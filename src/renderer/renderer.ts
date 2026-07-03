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
  url: string | null;
  forceWeb: boolean;
  // Browser ↔ Native model (pivot-mcp) — see preload.ts SavedPanelApp.
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
};

// Mirrors preload.ts PanelAppInput — fields forwarded to /api/panel-apps.
type PanelAppInput = {
  name?: string;
  slug?: string;
  url?: string | null;
  forceWeb?: boolean;
  isBrowser?: boolean;
  browserTarget?: "webview" | "native";
  execPath?: string | null;
  appArchetype?: string | null;
  launchConfig?: Record<string, unknown> | null;
};

declare global {
  interface Window {
    yo: {
      copyToClipboard: (text: string) => void;
      commandToggle: () => void;
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
      appWindowOpen: (spec: { slug: string; name: string; url: string; forceWeb?: boolean }) => Promise<{ ok: boolean; error?: string }>;
      appFileIcon: (execPath: string) => Promise<string>;
      appLaunch: (spec: {
        slug: string; name: string; url?: string | null; forceWeb?: boolean;
        isBrowser?: boolean; browserTarget?: "webview" | "native";
        execPath?: string | null; appArchetype?: string | null;
        launchConfig?: Record<string, unknown> | null;
      }) => Promise<{ ok: boolean; error?: string }>;
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
      panelAppsCreate: (input: PanelAppInput) => Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>;
      panelAppsUpdate: (id: string, patch: PanelAppInput) => Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>;
      panelAppsDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
      panelAppsSetConnection: (id: string, pipedreamSlug: string) => Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>;
      panelAppsRemoveConnection: (id: string) => Promise<{ ok: boolean; error?: string }>;
      panelAppsSetMcp: (id: string, mcp: Record<string, unknown>) => Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>;
      panelAppsRemoveMcp: (id: string) => Promise<{ ok: boolean; error?: string }>;
      panelAppsSetCommand: (id: string, key: string, mapping: Record<string, unknown>) => Promise<{ ok: boolean; app?: SavedPanelApp; error?: string }>;
      panelAppsRemoveCommand: (id: string, key: string) => Promise<{ ok: boolean; error?: string }>;
      appSecretsList: (id: string) => Promise<{ ok: boolean; secrets?: Array<{ key: string; at: string }>; error?: string }>;
      appSecretsSet: (id: string, key: string, value: string) => Promise<{ ok: boolean; error?: string }>;
      appSecretsDelete: (id: string, key: string) => Promise<{ ok: boolean; error?: string }>;
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
      appsSetConnectedSlug: (id: string, slug: string | null) => Promise<boolean>;
      appsSetCommand: (id: string, key: string, mapping: { selector: string; action: string; description: string }) => Promise<boolean>;
      appsRemoveCommand: (id: string, key: string) => Promise<boolean>;
      appsTestCommand: (mapping: { selector: string; action: string; description?: string; text?: string } | null, wcId?: number) => Promise<string>;
      startPicker: (wcId: number) => void;
      onPickerResult: (cb: (result: { selector: string; tag: string; text: string; isEditable: boolean; isClickable: boolean }) => void) => void;

      // Layouts
      layoutsList: () => Promise<Array<{ name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>>;
      layoutsOpen: (name: string) => Promise<{ ok: boolean; error?: string }>;
      layoutsSave: (name: string, panelIds: string[]) => Promise<boolean>;
      layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>; folderMode?: "single" | "multi" }) => Promise<boolean>;
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
      userTimezoneGet: () => Promise<string | null>;
      userTimezoneSet: (tz: string) => Promise<{ ok: boolean; error?: string }>;
      logout: () => Promise<void>;
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
      // Auto-update
      onUpdateStatus: (cb: (info: { status: string; version?: string; percent?: number; error?: string }) => void) => void;
      updateInstall: () => void;
      checkForUpdates: () => Promise<string | null>;
      getUpdateStatus: () => Promise<{ version: string; ready: boolean } | null>;
      // Remote relay
      relayReconnect: () => Promise<void>;
      relayStatus: () => Promise<{ enabled: boolean; signedIn: boolean; state: "off" | "connecting" | "connected" | "disconnected" }>;
      relayTokensList: () => Promise<Array<{ id: string; label: string; type: string; userId: string | null; createdAt: string; expiresAt: string }> | { error: string }>;
      relayTokensCreate: (label: string) => Promise<{ ok: boolean; id: string; token: string; expiresAt: string } | { error: string }>;
      relayTokensRevoke: (id: string) => Promise<{ ok: boolean } | { error: string }>;
      relayInstallClaude: (token: string) => Promise<{ ok: boolean; path: string } | { error: string }>;

      // Local MCP server (127.0.0.1)
      localMcpSetEnabled: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
      localMcpStatus: () => Promise<{ running: boolean; port: number }>;
      localMcpSetPort: (port: number) => Promise<{ ok: boolean; error?: string }>;
      localMcpTokensList: () => Promise<Array<{ id: string; label: string; createdAt: string; expiresAt: string }>>;
      localMcpTokensCreate: (label: string) => Promise<{ id: string; label: string; token: string; createdAt: string; expiresAt: string }>;
      localMcpTokensRevoke: (id: string) => Promise<{ ok: boolean }>;

      // BYOK provider key — only the Claude Code bootstrap gate path remains.

      // BYOK gate — Anthropic API key saved via the Claude Code bootstrap gate.
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
document.getElementById("titlebar-logout")?.addEventListener("click", () => { void window.yo.logout(); });
document.getElementById("header-command-center")?.addEventListener("click", () => window.yo.commandToggle());

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
let dashboardInitialized = false;
function initDashboard(): void {
  document.getElementById("files-rail")?.classList.add("dashboard-hidden");
  document.getElementById("tab-bar")?.classList.add("dashboard-hidden");
  const tabs = document.getElementById("dashboard-tabs");
  tabs?.classList.remove("hidden");

  if (dashboardInitialized) return;
  dashboardInitialized = true;

  type DashSlug = "apps" | "layouts" | "drips" | "skills" | "settings" | "about";
  const setActive = (slug: DashSlug) => {
    for (const s of ["apps", "layouts", "drips", "skills", "settings", "about"] as DashSlug[]) {
      document.getElementById(`dashboard-tab-${s}`)?.classList.toggle("active", slug === s);
    }
  };

  // Each tab opens its matching yo:// system-app panel (home.html?section=…).
  const wireTab = (slug: DashSlug, appId: string) => {
    document.getElementById(`dashboard-tab-${slug}`)?.addEventListener("click", () => {
      setActive(slug);
      openWorkspaceApp(appId);
    });
  };
  wireTab("apps", "apps");
  wireTab("layouts", "layouts");
  wireTab("drips", "drips");
  wireTab("skills", "skills");
  wireTab("settings", "dashboard-settings");
  wireTab("about", "about");

  // Land on Apps by default — just the tab styling. Main already opened and
  // activated the "apps" panel directly at boot (openAppsPanelOnly() in
  // main.ts); calling openWorkspaceApp("apps") here too raced it into
  // opening a SECOND "apps" instance (tabNewApp doesn't know the boot-time
  // one exists), which was the extra flash/transition after the splash.
  setActive("apps");
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
