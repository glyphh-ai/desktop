/**
 * background-mode — keep Glyphh running when the window is closed, so scheduled
 * loops/skills (agent-scheduler) and the attach socket stay alive with the app
 * "closed". Governed by the `runInBackground` preference. When ON:
 *   - closing the main window HIDES it instead of quitting the process;
 *   - a tray icon shows Glyphh is resident and offers Open / Quit;
 *   - the app optionally launches at login.
 * A real Quit (tray menu, ⌘Q via app.isQuitting) tears everything down.
 *
 * When OFF the app behaves exactly as before: closing the window quits.
 *
 * Preference: `desktopRunInBackground` (set by the welcome flow's checkbox and
 * Settings → Desktop). The pre-grant `runInBackground` pref is honored as a
 * legacy fallback so an existing opt-in survives the rename.
 */

import { app, Tray, Menu, nativeImage } from "electron";
import path from "path";
import { getPreference, setPreference } from "./stores/preferences-db.js";
import { getMainWindowRef } from "./main-window-ref.js";

let tray: Tray | null = null;

/** The user's setting. Default OFF — background running is opt-in. */
export function isBackgroundEnabled(): boolean {
  const v = getPreference<boolean | null>("desktopRunInBackground", null);
  if (typeof v === "boolean") return v;
  return getPreference<boolean>("runInBackground", false) === true;
}

/** Set on the quit path so the window's close handler stops guarding. */
export function markQuitting(): void {
  (app as unknown as { isQuitting?: boolean }).isQuitting = true;
}
export function isQuitting(): boolean {
  return (app as unknown as { isQuitting?: boolean }).isQuitting === true;
}

function trayIcon(): Electron.NativeImage {
  const img = nativeImage.createFromPath(path.join(__dirname, "..", "..", "assets", "icon.png"));
  // macOS menu-bar wants a small template image; other platforms take the icon.
  return process.platform === "darwin" ? img.resize({ width: 18, height: 18 }) : img;
}

function showMainWindow(): void {
  const win = getMainWindowRef();
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  // Window was closed while resident — ask main to rebuild it.
  onReopenRequested?.();
}

let onReopenRequested: (() => void) | null = null;
/** main.ts registers how to rebuild the window after it was closed in bg mode. */
export function setReopenHandler(fn: () => void): void { onReopenRequested = fn; }

function buildTray(): void {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip("Glyphh — running in the background");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Glyphh", click: showMainWindow },
    { type: "separator" },
    { label: "Quit Glyphh", click: () => { markQuitting(); app.quit(); } },
  ]));
  tray.on("click", showMainWindow);
}

function destroyTray(): void {
  if (tray) { tray.destroy(); tray = null; }
}

/** Reflect the current setting: tray on/off + launch-at-login. Idempotent. */
export function syncBackgroundMode(): void {
  const on = isBackgroundEnabled();
  if (on) buildTray(); else destroyTray();
  // Launch at login only makes sense with background running.
  try {
    app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
  } catch { /* unsupported platform — non-fatal */ }
}

/** Toggle the setting (welcome flow / settings IPC) and apply immediately. */
export function setBackgroundEnabled(enabled: boolean): void {
  setPreference("desktopRunInBackground", !!enabled);
  syncBackgroundMode();
}

/**
 * The window's `close` guard. Returns true when the close should be PREVENTED
 * (hide to tray instead). Call from the window's 'close' event.
 */
export function shouldHideOnClose(): boolean {
  return isBackgroundEnabled() && !isQuitting();
}
