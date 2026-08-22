import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from "electron";
import { isRailCollapsed, toggleRailCollapsed, setRailCollapsed } from "./screen-layout";
import fs from "fs";
import os from "os";
import path from "path";
import { generateGlyphhSkill } from "./glyphh-skill-export";
import { isBackgroundEnabled, setBackgroundEnabled } from "./background-mode";
import { type DevicePrompt, startDeviceLogin, cancelDeviceLogin } from "./auth";
import { getClient } from "./glyphh-client";
import type { SessionCache } from "./session-cache";

/** Theme ids whose BASE MODE is light — everything else maps to dark for the OS
 *  window chrome. Must list every light [data-theme] block in styles.css. */
export const LIGHT_THEMES = new Set(["light", "prism", "claude"]);

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
}

export function registerSettingsIpc(deps: SettingsIpcDeps): void {
  const {
    getPreference, setPreference, broadcastTheme,
    startAuthFlow, isAuthenticated,
    getAccountInfo, getAuthStatus, refreshHeartbeat, logout,
    session, sendSessionState,
    getMainWindow, hidePanels,
  } = deps;

  ipcMain.handle("get-theme", () => getPreference<string>("theme", "dark"));
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
  ipcMain.handle("get-background-mode", () => isBackgroundEnabled());
  ipcMain.handle("set-background-mode", (_e, enabled: boolean) => {
    setBackgroundEnabled(!!enabled);
    return isBackgroundEnabled();
  });

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

  ipcMain.handle("start-auth", async (_e, mode: "register" | "login") => startAuthFlow(mode));
  ipcMain.handle("is-authenticated", () => isAuthenticated());

  // Device-flow sign-in: the browser opens on the platform's approval page;
  // the prompt event carries the user code + URL so the renderer can display
  // them while the poll is in flight. Starting again replaces the in-flight
  // grant (a fresh code); cancel aborts it outright.
  ipcMain.handle("start-device-login", async (e) => {
    return startDeviceLogin((prompt) => {
      try { e.sender.send("device-login-prompt", prompt); } catch { /* window gone */ }
    });
  });
  ipcMain.handle("cancel-device-login", () => { cancelDeviceLogin(); return { ok: true }; });
  // Re-open the approval page for an already-displayed code (the browser
  // hand-off is best-effort; this is the "didn't open?" fallback link).
  ipcMain.handle("open-device-approval", (_e, url: string) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) void shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle("get-account-info", () => getAccountInfo());

  // Timezone lives on the user's server profile (users.timezone) and is edited
  // only through Settings › Account (account-ipc's account-profile-update).

  // Rail collapse — shrink the app to just the left rail (and back).
  ipcMain.handle("rail-collapse-get", () => isRailCollapsed());
  ipcMain.handle("rail-collapse-toggle", () => toggleRailCollapsed());
  ipcMain.handle("rail-collapse-set", (_e, on: boolean) => setRailCollapsed(!!on));

  // Reset is a RENDERER-only action now: it closes the workbench panels and
  // parks the agent back in its home column (see resetWorkspace). It no longer
  // touches the OS window (size, position, fullscreen) or the rail — a layout
  // is workspace state, not window state.

  // Per-user usage + credit balance, straight from the server (the proxy meters
  // this org/user). Replaces the old local UsageTracker numbers on the dashboard.

  // Per-CHAT credit usage — server returns { byChat: { <chatId>: { credits,
  // requests } } } with credits in MICRO-credits. Drives the per-chat credit
  // labels on the dashboard HOME landing.

  ipcMain.handle("get-auth-status", () => getAuthStatus());
  ipcMain.handle("refresh-auth", async () => {
    const hb = await refreshHeartbeat();
    return { tier: hb?.tier || "free", status: hb?.status || "unknown" };
  });
  ipcMain.handle("copy-to-clipboard", (_e, text: string) => {
    clipboard.writeText(text);
  });
  ipcMain.handle("logout", () => {
    const mainWindow = getMainWindow();
    logout();
    hidePanels();
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

  // Export a provider-tailored Glyphh skill (Claude / Gemini / OpenAI) — a file
  // that teaches that LLM to drive Glyphh over the MCP relay.
  //
  // Claude has a canonical on-disk skill location (~/.claude/skills/<name>/
  // SKILL.md, picked up by Claude Code + Desktop), so that export installs
  // there directly — no save dialog. Gemini/OpenAI have no standard location
  // (their file is pasted into custom instructions), so those still ask.
  ipcMain.handle("export-glyphh-skill", async (_e, provider: string) => {
    const p = provider === "gemini" || provider === "openai" ? provider : "claude";
    const { filename, content } = generateGlyphhSkill(p as "claude" | "gemini" | "openai");

    if (p === "claude") {
      try {
        const dir = path.join(os.homedir(), ".claude", "skills", "glyphh");
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, "SKILL.md");
        fs.writeFileSync(dest, content, "utf8");
        return { ok: true, path: dest };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: "No window" };
    const result = await dialog.showSaveDialog(win, {
      title: "Export Glyphh skill",
      defaultPath: filename,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: "Canceled" };
    try {
      fs.writeFileSync(result.filePath, content, "utf8");
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Settings → MCP: the caller's connected MCP clients (cloud OAuth grants) ──
  // No typed SDK resource covers /api/me/mcp-clients yet, so these go through
  // the client's authed-HTTP escape hatch (bearer + refresh handled). Same
  // read/write split as apikeys-ipc.ts: the list propagates rejection so the
  // panel paints an honest error; the revoke returns the { ok, error } envelope.
  ipcMain.handle("mcp-clients-list", async () => {
    const res = await getClient().http.get<{ clients: unknown[] }>("/api/me/mcp-clients");
    return res.clients;
  });
  ipcMain.handle("mcp-clients-revoke", async (_e, clientId: string) => {
    try {
      await getClient().http.del(`/api/me/mcp-clients/${encodeURIComponent(String(clientId || ""))}`);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
