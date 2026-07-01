/**
 * Renderer — titlebar + grid handles + boot gate.
 *
 * All user commands (yo/dip/drip) happen inside app panels
 * via the interceptor, or from the command bar. The renderer
 * manages window chrome and session state display.
 */

// Help overlay moved to yo://home app
import { showOnboarding } from "./onboarding.js";
import { formatMarkdown } from "./format-markdown.js";
import { initBootGate } from "./boot-gate-ui.js";
import { initDownloads } from "./downloads-ui.js";
import { initDrip } from "./drip-ui.js";
import { initTabBar } from "./tab-bar-ui.js";
import { initGrid } from "./grid-ui.js";
import { initCanvas } from "./canvas-ui.js";
import { initCommandCenter } from "./command-center-ui.js";
import { initYoPanel } from "./yo-panel-ui-vscode.js";
import { initSearchClears } from "./search-clear.js";
import { yoConfirm } from "./yo-modal.js";

type TabInfo = { id: string; name: string; favicon?: string; layoutFavicons?: string[]; pinned?: boolean; url?: string };

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
      cmdPaletteOpen: () => void;
      capturePanels: () => Promise<Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }>>;
      panelsRefresh: (id?: string) => void;
      panelsZoom: (factor: number) => void;
      panelsGetZoom: () => Promise<number>;
      // Skills
      skillsList: () => Promise<string[]>;
      skillsListDetailed: () => Promise<Array<{ name: string; description?: string; hasRunner: boolean; hasApp: boolean; scheduled: boolean; scheduleExpr?: string }>>;
      skillsRead: (name: string) => Promise<string | null>;
      skillsGet: (name: string) => Promise<{ name: string; manifest: any; prompt: string; hasRunner: boolean; hasApp: boolean; runnerCode: string | null; runnerSchedule: string | null } | null>;
      skillsWrite: (name: string, prompt: string) => Promise<boolean | { error: string }>;
      skillsWriteFull: (name: string, manifest: any, prompt: string, runnerCode?: string | null) => Promise<boolean | { error: string }>;
      skillsRemove: (name: string) => Promise<boolean>;
      skillsGenerate: (name: string, description: string) => Promise<string>;
      skillsAvailableTools: () => Promise<Array<{ namespace: string; label: string; tools: Array<{ name: string; description: string }> }>>;
      skillsListFiles: (name: string) => Promise<string[]>;
      skillsReadFile: (name: string, rel: string) => Promise<string | null>;
      skillsWriteFile: (name: string, rel: string, content: string) => Promise<boolean>;
      skillsDeleteFile: (name: string, rel: string) => Promise<boolean>;
      skillsOpenInEditor: (name: string) => Promise<boolean>;
      skillsOpenFileInEditor: (name: string, rel: string) => Promise<boolean>;
      skillsFileUrl: (name: string, rel: string) => Promise<string>;
      skillsRun: (name: string, input: unknown) => Promise<{ ok: true; output: unknown } | { ok: false; error: string }>;
      skillsCancel: (runId: string) => Promise<boolean>;
      skillsUserResponse: (qid: string, answer: string) => Promise<boolean>;
      skillsRunHistory: (name: string) => Promise<any[]>;
      skillsExport: (name: string) => Promise<string | null>;
      skillsImport: (base64: string, overwrite?: boolean) => Promise<{ imported: string[]; skipped: string[]; error?: string }>;
      skillsScheduleStatus: () => Promise<Array<{ name: string; schedule: string; paused: boolean }>>;
      skillsPauseSchedule: (name: string) => Promise<void>;
      skillsResumeSchedule: (name: string) => Promise<void>;
      onSkillProgress: (cb: (data: { runId: string; event: any }) => void) => void;
      onSkillAskUser: (cb: (data: { runId: string; qid: string; question: string }) => void) => void;
      onSkillsChanged: (cb: () => void) => () => void;
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
      appImport: () => Promise<{ ok: boolean; appId?: string; error?: string }>;
      appExport: (appId: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
      appsSetMcp: (id: string, mcp: { transport: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled: boolean; headers?: Record<string, string>; oauth?: { clientId: string; clientSecret: string; tokenUrl: string; scope?: string } }) => Promise<unknown>;
      appsRemoveMcp: (id: string) => Promise<boolean>;
      appsRemove: (id: string) => Promise<boolean>;
      appsSetConnection: (id: string, pipedreamSlug: string) => Promise<boolean>;
      appsRemoveConnection: (id: string) => Promise<boolean>;
      appsUpdateId: (oldId: string, newId: string) => Promise<boolean>;
      appsUpdateName: (id: string, name: string) => Promise<boolean>;
      appsUpdateUrl: (id: string, url: string) => Promise<boolean>;
      appsUpdateForceWeb: (id: string, forceWeb: boolean) => Promise<boolean>;
      appsUpdateDoNotRecord: (id: string, doNotRecord: boolean) => Promise<boolean>;
      appsUpdateCapturePolicy: (id: string, policy: { type: string; maxVersions?: number; windowHours?: number; minDeltaChars?: number }) => Promise<boolean>;
      appsGetCapturePolicy: (id: string) => Promise<{ type: string; maxVersions?: number; windowHours?: number; minDeltaChars?: number }>;
      appsSetConnectedSlug: (id: string, slug: string | null) => Promise<boolean>;
      appsSetCommand: (id: string, key: string, mapping: { selector: string; action: string; description: string }) => Promise<boolean>;
      appsRemoveCommand: (id: string, key: string) => Promise<boolean>;
      appsTestCommand: (id: string, key: string, wcId?: number) => Promise<string>;
      startPicker: (wcId: number) => void;
      onPickerResult: (cb: (result: { selector: string; tag: string; text: string; isEditable: boolean; isClickable: boolean }) => void) => void;

      // Layouts
      layoutsList: () => Promise<Array<{ name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>>;
      layoutsSave: (name: string, panelIds: string[]) => Promise<boolean>;
      layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>; folderMode?: "single" | "multi" }) => Promise<boolean>;
      layoutsFolderRequired?: (name: string) => Promise<boolean>;
      layoutsDelete: (name: string) => Promise<boolean>;
      pickDirectory: () => Promise<string | null>;
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
      onPreferenceChanged: (cb: (key: string, value: unknown) => void) => void;
      onboardingComplete: () => Promise<void>;

      getAppVersion: () => Promise<string>;
      startAuth: (mode: "register" | "login") => Promise<boolean>;
      isAuthenticated: () => Promise<boolean>;
      authRegister: (email: string) => Promise<{ ok: boolean; error?: string }>;
      authVerifyCode: (email: string, code: string) => Promise<{ ok: boolean; error?: string }>;
      authCompleteProfile: (data: { email: string; firstName: string; lastName: string; password: string; confirmPassword: string; orgName?: string }) => Promise<{ ok: boolean; error?: string }>;
      authLogin: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
      authForgotPassword: (email: string) => Promise<{ ok: boolean; error?: string }>;
      getAccountInfo: () => Promise<{ email: string; firstName: string; lastName: string; role: string; orgName: string; tier: string; billingStatus: string } | null>;
      logout: () => Promise<void>;
      validateApiKey: () => Promise<{ valid: boolean }>;
      getApiKey: () => Promise<null>;
      onBoot: (callback: (data: { authenticated: boolean; status: string; tier?: string; needsOnboarding: boolean; hideWelcome?: boolean; theme?: string }) => void) => void;
      onThemeChanged: (callback: (theme: string) => void) => void;
      onShowOnboarding: (callback: () => void) => void;
      onAccountLocked: (callback: (info: { status: string; upgradeUrl: string }) => void) => void;
      onAccountUnlocked: (callback: () => void) => void;
      recheckAccount: () => Promise<{ status: string }>;
      onOpenSettings: (callback: () => void) => void;
      onFocusInput: (callback: () => void) => void;
      onExecCommandFromPalette: (callback: (cmd: string) => void) => void;
      createAppFromTab: (tabId: string, url: string, name: string) => void;
      onOpenNewApp: (callback: (data: { url?: string; name?: string; tabId?: string }) => void) => void;
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
      onShowDownloadsDropdown: (cb: () => void) => void;
      // Drip effects
      onDripEffect: (callback: (effect: string) => void) => void;
      // Drips CRUD
      dripsList: () => Promise<Array<{ name: string; recipe: string }>>;
      dripsSave: (name: string, recipe: string) => Promise<string>;
      dripsDelete: (name: string) => Promise<string>;
      dripsPreview: (recipe: string) => Promise<string>;
      dripsBuiltinEffects: () => Promise<string[]>;
      // Dashboard
      dashboardToday: (tz?: string) => Promise<any>;
      dashboardHistory: (days?: number, tz?: string) => Promise<any[]>;
      userUsage: (range?: { from?: string; to?: string; tz?: string }) => Promise<{
        credits: { balance: number; grants: number; purchases: number; allowance?: number } | null;
        days: Array<{ day: string; credits: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; requests: number }>;
      }>;
      usageByChat: () => Promise<{ byChat: Record<string, { credits: number; requests: number }> }>;
      agentModels: () => Promise<{ models: Array<{ provider: string; model: string; display_name: string }>; default_model: string | null }>;
      dashboardAllTime: (tz?: string) => Promise<{ agents: Record<string, any>; total: any }>;
      dashboardApps: () => Promise<Array<{ name: string; path: string; modified: string }>>;
      dashboardOpenApp: (name: string) => void;
      dashboardDeleteApp: (name: string) => Promise<boolean>;
      dashboardReminders: () => Promise<Array<{ id: string; message: string; fireAt: number }>>;
      dashboardCancelReminder: (id: string) => Promise<boolean>;
      dashboardLLMInfo: () => Promise<{ provider: string; model: string }>;
      // Prompt log
      promptsList: (offset?: number, limit?: number) => Promise<Array<{ id: string; startTs: number; endTs: number; prompt: string; response: string; inputTokens: number; outputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number; model: string; provider: string; mode: string; toolsUsed: string[] }>>;
      promptsSearch: (query: string, limit?: number) => Promise<Array<{ id: string; startTs: number; endTs: number; prompt: string; response: string; inputTokens: number; outputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number; model: string; provider: string; mode: string; toolsUsed: string[] }>>;
      promptsGet: (id: string) => Promise<{ id: string; startTs: number; endTs: number; prompt: string; response: string; inputTokens: number; outputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number; model: string; provider: string; mode: string; toolsUsed: string[] } | null>;
      promptsCount: () => Promise<number>;
      // Capture store
      capturesStats: () => Promise<{ count: number; sources: Record<string, number>; diskBytes: number; oldestTs: number; newestTs: number; embeddedCount: number; ingestCount: number; searchCount: number; ingestBytes: number }>;
      capturesList: (offset: number, limit: number) => Promise<Array<{ meta: { id: string; source: string; created: number; chunkParent?: string }; snippet: string; size: number }>>;
      capturesRead: (id: string) => Promise<string | null>;
      capturesDelete: (id: string) => Promise<boolean>;
      capturesDeleteBySource: (source: string) => Promise<number>;
      capturesClear: () => Promise<number>;
      capturesSearch: (query: string, limit: number) => Promise<Array<{ meta: { id: string; source: string; created: number }; content: string; score: number }>>;
      capturesDailyHistory: (days?: number) => Promise<Array<{ date: string; count: number; bytes: number }>>;
      capturesEntrySize: (id: string) => Promise<number>;
      capturesStatsForSource: (source: string) => Promise<{ count: number; diskBytes: number; oldestTs: number; newestTs: number; embeddedCount: number }>;
      capturesListForSource: (source: string, offset: number, limit: number) => Promise<Array<{ meta: { id: string; source: string; created: number; chunkParent?: string }; snippet: string; size: number }>>;
      capturesDailyHistoryForSource: (source: string, days?: number) => Promise<Array<{ date: string; count: number; bytes: number }>>;
      // LLM config
      getLLMConfig: () => Promise<{ provider: string; model: string }>;
      getLLMPresets: () => Promise<Record<string, { name: string; models: string[]; defaultModel: string }>>;
      saveLLMConfig: (config: { provider: string; model: string }) => Promise<{ ok: boolean; error?: string }>;
      // Tabs
      tabList: () => Promise<{ tabs: TabInfo[]; activeId: string; visible: boolean }>;
      tabSwitch: (id: string) => void;
      tabClose: (id: string) => void;
      tabCloseAll: () => void;
      tabReorder: (newOrder: string[]) => void;
      tabNew: () => void;
      tabNewApp: (appId: string) => void;
      canvasOpenApp: (appId: string) => void;
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
      transcribeAudio: (audioBuffer: ArrayBuffer) => Promise<{ ok: boolean; text?: string; error?: string }>;
      // Yo agent panel
      yoPanelOpen: (query: string) => void;
      yoPanelSend: (message: string) => void;
      yoPanelDismiss: () => void;
      yoPanelStop: () => void;
      onYoPanelOpen: (cb: (query: string) => void) => void;
      onYoPanelToggle: (cb: () => void) => void;
      onYoPanelKickoff: (cb: (prompt: string) => void) => void;
      onYoPanelToken: (cb: (delta: string) => void) => void;
      onYoPanelToolUse: (cb: (id: string, name: string, input: unknown) => void) => void;
      onYoPanelToolResult: (cb: (id: string, detail: string) => void) => void;
      onYoPanelToolProgress: (cb: (id: string, status: string) => void) => void;
      onYoPanelDone: (cb: (fullText: string) => void) => void;
      onYoPanelBackgroundResult: (cb: (r: { id: string; name: string; ok: boolean; text: string }) => void) => void;
      onYoPanelBgCount: (cb: (count: number) => void) => void;
      onYoPanelError: (cb: (err: string) => void) => void;
      onYoContextUsage: (cb: (info: { used: number; window: number }) => void) => void;
      onYoPanelClose: (cb: () => void) => void;
      onYoPanelRefocus: (cb: () => void) => void;
      yoPanelPrefill: (text: string) => void;
      onYoPanelPrefill: (cb: (text: string) => void) => void;
      openYoChat: (id: string) => void;
      onYoPanelLoadChat: (cb: (id: string) => void) => void;
      // Local swarm — inline activity in the yo panel
      onYoPanelSwarmStart: (cb: (info: { title: string; goal: string; agents: Array<{ id: string; position: string; provider?: string; model?: string }> }) => void) => void;
      onYoPanelSwarmActivity: (cb: (event: { from: string; to?: string; kind: string; body: string; tags?: string[]; ts: number; meta?: Record<string, unknown> }) => void) => void;
      // Cypher chat layer
      onYoPanelChatMsg: (cb: (msg: { from: string; body: string; ts: number; isLocal: boolean }) => void) => void;
      onYoPanelDripEffect: (cb: (recipe: string) => void) => void;
      // Yo panel resize
      yoPanelResize: (width: number) => void;
      yoPanelWidthSave: (width: number) => void;
      yoPanelGetWidth: () => Promise<number>;
      // Files left rail
      filesRailResize: (width: number) => void;
      filesRailWidthSave: (width: number) => void;
      filesRailGetWidth: () => Promise<number>;
      // Recents (rich)
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
      createFile: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
      mkdir: (dirPath: string) => Promise<{ ok: boolean; error?: string }>;
      deleteEntry: (targetPath: string) => Promise<{ ok: boolean; error?: string }>;
      openHomeSection: (section: string, sub?: string) => void;
      onGotoSection: (cb: (section: string, sub?: string) => void) => void;
      getPendingSection: () => Promise<{ section: string; sub?: string } | null>;
      // Yo chat history
      yoChatsList: () => Promise<Array<{ id: string; title: string; created: string; messageCount: number }>>;
      yoChatsLoad: (id: string) => Promise<Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }> | null>;
      yoChatsDelete: (id: string) => Promise<boolean>;
      yoChatNew: () => Promise<boolean>;
      // Agent mode + guardrails
      getAgentMode: () => Promise<{ perm: string; swarm: boolean }>;
      setAgentMode: (mode: string) => void;
      onAgentModeChanged: (cb: (mode: string) => void) => void;
      getToolRegistry: () => Promise<Array<{ name: string; label: string; description: string; tier: string; override: string }>>;
      setToolOverride: (toolName: string, override: string) => void;
      onApprovalRequest: (cb: (id: string, toolName: string, toolLabel: string, input: unknown) => void) => void;
      approvalRespond: (id: string, approved: boolean) => void;
      onYoAskRequest: (cb: (id: string, questions: Array<{
        question: string;
        header?: string;
        options: Array<{ label: string; description?: string; recommended?: boolean; preview?: string }>;
        multiSelect?: boolean;
      }>) => void) => void;
      respondYoAsk: (id: string, answers: Array<string | null>) => void;
      // Connectors (Pipedream Connect)
      connectorsGetApps: (search?: string, offset?: number) => Promise<{ apps: Array<{ id: string; name: string; description: string; icon?: string; categories?: string[] }>; hasMore: boolean }>;
      connectorsGetAccounts: () => Promise<Array<{ id: string; appSlug: string; appName: string; createdAt: string; healthy: boolean }>>;
      connectorsConnect: (appSlug: string) => Promise<{ ok: boolean; error?: string }>;
      connectorsDisconnect: (accountId: string) => Promise<boolean>;
      connectorsRefreshMcp: () => Promise<{ ok: boolean; error?: string; toolCount: number }>;
      connectorsListTools: () => Promise<Array<{ slug: string; name: string; description: string }>>;
      onConnectorsChanged: (cb: () => void) => void;
      // Auto-update
      onUpdateStatus: (cb: (info: { status: string; version?: string; percent?: number; error?: string }) => void) => void;
      updateInstall: () => void;
      checkForUpdates: () => Promise<string | null>;
      // MCP Expose
      mcpExposeStart: () => Promise<{ ok: boolean; error?: string }>;
      mcpExposeStop: () => Promise<void>;
      mcpExposeStatus: () => Promise<{ running: boolean; port: number }>;
      mcpExposeGetTokens: () => Promise<Array<{ token: string; label: string; createdAt: string; expiresAt: string }>>;
      mcpExposeGenToken: (label: string, ttlDays?: number) => Promise<{ token: string; label: string; createdAt: string; expiresAt: string }>;
      mcpExposeRevokeToken: (token: string) => Promise<void>;
      mcpConfigureClient: (client: string) => Promise<{ ok: boolean; configPath?: string; error?: string }>;
      // Remote relay
      relayReconnect: () => Promise<void>;
      relayStatus: () => Promise<{ enabled: boolean; signedIn: boolean; state: "off" | "connecting" | "connected" | "disconnected" }>;
      relayTokensList: () => Promise<Array<{ id: string; label: string; type: string; userId: string | null; createdAt: string; expiresAt: string }> | { error: string }>;
      relayTokensCreate: (label: string) => Promise<{ ok: boolean; id: string; token: string; expiresAt: string } | { error: string }>;
      relayTokensRevoke: (id: string) => Promise<{ ok: boolean } | { error: string }>;
      relayInstallClaude: (token: string) => Promise<{ ok: boolean; path: string } | { error: string }>;

      // BYOK provider keys (Phase 1 of THE-PIVOT-BYOK)
      providerKeysList: () => Promise<Array<{
        provider: string;
        configured: boolean;
        savedAt: string | null;
        lastTested: string | null;
        lastTestOk: boolean | null;
        lastTestError: string | null;
      }>>;
      providerKeysSet: (provider: string, key: string) => Promise<{ ok: boolean; error?: string }>;
      providerKeysRemove: (provider: string) => Promise<{ ok: boolean }>;
      providerKeysTest: (provider: string) => Promise<{ ok: boolean; error?: string }>;
      providerKeysTestPrompt: (provider: string, model?: string, prompt?: string) => Promise<{ ok: boolean; text?: string; model?: string; error?: string }>;
      providerModelsGetAll: () => Promise<Record<string, { default: string; models: string[] }>>;
      providerModelsSet: (provider: string, models: string[], def?: string) => Promise<{ default: string; models: string[] }>;
      providerModelsReset: (provider: string) => Promise<{ default: string; models: string[] }>;

      // BYOK gate — Anthropic API key configured under Settings → Providers.
      ccStatus: () => Promise<{ found: boolean; byokAnthropic: boolean }>;
      onCcShowModal: (callback: () => void) => () => void;
      // Capability Offer
      capabilitiesSetEnabled: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean; derived_tier?: string; client_id?: string; error?: string }>;
      capabilitiesGetStatus: () => Promise<{ enabled: boolean; client_id: string; derived_tier: string | null; report: unknown }>;
      // Agents
      agentsList: () => Promise<unknown[]>;
      agentsGet: (id: string) => Promise<unknown>;
      agentsSave: (cfg: unknown) => Promise<unknown>;
      agentsRemove: (id: string) => Promise<boolean>;
      agentsIdAvailable: (id: string) => Promise<boolean>;
      // Vibes — persisted vibe-coding projects
      vibesList: () => Promise<Array<Record<string, unknown>>>;
      vibesGet: (id: string) => Promise<Record<string, unknown> | null>;
      vibesCreate: (name: string, description?: string) => Promise<Record<string, unknown>>;
      vibesDelete: (id: string) => Promise<boolean>;
      vibesOpen: (id: string) => Promise<Record<string, unknown> | null>;
      vibesPlan: (id: string, goal: string) => Promise<{ ok: boolean; error?: string }>;
      vibesPlanWithCouncil: (id: string, goal: string) => Promise<{ ok: boolean; error?: string; fellBack?: boolean }>;
      vibesShip: (id: string) => Promise<{ ok: boolean; appId?: string; error?: string }>;
      // yos wallet
      yosBalance: () => Promise<{ user_id: string; balance: number } | { error: string }>;
      yosRateCards: () => Promise<{ cards: Array<{ tier: string; yos_per_1k_input: number; yos_per_1k_output: number; yos_per_idle_minute: number }> } | { error: string }>;
      modelsList: () => Promise<{ models: Array<{ provider: string; model: string; display_name: string; yos_per_1k_input: number; yos_per_1k_output: number }> } | { error: string }>;
      yosBuyUrl: () => Promise<{ url: string }>;
      // Marketplace + reservations
      marketplaceAvailable: (opts?: { tier?: string; provider?: string; limit?: number }) => Promise<{ entries: Array<{ offer_handle: string; derived_tier: string; providers: string[]; pricing: { terms: string; tier: string; yos_per_1k_input?: number; yos_per_1k_output?: number } | null; last_seen_at: string }>; count: number; ts: string } | { error: string }>;
      agentsLeaderboard: (opts?: { skills?: string; days?: number; limit?: number }) => Promise<{
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
      } | { error: string }>;
      reservationCreate: (body: { provider_handle: string; idle_minutes: number; guardrails?: unknown }) => Promise<{ ok: boolean; reservation?: { id: string; status: string; idle_budget_yos: number; release_at: string }; buyer_balance_after?: number; error?: string }>;
      reservationRelease: (id: string, reason?: string) => Promise<{ ok: boolean; reservation?: unknown; buyer_balance_after?: number; idle_yos_settled?: number; provider_earned?: number; error?: string }>;
      reservationList: (opts?: { status?: string }) => Promise<{ reservations: Array<{ id: string; provider_client_id: string; status: string; idle_budget_yos: number; idle_yos_used: number; release_at: string; reserved_at: string }>; count: number } | { error: string }>;
      // Cyphers
      cypherCreate: (input: Record<string, unknown>) => Promise<{ ok: boolean; cypher?: { id: string; slug: string; status: string; type: string; visibility: string; title: string }; error?: string }>;
      cypherUpdate: (id: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; cypher?: unknown; error?: string }>;
      cypherPublish: (id: string, opts?: { initial_kitty_deposit?: number; lobby_duration_seconds?: number | null }) => Promise<{ ok: boolean; cypher?: { id: string; slug: string; status: string }; kitty_balance?: number; error?: string }>;
      cypherStart: (id: string) => Promise<{ ok: boolean; cypher?: { id: string; slug: string; status: string }; error?: string }>;
      cypherWrap: (id: string) => Promise<{ ok: boolean; cypher?: { id: string; status: string }; refunds?: Array<{ user_id: string; amount: number }>; error?: string }>;
      cypherCancel: (id: string) => Promise<{ ok: boolean; cypher?: unknown; error?: string }>;
      cypherDiscover: (opts?: { status?: string; type?: string; limit?: number; offset?: number }) => Promise<{ cyphers: Array<{ id: string; slug: string; title: string; description: string | null; type: string; status: string; visibility: string; max_jammers: number | null; created_at: string }>; count: number } | { error: string }>;
      cypherListMine: () => Promise<{ cyphers: Array<{ id: string; slug: string; title: string; type: string; status: string; visibility: string; created_at: string; updated_at: string }>; count: number } | { error: string }>;
      cypherGet: (id: string) => Promise<{ cypher: { id: string; slug: string; title: string; description: string | null; goal: string | null; type: string; status: string; visibility: string; max_jammers: number | null; min_tier: string | null; requirements: { skills?: string[]; apps?: string[]; mcp_servers?: string[]; model_provider?: string; min_tier?: string }; sensitivity: string; owner_user_id: string; created_at: string; started_at: string | null; ended_at: string | null }; kitty_balance: number } | { error: string }>;
      cypherGetBySlug: (slug: string) => Promise<{ cypher: unknown } | { error: string }>;
      cypherJoin: (id: string, agent_local_id: string, role?: string, invite_token?: string) => Promise<{ ok: boolean; cypher?: unknown; cohort_size?: number; error?: string }>;
      cypherInviteMint: (id: string, opts?: { role?: string; ttl_seconds?: number; multi_use?: boolean; invitee_user_id?: string }) => Promise<{ ok: boolean; invite?: { jti: string; cypher_id: string; role: string; multi_use: boolean; expires_at: string; invitee_user_id: string | null; revoked_at: string | null; used_at: string | null }; token?: string; error?: string }>;
      cypherInviteList: (id: string) => Promise<{ invites: Array<{ jti: string; role: string; multi_use: boolean; expires_at: string; invitee_user_id: string | null; revoked_at: string | null; used_at: string | null; used_by_user_id: string | null; created_at: string }>; count: number } | { error: string }>;
      cypherInviteRevoke: (id: string, jti: string) => Promise<{ ok: boolean; invite?: unknown; error?: string }>;
      cypherLeave: (id: string, agent_local_id: string) => Promise<{ ok: boolean }>;
      cypherJammers: (id: string) => Promise<{ jammers: Array<{ user_id: string; agent_local_id: string; role: string; joined_at: string; left_at: string | null }>; count: number } | { error: string }>;
      cypherJamsList: (id: string) => Promise<{ jams: Array<{ id: string; slug: string; title: string; description: string | null; state_doc: unknown; state_version: string }>; count: number } | { error: string }>;
      cypherJamCreate: (id: string, slug: string, title: string, description?: string) => Promise<{ ok: boolean; jam?: { id: string; slug: string }; error?: string }>;
      cypherJamSetState: (id: string, jam_id: string, expected_version: number, state: unknown) => Promise<{ ok: boolean; version?: number; error?: string }>;
      cypherEventPost: (id: string, kind: string, payload: unknown, jam_id?: string, by_agent_id?: string) => Promise<{ ok: boolean; event?: { id: string; seq: string }; error?: string }>;
      cypherEventsList: (id: string, opts?: { since?: number; jam_id?: string; limit?: number }) => Promise<{ events: Array<{ id: string; seq: string; kind: string; jam_id: string | null; by_user_id: string | null; by_agent_id: string | null; payload: unknown; created_at: string }>; count: number } | { error: string }>;
      cypherKittyDeposit: (id: string, amount: number) => Promise<{ ok: boolean; kitty_balance?: number; user_balance?: number; error?: string }>;
      cypherKittyBalance: (id: string) => Promise<{ balance: number } | { error: string }>;
      cypherKittyLedger: (id: string, opts?: { limit?: number }) => Promise<{ entries: Array<{ id: string; user_id: string; delta: number; kind: string; description: string | null; created_at: string }>; count: number } | { error: string }>;
      // MCP Servers (custom user-configured)
      mcpGetServers: () => Promise<Array<{ config: { id: string; name: string; transport: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled: boolean }; status: string; error?: string; tools: Array<{ name: string; description?: string }> }>>;
      mcpAddServer: (config: Record<string, unknown>) => Promise<void>;
      mcpUpdateServer: (id: string, updates: Record<string, unknown>) => Promise<void>;
      mcpRemoveServer: (id: string) => Promise<void>;
      mcpConnectServer: (id: string) => Promise<{ ok: boolean; error?: string }>;
      mcpDisconnectServer: (id: string) => Promise<void>;
      mcpGetToolOverride: (serverId: string, toolName: string) => Promise<string>;
      mcpSetToolOverride: (serverId: string, toolName: string, override: string) => void;
      mcpSetServerOverride: (serverId: string, override: string) => void;
      onMcpChanged: (cb: () => void) => void;
      onAppsChanged: (cb: () => void) => void;
      // Schedules (skill-runs history + keep-awake)
      runsList: (skillName?: string) => Promise<Array<{ id: string; skillName: string; title: string; created: string; trigger: string; ok: boolean }>>;
      setKeepAwake: (on: boolean) => void;
      schedulesList: () => Promise<Array<Record<string, unknown>>>;
      schedulesGet: (id: string) => Promise<Record<string, unknown> | null>;
      schedulesSave: (cfg: Record<string, unknown>) => Promise<Record<string, unknown>>;
      schedulesDelete: (id: string) => Promise<boolean>;
      schedulesRun: (id: string) => Promise<void>;
      schedulesPause: (id: string) => Promise<void>;
      schedulesResume: (id: string) => Promise<void>;
      schedulesDeleteRuns: (name: string) => Promise<number>;
      councilsList: () => Promise<Array<Record<string, unknown>>>;
      councilsGet: (id: string) => Promise<Record<string, unknown> | null>;
      councilsSave: (cfg: Record<string, unknown>) => Promise<Record<string, unknown>>;
      councilsDelete: (id: string) => Promise<boolean>;
      councilsRun: (id: string, live?: boolean) => Promise<{ ok: boolean; error?: string; message?: string; runId?: string }>;
      councilsRuns: (id: string) => Promise<Array<Record<string, unknown>>>;
      councilsRunGet: (id: string, runId: string) => Promise<Record<string, unknown> | null>;
      councilsScheduleStatus: () => Promise<Array<{ id: string; schedule: string; paused: boolean }>>;
      councilsPauseSchedule: (id: string) => Promise<void>;
      councilsResumeSchedule: (id: string) => Promise<void>;
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


