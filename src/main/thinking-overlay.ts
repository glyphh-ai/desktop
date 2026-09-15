/**
 * thinking-overlay — a full-screen "Glyphh is working" scrim shown while a
 * command runs (opening layouts/apps hits the server + window manager, which
 * takes a beat with no visible feedback otherwise).
 *
 * A frameless, transparent, click-through, NON-FOCUSABLE window covering the
 * ENTIRE display under the cursor: dimmed scrim + ghost Glyphh mark + white
 * braille spinner + a rotating clever phrase (thinking.html is self-contained).
 * showInactive() so it never steals focus from the apps being opened/arranged,
 * and moveTop() after showing so it sits above other screen-saver-level
 * windows (the command palette lives at the same level).
 *
 * initThinkingOverlay() pre-creates the window at app startup so the first
 * show doesn't pay window-creation + page-load while the main process is busy
 * spawning app windows — that lag was why the spinner used to appear only
 * after the layout had mostly loaded.
 *
 * showThinking() is debounced by 150ms so fast operations never flash it;
 * showThinking({ immediate: true }) skips the debounce for explicit user
 * actions (clicking a layout/app in the palette) where instant feedback is
 * the whole point.
 */

import { BrowserWindow, screen } from "electron";
import path from "path";

// Once shown, stay up at least this long — a sub-100ms operation (cache-hit
// layout open) would otherwise flash the scrim for a single frame.
const MIN_VISIBLE_MS = 300;

let win: BrowserWindow | null = null;
let pendingShow: ReturnType<typeof setTimeout> | null = null;
let pendingHide: ReturnType<typeof setTimeout> | null = null;
let shownAt = 0;
let visible = false;

function ensure(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 800,
    height: 600,
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

/** Pre-create the (hidden) overlay window so the first showThinking() is
 *  instant. Call once at app startup, after app.whenReady(). */
export function initThinkingOverlay(): void {
  ensure();
}

function reveal(): void {
  const w = ensure();
  // Cover the ENTIRE display under the cursor (bounds, not workArea — the
  // scrim should sit over the menu bar / taskbar too).
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
  w.setBounds(d);
  w.showInactive();
  // Same always-on-top level as the command palette — explicitly move above.
  w.moveTop();
  shownAt = Date.now();
  visible = true;
}

/** Show the scrim. Debounced 150ms by default so fast operations never flash
 *  it; pass { immediate: true } for explicit user actions (palette clicks). */
export function showThinking(opts?: { immediate?: boolean }): void {
  if (pendingHide) { clearTimeout(pendingHide); pendingHide = null; }
  if (visible) return;
  if (opts?.immediate) {
    if (pendingShow) { clearTimeout(pendingShow); pendingShow = null; }
    reveal();
    return;
  }
  if (pendingShow) return;
  pendingShow = setTimeout(() => {
    pendingShow = null;
    reveal();
  }, 150);
}

function doHide(): void {
  if (win && !win.isDestroyed() && visible) win.hide();
  visible = false;
}

export function hideThinking(): void {
  if (pendingShow) { clearTimeout(pendingShow); pendingShow = null; }
  if (!visible) return;
  // Hold the scrim to MIN_VISIBLE_MS so a fast (cached) operation reads as a
  // deliberate transition rather than a one-frame flicker.
  const elapsed = Date.now() - shownAt;
  if (elapsed < MIN_VISIBLE_MS) {
    if (pendingHide) return;
    pendingHide = setTimeout(() => { pendingHide = null; doHide(); }, MIN_VISIBLE_MS - elapsed);
    return;
  }
  doHide();
}

export function disposeThinking(): void {
  if (pendingShow) { clearTimeout(pendingShow); pendingShow = null; }
  if (pendingHide) { clearTimeout(pendingHide); pendingHide = null; }
  visible = false;
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
