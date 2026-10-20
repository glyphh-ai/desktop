/**
 * Renderer — the SHELL (index.html): splash, boot gate, onboarding, lockout,
 * and the update overlay. The whole workspace lives in the home.html
 * BrowserView layered above this page; the shell only shows through while
 * that view is detached (splash/onboarding/lockout/update handoff).
 */

// Section content (Apps/Layouts/Drips/Skills/Settings/About) lives in the
// home.html panel (home.ts).
import { showOnboarding } from "./onboarding.js";
import { initBootGate, webShowFirstRun, webEnterApp } from "./boot-gate-ui.js";
import { initDrip } from "./drip-ui.js";
import { installAutofillGuard } from "./autofill-guard.js";
import type { RoleView as LoopRoleView } from "./help/model-picker.js";
import type { LibEnvelope } from "./help/library-types.js";
import type { CliAgentPatch, CliAgentRow, CliId, CliOpenOverrides, CliRoute, CliRouteHints, CliSessionRow, CliTranscript, MissingCli } from "./help/cli-types.js";

/** The library kinds a bundle can be: every one of them is a skill, the kind
 *  says which sort (his ruling, 2026-09-17). */
type SkillKind = "skill" | "app" | "plugin" | "task";
/** A Pipedream connect's progress (main/pipedream.ts PdConnectProgress). */
type PdConnectProgress = { phase: "opening"; app: string } | { phase: "waiting"; app: string; url: string } | { phase: "done"; app: string; ok: true; account: { id: string; app: string; appName: string; icon: string | null; healthy: boolean; dead: boolean; createdAt: string } } | { phase: "done"; app: string; ok: false; error: string; cancelled?: boolean };
/** Settings → Remote control (mirrors main/remote-control.ts). */
type RemoteControlView = { enabled: boolean; folders: string[]; device: string; allowed: boolean; attached: boolean; refused?: string };

// Mirrors preload.ts's SavedPanelApp — duplicated rather than imported so
// the renderer program (ES2022 module tsconfig) never pulls preload.ts
// (CommonJS-targeted) into its compile graph, which previously caused
// build:renderer to silently re-emit dist/renderer/preload.js as an ESM
// file and break Electron's (CommonJS-only) preload loader.
type SavedPanelApp = {
  id: string;
  orgId: string;
  createdBy: string;
  name: string;
  slug: string;
  system: boolean;
  url: string | null;
  // Browser ↔ Native model (pivot-mcp) — see preload.ts SavedPanelApp.
  isBrowser?: boolean;
  execPath?: string | null;
  appArchetype?: string | null;
  launchConfig?: Record<string, unknown> | null;
  connectionIds: string[];
  mcp: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; oauth?: { clientId: string; hasSecret: boolean; tokenUrl: string; scope?: string }; enabled: boolean } | null;
  commands: Record<string, { selector: string; action: string; description?: string; text?: string }>;
  createdAt: string;
  updatedAt: string;
};

type Connection = {
  id: string; accountId: string; appSlug: string; appName: string;
  label: string | null; healthy: boolean; hiddenTools: string[]; createdAt: string;
  org?: boolean; shared?: boolean; connected?: boolean;
  // Governance, mirrored from preload.ts Connection.
  agentAllowed?: boolean; agentTools?: number; agentAvailable?: number;
};


// Marketplace wire shapes live in help/marketplace-data.ts (structural mirrors
// of the SDK contract); the marketplace modules reach their transport through
// their own typed casts, so nothing marketplace-shaped is declared globally.

// Mirrors preload.ts PanelAppInput — fields forwarded to /api/panel-apps.
/** Mirrors the server's OrgApp.listing — the marketplace record. */
type AppListingRecord = {
  title: string;
  tagline: string | null;
  category: string | null;
  body: string | null;
  iconUrl: string | null;
  screenshots: { url: string; caption: string }[];
  videoUrl: string | null;
  website: string | null;
  supportEmail: string | null;
  ratingAvg: number;
  ratingCount: number;
  listedAt: string | null;
};

type PanelAppInput = {
  name?: string;
  slug?: string;
  url?: string | null;
  isBrowser?: boolean;
  execPath?: string | null;
  appArchetype?: string | null;
  launchConfig?: Record<string, unknown> | null;
  access?: "public" | "members";
};

/** Mirrors preload.ts EdgeTrafficDayRow — apex-edge stats, one day or host. */
type EdgeTrafficDayRow = {
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
};

/** Mirrors preload.ts EdgeTelemetryRollups — pages/referrers/engagement. */
type EdgeTelemetryRollups = {
  topPages?: Array<{ path: string; views: number }>;
  topReferrers?: Array<{ refHost: string; views: number }>;
  topErrorPaths?: Array<{ path: string; hits: number }>;
  engagement?: { uniques: number; sessions: number; bounced: number; durationMsSum: number; viewsSum: number };
};

