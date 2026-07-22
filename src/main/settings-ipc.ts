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
import type { PanelManager } from "./panel-manager";

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
  execCommand: (cmd: string, sourcePanelId?: string) => Promise<string>;
  getMainWindow: () => BrowserWindow | null;
  panelManager: PanelManager;
}

export function registerSettingsIpc(deps: SettingsIpcDeps): void {
  const {
    getPreference, setPreference, broadcastTheme,
    startAuthFlow, isAuthenticated,
    getAccountInfo, getAuthStatus, refreshHeartbeat, logout,
    session, sendSessionState,
    getMainWindow, panelManager,
  } = deps;

  ipcMain.handle("get-theme", () => getPreference<string>("theme", "dark"));
  ipcMain.handle("set-theme", (_e, theme: string) => {
    setPreference("theme", theme);
    // nativeTheme only accepts system|light|dark, but theme ids can be richer
    // (purple, aurora, custom-*). Map to a base mode for the OS chrome; the
    // renderer drives the real palette via [data-theme="<theme>"].
    nativeTheme.themeSource = theme === "system" ? "system" : theme === "light" ? "light" : "dark";
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
    return deps.execCommand(cmd, panelManager.activePanelId ?? undefined);
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

  // Timezone lives on the user's server profile (users.timezone) — same
  // value the platform's Settings > Profile page edits. Not a local pref.
  ipcMain.handle("user-timezone-get", async () => {
    try {
      const me = await getClient().profile.get();
      return me.timezone || "UTC";
    } catch {
      return null;
    }
  });
  // Rail collapse — shrink the app to just the left rail (and back).
  ipcMain.handle("rail-collapse-get", () => isRailCollapsed());
  ipcMain.handle("rail-collapse-toggle", () => toggleRailCollapsed());
  ipcMain.handle("rail-collapse-set", (_e, on: boolean) => setRailCollapsed(!!on));

  ipcMain.handle("user-timezone-set", async (_e, timezone: string) => {
    try {
      await getClient().profile.update({ timezone });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "save failed" };
    }
  });

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
    if (mainWindow) panelManager.hideActive(mainWindow);
    mainWindow?.webContents.send("show-onboarding");
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
}
