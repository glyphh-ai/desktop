import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme } from "electron";
import { getScreenLayout, setScreenLayout, isRailCollapsed, toggleRailCollapsed, setRailCollapsed } from "./screen-layout";
import fs from "fs";
import os from "os";
import path from "path";
import { generateGlyphhSkill } from "./glyphh-skill-export";
import { authRegister, authVerifyCode, authCompleteProfile, authLogin, authForgotPassword, serverGetAuthed, serverPatchAuthed } from "./auth";
import type { SessionCache } from "./session-cache";
import type { PanelManager } from "./panel-manager";

interface SettingsIpcDeps {
  getPreference: <T>(key: string, def?: T) => T;
  setPreference: (key: string, val: unknown) => void;
  broadcastTheme: (resolved: string) => void;
  serverGetAuthed: <T = unknown>(path: string) => Promise<T>;
  startAuthFlow: (mode: "register" | "login") => Promise<unknown>;
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
    serverGetAuthed, startAuthFlow, isAuthenticated,
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

  // Native (in-client) email auth — no popup, no device-code handoff.
  ipcMain.handle("auth-register", (_e, email: string) => authRegister(email));
  ipcMain.handle("auth-verify-code", (_e, email: string, code: string) => authVerifyCode(email, code));
  ipcMain.handle("auth-complete-profile", (_e, data: { email: string; firstName: string; lastName: string; password: string; confirmPassword: string; orgName?: string }) => authCompleteProfile(data));
  ipcMain.handle("auth-login", (_e, email: string, password: string) => authLogin(email, password));
  ipcMain.handle("auth-forgot-password", (_e, email: string) => authForgotPassword(email));

  ipcMain.handle("get-account-info", () => getAccountInfo());

  // Timezone lives on the user's server profile (users.timezone) — same
  // value the platform's Settings > Profile page edits. Not a local pref.
  ipcMain.handle("user-timezone-get", async () => {
    try {
      const me = await serverGetAuthed<{ timezone?: string }>("/api/user/me");
      return me.timezone || "UTC";
    } catch {
      return null;
    }
  });
  // Screen layout — dock mode + fraction (applies live; persists to the
  // user's server profile with a local cache).
  ipcMain.handle("screen-layout-get", () => getScreenLayout());
  // Rail collapse — shrink the app to just the left rail (and back).
  ipcMain.handle("rail-collapse-get", () => isRailCollapsed());
  ipcMain.handle("rail-collapse-toggle", () => toggleRailCollapsed());
  ipcMain.handle("rail-collapse-set", (_e, on: boolean) => setRailCollapsed(!!on));
  ipcMain.handle("screen-layout-set", (_e, v: { mode?: string; fraction?: number }) =>
    setScreenLayout(v as Parameters<typeof setScreenLayout>[0]));

  ipcMain.handle("user-timezone-set", async (_e, timezone: string) => {
    try {
      await serverPatchAuthed("/api/user/me", { timezone });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "save failed" };
    }
  });

  // Org-wide runtime guardrails policy (organizations.guardrails_policy) —
  // server-authoritative and org_admin-gated on the server. Surfaced in the
  // Settings > Security panel; applied to every installed app in P2.3.
  ipcMain.handle("org-guardrails-get", async () => {
    try {
      const r = await serverGetAuthed<{ guardrails_policy?: Record<string, number> | null }>("/api/org/guardrails");
      return { ok: true, policy: r.guardrails_policy ?? null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "load failed" };
    }
  });
  ipcMain.handle("org-guardrails-set", async (_e, policy: Record<string, number> | null) => {
    try {
      await serverPatchAuthed("/api/org/guardrails", { guardrails_policy: policy });
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
