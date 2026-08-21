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

const GAP = 2; // hairline seam between panels


/** Column/row assignment for the BUILD pattern: 1 → CENTER half-width; 2 →
 *  under it; 3 → the pair becomes LEFT half and the new panel takes the
 *  RIGHT half (together they fill the screen); 4 → under the right; then
 *  alternate. splitX is user-draggable via window resize (shared edge). */
let splitFrac = 0.5;
const rowFrac = [0.5, 0.5]; // per-column horizontal divider (2-row columns)
const seat = new WeakMap<BrowserWindow, { col: number; row: number }>();

function assign(live: BrowserWindow[]): Array<{ col: number; row: number }> {
  const out: Array<{ col: number; row: number }> = [];
  const counts = [0, 0];
  live.forEach((_w, i) => {
    const col = i < 2 ? 0 : i < 4 ? 1 : (i % 2);
    out.push({ col, row: counts[col]++ });
  });
  return out;
}

function applyBounds(live: BrowserWindow[]): void {
  const area = workspaceArea();
  const seats = assign(live);
  const twoCols = live.length > 2;
  const colCount = [seats.filter(s => s.col === 0).length, seats.filter(s => s.col === 1).length];
  const splitX = area.x + Math.round(area.width * splitFrac);
  live.forEach((w, i) => {
    const { col, row } = seats[i];
    seat.set(w, seats[i]);
    const x = !twoCols
      ? area.x + Math.round(area.width / 4)
      : col === 0 ? area.x : splitX + GAP;
    const width = !twoCols
      ? Math.round(area.width / 2)
      : col === 0 ? (splitX - area.x - GAP) : (area.x + area.width - splitX - GAP);
    const rows = Math.max(1, colCount[col]);
    let y = area.y, height = area.height;
    if (rows === 2) {
      const topH = Math.round((area.height - GAP) * rowFrac[col]);
      if (row === 0) { height = topH; }
      else { y = area.y + topH + GAP; height = area.height - topH - GAP; }
    } else if (rows > 2) {
      const rowH = Math.round((area.height - GAP * (rows - 1)) / rows);
      y = area.y + row * (rowH + GAP); height = rowH;
    }
    w.setBounds({ x, y, width, height });
  });
  broadcastStack(live.length);
}

// The top-of-screen bar (the in-app "dropdown"): reuse the desktop-layout bar
// whenever ANY panel is up — Close there tears the stack down (app-reset).
let lastBroadcast = -1;
function broadcastStack(count: number): void {
  const state = count > 0 ? 1 : 0;
  if (state === lastBroadcast) return;
  lastBroadcast = state;
  const { webContents } = require("electron") as typeof import("electron");
  for (const wc of webContents.getAllWebContents()) {
    try {
      const url = wc.getURL();
      if (!wc.isDestroyed() && /home\.html(?!\?solo|\?section)/.test(url)) wc.send("desktop-layout-changed", state ? "Apps" : null);
    } catch { /* teardown */ }
  }
}

function retile(): void {
  const live = stack.filter((w) => !w.isDestroyed());
  stack.length = 0;
  stack.push(...live);
  if (!live.length) return;
  applyBounds(live);
}

/** Shared-edge drag: resizing a panel's width moves the column split for
 *  everyone (the internal layout manager's divider, as window edges). */
function watchResize(win: BrowserWindow): void {
  win.on("resized", () => {
    const s = seat.get(win);
    const live = stack.filter((w) => !w.isDestroyed());
    if (!s || live.length <= 2) return;
    const area = workspaceArea();
    const b = win.getBounds();
    const edge = s.col === 0 ? b.x + b.width + GAP : b.x - GAP;
    splitFrac = Math.max(0.2, Math.min(0.8, (edge - area.x) / area.width));
    // Vertical: the panel's new height moves its column's row divider.
    const topH = s.row === 0 ? b.height : area.height - GAP - b.height;
    rowFrac[s.col] = Math.max(0.15, Math.min(0.85, topH / (area.height - GAP)));
    applyBounds(live);
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
    resizable: true,
    // ONE header: the page draws a slim drag strip that hosts the traffic
    // lights AND the expand/collapse controls (his rule, 2026-08-21 — no
    // second header row inside the panel).
    titleBarStyle: "hiddenInset",
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
  watchResize(win);
  return win;
}

export function closeAllDesktopPanels(): void {
  for (const w of [...stack]) { try { if (!w.isDestroyed()) w.close(); } catch { /* gone */ } }
  stack.length = 0;
  broadcastStack(0);
}

const preExpand = new WeakMap<BrowserWindow, Electron.Rectangle>();

export function registerDesktopPanelsIpc(): void {
  // Header controls: EXPAND fills the workspace (remembering where the
  // window sat); COLLAPSE puts it back.
  ipcMain.on("desktop-panel-expand", (event, mode: "expand" | "collapse") => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    if (mode === "expand") {
      preExpand.set(win, win.getBounds());
      win.setBounds(workspaceArea());
    } else {
      const prev = preExpand.get(win);
      if (prev) win.setBounds(prev);
    }
  });

  ipcMain.handle("desktop-panel-open", (_e, spec: PanelSpec) => {
    try { openDesktopPanel(spec); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
}
