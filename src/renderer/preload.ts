/**
 * Preload script — exposes IPC to the renderer safely.
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";

/** Server-authoritative Apps tab record — mirrors yo-server's SavedApp
 *  (saved-app-service.ts). `id` is the server row's UUID; `slug` is the
 *  human-readable identifier shown/edited in the UI. */
export interface SavedPanelApp {
  id: string;
  orgId: string;
  createdBy: string;
  name: string;
  slug: string;
  url: string | null;
  forceWeb: boolean;
  // Browser ↔ Native model (pivot-mcp). isBrowser=true (default) → web app
  // with a url + browserTarget; false → native desktop app with execPath +
  // an archetype-specific launchConfig.
  isBrowser?: boolean;
  browserTarget?: "webview" | "native";
  execPath?: string | null;
  appArchetype?: string | null;
  launchConfig?: Record<string, unknown> | null;
  connection: { pipedreamSlug: string; accountId?: string; healthy?: boolean } | null;
  mcp: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; oauth?: { clientId: string; hasSecret: boolean; tokenUrl: string; scope?: string }; enabled: boolean } | null;
  commands: Record<string, { selector: string; action: string; description?: string; text?: string }>;
  createdAt: string;
  updatedAt: string;
}

// Fields the create/update calls forward to /api/panel-apps. Kept as a named
// type so preload + renderer stay in sync on the accepted keys.
export interface PanelAppInput {
  name?: string;
  slug?: string;
  url?: string | null;
  forceWeb?: boolean;
  isBrowser?: boolean;
  browserTarget?: "webview" | "native";
  execPath?: string | null;
  appArchetype?: string | null;
  launchConfig?: Record<string, unknown> | null;
}

