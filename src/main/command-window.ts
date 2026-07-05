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
import { listOsApps, focusOsAppFullscreen, frontWindow, type OsWindow } from "./os-window-manager.js";
import { showThinking, hideThinking, disposeThinking } from "./thinking-overlay.js";
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

// The window that was frontmost when the palette opened — `.dip exp` / `.dip
// min` typed INTO the palette target this window. Without it they'd act on
// whatever ends up focused after the palette hides (often Glyphh itself),
// which read as "native apps don't respond to exp/min".
let priorFront: OsWindow | null = null;

export function showCommandWindow(): void {
  if (!win || win.isDestroyed()) win = createWindow();
  // Capture BEFORE taking focus; skip our own windows (Glyphh was already
  // frontmost when the hotkey fired from inside the app).
  priorFront = null;
  void frontWindow().then((f) => {
    if (f && f.pid !== process.pid) priorFront = f;
  }).catch(() => {});
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
  // Explicit palette clicks: scrim FIRST (immediate — instant feedback is the
  // point), THEN hide the palette, so there's never a frame of bare desktop.
  ipcMain.handle("command:open-app", async (_e, ref: string) => {
    showThinking({ immediate: true });
    hideCommandWindow();
    try {
      const spec = await openAppByRef(String(ref));
      return { ok: true, app: spec.slug };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      hideThinking();
    }
  });

  ipcMain.handle("command:open-layout", async (_e, name: string) => {
    showThinking({ immediate: true });
    hideCommandWindow();
    try {
      return { ok: true, ...(await openLayoutByName(String(name))) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      hideThinking();
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
    showThinking();
    // Pass the pre-palette front window so `.dip exp` / `.dip min` typed here
    // act on the app the user was in, not on Glyphh (frontmost at exec time).
    try { return await runDip(text, { focusTarget: priorFront }); }
    finally { hideThinking(); }
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
    showThinking({ immediate: true });
    hideCommandWindow();
    // Focus AND land full-screen — same contract as opening a library app.
    try { await focusOsAppFullscreen(String(proc)); return { ok: true }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    finally { hideThinking(); }
  });

  ipcMain.on("command:close", () => hideCommandWindow());
  ipcMain.on("command:toggle", () => toggleCommandWindow());

  const ok = globalShortcut.register(HOTKEY, () => toggleCommandWindow());
  if (!ok) console.error(`[command] failed to register global shortcut ${HOTKEY}`);
}

/** Release the global hotkey (call on app quit). */
export function disposeCommandWindow(): void {
  globalShortcut.unregister(HOTKEY);
  disposeThinking();
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
