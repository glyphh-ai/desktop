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
import { execFile } from "child_process";
import path from "path";

let ghostWin: BrowserWindow | null = null;

interface Bounds { x: number; y: number; width: number; height: number }

/**
 * Bounds of the app window that is frontmost RIGHT NOW — read before our own
 * window steals focus, so Ghost Mode can size itself exactly over it. macOS via
 * System Events (needs Accessibility permission); null elsewhere or on failure.
 */
function frontmostWindowBounds(): Promise<Bounds | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  const script =
    'tell application "System Events" to tell (first application process whose frontmost is true) to get {position, size} of front window';
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 1500 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const n = String(stdout).trim().split(",").map((s) => parseInt(s.trim(), 10));
      if (n.length !== 4 || n.some((v) => Number.isNaN(v)) || n[2] < 80 || n[3] < 80) { resolve(null); return; }
      resolve({ x: n[0], y: n[1], width: n[2], height: n[3] });
    });
  });
}

/** Centered fallback when the active window's bounds can't be read. */
function centeredFallback(): Bounds {
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(980, Math.round(wa.width * 0.9));
  const height = Math.min(760, Math.round(wa.height * 0.82));
  return { x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2), width, height };
}

async function openGhost(): Promise<void> {
  if (ghostWin && !ghostWin.isDestroyed()) { ghostWin.show(); ghostWin.focus(); return; }
  // Size + position the overlay to EXACTLY match the target app's window.
  const bounds = (await frontmostWindowBounds()) ?? centeredFallback();
  ghostWin = new BrowserWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 240,
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
    // REAL blur-behind: CSS backdrop-filter can only blur content inside the
    // page — it cannot touch the other apps behind a transparent window. The
    // OS compositor does that: vibrancy (macOS) / acrylic (Windows 11).
    ...(process.platform === "darwin" ? { vibrancy: "under-window" as const } : {}),
    ...(process.platform === "win32" ? { backgroundMaterial: "acrylic" as const } : {}),
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
  else void openGhost();
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