contextBridge.exposeInMainWorld("yo", {
  copyToClipboard: (text: string) => ipcRenderer.invoke("copy-to-clipboard", text),
  // Resolve a dropped/selected File to its absolute on-disk path. Electron 32+
  // removed File.path; webUtils.getPathForFile is the supported replacement.
  getPathForFile: (file: File): string => { try { return webUtils.getPathForFile(file); } catch { return ""; } },
  windowClose: () => ipcRenderer.send("window-close"),
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  windowMaximize: () => ipcRenderer.send("window-maximize"),

  // Panel visibility + refresh
  panelsHide: () => ipcRenderer.send("panels-hide"),
  panelsShow: () => ipcRenderer.send("panels-show"),
  cmdPaletteOpen: () => ipcRenderer.send("cmd-palette-open"),
  capturePanels: () => ipcRenderer.invoke("capture-panels") as Promise<Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }>>,
  panelsRefresh: (id?: string) => ipcRenderer.send("panels-refresh", id),
  panelsZoom: (factor: number) => ipcRenderer.send("panels-zoom", factor),
  panelsGetZoom: () => ipcRenderer.invoke("panels-get-zoom") as Promise<number>,

  // Skills CRUD
  skillsList: () => ipcRenderer.invoke("skills-list") as Promise<string[]>,
  skillsListDetailed: () => ipcRenderer.invoke("skills-list-detailed") as Promise<Array<{ name: string; description?: string; hasRunner: boolean; hasApp: boolean; scheduled: boolean; scheduleExpr?: string }>>,
  skillsRead: (name: string) => ipcRenderer.invoke("skills-read", name) as Promise<string | null>,
  skillsGet: (name: string) => ipcRenderer.invoke("skills-get", name) as Promise<{ name: string; manifest: any; prompt: string; hasRunner: boolean; hasApp: boolean; runnerCode: string | null; runnerSchedule: string | null } | null>,
  skillsWrite: (name: string, prompt: string) => ipcRenderer.invoke("skills-write", name, prompt) as Promise<boolean | { error: string }>,
  skillsWriteFull: (name: string, manifest: any, prompt: string, runnerCode?: string | null) =>
    ipcRenderer.invoke("skills-write-full", name, manifest, prompt, runnerCode) as Promise<boolean | { error: string }>,
  skillsRemove: (name: string) => ipcRenderer.invoke("skills-remove", name) as Promise<boolean>,
  skillsGenerate: (name: string, description: string) => ipcRenderer.invoke("skills-generate", name, description) as Promise<string>,
  skillsAvailableTools: () => ipcRenderer.invoke("skills-available-tools") as Promise<Array<{ namespace: string; label: string; tools: Array<{ name: string; description: string }> }>>,
  // Vibe base CSS for preview
  getVibeBaseCss: () => ipcRenderer.invoke("vibe:get-base-css") as Promise<string>,
  vibePreviewWrite: (html: string, vibeName: string) => ipcRenderer.invoke("vibe:preview-write", html, vibeName) as Promise<{ fileUrl: string; preloadPath: string }>,
  vibePreviewRegister: (vibeName: string) => ipcRenderer.invoke("vibe:preview-register", vibeName) as Promise<void>,
  // Files in a skill folder
  skillsListFiles: (name: string) => ipcRenderer.invoke("skills-list-files", name) as Promise<string[]>,
  skillsReadFile: (name: string, rel: string) => ipcRenderer.invoke("skills-read-file", name, rel) as Promise<string | null>,
  skillsWriteFile: (name: string, rel: string, content: string) => ipcRenderer.invoke("skills-write-file", name, rel, content) as Promise<boolean>,
  skillsDeleteFile: (name: string, rel: string) => ipcRenderer.invoke("skills-delete-file", name, rel) as Promise<boolean>,
  skillsOpenInEditor: (name: string) => ipcRenderer.invoke("skills-open-in-editor", name) as Promise<boolean>,
  skillsOpenFileInEditor: (name: string, rel: string) => ipcRenderer.invoke("skills-open-file-in-editor", name, rel) as Promise<boolean>,
  skillsFileUrl: (name: string, rel: string) => ipcRenderer.invoke("skills-file-url", name, rel) as Promise<string>,
  // Run
  skillsRun: (name: string, input: unknown) => ipcRenderer.invoke("skills-run", name, input) as Promise<{ ok: true; output: unknown } | { ok: false; error: string }>,
  skillsCancel: (runId: string) => ipcRenderer.invoke("skills-cancel", runId) as Promise<boolean>,
  skillsUserResponse: (qid: string, answer: string) => ipcRenderer.invoke("skills-user-response", qid, answer) as Promise<boolean>,
  skillsRunHistory: (name: string) => ipcRenderer.invoke("skills-run-history", name) as Promise<any[]>,
  onSkillProgress: (cb: (data: { runId: string; event: any }) => void) => {
    ipcRenderer.on("skill-progress", (_e, data) => cb(data));
  },
  /** Skills directory changed (CRUD via skillEngine OR the agent writing
   *  files directly under ~/.claude/skills). The Skills explorer
   *  subscribes to auto-reload its tree. */
  onSkillsChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("skills-changed", handler);
    return () => { ipcRenderer.removeListener("skills-changed", handler); };
  },
  onSkillAskUser: (cb: (data: { runId: string; qid: string; question: string }) => void) => {
    ipcRenderer.on("skill-ask-user", (_e, data) => cb(data));
  },
  // Export/import
  skillsExport: (name: string) => ipcRenderer.invoke("skills-export", name) as Promise<string | null>,
  skillsImport: (base64: string, overwrite?: boolean) =>
    ipcRenderer.invoke("skills-import", base64, overwrite) as Promise<{ imported: string[]; skipped: string[]; error?: string }>,
  // Scheduler
  skillsScheduleStatus: () => ipcRenderer.invoke("skills-schedule-status") as Promise<Array<{ name: string; schedule: string; paused: boolean }>>,
  skillsPauseSchedule: (name: string) => ipcRenderer.invoke("skills-pause-schedule", name) as Promise<void>,
  skillsResumeSchedule: (name: string) => ipcRenderer.invoke("skills-resume-schedule", name) as Promise<void>,

  // Layouts CRUD
  layoutsList: () => ipcRenderer.invoke("layouts-list") as Promise<Array<{ name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>>,
  layoutsSave: (name: string, panelIds: string[]) => ipcRenderer.invoke("layouts-save", name, panelIds) as Promise<boolean>,
  layoutsFolderRequired: (name: string) => ipcRenderer.invoke("layouts-folder-required", name) as Promise<boolean>,
  layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>; folderMode?: "single" | "multi" }) =>
    ipcRenderer.invoke("layouts-save-grid", grid) as Promise<boolean>,
  layoutsDelete: (name: string) => ipcRenderer.invoke("layouts-delete", name) as Promise<boolean>,
  pickDirectory: () => ipcRenderer.invoke("pick-directory") as Promise<string | null>,
  pickExecutable: () => ipcRenderer.invoke("pick-executable") as Promise<string | null>,

  // Drips CRUD
  dripsList: () => ipcRenderer.invoke("drips-list") as Promise<Array<{ name: string; recipe: string }>>,
  dripsSave: (name: string, recipe: string) => ipcRenderer.invoke("drips-save", name, recipe) as Promise<string>,
  dripsDelete: (name: string) => ipcRenderer.invoke("drips-delete", name) as Promise<string>,
  dripsPreview: (recipe: string) => ipcRenderer.invoke("drips-preview", recipe) as Promise<string>,
  dripsBuiltinEffects: () => ipcRenderer.invoke("drips-builtin-effects") as Promise<string[]>,


  // Grid resize
  gridDragEnd: (type: "col" | "row", index: number, fraction: number) =>
    ipcRenderer.send("grid-drag-end", type, index, fraction),

  // Session
  sessionInfo: () => ipcRenderer.invoke("session-info") as Promise<{ hasContent: boolean; label: string; fileName: string }>,
  sessionClear: () => ipcRenderer.invoke("session-clear") as Promise<boolean>,
  onSessionChanged: (callback: (info: { hasContent: boolean; label: string; fileName: string }) => void) => {
    ipcRenderer.on("session-changed", (_event, info) => callback(info));
  },

  // Preferences
  relaunch: () => ipcRenderer.send("relaunch"),
  setPreference: (key: string, value: unknown) => ipcRenderer.send("set-preference", key, value),
  getPreference: (key: string, defaultVal?: unknown) => ipcRenderer.invoke("get-preference", key, defaultVal),
  // Fires in every panel when a preference is changed anywhere — lets forms
  // (e.g. Settings → Agent Defaults) reflect a change made elsewhere live.
  onPreferenceChanged: (cb: (key: string, value: unknown) => void) => {
    ipcRenderer.on("preference-changed", (_e, key, value) => cb(key, value));
  },
  onOpenSettings: (callback: () => void) => {
    ipcRenderer.on("open-settings", () => callback());
  },
  onFocusInput: (callback: () => void) => {
    ipcRenderer.on("focus-command-input", () => callback());
  },
  onExecCommandFromPalette: (callback: (cmd: string) => void) => {
    ipcRenderer.on("exec-command-from-palette", (_e, cmd: string) => callback(cmd));
  },

  // "Create App" from a browser tab → opens Home → Apps → New App prefilled.
  createAppFromTab: (tabId: string, url: string, name: string) =>
    ipcRenderer.send("create-app-from-tab", tabId, url, name),
  onOpenNewApp: (callback: (data: { url?: string; name?: string; tabId?: string }) => void) => {
    ipcRenderer.on("open-new-app", (_e, data) => callback(data));
  },
  convertTabToApp: (tabId: string, appId: string) =>
    ipcRenderer.send("convert-tab-to-app", tabId, appId),
  // Open a file from a yo-panel file link — main hands it to the OS default app.
  openInEditor: (filePath: string) => ipcRenderer.send("open-in-editor", filePath),

  // Working directory — per-chat folder the agent + files view focus on.
  getWorkingDir: () => ipcRenderer.invoke("working-dir:get") as Promise<string | null>,
  pickWorkingDir: (opts?: { asDefault?: boolean }) =>
    ipcRenderer.invoke("working-dir:pick", opts) as Promise<string | null>,
  setWorkingDir: (dir: string) => ipcRenderer.invoke("working-dir:set", dir) as Promise<string>,
  getWorkingDirRecents: () => ipcRenderer.invoke("working-dir:recents") as Promise<string[]>,
  onWorkingDirChanged: (callback: (dir: string | null) => void) => {
    ipcRenderer.on("working-dir-changed", (_e, dir) => callback(dir));
  },

  // Apps CRUD
  appsList: () => ipcRenderer.invoke("apps-list") as Promise<Array<{
    id: string; name: string; url?: string; connected: boolean; connectedSlug?: string;
    commands: Record<string, { selector: string; action: string; description: string }>;
    meta?: { description: string; capabilities: string[] };
    forceWeb?: boolean; doNotRecord?: boolean;
    kind?: "user" | "system"; requiresFolder?: boolean;
    connection?: { pipedreamSlug: string; accountId?: string; healthy?: boolean };
    mcp?: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; oauth?: { clientId: string; clientSecret: string; tokenUrl: string; scope?: string }; enabled: boolean };
  }>>,
  /** Includes system-kind apps (Dashboard, Apps, Agents, …). Used by the
   *  panel `+` picker so users can mount any internal surface ad-hoc. */
  appsListAll: () => ipcRenderer.invoke("apps-list-all") as Promise<Array<{
    id: string; name: string; url?: string; connected: boolean; connectedSlug?: string;
    commands: Record<string, { selector: string; action: string; description: string }>;
    meta?: { description: string; capabilities: string[] };
    forceWeb?: boolean; doNotRecord?: boolean;
    kind?: "user" | "system"; requiresFolder?: boolean;
    connection?: { pipedreamSlug: string; accountId?: string; healthy?: boolean };
    mcp?: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; oauth?: { clientId: string; clientSecret: string; tokenUrl: string; scope?: string }; enabled: boolean };
  }>>,
  /** Mountable in Layouts: user apps + non-system internal apps (Agent,
   *  Vibe, Spec, Council, Terminal, Browser). System rail surfaces excluded. */
  appsListMountable: () => ipcRenderer.invoke("apps-list-mountable") as Promise<Array<{
    id: string; name: string; url?: string; connected: boolean;
    kind?: "user" | "system"; internal?: boolean; requiresFolder?: boolean;
  }>>,
  // Only for the still-local system-app registry (nav/.dip apps) — NOT the
  // Apps tab, which is fully server-authoritative via panelApps* below.
  appsAdd: (id: string, name: string, url?: string) => ipcRenderer.invoke("apps-add", id, name, url),
  // Dashboard shell (5a): the Apps tab's data source. Every call here is a
  // main-process-mediated, JWT-authed request to yo-server's /api/panel-apps
  // (see panel-apps-* handlers in apps-ipc.ts) — no local mirror.
  // 5b Panel Manager: open a server app in its own native OS window.
  appWindowOpen: (spec: { slug: string; name: string; url: string; forceWeb?: boolean }) =>
    ipcRenderer.invoke("app-window-open", spec) as Promise<{ ok: boolean; error?: string }>,
  // Launch an app the way its config dictates (native exec / native Chrome /
  // webview) — see the app-launch handler in apps-ipc.ts.
  appLaunch: (spec: {
    slug: string; name: string; url?: string | null; forceWeb?: boolean;
    isBrowser?: boolean; browserTarget?: "webview" | "native";
    execPath?: string | null; appArchetype?: string | null;
    launchConfig?: Record<string, unknown> | null;
  }) => ipcRenderer.invoke("app-launch", spec) as Promise<{ ok: boolean; error?: string }>,
  panelAppsList: () => ipcRenderer.invoke("panel-apps-list") as Promise<SavedPanelApp[]>,
  panelAppsCreate: (input: PanelAppInput) =>
    ipcRenderer.invoke("panel-apps-create", input) as Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>,
  panelAppsUpdate: (id: string, patch: PanelAppInput) =>
    ipcRenderer.invoke("panel-apps-update", id, patch) as Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>,
  panelAppsDelete: (id: string) => ipcRenderer.invoke("panel-apps-delete", id) as Promise<{ ok: boolean; error?: string }>,
  panelAppsSetConnection: (id: string, pipedreamSlug: string) =>
    ipcRenderer.invoke("panel-apps-set-connection", id, pipedreamSlug) as Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>,
  panelAppsRemoveConnection: (id: string) =>
    ipcRenderer.invoke("panel-apps-remove-connection", id) as Promise<{ ok: boolean; error?: string }>,
  panelAppsSetMcp: (id: string, mcp: Record<string, unknown>) =>
    ipcRenderer.invoke("panel-apps-set-mcp", id, mcp) as Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>,
  panelAppsRemoveMcp: (id: string) =>
    ipcRenderer.invoke("panel-apps-remove-mcp", id) as Promise<{ ok: boolean; error?: string }>,
  panelAppsSetCommand: (id: string, key: string, mapping: Record<string, unknown>) =>
    ipcRenderer.invoke("panel-apps-set-command", id, key, mapping) as Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>,
  panelAppsRemoveCommand: (id: string, key: string) =>
    ipcRenderer.invoke("panel-apps-remove-command", id, key) as Promise<{ ok: boolean; error?: string }>,
  // yo app package (import / export)
  appImport: () => ipcRenderer.invoke("app-import") as Promise<{ ok: boolean; appId?: string; error?: string }>,
  appExport: (appId: string) => ipcRenderer.invoke("app-export", appId) as Promise<{ ok: boolean; path?: string; error?: string }>,
  appsSetMcp: (id: string, mcp: { transport: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled: boolean; headers?: Record<string, string>; oauth?: { clientId: string; clientSecret: string; tokenUrl: string; scope?: string } }) =>
    ipcRenderer.invoke("apps-set-mcp", id, mcp),
  appsRemoveMcp: (id: string) => ipcRenderer.invoke("apps-remove-mcp", id) as Promise<boolean>,
  appsRemove: (id: string) => ipcRenderer.invoke("apps-remove", id) as Promise<boolean>,
  appsSetConnection: (id: string, pipedreamSlug: string) => ipcRenderer.invoke("apps-set-connection", id, pipedreamSlug) as Promise<boolean>,
  appsRemoveConnection: (id: string) => ipcRenderer.invoke("apps-remove-connection", id) as Promise<boolean>,
  appsUpdateId: (oldId: string, newId: string) => ipcRenderer.invoke("apps-update-id", oldId, newId) as Promise<boolean>,
  appsUpdateName: (id: string, name: string) => ipcRenderer.invoke("apps-update-name", id, name) as Promise<boolean>,
  appsUpdateUrl: (id: string, url: string) => ipcRenderer.invoke("apps-update-url", id, url) as Promise<boolean>,
  appsUpdateForceWeb: (id: string, forceWeb: boolean) => ipcRenderer.invoke("apps-update-force-web", id, forceWeb) as Promise<boolean>,
  appsSetConnectedSlug: (id: string, slug: string | null) => ipcRenderer.invoke("apps-set-connected-slug", id, slug) as Promise<boolean>,
  appsSetCommand: (id: string, key: string, mapping: { selector: string; action: string; description: string }) =>
    ipcRenderer.invoke("apps-set-command", id, key, mapping) as Promise<boolean>,
  appsRemoveCommand: (id: string, key: string) =>
    ipcRenderer.invoke("apps-remove-command", id, key) as Promise<boolean>,
  appsTestCommand: (mapping: { selector: string; action: string; description?: string; text?: string } | null, wcId?: number) =>
    ipcRenderer.invoke("apps-test-command", mapping, wcId) as Promise<string>,
  startPicker: (wcId: number) => ipcRenderer.send("start-picker", wcId),
  onPickerResult: (cb: (result: { selector: string; tag: string; text: string; isEditable: boolean; isClickable: boolean }) => void) => {
    ipcRenderer.on("picker-result", (_e, result) => cb(result));
  },

  // Onboarding complete — triggers panel restore
  onboardingComplete: () => ipcRenderer.invoke("onboarding-complete"),

  // App version
  getAppVersion: () => ipcRenderer.invoke("get-app-version") as Promise<string>,

  // Auth
  startAuth: (mode: "register" | "login") => ipcRenderer.invoke("start-auth", mode) as Promise<boolean>,
  isAuthenticated: () => ipcRenderer.invoke("is-authenticated") as Promise<boolean>,
  // Native (in-client) email auth — no popup.
  authRegister: (email: string) => ipcRenderer.invoke("auth-register", email) as Promise<{ ok: boolean; error?: string }>,
  authVerifyCode: (email: string, code: string) => ipcRenderer.invoke("auth-verify-code", email, code) as Promise<{ ok: boolean; error?: string }>,
  authCompleteProfile: (data: { email: string; firstName: string; lastName: string; password: string; confirmPassword: string; orgName?: string }) => ipcRenderer.invoke("auth-complete-profile", data) as Promise<{ ok: boolean; error?: string }>,
  authLogin: (email: string, password: string) => ipcRenderer.invoke("auth-login", email, password) as Promise<{ ok: boolean; error?: string }>,
  authForgotPassword: (email: string) => ipcRenderer.invoke("auth-forgot-password", email) as Promise<{ ok: boolean; error?: string }>,
  getAccountInfo: () => ipcRenderer.invoke("get-account-info") as Promise<{ email: string; firstName: string; lastName: string; role: string; orgName: string; tier: string; billingStatus: string } | null>,
  // Server-profile timezone (users.timezone) — same field the platform edits.
  userTimezoneGet: () => ipcRenderer.invoke("user-timezone-get") as Promise<string | null>,
  userTimezoneSet: (tz: string) => ipcRenderer.invoke("user-timezone-set", tz) as Promise<{ ok: boolean; error?: string }>,
  logout: () => ipcRenderer.invoke("logout") as Promise<void>,
  validateApiKey: () => Promise.resolve({ valid: true }),
  getApiKey: () => Promise.resolve(null),
  onBoot: (callback: (data: { authenticated: boolean; status: string; tier?: string; needsOnboarding: boolean; hideWelcome?: boolean; theme?: string }) => void) => {
    ipcRenderer.on("boot", (_event, data) => callback(data));
  },
  onThemeChanged: (callback: (theme: string) => void) => {
    ipcRenderer.on("theme-changed", (_event, theme) => callback(theme));
  },
  onShowOnboarding: (callback: () => void) => {
    ipcRenderer.on("show-onboarding", () => callback());
  },
  onAccountLocked: (callback: (info: { status: string; upgradeUrl: string }) => void) => {
    ipcRenderer.on("account-locked", (_event, info) => callback(info));
  },
  onAccountUnlocked: (callback: () => void) => {
    ipcRenderer.on("account-unlocked", () => callback());
  },
  recheckAccount: () => ipcRenderer.invoke("recheck-account") as Promise<{ status: string }>,
  onSplashStatus: (callback: (msg: string) => void) => {
    ipcRenderer.on("splash-status", (_event, msg) => callback(msg));
  },
  onSplitState: (callback: (info: {
    panelIds: string[];
    cols: number;
    rows: number;
    colWidths: number[];
    rowHeights: number[];
    cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
  } | null) => void) => {
    ipcRenderer.on("split-state", (_event, info) => callback(info));
  },

  // Command execution (used internally by interceptor routing)
  execCommand: (cmd: string) => ipcRenderer.invoke("exec-command", cmd) as Promise<string>,

  // Downloads
  onDownloadStart: (cb: (info: { filename: string; totalBytes: number; savePath: string }) => void) => {
    ipcRenderer.on("download:start", (_e, info) => cb(info));
  },
  onDownloadProgress: (cb: (info: { filename: string; receivedBytes: number; totalBytes: number }) => void) => {
    ipcRenderer.on("download:progress", (_e, info) => cb(info));
  },
  onDownloadDone: (cb: (info: { filename: string; savePath: string; state: string }) => void) => {
    ipcRenderer.on("download:done", (_e, info) => cb(info));
  },
  downloadShow: (filePath: string) => ipcRenderer.send("download:show", filePath),

  // Drip effects
  onDripEffect: (callback: (effect: string) => void) => {
    ipcRenderer.on("drip-effect", (_event, effect) => callback(effect));
  },

  // LLM config
  getLLMConfig: () => ipcRenderer.invoke("get-llm-config") as Promise<{ provider: string; model: string }>,
  getLLMPresets: () => ipcRenderer.invoke("get-llm-presets") as Promise<Record<string, { name: string; models: string[]; defaultModel: string }>>,
  saveLLMConfig: (config: { provider: string; model: string }) =>
    ipcRenderer.invoke("save-llm-config", config) as Promise<{ ok: boolean; error?: string }>,

  // Tabs
  tabList: () => ipcRenderer.invoke("tab-list") as Promise<{ tabs: Array<{ id: string; name: string; favicon?: string; layoutFavicons?: string[] }>; activeId: string; visible: boolean }>,
  tabSwitch: (id: string) => ipcRenderer.send("tab-switch", id),
  tabClose: (id: string) => ipcRenderer.send("tab-close", id),
  tabCloseAll: () => ipcRenderer.send("tab-close-all"),
  tabReorder: (newOrder: string[]) => ipcRenderer.send("tab-reorder", newOrder),
  tabNew: () => ipcRenderer.send("tab-new"),
  tabNewApp: (appId: string) => ipcRenderer.send("tab-new-app", appId),
  tabNewWindow: (id: string) => ipcRenderer.send("tab-new-window", id),
  onTabState: (callback: (state: { tabs: Array<{ id: string; name: string; favicon?: string; layoutFavicons?: string[] }>; activeId: string; visible: boolean }) => void) => {
    ipcRenderer.on("tab-state", (_event, state) => callback(state));
  },

  // Theme
  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  setTheme: (theme: string) => ipcRenderer.invoke("set-theme", theme),

  // Account info
  getAuthStatus: () => ipcRenderer.invoke("get-auth-status") as Promise<{ authenticated: boolean; status: string; tier?: string }>,
  refreshAuth: () => ipcRenderer.invoke("refresh-auth") as Promise<{ tier: string; status: string }>,
  openExternal: (url: string) => ipcRenderer.send("open-external", url),
  platformUrl: process.env.YO_PLATFORM_URL || "https://platform.glyphh.ai",
  serverUrl: process.env.YO_AUTH_SERVER || "https://api.glyphh.ai",
  discordInvite: process.env.YO_DISCORD_INVITE || "https://discord.gg/cHGZR764D",
  hasMcpAccess: () => ipcRenderer.invoke("has-mcp-access") as Promise<boolean>,
  openAccountDashboard: () => ipcRenderer.send("open-external", (process.env.YO_PLATFORM_URL || "https://platform.glyphh.ai")),
  openBilling: () => ipcRenderer.send("open-external", (process.env.YO_PLATFORM_URL || "https://platform.glyphh.ai") + "/dashboard/billing"),
  /** Models the Glyphh agent can use (server-filtered for this user) + default. */
  agentModels: () => ipcRenderer.invoke("agent-models") as Promise<{
    models: Array<{ provider: string; model: string; display_name: string }>;
    default_model: string | null;
  }>,
  /** Per-user credit balance + daily usage from the server. */
  userUsage: (range?: { from?: string; to?: string; tz?: string }) => ipcRenderer.invoke("user-usage", range) as Promise<{
    credits: { balance: number; grants: number; purchases: number; allowance?: number } | null;
    days: Array<{ day: string; credits: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; requests: number }>;
  }>,
  /** Per-chat credit usage (credits in MICRO-credits), keyed by chat/run id. */
  usageByChat: () => ipcRenderer.invoke("usage-by-chat") as Promise<{ byChat: Record<string, { credits: number; requests: number }> }>,

  // Support
  submitSupportTicket: (ticket: { subject: string; description: string }) =>
    ipcRenderer.invoke("submit-support-ticket", ticket) as Promise<{ ok: boolean; error?: string }>,

  // Voice transcription
  transcribeAudio: (audioBuffer: ArrayBuffer) =>
    ipcRenderer.invoke("transcribe-audio", audioBuffer) as Promise<{ ok: boolean; text?: string; error?: string }>,

  // Yo agent panel bindings removed (pivot-mcp) — the interactive chat agent
  // panel (YoAgent + yo-panel-ui-vscode.ts) that these IPC channels served is
  // gone; no renderer code calls them anymore.

  // Jammer activity feed (workspace bus events forwarded from main)
  onJammerActivity: (cb: (event: { from: string; kind: string; body: string; tags?: string[]; ts: number }) => void) => {
    ipcRenderer.on("jammer-activity", (_e, event) => cb(event));
  },

  // Task runs (persisted scheduled/manual runs → Activity + schedule history)
  runsList: (skillName?: string) => ipcRenderer.invoke("runs-list", skillName) as Promise<Array<{ id: string; skillName: string; title: string; created: string; trigger: string; ok: boolean }>>,
  runsGet: (id: string) => ipcRenderer.invoke("runs-get", id) as Promise<{ title: string; messages: Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }> } | null>,
  onRunsChanged: (cb: () => void) => { ipcRenderer.on("runs-changed", () => cb()); },
  setKeepAwake: (on: boolean) => ipcRenderer.send("set-keep-awake", on),

  // Standalone prompt schedules (decoupled from skills)
  schedulesList: () => ipcRenderer.invoke("schedules-list") as Promise<Array<Record<string, unknown>>>,
  schedulesGet: (id: string) => ipcRenderer.invoke("schedules-get", id) as Promise<Record<string, unknown> | null>,
  schedulesSave: (cfg: Record<string, unknown>) => ipcRenderer.invoke("schedules-save", cfg) as Promise<Record<string, unknown>>,
  schedulesDelete: (id: string) => ipcRenderer.invoke("schedules-delete", id) as Promise<boolean>,
  schedulesRun: (id: string) => ipcRenderer.invoke("schedules-run", id) as Promise<void>,
  schedulesPause: (id: string) => ipcRenderer.invoke("schedules-pause", id) as Promise<void>,
  schedulesResume: (id: string) => ipcRenderer.invoke("schedules-resume", id) as Promise<void>,
  schedulesDeleteRuns: (name: string) => ipcRenderer.invoke("schedules-delete-runs", name) as Promise<number>,

  // Agent mode + guardrails
  getAgentMode: () => ipcRenderer.invoke("get-agent-mode") as Promise<{ perm: string; swarm: boolean }>,
  setAgentMode: (mode: string) => ipcRenderer.send("set-agent-mode", mode),
  onAgentModeChanged: (cb: (mode: string) => void) => {
    ipcRenderer.on("agent-mode-changed", (_e, mode) => cb(mode));
  },
  onApprovalRequest: (cb: (id: string, toolName: string, toolLabel: string, input: unknown) => void) => {
    ipcRenderer.on("approval-request", (_e, id, toolName, toolLabel, input) => cb(id, toolName, toolLabel, input));
  },
  approvalRespond: (id: string, approved: boolean) => ipcRenderer.send("approval-respond", id, approved),

  // mcp__yo__ask_user_question — purple "Input required" card. Main fires
  // yo-ask-request with the questions; renderer replies via yo-ask-respond
  // with an array of selected labels (one per question, null = cancelled).
  onYoAskRequest: (cb: (id: string, questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string; recommended?: boolean; preview?: string }>;
    multiSelect?: boolean;
  }>) => void) => {
    ipcRenderer.on("yo-ask-request", (_e, id, questions) => cb(id, questions));
  },
  respondYoAsk: (id: string, answers: Array<string | null>) => ipcRenderer.send("yo-ask-respond", id, answers),

  // URL bar
  urlBarNavigate: (url: string) => ipcRenderer.send("url-bar-navigate", url),
  urlBarBack: () => ipcRenderer.send("url-bar-back"),
  urlBarForward: () => ipcRenderer.send("url-bar-forward"),
  urlBarRefresh: () => ipcRenderer.send("url-bar-refresh"),
  panelNavBack: (panelId: string) => ipcRenderer.send("panel-nav-back", panelId),
  panelNavForward: (panelId: string) => ipcRenderer.send("panel-nav-forward", panelId),
  panelNavRefresh: (panelId: string) => ipcRenderer.send("panel-nav-refresh", panelId),
  panelNavTo: (panelId: string, url: string) => ipcRenderer.send("panel-nav-to", panelId, url),
  urlBarToggle: (show: boolean) => ipcRenderer.send("url-bar-toggle", show),
  onUrlUpdate: (cb: (info: { url: string; favicon: string }) => void) => {
    ipcRenderer.on("url-update", (_e, info) => cb(info));
  },
  onUrlBarForce: (cb: (show: boolean) => void) => {
    ipcRenderer.on("url-bar-force", (_e, show) => cb(show));
  },
  onTabFavicon: (cb: (info: { id: string; favicon: string }) => void) => {
    ipcRenderer.on("tab-favicon", (_e, info) => cb(info));
  },
  onPanelUrlUpdate: (cb: (info: { id: string; url: string; favicon: string }) => void) => {
    ipcRenderer.on("panel-url-update", (_e, info) => cb(info));
  },

  // Files left rail — explorer scoped to the working directory
  filesRailResize: (width: number) => ipcRenderer.send("files-rail-resize", width),
  filesRailWidthSave: (width: number) => ipcRenderer.send("files-rail-width-save", width),
  filesRailGetWidth: () => ipcRenderer.invoke("files-rail-get-width") as Promise<number>,

  // Recents (rich: app/layout + folder pairs)
  recentsList: () => ipcRenderer.invoke("recents:list") as Promise<Array<{
    kind: "app" | "layout"; id: string; name: string; folder: string; ts: number;
  }>>,
  recentsOpen: (entry: { kind: "app" | "layout"; id: string; name: string; folder: string; ts: number }) =>
    ipcRenderer.invoke("recents:open", entry) as Promise<boolean>,
  recentsRemove: (entry: { kind: "app" | "layout"; id: string; folder: string }) =>
    ipcRenderer.invoke("recents:remove", entry) as Promise<boolean>,
  recentsClear: () => ipcRenderer.invoke("recents:clear") as Promise<boolean>,
  workingDirRecentsClear: () => ipcRenderer.invoke("working-dir:clear-recents") as Promise<boolean>,
  onRecentsChanged: (cb: (list: Array<{
    kind: "app" | "layout"; id: string; name: string; folder: string; ts: number;
  }>) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, list: Array<{
      kind: "app" | "layout"; id: string; name: string; folder: string; ts: number;
    }>) => cb(list);
    ipcRenderer.on("recents-changed", handler);
    return () => { ipcRenderer.removeListener("recents-changed", handler); };
  },
  listDir: (dirPath: string) =>
    ipcRenderer.invoke("files:list-dir", dirPath) as Promise<Array<{ name: string; isDir: boolean }>>,
  gitInfo: (root: string) =>
    ipcRenderer.invoke("files:git-info", root) as Promise<{ isRepo: boolean; branch?: string; defaultBranch?: string }>,
  gitRepos: (root: string) =>
    ipcRenderer.invoke("files:git-repos", root) as Promise<Array<{ name: string; path: string; branch: string }>>,
  createFile: (filePath: string) =>
    ipcRenderer.invoke("files:create-file", filePath) as Promise<{ ok: boolean; error?: string }>,
  mkdir: (dirPath: string) =>
    ipcRenderer.invoke("files:mkdir", dirPath) as Promise<{ ok: boolean; error?: string }>,
  deleteEntry: (targetPath: string) =>
    ipcRenderer.invoke("files:delete", targetPath) as Promise<{ ok: boolean; error?: string }>,
  // Route a file to the app that handles its type (editor / browser / VS Code).
  openFile: (filePath: string) => ipcRenderer.send("file-open", filePath),
  // Open the Settings (home) panel at a section — driven by the left-rail nav.
  openHomeSection: (section: string, sub?: string) =>
    ipcRenderer.send("open-home-section", section, sub),
  // Home page listens for this to navigate to a section.
  onGotoSection: (cb: (section: string, sub?: string) => void) => {
    ipcRenderer.on("home:goto-section", (_e, section: string, sub?: string) => cb(section, sub));
  },
  getPendingSection: () =>
    ipcRenderer.invoke("home:get-pending-section") as Promise<{ section: string; sub?: string } | null>,

  // Connectors (Pipedream OAuth)
  connectorsGetApps: (search?: string, offset?: number) => ipcRenderer.invoke("connectors-get-apps", search, offset) as Promise<{ apps: Array<{ id: string; name: string; description: string; icon?: string }>; hasMore: boolean }>,
  connectorsGetAccounts: () => ipcRenderer.invoke("connectors-get-accounts") as Promise<Array<{ id: string; appSlug: string; appName: string; createdAt: string; healthy: boolean }>>,
  connectorsConnect: (appSlug: string) => ipcRenderer.invoke("connectors-connect", appSlug) as Promise<{ ok: boolean; error?: string }>,
  connectorsDisconnect: (accountId: string) => ipcRenderer.invoke("connectors-disconnect", accountId) as Promise<boolean>,
  connectorsRefreshMcp: () => ipcRenderer.invoke("connectors-refresh-mcp") as Promise<{ ok: boolean; error?: string; toolCount: number }>,
  connectorsListTools: () => ipcRenderer.invoke("connectors-list-tools") as Promise<Array<{ slug: string; name: string; description: string }>>,
  onConnectorsChanged: (cb: () => void) => { ipcRenderer.on("connectors-changed", cb); },

  // Apps registry live-reload — fired when ~/yo/apps changes on disk so the
  // registry + picker refresh without a restart.
  onAppsChanged: (cb: () => void) => { ipcRenderer.on("apps-changed", () => cb()); },

  // Auto-update
  onUpdateStatus: (cb: (info: { status: string; version?: string; percent?: number; error?: string }) => void) => {
    ipcRenderer.on("update-status", (_e, info) => cb(info));
  },
  updateInstall: () => ipcRenderer.send("update-install"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates") as Promise<string | null>,
  // Current pending update (null when none) — lets the About page show the
  // "Relaunch to Update" prompt on load, not only when a live event arrives.
  getUpdateStatus: () => ipcRenderer.invoke("get-update-status") as Promise<{ version: string; ready: boolean } | null>,

  // MCP Expose (pro feature — read-only capture store server)
  mcpExposeStart: () => ipcRenderer.invoke("mcp-expose-start") as Promise<{ ok: boolean; error?: string }>,
  mcpExposeStop: () => ipcRenderer.invoke("mcp-expose-stop") as Promise<void>,
  mcpExposeStatus: () => ipcRenderer.invoke("mcp-expose-status") as Promise<{ running: boolean; port: number }>,
  mcpExposeGetTokens: () => ipcRenderer.invoke("mcp-expose-get-tokens") as Promise<Array<{ token: string; label: string; createdAt: string; expiresAt: string }>>,
  mcpExposeGenToken: (label: string, ttlDays?: number) => ipcRenderer.invoke("mcp-expose-gen-token", label, ttlDays) as Promise<{ token: string; label: string; createdAt: string; expiresAt: string }>,
  mcpExposeRevokeToken: (token: string) => ipcRenderer.invoke("mcp-expose-revoke-token", token) as Promise<void>,
  mcpConfigureClient: (client: string) => ipcRenderer.invoke("mcp-configure-client", client) as Promise<{ ok: boolean; configPath?: string; error?: string }>,

  // Remote relay — settings UI uses these. The JWT authenticates the WS,
  // so there's no client-token to manage; only the external (server) tokens
  // for the user's external tools.
  relayReconnect: () => ipcRenderer.invoke("relay-reconnect") as Promise<void>,
  relayStatus: () => ipcRenderer.invoke("relay-status") as Promise<{ enabled: boolean; signedIn: boolean; state: "off" | "connecting" | "connected" | "disconnected" }>,
  relayTokensList: () => ipcRenderer.invoke("relay-tokens-list") as Promise<Array<{ id: string; label: string; type: string; userId: string | null; createdAt: string; expiresAt: string }> | { error: string }>,
  relayTokensCreate: (label: string) => ipcRenderer.invoke("relay-tokens-create", label) as Promise<{ ok: boolean; id: string; token: string; expiresAt: string } | { error: string }>,
  relayTokensRevoke: (id: string) => ipcRenderer.invoke("relay-tokens-revoke", id) as Promise<{ ok: boolean } | { error: string }>,
  relayInstallClaude: (token: string) => ipcRenderer.invoke("relay-install-claude", token) as Promise<{ ok: boolean; path: string } | { error: string }>,

  // BYOK provider keys (Phase 1 of THE-PIVOT-BYOK).
  // List returns *status only* — never plaintext. set/remove/test mutate.
  providerKeysList: () => ipcRenderer.invoke("provider-keys-list") as Promise<Array<{
    provider: string;
    configured: boolean;
    savedAt: string | null;
    lastTested: string | null;
    lastTestOk: boolean | null;
    lastTestError: string | null;
  }>>,
  providerKeysSet: (provider: string, key: string) =>
    ipcRenderer.invoke("provider-keys-set", provider, key) as Promise<{ ok: boolean; error?: string }>,
  providerKeysRemove: (provider: string) =>
    ipcRenderer.invoke("provider-keys-remove", provider) as Promise<{ ok: boolean }>,
  providerKeysTest: (provider: string) =>
    ipcRenderer.invoke("provider-keys-test", provider) as Promise<{ ok: boolean; error?: string }>,
  providerKeysTestPrompt: (provider: string, model?: string, prompt?: string) =>
    ipcRenderer.invoke("provider-keys-test-prompt", provider, model, prompt) as Promise<{ ok: boolean; text?: string; model?: string; error?: string }>,
  providerModelsGetAll: () =>
    ipcRenderer.invoke("provider-models-get-all") as Promise<Record<string, { default: string; models: string[] }>>,
  providerModelsSet: (provider: string, models: string[], def?: string) =>
    ipcRenderer.invoke("provider-models-set", provider, models, def) as Promise<{ default: string; models: string[] }>,
  providerModelsReset: (provider: string) =>
    ipcRenderer.invoke("provider-models-reset", provider) as Promise<{ default: string; models: string[] }>,

  // Claude Code bootstrap (Phase 2 of THE-PIVOT-BYOK)
  // BYOK gate status — true when an Anthropic API key is configured.
  ccStatus: () => ipcRenderer.invoke("cc-status") as Promise<{
    found: boolean; byokAnthropic: boolean;
  }>,
  onCcShowModal: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("cc-show-modal", handler);
    return () => ipcRenderer.removeListener("cc-show-modal", handler);
  },

  // Capability Offer — share this client's compute/LLM capacity with the .yo network
  capabilitiesSetEnabled: (enabled: boolean) => ipcRenderer.invoke("capabilities-set-enabled", enabled) as Promise<{ ok: boolean; enabled: boolean; derived_tier?: string; client_id?: string; error?: string }>,
  capabilitiesGetStatus: () => ipcRenderer.invoke("capabilities-get-status") as Promise<{ enabled: boolean; client_id: string; derived_tier: string | null; report: unknown }>,

  // Agents Registry (local + remote definitions)
  agentsList: () => ipcRenderer.invoke("agents-list") as Promise<unknown[]>,
  agentsGet: (id: string) => ipcRenderer.invoke("agents-get", id) as Promise<unknown>,
  agentsSave: (cfg: unknown) => ipcRenderer.invoke("agents-save", cfg) as Promise<unknown>,
  agentsRemove: (id: string) => ipcRenderer.invoke("agents-remove", id) as Promise<boolean>,
  agentsIdAvailable: (id: string) => ipcRenderer.invoke("agents-id-available", id) as Promise<boolean>,
  /** Open a saved agent as a standalone panel (yo://agent?slug=<slug>). */
  agentsOpenAsApp: (slug: string) => ipcRenderer.invoke("agents:open-as-app", slug) as Promise<boolean>,

  // yos wallet + rate cards
  yosBalance: () => ipcRenderer.invoke("yos-balance") as Promise<{ user_id: string; balance: number } | { error: string }>,
  yosRateCards: () => ipcRenderer.invoke("yos-rate-cards") as Promise<{ cards: Array<{ tier: string; yos_per_1k_input: number; yos_per_1k_output: number; yos_per_idle_minute: number }> } | { error: string }>,
  modelsList: () => ipcRenderer.invoke("models-list") as Promise<{ models: Array<{ provider: string; model: string; display_name: string; yos_per_1k_input: number; yos_per_1k_output: number }> } | { error: string }>,
  modelCatalog: () => ipcRenderer.invoke("model-catalog") as Promise<Array<{ provider: string; model: string; displayName: string; agentLoopCapable: boolean; maxContextTokens?: number; maxOutputTokens?: number }>>,
  yosBuyUrl: () => ipcRenderer.invoke("yos-buy-url") as Promise<{ url: string }>,

  // Marketplace + reservations
  marketplaceAvailable: (opts?: { tier?: string; provider?: string; limit?: number }) =>
    ipcRenderer.invoke("marketplace-available", opts) as Promise<{ entries: Array<{ offer_handle: string; derived_tier: string; providers: string[]; pricing: unknown; last_seen_at: string }>; count: number; ts: string } | { error: string }>,
  agentsLeaderboard: (opts?: { skills?: string; days?: number; limit?: number }) =>
    ipcRenderer.invoke("agents-leaderboard", opts) as Promise<{
      entries: Array<{
        published_agent_id: string | null;
        user_id: string;
        agent_local_id: string;
        name: string;
        avatar_url: string | null;
        bio: string | null;
        skills: string[];
        cyphers_count: number;
        tasks_completed: number;
        tasks_assigned: number;
        success_rate: number;
        avg_approval: number | null;
        total_yos: number;
        last_active_at: string | null;
        score: number;
      }>;
      count: number;
    } | { error: string }>,
  reservationCreate: (body: { provider_handle: string; idle_minutes: number; guardrails?: unknown }) =>
    ipcRenderer.invoke("reservation-create", body) as Promise<{ ok: boolean; reservation?: unknown; buyer_balance_after?: number; error?: string }>,
  reservationRelease: (id: string, reason?: string) =>
    ipcRenderer.invoke("reservation-release", id, reason) as Promise<{ ok: boolean; reservation?: unknown; buyer_balance_after?: number; idle_yos_settled?: number; provider_earned?: number; error?: string }>,
  reservationList: (opts?: { status?: string }) =>
    ipcRenderer.invoke("reservation-list", opts) as Promise<{ reservations: unknown[]; count: number } | { error: string }>,

  // Cyphers — collaborative gatherings of agents
  cypherCreate: (input: Record<string, unknown>) => ipcRenderer.invoke("cypher-create", input) as Promise<{ ok: boolean; cypher?: unknown; error?: string }>,
  cypherUpdate: (id: string, patch: Record<string, unknown>) => ipcRenderer.invoke("cypher-update", id, patch) as Promise<{ ok: boolean; cypher?: unknown; error?: string }>,
  cypherPublish: (id: string, opts?: { initial_kitty_deposit?: number; lobby_duration_seconds?: number | null }) =>
    ipcRenderer.invoke("cypher-publish", id, opts) as Promise<{ ok: boolean; cypher?: unknown; kitty_balance?: number; error?: string }>,
  cypherStart: (id: string) => ipcRenderer.invoke("cypher-start", id) as Promise<{ ok: boolean; cypher?: unknown; error?: string }>,
  cypherWrap: (id: string) => ipcRenderer.invoke("cypher-wrap", id) as Promise<{ ok: boolean; cypher?: unknown; refunds?: Array<{ user_id: string; amount: number }>; error?: string }>,
  cypherCancel: (id: string) => ipcRenderer.invoke("cypher-cancel", id) as Promise<{ ok: boolean; cypher?: unknown; error?: string }>,
  cypherDiscover: (opts?: { status?: string; type?: string; limit?: number; offset?: number }) =>
    ipcRenderer.invoke("cypher-discover", opts) as Promise<{ cyphers: unknown[]; count: number } | { error: string }>,
  cypherListMine: () => ipcRenderer.invoke("cypher-list-mine") as Promise<{ cyphers: unknown[]; count: number } | { error: string }>,
  cypherGet: (id: string) => ipcRenderer.invoke("cypher-get", id) as Promise<{ cypher: unknown; kitty_balance: number } | { error: string }>,
  cypherGetBySlug: (slug: string) => ipcRenderer.invoke("cypher-get-by-slug", slug) as Promise<{ cypher: unknown } | { error: string }>,
  cypherJoin: (id: string, agent_local_id: string, role?: string, invite_token?: string) => ipcRenderer.invoke("cypher-join", id, agent_local_id, role, invite_token) as Promise<{ ok: boolean; cypher?: unknown; cohort_size?: number; error?: string }>,
  cypherInviteMint: (id: string, opts?: { role?: string; ttl_seconds?: number; multi_use?: boolean; invitee_user_id?: string }) =>
    ipcRenderer.invoke("cypher-invite-mint", id, opts) as Promise<{ ok: boolean; invite?: { jti: string; cypher_id: string; role: string; multi_use: boolean; expires_at: string; invitee_user_id: string | null; revoked_at: string | null; used_at: string | null }; token?: string; error?: string }>,
  cypherInviteList: (id: string) =>
    ipcRenderer.invoke("cypher-invite-list", id) as Promise<{ invites: Array<{ jti: string; role: string; multi_use: boolean; expires_at: string; invitee_user_id: string | null; revoked_at: string | null; used_at: string | null; used_by_user_id: string | null; created_at: string }>; count: number } | { error: string }>,
  cypherInviteRevoke: (id: string, jti: string) =>
    ipcRenderer.invoke("cypher-invite-revoke", id, jti) as Promise<{ ok: boolean; invite?: unknown; error?: string }>,
  cypherLeave: (id: string, agent_local_id: string) => ipcRenderer.invoke("cypher-leave", id, agent_local_id) as Promise<{ ok: boolean }>,
  cypherJammers: (id: string) => ipcRenderer.invoke("cypher-jammers", id) as Promise<{ jammers: Array<{ user_id: string; agent_local_id: string; role: string; joined_at: string; left_at: string | null }>; count: number } | { error: string }>,
  cypherJamsList: (id: string) => ipcRenderer.invoke("cypher-jams-list", id) as Promise<{ jams: Array<{ id: string; slug: string; title: string; description: string | null; state_doc: unknown; state_version: string }>; count: number } | { error: string }>,
  cypherJamCreate: (id: string, slug: string, title: string, description?: string) => ipcRenderer.invoke("cypher-jam-create", id, slug, title, description) as Promise<{ ok: boolean; jam?: { id: string; slug: string }; error?: string }>,
  cypherJamSetState: (id: string, jam_id: string, expected_version: number, state: unknown) => ipcRenderer.invoke("cypher-jam-set-state", id, jam_id, expected_version, state) as Promise<{ ok: boolean; version?: number; error?: string }>,
  cypherEventPost: (id: string, kind: string, payload: unknown, jam_id?: string, by_agent_id?: string) =>
    ipcRenderer.invoke("cypher-event-post", id, kind, payload, jam_id, by_agent_id) as Promise<{ ok: boolean; event?: unknown; error?: string }>,
  cypherEventsList: (id: string, opts?: { since?: number; jam_id?: string; limit?: number }) =>
    ipcRenderer.invoke("cypher-events-list", id, opts) as Promise<{ events: Array<{ id: string; seq: string; kind: string; jam_id: string | null; by_user_id: string | null; by_agent_id: string | null; payload: unknown; created_at: string }>; count: number } | { error: string }>,
  cypherKittyDeposit: (id: string, amount: number) => ipcRenderer.invoke("cypher-kitty-deposit", id, amount) as Promise<{ ok: boolean; kitty_balance?: number; user_balance?: number; error?: string }>,
  cypherKittyBalance: (id: string) => ipcRenderer.invoke("cypher-kitty-balance", id) as Promise<{ balance: number } | { error: string }>,
  cypherKittyLedger: (id: string, opts?: { limit?: number }) => ipcRenderer.invoke("cypher-kitty-ledger", id, opts) as Promise<{ entries: Array<{ id: string; user_id: string; delta: number; kind: string; description: string | null; created_at: string }>; count: number } | { error: string }>,

  // MCP Servers (custom user-configured servers — Advanced plan)
  mcpGetServers: () => ipcRenderer.invoke("mcp-get-servers") as Promise<Array<{ config: { id: string; name: string; transport: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled: boolean }; status: string; error?: string; tools: Array<{ name: string; description?: string }> }>>,
  mcpAddServer: (config: Record<string, unknown>) => ipcRenderer.invoke("mcp-add-server", config) as Promise<void>,
  mcpUpdateServer: (id: string, updates: Record<string, unknown>) => ipcRenderer.invoke("mcp-update-server", id, updates) as Promise<void>,
  mcpRemoveServer: (id: string) => ipcRenderer.invoke("mcp-remove-server", id) as Promise<void>,
  mcpConnectServer: (id: string) => ipcRenderer.invoke("mcp-connect-server", id) as Promise<{ ok: boolean; error?: string }>,
  mcpDisconnectServer: (id: string) => ipcRenderer.invoke("mcp-disconnect-server", id) as Promise<void>,
  mcpGetToolOverride: (serverId: string, toolName: string) => ipcRenderer.invoke("mcp-get-tool-override", serverId, toolName) as Promise<string>,
  mcpSetToolOverride: (serverId: string, toolName: string, override: string) => ipcRenderer.send("mcp-set-tool-override", serverId, toolName, override),
  mcpSetServerOverride: (serverId: string, override: string) => ipcRenderer.send("mcp-set-server-override", serverId, override),
  onMcpChanged: (cb: () => void) => {
    ipcRenderer.on("mcp-changed", () => cb());
  },

  // Workspace / context panel
  workspaceGet: () => ipcRenderer.invoke("workspace-get") as Promise<string>,
  workspaceSet: (name: string) => ipcRenderer.invoke("workspace-set", name) as Promise<void>,
  workspaceList: () => ipcRenderer.invoke("workspace-list") as Promise<string[]>,
  contextRecent: (workspace: string, limit?: number) =>
    ipcRenderer.invoke("context-recent", workspace, limit ?? 50) as Promise<Array<{id: string; source: string; created: number; workspace?: string; snippet: string}>>,
  contextSearch: (workspace: string, query: string, limit?: number) =>
    ipcRenderer.invoke("context-search", workspace, query, limit ?? 20) as Promise<Array<{id: string; source: string; created: number; workspace?: string; snippet: string; score: number}>>,
  contextRead: (id: string) =>
    ipcRenderer.invoke("context-read", id) as Promise<string>,
  onContextUpdate: (cb: (entry: {id: string; source: string; created: number; workspace?: string}) => void) => {
    ipcRenderer.on("context-update", (_e, entry) => cb(entry));
  },
});
