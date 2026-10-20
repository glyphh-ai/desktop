import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, systemPreferences } from "electron";
import { isRailCollapsed, toggleRailCollapsed, setRailCollapsed } from "./screen-layout";
import { type DevicePrompt, startDeviceLogin, cancelDeviceLogin } from "./auth";
import type { SessionCache } from "./session-cache";

/** Theme ids whose BASE MODE is light — everything else maps to dark for the OS
 *  window chrome. Must list every light [data-theme] block in styles.css. */
export const LIGHT_THEMES = new Set(["light", "modern-light", "prism", "claude"]);

/** "highvis" became "dark" on 2026-09-22 (High Vis IS the dark theme now; the
 *  old dark lives on as "modern-dark"). A pref saved under the retired id reads
 *  as the new one, so the picker marks it and the OS chrome maps it. */
export function normalizeThemeId(theme: string): string {
  return theme === "highvis" ? "dark" : theme;
}

interface SettingsIpcDeps {
  getPreference: <T>(key: string, def?: T) => T;
  setPreference: (key: string, val: unknown) => void;
  broadcastTheme: (resolved: string) => void;
  startAuthFlow: (mode?: "register" | "login", onPrompt?: (prompt: DevicePrompt) => void) => Promise<boolean>;
  isAuthenticated: () => boolean;
  getAccountInfo: () => unknown;
  getAuthStatus: () => unknown;
  refreshHeartbeat: () => Promise<{ tier?: string; status?: string } | null>;
  logout: () => void;
  session: SessionCache;
  sendSessionState: () => void;
  execCommand: (cmd: string) => Promise<string>;
  getMainWindow: () => BrowserWindow | null;
  /** Detach the home view so the onboarding overlay is visible (logout). */
  hidePanels: () => void;
  /** Deliver an event to EVERY renderer that paints identity (main window +
   *  home view) — the rail's chip lives in home.html, not index.html. */
  broadcastAccountUpdated?: (info: unknown) => void;
  /** Reload the home view — SIGN-IN calls it so the workspace boots pristine
   *  for the user who just authenticated (his report, 2026-08-28: user B saw
   *  user A's wall until a page refetch). Logout reloads on its way OUT; this
   *  is the same law on the way IN, covering every path that reaches a login
   *  without tearing the renderer down. */
  reloadHome?: () => void;
}

