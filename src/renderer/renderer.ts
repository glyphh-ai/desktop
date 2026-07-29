/**
 * Renderer — titlebar + grid handles + boot gate.
 *
 * All user commands (yo/dip/drip) happen inside app panels
 * via the interceptor, or from the command bar. The renderer
 * manages window chrome and session state display.
 */

// Section content (Apps/Layouts/Drips/Skills/Settings/About) lives in the
// home.html panels (home.ts); this shell owns the tab bar + browser chrome.
import { showOnboarding } from "./onboarding.js";
import { formatMarkdown } from "./format-markdown.js";
import { initBootGate } from "./boot-gate-ui.js";
import { initDownloads } from "./downloads-ui.js";
import { initDrip } from "./drip-ui.js";
import { initTabBar } from "./tab-bar-ui.js";
import { initGrid } from "./grid-ui.js";
import { initSearchClears } from "./search-clear.js";
import { yoConfirm } from "./yo-modal.js";
import type { RoleView as LoopRoleView } from "./help/model-picker.js";
import type { LibEnvelope } from "./help/library-types.js";

type TabInfo = { id: string; name: string; favicon?: string; layoutFavicons?: string[]; pinned?: boolean; url?: string };

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
  org?: boolean;
  // Governance, mirrored from preload.ts Connection.
  agentAllowed?: boolean; agentTools?: number; agentAvailable?: number;
};


// Mirrors preload.ts MarketplaceApp — a marketplace listing.
type MarketplaceApp = {
  id: string; slug: string; name: string; tagline: string; description?: string;
  iconUrl?: string; developer: { name: string; verified: boolean };
  rating: number; ratingCount: number; priceCredits: number; category: string;
  scope: "public" | "private"; featured: boolean; popular: boolean;
  connections: Array<{ name: string; slug: string }>;
  version?: string; videoUrl?: string; mockups?: string[]; installed: boolean;
};

// Mirrors preload.ts MarketplaceAppDetail — the full listing-page payload.
type MarketplaceAppDetail = MarketplaceApp & {
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
  requiredConnections: Array<{ slug: string; actAs: string; connected: boolean }>;
  owned: boolean;
};

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

