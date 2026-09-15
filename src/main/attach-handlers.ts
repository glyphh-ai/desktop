/**
 * attach-handlers — the capability methods the CLOUD can invoke on this machine
 * over the attach socket, beyond the panels/apps/layouts set that
 * relay-handlers already registers. Everything runs on-machine via the shared
 * registry (registerRelayHandler), so the loopback local-MCP server and the
 * attach socket expose an identical surface.
 *
 *   loops.run   {slug, input?}          → run a saved loop, return its output
 *   skills.run  {slug, input?}          → run a saved skill, return its output
 *   agents.run  {agentId, taskId}       → fire a standing agent's task now
 *   scrape.page {url, wait?}            → load a URL headlessly, return text/html/title
 *   machine.appsList {}                 → the NATIVE apps installed on this machine
 *   machine.appOpen  {app}              → launch/activate a native app by (fuzzy) name
 */

import { BrowserWindow } from "electron";
import { homedir } from "node:os";
import { readdirSync, existsSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { registerRelayHandler } from "./relay-client.js";
import { loadSessions } from "./glyphh-agent-context.js";
import { runLoopBySlug, runSkillBySlug, runTaskNow } from "./agent-scheduler.js";
import { listInstalledApps, findInstalledApp, launchInstalledApp } from "./installed-apps.js";

function str(params: unknown, key: string): string {
  const v = (params as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
}
function obj(params: unknown, key: string): Record<string, unknown> {
  const v = (params as Record<string, unknown> | null)?.[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function installAttachHandlers(): void {
  // ── sessions.list / sessions.get: the WEB's view of THIS MACHINE's local
  // sessions (they live only in this app's store — signed-in web showed none).
  // list = metadata; get = one session's messages for a read view. ──
  registerRelayHandler("sessions.list", async () => {
    const { chats } = loadSessions();
    return {
      sessions: chats.map((c) => ({
        id: c.id, title: c.title, createdAt: c.createdAt,
        mode: (c as { mode?: string }).mode ?? "code",
        messages: c.messages?.length ?? 0,
      })),
    };
  });
  registerRelayHandler("sessions.get", async (params) => {
    const id = str(params, "id");
    if (!id) throw new Error("sessions.get requires { id }");
    const c = loadSessions().chats.find((x) => x.id === id);
    if (!c) throw new Error(`no local session ${id}`);
    return { session: { id: c.id, title: c.title, createdAt: c.createdAt, mode: (c as { mode?: string }).mode ?? "code", messages: (c.messages ?? []).slice(-200) } };
  });


/**
 * Is this folder already a git repo, and on what branch? Read straight off
 * `.git` rather than shelling out to git: the answer is needed the moment a
 * folder is picked (including from the WEB over the relay, where there is no
 * shell at all), and HEAD is a one-line file.
 *
 * Worktrees and submodules use a `.git` FILE pointing at the real dir; both
 * still mean "git is enabled here", which is what the caller is asking.
 */
function gitStateOf(dir: string): { isRepo: boolean; branch?: string } {
  const dot = join(dir, ".git");
  if (!existsSync(dot)) return { isRepo: false };
  try {
    const gitDir = statSync(dot).isDirectory()
      ? dot
      : join(dir, (readFileSync(dot, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1] ?? "").trim());
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    // Detached HEAD has no branch name — the short sha is the honest answer.
    return { isRepo: true, branch: ref ? ref[1] : head.slice(0, 7) };
  } catch {
    return { isRepo: true };   // .git exists but is unreadable — still a repo
  }
}

  // ── fs.list: the web's folder browser (source chip → Local). DIRECTORIES
  // only, dotfiles skipped, git roots flagged — capped at the user's home so
  // the cloud can browse where sessions may run, never the whole disk. ──
  registerRelayHandler("fs.list", async (params) => {
    const home = homedir();
    let path = str(params, "path") || home;
    if (!path.startsWith(home)) path = home; // never above the machine root we expose
    let entries: Array<{ name: string; path: string; dir: boolean; git?: boolean }> = [];
    try {
      entries = readdirSync(path, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => {
          const full = join(path, d.name);
          const git = existsSync(join(full, ".git"));
          return { name: d.name, path: full, dir: true, ...(git ? { git: true } : {}) };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      throw new Error(`could not list ${path}: ${(err as Error).message}`);
    }
    // The listed folder's OWN git state travels with the listing, so "Use this
    // folder" can be validated without a second round trip.
    // `root` is the ceiling the browser walks up to. Without it the client fell
    // back to "the first folder I listed", which meant no ‹ up row at all when
    // the picker opened deep in the tree.
    return { path, parent: path === home ? null : dirname(path), root: home, entries, git: gitStateOf(path) };
  });

  // ── fs.gitInfo: is git already enabled on THIS folder? The web's folder
  // picker validates a chosen directory with it (the desktop has wb.gitInfo);
  // capped at the machine root we expose, like every other fs handler. ──
  registerRelayHandler("fs.gitInfo", async (params) => {
    const home = homedir();
    const path = str(params, "path") || home;
    if (!path.startsWith(home)) throw new Error("fs.gitInfo is capped at your home folder");
    return { path, ...gitStateOf(path) };
  });

  // ── fs.mkdir: the web's "+ new folder" — create ONE directory under home
  // (no recursive trees, no dotfiles) and hand back the fresh listing entry. ──
  registerRelayHandler("fs.mkdir", async (params) => {
    const home = homedir();
    const parent = str(params, "path") || home;
    const name = str(params, "name").trim();
    if (!name || name.startsWith(".") || /[\/\\:]/.test(name)) throw new Error("fs.mkdir needs a plain folder name");
    if (!parent.startsWith(home)) throw new Error("fs.mkdir is capped at your home folder");
    const full = join(parent, name);
    if (existsSync(full)) throw new Error(`"${name}" already exists here`);
    mkdirSync(full);
    return { name, path: full, dir: true };
  });

  // ── machine reach: the SDK's shared layer (@glyphh/sdk/machine) ─────────
  registerRelayHandler("machine.appsList", async () => {
    return { apps: listInstalledApps().map((a) => a.name) };
  });

  registerRelayHandler("machine.appOpen", async (params) => {
    const ref = str(params, "app");
    if (!ref) throw new Error("machine.appOpen requires { app }");
    const app = findInstalledApp(ref);
    if (!app) throw new Error(`no installed app matches '${ref}'`);
    launchInstalledApp(app);
    return { opened: app.name };
  });

  registerRelayHandler("loops.run", async (params) => {
    const slug = str(params, "slug");
    if (!slug) throw new Error("loops.run requires { slug }");
    return { slug, output: await runLoopBySlug(slug, obj(params, "input")) };
  });

  registerRelayHandler("skills.run", async (params) => {
    const slug = str(params, "slug");
    if (!slug) throw new Error("skills.run requires { slug }");
    return { slug, output: await runSkillBySlug(slug, obj(params, "input")) };
  });

  registerRelayHandler("agents.run", async (params) => {
    const agentId = str(params, "agentId");
    const taskId = str(params, "taskId");
    if (!agentId || !taskId) throw new Error("agents.run requires { agentId, taskId }");
    const r = await runTaskNow(agentId, taskId);
    if (!r.ok) throw new Error(r.error || "agent run failed");
    return { agentId, taskId, ran: true };
  });

  // Headless scrape: a hidden, sandboxed BrowserWindow loads the URL, we pull
  // text + title + html, then destroy it. No renderer or visible panel needed.
  registerRelayHandler("scrape.page", async (params) => {
    const url = str(params, "url");
    if (!/^https?:\/\//i.test(url)) throw new Error("scrape.page requires an http(s) { url }");
    const waitMs = Math.min(Math.max(Number((params as Record<string, unknown>)?.wait) || 0, 0), 15_000);
    const win = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: true, javascript: true, images: false, sandbox: true, contextIsolation: true },
    });
    try {
      await win.loadURL(url);
      if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
      const [title, text, html] = await Promise.all([
        win.webContents.executeJavaScript("document.title").catch(() => ""),
        win.webContents.executeJavaScript("document.body ? document.body.innerText : ''").catch(() => ""),
        win.webContents.executeJavaScript("document.documentElement.outerHTML").catch(() => ""),
      ]);
      return {
        url: win.webContents.getURL() || url,
        title: String(title || ""),
        text: String(text || "").slice(0, 200_000),
        html: String(html || "").slice(0, 500_000),
      };
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  });
}
