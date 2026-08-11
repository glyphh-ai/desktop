/**
 * Working directory — the single project folder the app is focused on.
 *
 * One explicit, persisted folder. The Glyphh agent runs in it, and (todo) a
 * cypher clones the repo into it. Changing it broadcasts `working-dir-changed`
 * to the main window and every panel so they re-point.
 *
 * Recents — a chronological history of folder-bound app / layout instances.
 * Per design §2.1, each entry pairs an app (or layout) with a folder. The
 * Welcome surface and the left-rail bottom pane render the same list.
 */

import { ipcMain, dialog, BrowserWindow, shell, app } from "electron";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import { watch, statSync, type FSWatcher } from "fs";
import path from "path";
import os from "os";
import { getPreference, setPreference } from "./stores/preferences-db";

const execFileP = promisify(execFile);

type Broadcast = (channel: string, ...args: unknown[]) => void;

let getMainWindow: () => BrowserWindow | null = () => null;
let broadcastToPanels: Broadcast = () => {};
let onWorkingDirChange: (dir: string) => void = () => {};
let openRecentEntry: (entry: RecentEntry) => void = () => {};

// Folder-list cap (legacy "workingDirRecents" preference). Kept for back-compat
// during migration only.
const FOLDERS_CAP = 8;
// Recents (new model) — max kept, displayed paginated.
const RECENTS_CAP = 20;

export type RecentEntry = {
  /** "app" = a folder-bound app instance; "layout" = a folder-bound layout. */
  kind: "app" | "layout";
  /** App slug (e.g. "vibe") or layout name. */
  id: string;
  /** Display name shown in the row (e.g. "Vibe", "Layout: fullstack"). */
  name: string;
  /** The folder this mount bound to. */
  folder: string;
  /** When this entry was last touched (ms epoch). Newer entries bubble up. */
  ts: number;
};

/** The fallback working directory — the user's OS home folder. A user can
 *  override the default later (workingDirDefault); until then we land on
 *  ~ rather than prompting on first run. */
export function defaultWorkingDirectory(): string {
  return getPreference<string | null>("workingDirDefault", null) || os.homedir();
}

/** Set the user's default working folder (e.g. from a settings screen).
 *  Also becomes the current dir if none is set yet. */
export function setDefaultWorkingDirectory(dir: string): void {
  setPreference("workingDirDefault", dir);
  if (!getPreference<string | null>("workingDirectory", null)) {
    setWorkingDirectory(dir);
  }
}

/** The current working directory. Defaults to the configured default when
 *  none has been set. This doubles as "last used" — it persists across chats
 *  so a new chat inherits it. */
export function getWorkingDirectory(): string {
  return getPreference<string | null>("workingDirectory", null) || defaultWorkingDirectory();
}

/** The EXPLICITLY chosen working directory, or null when the user never
 *  picked one. The agent loop requires an explicit pick — it must never
 *  silently operate in ~ or wherever the app happened to launch from. */
export function getExplicitWorkingDirectory(): string | null {
  return getPreference<string | null>("workingDirectory", null);
}

/** Most-recently-used folder paths (legacy back-compat surface). */
export function getWorkingDirRecents(): string[] {
  return getPreference<string[]>("workingDirRecents", []) || [];
}

function pushRecentFolder(dir: string): void {
  const recents = getWorkingDirRecents().filter((d) => d !== dir);
  recents.unshift(dir);
  setPreference("workingDirRecents", recents.slice(0, FOLDERS_CAP));
}

// ── Recents (rich): app/layout + folder pairs ───────────────────────────

/** Read all recent (app|layout, folder) pairs, newest first. Capped at 20. */
export function getRecents(): RecentEntry[] {
  return getPreference<RecentEntry[]>("recents", []) || [];
}

/** Record a (kind, id, name, folder) recent. Deduped on the (kind, id,
 *  folder) triple so the same mount bubbles to the top rather than piling
 *  up. Non-folder-bound apps (Browser, ChatGPT, etc.) pass folder="" and
 *  dedupe by (kind, id). Newest first, capped at 20. */
export function addRecent(entry: Omit<RecentEntry, "ts">): void {
  const folder = entry.folder || "";
  const recents = getRecents().filter(
    (r) => !(r.kind === entry.kind && r.id === entry.id && r.folder === folder),
  );
  recents.unshift({ ...entry, folder, ts: Date.now() });
  setPreference("recents", recents.slice(0, RECENTS_CAP));
  broadcastRecentsChanged();
}