/** Mirrors preload.ts AppReleaseRow — one immutable build of an app. */
type AppReleaseRow = {
  id: string;
  version: string;
  status: "pending" | "uploading" | "building" | "ready" | "failed";
  error: string | null;
  notes: string | null;
  channel: "dev" | "live";
  promotedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

declare global {
  interface Window {
    yo: {
      copyToClipboard: (text: string) => void;
      getPathForFile: (file: File) => string;
      windowClose: () => void;
      windowMinimize: () => void;
      windowMaximize: () => void;
      panelsHide: () => void;
      panelsShow: () => void;
      capturePanels: () => Promise<Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }>>;
      panelsRefresh: (id?: string) => void;
      panelsZoom: (factor: number) => void;
      panelsGetZoom: () => Promise<number>;
      // Apps
      appsList: () => Promise<Array<{
        id: string; name: string; url?: string; connected: boolean; connectedSlug?: string;
        forceWeb?: boolean; doNotRecord?: boolean;
        commands: Record<string, { selector: string; action: string; description: string }>;
        meta?: { description: string; capabilities: string[] };
        connection?: { pipedreamSlug: string; accountId?: string; healthy?: boolean };
        mcp?: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; oauth?: { clientId: string; clientSecret: string; tokenUrl: string; scope?: string }; enabled: boolean };
      }>>;
      appsListMountable: () => Promise<Array<{
        id: string; name: string; url?: string; connected: boolean;
        kind?: "user" | "system"; internal?: boolean; requiresFolder?: boolean;
      }>>;
      appsAdd: (id: string, name: string, url?: string) => Promise<unknown>;
      // Dashboard shell (5a): server-authoritative Apps tab CRUD — see
      // apps-ipc.ts's panel-apps-* handlers / saved-app-routes.ts.
      appFileIcon: (execPath: string) => Promise<string>;
      appLaunch: (spec: {
        slug: string; name: string; url?: string | null;
        isBrowser?: boolean;
        execPath?: string | null; appArchetype?: string | null;
        launchConfig?: Record<string, unknown> | null;
      }) => Promise<{ ok: boolean; error?: string }>;
      glyphhAppPreviewOpen: (slug: string, previewWcId?: number) => Promise<{ ok: boolean; fileUrl?: string; error?: string }>;
      glyphhAppPreviewClear: (previewWcId?: number) => Promise<{ ok: boolean }>;
      appCallTool: (slug: string, tool: string, args: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
      marketplaceList: (params: {
        scope: "public" | "private"; category?: string; q?: string;
        sort?: "popular" | "rating" | "newest"; page?: number;
      }) => Promise<{
        items: MarketplaceApp[]; total: number; page: number; pageSize: number;
        categories: Array<{ id: string; label: string; count: number }>;
        featured: MarketplaceApp[]; popular: MarketplaceApp[];
      }>;
      marketplaceDetail: (id: string) => Promise<MarketplaceAppDetail | null>;
      marketplaceInstall: (id: string) => Promise<{ ok: boolean; slug?: string; error?: string }>;
      panelAppsList: () => Promise<SavedPanelApp[]>;
      dashboardData: () => Promise<{ name: string; plan: string; credits: number; allowance: number; spendCredits: number; requests: number; appsCount: number }>;
      usageSeries: (days: number, groupBy: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      dashboardRuns: () => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      homeGotoSection: (section: string) => Promise<{ ok: boolean }>;
      onGotoSection: (cb: (section: string) => void) => void;
      panelAppsCreate: (input: PanelAppInput) => Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>;
      panelAppsUpdate: (id: string, patch: PanelAppInput) => Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>;
      panelAppsDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
      loopsList: () => Promise<{ ok: boolean; loops: Array<{ id: string; name: string; description: string; builtIn?: boolean }>; canBuild: boolean }>;
      connectionsList: () => Promise<{ ok: boolean; error?: string; connections: Connection[] }>;
      connectionRename: (id: string, label: string) => Promise<{ ok: boolean; connection?: Connection; error?: string }>;
      connectionToolsList: (id: string) => Promise<{ ok: boolean; error?: string; tools: Array<{ name: string; description: string; hidden: boolean }> }>;
      connectionToolsSet: (id: string, hiddenTools: string[]) => Promise<{ ok: boolean; connection?: Connection; error?: string }>;
      connectionDisconnect: (id: string) => Promise<{ ok: boolean; error?: string }>;
      // App proxies — public <slug>.glyphh.app tunnels
      appSecretsList: (id: string) => Promise<{ ok: boolean; secrets?: Array<{ key: string; at: string; hostOnly?: boolean; appReadable?: boolean }>; error?: string }>;
      appSecretsSet: (id: string, key: string, value: string, appReadable?: boolean) => Promise<{ ok: boolean; error?: string }>;
      appSecretsDelete: (id: string, key: string) => Promise<{ ok: boolean; error?: string }>;
      appImport: () => Promise<{ ok: boolean; appId?: string; error?: string }>;
      appExport: (appId: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
      hostingStatus: (slug: string) => Promise<{ ok: boolean; deployment?: { id: string; appSlug: string; url: string | null; status: string } | null; error?: string }>;
      hostingDeploy: (slug: string) => Promise<{ ok: boolean; deployment?: { id: string; url: string | null; status: string }; error?: string }>;
      hostingDestroy: (id: string) => Promise<{ ok: boolean; error?: string }>;
      appListingSet: (slug: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
      appListingImageAdd: (slug: string, kind: "icon" | "screenshot") => Promise<{ ok: boolean; key?: string; error?: string }>;
      appListingImageRemove: (slug: string, key: string) => Promise<{ ok: boolean; error?: string }>;
      appListingList: (slug: string, listed: boolean) => Promise<{ ok: boolean; listed?: boolean; error?: string }>;
      // Releases — history, notes, and dev → live promotion (see preload's AppReleaseRow).
      appUpdateInstalled: (slug: string) => Promise<{ ok: boolean; error?: string }>;
      appBuildDeploy: (slug: string) => Promise<{ ok: boolean; result?: { slug: string; version: string; status: string; url?: string }; error?: string }>;
      appReleases: (slug: string) => Promise<{ ok: boolean; releases: AppReleaseRow[]; error?: string }>;
      appReleaseNotes: (slug: string, releaseId: string, notes: string | null) => Promise<{ ok: boolean; release?: AppReleaseRow; error?: string }>;
      appReleasePromote: (slug: string, releaseId: string) => Promise<{ ok: boolean; release?: AppReleaseRow; error?: string }>;
      appGraduate: (slug: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
      appsRemove: (id: string) => Promise<boolean>;
      appsSetConnection: (id: string, pipedreamSlug: string) => Promise<boolean>;
      appsRemoveConnection: (id: string) => Promise<boolean>;
      appsUpdateId: (oldId: string, newId: string) => Promise<boolean>;
      appsUpdateName: (id: string, name: string) => Promise<boolean>;
      appsUpdateUrl: (id: string, url: string) => Promise<boolean>;
      appsSetConnectedSlug: (id: string, slug: string | null) => Promise<boolean>;
      appsSetCommand: (id: string, key: string, mapping: { selector: string; action: string; description: string }) => Promise<boolean>;
      appsRemoveCommand: (id: string, key: string) => Promise<boolean>;

      // Layouts
      layoutsList: () => Promise<Array<{ name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; loop?: string | null; modelSelections?: Record<string, string>; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean }> }>>;
      layoutsOpen: (name: string) => Promise<{ ok: boolean; error?: string }>;
      layoutsSave: (name: string, panelIds: string[]) => Promise<boolean>;
      layoutsPickFolder: () => Promise<string | null>;
      layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean }>; folderMode?: "single" | "multi"; target?: "glyphh" | "desktop"; glyphh?: { mode: "rail" | "left" | "right" | "none"; fraction?: number }; loop?: string | null; modelSelections?: Record<string, string>; sessionMode?: "keep" | "new" | "last"; folder?: string | null }) => Promise<boolean>;
      layoutsFolderRequired?: (name: string) => Promise<boolean>;
      layoutsDelete: (name: string) => Promise<boolean>;
      pickDirectory: () => Promise<string | null>;
      pickExecutable: () => Promise<string | null>;
      // Grid resize
      gridDragEnd: (type: "col" | "row", index: number, fraction: number) => void;
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
      userTimezoneGet: () => Promise<string | null>;
      userTimezoneSet: (tz: string) => Promise<{ ok: boolean; error?: string }>;
      logout: () => Promise<void>;
      onBoot: (callback: (data: { authenticated: boolean; status: string; tier?: string; needsOnboarding: boolean; hideWelcome?: boolean; theme?: string }) => void) => void;
      onThemeChanged: (callback: (theme: string) => void) => void;
      onShowOnboarding: (callback: () => void) => void;
      onAccountUpdated: (callback: (info: { email: string; firstName: string; lastName: string } | null) => void) => void;
      onAccountLocked: (callback: (info: { status: string; upgradeUrl: string }) => void) => void;
      onAccountUnlocked: (callback: () => void) => void;
      recheckAccount: () => Promise<{ status: string }>;
      onOpenSettings: (callback: () => void) => void;
      onFocusInput: (callback: () => void) => void;
      onExecCommandFromPalette: (callback: (cmd: string) => void) => void;
      createAppFromTab: (tabId: string, url: string, name: string) => void;
      onOpenNewApp: (callback: (data: { url?: string; name?: string; tabId?: string }) => void) => void;
      onPanelAppsChanged: (callback: () => void) => void;
      convertTabToApp: (tabId: string, appId: string) => void;
      openInEditor: (filePath: string) => void;
      getWorkingDir: () => Promise<string | null>;
      pickWorkingDir: (opts?: { asDefault?: boolean }) => Promise<string | null>;
      setWorkingDir: (dir: string) => Promise<string>;
      gitInfo: (root: string) => Promise<{ isRepo: boolean; branch?: string; defaultBranch?: string }>;
      getWorkingDirRecents: () => Promise<string[]>;
      onWorkingDirChanged: (callback: (dir: string | null) => void) => void;
      onSplitState: (callback: (info: {
        panelIds: string[];
        cols: number;
        rows: number;
        colWidths: number[];
        rowHeights: number[];
        cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
      } | null) => void) => void;
      // Command execution
      execCommand: (cmd: string) => Promise<string>;
      // Downloads
      onDownloadStart: (cb: (info: { filename: string; totalBytes: number; savePath: string }) => void) => void;
      onDownloadProgress: (cb: (info: { filename: string; receivedBytes: number; totalBytes: number }) => void) => void;
      onDownloadDone: (cb: (info: { filename: string; savePath: string; state: string }) => void) => void;
      downloadShow: (filePath: string) => void;
      // Drip effects
      onDripEffect: (callback: (effect: string) => void) => void;
      // Drips CRUD
      dripsList: () => Promise<Array<{ name: string; recipe: string }>>;
      dripsSave: (name: string, recipe: string) => Promise<string>;
      dripsDelete: (name: string) => Promise<string>;
      dripsPreview: (recipe: string) => Promise<string>;
      dripsBuiltinEffects: () => Promise<string[]>;
      // Tabs
      tabList: () => Promise<{ tabs: TabInfo[]; activeId: string; visible: boolean }>;
      tabSwitch: (id: string) => void;
      tabClose: (id: string) => void;
      tabCloseAll: () => void;
      tabReorder: (newOrder: string[]) => void;
      tabNew: () => void;
      tabNewApp: (appId: string) => void;
      onTabState: (callback: (state: { tabs: TabInfo[]; activeId: string; visible: boolean }) => void) => void;
      // URL bar
      urlBarNavigate: (url: string) => void;
      urlBarBack: () => void;
      urlBarForward: () => void;
      urlBarRefresh: () => void;
      panelNavBack: (panelId: string) => void;
      panelNavForward: (panelId: string) => void;
      panelNavRefresh: (panelId: string) => void;
      panelNavTo: (panelId: string, url: string) => void;
      urlBarToggle: (show: boolean) => void;
      onUrlUpdate: (cb: (info: { url: string; favicon: string; canGoBack?: boolean; canGoForward?: boolean }) => void) => void;
      onUrlBarForce: (cb: (show: boolean) => void) => void;
      onTabFavicon: (cb: (info: { id: string; favicon: string }) => void) => void;
      onPanelUrlUpdate: (cb: (info: { id: string; url: string; favicon: string }) => void) => void;
      // Theme
      getTheme: () => Promise<string>;
      exportGlyphhSkill: (provider: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
      setTheme: (theme: string) => Promise<void>;
      // Account info
      getAuthStatus: () => Promise<{ authenticated: boolean; status: string; tier?: string }>;
      refreshAuth: () => Promise<{ tier: string; status: string }>;
      openExternal: (url: string) => void;
      platformUrl: string;
      serverUrl: string;
      discordInvite: string;
      hasMcpAccess: () => Promise<boolean>;
      openAccountDashboard: () => void;
      openBilling: () => void;
      // Support
      submitSupportTicket: (ticket: { subject: string; description: string }) => Promise<{ ok: boolean; error?: string }>;
      // Voice transcription
      // Files left rail
      filesRailResize: (width: number) => void;
      filesRailWidthSave: (width: number) => void;
      filesRailGetWidth: () => Promise<number>;
      // Recents (rich)
      glyphhRun: (p: { chatId: string; attachments?: Array<{ kind: "image" | "file" | "folder"; path: string; name: string }> }) => Promise<{ runId: string }>;
      glyphhPickAttachments: (mode?: "files" | "folder") => Promise<Array<{ kind: "image" | "file" | "folder"; path: string; name: string }>>;
      glyphhClassifyPaths: (paths: string[]) => Promise<Array<{ kind: "image" | "file" | "folder"; path: string; name: string }>>;
      glyphhSaveClipboardImage: (bytes: ArrayBuffer) => Promise<{ kind: "image"; path: string; name: string }>;
      glyphhSessionsLoad: () => Promise<{ chats: unknown[]; currentId: string }>;
      glyphhSessionsSave: (chats: unknown[], currentId: string) => Promise<boolean>;
      glyphhRemember: (fact: string) => Promise<boolean>;
      adaRecall: (query: string, k?: number) => Promise<Array<{ content: string; score: number }>>;
      libraryLoopGet: (ref: string) => Promise<LibEnvelope>;
      libraryLoopCreate: (input: unknown) => Promise<LibEnvelope>;
      libraryLoopUpdate: (ref: string, patch: unknown) => Promise<LibEnvelope>;
      libraryLoopDelete: (ref: string) => Promise<LibEnvelope>;
      librarySkillsList: () => Promise<LibEnvelope>;
      librarySkillGet: (ref: string) => Promise<LibEnvelope>;
      librarySkillCreate: (input: unknown) => Promise<LibEnvelope>;
      librarySkillUpdate: (ref: string, patch: unknown) => Promise<LibEnvelope>;
      librarySkillDelete: (ref: string) => Promise<LibEnvelope>;
      libraryAgentsList: () => Promise<LibEnvelope>;
      libraryAgentGet: (ref: string) => Promise<LibEnvelope>;
      libraryAgentCreate: (input: unknown) => Promise<LibEnvelope>;
      libraryAgentUpdate: (ref: string, patch: unknown) => Promise<LibEnvelope>;
      libraryAgentDelete: (ref: string) => Promise<LibEnvelope>;
      libraryAgentTasks: (ref: string) => Promise<LibEnvelope>;
      libraryAgentTaskAdd: (ref: string, input: unknown) => Promise<LibEnvelope>;
      libraryAgentTaskUpdate: (ref: string, taskId: string, patch: unknown) => Promise<LibEnvelope>;
      libraryAgentTaskRunNow: (ref: string, taskId: string) => Promise<LibEnvelope>;
      libraryAgentTaskRuns: (ref: string, taskId: string) => Promise<LibEnvelope>;
      libraryAgentTaskRunning: (ref: string, taskId: string) => Promise<LibEnvelope>;
      libraryAgentTaskDelete: (ref: string, taskId: string) => Promise<LibEnvelope>;
      loopRoles: (loop: string, force?: boolean) => Promise<{ ok: boolean; loop: string; roles: LoopRoleView[] }>;
      loopRoleSet: (loop: string, role: string, modelId: string | null) => Promise<{ ok: boolean; loop: string; roles: LoopRoleView[] }>;
      // Org-admin Models page.
      orgModelsList: () => Promise<{ ok: boolean; data?: unknown[]; error?: string }>;
      orgModelsSetSupported: (id: string, supported: boolean) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      orgCustomModelsList: () => Promise<{ ok: boolean; data?: unknown[]; error?: string }>;
      orgCustomModelsSave: (input: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      orgCustomModelsDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
      orgProvidersList: () => Promise<{ ok: boolean; data?: unknown[]; error?: string }>;
      orgProviderEnable: (slug: string, key?: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      orgProviderDisable: (slug: string) => Promise<{ ok: boolean; error?: string }>;
      orgProviderClearKey: (slug: string) => Promise<{ ok: boolean; error?: string }>;
      // @-mention summon (ghost overlay): alias lookup + summon.
      mentionCatalog: () => Promise<{ ok: boolean; pairs?: Record<string, string>; error?: string }>;
      ghostSummon: (model: string, prompt: string) => Promise<{ ok: boolean }>;
      loopApplyConfig: (loop: string | null, modelSelections?: Record<string, string>) => Promise<{ ok: boolean; loop: string }>;
      loopSetRoleDefault: (loopId: string, role: string, modelId: string | null) => Promise<{ ok: boolean; error?: string }>;
      adaAsk: (op: unknown) => Promise<{ ok: boolean; answer?: string; error?: string }>;
      adaStats: () => Promise<{ thoughts: number; slots: number; keys: number }>;
      glyphhContextUsage: (chatId: string) => Promise<{ tokens: number; budget: number; ratio: number; foldAt: number; lanes: Array<{ id: string; kind: "local" | "frontier"; tokens: number; budget: number; ratio: number; foldAt: number | null }> }>;
      glyphhCompact: (chatId: string, focus: string) => Promise<{ ok: boolean; reason?: string }>;
      glyphhStop: () => Promise<boolean>;
      onGlyphhAgentDelta: (cb: (d: { runId: string; delta: string }) => void) => void;
      onGlyphhAgentDone: (cb: (d: { runId: string; stopped: boolean }) => void) => void;
      onGlyphhAgentError: (cb: (d: { runId: string; error: string }) => void) => void;
      onGlyphhAgentSetup: (cb: (d: { phase: string; pct?: number; model?: string; receivedGB?: number; totalGB?: number; text?: string; html?: string; label?: string }) => void) => void;
      onGlyphhAgentCredits: (cb: (d: { runId: string; creditsMicro: number }) => void) => void;
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
      mkdir: (dirPath: string) => Promise<{ ok: boolean; error?: string }>;
      // Connectors (Pipedream Connect)
      connectorsGetApps: (search?: string, offset?: number) => Promise<{ apps: Array<{ id: string; name: string; description: string; icon?: string; categories?: string[] }>; hasMore: boolean }>;
      connectorsGetAccounts: () => Promise<Array<{ id: string; appSlug: string; appName: string; createdAt: string; healthy: boolean }>>;
      connectorsConnect: (appSlug: string) => Promise<{ ok: boolean; error?: string }>;
      connectorsDisconnect: (accountId: string) => Promise<boolean>;
      connectorsRefreshMcp: () => Promise<{ ok: boolean; error?: string; toolCount: number }>;
      connectorsListTools: () => Promise<Array<{ slug: string; name: string; description: string }>>;
      onConnectorsChanged: (cb: () => void) => void;
      onConnectorsConnectProgress: (cb: (p: { phase: "verifying" | "done"; appSlug: string; ok?: boolean; error?: string }) => void) => void;
      // Auto-update
      onUpdateStatus: (cb: (info: { status: string; version?: string; percent?: number; error?: string }) => void) => void;
      updateInstall: () => void;
      checkForUpdates: () => Promise<string | null>;
      getUpdateStatus: () => Promise<{ version: string; ready: boolean } | null>;
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
      mcpConnectionsCatalog: () => Promise<{ ok: boolean; error?: string; connections: Array<{ slug: string; name: string; installed: boolean; iconUrl: string | null }> }>;
      wbAppsChanged: (apps: Array<{ slug: string; name: string }>) => void;
      onWbAppCommand: (cb: (cmd: { action: string; app?: { slug: string; name: string; url: string; glyphh?: boolean }; apps?: Array<{ slug: string; name: string; url: string; glyphh?: boolean }>; slug?: string }) => void) => void;
      mcpConnectionsInstall: (slug: string) => Promise<{ ok: boolean; error?: string }>;
      mcpConnectionsCreate: (fields: { name: string; url: string; headers?: Record<string, string>; oauth?: { clientId: string; clientSecret?: string } }) => Promise<{ ok: boolean; error?: string; connection?: { slug: string; name: string }; toolCount?: number }>;
      mcpConnectionsUpdate: (slug: string, fields: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; connection?: unknown }>;
      mcpConnectionsDelete: (slug: string) => Promise<{ ok: boolean; error?: string }>;
      mcpConnectionsTools: (slug: string) => Promise<{ ok: boolean; error?: string; tools: Array<{ name: string; description: string; hidden: boolean }> }>;
      onAppsChanged: (cb: () => void) => void;
    };
  }
}

const gridHandles = document.getElementById("grid-handles")!;
const screenshotContainer = document.getElementById("panel-screenshots")!;

// -- Panel screenshot helpers (freeze-frame when hiding panels) --

async function showPanelScreenshots(): Promise<void> {
  const captures = await window.yo.capturePanels();
  for (const cap of captures) {
    const div = document.createElement("div");
    div.className = "panel-screenshot";
    div.style.left = `${cap.bounds.x}px`;
    div.style.top = `${cap.bounds.y}px`;
    div.style.width = `${cap.bounds.width}px`;
    div.style.height = `${cap.bounds.height}px`;
    div.style.backgroundImage = `url(${cap.dataUrl})`;
    screenshotContainer.appendChild(div);
  }
}

function clearPanelScreenshots(): void {
  screenshotContainer.innerHTML = "";
}

// -- Window controls --

document.getElementById("btn-close")!.addEventListener("click", () => window.yo.windowClose());
document.getElementById("btn-minimize")!.addEventListener("click", () => window.yo.windowMinimize());
document.getElementById("btn-maximize")!.addEventListener("click", () => window.yo.windowMaximize());
document.getElementById("splash-close")?.addEventListener("click", () => window.yo.windowClose());

// -- Titlebar label -> open home tab --

// The .Yo titlebar label is no longer a link — clicking it does nothing.

// Yos badge removed in Phase 7 of THE-PIVOT-BYOK — yo-server no longer
// tracks balances; users pay providers directly. The window.refreshYosBadge
// hook becomes a no-op for any caller that still touches it.
(window as unknown as { refreshYosBadge?: () => void }).refreshYosBadge = () => {};


// -- Yo agent panel removed (pivot-mcp) --
// The in-app interactive chat agent panel was removed; these stubs keep
// grid-ui.ts's layout math (right-inset calc) working with "no panel open".
const isYoPanelOpen = (): boolean => false;
const getYoPanelWidth = (): number => 0;

// -- Tab bar (extracted to tab-bar-ui.ts) --
const tabApi = initTabBar({
  isYoControlsInited: () => false,  // yo panel manages this internally now
  getCurrentMode: () => "standard",
  setModeValue: () => {},
  syncAgentMode: () => {},
});

// -- URL bar --

const urlBar = document.getElementById("url-bar")!;
const urlBarInput = document.getElementById("url-bar-input") as HTMLInputElement;
const urlBarFavicon = document.getElementById("url-bar-favicon") as HTMLImageElement;

function setUrlBarVisible(show: boolean) {
  urlBar.classList.toggle("hidden", !show);
  document.body.style.setProperty("--content-top", show ? "72px" : "38px");
}

// Load initial URL bar visibility
window.yo.getPreference("showUrlBar", false).then((show) => {
  setUrlBarVisible(show as boolean);
});

// Nav buttons
const urlBarBack = document.getElementById("url-bar-back") as HTMLButtonElement;
const urlBarForward = document.getElementById("url-bar-forward") as HTMLButtonElement;
const urlBarRefresh = document.getElementById("url-bar-refresh") as HTMLButtonElement;

urlBarBack.addEventListener("click", () => window.yo.urlBarBack());
urlBarForward.addEventListener("click", () => window.yo.urlBarForward());
urlBarRefresh.addEventListener("click", () => window.yo.urlBarRefresh());

// Navigate on Enter
urlBarInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const url = urlBarInput.value.trim();
    if (url) {
      window.yo.urlBarNavigate(url);
      urlBarInput.blur();
    }
  }
  if (e.key === "Escape") {
    urlBarInput.blur();
  }
});

