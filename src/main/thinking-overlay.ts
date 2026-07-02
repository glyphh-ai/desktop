/**
 * thinking-overlay — a small "Glyphh is working" indicator shown while a
 * command runs (opening layouts/apps hits the server + window manager, which
 * takes a beat with no visible feedback otherwise).
 *
 * A frameless, transparent, click-through, NON-FOCUSABLE window centered on
 * the display under the cursor: ghost Glyphh mark + white braille spinner +
 * a rotating clever phrase (thinking.html is self-contained). showInactive()
 * so it never steals focus from the apps being opened/arranged.
 *
 * show() is debounced by 150ms — operations that finish faster never flash it.
 */

import { BrowserWindow, screen } from "electron";
import path from "path";

const W = 240;
const H = 220;

let win: BrowserWindow | null = null;
let pendingShow: ReturnType<typeof setTimeout> | null = null;
let visible = false;

function ensure(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep the spinner smooth
    },
  });
  win.setIgnoreMouseEvents(true); // purely visual — clicks pass through
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, "screen-saver");
  void win.loadURL(`file://${path.join(__dirname, "..", "renderer", "thinking.html")}`);
  win.on("closed", () => { if (win) win = null; });
  return win;
}

/** Show the indicator (after a 150ms grace so fast operations never flash). */
export function showThinking(): void {
  if (pendingShow || visible) return;
  pendingShow = setTimeout(() => {
    pendingShow = null;
    const w = ensure();
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    w.setBounds({
      x: Math.round(d.x + (d.width - W) / 2),
      y: Math.round(d.y + (d.height - H) / 2),
      width: W,
      height: H,
    });
    w.showInactive();
    visible = true;
  }, 150);
}

export function hideThinking(): void {
  if (pendingShow) { clearTimeout(pendingShow); pendingShow = null; }
  if (win && !win.isDestroyed() && visible) win.hide();
  visible = false;
}

export function disposeThinking(): void {
  hideThinking();
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
