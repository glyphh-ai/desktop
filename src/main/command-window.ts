/**
 * Command overlay window — a full-screen, frameless, always-on-top launcher
 * shown by a global hotkey (Cmd+Shift+Space) or the header command icon.
 *
 * It lists the user's apps + saved layouts (command-center.html), and on
 * select opens them as real OS windows via app-window-manager (openAppByRef /
 * openLayoutByName). Nothing renders inside the Glyphh client.
 */

import { BrowserWindow, globalShortcut, ipcMain, nativeTheme, screen } from "electron";
import path from "path";
import { openAppByRef, openLayoutByName } from "./app-resolver.js";
import { getPreference } from "./stores/preferences-db";

/** Resolve the active theme the same way the main window does. */
function currentTheme(): string {
  const t = getPreference<string>("theme", "dark");
  return t === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : t;
}

let win: BrowserWindow | null = null;

const HOTKEY = "CommandOrControl+Shift+Space";

function overlayUrl(): string {
  // dist/main/command-window.js → ../renderer/command-center.html
  return `file://${path.join(__dirname, "..", "renderer", "command-center.html")}`;
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "command-preload.js"),
    },
  });
  // Float above full-screen apps and follow the user across Spaces.
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.setAlwaysOnTop(true, "screen-saver");
  void w.loadURL(overlayUrl());
  // Dismiss on focus loss (clicking an opened app steals focus → hide).
  w.on("blur", () => hideCommandWindow());
  w.on("closed", () => { if (win === w) win = null; });
  return w;
}

/** Cover the whole display under the cursor (bounds, not workArea). */
function coverCursorDisplay(w: BrowserWindow): void {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  w.setBounds(d.bounds);
}

export function showCommandWindow(): void {
  if (!win || win.isDestroyed()) win = createWindow();
  coverCursorDisplay(win);
  win.show();
  win.focus();
  win.webContents.send("command:refresh", currentTheme());
}

export function hideCommandWindow(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

export function toggleCommandWindow(): void {
  if (win && !win.isDestroyed() && win.isVisible()) hideCommandWindow();
  else showCommandWindow();
}

/** Register the overlay's IPC + global hotkey. Call once at startup. */
export function registerCommandWindow(): void {
  ipcMain.handle("command:open-app", async (_e, ref: string) => {
    hideCommandWindow();
    try {
      const spec = await openAppByRef(String(ref));
      return { ok: true, app: spec.slug };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("command:open-layout", async (_e, name: string) => {
    hideCommandWindow();
    try {
      return { ok: true, ...(await openLayoutByName(String(name), "screen")) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Free-text ".dip" command from the overlay input. Opens a layout or app
  // (or several apps split by "|") at the OS level. Leading "dip"/".dip" is
  // optional so both "dip email" and "email" work.
  ipcMain.handle("command:exec", async (_e, raw: string) => {
    hideCommandWindow();
    const text = String(raw || "").trim().replace(/^\.?dip\s+/i, "").trim();
    if (!text) return { ok: false, error: "empty command" };
    try {
      if (text.includes("|")) {
        const opened: string[] = [];
        for (const n of text.split("|").map((s) => s.trim()).filter(Boolean)) {
          opened.push((await openAppByRef(n)).slug);
        }
        return { ok: true, apps: opened };
      }
      // Single token: try a layout first, then fall back to an app.
      try {
        return { ok: true, ...(await openLayoutByName(text, "screen")) };
      } catch {
        return { ok: true, app: (await openAppByRef(text)).slug };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.on("command:close", () => hideCommandWindow());
  ipcMain.on("command:toggle", () => toggleCommandWindow());

  const ok = globalShortcut.register(HOTKEY, () => toggleCommandWindow());
  if (!ok) console.error(`[command] failed to register global shortcut ${HOTKEY}`);
}

/** Release the global hotkey (call on app quit). */
export function disposeCommandWindow(): void {
  globalShortcut.unregister(HOTKEY);
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
