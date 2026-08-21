/**
 * echo-overlay — ⌘⇧Space: Echo, full screen, over the desktop.
 *
 * A frameless window covering the display under the cursor, hosting the SAME
 * home page (home.html?solo=echo — Echo boots as always, chrome hidden). It
 * behaves like a launcher overlay: Esc closes it (the solo=echo branch in
 * home.ts), the shortcut toggles it, and blur closes it so it never lingers
 * behind whatever the user switched to. The main window is untouched — this
 * is a second, summonable Echo, not a mode of the first.
 *
 * (Future: a pin control could re-level this window to 'desktop' type so Echo
 * docks BEHIND every app as the wallpaper layer.)
 */

import { BrowserWindow, screen } from "electron";
import path from "path";

let win: BrowserWindow | null = null;

export function toggleEchoOverlay(): void {
  if (win && !win.isDestroyed()) { win.close(); return; }
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  win = new BrowserWindow({
    ...d.bounds,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "renderer", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on("blur", () => { try { win?.close(); } catch { /* already closing */ } });
  win.on("closed", () => { win = null; });
  void win.loadFile(path.join(__dirname, "..", "renderer", "home.html"), { query: { solo: "echo" } });
  win.once("ready-to-show", () => { win?.show(); win?.focus(); });
}

export function disposeEchoOverlay(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
