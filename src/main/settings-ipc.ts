import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, powerSaveBlocker } from "electron";
import { authRegister, authVerifyCode, authCompleteProfile, authLogin, authForgotPassword, serverGetAuthed, serverPatchAuthed } from "./auth";
import type { LLMConfig } from "./llm-config";
import type { SessionCache } from "./session-cache";
import type { PanelManager } from "./panel-manager";
import type { CloudSync } from "./cloud-sync";
import type * as providerKeysModule from "./provider-keys";
import type { Transcriber } from "./transcriber";

interface SettingsIpcDeps {
  getPreference: <T>(key: string, def?: T) => T;
  setPreference: (key: string, val: unknown) => void;
  getCurrentLimits: () => unknown;
  broadcastTheme: (resolved: string) => void;
  serverGetAuthed: <T = unknown>(path: string) => Promise<T>;
  startAuthFlow: (mode: "register" | "login") => Promise<unknown>;
  isAuthenticated: () => boolean;
  getAccountInfo: () => unknown;
  getAuthStatus: () => unknown;
  refreshHeartbeat: () => Promise<{ tier?: string; status?: string } | null>;
  logout: () => void;
  llmConfig: { provider: string; model: string };
  saveLLMConfig: (config: LLMConfig) => void;
  applyLLMConfig: (config: LLMConfig) => void;
  fetchServerModels: () => Promise<Array<{ provider: string; model: string }>>;
  session: SessionCache;
  sendSessionState: () => void;
  providerKeys: typeof providerKeysModule;
  ccBootstrapStatus: () => unknown;
  transcriber: Transcriber;
  cloudSyncInstance: CloudSync | null;
  execCommand: (cmd: string, sourcePanelId?: string) => Promise<string>;
  getMainWindow: () => BrowserWindow | null;
  panelManager: PanelManager;
}

// Active power-save-blocker id for the "Keep awake" toggle (-1 = none).
let keepAwakeBlockerId = -1;

