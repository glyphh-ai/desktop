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
  /** Who may reach it once deployed: 'public' (anyone with the link) or
   *  'members' (signed-in org members). Enforced at the edge. */
  access?: string;
  owned?: boolean;
  latestVersion?: string | null;
  requiredConnections?: { slug: string; actAs: string; connected: boolean }[];
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
  /** Org-SHARED connection (Configure → Connections) — read-only here. */
  org?: boolean;
  /** Governance, from the resolved catalog: false = this connection is
   *  connected but BLOCKED for the caller (workspace/org policy) — agents
   *  cannot call it. Undefined = governance unknown (offline). */
  agentAllowed?: boolean;
  /** Tools the caller's agents may actually call / tools advertised. */
  agentTools?: number;
  agentAvailable?: number;
}

/** One immutable build of an app, as the Releases tab renders it. */
export interface AppReleaseRow {
  id: string;
  version: string;
  status: "pending" | "uploading" | "building" | "ready" | "failed";
  error: string | null;
  notes: string | null;
  channel: "dev" | "live";
  promotedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Account surfaces (Settings › Billing / Organization / Account) ──────────
// The wire shapes of the SDK's billing/org/profile resources, mirrored here so
// the desktop contract is self-describing. Money is USD cents, credits are
// MICRO-credits (1 credit = 1e6) exactly as the server reports them — the
// renderer's settings-api.ts is the one place that converts for display.

/** A plan in the server-driven catalog (super-admin plans + their pricing). */
export interface AccountBillingPlan {
  tier: string;
  displayName: string;
  monthlyUsdCents: number;
  /** The TRUE active Stripe price, when resolvable — prefer this for display. */
  activeUsdCents?: number;
  monthlyCredits: number;
  maxSeats: number;
  sso: boolean;
  /** A PROVISIONED per-org plan: a real invoiced deal, not the generic tier. */
  bespoke?: boolean;
}

export interface AccountSubscription {
  tier: string;
  billingStatus: string;  // trial | active | past_due | canceled | none
  seats: number;
  maxSeats: number;
}

/** The org's credit balance by lot kind, in MICRO-credits. */
export interface AccountCredits {
  balance: number;
  allowance: number;
  grants: number;
  purchases: number;
}

/** The org's auto-top-up rule (MICRO-credits). */
export interface AccountAutotopup {
  enabled: boolean;
  thresholdCredits: number;
  topupCredits: number;
}

/** One normalized Stripe invoice (USD cents; `created` in unix seconds). */
export interface AccountInvoice {
  id: string;
  number: string | null;
  amountDue: number;
  amountPaid: number;
  status: string | null;
  hostedUrl: string | null;
  created: number;
}

export interface AccountAddress {
  line1: string; line2?: string; city: string; state: string; postalCode: string; country: string;
}

export interface AccountOrg {
  id: string;
  name: string;
  tier: string;
  maxSeats: number;
  seatsUsed: number;
  address: AccountAddress | null;
  billingAddress: AccountAddress | null;
  billingSameAsAddress: boolean;
  billingContact: { name: string; email: string; phone?: string } | null;
}

/** The caller's own editable profile. */
export interface AccountProfile {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  timezone: string;
  role: string;
  imageUrl: string | null;
  avatarUrl: string;
}

// Files artifact store (Files gallery). Structural mirror of @glyphh/sdk's
// FileArtifact / CreateFileInput — the MAIN-process SDK client executes these
// (files-ipc.ts); the renderer's help/files.ts mirrors the same shapes and owns
// the web target's SDK-handle transport. downloadUrl is present only on get().
export interface FileArtifactRow {
  id: string;
  name: string;
  mime: string;
  kind: "code" | "text" | "markdown" | "image" | "pdf" | "other";
  sessionId: string | null;
  sizeBytes: number;
  createdAt: string;
  downloadUrl?: string;
}
export interface FileCreateInputRow {
  name: string;
  mime?: string;
  contentBase64: string;
  sessionId?: string | null;
}

// A4 settings panels (API Keys, Support, Runtime, Guardrails). Structural
// mirrors of the SDK's shapes — the MAIN-process client executes these
// (apikeys-ipc.ts / support-ipc.ts / account-ipc.ts); help/settings-*.ts mirror
// the same shapes and own the web target's SDK-handle transport.
export interface ApiKeyRow { id: string; label: string; prefix: string; userId: string; userEmail: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null }
export interface CreatedApiKeyRow { key: ApiKeyRow; token: string }
export interface SupportMessageRow { id: string; authorKind: "user" | "admin"; authorUserId: string | null; body: string; createdAt: string }
export interface SupportTicketRow { id: string; subject: string; status: string; createdAt: string; updatedAt: string; lastMessage?: SupportMessageRow | null; unread?: boolean }
export interface SupportThreadRow extends SupportTicketRow { messages: SupportMessageRow[] }
export interface OrgInfraRow { mode: string; region: string | null; tier: string | null; status: string; regionChosen: boolean; regions: Array<{ id: string; label?: string }> }
export interface GuardrailsRow { guardrails_policy: Record<string, number> | null }

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
  access?: "public" | "members";
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
  /** Manifest-declared connections + whether the caller's org has each connected. */
  requiredConnections: Array<{ slug: string; actAs: string; connected: boolean }>;
  /** True when the caller's org published this app (gates publish-side UI). */
  owned: boolean;
}

/** The `{ ok, data | error }` envelope every library IPC handler returns. */
interface LibEnvelope { ok: boolean; data?: unknown; error?: string }

/** One model slot a loop declares, resolved for this caller — what a picker renders. */
interface LoopRoleView {
  name: string;
  label: string;
  description: string;
  modelId: string | null;
  source: "selection" | "loop" | "platform" | "fallback" | "none";
  choices: Array<{
    id: string;
    name: string;
    providerSlug: string;
    contextWindow: number | null;
    maxOutputTokens: number | null;
    inputCreditsPerMTok: number;
    outputCreditsPerMTok: number;
    isPlatformDefault: boolean;
  }>;
}