/** Drop a single recent entry. */
export function removeRecent(entry: Pick<RecentEntry, "kind" | "id" | "folder">): void {
  const recents = getRecents().filter(
    (r) => !(r.kind === entry.kind && r.id === entry.id && r.folder === entry.folder),
  );
  setPreference("recents", recents);
  broadcastRecentsChanged();
}

/** Drop every recent entry. */
export function clearRecents(): void {
  setPreference("recents", []);
  broadcastRecentsChanged();
}

/** Clear the workdir-recents list (the Workspaces section in the left rail).
 *  Doesn't touch the current working directory — the user stays in whatever
 *  folder they're working in. */
export function clearWorkingDirRecents(): void {
  setPreference("workingDirRecents", []);
  // Reuse the working-dir-changed signal to nudge the renderer to refresh
  // (it triggers refreshRailWorkspaces in the left rail).
  getMainWindow()?.webContents.send("working-dir-changed", getPreference<string | null>("workingDirectory", null));
}

function broadcastRecentsChanged(): void {
  const list = getRecents();
  getMainWindow()?.webContents.send("recents-changed", list);
  broadcastToPanels("recents-changed", list);
}

// ── Workdir event bus ────────────────────────────────────────
// In-process subscription to the SAME debounced signals the renderer gets over
// IPC (file-changed / git-changed / cwd-changed). The web relay (relay-fs.ts)
// rides this to forward changes to an attached browser — one watcher, two
// transports, identical timing.
export type WorkdirEvent =
  | { type: "file-changed"; path: string }
  | { type: "git-changed" }
  | { type: "cwd-changed"; cwd: string };

const workdirEventSubs = new Set<(ev: WorkdirEvent) => void>();

/** Subscribe to workdir events. Returns the unsubscribe. */
export function onWorkdirEvent(cb: (ev: WorkdirEvent) => void): () => void {
  workdirEventSubs.add(cb);
  return () => { workdirEventSubs.delete(cb); };
}

function emitWorkdirEvent(ev: WorkdirEvent): void {
  for (const cb of [...workdirEventSubs]) {
    try { cb(ev); } catch { /* subscriber's problem — never break the watcher */ }
  }
}

// ── File watcher ─────────────────────────────────────────────
// One recursive fs.watch on the current working directory. Fires
// `workdir:file-changed` (absolute path) to every panel so the Plan app,
// Workbench Files tree, open Monaco tabs, and Diff slot can refresh
// live as the agent writes files. Debounced per-path so a single save
// doesn't fan out to multiple broadcasts.
let workdirWatcher: FSWatcher | null = null;
const watcherTimers = new Map<string, ReturnType<typeof setTimeout>>();
const watcherMtimes = new Map<string, number>();
let gitChangedTimer: ReturnType<typeof setTimeout> | null = null;
function stopWorkdirWatcher(): void {
  if (workdirWatcher) {
    try { workdirWatcher.close(); } catch { /* noop */ }
    workdirWatcher = null;
  }
  for (const t of watcherTimers.values()) clearTimeout(t);
  watcherTimers.clear();
  watcherMtimes.clear();
  if (gitChangedTimer) { clearTimeout(gitChangedTimer); gitChangedTimer = null; }
}
/** Coalesce .git/index + .git/HEAD churn (a commit touches both, several
 *  times) into ONE `workdir:git-changed` signal — the Diff panel refreshes
 *  once per git operation, not once per internal write. */