export function registerSettingsIpc(deps: SettingsIpcDeps): void {
  const {
    getPreference, setPreference, broadcastTheme,
    startAuthFlow, isAuthenticated,
    getAccountInfo, getAuthStatus, refreshHeartbeat, logout,
    session, sendSessionState,
    getMainWindow, hidePanels,
  } = deps;

  ipcMain.handle("get-theme", () => normalizeThemeId(getPreference<string>("theme", "dark")));
  ipcMain.handle("set-theme", (_e, theme: string) => {
    setPreference("theme", theme);
    // nativeTheme only accepts system|light|dark, but theme ids can be richer
    // (purple, aurora, prism, claude, …). Map to a base mode for the OS chrome;
    // the renderer drives the real palette via [data-theme="<theme>"].
    nativeTheme.themeSource = theme === "system" ? "system" : LIGHT_THEMES.has(theme) ? "light" : "dark";
    const resolved = theme === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : theme;
    broadcastTheme(resolved);
  });

  // Background mode: keep Glyphh resident (tray + scheduler + attach) when the
  // window closes, so scheduled loops/skills fire with the app "closed".

  ipcMain.handle("exec-command", async (_e, cmd: string) => {
    return deps.execCommand(cmd);
  });

  ipcMain.handle("session-info", () => session.getInfo());
  ipcMain.handle("session-clear", () => {
    session.clear();
    sendSessionState();
    return true;
  });

  ipcMain.handle("get-app-version", () => app.getVersion());

  // THE MIC'S OS-LEVEL STATE (his report, 2026-08-29: the mic button flashes
  // then goes cold without recording). getUserMedia's NotAllowedError cannot
  // tell "the user denied us in System Settings" from "no device" — macOS can,
  // so ask it. 'not-determined' triggers the OS prompt right here; 'denied'
  // is unrecoverable in-app and the renderer says so with a way out.
  ipcMain.handle("mic-access-status", async () => {
    if (process.platform !== "darwin") return { status: "granted" as const };
    try {
      let status = systemPreferences.getMediaAccessStatus("microphone");
      if (status === "not-determined") {
        await systemPreferences.askForMediaAccess("microphone").catch(() => false);
        status = systemPreferences.getMediaAccessStatus("microphone");
      }
      return { status };
    } catch (e) {
      return { status: "unknown" as const, error: (e as Error).message };
    }
  });
  // The only route out of a denial: the OS pane that owns the switch.
  ipcMain.handle("mic-open-settings", () => {
    if (process.platform === "darwin") {
      void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    }
    return { ok: true };
  });

  ipcMain.handle("start-auth", async (_e, mode: "register" | "login") => {
    const ok = await startAuthFlow(mode);
    // A fresh sign-in boots the workspace pristine — the renderer may still
    // hold the PREVIOUS user's wall, apps, and caches in memory (the logout
    // reload only covers flows that went through logout).
    if (ok) deps.reloadHome?.();
    return ok;
  });
  ipcMain.handle("is-authenticated", () => isAuthenticated());

  // Device-flow sign-in: the browser opens on the platform's approval page;
  // the prompt event carries the user code + URL so the renderer can display
  // them while the poll is in flight. Starting again replaces the in-flight
  // grant (a fresh code); cancel aborts it outright.
  ipcMain.handle("start-device-login", async (e) => {
    const res = await startDeviceLogin((prompt) => {
      try { e.sender.send("device-login-prompt", prompt); } catch { /* window gone */ }
    });
    // Same pristine-boot law as start-auth: the user changed — the home
    // renderer must never carry the previous user's surface across.
    if ((res as { ok?: boolean } | null)?.ok) deps.reloadHome?.();
    return res;
  });
  ipcMain.handle("cancel-device-login", () => { cancelDeviceLogin(); return { ok: true }; });
  // Re-open the approval page for an already-displayed code (the browser
  // hand-off is best-effort; this is the "didn't open?" fallback link).
  ipcMain.handle("open-device-approval", (_e, url: string) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) void shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle("get-account-info", () => getAccountInfo());

  // Rail collapse — shrink the app to just the left rail (and back).
  ipcMain.handle("rail-collapse-get", () => isRailCollapsed());
  ipcMain.handle("rail-collapse-toggle", () => toggleRailCollapsed());
  ipcMain.handle("rail-collapse-set", (_e, on: boolean) => setRailCollapsed(!!on));

  // Reset is a RENDERER-only action now: it closes the workbench panels and
  // parks the agent back in its home column (see resetWorkspace). It no longer
  // touches the OS window (size, position, fullscreen) or the rail — a layout
  // is workspace state, not window state.

  ipcMain.handle("get-auth-status", () => getAuthStatus());
  ipcMain.handle("refresh-auth", async () => {
    const hb = await refreshHeartbeat();
    return { tier: hb?.tier || "none", status: hb?.status || "unknown" };
  });
  ipcMain.handle("copy-to-clipboard", (_e, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle("logout", () => {
    const mainWindow = getMainWindow();
    logout();
    hidePanels();
    // The ATTACHED-AGENT overlay is a second renderer with the whole session
    // surface in memory (his report, 2026-08-28: "can't be logged out — the
    // user never resets"). Reloading only the main window left it live and
    // signed-in over whatever app it rode. Sign-out tears it down with
    // everything else; ⌘⇧G after the next login starts it fresh.
    // The identity chips reset immediately — without this the rail kept the
    // previous user's name while signed out (and, before the home-view send
    // existed, for the whole next login too).
    deps.broadcastAccountUpdated?.(null);
    // FULL RENDERER RELOAD (his bug, 2026-08-20: logging back in as another
    // user still showed the prior user's sessions). The renderer holds the
    // whole session surface in memory — chats, caches, live pollers (the
    // dead-token glyphh-threads-list spam after sign-out) — and no broadcast
    // reliably reaches every module. Reload boots it pristine; the signed-out
    // boot path lands on onboarding by itself. The app-origin localStorage
    // goes too ("logout must wipe local leak") — webview site sessions live
    // in their own persist:yo partition and are untouched.
    try {
      void mainWindow?.webContents.session.clearStorageData({ storages: ["localstorage"] }).catch(() => { /* best-effort */ });
    } catch { /* best-effort */ }
    mainWindow?.webContents.reload();
  });

  ipcMain.handle("pick-directory", async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: "Choose project directory",
      buttonLabel: "Select",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Native-app exec-path picker (pivot-mcp). Analogous to pick-directory but
  // for a single file. On macOS a .app is a bundle (a directory) — we do NOT
  // pass treatPackageAsDirectory so the dialog returns the .app path itself
  // as a file selection, which is exactly what we want as the executable path.
  ipcMain.handle("pick-executable", async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      title: "Choose application or executable",
      buttonLabel: "Select",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}