contextBridge.exposeInMainWorld("glyphh", {
  copyToClipboard: (text: string) => ipcRenderer.invoke("copy-to-clipboard", text),
  // Toggle the full-screen command overlay (also bound to a global hotkey).
  // Resolve a dropped/selected File to its absolute on-disk path. Electron 32+
  // removed File.path; webUtils.getPathForFile is the supported replacement.
  getPathForFile: (file: File): string => { try { return webUtils.getPathForFile(file); } catch { return ""; } },
  windowClose: () => ipcRenderer.send("window-close"),
  /** The menu's ⌘W — the workbench closes the top panel first, and only
   *  falls back to windowClose when nothing is open. */
  onCloseGesture: (cb: () => void) => { ipcRenderer.on("close-gesture", () => cb()); },
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  // Org-admin Workspaces page (mirrors the platform's Configure → Workspaces).
  // Everything is `{ ok, data }` — the renderer paints the server's refusal
  // rather than assuming the caller is allowed.
  workspacesList: () => ipcRenderer.invoke("workspaces-list") as Promise<{ ok: boolean; data?: unknown[]; error?: string }>,
  workspacesCreate: (input: unknown) => ipcRenderer.invoke("workspaces-create", input) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  workspacesUpdate: (id: string, input: unknown) => ipcRenderer.invoke("workspaces-update", id, input) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  workspacesDelete: (id: string) => ipcRenderer.invoke("workspaces-delete", id) as Promise<{ ok: boolean; error?: string }>,
  workspacesModelCatalog: () => ipcRenderer.invoke("workspaces-model-catalog") as Promise<{ ok: boolean; data?: unknown[]; error?: string }>,
  workspacesOrgConnectors: () => ipcRenderer.invoke("workspaces-org-connectors") as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  workspacesOrgToolCap: () => ipcRenderer.invoke("workspaces-org-tool-cap") as Promise<{ ok: boolean; data?: Record<string, string[]>; error?: string }>,
  workspacesConnTools: (slug: string) => ipcRenderer.invoke("workspaces-conn-tools", slug) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  workspacesAppSearch: (search: string, limit?: number) => ipcRenderer.invoke("workspaces-app-search", search, limit) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  // Org-admin Models page (mirrors the platform's Configure → Models).
  orgModelsList: () => ipcRenderer.invoke("org-models-list") as Promise<{ ok: boolean; data?: unknown[]; error?: string }>,
  orgModelsSetSupported: (id: string, supported: boolean) => ipcRenderer.invoke("org-models-set-supported", id, supported) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  orgCustomModelsList: () => ipcRenderer.invoke("org-custom-models-list") as Promise<{ ok: boolean; data?: unknown[]; error?: string }>,
  orgCustomModelsSave: (input: unknown) => ipcRenderer.invoke("org-custom-models-save", input) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  orgCustomModelsDelete: (id: string) => ipcRenderer.invoke("org-custom-models-delete", id) as Promise<{ ok: boolean; error?: string }>,
  orgProvidersList: () => ipcRenderer.invoke("org-providers-list") as Promise<{ ok: boolean; data?: unknown[]; error?: string }>,
  orgProviderEnable: (slug: string, key?: string) => ipcRenderer.invoke("org-provider-enable", slug, key) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  orgProviderDisable: (slug: string) => ipcRenderer.invoke("org-provider-disable", slug) as Promise<{ ok: boolean; error?: string }>,
  orgProviderClearKey: (slug: string) => ipcRenderer.invoke("org-provider-clear-key", slug) as Promise<{ ok: boolean; error?: string }>,
  windowMaximize: () => ipcRenderer.send("window-maximize"),
  // Screen layout (Settings → Appearance): dock mode + draggable fraction.
  railCollapseGet: () => ipcRenderer.invoke("rail-collapse-get") as Promise<boolean>,
  railCollapseToggle: () => ipcRenderer.invoke("rail-collapse-toggle") as Promise<boolean>,
  railCollapseSet: (on: boolean) => ipcRenderer.invoke("rail-collapse-set", on) as Promise<boolean>,

  // Home view visibility + refresh
  panelsHide: () => ipcRenderer.send("panels-hide"),
  panelsShow: () => ipcRenderer.send("panels-show"),
  panelsRefresh: () => ipcRenderer.send("panels-refresh"),
  panelsZoom: (factor: number) => ipcRenderer.send("panels-zoom", factor),
  panelsGetZoom: () => ipcRenderer.invoke("panels-get-zoom") as Promise<number>,

  // Layouts CRUD
  layoutsList: () => ipcRenderer.invoke("layouts-list") as Promise<Array<{ name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; loop?: string | null; modelSelections?: Record<string, string>; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean }> }>>,
  // Open a layout at the OS level (real tiled windows) — hands off to the OS
  // layout manager, not the legacy in-window one.
  layoutsOpen: (name: string) => ipcRenderer.invoke("layouts-open", name) as Promise<{ ok: boolean; error?: string }>,
  layoutsSave: (name: string, panelIds: string[]) => ipcRenderer.invoke("layouts-save", name, panelIds) as Promise<boolean>,
  layoutsPickFolder: () => ipcRenderer.invoke("layouts-pick-folder") as Promise<string | null>,
  layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean; config?: { url?: string; cmd?: string; keepAlive?: boolean } }>; folderMode?: "single" | "multi"; target?: "glyphh" | "desktop"; glyphh?: { mode: "rail" | "left" | "right" | "none"; fraction?: number }; loop?: string | null; modelSelections?: Record<string, string>; sessionMode?: "keep" | "new" | "last"; folder?: string | null; space?: "chat" | "cowork" | "code" | null }) =>
    ipcRenderer.invoke("layouts-save-grid", grid) as Promise<boolean>,
  layoutsDelete: (name: string) => ipcRenderer.invoke("layouts-delete", name) as Promise<boolean>,
  pickDirectory: () => ipcRenderer.invoke("pick-directory") as Promise<string | null>,
  pickExecutable: () => ipcRenderer.invoke("pick-executable") as Promise<string | null>,

  // Drips CRUD
  dripsList: () => ipcRenderer.invoke("drips-list") as Promise<Array<{ name: string; recipe: string }>>,
  dripsSave: (name: string, recipe: string) => ipcRenderer.invoke("drips-save", name, recipe) as Promise<string>,
  dripsDelete: (name: string) => ipcRenderer.invoke("drips-delete", name) as Promise<string>,
  dripsPreview: (recipe: string) => ipcRenderer.invoke("drips-preview", recipe) as Promise<string>,
  dripsBuiltinEffects: () => ipcRenderer.invoke("drips-builtin-effects") as Promise<Array<{ name: string; kind: "one-shot" | "loop" }>>,

  // Run-stream observer (the desktop transport behind attachToActiveRun): the
  // renderer supplies its own subscription token, so pushed frames are
  // filterable from the very first event. Returns unsubscribe functions.
  runStreamAttach: (threadId: string, token: string) =>
    ipcRenderer.invoke("run-stream-attach", threadId, token) as Promise<{ ok: boolean; error?: string }>,
  runStreamStop: (token: string) => ipcRenderer.invoke("run-stream-stop", token) as Promise<{ ok: boolean }>,
  onRunStreamFrame: (cb: (p: { token: string; frame: unknown }) => void) => {
    const l = (_e: unknown, p: { token: string; frame: unknown }) => cb(p);
    ipcRenderer.on("run-stream-frame", l);
    return () => { ipcRenderer.removeListener("run-stream-frame", l); };
  },
  onRunStreamRun: (cb: (p: { token: string; runId: string }) => void) => {
    const l = (_e: unknown, p: { token: string; runId: string }) => cb(p);
    ipcRenderer.on("run-stream-run", l);
    return () => { ipcRenderer.removeListener("run-stream-run", l); };
  },

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
  getBackgroundMode: () => ipcRenderer.invoke("get-background-mode") as Promise<boolean>,
  setBackgroundMode: (enabled: boolean) => ipcRenderer.invoke("set-background-mode", enabled) as Promise<boolean>,
  // Fires in every panel when a preference is changed anywhere — lets forms
  // (e.g. Settings → Agent Defaults) reflect a change made elsewhere live.
  onPreferenceChanged: (cb: (key: string, value: unknown) => void) => {
    ipcRenderer.on("preference-changed", (_e, key, value) => cb(key, value));
  },
  onFocusInput: (callback: () => void) => {
    ipcRenderer.on("focus-command-input", () => callback());
  },

  // Fired by main whenever the saved-app library changes server-side (e.g. an
  // app was installed over the MCP relay) — the Apps page re-fetches.
  onPanelAppsChanged: (callback: () => void) => {
    ipcRenderer.on("panel-apps-changed", () => callback());
  },
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

  // Dashboard shell (5a): the Apps tab's data source. Every call here is a
  // main-process-mediated, JWT-authed request to yo-server's /api/panel-apps
  // (see panel-apps-* handlers in apps-ipc.ts) — no local mirror.
  // 5b Panel Manager: open a server app in its own native OS window.
  // Launch an app the way its config dictates (native exec / real browser) —
  // see the app-launch handler in apps-ipc.ts.
  appLaunch: (spec: {
    slug: string; name: string; url?: string | null;
    isBrowser?: boolean;
    execPath?: string | null; appArchetype?: string | null;
    launchConfig?: Record<string, unknown> | null;
  }) => ipcRenderer.invoke("app-launch", spec) as Promise<{ ok: boolean; error?: string }>,
  // Command center as a fullscreen transparent overlay over the whole desktop
  // Live preview of an installed glyphh-app on the Apps page: grants the preview
  // <webview> (id passed by webContents id) the app's caps and returns the
  // file:// entry URL to load. Clear drops the grant when switching away.
  glyphhAppPreviewOpen: (slug: string, previewWcId?: number) =>
    ipcRenderer.invoke("glyphh-app:preview-open", previewWcId, slug) as Promise<{ ok: boolean; fileUrl?: string; error?: string }>,
  glyphhAppPreviewClear: (previewWcId?: number) =>
    ipcRenderer.invoke("glyphh-app:preview-clear", previewWcId) as Promise<{ ok: boolean }>,
  // RPA: register/clear a panel's webContents id so main's rpa.* handlers
  // (attach + loopback MCP) can drive it.
  rpaRegister: (slug: string, wcId: number) => ipcRenderer.send("wb:rpa-register", slug, wcId),
  rpaUnregister: (slug: string) => ipcRenderer.send("wb:rpa-unregister", slug),
  // Invoke an installed app's declared tool locally — the Apps page MCP "Test" button.
  appCallTool: (slug: string, tool: string, args: unknown) =>
    ipcRenderer.invoke("glyphh-app:call-tool", slug, tool, args) as Promise<{ ok: boolean; result?: unknown; error?: string }>,
  // Installed real browsers — the app editor's Browser dropdown.
  // OS icon for a native app's executable / .app bundle (data URL, "" if none).
  appFileIcon: (execPath: string) => ipcRenderer.invoke("app-file-icon", execPath) as Promise<string>,
  // Favicon bytes as a data URL (main-process fetch — CORS-free) for WebGL.
  webIconFetch: (url: string) => ipcRenderer.invoke("web-icon-fetch", url) as Promise<string>,
  panelAppsList: () => ipcRenderer.invoke("panel-apps-list") as Promise<SavedPanelApp[]>,
  dashboardData: () => ipcRenderer.invoke("dashboard-data"),
  dashboardRuns: () => ipcRenderer.invoke("dashboard-runs") as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  homeGotoSection: (section: string) => ipcRenderer.invoke("home-goto-section", section) as Promise<{ ok: boolean }>,
  onOpenCommandCenter: (cb: () => void) => {
    ipcRenderer.on("home:open-cc", () => cb());
  },
  onGotoSection: (cb: (section: string) => void) => {
    ipcRenderer.on("home:goto-section", (_e, section: string) => cb(section));
  },
  // `userId` narrows the series to one member — org_admin only (the server
  // rejects it for anyone else); "" / omitted means the caller's own scope.
  usageSeries: (days: number, groupBy: string, userId?: string) =>
    ipcRenderer.invoke("usage-series", days, groupBy, userId) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  panelAppsCreate: (input: PanelAppInput) =>
    ipcRenderer.invoke("panel-apps-create", input) as Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>,
  panelAppsUpdate: (id: string, patch: PanelAppInput) =>
    ipcRenderer.invoke("panel-apps-update", id, patch) as Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>,
  panelAppsDelete: (id: string) => ipcRenderer.invoke("panel-apps-delete", id) as Promise<{ ok: boolean; error?: string }>,
  // First-class Connections (connected accounts + per-connection tool exposure).
  loopsList: () =>
    ipcRenderer.invoke("loops-list") as Promise<{ ok: boolean; loops: Array<{ id: string; name: string; description: string; builtIn?: boolean }>; canBuild: boolean }>,
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
  // Deploy (dev-host) + Production (Supabase graduation) — app-detail tabs.
  hostingStatus: (slug: string) => ipcRenderer.invoke("hosting-status", slug) as Promise<{ ok: boolean; deployment?: { id: string; appSlug: string; url: string | null; status: string } | null; error?: string }>,
  hostingDeploy: (slug: string) => ipcRenderer.invoke("hosting-deploy", slug) as Promise<{ ok: boolean; deployment?: { id: string; url: string | null; status: string }; error?: string }>,
  hostingDestroy: (id: string) => ipcRenderer.invoke("hosting-destroy", id) as Promise<{ ok: boolean; error?: string }>,
  // Marketplace listing — copy, images, and the list/unlist decision.
  appListingSet: (slug: string, patch: Record<string, unknown>) =>
    ipcRenderer.invoke("app-listing-set", slug, patch) as Promise<{ ok: boolean; error?: string }>,
  appListingImageAdd: (slug: string, kind: "icon" | "screenshot") =>
    ipcRenderer.invoke("app-listing-image-add", slug, kind) as Promise<{ ok: boolean; key?: string; error?: string }>,
  appListingImageRemove: (slug: string, key: string) =>
    ipcRenderer.invoke("app-listing-image-remove", slug, key) as Promise<{ ok: boolean; error?: string }>,
  appListingList: (slug: string, listed: boolean) =>
    ipcRenderer.invoke("app-listing-list", slug, listed) as Promise<{ ok: boolean; listed?: boolean; error?: string }>,
  // Releases — the app's version history, its notes, and dev → live promotion.
  // Re-fetch + reinstall an installed app at its newest published version. The
  // download endpoint is server-side and not built yet, so this reports honestly.
  appUpdateInstalled: (slug: string) =>
    ipcRenderer.invoke("app-update-installed", slug) as Promise<{ ok: boolean; error?: string }>,
  appBuildDeploy: (slug: string) =>
    ipcRenderer.invoke("app-build-deploy", slug) as Promise<{ ok: boolean; result?: { slug: string; version: string; status: string; url?: string }; error?: string }>,
  appReleases: (slug: string) =>
    ipcRenderer.invoke("app-releases", slug) as Promise<{ ok: boolean; releases: AppReleaseRow[]; error?: string }>,
  appReleaseNotes: (slug: string, releaseId: string, notes: string | null) =>
    ipcRenderer.invoke("app-release-notes", slug, releaseId, notes) as Promise<{ ok: boolean; release?: AppReleaseRow; error?: string }>,
  appReleasePromote: (slug: string, releaseId: string) =>
    ipcRenderer.invoke("app-release-promote", slug, releaseId) as Promise<{ ok: boolean; release?: AppReleaseRow; error?: string }>,
  appGraduate: (slug: string) => ipcRenderer.invoke("app-graduate", slug) as Promise<{ ok: boolean; path?: string; error?: string }>,

  // Onboarding complete — triggers panel restore
  onboardingComplete: () => ipcRenderer.invoke("onboarding-complete"),

  // App version
  getAppVersion: () => ipcRenderer.invoke("get-app-version") as Promise<string>,

  // Auth
  startAuth: (mode: "register" | "login") => ipcRenderer.invoke("start-auth", mode) as Promise<boolean>,
  isAuthenticated: () => ipcRenderer.invoke("is-authenticated") as Promise<boolean>,
  // Device-flow sign-in: the default browser opens on the platform's approval
  // page; the prompt event carries the user code + URL to display while
  // polling. Calling start again replaces the in-flight grant (fresh code).
  startDeviceLogin: () => ipcRenderer.invoke("start-device-login") as Promise<{ ok: boolean; error?: string }>,
  cancelDeviceLogin: () => ipcRenderer.invoke("cancel-device-login") as Promise<{ ok: boolean }>,
  openDeviceApproval: (url: string) => ipcRenderer.invoke("open-device-approval", url) as Promise<{ ok: boolean }>,
  onDeviceLoginPrompt: (cb: (prompt: { userCode: string; verificationUri: string; verificationUriComplete?: string; expiresIn: number }) => void) => {
    ipcRenderer.on("device-login-prompt", (_e, prompt) => cb(prompt));
  },
  getAccountInfo: () => ipcRenderer.invoke("get-account-info") as Promise<{ email: string; firstName: string; lastName: string; role: string; orgName: string; tier: string; billingStatus: string } | null>,
  // ── Account surfaces (Settings › Billing / Organization / Account) — the
  // MAIN-process SDK client executes these (account-ipc.ts). The renderer
  // mirrors their shapes structurally in help/settings-api.ts, which also owns
  // the web target's SDK-handle transport. Reads REJECT on failure so the
  // panel can show an honest error; writes answer with { ok, error }. ──
  billingPlans: () => ipcRenderer.invoke("billing-plans") as Promise<AccountBillingPlan[]>,
  billingStatus: () => ipcRenderer.invoke("billing-status") as Promise<AccountSubscription>,
  billingCredits: () => ipcRenderer.invoke("billing-credits") as Promise<AccountCredits>,
  billingInvoices: () => ipcRenderer.invoke("billing-invoices") as Promise<AccountInvoice[]>,
  billingAutotopupGet: () => ipcRenderer.invoke("billing-autotopup-get") as Promise<AccountAutotopup>,
  billingAutotopupSet: (input: AccountAutotopup) =>
    ipcRenderer.invoke("billing-autotopup-set", input) as Promise<{ ok: boolean; config?: AccountAutotopup; error?: string }>,
  billingSubscribe: (tier: string) =>
    ipcRenderer.invoke("billing-subscribe", tier) as Promise<{ ok: boolean; url?: string; error?: string }>,
  billingChangePlan: (tier: string) =>
    ipcRenderer.invoke("billing-change-plan", tier) as Promise<{ ok: boolean; change?: { tier: string; effect: string; url?: string }; error?: string }>,
  billingTopup: (credits: number) =>
    ipcRenderer.invoke("billing-topup", credits) as Promise<{ ok: boolean; url?: string; error?: string }>,
  billingPortal: () => ipcRenderer.invoke("billing-portal") as Promise<{ ok: boolean; url?: string; error?: string }>,
  accountOrgGet: () => ipcRenderer.invoke("account-org-get") as Promise<AccountOrg>,
  accountOrgUpdate: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke("account-org-update", patch) as Promise<{ ok: boolean; org?: AccountOrg; error?: string }>,
  accountProfileGet: () => ipcRenderer.invoke("account-profile-get") as Promise<AccountProfile>,
  accountProfileUpdate: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke("account-profile-update", patch) as Promise<{ ok: boolean; profile?: AccountProfile; error?: string }>,
  accountMembersList: () => ipcRenderer.invoke("account-members-list") as Promise<Array<{ userId: string; email: string; name: string | null; role: string }>>,
  accountMembersInvite: (email: string, role: string) =>
    ipcRenderer.invoke("account-members-invite", email, role) as Promise<{ ok: boolean; invite?: { acceptUrl?: string }; error?: string }>,
  accountMembersRemove: (userId: string) =>
    ipcRenderer.invoke("account-members-remove", userId) as Promise<{ ok: boolean; error?: string }>,
  accountMembersSetRole: (userId: string, role: string) =>
    ipcRenderer.invoke("account-members-set-role", userId, role) as Promise<{ ok: boolean; error?: string }>,
  accountMembersUpdateProfile: (userId: string, patch: { firstName?: string; lastName?: string }) =>
    ipcRenderer.invoke("account-members-update-profile", userId, patch) as Promise<{ ok: boolean; error?: string }>,
  // ── Settings › Platform (super_admin console) — the MAIN-process SDK client
  // executes these (admin-ipc.ts). The server enforces super_admin on every
  // route. Reads REJECT on failure; writes answer { ok, …, error }. All rates/
  // credits keep WIRE units (micro-credits, USD cents); the renderer
  // (help/settings-admin.ts) owns display conversion + the web SDK path. ──
  adminModels: () => ipcRenderer.invoke("admin-models") as Promise<{ models: unknown[] }>,
  adminModelUpdate: (provider: string, model: string, patch: Record<string, unknown>) =>
    ipcRenderer.invoke("admin-model-update", provider, model, patch) as Promise<{ ok: boolean; model?: unknown; error?: string }>,
  adminPlans: () => ipcRenderer.invoke("admin-plans") as Promise<{ plans: unknown[] }>,
  adminPlanUpdate: (tier: string, patch: Record<string, unknown>) =>
    ipcRenderer.invoke("admin-plan-update", tier, patch) as Promise<{ ok: boolean; plan?: unknown; error?: string }>,
  adminPlanPrices: (tier: string) => ipcRenderer.invoke("admin-plan-prices", tier) as Promise<unknown[]>,
  adminPlanPriceAdd: (tier: string, stripePriceId: string) =>
    ipcRenderer.invoke("admin-plan-price-add", tier, stripePriceId) as Promise<{ ok: boolean; price?: unknown; error?: string }>,
  adminPlanPriceActivate: (id: string) =>
    ipcRenderer.invoke("admin-plan-price-activate", id) as Promise<{ ok: boolean; price?: unknown; error?: string }>,
  adminPlanPriceRemove: (id: string) =>
    ipcRenderer.invoke("admin-plan-price-remove", id) as Promise<{ ok: boolean; error?: string }>,
  adminUsageByUser: (days: number) => ipcRenderer.invoke("admin-usage-by-user", days) as Promise<{ users: unknown[] }>,
  adminUsageDaily: (q: { from: string; to: string; tz?: string }) =>
    ipcRenderer.invoke("admin-usage-daily", q) as Promise<{ days: unknown[] }>,
  adminUsageByRuntime: (q: { from: string; to: string }) =>
    ipcRenderer.invoke("admin-usage-by-runtime", q) as Promise<{ runtimes: unknown[] }>,
  adminOrgs: (q: { q?: string; page?: number; limit?: number }) =>
    ipcRenderer.invoke("admin-orgs", q) as Promise<{ orgs: unknown[]; total: number }>,
  adminOrgGrantCredits: (id: string, credits: number, note?: string) =>
    ipcRenderer.invoke("admin-org-grant-credits", id, credits, note) as Promise<{ ok: boolean; balance?: number; error?: string }>,
  // ── Files artifact store (Files gallery) — the MAIN-process SDK client
  // executes these (files-ipc.ts). Reads REJECT on failure so the gallery shows
  // an honest error; create answers with { ok, file, error }. help/files.ts
  // mirrors these shapes and owns the web target's SDK-handle transport. ──
  filesList: () => ipcRenderer.invoke("files-list") as Promise<FileArtifactRow[]>,
  filesGet: (id: string) => ipcRenderer.invoke("files-get", id) as Promise<FileArtifactRow>,
  filesCreate: (input: FileCreateInputRow) =>
    ipcRenderer.invoke("files-create", input) as Promise<{ ok: boolean; file?: FileArtifactRow; error?: string }>,
  // ── A4 settings transports (API Keys, Support, Runtime region, Guardrails).
  // MAIN-process SDK client executes these; reads REJECT, writes answer
  // { ok, …, error }. help/settings-*.ts mirror these + own the web SDK path. ──
  apiKeysList: () => ipcRenderer.invoke("apikeys-list") as Promise<ApiKeyRow[]>,
  apiKeysCreate: (input: { label: string; expiresInDays?: number }) =>
    ipcRenderer.invoke("apikeys-create", input) as Promise<{ ok: boolean; created?: CreatedApiKeyRow; error?: string }>,
  apiKeysRevoke: (id: string) =>
    ipcRenderer.invoke("apikeys-revoke", id) as Promise<{ ok: boolean; error?: string }>,
  supportTickets: () => ipcRenderer.invoke("support-tickets") as Promise<SupportTicketRow[]>,
  supportThread: (id: string) => ipcRenderer.invoke("support-thread", id) as Promise<SupportThreadRow>,
  supportCreateTicket: (input: { subject: string; message: string }) =>
    ipcRenderer.invoke("support-create-ticket", input) as Promise<{ ok: boolean; thread?: SupportThreadRow; error?: string }>,
  supportReply: (id: string, body: string) =>
    ipcRenderer.invoke("support-reply", id, body) as Promise<{ ok: boolean; thread?: SupportThreadRow; error?: string }>,
  supportMarkRead: (id: string) =>
    ipcRenderer.invoke("support-mark-read", id) as Promise<{ ok: boolean; error?: string }>,
  orgInfraGet: () => ipcRenderer.invoke("account-org-infra") as Promise<OrgInfraRow>,
  orgChooseInfra: (choice: { region: string; tier: string }) =>
    ipcRenderer.invoke("account-org-choose-infra", choice) as Promise<{ ok: boolean; infra?: OrgInfraRow; error?: string }>,
  orgGuardrailsGet: () => ipcRenderer.invoke("account-org-guardrails") as Promise<GuardrailsRow>,
  orgGuardrailsSet: (policy: Record<string, number> | null) =>
    ipcRenderer.invoke("account-org-set-guardrails", policy) as Promise<{ ok: boolean; guardrails?: GuardrailsRow; error?: string }>,
  // AI Gateway — escalation models (org-governed), slicer usage, org governance.
  logout: () => ipcRenderer.invoke("logout") as Promise<void>,
  onBoot: (callback: (data: { authenticated: boolean; status: string; tier?: string; needsOnboarding: boolean; hideWelcome?: boolean; theme?: string }) => void) => {
    ipcRenderer.on("boot", (_event, data) => callback(data));
  },
  glyphhRun: (p: { chatId: string; attachments?: Array<{ kind: "image" | "file" | "folder"; path: string; name: string }>; workdir?: string; chat?: boolean; mode?: "chat" | "cowork" | "code"; permission?: "ask" | "plan" | "acceptEdits" | "auto" | "bypass"; source?: { kind: "cloud-new" } | { kind: "cloud-repo"; repo: string } | { kind: "local"; path: string; machineId?: string } }) =>
    ipcRenderer.invoke("glyphh-agent-run", p) as Promise<{ runId: string }>,
  glyphhPickAttachments: (mode?: "files" | "folder") =>
    ipcRenderer.invoke("glyphh-agent-pick-attachments", { mode }) as Promise<Array<{ kind: "image" | "file" | "folder"; path: string; name: string }>>,
  glyphhClassifyPaths: (paths: string[]) =>
    ipcRenderer.invoke("glyphh-agent-classify-paths", { paths }) as Promise<Array<{ kind: "image" | "file" | "folder"; path: string; name: string }>>,
  glyphhSaveClipboardImage: (bytes: ArrayBuffer) =>
    ipcRenderer.invoke("glyphh-agent-save-clipboard-image", { bytes }) as Promise<{ kind: "image"; path: string; name: string }>,
  glyphhSessionsLoad: () =>
    ipcRenderer.invoke("glyphh-agent-sessions-load") as Promise<{ chats: unknown[]; currentId: string }>,
  glyphhSessionsSave: (chats: unknown[], currentId: string) =>
    ipcRenderer.invoke("glyphh-agent-sessions-save", { chats, currentId }) as Promise<boolean>,
  // ── Server threads surface (thread-store.ts's desktop transport) — the
  // main-process SDK client executes these (threads-ipc.ts). ──
  threadsList: () =>
    ipcRenderer.invoke("glyphh-threads-list") as Promise<Array<{ id: string; title: string; mode: string; source: unknown; createdAt: number; updatedAt: number; messageCount: number }>>,
  threadsGet: (id: string) =>
    ipcRenderer.invoke("glyphh-threads-get", id) as Promise<{ id: string; title: string; mode: string; source: unknown; createdAt: number; updatedAt: number; messageCount: number; messages: unknown[] }>,
  threadsPush: (id: string, body: { title?: string; mode?: string; source?: unknown; messages?: unknown[]; updatedAt: number }) =>
    ipcRenderer.invoke("glyphh-threads-push", { id, body }) as Promise<{ applied: boolean; thread: { id: string; title: string; mode: string; source: unknown; createdAt: number; updatedAt: number; messageCount: number } }>,
  threadsDelete: (id: string) =>
    ipcRenderer.invoke("glyphh-threads-delete", id) as Promise<void>,
  // Another window (ghost overlay ↔ main app) saved the shared session store.
  onGlyphhSessionsUpdated: (callback: () => void) => {
    ipcRenderer.on("glyphh-sessions-updated", () => callback());
  },
  glyphhRemember: (fact: string) => ipcRenderer.invoke("glyphh-agent-remember", fact) as Promise<boolean>,
  glyphhCompact: (chatId: string, focus: string) =>
    ipcRenderer.invoke("glyphh-agent-compact", { chatId, focus }) as Promise<{ ok: boolean; reason?: string }>,
  adaRecall: (query: string, k?: number) =>
    ipcRenderer.invoke("ada-recall", { query, k }) as Promise<Array<{ content: string; score: number }>>,
  adaAsk: (op: unknown) => ipcRenderer.invoke("ada-ask", { op }) as Promise<{ ok: boolean; answer?: string; error?: string }>,
  adaStats: () => ipcRenderer.invoke("ada-stats") as Promise<{ thoughts: number; slots: number; keys: number }>,
  // ── Library: loops / skills / agents (SDK pass-throughs; {ok,data|error}) ──
  libraryLoopGet: (ref: string) => ipcRenderer.invoke("library-loop-get", ref) as Promise<LibEnvelope>,
  libraryLoopCreate: (input: unknown) => ipcRenderer.invoke("library-loop-create", input) as Promise<LibEnvelope>,
  libraryLoopUpdate: (ref: string, patch: unknown) => ipcRenderer.invoke("library-loop-update", ref, patch) as Promise<LibEnvelope>,
  libraryLoopDelete: (ref: string) => ipcRenderer.invoke("library-loop-delete", ref) as Promise<LibEnvelope>,
  librarySkillsList: () => ipcRenderer.invoke("library-skills-list") as Promise<LibEnvelope>,
  librarySkillGet: (ref: string) => ipcRenderer.invoke("library-skill-get", ref) as Promise<LibEnvelope>,
  librarySkillCreate: (input: unknown) => ipcRenderer.invoke("library-skill-create", input) as Promise<LibEnvelope>,
  librarySkillUpdate: (ref: string, patch: unknown) => ipcRenderer.invoke("library-skill-update", ref, patch) as Promise<LibEnvelope>,
  librarySkillDelete: (ref: string) => ipcRenderer.invoke("library-skill-delete", ref) as Promise<LibEnvelope>,
  libraryAgentsList: () => ipcRenderer.invoke("library-agents-list") as Promise<LibEnvelope>,
  libraryAgentGet: (ref: string) => ipcRenderer.invoke("library-agent-get", ref) as Promise<LibEnvelope>,
  libraryAgentCreate: (input: unknown) => ipcRenderer.invoke("library-agent-create", input) as Promise<LibEnvelope>,
  libraryAgentUpdate: (ref: string, patch: unknown) => ipcRenderer.invoke("library-agent-update", ref, patch) as Promise<LibEnvelope>,
  libraryAgentDelete: (ref: string) => ipcRenderer.invoke("library-agent-delete", ref) as Promise<LibEnvelope>,
  libraryAgentTasks: (ref: string) => ipcRenderer.invoke("library-agent-tasks", ref) as Promise<LibEnvelope>,
  libraryAgentTaskAdd: (ref: string, input: unknown) => ipcRenderer.invoke("library-agent-task-add", ref, input) as Promise<LibEnvelope>,
  libraryAgentTaskUpdate: (ref: string, taskId: string, patch: unknown) => ipcRenderer.invoke("library-agent-task-update", ref, taskId, patch) as Promise<LibEnvelope>,
  libraryAgentTaskRunNow: (ref: string, taskId: string) => ipcRenderer.invoke("library-agent-task-run-now", ref, taskId) as Promise<LibEnvelope>,
  libraryAgentTaskRuns: (ref: string, taskId: string) => ipcRenderer.invoke("library-agent-task-runs", ref, taskId) as Promise<LibEnvelope>,
  libraryAgentTaskRunning: (ref: string, taskId: string) => ipcRenderer.invoke("library-agent-task-running", ref, taskId) as Promise<LibEnvelope>,
  libraryAgentTaskDelete: (ref: string, taskId: string) => ipcRenderer.invoke("library-agent-task-delete", ref, taskId) as Promise<LibEnvelope>,
  // The loop decides the picker's shape: one slot → one dropdown, two → two.
  loopRoles: (loop: string, force?: boolean) =>
    ipcRenderer.invoke("loop-roles", { loop, force }) as Promise<{ ok: boolean; loop: string; roles: LoopRoleView[] }>,
  /** Bind a slot to a model, or pass null to hand it back to the loop's default. */
  loopRoleSet: (loop: string, role: string, modelId: string | null) =>
    ipcRenderer.invoke("loop-role-set", { loop, role, modelId }) as Promise<{ ok: boolean; loop: string; roles: LoopRoleView[] }>,
  /** Make a layout's loop active and bind its slot models (called on layout open). */
  loopApplyConfig: (loop: string | null, modelSelections?: Record<string, string>) =>
    ipcRenderer.invoke("loop-apply-config", { loop, modelSelections }) as Promise<{ ok: boolean; loop: string }>,
  /** Edit a loop's OWN default model for a role (writes manifest.roles[].default). */
  loopSetRoleDefault: (loopId: string, role: string, modelId: string | null) =>
    ipcRenderer.invoke("loop-set-role-default", { loopId, role, modelId }) as Promise<{ ok: boolean; error?: string }>,
  glyphhContextUsage: (chatId: string) =>
    ipcRenderer.invoke("glyphh-agent-context-usage", { chatId }) as Promise<{ tokens: number; budget: number; ratio: number; foldAt: number; lanes: Array<{ id: string; kind: "local" | "frontier"; tokens: number; budget: number; ratio: number; foldAt: number | null }> }>,
  glyphhStop: (chatId?: string) => ipcRenderer.invoke("glyphh-agent-stop", { chatId }) as Promise<boolean>,
  /** Change a DESKTOP-LOCAL run's permission mode mid-turn — main pushes it to the
   *  session's live pod so the gate re-evaluates. No live run → { updated: false }. */
  glyphhSetPermission: (chatId: string, permission: "ask" | "plan" | "acceptEdits" | "auto" | "bypass") =>
    ipcRenderer.invoke("glyphh-agent-set-permission", { chatId, permission }) as Promise<{ updated: boolean }>,
  onGlyphhAgentDelta: (callback: (d: { runId: string; delta: string }) => void) => {
    ipcRenderer.on("glyphh-agent:delta", (_event, d) => callback(d));
  },
  onGlyphhAgentDone: (callback: (d: { runId: string; stopped: boolean }) => void) => {
    ipcRenderer.on("glyphh-agent:done", (_event, d) => callback(d));
  },
  onGlyphhAgentError: (callback: (d: { runId: string; error: string }) => void) => {
    ipcRenderer.on("glyphh-agent:error", (_event, d) => callback(d));
  },
  onGlyphhAgentSetup: (callback: (d: { phase: string; pct?: number; model?: string; receivedGB?: number; totalGB?: number; text?: string; html?: string; label?: string }) => void) => {
    ipcRenderer.on("glyphh-agent:setup", (_event, d) => callback(d));
  },
  /** A run's live permission mode changed mid-flight (its own surface flipped it,
   *  or another surface pushed it) — repaint the mode chip for the affected chat. */
  onGlyphhAgentPermission: (callback: (d: { runId: string; permission: "ask" | "plan" | "acceptEdits" | "auto" | "bypass" }) => void) => {
    ipcRenderer.on("glyphh-agent:permission", (_event, d) => callback(d));
  },
  onGlyphhAgentCredits: (callback: (d: { runId: string; creditsMicro: number }) => void) => {
    ipcRenderer.on("glyphh-agent:credits", (_event, d) => callback(d));
  },
  onGlyphhAgentProgress: (callback: (d: { runId: string; inTokens: number; outTokens: number }) => void) => {
    ipcRenderer.on("glyphh-agent:progress", (_event, d) => callback(d));
  },
  onGlyphhAgentTool: (callback: (d: { runId: string; phase: string; name?: string; title?: string; thought?: string; denied?: boolean; failed?: boolean; preview?: string }) => void) => {
    ipcRenderer.on("glyphh-agent:tool", (_event, d) => callback(d));
  },
  glyphhApprovalRespond: (id: string, allow: boolean) =>
    ipcRenderer.invoke("glyphh-agent-approval-respond", { id, allow }) as Promise<boolean>,
  onGlyphhAgentApproval: (callback: (d: { id: string; kind: string; title: string; detail: string }) => void) => {
    ipcRenderer.on("glyphh-agent:approval", (_event, d) => callback(d));
  },
  glyphhAskRespond: (id: string, answers: string[]) =>
    ipcRenderer.invoke("glyphh-agent-ask-respond", { id, answers }) as Promise<boolean>,
  onGlyphhAgentAsk: (callback: (d: { id: string; questions: Array<{ question: string; options?: string[] }> }) => void) => {
    ipcRenderer.on("glyphh-agent:ask", (_event, d) => callback(d));
  },
  onThemeChanged: (callback: (theme: string) => void) => {
    ipcRenderer.on("theme-changed", (_event, theme) => callback(theme));
  },
  onShowOnboarding: (callback: () => void) => {
    ipcRenderer.on("show-onboarding", () => callback());
  },
  onAccountUpdated: (callback: (info: { email: string; firstName: string; lastName: string } | null) => void) => {
    ipcRenderer.on("account-updated", (_e, info) => callback(info));
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

  // Command execution (the command center routes through this)
  execCommand: (cmd: string) => ipcRenderer.invoke("exec-command", cmd) as Promise<string>,

  // Drip effects
  onDripEffect: (callback: (effect: string) => void) => {
    ipcRenderer.on("drip-effect", (_event, effect) => callback(effect));
  },

  // Theme
  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  exportGlyphhSkill: (provider: string) => ipcRenderer.invoke("export-glyphh-skill", provider) as Promise<{ ok: boolean; path?: string; error?: string }>,
  setTheme: (theme: string) => ipcRenderer.invoke("set-theme", theme),

  // Account info
  getAuthStatus: () => ipcRenderer.invoke("get-auth-status") as Promise<{ authenticated: boolean; status: string; tier?: string }>,
  refreshAuth: () => ipcRenderer.invoke("refresh-auth") as Promise<{ tier: string; status: string }>,
  openExternal: (url: string) => ipcRenderer.send("open-external", url),
  platformUrl: process.env.GLYPHH_PLATFORM_URL || "https://platform.glyphh.ai",
  serverUrl: process.env.GLYPHH_SERVER_URL || "https://api.glyphh.ai",
  discordInvite: process.env.GLYPHH_DISCORD_INVITE || "https://discord.gg/cHGZR764D",
  hasMcpAccess: () => ipcRenderer.invoke("has-mcp-access") as Promise<boolean>,
  openAccountDashboard: () => ipcRenderer.send("open-external", (process.env.GLYPHH_PLATFORM_URL || "https://platform.glyphh.ai")),
  openBilling: () => ipcRenderer.send("open-external", (process.env.GLYPHH_PLATFORM_URL || "https://platform.glyphh.ai") + "/billing"),
  // Support
  submitSupportTicket: (ticket: { subject: string; description: string }) =>
    ipcRenderer.invoke("submit-support-ticket", ticket) as Promise<{ ok: boolean; error?: string }>,

  // Recents (rich: app/layout + folder pairs)
  // Command-palette parity for the rail search — same global channels the
  // command overlay uses (registered in command-window.ts).
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
  onGlyphhAgentConnect: (cb: (p: { id: string; app: { appId: string; name: string; icon?: string | null } }) => void) => {
    const handler = (_e: unknown, p: { id: string; app: { appId: string; name: string; icon?: string | null } }) => cb(p);
    ipcRenderer.on("glyphh-agent:connect", handler);
    return () => { ipcRenderer.removeListener("glyphh-agent:connect", handler); };
  },
  glyphhAgentConnectRespond: (p: { id: string; connected: boolean; reason?: string }) =>
    ipcRenderer.invoke("glyphh-agent-connect-respond", p) as Promise<boolean>,
  connectorsDisconnect: (accountId: string) => ipcRenderer.invoke("connectors-disconnect", accountId) as Promise<boolean>,
  connectorsRefreshMcp: () => ipcRenderer.invoke("connectors-refresh-mcp") as Promise<{ ok: boolean; error?: string; toolCount: number }>,
  connectorsListTools: () => ipcRenderer.invoke("connectors-list-tools") as Promise<Array<{ slug: string; name: string; description: string }>>,
  onConnectorsChanged: (cb: () => void) => { ipcRenderer.on("connectors-changed", cb); },
  onConnectorsConnectProgress: (cb: (p: { phase: "verifying" | "done"; appSlug: string; ok?: boolean; error?: string }) => void) => {
    ipcRenderer.on("connectors-connect-progress", (_e, p) => cb(p));
  },

  // Apps registry live-reload — fired when ~/.glyphh/apps changes on disk so the
  // registry + picker refresh without a restart.

  // Auto-update
  onUpdateStatus: (cb: (info: { status: string; version?: string; percent?: number; error?: string }) => void) => {
    ipcRenderer.on("update-status", (_e, info) => cb(info));
  },
  updateInstall: () => ipcRenderer.send("update-install"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates") as Promise<string | null>,
  // Current pending update (null when none) — lets the About page show the
  // "Relaunch to Update" prompt on load, not only when a live event arrives.
  getUpdateStatus: () => ipcRenderer.invoke("get-update-status") as Promise<{ version: string; ready: boolean } | null>,

  // Remote relay — settings UI uses these. The JWT authenticates the WS,
  // so there's no client-token to manage; only the external (server) tokens
  // for the user's external tools.

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


  // Custom MCP connections — server-side rows; the server dials the MCP
  // endpoint, header values are write-only (never come back down).
  mcpCustomAllowed: () => ipcRenderer.invoke("mcp-custom-allowed") as Promise<{ allowed: boolean; reason?: string }>,
  mcpConnectionsList: () => ipcRenderer.invoke("mcp-connections-list") as Promise<{ ok: boolean; error?: string; connections: Array<{ slug: string; name: string; url: string; headerKeys: string[]; enabled: boolean; hiddenTools: string[]; createdAt: string; kind: "personal" | "org"; iconUrl: string | null }> }>,
  mcpConnectionsCatalog: () => ipcRenderer.invoke("mcp-connections-catalog") as Promise<{ ok: boolean; error?: string; connections: Array<{ slug: string; name: string; installed: boolean; iconUrl: string | null }> }>,
  mcpConnectionsInstall: (slug: string) => ipcRenderer.invoke("mcp-connections-install", slug) as Promise<{ ok: boolean; error?: string }>,
  mcpConnectionsCreate: (fields: { name: string; url: string; headers?: Record<string, string>; oauth?: { clientId: string; clientSecret?: string } }) => ipcRenderer.invoke("mcp-connections-create", fields) as Promise<{ ok: boolean; error?: string; connection?: { slug: string; name: string }; toolCount?: number }>,
  mcpConnectionsUpdate: (slug: string, fields: Record<string, unknown>) => ipcRenderer.invoke("mcp-connections-update", slug, fields) as Promise<{ ok: boolean; error?: string; connection?: unknown }>,
  mcpConnectionsDelete: (slug: string) => ipcRenderer.invoke("mcp-connections-delete", slug) as Promise<{ ok: boolean; error?: string }>,
  mcpConnectionsTools: (slug: string) => ipcRenderer.invoke("mcp-connections-tools", slug) as Promise<{ ok: boolean; error?: string; tools: Array<{ name: string; description: string; hidden: boolean }> }>,
  // Workbench apps — the OS-window replacement. The renderer reports its
  // open app panels; main drives open/close/focus/switcher via wb:app-cmd.
  wbAppsChanged: (apps: Array<{ slug: string; name: string }>) => ipcRenderer.send("wb-apps-changed", apps),
  wbLog: (msg: string) => ipcRenderer.send("wb-log", msg),
  onWbAppCommand: (cb: (cmd: { action: string; app?: { slug: string; name: string; url: string; glyphh?: boolean }; apps?: Array<{ slug: string; name: string; url: string; glyphh?: boolean }>; slug?: string; tool?: string; url?: string }) => void) => {
    ipcRenderer.on("wb:app-cmd", (_e, cmd) => cb(cmd));
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
  getCwdExplicit: () => ipcRenderer.invoke("working-dir:get-explicit"),
  pickCwd: (opts?: { asDefault?: boolean; nullOnCancel?: boolean }) => ipcRenderer.invoke("working-dir:pick", opts),
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
  searchFiles: (dir: string, query: string) =>
    ipcRenderer.invoke("files:search", dir, query) as Promise<{ entries: Array<{ name: string; rel: string; path: string; kind: "dir" | "file" }>; truncated?: boolean; error?: string }>,
  pickFile: () => ipcRenderer.invoke("files:pick-file") as Promise<string | null>,
  mkdir: (dirPath: string) => ipcRenderer.invoke("files:mkdir", dirPath) as Promise<{ ok: boolean; error?: string }>,
  deletePath: (target: string) => ipcRenderer.invoke("files:delete", target) as Promise<{ ok: boolean; error?: string }>,
  renamePath: (oldPath: string, newPath: string) => ipcRenderer.invoke("files:rename", oldPath, newPath) as Promise<{ ok: boolean; error?: string }>,
  platform: process.platform,
  previewNative: (filePath: string) =>
    ipcRenderer.invoke("files:preview-native", filePath) as Promise<{ ok: boolean; method?: string; error?: string }>,
  convertPreview: (filePath: string) =>
    ipcRenderer.invoke("files:convert-preview", filePath) as Promise<{ pdfPath?: string; error?: string }>,
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