export function registerSettingsIpc(deps: SettingsIpcDeps): void {
  const {
    getPreference, setPreference, getCurrentLimits, broadcastTheme,
    serverGetAuthed, startAuthFlow, isAuthenticated,
    getAccountInfo, getAuthStatus, refreshHeartbeat, logout,
    llmConfig, saveLLMConfig, applyLLMConfig, fetchServerModels,
    session, sendSessionState,
    providerKeys, ccBootstrapStatus,
    transcriber, cloudSyncInstance,
    getMainWindow, panelManager,
  } = deps;

  ipcMain.handle("get-entitlements", () => getCurrentLimits());

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

  ipcMain.handle("dev-flags", () => ({
    cyphersEnabled: process.env.YO_CYPHERS_ENABLED === "1" || process.env.YO_CYPHERS_ENABLED === "true",
    enableGhAuth: process.env.YO_ENABLE_GH_AUTH === "1" || process.env.YO_ENABLE_GH_AUTH === "true",
  }));

  ipcMain.handle("gh-app-install", async () => {
    try {
      const r = await serverGetAuthed<{ slug: string; installUrl: string }>("/api/github/app-info");
      if (!r?.installUrl) return { ok: false, error: "GitHub App not configured" };

      const installed = await new Promise<boolean>((resolve) => {
        const win = new BrowserWindow({
          width: 1024,
          height: 720,
          title: "Install yo-cypher on GitHub",
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });

        let resolved = false;
        const finish = (val: boolean) => {
          if (resolved) return;
          resolved = true;
          resolve(val);
          try { if (!win.isDestroyed()) win.close(); } catch {}
        };

        const checkNav = (navUrl: string) => {
          try {
            const u = new URL(navUrl);
            if (
              u.searchParams.has("installation_id") ||
              /\/settings\/installations\/\d+/.test(u.pathname)
            ) {
              finish(true);
            }
          } catch {}
        };
        win.webContents.on("will-redirect", (_e, navUrl) => checkNav(navUrl));
        win.webContents.on("will-navigate", (_e, navUrl) => checkNav(navUrl));
        win.webContents.on("did-navigate", (_e, navUrl) => checkNav(navUrl));
        win.on("closed", () => finish(false));

        win.loadURL(r.installUrl);
      });

      return { ok: true, installed };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "unknown error" };
    }
  });

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
  ipcMain.handle("user-timezone-set", async (_e, timezone: string) => {
    try {
      await serverPatchAuthed("/api/user/me", { timezone });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "save failed" };
    }
  });

  // Per-user usage + credit balance, straight from the server (the proxy meters
  // this org/user). Replaces the old local UsageTracker numbers on the dashboard.
  ipcMain.handle("user-usage", async (_e, range?: { from?: string; to?: string; tz?: string }) => {
    const qs = new URLSearchParams();
    if (range?.from) qs.set("from", range.from);
    if (range?.to) qs.set("to", range.to);
    if (range?.tz) qs.set("tz", range.tz);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const [credits, usage] = await Promise.all([
      serverGetAuthed<{ balance: number; grants: number; purchases: number }>("/api/billing/credits").catch(() => null),
      serverGetAuthed<{ days: Array<Record<string, number | string>> }>(`/api/usage/daily${suffix}`).catch(() => ({ days: [] })),
    ]);
    return { credits, days: usage?.days || [] };
  });

  // Per-CHAT credit usage — server returns { byChat: { <chatId>: { credits,
  // requests } } } with credits in MICRO-credits. Drives the per-chat credit
  // labels on the dashboard HOME landing.
  ipcMain.handle("usage-by-chat", async () => serverGetAuthed("/api/usage/by-chat").catch(() => ({ byChat: {} })));

  // Models the Glyphh agent can actually use — server-filtered for this user
  // (Anthropic ∩ plan ∩ org ∩ user allow-lists), with a guaranteed-usable default.
  ipcMain.handle("agent-models", async () => {
    return serverGetAuthed<{ models: Array<{ provider: string; model: string; display_name: string }>; default_model: string | null }>(
      "/api/models?proxy=1",
    ).catch(() => ({ models: [], default_model: null }));
  });

  ipcMain.handle("get-auth-status", () => getAuthStatus());
  ipcMain.handle("refresh-auth", async () => {
    const hb = await refreshHeartbeat();
    if (hb) cloudSyncInstance?.resetAuth();
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
  ipcMain.handle("validate-api-key", async () => ({ valid: true }));
  ipcMain.handle("get-api-key", () => null);

  ipcMain.handle("get-llm-config", () => ({
    provider: llmConfig.provider,
    model: llmConfig.model,
  }));
  ipcMain.handle("get-llm-presets", async () => {
    const models = await fetchServerModels();
    if (models.length === 0) {
      return { anthropic: { name: "Anthropic", models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"], defaultModel: "claude-sonnet-4-6" } };
    }
    const grouped: Record<string, { name: string; models: string[]; defaultModel: string }> = {};
    for (const m of models) {
      if (!grouped[m.provider]) grouped[m.provider] = { name: m.provider.charAt(0).toUpperCase() + m.provider.slice(1), models: [], defaultModel: "" };
      grouped[m.provider].models.push(m.model);
    }
    if (grouped.anthropic) grouped.anthropic.defaultModel = "claude-sonnet-4-6";
    for (const key of Object.keys(grouped)) {
      if (!grouped[key].defaultModel) grouped[key].defaultModel = grouped[key].models[0];
    }
    return grouped;
  });
  ipcMain.handle("save-llm-config", async (_e, config: LLMConfig) => {
    saveLLMConfig(config);
    applyLLMConfig(config);
    return { ok: true };
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

  ipcMain.handle("transcribe-audio", async (_e, audioBuffer: ArrayBuffer) => {
    try {
      const float32 = new Float32Array(audioBuffer);
      const text = await transcriber.transcribe(float32);
      return { ok: true, text };
    } catch (err: any) {
      console.error("[transcribe]", err);
      return { ok: false, error: err.message || "Transcription failed" };
    }
  });

  // Providers Settings panel removed. The only surviving provider-key path is
  // the Claude Code BYOK bootstrap gate (boot-gate-ui.ts), which saves an
  // Anthropic key so cc-status flips true. provider-keys.ts also still backs
  // the transcriber (Whisper) and cc-bootstrap.
  ipcMain.handle("provider-keys-set", async (_e, provider: string, key: string) => {
    try {
      await providerKeys.setKey(provider as providerKeysModule.ProviderId, key);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "save failed" };
    }
  });

  ipcMain.handle("cc-status", () => ccBootstrapStatus());

  // Keep awake — block app suspension.
  ipcMain.on("set-keep-awake", (_e, on: boolean) => { applyKeepAwake(!!on); });
  // Apply the saved preference at startup.
  applyKeepAwake(getPreference<boolean>("schedulesKeepAwake", false));
  function applyKeepAwake(on: boolean): void {
    setPreference("schedulesKeepAwake", on);
    const active = keepAwakeBlockerId >= 0 && powerSaveBlocker.isStarted(keepAwakeBlockerId);
    if (on && !active) {
      keepAwakeBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    } else if (!on && active) {
      powerSaveBlocker.stop(keepAwakeBlockerId);
      keepAwakeBlockerId = -1;
    }
  }
}
