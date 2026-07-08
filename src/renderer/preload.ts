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
  system: boolean;               // seeded system app (Glyphh) — hidden from the Apps list, undeletable
  url: string | null;
  // Browser ↔ Native model (pivot-mcp). isBrowser=true (default) → web app
  // with a url; false → native desktop app with execPath +
  // an archetype-specific launchConfig.
  isBrowser?: boolean;
  execPath?: string | null;
  appArchetype?: string | null;
  launchConfig?: Record<string, unknown> | null;
  connectionIds: string[];       // ids of first-class Connections this app uses
  mcp: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; oauth?: { clientId: string; hasSecret: boolean; tokenUrl: string; scope?: string }; enabled: boolean } | null;
  commands: Record<string, { selector: string; action: string; description?: string; text?: string }>;
  createdAt: string;
  updatedAt: string;
}

/** A first-class Connection — one connected Pipedream account. */
export interface Connection {
  id: string;
  accountId: string;
  appSlug: string;
  appName: string;
  label: string | null;
  healthy: boolean;
  hiddenTools: string[];
  createdAt: string;
}

/** One public <slug>.glyphh.app tunnel (server AppProxyRow, sanitized). */
export interface AppProxyRow {
  id: string;
  org_id: string;
  user_id: string;
  saved_app_id: string | null;
  kind: "http" | "mcp";
  slug: string;
  target: string;
  visibility: "private" | "org" | "public";
  status: "active" | "flagged" | "disabled";
  auth_mode: "public" | "glyphh" | "oidc" | "app_managed";
  auth_config: {
    issuer?: string; clientId?: string; scopes?: string[];
    allowedDomains?: string[]; hasClientSecret?: boolean;
  } | null;
  label: string | null;
  created_at: string;
  updated_at: string;
}

// Fields the create/update calls forward to /api/panel-apps. Kept as a named
// type so preload + renderer stay in sync on the accepted keys.
export interface PanelAppInput {
  name?: string;
  slug?: string;
  url?: string | null;
  isBrowser?: boolean;
  execPath?: string | null;
  appArchetype?: string | null;
  launchConfig?: Record<string, unknown> | null;
}

/** A marketplace listing (public catalog or org-private). Rich enough for a
 *  Shopify-style storefront: developer identity, rating, media, price. */
export interface MarketplaceApp {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description?: string;
  iconUrl?: string;
  developer: { name: string; verified: boolean };
  rating: number;          // 0–5
  ratingCount: number;
  priceCredits: number;    // 0 = free
  category: string;        // category id
  scope: "public" | "private";
  featured: boolean;       // sponsored strip
  popular: boolean;        // popular strip
  connections: Array<{ name: string; slug: string }>;   // required connections (slug = Pipedream app id)
  version?: string;
  videoUrl?: string;
  mockups?: string[];
  installed: boolean;
}

/** Full detail payload for one marketplace app (Shopify-style listing page). */
export interface MarketplaceAppDetail extends MarketplaceApp {
  description: string;
  highlights: string[];
  worksWith: string[];
  screenshots: Array<{ url: string; caption: string }>;
  plans: Array<{ name: string; priceCredits: number; blurb?: string; features: string[] }>;
  ratingBreakdown: Array<{ stars: number; count: number }>;
  reviews: Array<{ author: string; location?: string; rating: number; date: string; body: string; usage?: string }>;
  launchedAt: string;
  updatedAt?: string;
  website?: string;
  dataAccess: string[];
  languages: string[];
  similar: MarketplaceApp[];
}