// Select all on focus for easy replacement
urlBarInput.addEventListener("focus", () => {
  urlBarInput.select();
});

// Receive URL updates from main (active panel navigated)
window.yo.onUrlUpdate((info: { url: string; favicon: string; canGoBack?: boolean; canGoForward?: boolean }) => {
  urlBarInput.value = info.url;
  urlBarFavicon.src = info.favicon || "";
  urlBarFavicon.onerror = () => { urlBarFavicon.src = ""; };
  urlBarBack.disabled = !info.canGoBack;
  urlBarForward.disabled = !info.canGoForward;
});

// Force URL bar visible for browser panels even when globally hidden
window.yo.onUrlBarForce((show: boolean) => {
  setUrlBarVisible(show);
});


// Commands submitted from the palette child window
window.yo.onExecCommandFromPalette((cmd) => window.yo.execCommand(cmd));

// -- Global keyboard shortcuts --

document.addEventListener("keydown", (e) => {
  // Cmd+R / Ctrl+R to refresh panels
  if (e.key === "r" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.yo.panelsRefresh();
  }

  // Cmd+Plus / Cmd+Minus to zoom panels
  if ((e.key === "=" || e.key === "+") && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.yo.panelsGetZoom().then((z) => window.yo.panelsZoom(z + 0.1));
  }
  if (e.key === "-" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.yo.panelsGetZoom().then((z) => window.yo.panelsZoom(z - 0.1));
  }
  if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.yo.panelsZoom(1.0);
  }
});


