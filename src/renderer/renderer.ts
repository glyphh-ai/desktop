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

/** Mirrors preload.ts AppReleaseRow — one immutable build of an app. */
type AppReleaseRow = {
  id: string;
  version: string;
  status: "pending" | "uploading" | "building" | "ready" | "failed";
  error: string | null;
  notes: string | null;
  channel: "dev" | "live";
  promotedAt: string | null;
  /** The ORG approval ladder (co-working) — null until submitted to the org admins. */
  orgReview?: "submitted" | "approved" | "rejected" | null;
  createdAt: string;
  updatedAt: string;
};

/** Mirrors preload.ts AppCollaboratorRow — a co-working seat on a user-owned app. */
type AppCollaboratorRow = {
  userId: string;
  role: "read" | "edit" | "admin";
  email: string;
  name: string | null;
  addedAt: string;
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

/** Mirrors preload.ts AppSnapshotRow — one entry of the source snapshot chain. */
type AppSnapshotRow = {
  hash: string;
  parentHash: string | null;
  createdAt: string;
  createdByEmail: string | null;
  note: string | null;
  isHead: boolean;
};

/** Mirrors preload.ts OrgPendingReleaseRow — the org admin's approval queue. */
type OrgPendingReleaseRow = {
  appId: string;
  slug: string;
  name: string;
  releaseId: string;
  version: string;
  submittedAt: string;
  ownerEmail: string | null;
};

declare global {
  // A custom domain + the DNS records to publish — mirror of the SDK CustomDomain
  // contract (Phase F). Global so the app-detail hosting tab (help/apps.ts) shares it.
  type CustomDomainWire = {
    id: string;
    deploymentId: string;
    hostname: string;
    status: string;
    dnsInstructions: {
      hostname: string;
      isApex: boolean;
      records: Array<{ type: "CNAME" | "A" | "AAAA" | "TXT"; name: string; value: string }>;
      apexUnsupported: boolean;
    };
    error: string | null;
    verifiedAt: string | null;
    createdAt: string;
  };

  interface Window {
    glyphh: {
      copyToClipboard: (text: string) => void;
      getPathForFile: (file: File) => string;
      windowClose: () => void;
      agentDockIgnoreMouse?: (ignore: boolean) => void;
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
      glyphhAppPreviewOpen: (slug: string, previewWcId?: number) => Promise<{ ok: boolean; fileUrl?: string; error?: string }>;
      glyphhAppPreviewClear: (previewWcId?: number) => Promise<{ ok: boolean }>;
      appCallTool: (slug: string, tool: string, args: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
      panelAppsList: () => Promise<SavedPanelApp[]>;
      dashboardData: () => Promise<{ name: string; plan: string; credits: number; allowance: number; spendCredits: number; requests: number; appsCount: number }>;
      // `userId` narrows to one member (org_admin only); "" = the caller's scope.
      usageSeries: (days: number, groupBy: string, userId?: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      dashboardRuns: () => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      homeGotoSection: (section: string) => Promise<{ ok: boolean }>;
      onGotoSection: (cb: (section: string) => void) => void;
      onPrefsReady: (cb: () => void) => void;
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
      appServersList: () => Promise<{ ok: boolean; images?: Array<{ key: string; region: string; description: string; ramMb: number; diskGb: number; monthlyCredits: number; active: boolean; sort: number }>; error?: string }>;
      appServerDeploy: (slug: string, imageKey: string, releaseId?: string) => Promise<{ ok: boolean; queued?: { deploymentId: string; status: string }; error?: string }>;
      appServerDeployments: (slug: string) => Promise<{ ok: boolean; deployments?: Array<{ id: string; imageKey: string; region: string; status: string; url: string | null; error: string | null; createdAt: string }>; error?: string }>;
      appServerDestroy: (slug: string, id: string) => Promise<{ ok: boolean; error?: string }>;
      appDomainsList: (slug: string) => Promise<{ ok: boolean; domains?: CustomDomainWire[]; error?: string }>;
      appDomainAdd: (slug: string, deploymentId: string | null, hostname: string) => Promise<{ ok: boolean; domain?: CustomDomainWire; error?: string }>;
      appDomainRemove: (slug: string, id: string) => Promise<{ ok: boolean; error?: string }>;
      appListingSet: (slug: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
      appListingImageAdd: (slug: string, kind: "icon" | "screenshot") => Promise<{ ok: boolean; key?: string; error?: string }>;
      appListingImageRemove: (slug: string, key: string) => Promise<{ ok: boolean; error?: string }>;
      appListingList: (slug: string, listed: boolean) => Promise<{ ok: boolean; listed?: boolean; error?: string }>;
      // Releases — history, notes, and dev → live promotion (see preload's AppReleaseRow).
      appUpdateInstalled: (slug: string) => Promise<{ ok: boolean; error?: string }>;
      appBuildDeploy: (slug: string, opts?: { deploy?: boolean }) => Promise<{ ok: boolean; result?: { slug: string; version: string; status: string; url?: string }; error?: string }>;
      appReleases: (slug: string) => Promise<{ ok: boolean; releases: AppReleaseRow[]; error?: string }>;
      appReleaseNotes: (slug: string, releaseId: string, notes: string | null) => Promise<{ ok: boolean; release?: AppReleaseRow; error?: string }>;
      appReleasePromote: (slug: string, releaseId: string) => Promise<{ ok: boolean; release?: AppReleaseRow; error?: string }>;
      // Co-working — collaborators on a user-owned app + per-release org approval.
      appCollaborators: (slug: string) => Promise<{ ok: boolean; collaborators: AppCollaboratorRow[]; error?: string }>;
      appCollaboratorSet: (slug: string, userId: string, role: "read" | "edit" | "admin") => Promise<{ ok: boolean; collaborators?: AppCollaboratorRow[]; error?: string }>;
      appCollaboratorRemove: (slug: string, userId: string) => Promise<{ ok: boolean; error?: string }>;
      appReleaseOrgReview: (slug: string, releaseId: string, action: "submit" | "approve" | "reject") => Promise<{ ok: boolean; error?: string }>;
      appOrgPendingReleases: () => Promise<{ ok: boolean; pending: OrgPendingReleaseRow[]; error?: string }>;
      appTraffic: (slug: string, days?: number) => Promise<{ ok: boolean; days: EdgeTrafficDayRow[]; hosts: Array<EdgeTrafficDayRow & { hostname: string }>; error?: string } & EdgeTelemetryRollups>;
      orgDomainsTraffic: (days?: number, filter?: { host?: string; appId?: string }) => Promise<{ ok: boolean; days: EdgeTrafficDayRow[]; hosts: Array<EdgeTrafficDayRow & { hostname: string }>; error?: string } & EdgeTelemetryRollups>;
      appClone: (slug: string, input: { slug: string; name?: string }) => Promise<{ ok: boolean; id?: string; slug?: string; name?: string; error?: string }>;
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
      appSourceHistory: (slug: string) => Promise<{ ok: boolean; history: AppSnapshotRow[]; error?: string }>;
      appSourceRestore: (slug: string, hash: string) => Promise<{ ok: boolean; dir?: string; files?: number; error?: string }>;
      appGraduate: (slug: string) => Promise<{ ok: boolean; path?: string; error?: string }>;

      // Layouts
      layoutsList: () => Promise<Array<{ name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; loop?: string | null; modelSelections?: Record<string, string>; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean }> }>>;
      layoutsOpen: (name: string) => Promise<{ ok: boolean; error?: string }>;
      layoutsSave: (name: string, panelIds: string[]) => Promise<boolean>;
      layoutsPickFolder: () => Promise<string | null>;
      layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean; config?: { url?: string; cmd?: string; keepAlive?: boolean; railMenu?: boolean; railRecents?: boolean; railLayouts?: boolean; railHideLeft?: boolean; railHideRight?: boolean } }>; folderMode?: "single" | "multi"; target?: "glyphh" | "desktop"; loop?: string | null; modelSelections?: Record<string, string>; sessionMode?: "keep" | "new" | "last"; folder?: string | null; space?: "chat" | "cowork" | "code" | null }) => Promise<boolean>;
      layoutsDelete: (name: string) => Promise<boolean>;
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
      onShowOnboarding: (callback: () => void) => void;
      onAccountUpdated: (callback: (info: { email: string; firstName: string; lastName: string; tier?: string; avatarUrl?: string } | null) => void) => void;
      onAccountLocked: (callback: (info: { status: string; upgradeUrl: string }) => void) => void;
      onAccountUnlocked: (callback: () => void) => void;
      recheckAccount: () => Promise<{ status: string }>;
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
      // Recents (rich)
      glyphhRun: (p: { chatId: string; attachments?: Array<{ kind: "image" | "file" | "folder"; path: string; name: string }>; workdir?: string; mode?: "chat" | "cowork" | "code"; permission?: "ask" | "plan" | "acceptEdits" | "auto"; source?: unknown }) => Promise<{ runId: string }>;
      onGlyphhAgentConnect?: (cb: (p: { id: string; app: { appId: string; name: string; icon?: string | null } }) => void) => () => void;
      glyphhAgentConnectRespond?: (p: { id: string; connected: boolean; reason?: string }) => Promise<boolean>;
      glyphhPickAttachments: (mode?: "files" | "folder") => Promise<Array<{ kind: "image" | "file" | "folder"; path: string; name: string }>>;
      glyphhClassifyPaths: (paths: string[]) => Promise<Array<{ kind: "image" | "file" | "folder"; path: string; name: string }>>;
      glyphhSaveClipboardImage: (bytes: ArrayBuffer) => Promise<{ kind: "image"; path: string; name: string }>;
      glyphhSessionsLoad: () => Promise<{ chats: unknown[]; currentId: string }>;
      glyphhSessionsSave: (chats: unknown[], currentId: string) => Promise<boolean>;
      // Server threads surface (desktop transport for help/thread-store.ts).
      threadsList?: () => Promise<Array<{ id: string; title: string; mode: string; source: unknown; createdAt: number; updatedAt: number; messageCount: number }>>;
      threadsGet?: (id: string) => Promise<{ id: string; title: string; mode: string; source: unknown; createdAt: number; updatedAt: number; messageCount: number; messages: unknown[] }>;
      threadsPush?: (id: string, body: { title?: string; mode?: string; source?: unknown; messages?: unknown[]; updatedAt: number }) => Promise<{ applied: boolean; thread: { id: string; title: string; mode: string; source: unknown; createdAt: number; updatedAt: number; messageCount: number } }>;
      threadsDelete?: (id: string) => Promise<void>;
      glyphhRemember: (fact: string) => Promise<boolean>;
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
      loopRoles: (loop: string, force?: boolean, context?: "local" | "cloud") => Promise<{ ok: boolean; loop: string; roles: LoopRoleView[] }>;
      loopRoleSet: (loop: string, role: string, modelId: string | null) => Promise<{ ok: boolean; loop: string; roles: LoopRoleView[] }>;
      // Org-admin Models page.
      workspacesList: () => Promise<{ ok: boolean; data?: unknown[]; error?: string }>;
      workspacesCreate: (input: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      workspacesUpdate: (id: string, input: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      workspacesDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
      workspacesModelCatalog: () => Promise<{ ok: boolean; data?: unknown[]; error?: string }>;
      workspacesOrgConnectors: () => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      workspacesOrgToolCap: () => Promise<{ ok: boolean; data?: Record<string, string[]>; error?: string }>;
      workspacesConnTools: (slug: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      workspacesAppSearch: (search: string, limit?: number) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      orgModelsList: () => Promise<{ ok: boolean; data?: unknown[]; error?: string }>;
      orgModelsSetSupported: (id: string, supported: boolean) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      orgCustomModelsList: () => Promise<{ ok: boolean; data?: unknown[]; error?: string }>;
      orgCustomModelsSave: (input: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      orgCustomModelsDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
      orgCustomProvidersList: () => Promise<{ ok: boolean; data?: unknown[]; error?: string }>;
      orgCustomProvidersSave: (input: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      orgCustomProvidersDelete: (slug: string) => Promise<{ ok: boolean; error?: string }>;
      orgProvidersList: () => Promise<{ ok: boolean; data?: unknown[]; error?: string }>;
      orgProviderEnable: (slug: string, key?: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      orgProviderDisable: (slug: string) => Promise<{ ok: boolean; error?: string }>;
      orgProviderClearKey: (slug: string) => Promise<{ ok: boolean; error?: string }>;
      // @-mention summon (ghost overlay): alias lookup + summon.
      loopApplyConfig: (loop: string | null, modelSelections?: Record<string, string>) => Promise<{ ok: boolean; loop: string }>;
      loopSetRoleDefault: (loopId: string, role: string, modelId: string | null, model?: string | null) => Promise<{ ok: boolean; error?: string }>;
      glyphhContextUsage: (chatId: string) => Promise<{ tokens: number; budget: number; ratio: number; foldAt: number; lanes: Array<{ id: string; kind: "local" | "frontier"; tokens: number; budget: number; ratio: number; foldAt: number | null }> }>;
      glyphhCompact: (chatId: string, focus: string) => Promise<{ ok: boolean; reason?: string }>;
      glyphhStop: (chatId?: string) => Promise<boolean>;
      appVersionSet: (slug: string, version: string) => Promise<{ ok: boolean; version?: string; error?: string }>;
      appsSchedulesList: (slug: string) => Promise<{ ok: boolean; schedules?: unknown[]; error?: string }>;
      appsScheduleCreate: (slug: string, input: { name: string; cron: string; prompt: string }) => Promise<{ ok: boolean; schedule?: unknown; error?: string }>;
      appsScheduleUpdate: (slug: string, id: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; schedule?: unknown; error?: string }>;
      appsScheduleDelete: (slug: string, id: string) => Promise<{ ok: boolean; error?: string }>;
      appsScheduleRun: (slug: string, id: string) => Promise<{ ok: boolean; schedule?: unknown; error?: string }>;
      appsCronList: (slug: string) => Promise<{ ok: boolean; handlers?: Array<{ id: string; cron: string; handler: string }>; error?: string }>;
      glyphhSetPermission: (chatId: string, permission: "ask" | "plan" | "acceptEdits" | "auto") => Promise<{ updated: boolean }>;
      onGlyphhAgentDelta: (cb: (d: { runId: string; delta: string }) => void) => void;
      onGlyphhAgentDone: (cb: (d: { runId: string; stopped: boolean }) => void) => void;
      onGlyphhAgentError: (cb: (d: { runId: string; error: string }) => void) => void;
      onGlyphhAgentSetup: (cb: (d: { phase: string; pct?: number; model?: string; receivedGB?: number; totalGB?: number; text?: string; html?: string; label?: string }) => void) => void;
      onGlyphhAgentPermission: (cb: (d: { runId: string; permission: "ask" | "plan" | "acceptEdits" | "auto" }) => void) => void;
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
      connectorsConnect?: (appSlug: string) => Promise<{ ok: boolean; error?: string }>;
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
    window.glyphh.panelsGetZoom().then((z) => window.glyphh.panelsZoom(z + 0.1));
  }
  if (e.key === "-" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.glyphh.panelsGetZoom().then((z) => window.glyphh.panelsZoom(z - 0.1));
  }
  if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.glyphh.panelsZoom(1.0);
  }
});

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

window.glyphh.onUpdateStatus(({ status, version, percent, error }) => {
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
  window.glyphh.updateInstall();
});

updateDismiss.addEventListener("click", () => {
  updateBar.classList.add("hidden");
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