contextBridge.exposeInMainWorld("yo", {
  copyToClipboard: (text: string) => ipcRenderer.invoke("copy-to-clipboard", text),
  // Toggle the full-screen command overlay (also bound to a global hotkey).
  commandToggle: () => ipcRenderer.send("command:toggle"),
  // Resolve a dropped/selected File to its absolute on-disk path. Electron 32+
  // removed File.path; webUtils.getPathForFile is the supported replacement.
  getPathForFile: (file: File): string => { try { return webUtils.getPathForFile(file); } catch { return ""; } },
  windowClose: () => ipcRenderer.send("window-close"),
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  windowMaximize: () => ipcRenderer.send("window-maximize"),
  // Screen layout (Settings → Appearance): dock mode + draggable fraction.
  screenLayoutGet: () => ipcRenderer.invoke("screen-layout-get") as Promise<{ mode: "full" | "left" | "right" | "top" | "bottom"; fraction: number }>,
  screenLayoutSet: (v: { mode?: string; fraction?: number }) => ipcRenderer.invoke("screen-layout-set", v) as Promise<{ mode: string; fraction: number }>,
  railCollapseGet: () => ipcRenderer.invoke("rail-collapse-get") as Promise<boolean>,
  railCollapseToggle: () => ipcRenderer.invoke("rail-collapse-toggle") as Promise<boolean>,
  railCollapseSet: (on: boolean) => ipcRenderer.invoke("rail-collapse-set", on) as Promise<boolean>,

  // Panel visibility + refresh
  panelsHide: () => ipcRenderer.send("panels-hide"),
  panelsShow: () => ipcRenderer.send("panels-show"),
  capturePanels: () => ipcRenderer.invoke("capture-panels") as Promise<Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }>>,
  panelsRefresh: (id?: string) => ipcRenderer.send("panels-refresh", id),
  panelsZoom: (factor: number) => ipcRenderer.send("panels-zoom", factor),
  panelsGetZoom: () => ipcRenderer.invoke("panels-get-zoom") as Promise<number>,

  // Layouts CRUD
  layoutsList: () => ipcRenderer.invoke("layouts-list") as Promise<Array<{ name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>>,
  // Open a layout at the OS level (real tiled windows) — hands off to the OS
  // layout manager, not the legacy in-window one.
  layoutsOpen: (name: string) => ipcRenderer.invoke("layouts-open", name) as Promise<{ ok: boolean; error?: string }>,
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
  // Fired by main whenever the saved-app library changes server-side (e.g. an
  // app was installed over the MCP relay) — the Apps page re-fetches.
  onPanelAppsChanged: (callback: () => void) => {
    ipcRenderer.on("panel-apps-changed", () => callback());
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

  // Marketplace — Shopify-style catalog of installable apps (public catalog +
  // org-private). Server routes are pending; until they land the main process
  // serves a placeholder catalog so the UI is fully renderable (see apps-ipc).
  marketplaceList: (params: {
    scope: "public" | "private"; category?: string; q?: string;
    sort?: "popular" | "rating" | "newest"; page?: number;
  }) => ipcRenderer.invoke("marketplace-list", params) as Promise<{
    items: MarketplaceApp[]; total: number; page: number; pageSize: number;
    categories: Array<{ id: string; label: string; count: number }>;
    featured: MarketplaceApp[]; popular: MarketplaceApp[];
  }>,
  marketplaceDetail: (id: string) =>
    ipcRenderer.invoke("marketplace-detail", id) as Promise<MarketplaceAppDetail | null>,
  marketplaceInstall: (id: string) =>
    ipcRenderer.invoke("marketplace-install", id) as Promise<{ ok: boolean; slug?: string; error?: string }>,

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
  // Launch an app the way its config dictates (native exec / real browser) —
  // see the app-launch handler in apps-ipc.ts.
  appLaunch: (spec: {
    slug: string; name: string; url?: string | null;
    isBrowser?: boolean;
    execPath?: string | null; appArchetype?: string | null;
    launchConfig?: Record<string, unknown> | null;
  }) => ipcRenderer.invoke("app-launch", spec) as Promise<{ ok: boolean; error?: string }>,
  // Live preview of an installed glyphh-app on the Apps page: grants the preview
  // <webview> (id passed by webContents id) the app's caps and returns the
  // file:// entry URL to load. Clear drops the grant when switching away.
  glyphhAppPreviewOpen: (slug: string, previewWcId?: number) =>
    ipcRenderer.invoke("glyphh-app:preview-open", previewWcId, slug) as Promise<{ ok: boolean; fileUrl?: string; error?: string }>,
  glyphhAppPreviewClear: (previewWcId?: number) =>
    ipcRenderer.invoke("glyphh-app:preview-clear", previewWcId) as Promise<{ ok: boolean }>,
  // Invoke an installed app's declared tool locally — the Apps page MCP "Test" button.
  appCallTool: (slug: string, tool: string, args: unknown) =>
    ipcRenderer.invoke("glyphh-app:call-tool", slug, tool, args) as Promise<{ ok: boolean; result?: unknown; error?: string }>,
  // Installed real browsers — the app editor's Browser dropdown.
  browsersDetect: () =>
    ipcRenderer.invoke("browsers-detect") as Promise<Array<{ id: string; name: string; chromium: boolean }>>,
  // OS icon for a native app's executable / .app bundle (data URL, "" if none).
  appFileIcon: (execPath: string) => ipcRenderer.invoke("app-file-icon", execPath) as Promise<string>,
  panelAppsList: () => ipcRenderer.invoke("panel-apps-list") as Promise<SavedPanelApp[]>,
  dashboardData: () => ipcRenderer.invoke("dashboard-data"),
  panelAppsCreate: (input: PanelAppInput) =>
    ipcRenderer.invoke("panel-apps-create", input) as Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>,
  panelAppsUpdate: (id: string, patch: PanelAppInput) =>
    ipcRenderer.invoke("panel-apps-update", id, patch) as Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>,
  panelAppsDelete: (id: string) => ipcRenderer.invoke("panel-apps-delete", id) as Promise<{ ok: boolean; error?: string }>,
  panelAppsSetConnections: (id: string, connectionIds: string[]) =>
    ipcRenderer.invoke("panel-apps-set-connections", id, connectionIds) as Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>,
  // First-class Connections (connected accounts + per-connection tool exposure).
  connectionsList: () =>
    ipcRenderer.invoke("connections-list") as Promise<{ ok: boolean; error?: string; connections: Connection[] }>,
  connectionRename: (id: string, label: string) =>
    ipcRenderer.invoke("connection-rename", id, label) as Promise<{ ok: boolean; connection?: Connection; error?: string }>,
  connectionToolsList: (id: string) =>
    ipcRenderer.invoke("connection-tools-list", id) as Promise<{ ok: boolean; error?: string; tools: Array<{ name: string; description: string; hidden: boolean }> }>,
  connectionToolsSet: (id: string, hiddenTools: string[]) =>
    ipcRenderer.invoke("connection-tools-set", id, hiddenTools) as Promise<{ ok: boolean; connection?: Connection; error?: string }>,
  connectionDisconnect: (id: string) =>
    ipcRenderer.invoke("connection-disconnect", id) as Promise<{ ok: boolean; error?: string }>,
  // App proxies — public <slug>.glyphh.app tunnels to locally-running apps.
  appProxyGet: (appId: string) =>
    ipcRenderer.invoke("app-proxy-get", appId) as Promise<{ ok: boolean; proxy?: AppProxyRow | null; error?: string }>,
  appProxyCreate: (body: Record<string, unknown>) =>
    ipcRenderer.invoke("app-proxy-create", body) as Promise<{ ok: boolean; proxy?: AppProxyRow; error?: string }>,
  appProxyUpdate: (id: string, body: Record<string, unknown>) =>
    ipcRenderer.invoke("app-proxy-update", id, body) as Promise<{ ok: boolean; proxy?: AppProxyRow; error?: string }>,
  panelAppsSetMcp: (id: string, mcp: Record<string, unknown>) =>
    ipcRenderer.invoke("panel-apps-set-mcp", id, mcp) as Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>,
  panelAppsRemoveMcp: (id: string) =>
    ipcRenderer.invoke("panel-apps-remove-mcp", id) as Promise<{ ok: boolean; error?: string }>,
  panelAppsSetCommand: (id: string, key: string, mapping: Record<string, unknown>) =>
    ipcRenderer.invoke("panel-apps-set-command", id, key, mapping) as Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>,
  panelAppsRemoveCommand: (id: string, key: string) =>
    ipcRenderer.invoke("panel-apps-remove-command", id, key) as Promise<{ ok: boolean; error?: string }>,
  // Per-app config vars (encrypted secrets). List never includes values —
  // a value is visible only in the form where it's typed, at creation.
  appSecretsList: (id: string) =>
    ipcRenderer.invoke("app-secrets-list", id) as Promise<{ ok: boolean; secrets?: Array<{ key: string; at: string; hostOnly?: boolean; appReadable?: boolean }>; error?: string }>,
  appSecretsSet: (id: string, key: string, value: string, appReadable?: boolean) =>
    ipcRenderer.invoke("app-secrets-set", id, key, value, appReadable) as Promise<{ ok: boolean; error?: string }>,
  appSecretsDelete: (id: string, key: string) =>
    ipcRenderer.invoke("app-secrets-delete", id, key) as Promise<{ ok: boolean; error?: string }>,
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
  orgGuardrailsGet: () => ipcRenderer.invoke("org-guardrails-get") as Promise<{ ok: boolean; policy?: Record<string, number> | null; error?: string }>,
  orgGuardrailsSet: (policy: Record<string, number> | null) => ipcRenderer.invoke("org-guardrails-set", policy) as Promise<{ ok: boolean; error?: string }>,
  logout: () => ipcRenderer.invoke("logout") as Promise<void>,
  onBoot: (callback: (data: { authenticated: boolean; status: string; tier?: string; needsOnboarding: boolean; hideWelcome?: boolean; theme?: string }) => void) => {
    ipcRenderer.on("boot", (_event, data) => callback(data));
  },
  williamRun: (p: { chatId: string }) =>
    ipcRenderer.invoke("william-run", p) as Promise<{ runId: string }>,
  williamSessionsLoad: () =>
    ipcRenderer.invoke("william-sessions-load") as Promise<{ chats: unknown[]; currentId: string }>,
  williamSessionsSave: (chats: unknown[], currentId: string) =>
    ipcRenderer.invoke("william-sessions-save", { chats, currentId }) as Promise<boolean>,
  williamRemember: (fact: string) => ipcRenderer.invoke("william-remember", fact) as Promise<boolean>,
  williamCompact: (chatId: string, focus: string) =>
    ipcRenderer.invoke("william-compact", { chatId, focus }) as Promise<{ ok: boolean; reason?: string }>,
  adaRecall: (query: string, k?: number) =>
    ipcRenderer.invoke("ada-recall", { query, k }) as Promise<Array<{ content: string; score: number }>>,
  adaAsk: (op: unknown) => ipcRenderer.invoke("ada-ask", { op }) as Promise<{ ok: boolean; answer?: string; error?: string }>,
  adaStats: () => ipcRenderer.invoke("ada-stats") as Promise<{ thoughts: number; slots: number; keys: number }>,
  williamContextUsage: (chatId: string) =>
    ipcRenderer.invoke("william-context-usage", { chatId }) as Promise<{ tokens: number; budget: number; ratio: number; foldAt: number }>,
  williamStop: () => ipcRenderer.invoke("william-stop") as Promise<boolean>,
  williamStatus: () => ipcRenderer.invoke("william-status") as Promise<{ up: boolean }>,
  onWilliamDelta: (callback: (d: { runId: string; delta: string }) => void) => {
    ipcRenderer.on("william:delta", (_event, d) => callback(d));
  },
  onWilliamDone: (callback: (d: { runId: string; stopped: boolean }) => void) => {
    ipcRenderer.on("william:done", (_event, d) => callback(d));
  },
  onWilliamError: (callback: (d: { runId: string; error: string }) => void) => {
    ipcRenderer.on("william:error", (_event, d) => callback(d));
  },
  onWilliamTool: (callback: (d: { runId: string; phase: string; name?: string; title?: string; thought?: string; denied?: boolean; failed?: boolean; preview?: string }) => void) => {
    ipcRenderer.on("william:tool", (_event, d) => callback(d));
  },
  williamApprovalRespond: (id: string, allow: boolean) =>
    ipcRenderer.invoke("william-approval-respond", { id, allow }) as Promise<boolean>,
  onWilliamApproval: (callback: (d: { id: string; kind: string; title: string; detail: string }) => void) => {
    ipcRenderer.on("william:approval", (_event, d) => callback(d));
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
  exportGlyphhSkill: (provider: string) => ipcRenderer.invoke("export-glyphh-skill", provider) as Promise<{ ok: boolean; path?: string; error?: string }>,
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
  // Support
  submitSupportTicket: (ticket: { subject: string; description: string }) =>
    ipcRenderer.invoke("submit-support-ticket", ticket) as Promise<{ ok: boolean; error?: string }>,


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
  // Command-palette parity for the rail search — same global channels the
  // command overlay uses (registered in command-window.ts).
  commandOsApps: () => ipcRenderer.invoke("command:os-apps") as Promise<Array<{ proc: string; path: string }>>,
  commandFocusApp: (proc: string) => ipcRenderer.invoke("command:focus-app", proc) as Promise<{ ok: boolean; error?: string }>,
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
  // Route a file to the app that handles its type (editor / browser / VS Code).
  openFile: (filePath: string) => ipcRenderer.send("file-open", filePath),

  // Connectors (Pipedream OAuth)
  connectorsGetApps: (search?: string, offset?: number) => ipcRenderer.invoke("connectors-get-apps", search, offset) as Promise<{ apps: Array<{ id: string; name: string; description: string; icon?: string }>; hasMore: boolean }>,
  connectorsGetAccounts: () => ipcRenderer.invoke("connectors-get-accounts") as Promise<Array<{ id: string; appSlug: string; appName: string; createdAt: string; healthy: boolean }>>,
  connectorsConnect: (appSlug: string) => ipcRenderer.invoke("connectors-connect", appSlug) as Promise<{ ok: boolean; error?: string }>,
  connectorsDisconnect: (accountId: string) => ipcRenderer.invoke("connectors-disconnect", accountId) as Promise<boolean>,
  connectorsRefreshMcp: () => ipcRenderer.invoke("connectors-refresh-mcp") as Promise<{ ok: boolean; error?: string; toolCount: number }>,
  connectorsListTools: () => ipcRenderer.invoke("connectors-list-tools") as Promise<Array<{ slug: string; name: string; description: string }>>,
  onConnectorsChanged: (cb: () => void) => { ipcRenderer.on("connectors-changed", cb); },

  // Apps registry live-reload — fired when ~/.glyphh/apps changes on disk so the
  // registry + picker refresh without a restart.
  onAppsChanged: (cb: () => void) => { ipcRenderer.on("apps-changed", () => cb()); },

  // Auto-update
  onUpdateStatus: (cb: (info: { status: string; version?: string; percent?: number; error?: string }) => void) => {
    ipcRenderer.on("update-status", (_e, info) => cb(info));
  },
  updateInstall: () => ipcRenderer.send("update-install"),
  updateBadgeDismiss: (version: string) => ipcRenderer.send("update-badge-dismiss", version),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates") as Promise<string | null>,
  // Current pending update (null when none) — lets the About page show the
  // "Relaunch to Update" prompt on load, not only when a live event arrives.
  getUpdateStatus: () => ipcRenderer.invoke("get-update-status") as Promise<{ version: string; ready: boolean } | null>,

  // Remote relay — settings UI uses these. The JWT authenticates the WS,
  // so there's no client-token to manage; only the external (server) tokens
  // for the user's external tools.
  relayReconnect: () => ipcRenderer.invoke("relay-reconnect") as Promise<void>,
  relayStatus: () => ipcRenderer.invoke("relay-status") as Promise<{ enabled: boolean; signedIn: boolean; state: "off" | "connecting" | "connected" | "disconnected" }>,
  relayTokensList: () => ipcRenderer.invoke("relay-tokens-list") as Promise<Array<{ id: string; label: string; type: string; userId: string | null; createdAt: string; expiresAt: string }> | { error: string }>,
  relayTokensCreate: (label: string) => ipcRenderer.invoke("relay-tokens-create", label) as Promise<{ ok: boolean; id: string; token: string; expiresAt: string } | { error: string }>,
  relayTokensRevoke: (id: string) => ipcRenderer.invoke("relay-tokens-revoke", id) as Promise<{ ok: boolean } | { error: string }>,
  relayInstallClaude: (token: string) => ipcRenderer.invoke("relay-install-claude", token) as Promise<{ ok: boolean; path: string } | { error: string }>,

  // Local MCP server (127.0.0.1) — the no-cloud alternative to the relay.
  localMcpSetEnabled: (enabled: boolean) => ipcRenderer.invoke("local-mcp-set-enabled", enabled) as Promise<{ ok: boolean; error?: string }>,
  localMcpStatus: () => ipcRenderer.invoke("local-mcp-status") as Promise<{ running: boolean; port: number }>,
  localMcpSetPort: (port: number) => ipcRenderer.invoke("local-mcp-set-port", port) as Promise<{ ok: boolean; error?: string }>,
  localMcpTokensList: () => ipcRenderer.invoke("local-mcp-tokens-list") as Promise<Array<{ id: string; label: string; createdAt: string; expiresAt: string }>>,
  localMcpTokensCreate: (label: string) => ipcRenderer.invoke("local-mcp-tokens-create", label) as Promise<{ id: string; label: string; token: string; createdAt: string; expiresAt: string }>,
  localMcpTokensRevoke: (id: string) => ipcRenderer.invoke("local-mcp-tokens-revoke", id) as Promise<{ ok: boolean }>,

  // BYOK provider key — the only surviving path is the Claude Code bootstrap
  // gate (boot-gate-ui.ts) saving an Anthropic key. The Providers Settings
  // panel (list/remove/test + per-provider model catalog) was removed.

  // Claude Code bootstrap (Phase 2 of THE-PIVOT-BYOK)
  // BYOK gate status — true when an Anthropic API key is configured.


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
  onContextUpdate: (cb: (entry: {id: string; source: string; created: number; workspace?: string}) => void) => {
    ipcRenderer.on("context-update", (_e, entry) => cb(entry));
  },
});

// ── Code workbench bridge (window.wb) ────────────────────────────────────
// The same contract the old standalone workbench preload exposed: workdir +
// git, the lazy file tree / file readers / diff, and the per-id terminal pty
// bridge the Files / Diff / Terminal slots need. Consumed by
// code-workbench-bundle.js inside the Code section.
contextBridge.exposeInMainWorld("wb", {
  getCwd: () => ipcRenderer.invoke("working-dir:get"),
  pickCwd: () => ipcRenderer.invoke("working-dir:pick"),
  setCwd: (dir: string) => ipcRenderer.invoke("working-dir:set", dir),
  getCwdRecents: () => ipcRenderer.invoke("working-dir:recents"),
  gitInfo: (root: string) => ipcRenderer.invoke("files:git-info", root),
  onCwdChanged: (cb: (dir: string | null) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, dir: string | null) => cb(dir);
    ipcRenderer.on("working-dir-changed", handler);
    return () => { ipcRenderer.removeListener("working-dir-changed", handler); };
  },
  onFileChanged: (cb: (absPath: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, abs: string) => cb(abs);
    ipcRenderer.on("workdir:file-changed", handler);
    return () => { ipcRenderer.removeListener("workdir:file-changed", handler); };
  },
  listDir: (dir: string) => ipcRenderer.invoke("files:list-dir", dir),
  readFile: (filePath: string) => ipcRenderer.invoke("files:read-file", filePath),
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke("files:write-file", filePath, content),
  gitDiff: (root: string) => ipcRenderer.invoke("files:git-diff", root),
  termSpawn: (termId: string, cwd: string, cols: number, rows: number) =>
    ipcRenderer.send("wb-term:spawn", termId, cwd, cols, rows),
  termWrite: (termId: string, data: string) => ipcRenderer.send("wb-term:write", termId, data),
  termResize: (termId: string, cols: number, rows: number) =>
    ipcRenderer.send("wb-term:resize", termId, cols, rows),
  termKill: (termId: string) => ipcRenderer.send("wb-term:kill", termId),
  termOnData: (termId: string, cb: (data: string) => void) => {
    const channel = `wb-term:data:${termId}`;
    const handler = (_e: Electron.IpcRendererEvent, data: string) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  },
  termOnExit: (termId: string, cb: (code: number) => void) => {
    const channel = `wb-term:exit:${termId}`;
    const handler = (_e: Electron.IpcRendererEvent, code: number) => cb(code);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  },
});
