/**
 * ghost-mode — summon the coding agent as a translucent overlay ON TOP of
 * whatever app is in front, without leaving it.
 *
 * A global hotkey (Cmd+Shift+G / Ctrl+Shift+G) toggles a frameless, transparent,
 * always-on-top window that fills the display under the cursor and loads the
 * renderer in `?solo=ghost` mode — a floating glass card with the Coding Agent
 * over a dim, blurred backdrop that lets the app behind show through. Esc, a
 * backdrop click (→ "ghost-close" IPC), or the hotkey again dismisses it and
 * focus returns to the app you were in.
 *
 * It rides at "screen-saver" level and is visible on fullscreen spaces, so it
 * appears even over a fullscreen editor or browser.
 */

import { BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import path from "path";

let ghostWin: BrowserWindow | null = null;

function openGhost(): void {
  if (ghostWin && !ghostWin.isDestroyed()) { ghostWin.show(); ghostWin.focus(); return; }
  // A card-sized panel that floats over the active app — NOT the whole screen.
  // Centered on the display under the cursor; the user can drag it (the card's
  // top strip is a drag region) to sit right over the app they're working in.
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(980, Math.round(wa.width * 0.9));
  const height = Math.min(760, Math.round(wa.height * 0.82));
  const x = Math.round(wa.x + (wa.width - width) / 2);
  const y = Math.round(wa.y + (wa.height - height) / 2);
  ghostWin = new BrowserWindow({
    x, y, width, height,
    minWidth: 420,
    minHeight: 320,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "..", "renderer", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  // Float above everything, including fullscreen apps and other overlays.
  ghostWin.setAlwaysOnTop(true, "screen-saver");
  ghostWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ghostWin.on("closed", () => { ghostWin = null; });
  void ghostWin.loadFile(path.join(__dirname, "..", "renderer", "home.html"), { query: { solo: "ghost" } });
  ghostWin.once("ready-to-show", () => { ghostWin?.show(); ghostWin?.focus(); });
}

function closeGhost(): void {
  const w = ghostWin;
  ghostWin = null;
  try { if (w && !w.isDestroyed()) w.close(); } catch { /* already closing */ }
}

export function toggleGhost(): void {
  if (ghostWin && !ghostWin.isDestroyed()) closeGhost();
  else openGhost();
}

export function isGhostOpen(): boolean {
  return !!(ghostWin && !ghostWin.isDestroyed());
}

/** Register the global hotkey + the renderer's close channel. Idempotent. */
export function registerGhostMode(): void {
  const accelerator = process.platform === "darwin" ? "Command+Shift+G" : "Control+Shift+G";
  try {
    globalShortcut.register(accelerator, toggleGhost);
  } catch { /* accelerator unavailable — non-fatal, ghost just won't hotkey */ }
  // The overlay renderer asks to dismiss itself (Esc / backdrop click).
  ipcMain.handle("ghost-close", () => { closeGhost(); return { ok: true }; });
}

/** Tear the overlay down on quit. globalShortcut.unregisterAll() runs elsewhere. */
export function destroyGhostMode(): void {
  closeGhost();
}