// Open a system/user app in the workspace as a tab. Keep every "app tray"
// entry point (nav rail, header gear, settings signal) going through here.
function openWorkspaceApp(slug: string): void {
  window.yo.tabNewApp(slug);
}

// Open settings tab when main process signals (kept; welcome removed).
window.yo.onOpenSettings(() => openWorkspaceApp("home"));


// -- Grid (extracted to grid-ui.ts) --
const gridApi = initGrid({
  isYoPanelOpen,
  getYoPanelWidth,
  getLeftInset: () => parseFloat(getComputedStyle(document.body).getPropertyValue("--left-inset")) || 0,
  isUrlBarHidden: () => urlBar.classList.contains("hidden"),
  setUrlBarVisibility: (hidden) => { urlBar.style.visibility = hidden ? "hidden" : ""; },
  showPanelScreenshots,
  clearPanelScreenshots,
});

// -- Downloads dropdown (extracted to downloads-ui.ts) --
initDownloads();
initSearchClears();

// -- Update bar --

const updateBar = document.getElementById("update-bar")!;
const updateMsg = document.getElementById("update-message")!;
const updateProgress = document.getElementById("update-progress")!;
const updateFill = document.getElementById("update-progress-fill")!;
const updateAction = document.getElementById("update-action")!;
const updateDismiss = document.getElementById("update-dismiss")!;