// -- Yo panel (extracted to yo-panel-ui.ts) --
const { openYoPanel, closeYoPanel, isYoPanelOpen, yoScroll, showYoWelcome, hideYoWelcome, getYoPanelWidth } = initYoPanel({
  renderGridHandles: () => gridApi.renderGridHandles(),
});

// Right-rail toggle in the header — slides the yo agent panel in/out.
document.getElementById("yo-rail-toggle")?.addEventListener("click", () => {
  if (isYoPanelOpen()) {
    window.yo.yoPanelDismiss();
  } else {
    window.yo.yoPanelOpen("");
    openYoPanel("");
  }
  // Yo panel open/close is also rail "content" — re-evaluate empty state.
  setTimeout(() => tabApi.refreshEmptyState(), 250);
});

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


// -- Cmd+. opens yo agent panel --

// focus-command-input from main → open agent panel
window.yo.onFocusInput(() => {
  if (!isYoPanelOpen()) {
    window.yo.yoPanelOpen("");
    openYoPanel("");
  }
});



// Commands submitted from the palette child window
window.yo.onExecCommandFromPalette((cmd) => window.yo.execCommand(cmd));

// -- Global keyboard shortcuts --

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (isYoPanelOpen()) window.yo.yoPanelDismiss();
  }

  // Cmd+Shift+. — toggle the Command Center (zoom-out view of all open apps)
  if (e.key === "." && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    e.preventDefault();
    commandCenter.toggle();
    return;
  }

  // Cmd+. (without shift) — toggle yo agent panel
  if (e.key === "." && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
    e.preventDefault();
    if (isYoPanelOpen()) {
      window.yo.yoPanelDismiss();
    } else {
      window.yo.yoPanelOpen("");
      openYoPanel("");
    }
    return;
  }

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


