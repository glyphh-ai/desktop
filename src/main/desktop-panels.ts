/**
 * desktop-panels — EVERY surface is a standalone OS window on the desktop.
 *
 * The tension this resolves (his rule, 2026-08-21): when Glyphh manages the
 * desktop, anything opening INSIDE the app is odd. So tools, sections (even
 * Settings), web apps and the agent all open as their own windows out here,
 * and STACK like a live layout: the first takes half the workspace, each
 * addition re-tiles the stack across the same grid math desktop layouts use.
 * Closing one re-tiles the rest.
 *
 * The agent is deliberately NOT a singleton: every click on the Glyphh tile
 * mints a NEW agent window. Each is its own webContents — its own thread DOM,
 * its own run-stream subscription — so parallel agents never fight over one
 * transcript (the old single-#code-thread contention).
 *
 * Window content reuses the existing solo surfaces:
 *   tool    → home.html?solo=tool:<ViewKind>   (agent = tool:coding)
 *   section → home.html?section=<slug>         (settings, apps, layouts, …)
 *   url     → the web app directly (persist:yo — the signed-in session)
 */

import { BrowserWindow, ipcMain } from "electron";
import path from "path";
import { workspaceArea } from "./screen-layout.js";
import { getPreference } from "./stores/preferences-db.js";

/** Themed window background (app-window-manager, e1b6f457^) — a fresh window
 *  paints as a themed tile instead of flashing white while it loads. */
function themedBackground(): string {
  const t = getPreference<string>("theme", "dark");
  if (t === "light") return "#f5f5f5";
  if (t === "purple") return "#140a1f";
  return "#1a1a1c";
}

interface PanelSpec {
  kind: "tool" | "agent" | "section" | "url" | "app";
  value: string;      // ViewKind | section slug | url | app slug ("" for agent)
  url?: string;       // kind "app": the web app's url
  name?: string;
}

const stack: BrowserWindow[] = [];
// One window per surface KEY (tool:files, section:settings, url:<u>) — the
// old per-slug identity: re-opening focuses. Agents are deliberately keyless:
// every open is a NEW window (its own thread, its own stream).
const byKey = new Map<string, BrowserWindow>();

/** Re-tile the live stack across the workspace: 1 → right half, 2 → halves,
 *  then a near-square grid — the same shape a desktop layout would take. */
function retile(): void {
  const live = stack.filter((w) => !w.isDestroyed());
  stack.length = 0;
  stack.push(...live);
  if (!live.length) return;
  const area = workspaceArea();
  if (live.length === 1) {
    live[0].setBounds({
      x: area.x + Math.round(area.width / 2), y: area.y,
      width: Math.round(area.width / 2), height: area.height,
    });
    return;
  }
  const cols = Math.ceil(Math.sqrt(live.length));
  const rows = Math.ceil(live.length / cols);
  live.forEach((w, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    w.setBounds({
      x: area.x + Math.round((area.width * c) / cols),
      y: area.y + Math.round((area.height * r) / rows),
      width: Math.round(area.width / cols),
      height: Math.round(area.height / rows),
    });
  });
}

export function openDesktopPanel(spec: PanelSpec): BrowserWindow {
  const key = spec.kind === "agent" ? null : `${spec.kind}:${spec.value}`;
  const existing = key ? byKey.get(key) : undefined;
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({
    width: 1160, height: 740, show: false,
    // A DEDICATED header row — the traffic lights get a real title bar, they
    // never overlay panel content (his rule, 2026-08-21).
    backgroundColor: themedBackground(),
    webPreferences: spec.kind === "url"
      ? { contextIsolation: true, nodeIntegration: false, partition: "persist:yo" }
      : {
          preload: path.join(__dirname, "..", "renderer", "preload.js"),
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: true,
        },
  });
  if (spec.name) win.setTitle(spec.name);
  if (spec.kind === "url") {
    void win.loadURL(spec.value);
  } else if (spec.kind === "app") {
    // A GLYPHH APP PANEL, standalone: the workbench mounts the one app cell
    // (webview, persist:yo) — the panel look, its own window, real header.
    void win.loadFile(path.join(__dirname, "..", "renderer", "home.html"),
      { query: { solo: `app:${spec.value}`, appUrl: spec.url || "", appName: spec.name || spec.value } });
  } else if (spec.kind === "section") {
    void win.loadFile(path.join(__dirname, "..", "renderer", "home.html"), { query: { section: spec.value } });
  } else {
    // tool | agent — agent IS the coding tool slot, standalone.
    const view = spec.kind === "agent" ? "coding" : spec.value;
    void win.loadFile(path.join(__dirname, "..", "renderer", "home.html"), { query: { solo: `tool:${view}` } });
  }
  stack.push(win);
  if (key) byKey.set(key, win);
  win.on("closed", () => { if (key && byKey.get(key) === win) byKey.delete(key); retile(); });
  win.once("ready-to-show", () => { win.show(); retile(); });
  return win;
}

export function closeAllDesktopPanels(): void {
  for (const w of [...stack]) { try { if (!w.isDestroyed()) w.close(); } catch { /* gone */ } }
  stack.length = 0;
}

export function registerDesktopPanelsIpc(): void {
  ipcMain.handle("desktop-panel-open", (_e, spec: PanelSpec) => {
    try { openDesktopPanel(spec); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
}