// Full-screen updating overlay — shown once the user commits to relaunching
// (main hides the panels first so this shell overlay is visible before quit).
const updatingOverlay = document.getElementById("updating-overlay");
const updatingLabel = document.getElementById("updating-label");
const updatingFill = document.getElementById("updating-fill");

window.yo.onUpdateStatus(({ status, version, percent, error }) => {
  if (status === "available") {
    updateMsg.textContent = `Downloading v${version}...`;
    updateProgress.classList.remove("hidden");
    updateAction.classList.add("hidden");
    updateBar.classList.remove("hidden");
  } else if (status === "downloading") {
    updateFill.style.width = `${percent || 0}%`;
    // If the user already hit relaunch, reflect the download on the overlay.
    if (updatingOverlay && !updatingOverlay.classList.contains("hidden") && updatingFill) {
      updatingFill.style.width = `${percent || 0}%`;
    }
  } else if (status === "ready") {
    updateMsg.textContent = `v${version} ready — restart to update`;
    updateProgress.classList.add("hidden");
    updateAction.classList.remove("hidden");
    updateBar.classList.remove("hidden");
  } else if (status === "restarting") {
    // User committed to the update — take over the whole shell so they see a
    // clean "Updating…" screen instead of a flash of the workspace.
    if (updatingLabel) updatingLabel.textContent = version ? `Updating to v${version}…` : "Updating…";
    if (updatingFill) updatingFill.style.width = "100%";
    updatingOverlay?.classList.remove("hidden");
  } else if (status === "error") {
    updateMsg.textContent = `Update failed: ${error || "unknown error"}`;
  }
});