/** Mirrors preload.ts LibraryListingRow — a skills/loops marketplace listing. */
type LibraryListingRow = {
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
};

/** Mirrors preload.ts LibraryShareRow — an open org-share submission. */
type LibraryShareRow = {
  id: string;
  kind: "skill" | "loop";
  slug: string;
  name: string;
  requestedBy: string;
  submittedAt: string;
};

/** Mirrors preload.ts MarketingLinkRow — an org campaign link + window stats. */
type MarketingLinkRow = {
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
};

declare global {

  interface Window {
    glyphh: {
      copyToClipboard: (text: string) => void;
      getPathForFile: (file: File) => string;
      windowClose: () => void;
      /** A generated session title's model call (main/session-title.ts). */
      sessionTitleGenerate?: (body: { model: string; system: string; messages: Array<{ role: "user"; content: string }>; max_tokens: number; temperature: number }) => Promise<string | null>;
      // The live-run ledger and agent-panel steering (agent-live.ts).
      glyphhLiveList?: () => Promise<Array<{ chatId: string; cliSessionId: string | null; cli: string; runId: string; senderId: number; startedAt: number }>>;
      onGlyphhLive?: (callback: (runs: Array<{ chatId: string; cliSessionId: string | null; cli: string; runId: string; senderId: number; startedAt: number }>) => void) => void;
      agentPanelOpen?: (p: { loop?: string }) => Promise<boolean>;
      onAgentPanelOpen?: (callback: (p: { loop?: string }) => void) => void;
      agentPanelOpenTool?: (p: { view: string; cwd?: string }) => Promise<boolean>;
      agentPanelActivate?: (p?: { wcId?: number }) => Promise<boolean>;
      glyphhRunAdopt?: (chatId: string, opts?: { orphanOnly?: boolean }) => Promise<{ ok: false } | { ok: true; runId: string; cliSessionId: string | null; cli: string; startedAt: number; text: string }>;
      onGlyphhAgentHandoff?: (callback: (d: { runId: string; chatId: string }) => void) => void;
      onAgentPanelOpenTool?: (callback: (p: { view: string; cwd?: string }) => void) => void;
      onAgentPanelCommand?: (callback: (cmd: unknown) => void) => void;
      agentDockCaptureTarget?: () => Promise<{ ok: boolean; path?: string; proc?: string; error?: string }>;
      micAccessStatus?: () => Promise<{ status: string; error?: string }>;
      micOpenSettings?: () => Promise<{ ok: boolean }>;
      windowMinimize: () => void;
      windowMaximize: () => void;
      panelsHide: () => void;
      panelsShow: () => void;
      panelsRefresh: () => void;
      panelsZoom: (factor: number) => void;
      panelsGetZoom: () => Promise<number>;
      // Dashboard shell (5a): server-authoritative Apps tab CRUD — see
      // apps-ipc.ts's panel-apps-* handlers / saved-app-routes.ts.
      appFileIcon: (execPath: string) => Promise<string>;
      appLaunch: (spec: {
        slug: string; name: string; url?: string | null;
        isBrowser?: boolean;
        execPath?: string | null; appArchetype?: string | null;
        launchConfig?: Record<string, unknown> | null;
      }) => Promise<{ ok: boolean; error?: string }>;
      panelAppsList: () => Promise<SavedPanelApp[]>;
      homeGotoSection: (section: string) => Promise<{ ok: boolean }>;
      onGotoSection: (cb: (section: string) => void) => void;
      onPrefsReady: (cb: () => void) => void;
      panelAppsCreate: (input: PanelAppInput) => Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>;
      panelAppsUpdate: (id: string, patch: PanelAppInput) => Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>;
      panelAppsDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
      chromeImportScan: () => Promise<{ ok: boolean; installed: boolean; cookiesSupported: boolean; profiles: Array<{ dir: string; name: string; bookmarks: number; newBookmarks: number; cookieSites: number }>; error?: string }>;
      chromeImportRun: (opts: { profile?: string; cookies?: boolean }) => Promise<{ ok: boolean; tabsAdded: number; tabsSkipped: number; cookiesImported: number; cookiesFailed: number; cookieError?: string; error?: string }>;
      loopsList: () => Promise<{ ok: boolean; loops: Array<{ id: string; name: string; description: string; builtIn?: boolean }>; canBuild: boolean }>;
      appListingSet: (slug: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
      appListingImageAdd: (slug: string, kind: "icon" | "screenshot") => Promise<{ ok: boolean; key?: string; error?: string }>;
      appListingImageRemove: (slug: string, key: string) => Promise<{ ok: boolean; error?: string }>;
      appListingList: (slug: string, listed: boolean) => Promise<{ ok: boolean; listed?: boolean; error?: string }>;
      orgDomainsTraffic: (days?: number, filter?: { host?: string; appId?: string }) => Promise<{ ok: boolean; days: EdgeTrafficDayRow[]; hosts: Array<EdgeTrafficDayRow & { hostname: string }>; error?: string } & EdgeTelemetryRollups>;
      orgClients: () => Promise<{ ok: boolean; clients: Array<{ id: string; name: string; createdAt: string; creditsMicro: number; members: number; monthlyCapMicro: number; monthUsedMicro: number }>; error?: string }>;
      orgClientCreate: (name: string) => Promise<{ ok: boolean; id?: string; name?: string; error?: string }>;
      orgClientCap: (id: string, monthlyCapCredits: number) => Promise<{ ok: boolean; error?: string }>;
      orgClientDetach: (id: string) => Promise<{ ok: boolean; error?: string }>;
      libraryShare: (kind: "skill" | "loop", ref: string) => Promise<{ ok: boolean; id?: string; status?: string; error?: string }>;
      libraryPublish: (kind: "skill" | "loop", ref: string) => Promise<{ ok: boolean; id?: string; reviewStatus?: string; error?: string }>;
      libraryPending: () => Promise<{ ok: boolean; pending: LibraryShareRow[]; error?: string }>;
      libraryShareReview: (id: string, action: "approve" | "reject") => Promise<{ ok: boolean; error?: string }>;
      libraryMarket: (kind?: "skill" | "loop") => Promise<{ ok: boolean; listings: LibraryListingRow[]; org: Array<{ kind: string; slug: string; name: string; description: string }>; error?: string }>;
      libraryMarketInstall: (id: string) => Promise<{ ok: boolean; kind?: string; slug?: string; error?: string }>;
      libraryMarketUninstall: (id: string) => Promise<{ ok: boolean; error?: string }>;
      libraryAdminQueue: () => Promise<{ ok: boolean; queue: Array<LibraryListingRow & { prompt: string; code: string; submittedBy: string | null }>; error?: string }>;
      libraryAdminReview: (id: string, action: "begin" | "approve" | "reject", notes?: string) => Promise<{ ok: boolean; error?: string }>;
      marketingLinks: (days?: number) => Promise<{ ok: boolean; links: MarketingLinkRow[]; error?: string }>;
      marketingLinkCreate: (input: { name: string; targetUrl: string; appId?: string }) => Promise<{ ok: boolean; link?: MarketingLinkRow; error?: string }>;
      marketingLinkUpdate: (id: string, patch: { name?: string; archived?: boolean }) => Promise<{ ok: boolean; error?: string }>;
      marketingLinkDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;

      // Layouts
      layoutsList: () => Promise<Array<{ name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; loop?: string | null; modelSelections?: Record<string, string>; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean }> }>>;
      layoutsOpen: (name: string) => Promise<{ ok: boolean; error?: string }>;
      layoutsSave: (name: string, panelIds: string[]) => Promise<boolean>;
      layoutsPickFolder: () => Promise<string | null>;
      layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean; config?: { url?: string; cmd?: string; keepAlive?: boolean; railMenu?: boolean; railRecents?: boolean; railLayouts?: boolean; railHideLeft?: boolean; railHideRight?: boolean; loop?: string; view?: "glyphh" | "cli"; folder?: string; model?: string; session?: "keep" | "new" | "last"; gateway?: "on" | "off"; type?: "work" | "code" } }>; folderMode?: "single" | "multi"; target?: "glyphh" | "desktop"; loop?: string | null; view?: "glyphh" | "cli" | null; modelSelections?: Record<string, string>; sessionMode?: "keep" | "new" | "last"; type?: "work" | "code" | null; gateway?: "on" | "off" | null; folder?: string | null; space?: "chat" | "cowork" | "code" | null }) => Promise<boolean | { error: string }>;
      layoutsDelete: (name: string) => Promise<boolean | { error: string }>;
      pickDirectory: () => Promise<string | null>;
      pickExecutable: () => Promise<string | null>;
      // Session
      sessionInfo: () => Promise<{ hasContent: boolean; label: string; fileName: string }>;
      sessionClear: () => Promise<boolean>;
      onSessionChanged: (callback: (info: { hasContent: boolean; label: string; fileName: string }) => void) => void;
      // Preferences + boot
      relaunch: () => void;
      setPreference: (key: string, value: unknown) => void;
      getPreference: (key: string, defaultVal?: unknown) => Promise<unknown>;
      getBackgroundMode: () => Promise<boolean>;
      setBackgroundMode: (enabled: boolean) => Promise<boolean>;
      // Notifications (help/notify.ts): the host's door for one, and the OS/browser notification it asks for.
      onNotify?: (cb: (n: { id?: string; app: string; title: string; body: string; source: "cloud" | "local"; slug?: string }) => void) => () => void;
      notifyShow?: (n: { id?: string; app: string; title: string; body: string; source: "cloud" | "local"; slug?: string }) => Promise<{ shown: boolean }>;
      notifyPrepare?: () => Promise<boolean>;
      onPreferenceChanged: (cb: (key: string, value: unknown) => void) => void;
      onboardingComplete: () => Promise<void>;

      getAppVersion: () => Promise<string>;
      startAuth: (mode: "register" | "login") => Promise<boolean>;
      isAuthenticated: () => Promise<boolean>;
      startDeviceLogin: () => Promise<{ ok: boolean; error?: string }>;
      cancelDeviceLogin: () => Promise<{ ok: boolean }>;
      openDeviceApproval: (url: string) => Promise<{ ok: boolean }>;
      onDeviceLoginPrompt: (cb: (prompt: { userCode: string; verificationUri: string; verificationUriComplete?: string; expiresIn: number }) => void) => void;
      getAccountInfo: () => Promise<{ email: string; firstName: string; lastName: string; role: string; orgName: string; tier: string; billingStatus: string } | null>;
      logout: () => Promise<void>;
      onBoot: (callback: (data: { authenticated: boolean; status: string; tier?: string; needsOnboarding: boolean; hideWelcome?: boolean; theme?: string }) => void) => void;
      onThemeChanged: (callback: (theme: string) => void) => void;
      onAccountUpdated: (callback: (info: { email: string; firstName: string; lastName: string; tier?: string; avatarUrl?: string } | null) => void) => void;
      onFocusInput: (callback: () => void) => void;
      onPanelAppsChanged: (callback: () => void) => void;
      openInEditor: (filePath: string) => void;
      getWorkingDir: () => Promise<string | null>;
      pickWorkingDir: (opts?: { asDefault?: boolean }) => Promise<string | null>;
      setWorkingDir: (dir: string) => Promise<string>;
      gitInfo: (root: string) => Promise<{ isRepo: boolean; branch?: string; defaultBranch?: string }>;
      getWorkingDirRecents: () => Promise<string[]>;
      onWorkingDirChanged: (callback: (dir: string | null) => void) => void;
      // Command execution
      execCommand: (cmd: string) => Promise<string>;
      // Drip effects
      onDripEffect: (callback: (effect: string) => void) => void;
      // Drips CRUD
      dripsList: () => Promise<Array<{ name: string; recipe: string }>>;
      dripsSave: (name: string, recipe: string) => Promise<string>;
      dripsDelete: (name: string) => Promise<string>;
      dripsPreview: (recipe: string) => Promise<string>;
      dripsBuiltinEffects: () => Promise<Array<{ name: string; kind: "one-shot" | "loop" }>>;
      dripsStop: () => Promise<string>;
      dripsRunning: () => Promise<string[]>;
      // Theme
      getTheme: () => Promise<string>;
      setTheme: (theme: string) => Promise<void>;
      // Account info
      getAuthStatus: () => Promise<{ authenticated: boolean; status: string; tier?: string }>;
      refreshAuth: () => Promise<{ tier: string; status: string }>;
      openExternal: (url: string) => void;
      discordInvite: string;
      hasMcpAccess: () => Promise<boolean>;
      // Recents (rich)
      glyphhRun: (p: { chatId: string; attachments?: Array<{ kind: "image" | "file" | "folder"; path: string; name: string }>; workdir?: string; mode?: "work" | "code"; permission?: "ask" | "plan" | "acceptEdits" | "auto"; steer?: string; model?: string; loop?: string; cliSessionId?: string; route?: CliRouteHints; effort?: "low" | "medium" | "high" | "xhigh" | "max"; source?: unknown }) => Promise<{ runId: string }>;
      // The chat ⇄ terminal hop (agent-ipc.ts): a chat's session on each CLI.
      glyphhBindCliSession: (chatId: string, cliSessionId: string, cli?: string) => Promise<boolean>;
      glyphhCliSessionOf: (chatId: string, cli?: string) => Promise<string | null>;
      glyphhCliTranscript: (sessionId: string) => Promise<CliTranscript>;
      // The loops (cli-agents.ts).
      cliAgentsList: () => Promise<{ ok: boolean; agents: CliAgentRow[]; gatewayDefault?: boolean; gatewayReady?: boolean; error?: string }>;
      cliAgentsSave: (patch: CliAgentPatch) => Promise<{ ok: boolean; agent?: CliAgentRow; error?: string }>;
      onCliAgentsChanged: (callback: (r: { enabled: CliId[] }) => void) => () => void;
      cliAgentOpen: (id: CliId, overrides?: CliOpenOverrides) => Promise<{ ok: boolean; command?: string; name?: string; cwd?: string; route?: CliRoute; missing?: MissingCli; error?: string }>;
      cliSessionsList: (limit?: number) => Promise<{ ok: boolean; sessions: CliSessionRow[]; error?: string }>;
      cliSessionDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
      onCliSessionsChanged: (callback: () => void) => () => void;
      cliAgentsMissing: () => Promise<{ ok: boolean; missing: Record<string, MissingCli | null>; error?: string }>;
      cliLogin: (cli: string) => Promise<{ ok: true; data: { command: string } } | { ok: false; error: string }>;
      onGlyphhAgentConnect?: (cb: (p: { id: string; app: { appId: string; name: string; icon?: string | null } }) => void) => () => void;
      glyphhAgentConnectRespond?: (p: { id: string; connected: boolean; reason?: string }) => Promise<boolean>;
      glyphhPickAttachments: (mode?: "files" | "folder") => Promise<Array<{ kind: "image" | "file" | "folder"; path: string; name: string }>>;
      glyphhClassifyPaths: (paths: string[]) => Promise<Array<{ kind: "image" | "file" | "folder"; path: string; name: string }>>;
      glyphhSaveClipboardImage: (bytes: ArrayBuffer) => Promise<{ kind: "image"; path: string; name: string }>;
      glyphhSessionsLoad: () => Promise<{ chats: unknown[]; currentId: string }>;
      glyphhSessionsSave: (chats: unknown[], currentId: string, deleted?: string[]) => Promise<boolean>;
      glyphhRemember: (fact: string) => Promise<boolean>;
      libraryLoopGet: (ref: string) => Promise<LibEnvelope>;
      libraryLoopCreate: (input: unknown) => Promise<LibEnvelope>;
      libraryLoopUpdate: (ref: string, patch: unknown) => Promise<LibEnvelope>;
      libraryLoopDelete: (ref: string) => Promise<LibEnvelope>;
      librarySkillsList: () => Promise<LibEnvelope>;
      librarySkillGet: (ref: string) => Promise<LibEnvelope>;
      librarySkillCreate: (input: unknown) => Promise<LibEnvelope>;
      librarySkillUpdate: (ref: string, patch: unknown) => Promise<LibEnvelope>;
      skillsList: (kind?: SkillKind | SkillKind[]) => Promise<LibEnvelope>;
      skillCreate: (name: string, kind?: "skill" | "app" | "plugin" | "task") => Promise<LibEnvelope>;
      skillsHome: (kind?: "skill" | "app" | "plugin" | "task") => Promise<LibEnvelope>;
      skillImage: (id: string, rel: string) => Promise<LibEnvelope>;
      skillImport: (kind?: "skill" | "app" | "plugin" | "task") => Promise<LibEnvelope>;
      skillGet: (id: string) => Promise<LibEnvelope>;
      skillFileRead: (id: string, rel: string) => Promise<LibEnvelope>;
      skillFileWrite: (id: string, rel: string, text: string) => Promise<LibEnvelope>;
      connToolModes?: (appSlug: string, tools: string[]) => Promise<{ ok: boolean; data?: Record<string, "allow" | "ask" | "never">; error?: string }>;
      skillAgents: (id: string) => Promise<LibEnvelope>;
      skillAgentSet: (id: string, ref: string, patch: { loop?: string; model?: string }) => Promise<LibEnvelope>;
      skillSetEnabled: (id: string, on: boolean) => Promise<LibEnvelope>;
      skillDelete: (id: string, opts?: { purge?: boolean }) => Promise<LibEnvelope>;
      skillReveal: (id: string) => Promise<LibEnvelope>;
      skillAdopt: (id: string) => Promise<LibEnvelope>;
      skillReplace: (id: string) => Promise<LibEnvelope>;
      skillDownload: (id: string) => Promise<LibEnvelope>;
      tasksSpecs: () => Promise<LibEnvelope>;
      taskSpec: (slug: string) => Promise<LibEnvelope>;
      taskSlotSet: (slug: string, slot: string, agentId: string | null, lane?: { model?: string | null }) => Promise<LibEnvelope>;
      taskRun: (slug: string, input?: unknown) => Promise<LibEnvelope>;
      taskRuns: (slug: string) => Promise<LibEnvelope>;
      taskRunGet: (id: string) => Promise<LibEnvelope>;
      taskRunCancel: (id: string) => Promise<LibEnvelope>;
      onTaskRunsChanged: (fn: () => void) => () => void;
      schedulesList: () => Promise<LibEnvelope>;
      scheduleSave: (input: unknown) => Promise<LibEnvelope>;
      scheduleSetEnabled: (id: string, enabled: boolean) => Promise<LibEnvelope>;
      scheduleDelete: (id: string) => Promise<LibEnvelope>;
      scheduleRunNow: (id: string) => Promise<{ ok: boolean; error?: string }>;
      scheduleRuns: (id: string) => Promise<LibEnvelope>;
      scheduleRecentRuns: () => Promise<LibEnvelope>;
      librarySkillDelete: (ref: string) => Promise<LibEnvelope>;
      tasksAgentsList: () => Promise<LibEnvelope>;
      loopModels: (loopId: string, force?: boolean) => Promise<{ ok: boolean; source: "gateway" | "none"; baseUrl: string | null; models: Array<{ id: string; name: string; providerSlug: string; reasoning?: boolean; freePlan?: boolean }>; error?: string }>;
      libraryAgentsList: () => Promise<LibEnvelope>;
      libraryAgentTasks: (ref: string) => Promise<LibEnvelope>;
      libraryAgentTaskUpdate: (ref: string, taskId: string, patch: unknown) => Promise<LibEnvelope>;
      libraryAgentTaskRunNow: (ref: string, taskId: string) => Promise<LibEnvelope>;
      libraryAgentTaskRuns: (ref: string, taskId: string) => Promise<LibEnvelope>;
      libraryAgentGet: (ref: string) => Promise<LibEnvelope>;
      libraryAgentCreate: (input: unknown) => Promise<LibEnvelope>;
      libraryAgentUpdate: (ref: string, patch: unknown) => Promise<LibEnvelope>;
      libraryAgentDelete: (ref: string) => Promise<LibEnvelope>;
      tasksForAgent: (ref: string) => Promise<LibEnvelope>;
      libraryAgentTaskAdd: (ref: string, input: unknown) => Promise<LibEnvelope>;
      tasksSetEnabled: (ref: string, taskId: string, patch: unknown) => Promise<LibEnvelope>;
      tasksRunNow: (ref: string, taskId: string) => Promise<LibEnvelope>;
      tasksRunList: (ref: string, taskId: string) => Promise<LibEnvelope>;
      libraryAgentTaskRunning: (ref: string, taskId: string) => Promise<LibEnvelope>;
      libraryAgentTaskDelete: (ref: string, taskId: string) => Promise<LibEnvelope>;
      loopRoles: (loop: string, force?: boolean, context?: "local" | "cloud") => Promise<{ ok: boolean; loop: string; roles: LoopRoleView[] }>;
      loopRoleSet: (loop: string, role: string, modelId: string | null) => Promise<{ ok: boolean; loop: string; roles: LoopRoleView[] }>;
      gatewayMetrics: (opts?: { days?: number; workspaceId?: string }) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      workspaceProviderKeys: (id: string) => Promise<{ ok: boolean; data?: unknown[]; error?: string }>;
      workspaceProviderKeySet: (id: string, slug: string, key: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      workspaceProviderKeyClear: (id: string, slug: string) => Promise<{ ok: boolean; error?: string }>;
      gatewayKeysList: () => Promise<{ ok: boolean; data?: unknown[]; error?: string }>;
      gatewayKeysCreate: (input: { name: string; workspaceId: string; days?: number }) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      gatewayKeysRevoke: (id: string) => Promise<{ ok: boolean; error?: string }>;
      // @-mention summon (ghost overlay): alias lookup + summon.
      loopApplyConfig: (loop: string | null, modelSelections?: Record<string, string>) => Promise<{ ok: boolean; loop: string }>;
      loopSetRoleDefault: (loopId: string, role: string, modelId: string | null, model?: string | null) => Promise<{ ok: boolean; error?: string }>;
      glyphhContextUsage: (chatId: string) => Promise<{ tokens: number; budget: number; ratio: number; foldAt: number; lanes: Array<{ id: string; kind: "local" | "frontier"; tokens: number; budget: number; ratio: number; foldAt: number | null }> }>;
      glyphhCompact: (chatId: string, focus: string, loop?: string) => Promise<{ ok: boolean; reason?: string }>;
      glyphhStop: (chatId?: string) => Promise<boolean>;
      glyphhSetPermission: (chatId: string, permission: "ask" | "plan" | "acceptEdits" | "auto") => Promise<{ updated: boolean }>;
      onGlyphhAgentDelta: (cb: (d: { runId: string; delta: string }) => void) => void;
      onGlyphhAgentThinking?: (cb: (d: { runId: string; text: string }) => void) => void;
      onGlyphhAgentDone: (cb: (d: { runId: string; stopped: boolean }) => void) => void;
      onGlyphhAgentError: (cb: (d: { runId: string; error: string; fix?: { kind: string; cli: string; command: string; message: string } }) => void) => void;
      onGlyphhAgentSetup: (cb: (d: { phase: string; chatId?: string; pct?: number; model?: string; receivedGB?: number; totalGB?: number; text?: string; html?: string; label?: string; cli?: string; route?: CliRoute; cliSessionId?: string }) => void) => void;
      onGlyphhAgentPermission: (cb: (d: { runId: string; permission: "ask" | "plan" | "acceptEdits" | "auto" }) => void) => void;
      onGlyphhAgentCredits: (cb: (d: { runId: string; usd: number }) => void) => void;
      onGlyphhAgentProgress: (cb: (d: { runId: string; inTokens: number; outTokens: number }) => void) => void;
      onGlyphhAgentTool: (cb: (d: { runId: string; phase: string; name?: string; title?: string; thought?: string; denied?: boolean; failed?: boolean; preview?: string }) => void) => void;
      glyphhApprovalRespond: (id: string, allow: boolean) => Promise<boolean>;
      onGlyphhAgentApproval: (cb: (d: { id: string; kind: string; title: string; detail: string }) => void) => void;
      glyphhAskRespond: (id: string, answers: string[]) => Promise<boolean>;
      onGlyphhAgentAsk: (cb: (d: { id: string; questions: Array<{ question: string; options?: string[] }> }) => void) => void;
      railCollapseGet: () => Promise<boolean>;
      railCollapseToggle: () => Promise<boolean>;
      railCollapseSet: (on: boolean) => Promise<boolean>;
      recentsList: () => Promise<Array<{
        kind: "app" | "layout"; id: string; name: string; folder: string; ts: number;
      }>>;
      recentsOpen: (entry: { kind: "app" | "layout"; id: string; name: string; folder: string; ts: number }) => Promise<boolean>;
      recentsRemove: (entry: { kind: "app" | "layout"; id: string; folder: string }) => Promise<boolean>;
      recentsClear: () => Promise<boolean>;
      workingDirRecentsClear: () => Promise<boolean>;
      onRecentsChanged: (cb: (list: Array<{
        kind: "app" | "layout"; id: string; name: string; folder: string; ts: number;
      }>) => void) => () => void;
      listDir: (dirPath: string) => Promise<Array<{ name: string; isDir: boolean }>>;
      openFile: (filePath: string) => void;
      // Remote relay

      // Local MCP server (127.0.0.1)
      localMcpSetEnabled: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
      localMcpStatus: () => Promise<{ running: boolean; port: number }>;
      localMcpSetPort: (port: number) => Promise<{ ok: boolean; error?: string }>;
      localMcpTokensList: () => Promise<Array<{ id: string; label: string; createdAt: string; expiresAt: string }>>;
      localMcpTokensCreate: (label: string) => Promise<{ id: string; label: string; token: string; createdAt: string; expiresAt: string }>;
      localMcpTokensRevoke: (id: string) => Promise<{ ok: boolean }>;

      // BYOK provider key — only the Claude Code bootstrap gate path remains.

      // BYOK gate — Anthropic API key saved via the Claude Code bootstrap gate.
      // Custom MCP connections (server-side; header values write-only)
      mcpCustomAllowed: () => Promise<{ allowed: boolean; reason?: string }>;
      mcpConnectionsList: () => Promise<{ ok: boolean; error?: string; connections: Array<{ slug: string; name: string; url: string; headerKeys: string[]; enabled: boolean; hiddenTools: string[]; createdAt: string; kind: "personal" | "org"; iconUrl: string | null }> }>;
      wbAppsChanged: (apps: Array<{ slug: string; name: string }>) => void;
      onWbAppCommand: (cb: (cmd: { action: string; app?: { slug: string; name: string; url: string; glyphh?: boolean }; apps?: Array<{ slug: string; name: string; url: string; glyphh?: boolean }>; slug?: string }) => void) => void;
      mcpConnectionsCreate: (fields: { name: string; url: string; headers?: Record<string, string>; oauth?: { clientId: string; clientSecret?: string } }) => Promise<{ ok: boolean; error?: string; connection?: { slug: string; name: string }; toolCount?: number }>;
      mcpConnectionsUpdate: (slug: string, fields: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; connection?: unknown }>;
      mcpConnectionsDelete: (slug: string) => Promise<{ ok: boolean; error?: string }>;
      mcpConnectionsTools: (slug: string) => Promise<{ ok: boolean; error?: string; tools: Array<{ name: string; description: string; hidden: boolean }> }>;
      // Pipedream on the user's own project (secret write-only)
      pipedreamConfigGet: () => Promise<{ ok: true; data: { configured: boolean; projectId: string; environment: "development" | "production"; clientId: string; secretSet: boolean; secretHint: string } } | { ok: false; error: string }>;
      pipedreamConfigSet: (input: { projectId?: string; environment?: "development" | "production"; clientId?: string; clientSecret?: string }) => Promise<{ ok: true; data: { configured: boolean; projectId: string; environment: "development" | "production"; clientId: string; secretSet: boolean; secretHint: string } } | { ok: false; error: string }>;
      pipedreamConfigClear: () => Promise<{ ok: true; data: { configured: boolean; projectId: string; environment: "development" | "production"; clientId: string; secretSet: boolean; secretHint: string } } | { ok: false; error: string }>;
      pipedreamTest: () => Promise<{ ok: true; data: { accounts: number } } | { ok: false; error: string }>;
      pipedreamApps: (o: { q?: string; after?: string; category?: string }) => Promise<{ ok: true; data: { apps: Array<{ slug: string; name: string; icon: string | null; description: string; categories: string[] }>; next: string; total: number } } | { ok: false; error: string }>;
      pipedreamCategories: () => Promise<{ ok: true; data: Array<{ id: string; name: string }> } | { ok: false; error: string }>;
      pipedreamAccounts: (refresh?: boolean) => Promise<{ ok: true; data: Array<{ id: string; app: string; appName: string; icon: string | null; healthy: boolean; dead: boolean; createdAt: string; enabled: boolean }> } | { ok: false; error: string }>;
      pipedreamConnect: (app: string) => Promise<{ ok: true; data: Extract<PdConnectProgress, { phase: "done" }> } | { ok: false; error: string }>;
      pipedreamConnectCancel: (app: string) => Promise<{ ok: true; data: { cancelled: boolean } } | { ok: false; error: string }>;
      pipedreamDisconnect: (accountId: string) => Promise<{ ok: true; data: Array<{ id: string; app: string; appName: string; icon: string | null; healthy: boolean; dead: boolean; createdAt: string; enabled: boolean }> } | { ok: false; error: string }>;
      pipedreamAppEnable: (app: string, on: boolean) => Promise<{ ok: true; data: Array<{ id: string; app: string; appName: string; icon: string | null; healthy: boolean; dead: boolean; createdAt: string; enabled: boolean }> } | { ok: false; error: string }>;
      pipedreamTools: (app: string) => Promise<{ ok: true; data: Array<{ name: string; description: string }> } | { ok: false; error: string }>;
      onPipedreamConnectProgress: (cb: (p: PdConnectProgress) => void) => () => void;
      onPipedreamChanged: (cb: () => void) => () => void;
    };
  }
}

