/**
 * Preload script — exposes IPC to the renderer safely.
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { LoopEffort } from "@glyphh/sdk/loop";

/** A Pipedream connect's progress (main/pipedream.ts PdConnectProgress). */
type PdProgress = { phase: "opening"; app: string } | { phase: "waiting"; app: string; url: string } | { phase: "done"; app: string; ok: true; account: { id: string; app: string; appName: string; icon: string | null; healthy: boolean; dead: boolean; createdAt: string } } | { phase: "done"; app: string; ok: false; error: string; cancelled?: boolean };

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
  /** The app's steered NEXT version — what the next build releases. */
  version?: string;
  secretNames?: string[];
  requiredConnections?: { slug: string; actAs: string; connected: boolean }[];
  /** The marketplace listing's uploaded icon (installed/built Glyphh apps). */
  iconUrl?: string | null;
  /** A local icon file (≤ 24 KB) as a data URL — main's org-apps row carries
   *  it so the web (relay rows) can draw art that lives on this machine. */
  iconDataUrl?: string;
  /** A URL tab's favicon URL, the one the desktop fetches (org-apps.ts). */
  faviconUrl?: string;
  connectionIds: string[];       // ids of first-class Connections this app uses
  mcp: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; oauth?: { clientId: string; hasSecret: boolean; tokenUrl: string; scope?: string }; enabled: boolean } | null;
  commands: Record<string, { selector: string; action: string; description?: string; text?: string }>;
  createdAt: string;
  updatedAt: string;
}

/** One day (or one hostname's totals) of apex-edge traffic. */
export interface EdgeTrafficDayRow {
  day: string;
  requests: number;
  bytesIn: number;
  bytesOut: number;
  avgMs: number;
  maxMs: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  blocked: number;
  offline?: number;
}

/** Telemetry rollups riding a traffic report (pages/referrers/engagement). */
export interface EdgeTelemetryRollups {
  topPages?: Array<{ path: string; views: number }>;
  topReferrers?: Array<{ refHost: string; views: number }>;
  topErrorPaths?: Array<{ path: string; hits: number }>;
  engagement?: { uniques: number; sessions: number; bounced: number; durationMsSum: number; viewsSum: number };
}

/** A skills/loops marketplace listing (free installs). */
export interface LibraryListingRow {
  id: string;
  kind: "skill" | "loop";
  slug: string;
  name: string;
  description: string;
  reviewStatus: string;
  reviewNotes: string | null;
  submittedAt: string;
  listedAt: string | null;
  installs: number;
  installed: boolean;
}

/** An open org-share submission (skills/loops) awaiting an admin. */
export interface LibraryShareRow {
  id: string;
  kind: "skill" | "loop";
  slug: string;
  name: string;
  requestedBy: string;
  submittedAt: string;
}

/** An org marketing link + its window stats. */
export interface MarketingLinkRow {
  id: string;
  code: string;
  name: string;
  targetUrl: string;
  url: string;
  appId: string | null;
  archived: boolean;
  createdAt: string;
  clicks: number;
  sessions: number;
  bounced: number;
  durationMsSum: number;
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
  /** Absolute path on this machine - artifacts are local files (2026-09-18). */
  path?: string;
  downloadUrl?: string;
}
export interface FileCreateInputRow {
  name: string;
  /** The starting text. Artifacts are local files now, not base64 uploads. */
  content?: string;
}

// The API Keys panel's rows (its channels are dead ends, agent-stubs.ts).
export interface ApiKeyRow { id: string; label: string; prefix: string; userId: string; userEmail: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null }
export interface CreatedApiKeyRow { key: ApiKeyRow; token: string }

// Fields the create/update calls forward to /api/panel-apps. Kept as a named
// type so preload + renderer stay in sync on the accepted keys.
/** One Chrome profile the import could read (name + counts, never contents). */
export interface ChromeProfileRow { dir: string; name: string; bookmarks: number; newBookmarks: number; cookieSites: number }
export interface ChromeImportOutcome {
  ok: boolean; tabsAdded: number; tabsSkipped: number; cookiesImported: number; cookiesFailed: number;
  cookieError?: string; error?: string;
}

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

// Marketplace wire shapes are the SDK CONTRACT (contract/apps.ts +
// contract/marketplace.ts), passed through marketplace-ipc.ts verbatim. The
// renderer's marketplace modules keep their own structural mirrors
// (help/marketplace-data.ts), so preload types the payloads loosely here —
// duplicating the whole contract in a third place buys nothing.

/** The `{ ok, data | error }` envelope Settings › Models answers in. */
type ModelsEnv<T> = { ok: true; data: T } | { ok: false; error: string };
/** The `{ ok, data | error }` envelope every library IPC handler returns. */
interface LibEnvelope { ok: boolean; data?: unknown; error?: string }
/** A notification as main/notify.ts hands it to the workbench (mirrors AppNotification). */
interface AppNotification { id?: string; app: string; title: string; body: string; source: "cloud" | "local"; slug?: string }
/** The library kinds a bundle can be: every one of them is a skill, the
 *  kind says which sort (his ruling, 2026-09-17). */
type SkillKind = "skill" | "app" | "plugin" | "task";


/** One model slot a loop declares, resolved for this caller — what a picker renders. */
interface VoiceSettingsView {
  inputModel: string | null;
  outputModel: string | null;
  voiceId: string | null;
  mode: "off" | "push-to-talk" | "continuous";
  autoplay: boolean;
}

interface LoopRoleView {
  name: string;
  label: string;
  description: string;
  modality?: string;
  modelId: string | null;
  /** The slot's model OVERRIDE (rides the agent's CLI as its -m). */
  model?: string | null;
  source: "selection" | "loop" | "platform" | "fallback" | "none";
  choices: Array<{
    id: string;
    name: string;
    providerSlug: string;
    modality?: string;
    contextWindow: number | null;
    maxOutputTokens: number | null;
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
    isPlatformDefault: boolean;
  }>;
}

/** Which sub-agent a frame came from; absent on the main agent's own. */
interface SubAgentRef { childId: string; slug: string; name: string; model: string }

// ── The loops: Glyphh's own and the vendor CLIs (main/cli-agents.ts) ──────────
type CliId = "glyphh" | "claude" | "codex" | "gemini" | "copilot" | "cursor";
type SessionPermission = "ask" | "plan" | "acceptEdits" | "auto";
/** direct = the CLI on its own login; gateway = the CLI on the local router. */
type CliRoute = "direct" | "gateway";
/** Where a CLI's route was chosen, most specific first; absent/null = no opinion. */
interface CliRouteHints { session?: boolean | null; cell?: boolean | null; layout?: boolean | null }
interface CliAgentRow {
  id: CliId; name: string; cli: CliId; cmd: string; model: string; mcp: boolean; cwd: string;
  session: "keep" | "new" | "last"; permission: "safe" | "ask" | "auto"; enabled: boolean; updatedAt?: string;
  /** The line a terminal plays with no overrides. */
  command: string;
  /** Runs unattended (task slots, schedules). */
  headless: boolean;
  /** The session modes the agent panel can honor on this loop. */
  modes: SessionPermission[];
  /** The router can carry it (Claude today). */
  gatewayCapable: boolean;
}
interface CliAgentPatch { id: CliId; cmd?: string; model?: string; mcp?: boolean; cwd?: string; session?: "keep" | "new" | "last"; permission?: "safe" | "ask" | "auto"; enabled?: boolean }
interface CliOpenOverrides { model?: string; cwd?: string; resume?: boolean | string; prompt?: string; light?: boolean; permission?: SessionPermission; route?: CliRouteHints }
interface MissingCli { cli: string; name: string; bin: string; install: string; login: string; note?: string }
interface CliSessionRow { id: string; cli: Exclude<CliId, "glyphh">; title: string; cwd: string; mtime: number }

