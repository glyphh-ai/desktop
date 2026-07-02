/**
 * Command overlay window — a full-screen, frameless, always-on-top launcher
 * shown by a global hotkey (Cmd+Shift+Space) or the header command icon.
 *
 * It lists the user's apps + saved layouts (command-center.html), and on
 * select opens them as real OS windows via app-window-manager (openAppByRef /
 * openLayoutByName). Nothing renders inside the Glyphh client.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, nativeTheme, screen } from "electron";
import path from "path";
import { openAppByRef, openLayoutByName } from "./app-resolver.js";
import { runDip } from "./dip-commands.js";
import { listOsApps, focusOsApp } from "./os-window-manager.js";
import { getPreference } from "./stores/preferences-db";

/** Resolve the active theme the same way the main window does. */
function currentTheme(): string {
  const t = getPreference<string>("theme", "dark");
  return t === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : t;
}

let win: BrowserWindow | null = null;

/** Executor for non-dip commands typed in the overlay (".drip <effect>" —
 *  routed to the command parser). Injected by main.ts at registration. */
let execFallback: ((cmd: string) => Promise<string> | string | void) | null = null;

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
export function registerCommandWindow(fallback?: (cmd: string) => Promise<string> | string | void): void {
  execFallback = fallback ?? null;
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

  // Free-text command from the overlay input. ".drip <effect>" routes to the
  // command parser (the full-screen effect); everything else goes through the
  // .dip runner (open app/layout, grid/split/min/exp, …).
  ipcMain.handle("command:exec", async (_e, raw: string) => {
    hideCommandWindow();
    const text = String(raw || "").trim();
    if (/^\.?drip\b/i.test(text)) {
      const cmd = text.replace(/^\./, "");
      try { await execFallback?.(cmd); return { ok: true, message: "drip" }; }
      catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    }
    return runDip(text);
  });

  // Running OS apps NOT managed by Glyphh — shown as a lighter section in the
  // overlay so the user can switch to them too. Excludes our own process.
  ipcMain.handle("command:os-apps", async () => {
    try {
      const self = (app.getName() || "").toLowerCase();
      const skip = new Set([self, "electron", "glyphh", "dock"]);
      return (await listOsApps()).filter((a) => !skip.has(a.proc.toLowerCase()));
    } catch {
      return [];
    }
  });

  ipcMain.handle("command:focus-app", async (_e, proc: string) => {
    hideCommandWindow();
    try { await focusOsApp(String(proc)); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
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