// -- Window controls --

document.getElementById("btn-close")!.addEventListener("click", () => window.glyphh.windowClose());
document.getElementById("btn-minimize")!.addEventListener("click", () => window.glyphh.windowMinimize());
document.getElementById("btn-maximize")!.addEventListener("click", () => window.glyphh.windowMaximize());
document.getElementById("splash-close")?.addEventListener("click", () => window.glyphh.windowClose());

// -- Titlebar label -> open home tab --

// The .Yo titlebar label is no longer a link — clicking it does nothing.

// Yos badge removed in Phase 7 of THE-PIVOT-BYOK — yo-server no longer
// tracks balances; users pay providers directly. The window.refreshYosBadge
// hook becomes a no-op for any caller that still touches it.
(window as unknown as { refreshYosBadge?: () => void }).refreshYosBadge = () => {};

// -- Global keyboard shortcuts --
// The home view holds focus almost always (it wires its own shortcuts in
// main); these cover the rare moments the shell itself has focus.

document.addEventListener("keydown", (e) => {
  // Cmd+R / Ctrl+R to refresh the home view
  if (e.key === "r" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.glyphh.panelsRefresh();
  }

  // Cmd+Plus / Cmd+Minus to zoom the home view
  if ((e.key === "=" || e.key === "+") && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void Promise.resolve(window.glyphh.panelsGetZoom()).then((z) => { if (typeof z === "number") window.glyphh.panelsZoom(z + 0.1); });   // web: the bridge answers undefined, the browser zooms itself
  }
  if (e.key === "-" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void Promise.resolve(window.glyphh.panelsGetZoom()).then((z) => { if (typeof z === "number") window.glyphh.panelsZoom(z - 0.1); });   // web: the bridge answers undefined, the browser zooms itself
  }
  if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.glyphh.panelsZoom(1.0);
  }
});