contextBridge.exposeInMainWorld("glyphh", {
  copyToClipboard: (text: string) => ipcRenderer.invoke("copy-to-clipboard", text),
  // Toggle the full-screen command overlay (also bound to a global hotkey).
  // Resolve a dropped/selected File to its absolute on-disk path. Electron 32+
  // removed File.path; webUtils.getPathForFile is the supported replacement.
  getPathForFile: (file: File): string => { try { return webUtils.getPathForFile(file); } catch { return ""; } },
  windowClose: () => ipcRenderer.send("window-close"),
  // "Record this window" — capture the attached app's window as a PNG.
  agentDockCaptureTarget: () => ipcRenderer.invoke("agent-dock:capture-target") as Promise<{ ok: boolean; path?: string; proc?: string; error?: string }>,
  // The mic's OS-level permission (macOS TCC) + the door to its settings pane.
  micAccessStatus: () => ipcRenderer.invoke("mic-access-status") as Promise<{ status: string; error?: string }>,
  micOpenSettings: () => ipcRenderer.invoke("mic-open-settings") as Promise<{ ok: boolean }>,
  /** The menu's ⌘W — the workbench closes the top panel first, and only
   *  falls back to windowClose when nothing is open. */
  onCloseGesture: (cb: () => void) => { ipcRenderer.on("close-gesture", () => cb()); },
  // Fired once the server prefs map is warm (after auth), so pref-driven UI that
  // booted before the fetch (the agent anchor, theme) can RE-APPLY the saved value.
  onPrefsReady: (cb: () => void) => { ipcRenderer.on("prefs-ready", () => cb()); },
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  gatewayMetrics: (opts?: { days?: number; workspaceId?: string }) => ipcRenderer.invoke("gateway-metrics", opts) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  workspaceProviderKeys: (id: string) => ipcRenderer.invoke("workspace-provider-keys", id) as Promise<{ ok: boolean; data?: unknown[]; error?: string }>,
  workspaceProviderKeySet: (id: string, slug: string, key: string) => ipcRenderer.invoke("workspace-provider-key-set", id, slug, key) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  workspaceProviderKeyClear: (id: string, slug: string) => ipcRenderer.invoke("workspace-provider-key-clear", id, slug) as Promise<{ ok: boolean; error?: string }>,
  gatewayKeysList: () => ipcRenderer.invoke("gateway-keys-list") as Promise<{ ok: boolean; data?: unknown[]; error?: string }>,
  gatewayKeysCreate: (input: { name: string; workspaceId: string; days?: number }) => ipcRenderer.invoke("gateway-keys-create", input) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  gatewayKeysRevoke: (id: string) => ipcRenderer.invoke("gateway-keys-revoke", id) as Promise<{ ok: boolean; error?: string }>,
  // Org-admin Models page (mirrors the platform's Configure → Models).
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
  layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean; config?: { url?: string; cmd?: string; keepAlive?: boolean; railMenu?: boolean; railRecents?: boolean; railLayouts?: boolean; railHideLeft?: boolean; railHideRight?: boolean; loop?: string; view?: "glyphh" | "cli"; folder?: string; model?: string; session?: "keep" | "new" | "last"; gateway?: "on" | "off"; type?: "work" | "code" } }>; folderMode?: "single" | "multi"; target?: "glyphh" | "desktop"; loop?: string | null; view?: "glyphh" | "cli" | null; modelSelections?: Record<string, string>; sessionMode?: "keep" | "new" | "last"; type?: "work" | "code" | null; gateway?: "on" | "off" | null; folder?: string | null; space?: "chat" | "cowork" | "code" | null }) =>
    ipcRenderer.invoke("layouts-save-grid", grid) as Promise<boolean | { error: string }>,
  layoutsDelete: (name: string) => ipcRenderer.invoke("layouts-delete", name) as Promise<boolean | { error: string }>,
  pickDirectory: () => ipcRenderer.invoke("pick-directory") as Promise<string | null>,
  pickExecutable: () => ipcRenderer.invoke("pick-executable") as Promise<string | null>,

  // Workspace state — the drag/panel arrangement, sharded to
  // ~/.glyphh/workspaces/<id>/state.json (THE PURGE 2026-09-10)
  wsStateLoad: () => ipcRenderer.invoke("wsstate-load") as Promise<Record<string, { v: string; at: number }>>,
  wsStateSave: (snapshot: Record<string, { v: string; at: number }>) => ipcRenderer.invoke("wsstate-save", snapshot) as Promise<boolean>,

  // Embeddings upgrade (Settings → Memory): the org's embedding models on the
  // gateway; memory itself rides the loop (main's memory.ts).
  memoryStats: () => ipcRenderer.invoke("memory-stats") as Promise<{ ok: boolean; turns?: number; chunks?: number; facts?: number }>,
  memoryClear: () => ipcRenderer.invoke("memory-clear") as Promise<{ ok: boolean; deleted?: number; error?: string }>,
  memoryTurnList: () => ipcRenderer.invoke("memory-turn-list") as Promise<{ ok: boolean; rows: Array<{ id: string; kind: string; section: string; title: string; text: string; at: string; folder: string; workspace: string; parts: number }>; error?: string }>,
  memoryTurnUpdate: (input: { source: string; title?: string; summary?: string; details: string[] }) => ipcRenderer.invoke("memory-turn-update", input) as Promise<{ ok: boolean; chunks?: number; error?: string }>,
  memoryCurateNow: () => ipcRenderer.invoke("memory-curate-now") as Promise<{ ok: boolean; error?: string }>,
  memoryTurnForget: (source: string) => ipcRenderer.invoke("memory-turn-forget", source) as Promise<{ ok: boolean; deleted?: number; error?: string }>,
  embeddingsConfigGet: () => ipcRenderer.invoke("embeddings-config-get") as Promise<{ ok: boolean; model: string; models: Array<{ id: string; name: string; providerSlug: string }> }>,
  embeddingsConfigSet: (input: { model?: string }) => ipcRenderer.invoke("embeddings-config-set", input) as Promise<{ ok: boolean; model?: string; error?: string }>,

  // Loops + skills (local library) — hand-create + schedules
  loopsCreate: (input: { name?: string }) => ipcRenderer.invoke("loops-create", input) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  skillsCreate: (input: { name?: string }) => ipcRenderer.invoke("skills-create", input) as Promise<{ ok: boolean; data?: unknown; error?: string }>,

  // Drips CRUD
  dripsList: () => ipcRenderer.invoke("drips-list") as Promise<Array<{ name: string; recipe: string }>>,
  dripsSave: (name: string, recipe: string) => ipcRenderer.invoke("drips-save", name, recipe) as Promise<string>,
  dripsDelete: (name: string) => ipcRenderer.invoke("drips-delete", name) as Promise<string>,
  dripsPreview: (recipe: string) => ipcRenderer.invoke("drips-preview", recipe) as Promise<string>,
  dripsBuiltinEffects: () => ipcRenderer.invoke("drips-builtin-effects") as Promise<Array<{ name: string; kind: "one-shot" | "loop" }>>,
  dripsStop: () => ipcRenderer.invoke("drips-stop") as Promise<string>,
  dripsRunning: () => ipcRenderer.invoke("drips-running") as Promise<string[]>,

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
  // Notifications (main/notify.ts): a cloud app's over the attach link or a
  // local app's from this host, met by the member's pref in the workbench;
  // what it decides to show comes back as the OS notification.
  onNotify: (cb: (n: AppNotification) => void) => {
    const h = (_e: unknown, n: AppNotification) => cb(n);
    ipcRenderer.on("notify:incoming", h);
    return () => { ipcRenderer.removeListener("notify:incoming", h); };
  },
  notifyShow: (n: AppNotification) => ipcRenderer.invoke("notify:show", n) as Promise<{ shown: boolean }>,
  notifyPrepare: () => ipcRenderer.invoke("notify:prepare") as Promise<boolean>,
  // Fires in every panel when a preference is changed anywhere — lets forms
  // (e.g. Settings → Agent Defaults) reflect a change made elsewhere live.
  /** The server's model list or the org's defaults moved (main/model-watch.ts). */
  onModelsChanged: (cb: (c: { models: { ok: boolean; source: string; models: Array<{ id: string; name: string; providerSlug: string; reasoning?: boolean; freePlan?: boolean; modality?: string; utility?: boolean; inputUsdPerMTok?: number; outputUsdPerMTok?: number }> }; defaultModel: string; gatewayOn: boolean; connectionsOn: boolean }) => void) => {
    const h = (_e: unknown, c: Parameters<typeof cb>[0]) => cb(c);
    ipcRenderer.on("models:changed", h);
    return () => { ipcRenderer.removeListener("models:changed", h); };
  },
  onPreferenceChanged: (cb: (key: string, value: unknown) => void) => {
    ipcRenderer.on("preference-changed", (_e, key, value) => cb(key, value));
  },
  onFocusInput: (callback: () => void) => {
    ipcRenderer.on("focus-command-input", () => callback());
  },

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

  // Marketplace — the left-rail storefront + detail + reviews + developer
  // profiles + platform-admin queues. Thin pass-throughs to marketplace-ipc.ts,
  // which returns the SDK contract shapes verbatim; the renderer's marketplace
  // modules own the (structurally mirrored) types, so these are typed loosely
  // on purpose — one contract, two copies (SDK + renderer), not three.
  mktBrowse: () => ipcRenderer.invoke("mkt-browse") as Promise<unknown>,
  mktDetail: (slug: string) => ipcRenderer.invoke("mkt-detail", slug) as Promise<unknown>,
  mktInstall: (slug: string) => ipcRenderer.invoke("mkt-install", slug) as Promise<unknown>,
  mktUninstall: (slug: string) => ipcRenderer.invoke("mkt-uninstall", slug) as Promise<unknown>,
  mktReviews: (slug: string, query?: { limit?: number; offset?: number }) =>
    ipcRenderer.invoke("mkt-reviews", slug, query) as Promise<unknown>,
  mktReviewPut: (slug: string, input: { stars: number; body?: string }) =>
    ipcRenderer.invoke("mkt-review-put", slug, input) as Promise<unknown>,
  mktReviewDelete: (slug: string) => ipcRenderer.invoke("mkt-review-delete", slug) as Promise<unknown>,
  mktReviewReport: (slug: string, reviewId: string, reason: string) =>
    ipcRenderer.invoke("mkt-review-report", slug, reviewId, reason) as Promise<unknown>,
  mktReviewRespond: (slug: string, reviewId: string, response: string) =>
    ipcRenderer.invoke("mkt-review-respond", slug, reviewId, response) as Promise<unknown>,
  mktReportApp: (slug: string, reason: string, detail?: string) =>
    ipcRenderer.invoke("mkt-report-app", slug, reason, detail) as Promise<unknown>,
  mktMyApps: () => ipcRenderer.invoke("mkt-my-apps") as Promise<unknown>,
  mktPricingSet: (slug: string, patch: unknown) => ipcRenderer.invoke("mkt-pricing-set", slug, patch) as Promise<unknown>,
  mktReleases: (slug: string) => ipcRenderer.invoke("mkt-releases", slug) as Promise<unknown>,
  mktReleaseSubmit: (slug: string, releaseId: string, note?: string) =>
    ipcRenderer.invoke("mkt-release-submit", slug, releaseId, note) as Promise<unknown>,
  mktDevMe: () => ipcRenderer.invoke("mkt-dev-me") as Promise<unknown>,
  mktDevGet: (handle: string) => ipcRenderer.invoke("mkt-dev-get", handle) as Promise<unknown>,
  mktDevCreate: (input: unknown) => ipcRenderer.invoke("mkt-dev-create", input) as Promise<unknown>,
  mktDevUpdate: (handle: string, patch: unknown) => ipcRenderer.invoke("mkt-dev-update", handle, patch) as Promise<unknown>,
  mktDevAvatar: (handle: string, bytes: ArrayBuffer) => ipcRenderer.invoke("mkt-dev-avatar", handle, bytes) as Promise<unknown>,
  mktDevReviews: (handle: string, query?: { limit?: number; offset?: number }) =>
    ipcRenderer.invoke("mkt-dev-reviews", handle, query) as Promise<unknown>,
  mktDevReviewPut: (handle: string, input: { stars: number; body?: string }) =>
    ipcRenderer.invoke("mkt-dev-review-put", handle, input) as Promise<unknown>,
  mktDevReviewDelete: (handle: string) => ipcRenderer.invoke("mkt-dev-review-delete", handle) as Promise<unknown>,
  mktDevReviewRespond: (handle: string, reviewId: string, response: string) =>
    ipcRenderer.invoke("mkt-dev-review-respond", handle, reviewId, response) as Promise<unknown>,
  mktDevReviewReport: (handle: string, reviewId: string, reason: string) =>
    ipcRenderer.invoke("mkt-dev-review-report", handle, reviewId, reason) as Promise<unknown>,
  mktAdminQueue: () => ipcRenderer.invoke("mkt-admin-queue") as Promise<unknown>,
  mktAdminSourceTree: (releaseId: string) =>
    ipcRenderer.invoke("mkt-admin-source-tree", releaseId) as Promise<{ files: Array<{ path: string; size: number }> }>,
  mktAdminSourceFile: (releaseId: string, path: string) =>
    ipcRenderer.invoke("mkt-admin-source-file", releaseId, path) as Promise<{ path: string; size: number; content: string }>,
  mktAdminReview: (releaseId: string, action: "begin" | "approve" | "reject", notes?: string, share?: boolean) =>
    ipcRenderer.invoke("mkt-admin-review", releaseId, action, notes, share) as Promise<unknown>,
  mktAdminReports: (status?: string) => ipcRenderer.invoke("mkt-admin-reports", status) as Promise<unknown>,
  mktAdminReportResolve: (reportId: string, status: string) =>
    ipcRenderer.invoke("mkt-admin-report-resolve", reportId, status) as Promise<unknown>,
  mktAdminFlaggedReviews: () => ipcRenderer.invoke("mkt-admin-flagged-reviews") as Promise<unknown>,
  mktAdminReviewModerate: (reviewId: string, action: "restore" | "remove") =>
    ipcRenderer.invoke("mkt-admin-review-moderate", reviewId, action) as Promise<unknown>,
  mktAdminDevFlagged: () => ipcRenderer.invoke("mkt-admin-dev-flagged") as Promise<unknown>,
  mktAdminDevModerate: (reviewId: string, action: "restore" | "remove") =>
    ipcRenderer.invoke("mkt-admin-dev-moderate", reviewId, action) as Promise<unknown>,
  mktAdminAppSearch: (q: string) =>
    ipcRenderer.invoke("mkt-admin-app-search", q) as Promise<{ apps: unknown[] }>,
  mktAdminSuspend: (slug: string, suspend: boolean, reason?: string) =>
    ipcRenderer.invoke("mkt-admin-suspend", slug, suspend, reason) as Promise<unknown>,
  // Developer program (M7) — Settings → Developer. Handle-scoped: a PROFILE
  // (org or personal) holds the program; payout config rides inside the state.
  mktProgramState: (handle: string) => ipcRenderer.invoke("mkt-program-state", handle) as Promise<unknown>,
  mktProgramEnroll: (handle: string, agreementVersion: string) =>
    ipcRenderer.invoke("mkt-program-enroll", handle, agreementVersion) as Promise<unknown>,
  mktPayoutConfigSet: (handle: string, patch: { stripeConnectAccountId?: string | null; payoutThresholdCredits?: number }) =>
    ipcRenderer.invoke("mkt-payout-config-set", handle, patch) as Promise<unknown>,
  mktStripeOnboarding: (handle: string) => ipcRenderer.invoke("mkt-stripe-onboarding", handle) as Promise<unknown>,
  mktEarnings: (handle: string, query?: { limit?: number; offset?: number }) =>
    ipcRenderer.invoke("mkt-earnings", handle, query) as Promise<unknown>,
  mktPayouts: (handle: string) => ipcRenderer.invoke("mkt-payouts", handle) as Promise<unknown>,

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
  // RPA: register/clear a panel's webContents id so main's rpa.* handlers
  // (attach + loopback MCP) can drive it.
  rpaRegister: (slug: string, wcId: number, opts?: { preview?: boolean }) => ipcRenderer.send("wb:rpa-register", slug, wcId, opts),
  rpaUnregister: (slug: string, opts?: { preview?: boolean }) => ipcRenderer.send("wb:rpa-unregister", slug, opts),
  // RPA ON A TAB (2026-10-07): the Tabs page's RPA tab drives the same doors
  // the agent's tools do — commands, pick, map, unmap, run, sequenceSave,
  // sequenceRemove, sequenceRun — on main's registry.
  rpaTab: (method: string, params: Record<string, unknown>) =>
    ipcRenderer.invoke("rpa-tab", method, params) as Promise<{ ok: boolean; result?: unknown; error?: string }>,
  // Installed real browsers — the app editor's Browser dropdown.
  // OS icon for a native app's executable / .app bundle (data URL, "" if none).
  appFileIcon: (execPath: string) => ipcRenderer.invoke("app-file-icon", execPath) as Promise<string>,
  // Favicon bytes as a data URL (main-process fetch — CORS-free) for WebGL.
  webIconFetch: (url: string) => ipcRenderer.invoke("web-icon-fetch", url) as Promise<string>,
  panelAppsList: () => ipcRenderer.invoke("panel-apps-list") as Promise<SavedPanelApp[]>,
  homeGotoSection: (section: string) => ipcRenderer.invoke("home-goto-section", section) as Promise<{ ok: boolean }>,
  onNewSessionGesture: (cb: () => void) => {
    ipcRenderer.on("home:new-session", () => cb());
  },
  onResetWorkspaceGesture: (cb: () => void) => {
    ipcRenderer.on("home:reset-workspace", () => cb());
  },
  onGotoSection: (cb: (section: string) => void) => {
    ipcRenderer.on("home:goto-section", (_e, section: string) => cb(section));
  },
  panelAppsCreate: (input: PanelAppInput) =>
    ipcRenderer.invoke("panel-apps-create", input) as Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>,
  panelAppsUpdate: (id: string, patch: PanelAppInput) =>
    ipcRenderer.invoke("panel-apps-update", id, patch) as Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>,
  panelAppsDelete: (id: string) => ipcRenderer.invoke("panel-apps-delete", id) as Promise<{ ok: boolean; error?: string }>,
  chromeImportScan: () =>
    ipcRenderer.invoke("chrome-import-scan") as Promise<{ ok: boolean; installed: boolean; cookiesSupported: boolean; profiles: ChromeProfileRow[]; error?: string }>,
  chromeImportRun: (opts: { profile?: string; cookies?: boolean }) =>
    ipcRenderer.invoke("chrome-import-run", opts) as Promise<ChromeImportOutcome>,
  // First-class Connections (connected accounts + per-connection tool exposure).
  loopsList: () =>
    ipcRenderer.invoke("loops-list") as Promise<{ ok: boolean; loops: Array<{ id: string; name: string; description: string; builtIn?: boolean }>; canBuild: boolean }>,
  /** What each tool may actually do — the one rule the runner uses too. */
  connToolModes: (appSlug: string, tools: string[]) =>
    ipcRenderer.invoke("conn-tool-modes", appSlug, tools) as Promise<{ ok: boolean; data?: Record<string, "allow" | "ask" | "never">; error?: string }>,
  // Marketplace listing — copy, images, and the list/unlist decision.
  appListingSet: (slug: string, patch: Record<string, unknown>) =>
    ipcRenderer.invoke("app-listing-set", slug, patch) as Promise<{ ok: boolean; error?: string }>,
  appListingImageAdd: (slug: string, kind: "icon" | "screenshot" | "video") =>
    ipcRenderer.invoke("app-listing-image-add", slug, kind) as Promise<{ ok: boolean; key?: string; error?: string }>,
  appListingImageRemove: (slug: string, key: string) =>
    ipcRenderer.invoke("app-listing-image-remove", slug, key) as Promise<{ ok: boolean; error?: string }>,
  appListingList: (slug: string, listed: boolean) =>
    ipcRenderer.invoke("app-listing-list", slug, listed) as Promise<{ ok: boolean; listed?: boolean; error?: string }>,
  // Edge traffic — the apex fleet's per-hostname stats (org-wide).
  orgDomainsTraffic: (days?: number, filter?: { host?: string; appId?: string }) =>
    ipcRenderer.invoke("org-domains-traffic", days, filter) as Promise<{ ok: boolean; days: EdgeTrafficDayRow[]; hosts: Array<EdgeTrafficDayRow & { hostname: string }>; error?: string } & EdgeTelemetryRollups>,
  // Marketing links (his order, 2026-09-02): campaign URLs + attribution stats.
  marketingLinks: (days?: number) =>
    ipcRenderer.invoke("marketing-links", days) as Promise<{ ok: boolean; links: MarketingLinkRow[]; error?: string }>,
  marketingLinkCreate: (input: { name: string; targetUrl: string; appId?: string }) =>
    ipcRenderer.invoke("marketing-link-create", input) as Promise<{ ok: boolean; link?: MarketingLinkRow; error?: string }>,
  marketingLinkUpdate: (id: string, patch: { name?: string; archived?: boolean }) =>
    ipcRenderer.invoke("marketing-link-update", id, patch) as Promise<{ ok: boolean; error?: string }>,
  marketingLinkDelete: (id: string) =>
    ipcRenderer.invoke("marketing-link-delete", id) as Promise<{ ok: boolean; error?: string }>,
  // Agency client orgs — workspaces the org creates and funds for its clients.
  orgClients: () =>
    ipcRenderer.invoke("org-clients") as Promise<{ ok: boolean; clients: Array<{ id: string; name: string; createdAt: string; creditsMicro: number; members: number; monthlyCapMicro: number; monthUsedMicro: number }>; error?: string }>,
  orgClientCreate: (name: string) =>
    ipcRenderer.invoke("org-client-create", name) as Promise<{ ok: boolean; id?: string; name?: string; error?: string }>,
  orgClientCap: (id: string, monthlyCapCredits: number) =>
    ipcRenderer.invoke("org-client-cap", id, monthlyCapCredits) as Promise<{ ok: boolean; error?: string }>,
  orgClientDetach: (id: string) =>
    ipcRenderer.invoke("org-client-detach", id) as Promise<{ ok: boolean; error?: string }>,
  // Library sharing + marketplace (skills + loops) — free installs, approvals.
  libraryShare: (kind: "skill" | "loop", ref: string) =>
    ipcRenderer.invoke("library-share", kind, ref) as Promise<{ ok: boolean; id?: string; status?: string; error?: string }>,
  libraryPublish: (kind: "skill" | "loop", ref: string) =>
    ipcRenderer.invoke("library-publish", kind, ref) as Promise<{ ok: boolean; id?: string; reviewStatus?: string; error?: string }>,
  libraryPending: () =>
    ipcRenderer.invoke("library-pending") as Promise<{ ok: boolean; pending: LibraryShareRow[]; error?: string }>,
  libraryShareReview: (id: string, action: "approve" | "reject") =>
    ipcRenderer.invoke("library-share-review", id, action) as Promise<{ ok: boolean; error?: string }>,
  libraryMarket: (kind?: "skill" | "loop") =>
    ipcRenderer.invoke("library-market", kind) as Promise<{ ok: boolean; listings: LibraryListingRow[]; org: Array<{ kind: string; slug: string; name: string; description: string }>; error?: string }>,
  libraryMarketInstall: (id: string) =>
    ipcRenderer.invoke("library-market-install", id) as Promise<{ ok: boolean; kind?: string; slug?: string; error?: string }>,
  libraryMarketUninstall: (id: string) =>
    ipcRenderer.invoke("library-market-uninstall", id) as Promise<{ ok: boolean; error?: string }>,
  libraryAdminQueue: () =>
    ipcRenderer.invoke("library-admin-queue") as Promise<{ ok: boolean; queue: Array<LibraryListingRow & { prompt: string; code: string; submittedBy: string | null }>; error?: string }>,
  libraryAdminReview: (id: string, action: "begin" | "approve" | "reject", notes?: string) =>
    ipcRenderer.invoke("library-admin-review", id, action, notes) as Promise<{ ok: boolean; error?: string }>,

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
  getAccountInfo: () => ipcRenderer.invoke("get-account-info") as Promise<{ email: string; firstName: string; lastName: string; role: string; orgName: string; tier: string; billingStatus: string; avatarUrl?: string; impersonatingOrgId?: string | null } | null>,
  // ── voice settings ──
  catalogModels: () => ipcRenderer.invoke("catalog-models") as Promise<Array<{ id: string; name: string; providerSlug: string; modality: string; active: boolean }>>,
  catalogVoices: (provider: string) => ipcRenderer.invoke("catalog-voices", provider) as Promise<Array<{ id: string; name: string; providerSlug: string; previewUrl?: string; category?: string }>>,
  /** The super admin's speech models (stt, tts, the tts voice) — the member's
   *  own voice settings fill from these when unset (2026-10-06). */
  voiceConfig: () => ipcRenderer.invoke("voice-config") as Promise<{ stt: string | null; tts: string | null; voice: string | null }>,
  voiceSettingsGet: () => ipcRenderer.invoke("voice-settings-get") as Promise<VoiceSettingsView>,
  voiceSettingsSet: (patch: Partial<VoiceSettingsView>) => ipcRenderer.invoke("voice-settings-set", patch) as Promise<VoiceSettingsView>,
  voiceTranscribe: (audio: ArrayBuffer, mime: string, model: string, ms: number) => ipcRenderer.invoke("voice-transcribe", audio, mime, model, ms) as Promise<{ text: string }>,
  voiceSynthesize: (text: string, model: string, voiceId: string | null) => ipcRenderer.invoke("voice-synthesize", text, model, voiceId) as Promise<ArrayBuffer>,
  // Settings › Models (main/models-ipc.ts): providers, keys (sent once, shown masked), models and defaults.
  modelsPage: () => ipcRenderer.invoke("models-page") as Promise<ModelsEnv<unknown>>,
  modelsProviderSave: (input: { id?: string; kind: string; name?: string; baseUrl?: string; apiKey?: string; clearKey?: boolean }) =>
    ipcRenderer.invoke("models-provider-save", input) as Promise<ModelsEnv<unknown>>,
  modelsProviderRemove: (id: string) => ipcRenderer.invoke("models-provider-remove", id) as Promise<ModelsEnv<unknown>>,
  modelsProviderList: (id: string) => ipcRenderer.invoke("models-provider-list", id) as Promise<ModelsEnv<Array<{ model: string; type: string; added: boolean }>>>,
  modelsModelSave: (input: { provider: string; model: string; type: string; label?: string }) => ipcRenderer.invoke("models-model-save", input) as Promise<ModelsEnv<unknown>>,
  modelsModelRemove: (id: string) => ipcRenderer.invoke("models-model-remove", id) as Promise<ModelsEnv<unknown>>,
  modelsDefaultSet: (key: string, value: string) => ipcRenderer.invoke("models-default-set", key, value) as Promise<ModelsEnv<unknown>>,
  // ── Files artifact store (Files gallery) — the MAIN-process SDK client
  // executes these (files-ipc.ts). Reads REJECT on failure so the gallery shows
  // an honest error; create answers with { ok, file, error }. help/files.ts
  // mirrors these shapes and owns the web target's SDK-handle transport. ──
  filesList: () => ipcRenderer.invoke("files-list") as Promise<FileArtifactRow[]>,
  filesGet: (id: string) => ipcRenderer.invoke("files-get", id) as Promise<FileArtifactRow>,
  filesDelete: (id: string) => ipcRenderer.invoke("files-delete", id) as Promise<{ ok: boolean; error?: string }>,
  filesContent: (id: string) => ipcRenderer.invoke("files-content", id) as Promise<{ ok: boolean; content?: string; error?: string }>,
  filesCreate: (input: FileCreateInputRow) =>
    ipcRenderer.invoke("files-create", input) as Promise<{ ok: boolean; file?: FileArtifactRow; error?: string }>,
  filesPeek: (id: string) => ipcRenderer.invoke("files-peek", id) as Promise<string>,
  filesSave: (id: string, content: string) =>
    ipcRenderer.invoke("files-save", id, content) as Promise<{ ok: boolean; file?: FileArtifactRow; error?: string }>,
  filesRename: (id: string, name: string) =>
    ipcRenderer.invoke("files-rename", id, name) as Promise<{ ok: boolean; file?: FileArtifactRow; error?: string }>,
  // ── API Keys (dead ends in agent-stubs.ts). ──
  apiKeysList: () => ipcRenderer.invoke("apikeys-list") as Promise<ApiKeyRow[]>,
  apiKeysCreate: (input: { label: string; expiresInDays?: number }) =>
    ipcRenderer.invoke("apikeys-create", input) as Promise<{ ok: boolean; created?: CreatedApiKeyRow; error?: string }>,
  apiKeysRevoke: (id: string) =>
    ipcRenderer.invoke("apikeys-revoke", id) as Promise<{ ok: boolean; error?: string }>,
  // THE ARTIFACTS PANEL (his order, 2026-10-05): the desktop's transport to
  // the local artifacts and their comments (artifacts-ipc.ts; local only,
  // 2026-10-18) — every answer an { ok, data | error } envelope; the bytes
  // come back base64 so the viewer frames a blob URL.
  artifactsList: () => ipcRenderer.invoke("artifacts-list") as Promise<unknown>,
  artifactsGet: (id: string) => ipcRenderer.invoke("artifacts-get", id) as Promise<unknown>,
  artifactsContent: (id: string) => ipcRenderer.invoke("artifacts-content", id) as Promise<unknown>,
  artifactsUpdate: (id: string, patch: { name: string }) => ipcRenderer.invoke("artifacts-update", id, patch) as Promise<unknown>,
  artifactsDelete: (id: string) => ipcRenderer.invoke("artifacts-delete", id) as Promise<unknown>,
  artifactsCommentsList: (id: string) => ipcRenderer.invoke("artifacts-comments", id) as Promise<unknown>,
  artifactsCommentAdd: (id: string, input: { text: string; region?: unknown; parentId?: string; agent?: boolean }) => ipcRenderer.invoke("artifacts-comment-add", id, input) as Promise<unknown>,
  artifactsCommentPatch: (id: string, cid: string, patch: { resolved: boolean }) => ipcRenderer.invoke("artifacts-comment-patch", id, cid, patch) as Promise<unknown>,
  artifactsCommentDelete: (id: string, cid: string) => ipcRenderer.invoke("artifacts-comment-delete", id, cid) as Promise<unknown>,
  // AI Gateway — escalation models (org-governed), slicer usage, org governance.
  logout: () => ipcRenderer.invoke("logout") as Promise<void>,
  onBoot: (callback: (data: { authenticated: boolean; status: string; tier?: string; needsOnboarding: boolean; hideWelcome?: boolean; theme?: string }) => void) => {
    ipcRenderer.on("boot", (_event, data) => callback(data));
  },
  glyphhRun: (p: { chatId: string; attachments?: Array<{ kind: "image" | "file" | "folder"; path: string; name: string }>; workdir?: string; chat?: boolean; mode?: "work" | "code"; permission?: "ask" | "plan" | "acceptEdits" | "auto"; steer?: string; model?: string; loop?: string; cliSessionId?: string; route?: CliRouteHints; effort?: LoopEffort; source?: { kind: "cloud-new" } | { kind: "cloud-repo"; repo: string } | { kind: "local"; path: string; machineId?: string } }) =>
    ipcRenderer.invoke("glyphh-agent-run", p) as Promise<{ runId: string }>,
  // ── The chat ⇄ terminal hop: a chat's session on each CLI ──
  glyphhBindCliSession: (chatId: string, cliSessionId: string, cli?: string) =>
    ipcRenderer.invoke("glyphh-agent-bind-session", { chatId, cliSessionId, cli }) as Promise<boolean>,
  glyphhCliSessionOf: (chatId: string, cli?: string) =>
    ipcRenderer.invoke("glyphh-agent-session-of", { chatId, cli }) as Promise<string | null>,
  glyphhCliTranscript: (sessionId: string) =>
    ipcRenderer.invoke("glyphh-agent-transcript", { sessionId }) as Promise<{ ok: true; cli: Exclude<CliId, "glyphh">; title: string; cwd: string; turns: Array<{ role: "user" | "assistant"; text: string }> } | { ok: false; error: string }>,
  // ── The loops (main/cli-agents.ts) ──
  cliAgentsList: () =>
    ipcRenderer.invoke("cli-agents-list") as Promise<{ ok: boolean; agents: CliAgentRow[]; gatewayDefault?: boolean; gatewayReady?: boolean; error?: string }>,
  cliAgentsSave: (patch: CliAgentPatch) =>
    ipcRenderer.invoke("cli-agents-save", patch) as Promise<{ ok: boolean; agent?: CliAgentRow; error?: string }>,
  onCliAgentsChanged: (callback: (r: { enabled: CliId[] }) => void) => {
    const handler = (_e: unknown, r: { enabled?: CliId[] }) => callback({ enabled: Array.isArray(r?.enabled) ? r.enabled : [] });
    ipcRenderer.on("cli-agents-changed", handler);
    return () => { ipcRenderer.removeListener("cli-agents-changed", handler); };
  },
  cliAgentOpen: (id: CliId, overrides?: CliOpenOverrides) =>
    ipcRenderer.invoke("cli-agent-open", id, overrides) as Promise<{ ok: boolean; command?: string; name?: string; cwd?: string; route?: CliRoute; missing?: MissingCli; error?: string }>,
  cliSessionsList: (limit?: number) =>
    ipcRenderer.invoke("cli-sessions-list", { limit }) as Promise<{ ok: boolean; sessions: CliSessionRow[]; error?: string }>,
  cliSessionDelete: (id: string) =>
    ipcRenderer.invoke("cli-session-delete", id) as Promise<{ ok: boolean; error?: string }>,
  /** A CLI's own store changed (a turn typed in the CLI itself). Debounced in main. */
  onCliSessionsChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("cli-sessions-changed", handler);
    return () => { ipcRenderer.removeListener("cli-sessions-changed", handler); };
  },
  /** Which loops' binaries are not on the PATH, each with its install line (null = installed). */
  cliAgentsMissing: () =>
    ipcRenderer.invoke("cli-agents-missing") as Promise<{ ok: boolean; missing: Record<string, MissingCli | null>; error?: string }>,
  /** Open the system terminal on the command that signs a CLI back in. */
  cliLogin: (cli: string) =>
    ipcRenderer.invoke("cli-login", cli) as Promise<{ ok: true; data: { command: string } } | { ok: false; error: string }>,
  glyphhPickAttachments: (mode?: "files" | "folder") =>
    ipcRenderer.invoke("glyphh-agent-pick-attachments", { mode }) as Promise<Array<{ kind: "image" | "file" | "folder"; path: string; name: string }>>,
  glyphhClassifyPaths: (paths: string[]) =>
    ipcRenderer.invoke("glyphh-agent-classify-paths", { paths }) as Promise<Array<{ kind: "image" | "file" | "folder"; path: string; name: string }>>,
  glyphhSaveClipboardImage: (bytes: ArrayBuffer) =>
    ipcRenderer.invoke("glyphh-agent-save-clipboard-image", { bytes }) as Promise<{ kind: "image"; path: string; name: string }>,
  glyphhSessionsLoad: () =>
    ipcRenderer.invoke("glyphh-agent-sessions-load") as Promise<{ chats: unknown[]; currentId: string }>,
  glyphhSessionsSave: (chats: unknown[], currentId: string, deleted?: string[]) =>
    ipcRenderer.invoke("glyphh-agent-sessions-save", { chats, currentId, deleted }) as Promise<boolean>,
  // Another window (ghost overlay ↔ main app) saved the shared session store.
  onGlyphhSessionsUpdated: (callback: (info: { deleted: string[] }) => void) => {
    ipcRenderer.on("glyphh-sessions-updated", (_e, info?: { deleted?: string[] }) =>
      callback({ deleted: Array.isArray(info?.deleted) ? info.deleted : [] }));
  },
  glyphhRemember: (fact: string) => ipcRenderer.invoke("glyphh-agent-remember", fact) as Promise<boolean>,
  glyphhCompact: (chatId: string, focus: string, loop?: string) =>
    ipcRenderer.invoke("glyphh-agent-compact", { chatId, focus, loop }) as Promise<{ ok: boolean; reason?: string }>,
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
  tasksAgentsList: () => ipcRenderer.invoke("tasks-agents-list") as Promise<LibEnvelope>,
  // AGENTS (local-agents.ts) — the standing workforce. Distinct from the
  // tasks* lane above, which groups schedules by the LOOP that runs them.
  /** THE licensing read (SDK client.plans) — one place, every surface. */
  /** THE MODELS the agent can run — the org's own list, asked of the server
   *  (the loop id is vestigial: there is one loop). */
  loopModels: (loopId: string, force?: boolean) => ipcRenderer.invoke("loop-models", loopId, force) as Promise<{ ok: boolean; source: "gateway" | "none"; baseUrl: string | null; models: Array<{ id: string; name: string; providerSlug: string; reasoning?: boolean; freePlan?: boolean; modality?: string; utility?: boolean; inputUsdPerMTok?: number; outputUsdPerMTok?: number }>; error?: string }>,
  libraryAgentsList: () => ipcRenderer.invoke("library-agents-list") as Promise<LibEnvelope>,
  libraryAgentTasks: (ref: string) => ipcRenderer.invoke("library-agent-tasks", ref) as Promise<LibEnvelope>,
  libraryAgentTaskUpdate: (ref: string, taskId: string, patch: unknown) => ipcRenderer.invoke("library-agent-task-update", ref, taskId, patch) as Promise<LibEnvelope>,
  libraryAgentTaskRunNow: (ref: string, taskId: string) => ipcRenderer.invoke("library-agent-task-run-now", ref, taskId) as Promise<LibEnvelope>,
  libraryAgentTaskRuns: (ref: string, taskId: string) => ipcRenderer.invoke("library-agent-task-runs", ref, taskId) as Promise<LibEnvelope>,
  libraryAgentGet: (ref: string) => ipcRenderer.invoke("library-agent-get", ref) as Promise<LibEnvelope>,
  libraryAgentCreate: (input: unknown) => ipcRenderer.invoke("library-agent-create", input) as Promise<LibEnvelope>,
  libraryAgentUpdate: (ref: string, patch: unknown) => ipcRenderer.invoke("library-agent-update", ref, patch) as Promise<LibEnvelope>,
  libraryAgentDelete: (ref: string) => ipcRenderer.invoke("library-agent-delete", ref) as Promise<LibEnvelope>,
  tasksForAgent: (ref: string) => ipcRenderer.invoke("tasks-for-agent", ref) as Promise<LibEnvelope>,
  libraryAgentTaskAdd: (ref: string, input: unknown) => ipcRenderer.invoke("library-agent-task-add", ref, input) as Promise<LibEnvelope>,
  tasksSetEnabled: (ref: string, taskId: string, patch: unknown) => ipcRenderer.invoke("tasks-set-enabled", ref, taskId, patch) as Promise<LibEnvelope>,
  tasksRunNow: (ref: string, taskId: string) => ipcRenderer.invoke("tasks-run-now", ref, taskId) as Promise<LibEnvelope>,
  tasksRunList: (ref: string, taskId: string) => ipcRenderer.invoke("tasks-run-list", ref, taskId) as Promise<LibEnvelope>,
  // The AI Hub (the Marketplace rail item → the org's hub on the console, in a work panel).
  // SKILLS (2026-09-16): folders on disk, the Agent Skills standard.
  skillsList: (kind?: SkillKind | SkillKind[]) => ipcRenderer.invoke("skills-list", kind) as Promise<LibEnvelope>,
  // TASKS (2026-09-17): bundles the desktop runs itself (task-runner.ts) and the SCHEDULES lane over them.
  tasksSpecs: () => ipcRenderer.invoke("tasks-specs") as Promise<LibEnvelope>,
  taskSpec: (slug: string) => ipcRenderer.invoke("task-spec", slug) as Promise<LibEnvelope>,
  taskSlotSet: (slug: string, slot: string, agentId: string | null, lane?: { model?: string | null }) => ipcRenderer.invoke("task-slot-set", slug, slot, agentId, lane ?? {}) as Promise<LibEnvelope>,
  taskRun: (slug: string, input?: unknown) => ipcRenderer.invoke("task-run", slug, input) as Promise<LibEnvelope>,
  taskRuns: (slug: string) => ipcRenderer.invoke("task-runs", slug) as Promise<LibEnvelope>,
  taskRunGet: (id: string) => ipcRenderer.invoke("task-run-get", id) as Promise<LibEnvelope>,
  taskRunCancel: (id: string) => ipcRenderer.invoke("task-run-cancel", id) as Promise<LibEnvelope>,
  onTaskRunsChanged: (fn: () => void) => { const h = (): void => fn(); ipcRenderer.on("task-runs-changed", h); return () => ipcRenderer.removeListener("task-runs-changed", h); },
  schedulesList: () => ipcRenderer.invoke("schedules-list") as Promise<LibEnvelope>,
  scheduleSave: (input: unknown) => ipcRenderer.invoke("schedule-save", input) as Promise<LibEnvelope>,
  scheduleSetEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke("schedule-set-enabled", id, enabled) as Promise<LibEnvelope>,
  scheduleDelete: (id: string) => ipcRenderer.invoke("schedule-delete", id) as Promise<LibEnvelope>,
  scheduleRunNow: (id: string) => ipcRenderer.invoke("schedule-run-now", id) as Promise<{ ok: boolean; error?: string }>,
  scheduleRuns: (id: string) => ipcRenderer.invoke("schedule-runs", id) as Promise<LibEnvelope>,
  scheduleRecentRuns: () => ipcRenderer.invoke("schedule-recent-runs") as Promise<LibEnvelope>,
  skillCreate: (name: string, kind?: "skill" | "app" | "plugin" | "task") => ipcRenderer.invoke("skill-create", name, kind) as Promise<LibEnvelope>,
  skillsHome: (kind?: "skill" | "app" | "plugin" | "task") => ipcRenderer.invoke("skills-home", kind) as Promise<LibEnvelope>,
  skillImage: (id: string, rel: string) => ipcRenderer.invoke("skill-image", id, rel) as Promise<LibEnvelope>,
  skillImport: (kind?: "skill" | "app" | "plugin" | "task") => ipcRenderer.invoke("skill-import", kind) as Promise<LibEnvelope>,
  skillGet: (id: string) => ipcRenderer.invoke("skill-get", id) as Promise<LibEnvelope>,
  skillFileRead: (id: string, rel: string) => ipcRenderer.invoke("skill-file-read", id, rel) as Promise<LibEnvelope>,
  skillFileWrite: (id: string, rel: string, text: string) => ipcRenderer.invoke("skill-file-write", id, rel, text) as Promise<LibEnvelope>,
  /** A bundle's own agents (agents/*.md, or a task's slots) and what they run on. */
  skillAgents: (id: string) => ipcRenderer.invoke("skill-agents", id) as Promise<LibEnvelope>,
  skillAgentSet: (id: string, ref: string, patch: { loop?: string; model?: string }) =>
    ipcRenderer.invoke("skill-agent-set", id, ref, patch) as Promise<LibEnvelope>,
  skillSetEnabled: (id: string, on: boolean) => ipcRenderer.invoke("skill-set-enabled", id, on) as Promise<LibEnvelope>,
  skillDelete: (id: string, opts?: { purge?: boolean }) => ipcRenderer.invoke("skill-delete", id, opts ?? {}) as Promise<LibEnvelope>,
  skillReveal: (id: string) => ipcRenderer.invoke("skill-reveal", id) as Promise<LibEnvelope>,
  skillAdopt: (id: string) => ipcRenderer.invoke("skill-adopt", id) as Promise<LibEnvelope>,
  skillReplace: (id: string) => ipcRenderer.invoke("skill-replace", id) as Promise<LibEnvelope>,
  skillDownload: (id: string) => ipcRenderer.invoke("skill-download", id) as Promise<LibEnvelope>,
  runGet: (id: string) => ipcRenderer.invoke("run-get", id) as Promise<LibEnvelope>,
  libraryAgentTaskRunning: (ref: string, taskId: string) => ipcRenderer.invoke("library-agent-task-running", ref, taskId) as Promise<LibEnvelope>,
  libraryAgentTaskDelete: (ref: string, taskId: string) => ipcRenderer.invoke("library-agent-task-delete", ref, taskId) as Promise<LibEnvelope>,
  // The loop decides the picker's shape: one slot → one dropdown, two → two.
  loopRoles: (loop: string, force?: boolean, context?: "local" | "cloud") =>
    ipcRenderer.invoke("loop-roles", { loop, force, context }) as Promise<{ ok: boolean; loop: string; roles: LoopRoleView[] }>,
  /** Bind a slot to a model, or pass null to hand it back to the loop's default. */
  loopRoleSet: (loop: string, role: string, modelId: string | null) =>
    ipcRenderer.invoke("loop-role-set", { loop, role, modelId }) as Promise<{ ok: boolean; loop: string; roles: LoopRoleView[] }>,
  /** Make a layout's loop active and bind its slot models (called on layout open). */
  loopApplyConfig: (loop: string | null, modelSelections?: Record<string, string>) =>
    ipcRenderer.invoke("loop-apply-config", { loop, modelSelections }) as Promise<{ ok: boolean; loop: string }>,
  /** Edit a loop's OWN default model for a role (writes manifest.roles[].default). */
  loopSetRoleDefault: (loopId: string, role: string, modelId: string | null, model?: string | null) =>
    ipcRenderer.invoke("loop-set-role-default", { loopId, role, modelId, ...(model !== undefined ? { model } : {}) }) as Promise<{ ok: boolean; error?: string }>,
  glyphhContextUsage: (chatId: string) =>
    ipcRenderer.invoke("glyphh-agent-context-usage", { chatId }) as Promise<{ tokens: number; budget: number; ratio: number; foldAt: number; lanes: Array<{ id: string; kind: "local" | "frontier"; tokens: number; budget: number; ratio: number; foldAt: number | null }> }>,
  glyphhStop: (chatId?: string) => ipcRenderer.invoke("glyphh-agent-stop", { chatId }) as Promise<boolean>,
  /** Every chat with a turn running ANYWHERE in this app (agent-live.ts) —
   *  cold read, then pushed on every change. The rail pulses by it. */
  glyphhLiveList: () =>
    ipcRenderer.invoke("glyphh-agent-live-list") as Promise<Array<{ chatId: string; cliSessionId: string | null; cli: string; runId: string; senderId: number; startedAt: number }>>,
  /** Take over a chat's running turn from the panel that started it (agent-live.ts). */
  glyphhRunAdopt: (chatId: string, opts?: { orphanOnly?: boolean }) =>
    ipcRenderer.invoke("glyphh-agent-run-adopt", { chatId, orphanOnly: !!opts?.orphanOnly }) as Promise<{ ok: false } | { ok: true; runId: string; cliSessionId: string | null; cli: string; startedAt: number; text: string }>,
  /** Another panel took this run over — let go of it here (no message is written). */
  onGlyphhAgentHandoff: (callback: (d: { runId: string; chatId: string }) => void) => {
    ipcRenderer.on("glyphh-agent:handoff", (_event, d) => callback(d));
  },
  onGlyphhLive: (callback: (runs: Array<{ chatId: string; cliSessionId: string | null; cli: string; runId: string; senderId: number; startedAt: number }>) => void) => {
    ipcRenderer.on("glyphh-agent:live", (_event, runs) => callback(Array.isArray(runs) ? runs : []));
  },
  /** A solo agent panel asks the shell for ANOTHER agent panel (a webview
   *  never nests one) — main relays it to the host document. */
  agentPanelOpen: (p: { loop?: string }) => ipcRenderer.invoke("agent-panel-open", p) as Promise<boolean>,
  /** A solo agent panel asks the shell to close ITS card (the session stays in the recents). */
  agentPanelClose: () => ipcRenderer.invoke("agent-panel-close") as Promise<boolean>,
  onAgentPanelClose: (callback: (p: { wcId: number }) => void) => {
    ipcRenderer.on("agent-panel:close", (_event, p) => callback(p));
  },
  onAgentPanelOpen: (callback: (p: { loop?: string }) => void) => {
    ipcRenderer.on("agent-panel:open", (_event, p) => callback(p ?? {}));
  },
  /** This panel became the one being worked in (or, from the shell, the panel with that webContents id). */
  agentPanelActivate: (p?: { wcId?: number }) => ipcRenderer.invoke("agent-panel-activate", p ?? {}) as Promise<boolean>,
  /** A solo panel asks the shell to open a workbench tool beside it. */
  agentPanelOpenTool: (p: { view: string; cwd?: string }) => ipcRenderer.invoke("agent-panel-open-tool", p) as Promise<boolean>,
  /** The shell says how far this panel's top row must clear the window controls (2026-10-09). */
  onAgentPanelClearStrip: (callback: (p: { px: number }) => void) => {
    ipcRenderer.on("agent-panel:clear-strip", (_event, p) => callback(p ?? { px: 0 }));
  },
  /** The panel's row drag acts on ITS card in the shell (2026-10-09). */
  agentPanelDrag: (p: { phase: "down" | "move" | "up"; cx: number; cy: number; sx: number; sy: number }) => ipcRenderer.send("agent-panel-drag", p),
  onAgentPanelDrag: (callback: (p: { wcId: number; phase: "down" | "move" | "up"; cx: number; cy: number; sx: number; sy: number }) => void) => {
    ipcRenderer.on("agent-panel:drag", (_event, p) => callback(p));
  },
  /** A panel's "Create workspace…" opens the SHELL's modal — the arrangement is the shell's. */
  agentPanelCreateWorkspace: () => ipcRenderer.invoke("agent-panel-create-workspace") as Promise<boolean>,
  onAgentPanelCreateWorkspace: (callback: () => void) => {
    ipcRenderer.on("agent-panel:create-workspace", () => callback());
  },
  /** A workspace a panel opens lands in the shell's grid, never inside the panel. */
  agentPanelOpenLayout: (p: { name: string }) => ipcRenderer.invoke("agent-panel-open-layout", p) as Promise<boolean>,
  onAgentPanelOpenLayout: (callback: (p: { name: string }) => void) => {
    ipcRenderer.on("agent-panel:open-layout", (_event, p) => callback(p ?? { name: "" }));
  },
  /** A file a panel opens goes to the shell's workbench, never inside the panel. */
  agentPanelOpenFile: (p: { path: string; mode?: "open" | "browse" | "edit" }) => ipcRenderer.invoke("agent-panel-open-file", p) as Promise<boolean>,
  agentPanelOpenSettings: (sub: string) => ipcRenderer.invoke("agent-panel-open-settings", { sub }) as Promise<boolean>,
  onAgentPanelOpenFile: (callback: (p: { path: string; mode?: "open" | "browse" | "edit" }) => void) => {
    ipcRenderer.on("agent-panel:open-file", (_event, p) => callback(p ?? { path: "" }));
  },
  onAgentPanelOpenTool: (callback: (p: { view: string; cwd?: string }) => void) => {
    ipcRenderer.on("agent-panel:open-tool", (_event, p) => callback(p ?? { view: "" }));
  },
  /** The host document steering THIS agent panel (webview.send): a rail
   *  session click, the Home composer's send, a fresh session. */
  onAgentPanelCommand: (callback: (cmd: unknown) => void) => {
    ipcRenderer.on("agent-panel:command", (_event, cmd) => callback(cmd));
  },
  /** Change a DESKTOP-LOCAL run's permission mode mid-turn — main pushes it to the
   *  session's live pod so the gate re-evaluates. No live run → { updated: false }. */
  glyphhSetPermission: (chatId: string, permission: "ask" | "plan" | "acceptEdits" | "auto") =>
    ipcRenderer.invoke("glyphh-agent-set-permission", { chatId, permission }) as Promise<{ updated: boolean }>,
  onGlyphhAgentDelta: (callback: (d: { runId: string; delta: string }) => void) => {
    ipcRenderer.on("glyphh-agent:delta", (_event, d) => callback(d));
  },
  /** The model's thinking, streamed (the loop's `thinking` deltas): the panel
   *  folds it above the answer. */
  onGlyphhAgentThinking: (callback: (d: { runId: string; text: string }) => void) => {
    ipcRenderer.on("glyphh-agent:thinking", (_event, d) => callback(d));
  },
  onGlyphhAgentDone: (callback: (d: { runId: string; stopped: boolean }) => void) => {
    ipcRenderer.on("glyphh-agent:done", (_event, d) => callback(d));
  },
  onGlyphhAgentError: (callback: (d: { runId: string; error: string; fix?: { kind: string; cli: string; command: string; message: string } }) => void) => {
    ipcRenderer.on("glyphh-agent:error", (_event, d) => callback(d));
  },
  onGlyphhAgentSetup: (callback: (d: { phase: string; chatId?: string; pct?: number; model?: string; receivedGB?: number; totalGB?: number; text?: string; html?: string; label?: string; cli?: string; route?: CliRoute; cliSessionId?: string }) => void) => {
    ipcRenderer.on("glyphh-agent:setup", (_event, d) => callback(d));
  },
  /** A run's live permission mode changed mid-flight (its own surface flipped it,
   *  or another surface pushed it) — repaint the mode chip for the affected chat. */
  onGlyphhAgentPermission: (callback: (d: { runId: string; permission: "ask" | "plan" | "acceptEdits" | "auto" }) => void) => {
    ipcRenderer.on("glyphh-agent:permission", (_event, d) => callback(d));
  },
  /** A run's running Pipedream spend, in dollars. */
  onGlyphhAgentCredits: (callback: (d: { runId: string; usd: number }) => void) => {
    ipcRenderer.on("glyphh-agent:credits", (_event, d) => callback(d));
  },
  onGlyphhAgentProgress: (callback: (d: { runId: string; inTokens: number; outTokens: number }) => void) => {
    ipcRenderer.on("glyphh-agent:progress", (_event, d) => callback(d));
  },
  onGlyphhAgentTool: (callback: (d: { runId: string; phase: string; name?: string; title?: string; thought?: string; denied?: boolean; failed?: boolean; preview?: string; agent?: SubAgentRef }) => void) => {
    ipcRenderer.on("glyphh-agent:tool", (_event, d) => callback(d));
  },
  /** A SUB-AGENT started or finished (his order, 2026-09-29: sub-agent swarms).
   *  Every other frame of a child's work — its deltas, its tool steps — arrives
   *  on the channel it always did, tagged with the same `agent` ref. */
  onGlyphhSubAgent: (callback: (d: { runId: string; phase: "start" | "done"; agent: SubAgentRef; task?: string; failed?: boolean; summary?: string }) => void) => {
    ipcRenderer.on("glyphh-agent:agent", (_event, d) => callback(d));
  },
  /** Write an agent's brief with AI, on the member's default model (agent-brief.ts). */
  /** A generated session title's model call (main/session-title.ts): the raw answer, or null. */
  sessionTitleGenerate: (body: { model: string; system: string; messages: Array<{ role: "user"; content: string }>; max_tokens: number; temperature: number }) =>
    ipcRenderer.invoke("session-title-generate", body) as Promise<string | null>,
  agentBriefGenerate: (input: { name?: string; description?: string; model?: string; draft?: string }) =>
    ipcRenderer.invoke("agent-brief-generate", input) as Promise<{ ok: true; brief: string; model: string } | { ok: false; error: string }>,
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
  onAccountUpdated: (callback: (info: { email: string; firstName: string; lastName: string; tier?: string; avatarUrl?: string } | null) => void) => {
    ipcRenderer.on("account-updated", (_e, info) => callback(info));
  },
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
  setTheme: (theme: string) => ipcRenderer.invoke("set-theme", theme),

  // Account info
  getAuthStatus: () => ipcRenderer.invoke("get-auth-status") as Promise<{ authenticated: boolean; status: string; tier?: string }>,
  refreshAuth: () => ipcRenderer.invoke("refresh-auth") as Promise<{ tier: string; status: string }>,
  openExternal: (url: string) => ipcRenderer.send("open-external", url),
  discordInvite: process.env.GLYPHH_DISCORD_INVITE || "https://discord.gg/P3yynv4v9",
  hasMcpAccess: () => ipcRenderer.invoke("has-mcp-access") as Promise<boolean>,

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
  onGlyphhAgentConnect: (cb: (p: { id: string; app: { appId: string; name: string; icon?: string | null } }) => void) => {
    const handler = (_e: unknown, p: { id: string; app: { appId: string; name: string; icon?: string | null } }) => cb(p);
    ipcRenderer.on("glyphh-agent:connect", handler);
    return () => { ipcRenderer.removeListener("glyphh-agent:connect", handler); };
  },
  glyphhAgentConnectRespond: (p: { id: string; connected: boolean; reason?: string }) =>
    ipcRenderer.invoke("glyphh-agent-connect-respond", p) as Promise<boolean>,

  // ── GitHub (desktop): clone a repo into an empty local folder ──
  gitCloneInto: (repo: string, dir: string) => ipcRenderer.invoke("git-clone-into", repo, dir) as Promise<{ ok: boolean; error?: string }>,

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


  // Custom MCP connections — local rows (main/mcp-connections.ts); this
  // machine dials the servers, header values are write-only (never come back).
  mcpCustomAllowed: () => ipcRenderer.invoke("mcp-custom-allowed") as Promise<{ allowed: boolean; reason?: string }>,
  mcpConnectionsList: () => ipcRenderer.invoke("mcp-connections-list") as Promise<{ ok: boolean; error?: string; connections: Array<{ slug: string; name: string; url: string; headerKeys: string[]; enabled: boolean; hiddenTools: string[]; createdAt: string; kind: "personal" | "org"; iconUrl: string | null }> }>,
  mcpConnectionsCreate: (fields: { name: string; url: string; headers?: Record<string, string>; oauth?: { clientId: string; clientSecret?: string } }) => ipcRenderer.invoke("mcp-connections-create", fields) as Promise<{ ok: boolean; error?: string; connection?: { slug: string; name: string }; toolCount?: number }>,
  mcpConnectionsUpdate: (slug: string, fields: Record<string, unknown>) => ipcRenderer.invoke("mcp-connections-update", slug, fields) as Promise<{ ok: boolean; error?: string; connection?: unknown }>,
  mcpConnectionsDelete: (slug: string) => ipcRenderer.invoke("mcp-connections-delete", slug) as Promise<{ ok: boolean; error?: string }>,
  mcpConnectionsTools: (slug: string) => ipcRenderer.invoke("mcp-connections-tools", slug) as Promise<{ ok: boolean; error?: string; tools: Array<{ name: string; description: string; hidden: boolean }> }>,
  // Pipedream on the user's own project (main/pipedream-ipc.ts): the secret
  // goes in, never comes back — the config view carries a masked hint only.
  pipedreamConfigGet: () => ipcRenderer.invoke("pipedream-config-get") as Promise<{ ok: true; data: { configured: boolean; projectId: string; environment: "development" | "production"; clientId: string; secretSet: boolean; secretHint: string } } | { ok: false; error: string }>,
  pipedreamConfigSet: (input: { projectId?: string; environment?: "development" | "production"; clientId?: string; clientSecret?: string }) => ipcRenderer.invoke("pipedream-config-set", input) as Promise<{ ok: true; data: { configured: boolean; projectId: string; environment: "development" | "production"; clientId: string; secretSet: boolean; secretHint: string } } | { ok: false; error: string }>,
  pipedreamConfigClear: () => ipcRenderer.invoke("pipedream-config-clear") as Promise<{ ok: true; data: { configured: boolean; projectId: string; environment: "development" | "production"; clientId: string; secretSet: boolean; secretHint: string } } | { ok: false; error: string }>,
  pipedreamTest: () => ipcRenderer.invoke("pipedream-test") as Promise<{ ok: true; data: { accounts: number } } | { ok: false; error: string }>,
  pipedreamApps: (o: { q?: string; after?: string; category?: string }) => ipcRenderer.invoke("pipedream-apps", o) as Promise<{ ok: true; data: { apps: Array<{ slug: string; name: string; icon: string | null; description: string; categories: string[] }>; next: string; total: number } } | { ok: false; error: string }>,
  pipedreamCategories: () => ipcRenderer.invoke("pipedream-categories") as Promise<{ ok: true; data: Array<{ id: string; name: string }> } | { ok: false; error: string }>,
  pipedreamAccounts: (refresh?: boolean) => ipcRenderer.invoke("pipedream-accounts", !!refresh) as Promise<{ ok: true; data: Array<{ id: string; app: string; appName: string; icon: string | null; healthy: boolean; dead: boolean; createdAt: string; enabled: boolean }> } | { ok: false; error: string }>,
  pipedreamConnect: (app: string) => ipcRenderer.invoke("pipedream-connect", app) as Promise<{ ok: true; data: Extract<PdProgress, { phase: "done" }> } | { ok: false; error: string }>,
  pipedreamConnectCancel: (app: string) => ipcRenderer.invoke("pipedream-connect-cancel", app) as Promise<{ ok: true; data: { cancelled: boolean } } | { ok: false; error: string }>,
  pipedreamDisconnect: (accountId: string) => ipcRenderer.invoke("pipedream-disconnect", accountId) as Promise<{ ok: true; data: Array<{ id: string; app: string; appName: string; icon: string | null; healthy: boolean; dead: boolean; createdAt: string; enabled: boolean }> } | { ok: false; error: string }>,
  pipedreamAppEnable: (app: string, on: boolean) => ipcRenderer.invoke("pipedream-app-enable", app, on) as Promise<{ ok: true; data: Array<{ id: string; app: string; appName: string; icon: string | null; healthy: boolean; dead: boolean; createdAt: string; enabled: boolean }> } | { ok: false; error: string }>,
  pipedreamTools: (app: string) => ipcRenderer.invoke("pipedream-tools", app) as Promise<{ ok: true; data: Array<{ name: string; description: string }> } | { ok: false; error: string }>,
  onPipedreamConnectProgress: (cb: (p: PdProgress) => void) => {
    const h = (_e: unknown, p: PdProgress) => cb(p);
    ipcRenderer.on("pipedream:connect-progress", h);
    return () => { ipcRenderer.removeListener("pipedream:connect-progress", h); };
  },
  onPipedreamChanged: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on("pipedream:changed", h);
    return () => { ipcRenderer.removeListener("pipedream:changed", h); };
  },
  // Workbench apps — the OS-window replacement. The renderer reports its
  // open app panels; main drives open/close/focus/switcher via wb:app-cmd.
  wbAppsChanged: (apps: Array<{ slug: string; name: string }>) => ipcRenderer.send("wb-apps-changed", apps),
  wbLog: (msg: string) => ipcRenderer.send("wb-log", msg),
  onWbAppCommand: (cb: (cmd: { action: string; app?: { slug: string; name: string; url: string; glyphh?: boolean }; apps?: Array<{ slug: string; name: string; url: string; glyphh?: boolean }>; slug?: string; tool?: string; url?: string; file?: string; title?: string }) => void) => {
    ipcRenderer.on("wb:app-cmd", (_e, cmd) => cb(cmd));
  },

  // Glyphh Office · Slides (the Slides panel's org deck library).
  gpointList: () => ipcRenderer.invoke("gpoint-list") as Promise<{ ok: boolean; decks: Array<{ file: string; title: string; slides: number; mtime: number; size: number }>; error?: string }>,
  gpointRead: (file: string) => ipcRenderer.invoke("gpoint-read", file) as Promise<{ ok: boolean; content?: string; error?: string }>,
  gpointDelete: (file: string) => ipcRenderer.invoke("gpoint-delete", file) as Promise<{ ok: boolean; error?: string }>,
  gpointNew: (name: string, title?: string) => ipcRenderer.invoke("gpoint-new", name, title) as Promise<{ ok: boolean; file?: string; title?: string; error?: string }>,
  gpointWrite: (file: string, html: string) => ipcRenderer.invoke("gpoint-write", file, html) as Promise<{ ok: boolean; error?: string }>,
  // Fired by main whenever a deck is written or deleted (agent tools, ＋ New,
  // in-panel surgery) — the Slides panel drops its cached copy and repaints.
  onGPointChanged: (callback: (file: string) => void) => { ipcRenderer.on("gpoint-changed", (_e, file: string) => callback(String(file))); },
  // Glyphh Office → PDF (slides page-per-slide, docs on Letter).
  officeExportPdf: (req: { kind: "slides" | "doc-html"; file?: string; title?: string; html?: string; print?: boolean }) => ipcRenderer.invoke("office-export-pdf", req) as Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>,
  // Glyphh Office · Docs (the Docs panel's org library).
  gdocList: () => ipcRenderer.invoke("gdoc-list") as Promise<{ ok: boolean; docs: Array<{ file: string; title: string; size: number; folderId: string | null; mtime: number }>; error?: string }>,
  gdocRead: (file: string) => ipcRenderer.invoke("gdoc-read", file) as Promise<{ ok: boolean; markdown?: string; title?: string; error?: string }>,
  gdocWrite: (file: string, markdown: string, folderId?: string | null) => ipcRenderer.invoke("gdoc-write", file, markdown, folderId) as Promise<{ ok: boolean; file?: string; title?: string; error?: string }>,
  gdocDelete: (file: string) => ipcRenderer.invoke("gdoc-delete", file) as Promise<{ ok: boolean; error?: string }>,
  gdocSuggestions: (file: string, status?: string) => ipcRenderer.invoke("gdoc-suggestions", file, status) as Promise<{ ok: boolean; suggestions: Array<{ id: string; file: string; section: string; beforeMd: string; afterMd: string; note: string; authorKind: string; status: string; createdAt: string }>; error?: string }>,
  gdocSuggest: (file: string, input: unknown) => ipcRenderer.invoke("gdoc-suggest", file, input) as Promise<{ ok: boolean; suggestion?: unknown; error?: string }>,
  gdocResolve: (id: string, approve: boolean) => ipcRenderer.invoke("gdoc-resolve", id, approve) as Promise<{ ok: boolean; suggestion?: { id: string; status: string }; error?: string }>,
  // Glyphh Office · Sheets (the Sheets panel's org workbook library).
  gsheetList: () => ipcRenderer.invoke("gsheet-list") as Promise<{ ok: boolean; sheets: Array<{ file: string; title: string; sheets: number; totalRows: number; size: number; folderId: string | null; mtime: number }>; error?: string }>,
  gsheetRead: (file: string) => ipcRenderer.invoke("gsheet-read", file) as Promise<{ ok: boolean; title?: string; workbook?: unknown; error?: string }>,
  gsheetWrite: (file: string, title: string, workbook: unknown) => ipcRenderer.invoke("gsheet-write", file, title, workbook) as Promise<{ ok: boolean; file?: string; title?: string; error?: string }>,
  gsheetDelete: (file: string) => ipcRenderer.invoke("gsheet-delete", file) as Promise<{ ok: boolean; error?: string }>,
  designList: () => ipcRenderer.invoke("design-list") as Promise<{ ok: boolean; designs: Array<{ file: string; title: string; size: number; mtime: number }>; error?: string }>,
  designRead: (file: string) => ipcRenderer.invoke("design-read", file) as Promise<{ ok: boolean; title?: string; document?: unknown; error?: string }>,
  designWrite: (file: string, document: unknown) => ipcRenderer.invoke("design-write", file, document) as Promise<{ ok: boolean; file?: string; title?: string; error?: string }>,
  designDelete: (file: string) => ipcRenderer.invoke("design-delete", file) as Promise<{ ok: boolean; error?: string }>,
  designAssetUpload: (file: string, input: unknown) => ipcRenderer.invoke("design-asset-upload", file, input) as Promise<{ ok: boolean; asset?: { id: string; kind: string; title: string; contentType: string; sizeBytes: number }; error?: string }>,
  designAssetUrl: (file: string, assetId: string) => ipcRenderer.invoke("design-asset-url", file, assetId) as Promise<{ ok: boolean; url?: string; error?: string }>,
  designAssetDelete: (file: string, assetId: string) => ipcRenderer.invoke("design-asset-delete", file, assetId) as Promise<{ ok: boolean; error?: string }>,
  memoryBrowse: (limit?: number) => ipcRenderer.invoke("memory-browse", limit) as Promise<{ ok: boolean; facts: unknown[]; error?: string }>,
  memoryGraph: (opts?: unknown) => ipcRenderer.invoke("memory-graph", opts) as Promise<{ ok: boolean; nodes: unknown[]; coords: Array<[number, number, number]>; edges: Array<{ a: number; b: number; sim: number; kind: string }>; error?: string }>,
  memorySearch: (query: string, topK?: number) => ipcRenderer.invoke("memory-search", query, topK) as Promise<{ ok: boolean; facts: unknown[]; error?: string }>,
  memoryForget: (id: string) => ipcRenderer.invoke("memory-forget", id) as Promise<{ ok: boolean; forgotten?: boolean; error?: string }>,
  memoryAmend: (input: unknown) => ipcRenderer.invoke("memory-amend", input) as Promise<{ ok: boolean; id?: string; supersedes?: string; error?: string }>,
  mediaList: (kind?: string, q?: string) => ipcRenderer.invoke("media-list", kind, q) as Promise<{ ok: boolean; assets: unknown[]; error?: string }>,
  mediaUrl: (id: string) => ipcRenderer.invoke("media-url", id) as Promise<{ ok: boolean; url?: string; error?: string }>,
  mediaThumbBytes: (id: string) => ipcRenderer.invoke("media-thumb-bytes", id) as Promise<{ ok: boolean; bytes?: Uint8Array; mime?: string; error?: string }>,
  mediaDelete: (id: string) => ipcRenderer.invoke("media-delete", id) as Promise<{ ok: boolean; error?: string }>,
  mediaGenerate: (input: unknown) => ipcRenderer.invoke("media-generate", input) as Promise<{ ok: boolean; job?: unknown; outputKind?: string; error?: string }>,
  mediaJob: (id: string) => ipcRenderer.invoke("media-job", id) as Promise<{ ok: boolean; job?: unknown; error?: string }>,
  mediaUploadPick: (kind?: string) => ipcRenderer.invoke("media-upload-pick", kind) as Promise<{ ok: boolean; id?: string; title?: string; error?: string }>,
  /** A file already on this machine joins a library (an image artifact → Images). */
  mediaUploadFile: (path: string, opts?: { title?: string; kind?: string }) => ipcRenderer.invoke("media-upload-file", path, opts) as Promise<{ ok: boolean; id?: string; title?: string; error?: string }>,
  mediaSave: (id: string) => ipcRenderer.invoke("media-save", id) as Promise<{ ok: boolean; path?: string; error?: string }>,
  gdriveList: (q?: string) => ipcRenderer.invoke("gdrive-list", q) as Promise<{ ok: boolean; folders: Array<{ id: string; name: string; parentId: string | null }>; files: Array<{ kind: string; ref: string; file?: string; title: string; sizeBytes: number; folderId: string | null; subkind?: string; mime?: string; updatedAt: string }>; error?: string }>,
  gdriveMkdir: (name: string, parentId?: string | null) => ipcRenderer.invoke("gdrive-mkdir", name, parentId) as Promise<{ ok: boolean; folder?: { id: string; name: string }; error?: string }>,
  gdriveMove: (kind: string, ref: string, folderId: string | null) => ipcRenderer.invoke("gdrive-move", kind, ref, folderId) as Promise<{ ok: boolean; error?: string }>,
  gdriveFolderRename: (id: string, name: string) => ipcRenderer.invoke("gdrive-folder-rename", id, name) as Promise<{ ok: boolean; error?: string }>,
  gdriveFolderDelete: (id: string) => ipcRenderer.invoke("gdrive-folder-delete", id) as Promise<{ ok: boolean; error?: string }>,
  gdocTemplates: () => ipcRenderer.invoke("gdoc-templates") as Promise<{ ok: boolean; templates: Array<{ slug: string; name: string; category: string; description: string; markdown: string }>; error?: string }>,
  // Pop a panel off the app into a standalone OS window (traffic lights).
  panelPopout: (req: { kind: "url" | "slides"; url?: string; file?: string; title?: string }) => ipcRenderer.invoke("panel-popout", req) as Promise<{ ok: boolean; error?: string }>,

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
type GitBranchesView = { isRepo: boolean; current?: string; branches: string[]; error?: string };
contextBridge.exposeInMainWorld("wb", {
  getCwd: () => ipcRenderer.invoke("working-dir:get"),
  getCwdExplicit: () => ipcRenderer.invoke("working-dir:get-explicit"),
  pickCwd: (opts?: { asDefault?: boolean; nullOnCancel?: boolean }) => ipcRenderer.invoke("working-dir:pick", opts),
  setCwd: (dir: string) => ipcRenderer.invoke("working-dir:set", dir),
  getCwdRecents: () => ipcRenderer.invoke("working-dir:recents"),
  gitInfo: (root: string) => ipcRenderer.invoke("files:git-info", root),
  // The branch chip: a refusal rejects with git's reason, said plainly.
  gitBranches: (root: string) => ipcRenderer.invoke("files:git-branches", root) as Promise<GitBranchesView>,
  gitSwitch: (root: string, branch: string) => ipcRenderer.invoke("files:git-switch", root, branch) as Promise<GitBranchesView>,
  gitCreateBranch: (root: string, name: string) => ipcRenderer.invoke("files:git-create-branch", root, name) as Promise<GitBranchesView>,
  gitInit: (root: string) => ipcRenderer.invoke("files:git-init", root) as Promise<GitBranchesView>,
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
  // Git state moved (.git/index or .git/HEAD written — commit/stage/checkout).
  // One coalesced signal per git operation; the Diff panel refreshes on it.
  onGitChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("workdir:git-changed", handler);
    return () => { ipcRenderer.removeListener("workdir:git-changed", handler); };
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
  // The R2 lane (glyphh-versioned apps): head→local unified diff + drift + history.
  r2Diff: () => ipcRenderer.invoke("files:r2-diff"),
  termSpawn: (termId: string, cwd: string, cols: number, rows: number, light?: boolean) =>
    ipcRenderer.send("wb-term:spawn", termId, cwd, cols, rows, light),
  termWrite: (termId: string, data: string) => ipcRenderer.send("wb-term:write", termId, data),
  termResize: (termId: string, cols: number, rows: number) =>
    ipcRenderer.send("wb-term:resize", termId, cols, rows),
  termKill: (termId: string) => ipcRenderer.send("wb-term:kill", termId),
  termAlive: (termId: string) => ipcRenderer.invoke("wb-term:alive", termId) as Promise<boolean>,
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