// Open a system/user app in the workspace. In canvas mode each app is a
// free-floating window, so route through canvasOpenApp; otherwise open a tab.
// Keep every "app tray" entry point (nav rail, header gear, settings signal)
// going through here so they all respect the active layout mode.
function openWorkspaceApp(slug: string): void {
  if (document.body.classList.contains("canvas-mode")) window.yo.canvasOpenApp(slug);
  else window.yo.tabNewApp(slug);
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
// A canvas window's URL-bar download button opens this dropdown (the list
// always lives here regardless of which panel triggered the download).
window.yo.onShowDownloadsDropdown(() => { document.getElementById("dl-btn")?.click(); });
initSearchClears();

// -- Canvas mode + Command Center --
initCanvas();
const commandCenter = initCommandCenter();
// Header Command Center launcher (zoom-out view of all open apps + layouts).
document.getElementById("header-command-center")?.addEventListener("click", () => commandCenter.toggle());

// -- Left rail: working-folder picker + app navigation --
{
  const rail = document.getElementById("files-rail")!;
  const railToggle = document.getElementById("files-rail-toggle")!;
  const railResize = document.getElementById("files-rail-resize")!;

  let railWidth = 240;

  // Measure the chrome before #tab-bar inside #titlebar so the first tab can
  // line up with the rail's right edge regardless of label width / font.
  // Sets --tabbar-chrome-w which the #tab-bar's padding-left calc consumes.
  function measureTabbarChromeWidth(): void {
    const tabBarEl = document.getElementById("tab-bar");
    if (!tabBarEl) return;
    const r = tabBarEl.getBoundingClientRect();
    document.body.style.setProperty("--tabbar-chrome-w", `${Math.round(r.left)}px`);
  }
  measureTabbarChromeWidth();
  window.addEventListener("resize", measureTabbarChromeWidth);

  const setInset = (px: number) => {
    document.body.style.setProperty("--left-inset", `${px}px`);
    window.yo.filesRailResize(px);
    // Reposition any split drag-handles to track the new content offset.
    gridApi.renderGridHandles();
  };

  function applyOpen(open: boolean) {
    railToggle.classList.toggle("active", open);
    if (open) {
      rail.classList.remove("hidden");
      void rail.offsetHeight;
      rail.classList.add("open");
      setInset(railWidth);
    } else {
      rail.classList.remove("open");
      setInset(0);
      setTimeout(() => rail.classList.add("hidden"), 200);
    }
    try { localStorage.setItem("filesRailOpen", open ? "1" : "0"); } catch {}
    tabApi.refreshEmptyState();
  }

  railToggle.addEventListener("click", () => applyOpen(!rail.classList.contains("open")));

  // Nav: each rail button opens the matching yo://<slug> system app in a
  // panel. The data-section value (dashboard, apps, agents, vibes, councils,
  // schedules, layouts, skills, drips) IS the app slug — they're registered
  // as INTERNAL_APPS with kind:"system" in app-connector.ts and routed in
  // main.ts. Same mechanism .dip uses, so there's one entry point per app.
  rail.querySelectorAll<HTMLElement>(".files-rail-navitem[data-section]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const slug = btn.dataset.section;
      if (slug) openWorkspaceApp(slug);
    });
  });
  document.getElementById("files-rail-logout")?.addEventListener("click", () => {
    void window.yo.logout();
  });
  // Resize handle.
  let dragging = false;
  railResize.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    railResize.classList.add("dragging");
    rail.style.transition = "none";
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    railWidth = Math.max(160, Math.min(window.innerWidth * 0.4, e.clientX));
    rail.style.width = `${railWidth}px`;
    setInset(railWidth);
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    railResize.classList.remove("dragging");
    rail.style.transition = "";
    window.yo.filesRailWidthSave(railWidth);
  });

  void (async () => {
    railWidth = await window.yo.filesRailGetWidth().catch(() => 240);
    rail.style.width = `${railWidth}px`;
    let savedOpen: string | null = null;
    try { savedOpen = localStorage.getItem("filesRailOpen"); } catch { /* ignore */ }
    applyOpen(savedOpen !== "0"); // default open
  })();

  // ── Rail Recents (bottom pane) ───────────────────────────────────
  // App-centric: shows the last 10 distinct apps the user has opened, with the
  // app's icon (favicon for web apps, initial for yo:// internal). Grid
  // layout — at least 2 wide, expands to fill the rail's width.
  type RailRecent = { kind: "app" | "layout"; id: string; name: string; folder: string; ts: number };
  type AppMeta = { id: string; name: string; url?: string };
  const railNav = document.getElementById("files-rail-nav")!;
  const railSplitHandle = document.getElementById("rail-split-handle")!;

  // Shared icon renderer (favicon for web apps, initial for yo:// internal).
  function iconHtml(app: RailRecent, meta?: AppMeta): string {
    const initial = (meta?.name || app.name).charAt(0).toUpperCase();
    const url = meta?.url || "";
    const isWeb = url && !url.startsWith("yo://") && !url.startsWith("file://");
    if (isWeb) {
      try {
        const host = new URL(url).hostname;
        const fav = `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
        return `<img class="rail-recents-icon-img" src="${fav}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><span class="rail-recents-icon-initial" style="display:none">${initial}</span>`;
      } catch { /* malformed URL — fall through */ }
    }
    return `<span class="rail-recents-icon-initial">${initial}</span>`;
  }

  // ── Apps section — every openable app, alphabetical, click to open ──
  // (canvas-aware). This is the canvas-mode stand-in for the `+` picker.
  const railAppsListEl = document.getElementById("rail-apps-list");
  const railAppsSearch = document.getElementById("rail-apps-search") as HTMLInputElement | null;
  let railAppsAll: Array<{ id: string; name: string; url?: string }> = [];
  let railAppsQuery = "";
  function renderRailAppsList(): void {
    if (!railAppsListEl) return;
    const q = railAppsQuery.trim().toLowerCase();
    const list = railAppsAll.filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q));
    railAppsListEl.innerHTML = "";
    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rail-recents-empty";
      empty.textContent = q ? `No apps matching "${railAppsQuery}".` : "No apps.";
      railAppsListEl.appendChild(empty);
      return;
    }
    for (const app of list) {
      const entry: RailRecent = { kind: "app", id: app.id, name: app.name, folder: "", ts: 0 };
      const meta: AppMeta = { id: app.id, name: app.name, url: app.url };
      const cell = document.createElement("button");
      cell.className = "rail-recents-cell";
      cell.type = "button";
      cell.title = app.name;
      cell.innerHTML = `<div class="rail-recents-icon">${iconHtml(entry, meta)}</div><div class="rail-recents-name"></div>`;
      (cell.querySelector(".rail-recents-name") as HTMLElement).textContent = app.name;
      cell.addEventListener("click", () => openWorkspaceApp(app.id));
      railAppsListEl.appendChild(cell);
    }
  }
  async function refreshRailAppsSection(): Promise<void> {
    let apps: Array<{ id: string; name: string; url?: string }> = [];
    try { apps = await window.yo.appsListMountable(); } catch { /* leave empty */ }
    // Only real, openable apps (drops stale/removed entries without a URL), A→Z.
    railAppsAll = apps
      .filter((a) => !!a.url)
      .sort((a, b) => a.name.localeCompare(b.name));
    renderRailAppsList();
  }
  railAppsSearch?.addEventListener("input", () => { railAppsQuery = railAppsSearch.value; renderRailAppsList(); });
  // The header's open icon launches the Apps management page.
  document.getElementById("rail-apps-open")?.addEventListener("click", () => openWorkspaceApp("apps"));
  window.yo.onAppsChanged?.(() => { void refreshRailAppsSection(); });
  void refreshRailAppsSection();

  // Left-rail user section (bottom) — signed-in name/avatar + an upward menu
  // with Settings / Manage Account / Sign out.
  (function initRailUser() {
    const wrap = document.getElementById("files-rail-user");
    const btn = document.getElementById("files-rail-user-btn");
    const menu = document.getElementById("files-rail-user-menu");
    if (!wrap || !btn || !menu) return;
    const avatar = document.getElementById("files-rail-user-avatar");
    const nameEl = document.getElementById("files-rail-user-name");
    const subEl = document.getElementById("files-rail-user-sub");

    void window.yo.getAccountInfo().then((info) => {
      if (!info) return;
      const name = `${info.firstName || ""} ${info.lastName || ""}`.trim() || info.email;
      const initials = ((info.firstName?.[0] || "") + (info.lastName?.[0] || "")).toUpperCase()
        || (info.email?.[0] || "?").toUpperCase();
      if (nameEl) nameEl.textContent = name || "Account";
      if (subEl) subEl.textContent = info.email || info.orgName || "";
      if (avatar) avatar.textContent = initials;
    }).catch(() => {});

    const close = () => { menu.classList.add("hidden"); wrap.classList.remove("open"); };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menu.classList.contains("hidden")) { menu.classList.remove("hidden"); wrap.classList.add("open"); }
      else close();
    });
    document.addEventListener("click", (e) => { if (!wrap.contains(e.target as Node)) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    menu.querySelectorAll<HTMLButtonElement>(".files-rail-user-item").forEach((item) => {
      item.addEventListener("click", () => {
        close();
        const act = item.dataset.act;
        if (act === "settings") openWorkspaceApp("settings");
        else if (act === "account") void window.yo.execCommand(`dip ${window.yo.platformUrl}`);
        else if (act === "logout") void window.yo.logout();
      });
    });
  })();

  // ── Rail split: draggable divider between nav and Apps ──
  //  - leftRailSplit (px): height of the top nav pane (Apps takes the rest,
  //    Workspaces removed).
  let navH = 280;
  let splitDragging = false;
  const applyNavHeight = (px: number): void => { rail.style.setProperty("--rail-nav-h", `${Math.max(80, px)}px`); };
  void (async () => {
    const savedNav = await window.yo.getPreference("leftRailSplit", 280);
    if (typeof savedNav === "number" && savedNav > 0) navH = savedNav;
    applyNavHeight(navH);
  })();
  railSplitHandle.addEventListener("mousedown", (e) => {
    e.preventDefault(); splitDragging = true; railSplitHandle.classList.add("dragging"); document.body.style.cursor = "row-resize";
  });
  document.addEventListener("mousemove", (e) => {
    if (!splitDragging) return;
    const railRect = rail.getBoundingClientRect();
    const relY = e.clientY - railRect.top;
    navH = Math.max(80, Math.min(railRect.height - 200, relY));
    applyNavHeight(navH);
  });
  document.addEventListener("mouseup", () => {
    if (!splitDragging) return;
    splitDragging = false;
    railSplitHandle.classList.remove("dragging");
    document.body.style.cursor = "";
    void window.yo.setPreference("leftRailSplit", navH);
  });

  // Silence the unused-var warning for railNav — used implicitly via DOM.
  void railNav;
}