// -- Drip effects (extracted to drip-ui.ts) --
initDrip();

// Suppress browser autocomplete / password-manager bars on ad-hoc fields.
installAutofillGuard();


// -- Home surface chrome --
// The home view is the one full-bleed surface and owns its own chrome
// (traffic lights, drag regions). Punch a permanent no-drag hole in this
// page's titlebar drag claim — base-window drag regions bleed through
// BrowserViews.
function initDashboard(): void {
  document.body.classList.add("fullbleed-active");
}

// -- Boot gate --

initBootGate({
  onBootReady: () => {},
  showPanels: () => { window.glyphh.panelsShow(); initDashboard(); },
  hidePanels: () => window.glyphh.panelsHide(),
  applyTheme: (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("yoTheme", theme); } catch {}
  },
  showOnboarding: (requiresAuth) => showOnboarding(requiresAuth),
});

// WEB-ONLY: expose the boot-gate's first-run drivers to the web boot script
// (web/src/web-boot.js lives in a separate module graph — the injected bundle —
// so it reaches these via window). The web boot decides first-run from the server
// per-user `regionChosen` and calls exactly one of these. Desktop never sets this.
if ((window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__) {
  (window as unknown as {
    glyphhWebBoot?: { showFirstRun: (onComplete?: () => void) => void; enterApp: (onComplete?: () => void) => void };
  }).glyphhWebBoot = {
    showFirstRun: webShowFirstRun,
    enterApp: webEnterApp,
  };
}
