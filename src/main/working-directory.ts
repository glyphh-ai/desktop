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

import { ipcMain, dialog, BrowserWindow, shell, app, type WebContents } from "electron";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import { realpathSync } from "fs";
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
  /** Display name shown in the row (e.g. "Vibe", "Workspace: fullstack"). */
  name: string;
  /** The folder this mount bound to. */
  folder: string;
  /** When this entry was last touched (ms epoch). Newer entries bubble up. */
  ts: number;
};

/** The fallback working directory — the user's OS home folder. A user can
 *  override the default later (workingDirDefault); until then we land on
 *  ~ rather than prompting on first run. */
// ── Agent panels: THE SHELL FOLLOWS THE AGENT YOU'RE WORKING IN (his
// decision, 2026-09-27). Each agent panel (a home.html?solo=tool:coding guest)
// keeps its own folder here; only the ACTIVE panel — the one last clicked,
// focused, fronted, or opening a tool — drives the shell's working folder.
// A folder set from a background panel is recorded for that panel alone and
// applied the moment it becomes active. A panel reads back its own folder.
const panelFolders = new Map<number, string>();
const trackedPanels = new Set<number>();
let activePanel: number | null = null;

export function isAgentPanel(wc: WebContents): boolean {
  try { return !wc.isDestroyed() && wc.getURL().includes("solo=tool:coding"); } catch { return false; }
}

function trackPanel(wc: WebContents): void {
  if (trackedPanels.has(wc.id)) return;
  trackedPanels.add(wc.id);
  wc.once("destroyed", () => {
    trackedPanels.delete(wc.id);
    panelFolders.delete(wc.id);
    if (activePanel === wc.id) activePanel = null;   // the shell keeps its folder; the tools stay
  });
}

/** The panel with this webContents id is the one being worked in: its folder
 *  becomes the shell's. Unknown ids (not a panel) are ignored. */
export function activateAgentPanel(wcId: number): void {
  if (activePanel === wcId) return;
  activePanel = wcId;
  const dir = panelFolders.get(wcId);
  if (dir && dir !== getWorkingDirectory()) {
    console.warn("[workdir] the shell follows the active agent panel", JSON.stringify({ wcId, dir }));
    setWorkingDirectory(dir);
  }
}

/** A folder set by a renderer: from a panel it is that panel's own folder and
 *  reaches the shell only while that panel is active; from the shell it is the
 *  shell's, as ever. Returns what the caller now sees as its folder. */
function applyFolderFrom(sender: WebContents, dir: string | null): string {
  if (!isAgentPanel(sender)) { setWorkingDirectory(dir); return getWorkingDirectory(); }
  trackPanel(sender);
  const value = dir ? normalizeDir(dir) : "";
  if (value && isDir(value)) panelFolders.set(sender.id, value); else panelFolders.delete(sender.id);
  if (activePanel === null) activePanel = sender.id;
  const result = activePanel !== sender.id ? (value || getWorkingDirectory()) : (setWorkingDirectory(dir), getWorkingDirectory());
  // THE PANEL THAT PICKED IS TOLD (his report, 2026-09-29: "the agent didn't
  // use the folder that i had set… It reverted to another folder that was
  // previously set"). The change was announced to the main window and the
  // workbench only — an agent panel is neither — so the panel's own thread
  // never learned its folder had changed and its next turn ran in the old one.
  // Only the panel that picked: another panel's thread keeps its own folder.
  try { if (!sender.isDestroyed()) sender.send("working-dir-changed", result); } catch { /* panel closing */ }
  return result;
}

function folderFor(sender: WebContents): string {
  if (isAgentPanel(sender)) { trackPanel(sender); const own = panelFolders.get(sender.id); if (own) return own; }
  return getWorkingDirectory();
}

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
  const stored = getPreference<string | null>("workingDirectory", null);
  // A stored folder that no longer exists (or never did) heals to the default
  // instead of breaking every terminal until someone finds the preference.
  if (stored && !isDir(stored)) {
    console.warn("[workdir] stored folder is not a directory; falling back", JSON.stringify({ stored }));
    setPreference("workingDirectory", null);
    return defaultWorkingDirectory();
  }
  return stored || defaultWorkingDirectory();
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

/** `~` and `~/x` as a shell would expand them. A bare "~" once reached here
 *  from a stored chat, and path.resolve made it <app dir>/~ — a folder that
 *  does not exist, so every shell the terminal spawned there died at once
 *  (his report, 2026-09-21: a black pane for every CLI). */
function expandHome(dir: string): string {
  const d = dir.trim();
  return d === "~" ? os.homedir() : d.startsWith("~/") ? path.join(os.homedir(), d.slice(2)) : d;
}