updateAction.addEventListener("click", () => {
  window.yo.updateInstall();
});

updateDismiss.addEventListener("click", () => {
  updateBar.classList.add("hidden");
});

// -- Drip effects (extracted to drip-ui.ts) --
initDrip();


// -- Dashboard shell (5a) --
//
// Replaces the tab-bar + files-rail chrome shown after Splash -> Auth with a
// simple two-tab Apps / Settings dashboard. Tabs open the existing yo://apps
// and yo://dashboard-settings system-app panels through the same
// panel-manager mechanism the old rail used (openWorkspaceApp) — a deliberate
// stopgap; the real Panel Manager rewrite is sub-phase 5b.
let dashboardChromeInited = false;
function initDashboard(): void {
  // The titlebar tab strip is gone — the Code-primary home panel carries its
  // own app rail (Home|Code, sections, user area). Just hide legacy chrome;
  // main opened + activated the "dashboard" panel at boot (openHomePanelOnly).
  document.getElementById("files-rail")?.classList.add("dashboard-hidden");
  document.getElementById("tab-bar")?.classList.add("dashboard-hidden");
  if (dashboardChromeInited) return;
  dashboardChromeInited = true;
  // Full-bleed sync: while the unlocked home panel (it owns the chrome
  // cluster) is active, punch a no-drag hole in THIS page's titlebar drag
  // claim — base-window drag regions bleed through BrowserViews.
  const syncFullbleed = (activeId: string) => {
    const on = activeId === "dashboard" || /^dashboard-\d+$/.test(activeId);
    document.body.classList.toggle("fullbleed-active", on);
  };
  syncFullbleed("dashboard");
  window.yo.onTabState((state) => syncFullbleed(state.activeId));
}

// -- Boot gate --

initBootGate({
  onBootReady: () => {},
  showPanels: () => { window.yo.panelsShow(); initDashboard(); },
  hidePanels: () => window.yo.panelsHide(),
  applyTheme: (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("yoTheme", theme); } catch {}
  },
  showOnboarding: (requiresAuth) => showOnboarding(requiresAuth),
});