function scheduleGitChanged(): void {
  if (gitChangedTimer) return;
  gitChangedTimer = setTimeout(() => {
    gitChangedTimer = null;
    broadcastToPanels("workdir:git-changed");
    getMainWindow()?.webContents.send("workdir:git-changed");
    emitWorkdirEvent({ type: "git-changed" });
  }, 250);
}
function startWorkdirWatcher(dir: string): void {
  stopWorkdirWatcher();
  if (!dir) return;
  try {
    workdirWatcher = watch(dir, { recursive: true, persistent: false }, (_eventType, filename) => {
      if (!filename) return;
      // Skip noise that would saturate the IPC channel.
      const f = String(filename).replace(/\\/g, "/");
      // .git is skipped wholesale below — EXCEPT the two files that mean "git
      // state moved" (commit/stage/checkout): the index and HEAD. Those emit a
      // single coalesced git-changed signal so the Diff panel tracks commits.
      if (f === ".git/index" || f === ".git/HEAD") { scheduleGitChanged(); return; }
      if (f.includes("node_modules") || f.startsWith(".git/") || f.includes("/.git/")) return;
      const abs = path.join(dir, f);
      const prev = watcherTimers.get(abs);
      if (prev) clearTimeout(prev);
      watcherTimers.set(abs, setTimeout(() => {
        watcherTimers.delete(abs);
        // Only broadcast on a real CONTENT change. fs.watch(recursive) on macOS
        // — especially under newer Electron/Node — also reports access-only
        // events (e.g. when the Workbench Files tree re-reads the directory),
        // which would otherwise feed back into another re-render in an endless
        // refresh loop. Gate on mtime: skip events that didn't change content.
        let mt = -1;
        try { mt = statSync(abs).mtimeMs; } catch { watcherMtimes.delete(abs); } // deleted/missing → fall through and notify
        if (mt !== -1) {
          if (watcherMtimes.get(abs) === mt) return; // access/atime only — no content change
          watcherMtimes.set(abs, mt);
        }
        broadcastToPanels("workdir:file-changed", abs);
        getMainWindow()?.webContents.send("workdir:file-changed", abs);
        emitWorkdirEvent({ type: "file-changed", path: abs });
      }, 80));
    });
  } catch (err) {
    // recursive isn't supported on Linux without polling — fall back silently
    // rather than spamming console; the watcher will simply not fire.
    console.warn("[workdir-watcher] could not watch", dir, err);
  }
}

/** Set the working directory and notify the renderer + every panel. */
export function setWorkingDirectory(dir: string | null): void {
  const value = dir || null;
  setPreference("workingDirectory", value);
  if (value) pushRecentFolder(value);
  getMainWindow()?.webContents.send("working-dir-changed", value);
  broadcastToPanels("working-dir-changed", value);
  onWorkingDirChange(getWorkingDirectory());
  emitWorkdirEvent({ type: "cwd-changed", cwd: getWorkingDirectory() });
  startWorkdirWatcher(getWorkingDirectory());
}

// ── Shared filesystem/git implementations ────────────────────────────────
// ONE implementation per operation, consumed by BOTH transports: the desktop
// renderer's files:* IPC handlers below and the web relay (relay-fs.ts). The
// relay must never fork behavior from the local workbench — same listing
// filters, same size caps, same error shapes.