// -- Update bar --

const updateBar = document.getElementById("update-bar")!;
const updateMsg = document.getElementById("update-message")!;
const updateProgress = document.getElementById("update-progress")!;
const updateFill = document.getElementById("update-progress-fill")!;
const updateAction = document.getElementById("update-action")!;
const updateDismiss = document.getElementById("update-dismiss")!;

window.yo.onUpdateStatus(({ status, version, percent, error }) => {
  if (status === "available") {
    updateMsg.textContent = `Downloading v${version}...`;
    updateProgress.classList.remove("hidden");
    updateAction.classList.add("hidden");
    updateBar.classList.remove("hidden");
  } else if (status === "downloading") {
    updateFill.style.width = `${percent || 0}%`;
  } else if (status === "ready") {
    updateMsg.textContent = `v${version} ready — restart to update`;
    updateProgress.classList.add("hidden");
    updateAction.classList.remove("hidden");
    updateBar.classList.remove("hidden");
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


// -- First-run: auto-open the yo agent panel --
// On the very first launch — after the splash, and after onboarding for a
// brand-new user — drop the user straight into the yo agent so the assistant
// is the first thing they reach for. Once-only, guarded by a preference.
function maybeAutoOpenYoPanel(): void {
  window.yo.getPreference("hasAutoOpenedYoPanel", false).then((opened) => {
    if (opened) return;
    window.yo.setPreference("hasAutoOpenedYoPanel", true);
    setTimeout(() => {
      if (!isYoPanelOpen()) {
        window.yo.yoPanelOpen("");
        openYoPanel("");
      }
    }, 1200);
  });
}

// Brand-new user: fires once onboarding activation completes.
window.addEventListener("yo-onboarding-done", () => {
  setTimeout(maybeAutoOpenYoPanel, 800);
});

// -- Boot gate --

initBootGate({
  onBootReady: (data) => {
    // Returning/authenticated user's first launch with this build — a
    // brand-new user reaches this via the yo-onboarding-done path instead.
    if (!data.needsOnboarding) maybeAutoOpenYoPanel();
  },
  showPanels: () => window.yo.panelsShow(),
  hidePanels: () => window.yo.panelsHide(),
  applyTheme: (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("yoTheme", theme); } catch {}
  },
  showOnboarding: (requiresAuth) => showOnboarding(requiresAuth),
});