/** One spelling per folder: absolute, no trailing slash, symlinks resolved. */
function normalizeDir(dir: string): string {
  let out = path.resolve(expandHome(dir));
  try { out = realpathSync(out); } catch { /* not there yet */ }
  return out.length > 1 ? out.replace(/[\\/]+$/, "") : out;
}

/** Is this an existing directory? The working folder is never allowed to point
 *  at nothing: a shell spawned there exits before its prompt. */
function isDir(dir: string): boolean {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}
const sameDir = (a: string, b: string): boolean => (process.platform === "darwin" || process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

function pushRecentFolder(dir: string): void {
  const norm = normalizeDir(dir);
  const recents = getWorkingDirRecents().map(normalizeDir).filter((d, i, all) => !sameDir(d, norm) && all.findIndex((x) => sameDir(x, d)) === i);
  recents.unshift(norm);
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
  const value = dir ? normalizeDir(dir) : null;
  if (value && !isDir(value)) {
    console.warn("[workdir] refused: not a directory", JSON.stringify({ dir, value }));
    return;
  }
  setPreference("workingDirectory", value);
  if (value) pushRecentFolder(value);
  getMainWindow()?.webContents.send("working-dir-changed", value);
  broadcastToPanels("working-dir-changed", value);
  onWorkingDirChange(getWorkingDirectory());
  emitWorkdirEvent({ type: "cwd-changed", cwd: getWorkingDirectory() });
  startWorkdirWatcher(getWorkingDirectory());
}

/** A shell cd'd somewhere: the panels and watcher follow for this session, but
 *  the user's CHOSEN folder and the recents stay as picked (his order,
 *  2026-09-16: a resumed session in some app folder must not become the default). */
export function followWorkingDirectory(dir: string): void {
  const value = normalizeDir(dir);
  if (!isDir(value)) return;
  getMainWindow()?.webContents.send("working-dir-changed", value);
  broadcastToPanels("working-dir-changed", value);
  onWorkingDirChange(value);
  emitWorkdirEvent({ type: "cwd-changed", cwd: value });
  startWorkdirWatcher(value);
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

// ── Branches (the composer's one chip, 2026-10-10) ─────────────────────────
// The composer's branch chip: what branch the folder is on, the
// others it has, switch, start a new one, or turn git on. Plain git, no shell;
// a refusal comes back as one sentence a person who does not know git can act on.

export interface GitBranches { isRepo: boolean; current?: string; branches: string[]; error?: string }

/** git's own refusal, said plainly. */
export function gitWords(err: unknown, branch = ""): string {
  const raw = err instanceof Error ? ((err as Error & { stderr?: string }).stderr || err.message) : String(err);
  if (/would be overwritten|commit your changes or stash/i.test(raw)) {
    return `This folder has changes that ${branch ? `"${branch}"` : "the other branch"} would overwrite. Save or undo them first, then switch.`;
  }
  if (/already exists/i.test(raw)) return `A branch called "${branch}" already exists. Pick it from the list instead.`;
  if (/not a valid branch name|is not a valid/i.test(raw)) return `"${branch}" can't be a branch name. Use letters, numbers, - or /.`;
  if (/not a git repository/i.test(raw)) return "This folder doesn't track changes yet.";
  if (/ENOENT|spawn git/i.test(raw)) return "Git isn't installed on this machine.";
  return raw.split("\n").map((l) => l.replace(/^(error|fatal):\s*/i, "").trim()).find(Boolean) || "git refused";
}

/** The folder's branches, the current one first known. An empty repo (no
 *  commit yet) is on its unborn branch, which is listed so it can be named. */
export async function gitBranchesForDir(root: string): Promise<GitBranches> {
  const info = await gitInfoForDir(root);
  if (!info.isRepo) return { isRepo: false, branches: [] };
  let current = info.branch;
  if (!current) {
    try { current = (await execFileP("git", ["symbolic-ref", "--short", "HEAD"], { cwd: root })).stdout.trim() || undefined; } catch { /* detached */ }
  }
  try {
    const { stdout } = await execFileP("git", ["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", "refs/heads"], { cwd: root });
    const branches = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (current && !branches.includes(current)) branches.unshift(current);
    return { isRepo: true, ...(current ? { current } : {}), branches };
  } catch (err) {
    return { isRepo: true, ...(current ? { current } : {}), branches: current ? [current] : [], error: gitWords(err) };
  }
}

/** A name git accepts for a new branch, else why not. */
async function checkBranchName(root: string, name: string): Promise<string> {
  const n = String(name || "").trim();
  if (!n || n.startsWith("-")) throw new Error(`"${n}" can't be a branch name. Use letters, numbers, - or /.`);
  try { await execFileP("git", ["check-ref-format", "--branch", n], { cwd: root }); } catch (err) { throw new Error(gitWords(err, n)); }
  return n;
}

/** Switch the folder to an existing branch. git refuses when the folder's
 *  changes would be lost; the refusal is the answer. */
export async function gitSwitchBranch(root: string, branch: string): Promise<GitBranches> {
  const b = String(branch || "").trim();
  if (!b || b.startsWith("-")) throw new Error("pick a branch");
  try { await execFileP("git", ["checkout", b, "--"], { cwd: root }); } catch (err) { throw new Error(gitWords(err, b)); }
  return gitBranchesForDir(root);
}

/** Start a new branch from where the folder is, and switch to it. */
export async function gitCreateBranch(root: string, name: string): Promise<GitBranches> {
  const n = await checkBranchName(root, name);
  try { await execFileP("git", ["checkout", "-b", n], { cwd: root }); } catch (err) { throw new Error(gitWords(err, n)); }
  return gitBranchesForDir(root);
}

/** Turn git on for a folder ("Track changes"): a repo on main. */
export async function gitInitDir(root: string): Promise<GitBranches> {
  if (typeof root !== "string" || !root) throw new Error("pick a folder first");
  if ((await gitInfoForDir(root)).isRepo) return gitBranchesForDir(root);
  try { await execFileP("git", ["init", "-b", "main"], { cwd: root }); }
  catch {
    try { await execFileP("git", ["init"], { cwd: root }); } catch (err) { throw new Error(gitWords(err)); }
  }
  return gitBranchesForDir(root);
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

/** Delete = move to the OS trash (recoverable), never a hard unlink. (files:delete) */
export async function deleteWorkdirPath(target: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof target !== "string" || !target) return { ok: false, error: "missing path" };
  try { await shell.trashItem(target); return { ok: true }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
}

/** Rename or move within the tree. (files:rename) */
export async function renameWorkdirPath(oldPath: string, newPath: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof oldPath !== "string" || !oldPath || typeof newPath !== "string" || !newPath) {
    return { ok: false, error: "missing path" };
  }
  try { await fs.rename(oldPath, newPath); return { ok: true }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
}

/** `git status --porcelain` of the tree: the branch and every changed path with
 *  its two-letter status (index, worktree), untracked as `??`. Read-only. */
export async function gitStatusWorkdir(root: string): Promise<{ branch?: string; entries: Array<{ status: string; path: string }>; error?: string }> {
  if (typeof root !== "string" || !root) return { entries: [], error: "missing root" };
  try {
    const { stdout } = await execFileP("git", ["status", "--porcelain=v1", "--branch", "--untracked-files=all"], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    const lines = stdout.split("\n").filter(Boolean);
    const head = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : "";
    const branch = head.split("...")[0]?.trim();
    const entries = lines.slice(0, 2000).map((l) => ({ status: l.slice(0, 2), path: l.slice(3).split(" -> ").pop() ?? l.slice(3) }));
    return { ...(branch && !branch.startsWith("HEAD") ? { branch } : {}), entries };
  } catch (err) {
    const msg = err instanceof Error ? (err as Error & { stderr?: string }).stderr || err.message : String(err);
    return { entries: [], error: /not a git repository/i.test(msg) ? "not a git repo" : (msg.split("\n")[0] || "git error") };
  }
}

/** `git diff HEAD` NEVER shows untracked files — exactly what the agent
 *  creates all day. Synthesize an added-file diff per untracked file
 *  (`diff --no-index /dev/null <f>` exits 1 WITH the diff on stdout) and
 *  append. Read-only: never stages, never touches the index. `file` narrows
 *  it to one path. */
async function untrackedAsDiff(root: string, file?: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["ls-files", "--others", "--exclude-standard", ...(file ? ["--", file] : [])], { cwd: root });
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
 *  `file` (a path relative to the root) narrows it to one file. (files:git-diff) */
export async function gitDiffWorkdir(root: string, file?: string): Promise<{ text: string; error?: string }> {
  if (typeof root !== "string" || !root) return { text: "", error: "missing root" };
  try {
    const probe = await execFileP("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
    if (probe.stdout.trim() !== "true") return { text: "", error: "not a git repo" };
  } catch {
    return { text: "", error: "not a git repo" };
  }
  const only = file ? ["--", file] : [];
  try {
    const { stdout } = await execFileP("git", ["diff", "HEAD", ...only], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    return { text: stdout + (await untrackedAsDiff(root, file)) };
  } catch (err) {
    // Initial commit (no HEAD) is a normal state — show staged + unstaged.
    const msg = err instanceof Error
      ? (err as Error & { stderr?: string }).stderr || err.message
      : String(err);
    if (/unknown revision|ambiguous argument 'HEAD'|bad revision/i.test(msg)) {
      try {
        const { stdout } = await execFileP("git", ["diff", ...only], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
        return { text: stdout + (await untrackedAsDiff(root, file)) };
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
  // CLOUD SESSIONS (2026-08-19): when the composer's active session runs on a
  // THE PURGE: the cloud-fs router died with cloud sessions — every files:*
  // surface below is LOCAL DISK, unconditionally.
  // Defer watcher start to a setTimeout so any sync work in this fn doesn't
  // get blocked behind fs.watch setup on a potentially-large dir. The
  // watcher is best-effort — if it fails the rest of the app still works.
  setTimeout(() => {
    try { startWorkdirWatcher(getWorkingDirectory()); } catch { /* noop */ }
  }, 0);
  if (deps.openRecent) openRecentEntry = deps.openRecent;

  ipcMain.handle("working-dir:get", (e) => folderFor(e.sender));
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
  // (The cloud sections of the source chip — cloud-spaces-list, cloud-fs-browse —
  //  are the cloud lane's, cloud-run.ts, since 2026-10-04.)

  ipcMain.handle("files:git-info", (_e, root: string) =>
    gitInfoForDir(root));

  // The branch chip: list, switch, start one, turn git on. A refusal throws
  // its plain sentence; the renderer shows it as is.
  ipcMain.handle("files:git-branches", (_e, root: string) => gitBranchesForDir(String(root || "")));
  ipcMain.handle("files:git-switch", (_e, root: string, branch: string) => gitSwitchBranch(String(root || ""), String(branch || "")));
  ipcMain.handle("files:git-create-branch", (_e, root: string, name: string) => gitCreateBranch(String(root || ""), String(name || "")));
  ipcMain.handle("files:git-init", (_e, root: string) => gitInitDir(String(root || "")));
  // Explicit-only read: null until the user has ever picked a folder —
  // the Code composer gates on this (never on the ~/ fallback).
  ipcMain.handle("working-dir:get-explicit", () =>
    getExplicitWorkingDirectory());

  // Set the current dir to an already-known path (e.g. picked from recents).
  ipcMain.handle("working-dir:set", (e, dir: string) => {
    // Empty = RESET to the default (home) — the new-session clean slate.
    return applyFolderFrom(e.sender, dir || null);
  });

  // OS folder picker. `opts.startIn` opens the dialog in the current dir;
  // `opts.asDefault` also stores the pick as the first-run default.
  ipcMain.handle("working-dir:pick", async (e, opts?: { asDefault?: boolean; nullOnCancel?: boolean }) => {
    const win = getMainWindow();
    const dialogOpts = {
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
      defaultPath: folderFor(e.sender),
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);
    if (result.canceled || result.filePaths.length === 0) {
      return opts?.nullOnCancel ? null : folderFor(e.sender);
    }
    const picked = result.filePaths[0];
    if (opts?.asDefault) setDefaultWorkingDirectory(picked);
    applyFolderFrom(e.sender, picked);
    return picked;
  });

  // Lazy directory listing for the Workbench file tree. Returns immediate
  // children only — the tree fetches deeper levels on expand.
  ipcMain.handle("files:list-dir", (_e, dir: string) =>
    listWorkdirDir(dir));

  // Recursive NAME search under a root — powers the file tree's search box.
  // The old search only filtered rows already rendered, so anything inside a
  // collapsed (or never-expanded) folder was unfindable.
  ipcMain.handle("files:search", (_e, root: string, query: string) =>
    searchWorkdirFiles(root, query));

  // Read a file's text contents. Cap to ~1MB to avoid blowing up the renderer
  // on accidental clicks into a giant binary.
  ipcMain.handle("files:read-file", (_e, filePath: string) =>
    readWorkdirFile(filePath));

  // ── File management (workbench Files panel) ─────────────────────────────
  ipcMain.handle("files:mkdir", async (_e, dirPath: string) => {
    if (typeof dirPath !== "string" || !dirPath) return { ok: false, error: "missing path" };
    try { await fs.mkdir(dirPath, { recursive: true }); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("files:delete", (_e, target: string) => deleteWorkdirPath(target));
  ipcMain.handle("files:rename", (_e, oldPath: string, newPath: string) => renameWorkdirPath(oldPath, newPath));

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
  ipcMain.handle("files:write-file", (_e, filePath: string, content: string) =>
    writeWorkdirFile(filePath, content));

  // Unified git diff of the working tree (staged + unstaged + untracked). The
  // workbench Diff slot renders this; returns "" when the tree is clean.
  ipcMain.handle("files:git-diff", (_e, root: string) =>
    gitDiffWorkdir(root));
}