/** Is this folder a git repo, and on what branch? (files:git-info) */
export async function gitInfoForDir(root: string): Promise<{ isRepo: boolean; branch?: string }> {
  const result: { isRepo: boolean; branch?: string } = { isRepo: false };
  if (typeof root !== "string" || !root) return result;
  try {
    const inside = await execFileP("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
    if (inside.stdout.trim() !== "true") return result;
    result.isRepo = true;
    try {
      const head = await execFileP("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
      const branch = head.stdout.trim();
      if (branch && branch !== "HEAD") result.branch = branch;
    } catch { /* detached HEAD or other — leave branch undefined */ }
  } catch { /* not a repo or git unavailable */ }
  return result;
}

/** Immediate children of a directory for the file tree. (files:list-dir) */
export async function listWorkdirDir(dir: string): Promise<{ entries: Array<{ name: string; path: string; kind: "dir" | "file" }>; error?: string }> {
  if (typeof dir !== "string" || !dir) return { entries: [], error: "missing dir" };
  try {
    const items = await fs.readdir(dir, { withFileTypes: true });
    // Show dotfiles; .git is filtered explicitly since
    // it's noisy and rarely useful in a file tree.
    const entries = items
      .filter((d) => d.name !== ".git" && d.name !== "node_modules")
      .map((d) => ({
        name: d.name,
        path: path.join(dir, d.name),
        kind: d.isDirectory() ? "dir" as const : "file" as const,
      }))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { entries };
  } catch (err) {
    return { entries: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Recursive NAME search under a root — powers the file tree's search box.
 *  Case-insensitive substring on the entry name, heavy dirs skipped, capped
 *  so a giant repo can't stall the tree. (files:search) */
export async function searchWorkdirFiles(root: string, query: string): Promise<{ entries: Array<{ name: string; rel: string; path: string; kind: "dir" | "file" }>; truncated?: boolean; error?: string }> {
  if (typeof root !== "string" || !root) return { entries: [], error: "missing dir" };
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return { entries: [] };
  const SKIP = new Set([".git", "node_modules", "dist", "build", "out", ".next", "coverage", "vendor", "__pycache__", ".venv", "target"]);
  const MAX_RESULTS = 200;
  const MAX_DIRS = 4000; // hard walk ceiling — search must never hang the tree
  const entries: Array<{ name: string; rel: string; path: string; kind: "dir" | "file" }> = [];
  const stack = [root];
  let visited = 0;
  try {
    while (stack.length && entries.length < MAX_RESULTS && visited < MAX_DIRS) {
      const dir = stack.pop()!;
      visited++;
      let items: Array<{ name: string; isDirectory(): boolean }> = [];
      try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const d of items) {
        if (SKIP.has(d.name)) continue;
        const abs = path.join(dir, d.name);
        const isDir = d.isDirectory();
        if (d.name.toLowerCase().includes(q)) {
          entries.push({ name: d.name, rel: path.relative(root, abs), path: abs, kind: isDir ? "dir" : "file" });
          if (entries.length >= MAX_RESULTS) break;
        }
        if (isDir) stack.push(abs);
      }
    }
    // Shallow matches first, then alphabetical — the file you meant is
    // usually near the top of the repo, not five vendored levels down.
    entries.sort((a, b) => {
      const da = a.rel.split(path.sep).length, dbb = b.rel.split(path.sep).length;
      if (da !== dbb) return da - dbb;
      return a.rel.localeCompare(b.rel);
    });
    return { entries, truncated: entries.length >= MAX_RESULTS };
  } catch (err) {
    return { entries: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read a file's text contents, capped at ~1MB. (files:read-file) */
export async function readWorkdirFile(filePath: string): Promise<{ content: string; error?: string }> {
  if (typeof filePath !== "string" || !filePath) return { content: "", error: "missing path" };
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > 1_000_000) {
      return { content: "", error: `file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB)` };
    }
    const content = await fs.readFile(filePath, "utf8");
    return { content };
  } catch (err) {
    return { content: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Write a text file, creating parent directories as needed. (files:write-file) */
export async function writeWorkdirFile(filePath: string, content: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof filePath !== "string" || !filePath) return { ok: false, error: "missing path" };
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, typeof content === "string" ? content : "", "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `git diff HEAD` NEVER shows untracked files — exactly what the agent
 *  creates all day. Synthesize an added-file diff per untracked file
 *  (`diff --no-index /dev/null <f>` exits 1 WITH the diff on stdout) and
 *  append. Read-only: never stages, never touches the index. */
async function untrackedAsDiff(root: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root });
    const files = stdout.split("\n").filter(Boolean).slice(0, 200);
    let text = "";
    for (const f of files) {
      try {
        await execFileP("git", ["diff", "--no-index", "--", "/dev/null", f], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
      } catch (err) {
        const out = (err as { stdout?: string }).stdout;
        if (out) text += out;
      }
    }
    return text;
  } catch {
    return "";   // untracked listing failed — the tracked diff still shows
  }
}

/** Unified git diff of the working tree (staged + unstaged + untracked).
 *  Returns "" when clean; probes first so a non-repo gets a clean message.
 *  (files:git-diff) */
export async function gitDiffWorkdir(root: string): Promise<{ text: string; error?: string }> {
  if (typeof root !== "string" || !root) return { text: "", error: "missing root" };
  try {
    const probe = await execFileP("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
    if (probe.stdout.trim() !== "true") return { text: "", error: "not a git repo" };
  } catch {
    return { text: "", error: "not a git repo" };
  }
  try {
    const { stdout } = await execFileP("git", ["diff", "HEAD"], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    return { text: stdout + (await untrackedAsDiff(root)) };
  } catch (err) {
    // Initial commit (no HEAD) is a normal state — show staged + unstaged.
    const msg = err instanceof Error
      ? (err as Error & { stderr?: string }).stderr || err.message
      : String(err);
    if (/unknown revision|ambiguous argument 'HEAD'|bad revision/i.test(msg)) {
      try {
        const { stdout } = await execFileP("git", ["diff"], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
        return { text: stdout + (await untrackedAsDiff(root)) };
      } catch (err2) {
        const msg2 = err2 instanceof Error
          ? (err2 as Error & { stderr?: string }).stderr || err2.message
          : String(err2);
        return { text: "", error: msg2.split("\n")[0] || "git error" };
      }
    }
    return { text: "", error: msg.split("\n")[0] || "git error" };
  }
}

export function registerWorkingDirectoryIpc(deps: {
  getMainWindow: () => BrowserWindow | null;
  broadcastToPanels: Broadcast;
  onWorkingDirChange?: (dir: string) => void;
  /** Re-open a recent entry. Wired in main.ts so it can call the same
   *  spawn paths Welcome / +picker / tab-new-app use. */
  openRecent?: (entry: RecentEntry) => void;
}): void {
  getMainWindow = deps.getMainWindow;
  broadcastToPanels = deps.broadcastToPanels;
  if (deps.onWorkingDirChange) onWorkingDirChange = deps.onWorkingDirChange;
  // Defer watcher start to a setTimeout so any sync work in this fn doesn't
  // get blocked behind fs.watch setup on a potentially-large dir. The
  // watcher is best-effort — if it fails the rest of the app still works.
  setTimeout(() => {
    try { startWorkdirWatcher(getWorkingDirectory()); } catch { /* noop */ }
  }, 0);
  if (deps.openRecent) openRecentEntry = deps.openRecent;

  ipcMain.handle("working-dir:get", () => getWorkingDirectory());
  ipcMain.handle("working-dir:recents", () => getWorkingDirRecents());

  // ── Recents (rich) ──
  ipcMain.handle("recents:list", () => getRecents());
  ipcMain.handle("recents:open", (_e, entry: RecentEntry) => {
    if (!entry?.kind || !entry?.id) return false;
    openRecentEntry({ ...entry, folder: entry.folder || "" });
    return true;
  });
  ipcMain.handle("recents:remove", (_e, entry: Pick<RecentEntry, "kind" | "id" | "folder">) => {
    if (!entry?.kind || !entry?.id) return false;
    removeRecent({ ...entry, folder: entry.folder || "" });
    return true;
  });
  ipcMain.handle("recents:clear", () => { clearRecents(); return true; });
  ipcMain.handle("working-dir:clear-recents", () => { clearWorkingDirRecents(); return true; });

  // Lightweight git probe used by folder-bound app chrome (Agent app etc.)
  // to surface the current branch when the working folder is a git repo.
  ipcMain.handle("files:git-info", (_e, root: string) => gitInfoForDir(root));

  // List local branches in a repo, with the current one. Used by the
  // Agent app's branch picker dropdown.
  // Switch branches. Fails if the working tree is dirty — git surfaces a
  // clear error, which the renderer can display.
  // Explicit-only read: null until the user has ever picked a folder —
  // the Code composer gates on this (never on the ~/ fallback).
  ipcMain.handle("working-dir:get-explicit", () => getExplicitWorkingDirectory());

  // Set the current dir to an already-known path (e.g. picked from recents).
  ipcMain.handle("working-dir:set", (_e, dir: string) => {
    if (dir) setWorkingDirectory(dir);
    return getWorkingDirectory();
  });

  // OS folder picker. `opts.startIn` opens the dialog in the current dir;
  // `opts.asDefault` also stores the pick as the first-run default.
  ipcMain.handle("working-dir:pick", async (_e, opts?: { asDefault?: boolean; nullOnCancel?: boolean }) => {
    const win = getMainWindow();
    const dialogOpts = {
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
      defaultPath: getWorkingDirectory(),
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);
    if (result.canceled || result.filePaths.length === 0) {
      return opts?.nullOnCancel ? null : getWorkingDirectory();
    }
    const picked = result.filePaths[0];
    if (opts?.asDefault) setDefaultWorkingDirectory(picked);
    setWorkingDirectory(picked);
    return picked;
  });

  // Lazy directory listing for the Workbench file tree. Returns immediate
  // children only — the tree fetches deeper levels on expand.
  ipcMain.handle("files:list-dir", (_e, dir: string) => listWorkdirDir(dir));

  // Recursive NAME search under a root — powers the file tree's search box.
  // The old search only filtered rows already rendered, so anything inside a
  // collapsed (or never-expanded) folder was unfindable.
  ipcMain.handle("files:search", (_e, root: string, query: string) => searchWorkdirFiles(root, query));

  // Read a file's text contents. Cap to ~1MB to avoid blowing up the renderer
  // on accidental clicks into a giant binary.
  ipcMain.handle("files:read-file", (_e, filePath: string) => readWorkdirFile(filePath));

  // ── File management (workbench Files panel) ─────────────────────────────
  ipcMain.handle("files:mkdir", async (_e, dirPath: string) => {
    if (typeof dirPath !== "string" || !dirPath) return { ok: false, error: "missing path" };
    try { await fs.mkdir(dirPath, { recursive: true }); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  // Delete = move to the OS trash (recoverable), never a hard unlink.
  ipcMain.handle("files:delete", async (_e, target: string) => {
    if (typeof target !== "string" || !target) return { ok: false, error: "missing path" };
    try { await shell.trashItem(target); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("files:rename", async (_e, oldPath: string, newPath: string) => {
    if (typeof oldPath !== "string" || !oldPath || typeof newPath !== "string" || !newPath) {
      return { ok: false, error: "missing path" };
    }
    try { await fs.rename(oldPath, newPath); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });

  // ── Rich file preview — platform-aware ──────────────────────────────────
  // Native viewer: macOS gets Quick Look (renders pptx/docx/key/xlsx without
  // any dependency); everywhere else the file opens in its default app.
  ipcMain.handle("files:preview-native", async (_e, filePath: string) => {
    if (typeof filePath !== "string" || !filePath) return { ok: false, error: "missing path" };
    try {
      if (process.platform === "darwin") {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) { win.previewFile(filePath); return { ok: true, method: "quicklook" }; }
      }
      const err = await shell.openPath(filePath);
      return err ? { ok: false, error: err } : { ok: true, method: "shell" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Embedded viewer: LibreOffice headless → PDF (mtime-cached in temp), which
  // the Browser panel renders in-tile. Absent LibreOffice → "no-converter"
  // and the caller falls back to the native viewer above. Probed once.
  const SOFFICE_CANDIDATES =
    process.platform === "darwin"
      ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice", "soffice"]
      : process.platform === "win32"
        ? ["C:\\Program Files\\LibreOffice\\program\\soffice.exe", "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe", "soffice.exe"]
        : ["soffice", "libreoffice"];
  let sofficePath: string | null | undefined;
  async function findSoffice(): Promise<string | null> {
    if (sofficePath !== undefined) return sofficePath;
    for (const cand of SOFFICE_CANDIDATES) {
      try {
        if (path.isAbsolute(cand)) statSync(cand);
        else await execFileP(cand, ["--version"], { timeout: 8000 });
        sofficePath = cand;
        return cand;
      } catch { /* try the next candidate */ }
    }
    sofficePath = null;
    return null;
  }
  ipcMain.handle("files:convert-preview", async (_e, filePath: string) => {
    if (typeof filePath !== "string" || !filePath) return { error: "missing path" };
    const soffice = await findSoffice();
    if (!soffice) return { error: "no-converter" };
    try {
      const src = await fs.stat(filePath);
      const key = createHash("sha1").update(filePath).digest("hex").slice(0, 16);
      const outDir = path.join(app.getPath("temp"), "glyphh-previews", key);
      const pdfPath = path.join(outDir, path.basename(filePath).replace(/\.[^.]+$/, "") + ".pdf");
      const cached = await fs.stat(pdfPath).catch(() => null);
      if (cached && cached.mtimeMs >= src.mtimeMs) return { pdfPath };
      await fs.mkdir(outDir, { recursive: true });
      await execFileP(soffice, ["--headless", "--convert-to", "pdf", "--outdir", outDir, filePath], { timeout: 60_000 });
      await fs.stat(pdfPath); // conversion that produced nothing → error path
      return { pdfPath };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Native open-file dialog for the workbench Browser panel — returns the
  // picked absolute path, or null on cancel.
  ipcMain.handle("files:pick-file", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = win
      ? await dialog.showOpenDialog(win, { title: "Open file", properties: ["openFile"] })
      : await dialog.showOpenDialog({ title: "Open file", properties: ["openFile"] });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  // Write a text file, creating parent directories as needed. Used by the
  // Code workbench's Plan slot to persist <cwd>/plan.md.
  ipcMain.handle("files:write-file", (_e, filePath: string, content: string) => writeWorkdirFile(filePath, content));

  // Unified git diff of the working tree (staged + unstaged + untracked). The
  // workbench Diff slot renders this; returns "" when the tree is clean.
  ipcMain.handle("files:git-diff", (_e, root: string) => gitDiffWorkdir(root));
}
