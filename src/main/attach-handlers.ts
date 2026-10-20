/**
 * attach-handlers — the machine capabilities beyond panels that the local MCP
 * server exposes. Everything runs on-machine via the shared registry
 * (registerRelayHandler).
 *
 *   fs.list     {path?}        → the web folder picker's home-capped browse
 *   fs.gitInfo  {path?}        → is git enabled on that folder, on what branch
 *   fs.mkdir    {path?, name}  → one new folder under home
 *   machine.appsList {}        → the native apps installed here
 *   machine.appOpen  {app}     → launch one by (fuzzy) name
 *   machine.openUrl  {url}     → open an http(s) url in the default browser
 *   scrape.page {url, wait?}   → load a URL headlessly, return title/text/html
 *                                cli-sessions-list IPC lists, read-only, each with its resume handle —
 *                                the ONE read that rides the relay (his order, 2026-10-07): a CLI's
 *                                sessions live on this machine and nowhere else
 *
 * loops.run / skills.run / agents.run are gone with the scheduler they ran on
 * (2026-09-21); tasks are programs the desktop runs, and the MCP tools that
 * pointed at them were removed rather than left throwing "unknown method".
 */

import { BrowserWindow, shell } from "electron";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { registerRelayHandler } from "./relay-client.js";
import { findInstalledApp, launchInstalledApp, listInstalledApps } from "./installed-apps.js";

function str(params: unknown, key: string): string {
  const v = (params as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
}

/** Read straight off `.git`: no shell, answers the moment a folder is picked.
 *  A `.git` FILE (worktree, submodule) still means git is enabled here. */
export function gitStateOf(dir: string): { isRepo: boolean; branch?: string } {
  const dot = join(dir, ".git");
  if (!existsSync(dot)) return { isRepo: false };
  try {
    const gitDir = statSync(dot).isDirectory()
      ? dot
      : join(dir, (readFileSync(dot, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1] ?? "").trim());
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return { isRepo: true, branch: ref ? ref[1] : head.slice(0, 7) };
  } catch {
    return { isRepo: true };
  }
}

export function installAttachHandlers(): void {
  registerRelayHandler("fs.list", async (params) => {
    const home = homedir();
    let path = str(params, "path") || home;
    if (!path.startsWith(home)) path = home;
    let entries: Array<{ name: string; path: string; dir: boolean; git?: boolean }> = [];
    try {
      entries = readdirSync(path, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => {
          const full = join(path, d.name);
          return { name: d.name, path: full, dir: true, ...(existsSync(join(full, ".git")) ? { git: true } : {}) };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      throw new Error(`could not list ${path}: ${(err as Error).message}`);
    }
    return { path, parent: path === home ? null : dirname(path), root: home, entries, git: gitStateOf(path) };
  });

  registerRelayHandler("fs.gitInfo", async (params) => {
    const home = homedir();
    const path = str(params, "path") || home;
    if (!path.startsWith(home)) throw new Error("fs.gitInfo is capped at your home folder");
    return { path, ...gitStateOf(path) };
  });

  registerRelayHandler("fs.mkdir", async (params) => {
    const home = homedir();
    const parent = str(params, "path") || home;
    const name = str(params, "name").trim();
    if (!name || name.startsWith(".") || /[/\\:]/.test(name)) throw new Error("fs.mkdir needs a plain folder name");
    if (!parent.startsWith(home)) throw new Error("fs.mkdir is capped at your home folder");
    const full = join(parent, name);
    if (existsSync(full)) throw new Error(`"${name}" already exists here`);
    mkdirSync(full);
    return { name, path: full, dir: true };
  });

  registerRelayHandler("machine.appsList", async () => ({ apps: listInstalledApps().map((a) => a.name) }));

  registerRelayHandler("machine.appOpen", async (params) => {
    const ref = str(params, "app");
    if (!ref) throw new Error("machine.appOpen requires { app }");
    const app = findInstalledApp(ref);
    if (!app) throw new Error(`no installed app matches '${ref}'`);
    launchInstalledApp(app);
    return { opened: app.name };
  });

  registerRelayHandler("machine.openUrl", async (params) => {
    const url = str(params, "url");
    if (!/^https?:\/\//i.test(url)) throw new Error("machine.openUrl requires an http(s) { url }");
    await shell.openExternal(url);
    return { opened: url };
  });

  // Headless scrape: a hidden, sandboxed window loads the URL, we pull
  // title + text + html, then destroy it.
  registerRelayHandler("scrape.page", async (params) => {
    const url = str(params, "url");
    if (!/^https?:\/\//i.test(url)) throw new Error("scrape.page requires an http(s) { url }");
    const waitMs = Math.min(Math.max(Number((params as Record<string, unknown>)?.wait) || 0, 0), 15_000);
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: true, images: false, sandbox: true, contextIsolation: true } });
    try {
      await win.loadURL(url);
      if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
      const [title, text, html] = await Promise.all([
        win.webContents.executeJavaScript("document.title").catch(() => ""),
        win.webContents.executeJavaScript("document.body ? document.body.innerText : ''").catch(() => ""),
        win.webContents.executeJavaScript("document.documentElement.outerHTML").catch(() => ""),
      ]);
      return { url: win.webContents.getURL() || url, title: String(title || ""), text: String(text || "").slice(0, 200_000), html: String(html || "").slice(0, 500_000) };
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  });
}
