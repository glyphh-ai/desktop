/**
 * Yo — Electron main process.
 *
 * Boots the app, registers the global hotkey, creates the
 * overlay window, and wires up panels + commands.
 */

import "dotenv/config";

// Fix process.cwd() in packaged Electron apps — .asar is a file, not a directory,
// which causes ENOTDIR when child_process.spawn inherits cwd.
import os from "os";
try {
  const cwd = process.cwd();
  if (cwd.includes(".asar") || !require("fs").statSync(cwd).isDirectory()) {
    process.chdir(os.homedir());
  }
} catch {
  process.chdir(os.homedir());
}

import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeTheme, net, protocol, session as electronSession, shell, systemPreferences, webContents } from "electron";

// Stop Chromium from encrypting its own internal cookie/session storage via
// the OS keychain ("Chrome Safe Storage" on macOS). This is separate from
// anything our own code does (provider-keys.ts, auth.ts, app-connector.ts
// all avoid safeStorage already) — it's Chromium's automatic behavior for
// ANY persistent session partition (e.g. `persist:yo`, used by webviews and
// browser tabs), and it's what was still triggering a keychain prompt on
// every launch. In an unsigned/dev build, macOS can't remember the "Always
// Allow" grant across relaunches (the app's signature changes each build),
// so it re-prompts every single time. Must be set before app is ready.
app.commandLine.appendSwitch("use-mock-keychain");

import path from "path";
import fs from "fs";
import { PanelManager } from "./panel-manager";
import { TerminalManager, AgentSpawnConfig } from "./terminal";
import { CommandParser } from "./command-parser";
import { registerHotkey } from "./hotkey";
import { isAuthenticated, initAuth, startAuthFlow, getAuthStatus, getAccountInfo, logout, cleanupAuthTimers, refreshHeartbeat, setHeartbeatObserver, setReauthHandler, PLATFORM_URL, serverPostAuthed, serverGetAuthed, getAuthToken } from "./auth";
import { CloudSync } from "./cloud-sync";
import { loadLLMConfig, saveLLMConfig, LLMConfig } from "./llm-config";
import { LayoutManager } from "./layout-manager";
import { AppConnector } from "./app-connector";
import { canAddApp, canSaveLayout, canUseMcp, canUseSync, canUseVoice, getCurrentLimits } from "./entitlements";
import { executeCommand } from "./dom-bridge";
import { getPreference, setPreference } from "./stores/preferences-db";
import { YoInterceptor } from "./yo-interceptor";
import { YoChat } from "./yo-chat";
import * as providerKeysModule from "./provider-keys";
import { bootstrapStatus as ccBootstrapStatus } from "./cc-bootstrap";
import { SessionCache } from "./session-cache";
import { NoteStore } from "./note-store";
import { Transcriber } from "./transcriber";
import { VoiceRelay } from "./voice-relay";
import { smartGrab } from "./smart-grab";
import { resolveShellPath } from "./shell-path";
import { autoUpdater } from "electron-updater";

/** True if semver `latest` is strictly newer than `current` (major.minor.patch). */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}
import { ConfigSync } from "./config-sync";
import { reloadRemotePatterns } from "./firewall";
import { usageTracker } from "./usage-tracker";
import { promptLog } from "./prompt-log";
import { startOverlay } from "./overlay-bridge";
import { registerCommandWindow, disposeCommandWindow } from "./command-window";
import { runDip } from "./dip-commands";
import { McpManager } from "./mcp-manager";
import { initRelayClient, reconnectRelay } from "./relay-client";
import { syncLocalMcpServer } from "./local-mcp-server";
import { installRelayHandlers } from "./relay-handlers";
import { registerCodeIndexIpc } from "./code-index/ipc";
import { registerWorkingDirectoryIpc, getWorkingDirectory, getWorkingDirRecents, setWorkingDirectory, addRecent } from "./working-directory";
import { DripManager, BUILTIN_EFFECTS } from "./drip-manager";
import { ConnectorManager } from "./connectors";
import { closeDataStoreDb } from "./data-store";
import { registerSettingsIpc } from "./settings-ipc";
import { registerAppsIpc } from "./apps-ipc";
import { registerGlyphhAppHost } from "./glyphh-app-host";
import { registerHomeIpc } from "./home-ipc";
import { registerTabIpc } from "./tab-ipc";
import { initLocalDb, closeLocalDb } from "./local-db";
import { migrateFromFiles } from "./stores/migrate-from-files";
import { getAgentMode } from "./action-gate";


let mainWindow: BrowserWindow | null = null;
let panelManager: PanelManager;
let layoutManager: LayoutManager;
let commandParser: CommandParser;
let appConnector: AppConnector;

let terminalManager: TerminalManager;
let noteStore: NoteStore;
let voiceRelay: VoiceRelay | null = null;
let cloudSyncInstance: CloudSync | null = null;
let configSync: ConfigSync | null = null;

let mcpManager: McpManager | null = null;
let dripManager: DripManager | null = null;
let connectorManager: ConnectorManager | null = null;

// ── DOM Picker script (injected into panel webContents) ─────
const PICKER_SCRIPT = `(function(){
  if(document.getElementById('__yo_picker__')) return null;
  return new Promise(function(resolve){
  function cleanup(){overlay.remove();highlight.remove();label.remove();document.removeEventListener('keydown',esc);}
  function esc(e){if(e.key==='Escape'){cleanup();resolve(null);}}
  const overlay=document.createElement('div');
  overlay.id='__yo_picker__';
  overlay.style.cssText='position:fixed;inset:0;z-index:2147483647;cursor:crosshair;';
  const highlight=document.createElement('div');
  highlight.style.cssText='position:fixed;pointer-events:none;border:2px solid #a855f7;background:rgba(168,85,247,0.08);z-index:2147483646;transition:all 0.05s;display:none;';
  const label=document.createElement('div');
  label.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;background:#a855f7;color:#fff;font:11px/1.3 monospace;padding:2px 6px;border-radius:3px;display:none;max-width:300px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;';
  document.body.appendChild(highlight);
  document.body.appendChild(label);
  document.body.appendChild(overlay);
  let current=null;
  function buildSelector(el){
    if(el.dataset && el.dataset.testid) return '[data-testid="'+el.dataset.testid+'"]';
    if(el.getAttribute('role')&&el.getAttribute('aria-label')) return '[role="'+el.getAttribute('role')+'"][aria-label="'+el.getAttribute('aria-label')+'"]';
    if(el.id&&!/\\d{4,}/.test(el.id)&&!/^[:.]/.test(el.id)&&el.id.length>3&&!/^(ember|react|ng|mat-|cdk-|gb_)/.test(el.id)&&!/^[a-z]{1,2}\\d/.test(el.id)) return '#'+CSS.escape(el.id);
    if(el.getAttribute('placeholder')) return el.tagName.toLowerCase()+'[placeholder="'+el.getAttribute('placeholder')+'"]';
    if(el.getAttribute('aria-label')) return '[aria-label="'+el.getAttribute('aria-label')+'"]';
    if(el.getAttribute('role')) return el.tagName.toLowerCase()+'[role="'+el.getAttribute('role')+'"]';
    if(el.getAttribute('name')&&!el.getAttribute('name').match(/\\d{4,}/)) return el.tagName.toLowerCase()+'[name="'+el.getAttribute('name')+'"]';
    const parts=[];
    let node=el;
    while(node&&node!==document.body){
      let tag=node.tagName.toLowerCase();
      const parent=node.parentElement;
      if(parent){
        const siblings=Array.from(parent.children).filter(c=>c.tagName===node.tagName);
        if(siblings.length>1) tag+=':nth-of-type('+(siblings.indexOf(node)+1)+')';
      }
      parts.unshift(tag);
      node=parent;
      if(parts.length>=4) break;
    }
    return parts.join(' > ');
  }
  overlay.addEventListener('mousemove',function(e){
    overlay.style.pointerEvents='none';
    const target=document.elementFromPoint(e.clientX,e.clientY);
    overlay.style.pointerEvents='auto';
    if(!target||target===overlay||target===highlight||target===label){highlight.style.display='none';label.style.display='none';current=null;return;}
    current=target;
    const r=target.getBoundingClientRect();
    highlight.style.display='block';
    highlight.style.left=r.left+'px';highlight.style.top=r.top+'px';highlight.style.width=r.width+'px';highlight.style.height=r.height+'px';
    const sel=buildSelector(target);
    const txt=(target.textContent||'').trim().slice(0,40);
    label.textContent=target.tagName.toLowerCase()+(txt?' — '+txt:'');
    label.style.display='block';
    label.style.left=Math.min(r.left,window.innerWidth-310)+'px';
    label.style.top=Math.max(0,r.top-22)+'px';
  });
  overlay.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    if(!current) return;
    const sel=buildSelector(current);
    const tag=current.tagName.toLowerCase();
    const txt=(current.textContent||'').trim().slice(0,80);
    const isEditable=tag==='input'||tag==='textarea'||current.isContentEditable||current.getAttribute('role')==='textbox';
    const isClickable=tag==='button'||tag==='a'||current.getAttribute('role')==='button'||current.onclick!=null||window.getComputedStyle(current).cursor==='pointer';
    cleanup();
    resolve({selector:sel,tag:tag,text:txt,isEditable:isEditable,isClickable:isClickable});
  });
  overlay.addEventListener('contextmenu',function(e){e.preventDefault();cleanup();resolve(null);});
  document.addEventListener('keydown',esc);
  });
})()`;

// Drip effects — extracted to drip-manager.ts

async function createWindow() {
  const saved = getPreference<{ x?: number; y?: number; width: number; height: number; maximized?: boolean }>("windowBounds", { width: 1200, height: 800 });

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    frame: false,
    transparent: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "renderer", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  if (saved.maximized) mainWindow.maximize();

  // Request macOS mic entitlement (triggers OS permission dialog on first use)
  if (process.platform === "darwin") {
    systemPreferences.askForMediaAccess("microphone").catch(() => {});
  }

  // Allow microphone access in the main window renderer (for voice input)
  const mainSes = mainWindow.webContents.session;
  mainSes.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });
  mainSes.setPermissionCheckHandler((_wc, permission) => permission === "media");

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  // Persist window position and size
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const maximized = mainWindow.isMaximized();
      const bounds = maximized ? (getPreference<any>("windowBounds", null) || mainWindow.getBounds()) : mainWindow.getBounds();
      setPreference("windowBounds", { ...bounds, maximized });
    }, 500);
  };
  mainWindow.on("resize", saveBounds);
  mainWindow.on("move", saveBounds);

  mainWindow.setMaxListeners(30);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Refresh auth/tier when window regains focus (e.g. returning from billing portal)
  mainWindow.on("focus", () => {
    refreshHeartbeat().catch(() => {});
  });
}

async function boot() {
  app.setName("Yo");

  // Resolve real shell PATH once — Electron on macOS launched from Finder
  // inherits a sanitized PATH that breaks Homebrew/asdf/nvm tools. Cached for
  // all later spawns (terminals, PTYs, agent shells).
  resolveShellPath();

  // Clear stale IndexedDB locks from previous crashes
  try {
    const idbDir = path.join(app.getPath("userData"), "Partitions", "yo", "IndexedDB");
    const fs = require("fs");
    if (fs.existsSync(idbDir)) {
      for (const entry of fs.readdirSync(idbDir)) {
        const lockPath = path.join(idbDir, entry, "LOCK");
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      }
    }
  } catch { /* non-critical */ }

  // Initialize local SQLite database (agents, layouts, preferences)
  initLocalDb();
  const migrationResult = migrateFromFiles();
  if (migrationResult.migrated) {
    console.log(`[local-db] migrated from files: ${migrationResult.layouts} layouts, ${migrationResult.prefs} prefs`);
  }

  // Load LLM config (provider + model selection only)
  let llmConfig = loadLLMConfig();

  // Cached model list from server (model_rates table)
  interface ServerModel { provider: string; model: string; display_name: string; yos_per_1k_input: number; yos_per_1k_output: number; max_context_tokens?: number; max_output_tokens?: number }
  let serverModelsCache: ServerModel[] = [];
  let serverModelsFetchedAt = 0;
  async function fetchServerModels(): Promise<ServerModel[]> {
    if (serverModelsCache.length > 0 && Date.now() - serverModelsFetchedAt < 60_000) return serverModelsCache;
    try {
      const r = await serverGetAuthed<{ models: ServerModel[] }>("/api/models");
      if (r.models?.length) {
        serverModelsCache = r.models;
        serverModelsFetchedAt = Date.now();
      }
    } catch { /* offline / not yet authed — keep cache or fallback */ }
    return serverModelsCache;
  }

  function applyLLMConfig(config: LLMConfig) {
    llmConfig = config;
    yoChat?.setLLMConfig(config);
    yoInterceptor?.setCurrentModel(config.model);
    const modelNames = serverModelsCache.length > 0
      ? serverModelsCache.map((m) => m.model)
      : ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
    yoInterceptor?.setAvailableModels(modelNames);
  }

  // ── yo-asset:// protocol — serves shared assets (Chart.js etc.) to vibe panels ──
  const rendererDir = path.join(__dirname, "..", "renderer");
  protocol.handle("yo-asset", (request) => {
    const assetName = decodeURIComponent(request.url.replace(/^yo-asset:\/\//, "").replace(/^\/+/, ""));
    const filePath = path.join(rendererDir, assetName);
    if (!fs.existsSync(filePath)) {
      return new Response(`yo-asset not found: ${assetName}`, { status: 404 });
    }
    return net.fetch(`file://${filePath}`);
  });

  // Backward compat: redirect file:// requests for chart.umd.min.js from skill folders
  const yoDir = path.join(os.homedir(), "yo", "skills");
  electronSession.defaultSession.webRequest.onBeforeRequest(
    { urls: ["file://*chart.umd.min.js"] },
    (details: { url: string }, callback: (response: { redirectURL?: string }) => void) => {
      if (details.url.includes(yoDir)) {
        callback({ redirectURL: `file://${path.join(rendererDir, "chart.umd.min.js")}` });
      } else {
        callback({});
      }
    },
  );

  // Core services
  appConnector = new AppConnector();

  // MCP Manager — always init so tools are ready when the agent needs them.
  // Tier gates apply at the UI level (add/connect), not at boot.
  mcpManager = new McpManager();
  mcpManager.setAppConnector(appConnector);
  mcpManager.init().catch((err) => console.error("[mcp-manager]", err));

  // Relay client — persistent WebSocket to yo-server so external MCP callers
  // can drive this instance. No-op until the user sets a client token.
  initRelayClient();

  // Local MCP server — the no-cloud alternative. Starts only if the user has
  // opted in (localMcpEnabled). Uses the same handler registry as the relay.
  void syncLocalMcpServer().catch((err) => console.error("[local-mcp] sync failed:", err));
  mcpManager.on("changed", () => {
    mainWindow?.webContents.send("mcp-changed");
  });

  // Pipedream Connectors — managed OAuth connections (Advanced tier)
  connectorManager = new ConnectorManager();
  connectorManager.setMcpManager(mcpManager);
  connectorManager.setAppConnector(appConnector);
  connectorManager.on("changed", () => {
    mainWindow?.webContents.send("connectors-changed");
  });

  // Terminal manager — pty processes for terminal panels
  terminalManager = new TerminalManager();
  terminalManager.init();

  // Session cache — in-memory yo/sup content store
  const session = new SessionCache();
  session.setOnCapture(() => {});

  // yo/dip/drip interceptor — injected into ALL app panels
  const yoInterceptor = new YoInterceptor(appConnector, session);
  {
    // `agentMode` holds the permission (default/plan/acceptEdits/bypassPermissions).
    // Previously also set on yoAgent (the now-removed chat agent); the panel's
    // permission dropdown is gone too, so this just feeds the interceptor's
    // (currently-unread) mode field for now.
    const savedPerm = getAgentMode();
    yoInterceptor.setAgentMode(savedPerm);
  }
  yoInterceptor.setCurrentModel(llmConfig.model);
  // Fetch active models from server and populate the interceptor + presets cache
  void fetchServerModels().then((models) => {
    const names = models.length > 0 ? models.map((m) => m.model) : ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
    yoInterceptor.setAvailableModels(names);
  });
  const initialTheme = getPreference<string>("theme", "dark");
  // Map themed ids (purple/aurora/custom) to a base mode nativeTheme accepts.
  nativeTheme.themeSource = initialTheme === "system" ? "system" : initialTheme === "light" ? "light" : "dark";
  const resolvedTheme = initialTheme === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : initialTheme;
  yoInterceptor.setTheme(resolvedTheme);

  nativeTheme.on("updated", () => {
    if (getPreference<string>("theme", "dark") !== "system") return;
    const resolved = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    broadcastTheme(resolved);
  });

  // Helper: send theme to main window + all panel webContents (home, etc.)
  function broadcastTheme(resolved: string) {
    yoInterceptor.setTheme(resolved);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("theme-changed", resolved);
    }
    for (const wc of panelManager.getAllWebContents()) {
      wc.send("theme-changed", resolved);
    }
  }

  // Live apps reload — watch ~/yo/apps so an app dropped on disk (e.g. a
  // packaged app's <id>.json) shows up in the registry + `+` picker without a
  // restart. Fans the refresh to the main window and every panel webContents
  // (the Apps registry runs inside the yo://apps panel, not the main window).
  appConnector.setOnChange(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("apps-changed");
    }
    for (const wc of panelManager.getAllWebContents()) {
      wc.send("apps-changed");
    }
  });
  appConnector.startWatching();

  // Track code-terminal panels (Phase 2): panel id → spawn config used when
  // the panel's webContents finishes loading.
  const panelIdToAgentConfig = new Map<string, AgentSpawnConfig>();

  panelManager = new PanelManager((id, wc) => {
    const baseAppId = resolveAppId(id);
    console.log(`[onCreated] panel="${id}" baseApp="${baseAppId}" wcId=${wc.id}`);
    if (baseAppId === "term") {
      wc.on("did-finish-load", () => {
        console.log(`[terminal] did-finish-load panel="${id}" wcId=${wc.id} — spawning pty`);
        terminalManager.spawn(wc);
      });
    } else if (baseAppId === "code") {
      // Code-terminal: spawn the named agent CLI (claude) with role env vars
      const cfg = panelIdToAgentConfig.get(id);
      if (cfg) {
        wc.on("did-finish-load", () => terminalManager.spawnAgent(wc, cfg));
      } else {
        console.warn(`[code-terminal] no agent config for panel "${id}" — falling back to plain terminal`);
        wc.on("did-finish-load", () => terminalManager.spawn(wc));
      }
    } else {
      // Activate interceptor so yo/dip/sup work on app panels
      yoInterceptor.activate(wc, id);
      // Track URL changes in browser tabs for persistence
      if (baseAppId === "browser") trackBrowserUrl(id, wc);
    }

    // Track URL + favicon for URL bar and tab favicons
    const isBrowserPanel = baseAppId === "browser";
    if (isBrowserPanel) {
      // Browser panels use <webview> — track the guest's URL/favicon
      (wc as any).on("did-attach-webview", (_event: unknown, childWc: Electron.WebContents) => {
        panelNavWc[id] = childWc;
        const trackChild = (url: string) => {
          if (url && url !== "about:blank") {
            panelUrls[id] = url;
            if (panelManager.activePanelId === id) sendUrlUpdate();
            sendPanelUrl(id);
            sendTabState();
          }
        };
        childWc.on("did-navigate", (_e: unknown, url: string) => {
          trackChild(url);
        });
        childWc.on("did-navigate-in-page", (_e: unknown, url: string, isMainFrame: boolean) => {
          if (isMainFrame) trackChild(url);
        });
        childWc.on("page-favicon-updated" as any, (_e: unknown, favicons: string[]) => {
          if (favicons?.length) {
            panelFavicons[id] = favicons[0];
            setPreference("panelFavicons", { ...panelFavicons });
            if (panelManager.activePanelId === id) sendUrlUpdate();
            sendPanelUrl(id);
            sendTabState();
          }
        });
      });
    } else {
      // Direct BrowserView — track its own URL/favicon
      panelNavWc[id] = wc;
      const trackDirect = (url: string) => {
        if (url && !url.startsWith("file://")) {
          panelUrls[id] = url;
          if (panelManager.activePanelId === id) sendUrlUpdate();
          sendPanelUrl(id);
          sendTabState();
        }
      };
      wc.on("did-navigate", (_e: unknown, url: string) => {
        trackDirect(url);
      });
      wc.on("did-navigate-in-page", (_e: unknown, url: string, isMainFrame: boolean) => {
        if (isMainFrame) trackDirect(url);
      });
      wc.on("page-favicon-updated" as any, (_e: unknown, favicons: string[]) => {
        if (favicons?.length) {
          panelFavicons[id] = favicons[0];
          setPreference("panelFavicons", { ...panelFavicons });
          if (panelManager.activePanelId === id) sendUrlUpdate();
          sendPanelUrl(id);
          sendTabState();
        }
      });
    }
  });

  // Persist zoom when changed via keyboard shortcut in panels
  panelManager.setOnZoomChange((factor) => {
    setPreference("zoom", factor);
  });

  // Relay panel + RPA handlers — register once panelManager exists. The
  // WebSocket itself was started earlier; handlers are looked up at request
  // time, so registering them here is fine.
  installRelayHandlers({
    getMcpManager: () => mcpManager,
  });

  // Browser panel helpers (must be before app connector loop)
  const BROWSER_HOMES: Record<string, string> = {
    google: "https://www.google.com",
    claude: "https://claude.ai",
    chatgpt: "https://chatgpt.com",
    gemini: "https://gemini.google.com",
  };

  function resolveBrowserHome(): string {
    // Default matches the Appearance tab's select (claude) — was "google",
    // which isn't even an option there, so the setting read as broken.
    const pref = getPreference<string>("browserHomepage", "claude");
    if (pref === "custom") return getPreference<string>("browserHomepageUrl", "") || BROWSER_HOMES.claude;
    return BROWSER_HOMES[pref] || BROWSER_HOMES.claude;
  }

  function browserHtmlUrl(initialUrl?: string): string {
    const base = `file://${path.join(__dirname, "..", "renderer", "browser.html")}`;
    if (initialUrl) return `${base}?url=${encodeURIComponent(initialUrl)}`;
    return base;
  }

  function trackBrowserUrl(panelId: string, wc: Electron.WebContents): void {
    (wc as any).on("did-attach-webview", (_event: unknown, childWc: Electron.WebContents) => {
      const saveUrl = (url: string) => {
        if (url && url !== "about:blank") {
          const saved = getPreference<Record<string, string>>("browserTabUrls", {});
          saved[panelId] = url;
          setPreference("browserTabUrls", saved);
        }
      };
      childWc.on("did-navigate", (_e: unknown, url: string) => saveUrl(url));
      childWc.on("did-navigate-in-page", (_e: unknown, url: string, isMainFrame: boolean) => {
        if (isMainFrame) saveUrl(url);
      });
    });
  }

  // Seed PanelManager configs from apps (apps are the source of truth)
  const terminalHtml = `file://${path.join(__dirname, "..", "renderer", "terminal.html")}`;
  const terminalPreload = path.join(__dirname, "terminal-preload.js");
  const homeHtml = `file://${path.join(__dirname, "..", "renderer", "home.html")}`;
  // Slugs that map to home.html with ?section=<slug>.
  const HOME_SECTION_SLUGS: Record<string, string> = {
    "yo://apps": "apps",
    "yo://layouts": "layouts",
    "yo://drips": "drips",
    "yo://skills": "skills",
    "yo://about": "about",
  };
  // Dashboard shell (5a) — same section panels as above, plus &dashboard=1 so
  // home.ts applies the trimmed-down [data-home-scope="settings-flat"] view.
  const DASHBOARD_SECTION_SLUGS: Record<string, string> = {
    "yo://dashboard-settings": "settings",
  };
  for (const app of appConnector.list()) {
    if (app.url === "yo://home") {
      const homePreload = path.join(__dirname, "..", "renderer", "preload.js");
      // webviewTag: true so the <webview id="app-preview"> inside App detail can render
      panelManager.addPanel(app.id, homeHtml, homePreload, undefined, true);
    } else if (app.url && HOME_SECTION_SLUGS[app.url]) {
      const section = HOME_SECTION_SLUGS[app.url];
      const homePreload = path.join(__dirname, "..", "renderer", "preload.js");
      panelManager.addPanel(app.id, `${homeHtml}?section=${section}`, homePreload, undefined, true);
    } else if (app.url && DASHBOARD_SECTION_SLUGS[app.url]) {
      const section = DASHBOARD_SECTION_SLUGS[app.url];
      const homePreload = path.join(__dirname, "..", "renderer", "preload.js");
      panelManager.addPanel(app.id, `${homeHtml}?section=${section}&dashboard=1`, homePreload, undefined, true);
    } else if (app.url === "yo://terminal") {
      panelManager.addPanel(app.id, terminalHtml, terminalPreload);
    } else if (app.url === "yo://browser") {
      // Always open at the configured homepage (Appearance tab) — restoring
      // the last-visited URL here made the homepage setting a no-op.
      panelManager.addPanel(app.id, browserHtmlUrl(resolveBrowserHome()), undefined, undefined, true);
    } else {
      panelManager.addPanel(app.id, app.url!, undefined, app.forceWeb);
    }
  }

  // Note store + memory store (flat files with keyword search)
  noteStore = new NoteStore();

  // Transcriber — OpenAI Whisper API for voice input
  const transcriber = new Transcriber();

  layoutManager = new LayoutManager(panelManager);
  commandParser = new CommandParser(panelManager, layoutManager, appConnector, session);
  let restoring = false;

  // LLM engine for inline yo/sup execution
  const yoChat = new YoChat(panelManager);
  applyLLMConfig(llmConfig);
  yoInterceptor.setYoChat(yoChat);
  commandParser.setYoChat(yoChat);

  // OS window control (.dip grid/split/min/exp via the command overlay) drives
  // other apps through System Events, which needs Accessibility. Prompt once
  // (no-op if already granted) so commands don't silently fail.
  if (process.platform === "darwin") {
    try { systemPreferences.isTrustedAccessibilityClient(true); } catch { /* noop */ }
  }

  // Global keytap (macOS): native CGEventTap helper that intercepted dot-commands
  // typed in ANY text box. RETIRED as a default — the caret spinner kept getting
  // stranded (focus moves when windows open), so commands now live in the
  // command overlay (Cmd+Shift+Space) instead. Opt back in with the
  // `overlayEnabled` pref if you want the in-text-field triggers regardless.
  if (getPreference<boolean>("overlayEnabled", false)) {
    const overlayBin = app.isPackaged
      ? path.join(process.resourcesPath, "overlay", "keytap")
      : path.join(__dirname, "overlay", "keytap");
    const overlayTriggers = ".dip,.drip";
    startOverlay(
      async (cmd) => {
        if (/^dip\b/.test(cmd)) {
          const r = await runDip(cmd);
          if (!r.ok) console.error("[dip] failed:", r.error);
          return "";
        }
        return commandParser.execute(cmd);
      },
      () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } },
      overlayBin,
      overlayTriggers,
    );
  }

  // Full-screen command overlay (apps + layouts launcher) + its global hotkey
  // (Cmd+Shift+Space). Opens apps/layouts as real OS windows; ".drip <effect>"
  // typed in its command bar routes through the command parser.
  registerCommandWindow((cmd) => commandParser.execute(cmd));

  // Give interceptor access to visible panel IDs (for multi-panel grab)
  yoInterceptor.setVisiblePanelsGetter(() => {
    const gridInfo = layoutManager.getGridInfo();
    if (gridInfo) return gridInfo.panelIds;
    return panelManager.activePanelId ? [panelManager.activePanelId] : [];
  });

  // Give command parser a way to grab panel content for yo/sup from the command bar
  commandParser.setGrabber(async (activeOnly?: boolean) => {
    let panelIds: string[];
    if (activeOnly) {
      panelIds = panelManager.activePanelId ? [panelManager.activePanelId] : [];
    } else {
      panelIds = (layoutManager.getGridInfo()?.panelIds
        ?? (panelManager.activePanelId ? [panelManager.activePanelId] : []))
        .filter((id) => id !== "term");
    }
    const sections: string[] = [];
    for (const id of panelIds) {
      const wc = panelManager.getWebContents(id);
      if (!wc) continue;
      const app = appConnector.get(id);
      let content = "";
      if (app?.commands.grab) {
        try { content = await executeCommand(wc, app.commands.grab); } catch {}
      }
      if (!content || content.startsWith("[Element not found")) {
        try { content = await smartGrab(wc) || ""; } catch {}
      }
      if (content && !content.startsWith("[Element not found")) {
        sections.push(panelIds.length > 1 ? `## ${app?.name || id}\n\n${content}` : content);
      }
      // Raw body text → capture store for search indexing
      try {
        const raw = await wc.executeJavaScript("document.body.innerText.slice(0, 30000)");
        if (raw) session.rawCapture(id, `PAGE: ${await wc.executeJavaScript("document.title")}\nURL: ${wc.getURL()}\n\n${raw}`);
      } catch {}
    }
    return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
  });

  // Give command parser access to panel WebContents for app commands
  commandParser.setWebContentsGetter((id) => panelManager.getGuestOrWebContents(id));

  // Push session state to renderer
  const sendSessionState = () => {
    mainWindow?.webContents.send("session-changed", session.getInfo());
  };

  // Wire command callbacks for interceptor + chat (both need dip routing)
  const callbacks = { openYoPanel: null as ((query: string) => void) | null };

  const execCommand = async (cmd: string, sourcePanelId?: string) => {
    // .waz is now handled by commandParser.execute (so chained forms like
    // `.dip gmail .waz new <prompt>` work too); the inline shim that used
    // to short-circuit bare `waz <prompt>` is no longer needed.
    const result = await commandParser.execute(cmd, sourcePanelId);

    // .yo always opens the agent side panel
    if (result.startsWith("__YO_PANEL__")) {
      const query = result.replace(/^__YO_PANEL__:?/, "");
      callbacks.openYoPanel?.(query);
      return "";
    }

    const gridInfo = layoutManager.getGridInfo();
    mainWindow?.webContents.send("split-state", gridInfo);
    sendSessionState();
    // Track every panel in the layout — a layout can open apps that weren't
    // previously open.
    if (gridInfo) {
      for (const id of gridInfo.panelIds) ensureTab(id);
    }
    // Sync tab state (dip commands change active panel / open grids)
    if (gridInfo) {
      setPreference("suspendedLayout", null);
      // Show the per-cell URL bar whenever the grid has a browser, regardless
      // of which cell is focused. Set once on entry so the browser cell is
      // editable from paint.
      const showBar = layoutManager.gridHasBrowser();
      panelManager.setTopInset(showBar ? URL_BAR_HEIGHT : 0);
      mainWindow?.webContents.send("url-bar-force", showBar);
    } else if (panelManager.activePanelId) {
      ensureTab(panelManager.activePanelId);
    }
    // Persist suspended grid if command suspended it
    const suspended = layoutManager.getSuspendedGridInfo();
    if (suspended) {
      setPreference("suspendedLayout", {
        version: 2, name: suspended.name, cols: suspended.cols, rows: suspended.rows,
        colWidths: suspended.colWidths, rowHeights: suspended.rowHeights, cells: suspended.cells,
      });
    }
    sendTabState();
    return result;
  };
  yoInterceptor.setCommandHandler(execCommand);
  yoInterceptor.setSessionNotifier(sendSessionState);
  yoInterceptor.setYoClearer(() => { commandParser.clearYoHistory(); });

  // Reminder registry
  const activeReminders = new Map<string, { message: string; fireAt: number; timer: ReturnType<typeof setTimeout> }>();

  // Voice Relay — phone-to-desktop voice remote (Advanced tier, feature-flagged)
  if (getPreference<boolean>("voiceRemoteFeature", false) && canUseVoice().allowed) {
    voiceRelay = new VoiceRelay();
    if (getPreference<boolean>("remoteEnabled", false)) {
      voiceRelay.start();
    }
  }

  // Wire .yo conversational agent — slide-out panel
  const yoPanelWidth = () => getPreference<number>("yoPanelWidth", 380);

  // When inset changes (panel open/close), re-apply current layout
  panelManager.setOnInsetChange(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (panelManager.isHidden) return; // don't re-show during splash/overlay
    if (layoutManager.hasSplit) {
      layoutManager.restoreSplit(mainWindow);
    } else {
      panelManager.resizeViews(mainWindow);
    }
  });

  // Panel opener / .waz spawner / mode changer removed with the interactive
  // chat agent (YoAgent) and its popup variant (.waz) — see yo-agent.ts /
  // waz-manager.ts deletion notes. `.yo`, `set-mode`, and `.waz` command
  // dispatches in yo-interceptor.ts now no-op gracefully (their callback
  // hooks are simply never wired).
  yoInterceptor.setFaviconsGetter(() => panelFavicons);
  yoInterceptor.setLayoutsGetter(() => layoutManager.listLayouts());

  // Command palette model changer — still meaningful (feeds skillEngine/yoChat).
  yoInterceptor.setModelChanger((model) => {
    const cfg = loadLLMConfig();
    cfg.model = model;
    saveLLMConfig(cfg);
    llmConfig = cfg;
    applyLLMConfig(cfg);
    yoInterceptor.setCurrentModel(model);
    mainWindow?.webContents.send("llm-config-changed", { provider: cfg.provider, model: cfg.model });
  });

  yoChat.setCommandCallback(execCommand);

  // Terminal yo/sup/dip — route through command parser, show result in terminal
  terminalManager.setCommandHandler(async (cmd, wc) => {
    const result = await execCommand(cmd);
    if (!result || wc.isDestroyed()) return;

    // Write result to terminal in grey
    const lines = result.replace(/\r/g, "").split("\n").join("\r\n");
    wc.send("terminal:data", `\x1b[90m${lines}\x1b[0m\r\n`);
  });

  // Create window
  await createWindow();
  if (mainWindow) commandParser.setMainWindow(mainWindow);

  // Drip effects
  dripManager = new DripManager();
  if (mainWindow) dripManager.setMainWindow(mainWindow);
  commandParser.setDripManager(dripManager);
  yoInterceptor.setDripCustomsGetter(() => dripManager!.listCustoms());

  function deduplicateRestorePanels(ids: string[]): string[] {
    const seen = new Set<string>();
    return ids.map((id) => {
      if (!seen.has(id)) { seen.add(id); return id; }
      const app = appConnector.get(resolveAppId(id));
      if (!app?.url) return id;
      panelInstanceCounter++;
      const instanceId = `${id}-${panelInstanceCounter}`;
      createPanelForApp(instanceId, app);
      ensureTab(instanceId);
      seen.add(instanceId);
      return instanceId;
    });
  }

  // Dashboard shell (5a): boot lands directly on the Apps panel instead of
  // restoring the previous session's grid/split/tabs. restorePanels() below
  // used to recreate every panel from the last session before the renderer's
  // initDashboard() swapped over to the Apps tab — each restored BrowserView
  // paints/loads independently, which looked like every screen flashing on
  // launch. Kept restorePanels() defined (unused) rather than deleted, in
  // case per-app windows (5b) want to resurrect a "reopen last session" option.
  function openAppsPanelOnly() {
    const appsApp = appConnector.get("apps");
    if (appsApp?.url && mainWindow) {
      createPanelForApp("apps", appsApp);
      panelManager.switchTo("apps", mainWindow);
    }
  }

  // Restore panels from last view (or default to claude)
  function restorePanels() {
    let lastView = getPreference<{ type: string; id?: string; panels?: string[]; name?: string; rows?: string[][]; grid?: import("./layout-manager").GridLayout }>("lastView", null!);
    // Cypher tabs are live sessions, not apps — they never survive a restart.
    // Drop them from the restored tab strip, and if the persisted view itself
    // involved a cypher, land the user on The Drop instead.
    const savedTabs = getPreference<string[]>("openTabs", []).filter(
      (id) => resolveAppId(id) !== "cypher",
    );
    if (lastView) {
      const viewPanelIds: string[] = [];
      if (lastView.id) viewPanelIds.push(lastView.id);
      if (lastView.panels) viewPanelIds.push(...lastView.panels);
      if (lastView.rows) lastView.rows.forEach((r) => viewPanelIds.push(...r));
      if (lastView.grid?.cells) viewPanelIds.push(...lastView.grid.cells.map((c) => c.panelId));
      if (viewPanelIds.some((id) => resolveAppId(id) === "cypher")) {
        lastView = { type: "panel", id: "home" };
      }
    }

    // Re-register instance panels from saved tabs/view so they exist for restore
    const allPanelIds: string[] = [...savedTabs];
    if (lastView) {
      if (lastView.grid?.cells) allPanelIds.push(...lastView.grid.cells.map(c => c.panelId));
      if (lastView.panels) allPanelIds.push(...lastView.panels);
      if (lastView.rows) lastView.rows.forEach(row => allPanelIds.push(...row));
      if (lastView.id) allPanelIds.push(lastView.id);
    }
    console.log(`[restorePanels] allPanelIds:`, allPanelIds);
    for (const id of allPanelIds) {
      if (!id) continue;
      if (panelManager.hasPanel(id)) { console.log(`[restorePanels] skip "${id}" — already registered`); continue; }
      const baseId = resolveAppId(id);
      if (baseId === id) { console.log(`[restorePanels] skip "${id}" — is base app, already registered at boot`); continue; }
      // Code-terminal panels need special handling — re-create via codeTerminalLauncher
      if (baseId === "code") {
        console.log(`[restorePanels] skip code panel "${id}" — will restore via layout`);
        continue;
      }
      const app = appConnector.get(baseId);
      if (!app?.url) continue;
      // Track counters so new instances don't collide
      const dash = id.lastIndexOf("-");
      const num = dash > 0 ? parseInt(id.slice(dash + 1), 10) : 0;
      if (num > panelInstanceCounter) panelInstanceCounter = num;
      if (baseId === "browser" && num > tabBrowserCounter) tabBrowserCounter = num;
      createPanelForApp(id, app);
    }

    // Welcome app removed — boot directly into lastView or the first
    // user app. No splash-style landing screen anymore.
    if (lastView && mainWindow) {
      if (lastView.type === "grid-full" && lastView.grid) {
        const allCellIds = lastView.grid.cells.map(c => c.panelId);
        const dedupedCellIds = deduplicateRestorePanels(allCellIds);
        const dedupedGrid = { ...lastView.grid, cells: lastView.grid.cells.map((c, i) => ({ ...c, panelId: dedupedCellIds[i] })) };
        layoutManager.applyGridLayout(dedupedGrid, mainWindow);
        if (dedupedGrid.cells.length > 0) {
          panelManager.setInitialActive(dedupedGrid.cells[0].panelId);
        }
      } else if (lastView.type === "grid" && lastView.rows) {
        const flatIds = lastView.rows.flat();
        const dedupedFlat = deduplicateRestorePanels(flatIds);
        let idx = 0;
        const dedupedRows = lastView.rows.map(row => row.map(() => dedupedFlat[idx++]));
        layoutManager.splitGrid(dedupedRows, mainWindow);
        if (dedupedRows.length > 0 && dedupedRows[0].length > 0) {
          panelManager.setInitialActive(dedupedRows[0][0]);
        }
      } else if (lastView.type === "split" && lastView.panels) {
        const deduped = deduplicateRestorePanels(lastView.panels);
        if (deduped.length === 2) {
          layoutManager.splitTwo(deduped[0], deduped[1], mainWindow);
        } else if (deduped.length > 2) {
          layoutManager.splitN(deduped, mainWindow);
        }
        panelManager.setInitialActive(deduped[0]);
      } else if (lastView.type === "layout" && lastView.name) {
        layoutManager.apply(lastView.name, mainWindow);
        const grid = layoutManager.getGridInfo();
        if (grid && grid.panelIds.length > 0) {
          panelManager.setInitialActive(grid.panelIds[0]);
        }
      } else if (lastView.type === "panel" && lastView.id) {
        panelManager.switchTo(lastView.id, mainWindow);
      }
    } else if (mainWindow) {
      // No persisted view — land on the first user app.
      const firstApp = appConnector.list().find(a => a.url && !a.url.startsWith("yo://"));
      panelManager.switchTo(firstApp?.id || "home", mainWindow);
    }

    // Restore all saved tabs (not just those in the current view).
    // Skip code panels — they're managed by the layout restore above, not as standalone tabs.
    for (const id of savedTabs) {
      if (!id) continue;
      if (!openTabs.includes(id) && resolveAppId(id) !== "code") {
        openTabs.push(id);
      }
    }
    // Restore suspended layout from previous session
    const savedSuspended = getPreference<import("./layout-manager").GridLayout | null>("suspendedLayout", null);
    if (savedSuspended && !layoutManager.hasSplit) {
      layoutManager.setSuspendedGrid(savedSuspended);
    }

    // Also ensure panels from the active/suspended layout are in tabs
    const gridInfo = layoutManager.getGridInfo();
    const suspendedInfo = layoutManager.getSuspendedGridInfo();
    if (gridInfo) {
      for (const id of gridInfo.panelIds) ensureTab(id);
      // Restoring a saved split that includes a browser → show its URL bar.
      const showBar = layoutManager.gridHasBrowser();
      panelManager.setTopInset(showBar ? URL_BAR_HEIGHT : 0);
      mainWindow?.webContents.send("url-bar-force", showBar);
    } else if (suspendedInfo) {
      for (const id of suspendedInfo.panelIds) ensureTab(id);
    }
    if (panelManager.activePanelId) {
      ensureTab(panelManager.activePanelId);
    }
    sendTabState();
  }

  // Helper: push grid state to renderer (for drag handles + panel chips)
  function sendSplitState() {
    const gridInfo = layoutManager.getGridInfo();
    mainWindow?.webContents.send("split-state", gridInfo);
  }

  // ── Tab management ─────────���───────────────────────────────
  const openTabs: string[] = [];
  let tabBrowserCounter = 0;
  let panelInstanceCounter = 0;

  function resolveAppId(panelId: string | null | undefined): string {
    if (!panelId) return "";
    if (appConnector.hasDirect(panelId)) return panelId;
    if (panelId.startsWith("browse-")) return "browser";
    if (panelId.startsWith("code-")) return "code";
    const dash = panelId.lastIndexOf("-");
    if (dash > 0) {
      const base = panelId.slice(0, dash);
      const suffix = panelId.slice(dash + 1);
      if (/^\d+$/.test(suffix) && appConnector.hasDirect(base)) return base;
    }
    return panelId;
  }

  function createPanelForApp(instanceId: string, app: { id: string; url?: string; forceWeb?: boolean }): void {
    if (!app.url) return;
    if (app.url === "yo://home") {
      const homePreload = path.join(__dirname, "..", "renderer", "preload.js");
      panelManager.addPanel(instanceId, homeHtml, homePreload, undefined, true);
    } else if (app.url && HOME_SECTION_SLUGS[app.url]) {
      // System-app wrappers (yo://dashboard, yo://apps, …) reuse home.html
      // with ?section=<slug>. home.ts reads the query on boot.
      const section = HOME_SECTION_SLUGS[app.url];
      const homePreload = path.join(__dirname, "..", "renderer", "preload.js");
      panelManager.addPanel(instanceId, `${homeHtml}?section=${section}`, homePreload, undefined, true);
    } else if (app.url === "yo://terminal") {
      panelManager.addPanel(instanceId, terminalHtml, terminalPreload);
    } else if (app.url === "yo://browser") {
      // New browser panels start at the configured homepage (Appearance tab).
      panelManager.addPanel(instanceId, browserHtmlUrl(resolveBrowserHome()), undefined, undefined, true);
    } else {
      panelManager.addPanel(instanceId, app.url!, undefined, app.forceWeb);
    }
  }

  // Per-panel URL + favicon tracking
  const panelUrls: Record<string, string> = {};
  const panelFavicons: Record<string, string> = getPreference<Record<string, string>>("panelFavicons", {});
  const panelNavWc: Record<string, Electron.WebContents> = {}; // navigable webContents per panel

  function getTabName(id: string | null | undefined): string {
    if (!id) return "";
    const app = appConnector.get(id) || appConnector.get(resolveAppId(id));
    return app?.name || id;
  }

  /** The agent registry (and agent-<slug> panels) were removed, so there is no
   *  longer an agent-panel favicon to resolve. Kept as a no-op for callers. */
  function agentPanelFavicon(_id: string): string | null {
    return null;
  }

  function buildTabState() {
    // Tabs are always shown now — the "Show Tabs" option was removed (closing
    // the last tab used to strand chrome like the URL bar). Kept as a const so
    // the rest of buildTabState reads unchanged.
    const visible = true;
    const gridInfo = layoutManager.getGridInfo();
    const suspendedInfo = layoutManager.getSuspendedGridInfo();
    const layoutInfo = gridInfo || suspendedInfo;
    if (layoutInfo) layoutInfo.panelIds = layoutInfo.panelIds.filter(Boolean);
    const hasLayout = layoutInfo && layoutInfo.panelIds.length > 1;
    const isActiveLayout = gridInfo && gridInfo.panelIds.length > 1;

    // Filter stale null entries and deduplicate
    for (let i = openTabs.length - 1; i >= 0; i--) {
      if (!openTabs[i] || openTabs.indexOf(openTabs[i]) !== i) openTabs.splice(i, 1);
    }

    // "home" (Settings) is an on-demand, closable tab — opened only when the
    // user picks a section from the left-rail Settings menu. Not forced here.

    const urlForTab = (id: string): string | undefined => {
      const isBrowser = resolveAppId(id) === "browser";
      return isBrowser ? (panelUrls[id] || undefined) : undefined;
    };

    let tabs: Array<{ id: string; name: string; favicon?: string; layoutFavicons?: string[]; pinned?: boolean; url?: string; kind?: string }>;
    if (hasLayout) {
      // Show the saved layout's NAME — falling back to the panel-id join only
      // for unnamed grids (ad-hoc splits created on the fly). The tab-bar
      // renderer keys off `kind: "layout"` to draw a single layout glyph
      // instead of stacked panel favicons.
      const savedName = (layoutInfo.name || "").trim();
      const layoutName = savedName || layoutInfo.panelIds.map((id) => getTabName(id)).join(" + ");
      const layoutTabId = "__layout__";
      const gridSet = new Set(layoutInfo.panelIds);
      tabs = [
        { id: layoutTabId, name: layoutName, kind: "layout" },
        ...openTabs.filter((id) => !gridSet.has(id)).map((id) => ({
          id,
          name: getTabName(id),
          favicon: panelFavicons[id] || agentPanelFavicon(id) || "",
          url: urlForTab(id),
        })),
      ];
    } else {
      tabs = openTabs.map((id) => ({
        id,
        name: getTabName(id),
        favicon: panelFavicons[id] || agentPanelFavicon(id) || "",
        url: urlForTab(id),
      }));
    }

    return {
      tabs,
      activeId: isActiveLayout ? "__layout__" : (panelManager.activePanelId || ""),
      visible,
    };
  }

  function sendTabState() {
    const state = buildTabState();
    mainWindow?.webContents.send("tab-state", state);
  }

  // 36px url-bar (28 input + 4 top + 4 bottom padding). No gap below —
  // panel content starts immediately at url-bar's bottom edge.
  const URL_BAR_HEIGHT = 36;

  /** Push the active panel's URL + favicon + nav state to the renderer URL bar */
  function sendUrlUpdate() {
    const id = panelManager.activePanelId;
    if (!id || !mainWindow || mainWindow.isDestroyed()) return;
    const nwc = panelNavWc[id];
    const canGoBack = nwc && !nwc.isDestroyed() ? nwc.navigationHistory.canGoBack() : false;
    const canGoForward = nwc && !nwc.isDestroyed() ? nwc.navigationHistory.canGoForward() : false;
    mainWindow.webContents.send("url-update", {
      url: panelUrls[id] || "",
      favicon: panelFavicons[id] || "",
      canGoBack,
      canGoForward,
    });
    // In grid mode, per-cell URL bars are handled by the layout manager — don't
    // change the global topInset or it will trigger restoreSplit and re-apply the grid,
    // stealing focus in a loop.
    if (!layoutManager.hasSplit) {
      // Only the browser panel shows a URL bar. Internal yo:// apps
      // (Agent / Plan / Workbench / …) don't have URLs.
      const isBrowser = resolveAppId(id) === "browser";
      if (isBrowser) {
        panelManager.setTopInset(URL_BAR_HEIGHT);
        mainWindow.webContents.send("url-bar-force", true);
      } else {
        panelManager.setTopInset(0);
        mainWindow.webContents.send("url-bar-force", false);
      }
    }
  }

  /** Notify renderer of a specific panel's URL (for cell URL bars in grid mode) */
  function sendPanelUrl(panelId: string) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("panel-url-update", {
      id: panelId,
      url: panelUrls[panelId] || "",
      favicon: panelFavicons[panelId] || "",
    });
  }

  function ensureTab(id: string | null | undefined) {
    if (!id) return;
    if (!openTabs.includes(id)) {
      openTabs.push(id);
      persistTabs();
    }
  }

  function persistTabs() {
    setPreference("openTabs", [...new Set(openTabs)]);
  }

  // NOTE: The Workbench Preview slot used to render as a native BrowserView
  // overlay managed here (wb-preview:mount/bounds/navigate/reload/close). That
  // approach was replaced by an in-DOM <iframe> inside the workbench renderer,
  // so the BrowserView manager + its IPC handlers were removed as dead code.
  // The surviving wb-preview:set-url / wb-preview:accepted channels (further
  // below) belong to the separate `preview_url` tool consent flow.

  // Hook into panel focus events — add tab when panel becomes active
  let lastFocusedPanel: string | null = null;
  panelManager.setOnPanelFocused((id: string) => {
    lastFocusedPanel = id;

    ensureTab(id);
    // Persist lastView (only for single-panel mode — grids are saved by the layout system)
    const gridInfo = layoutManager.getGridInfo();
    if (!gridInfo || gridInfo.panelIds.length <= 1) {
      setPreference("lastView", { type: "panel", id });
    }
    // Recents: any app focused (open / switch / dip / reopen / tab click)
    // bubbles to the top of the left-rail Recents grid. Resolves multi-
    // instance panel ids (e.g. workbench-2) back to the base app id.
    const appId = resolveAppId(id);
    if (appId) {
      const app = appConnector.get(appId);
      if (app) {
        const folder = instanceBindings.get(id)?.folder || "";
        addRecent({ kind: "app", id: appId, name: app.name, folder });
      }
    }
    sendTabState();
    sendUrlUpdate();
  });

  // When a browser panel's webview guest attaches, focus it so clicks pass through
  panelManager.setOnPanelReady((id, wc) => {
    if (resolveAppId(id) === "browser") {
      const focusWebview = () => {
        if (wc.isDestroyed()) return;
        wc.executeJavaScript(`(function(){
          var wv = document.getElementById("webview");
          if (wv) { wv.focus(); }
        })()`).catch(() => {});
      };
      // Focus immediately (for already-attached guests) and again after a delay
      // to handle the case where the guest process attaches after the host loads
      focusWebview();
      setTimeout(focusWebview, 500);
      setTimeout(focusWebview, 1500);
    }
  });

  // Activate interceptor on browser panel guest webviews and ensure they're focusable
  panelManager.setOnWebviewAttach((childWc, panelId) => {
    yoInterceptor.activate(childWc, panelId);
    if (resolveAppId(panelId) === "browser") {
      childWc.on("did-finish-load", () => {
        if (!childWc.isDestroyed()) childWc.focus();
      });
    }
  });

  // Give command parser tab close/list for .dip close
  commandParser.setTabManager(
    (id) => {
      if (!mainWindow) return;
      const idx = openTabs.indexOf(id);
      if (idx >= 0) openTabs.splice(idx, 1);
      const nextId = openTabs[Math.min(idx, openTabs.length - 1)];
      panelManager.closePanel(id, mainWindow, nextId);
      persistTabs();
      sendSplitState();
      sendTabState();
    },
    () => [...openTabs],
    (url: string) => {
      tabBrowserCounter++;
      const id = `browse-${tabBrowserCounter}`;
      panelManager.addPanel(id, browserHtmlUrl(url), undefined, undefined, true);
      if (mainWindow) panelManager.switchTo(id, mainWindow);
      ensureTab(id);
      sendSplitState();
      sendTabState();
      return id;
    },
  );

  commandParser.setInstanceCreator((appId: string) => {
    const app = appConnector.get(appId);
    if (!app?.url) return null;
    panelInstanceCounter++;
    const instanceId = `${appId}-${panelInstanceCounter}`;
    createPanelForApp(instanceId, app);
    ensureTab(instanceId);
    return instanceId;
  });

  // Account gate — the heartbeat reports the account status. When it reports
  // the account disabled (an admin action) we lock the user out of the
  // workspace: hide the panels and raise the lockout overlay in the renderer.
  // Registered BEFORE initAuth so the first heartbeat (fired fire-and-forget
  // inside initAuth) can never slip past us.
  let accountLocked = false;
  setHeartbeatObserver((hb) => {
    // Tier may have changed (free <-> paid). The relay is paid-only, so
    // re-evaluate it on every heartbeat — this also starts it once the boot
    // heartbeat finally lands, and tears it down on a downgrade.
    reconnectRelay();
    const locked = hb.status === "disabled";
    if (locked === accountLocked) return;
    accountLocked = locked;
    // Set the lock on the panel manager FIRST and unconditionally (independent of
    // mainWindow timing). While locked it refuses every view attach — single panel
    // or grid layout — so nothing can paint over the lockout overlay.
    panelManager.setLocked(locked);
    if (locked) {
      if (mainWindow) panelManager.hideActive(mainWindow);
      mainWindow?.webContents.send("account-locked", {
        status: hb.status,
        upgradeUrl: `${PLATFORM_URL}/dashboard/billing`,
      });
    } else {
      mainWindow?.webContents.send("account-unlocked");
    }
  });

  // Lockout overlay's "Refresh" button — force a fresh heartbeat. If the
  // account is active again the observer above fires "account-unlocked"; the
  // renderer also uses the returned status to message a still-inactive account.
  ipcMain.handle("recheck-account", async () => {
    const hb = await refreshHeartbeat();
    return { status: hb?.status ?? getAuthStatus().status };
  });

  // Session expired and couldn't be refreshed → surface the login gate instead
  // of silently degrading (connectors/cloud-sync go dark otherwise). Reuses the
  // onboarding overlay; signing back in mints a fresh JWT and everything that
  // rides the token (connector catalog, heartbeat, cloud-sync) recovers.
  setReauthHandler(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      panelManager.hideActive(mainWindow);
      mainWindow.webContents.send("show-onboarding");
    }
  });

  // Initialize auth — restore session, schedule refresh, start heartbeat.
  // Hard 3s timeout so splash never hangs if server is unreachable.
  await Promise.race([initAuth(), new Promise((r) => setTimeout(r, 3000))]);

  // Lexical code index — code_search over the working directory.
  if (!ipcMain.listenerCount("code-index:status")) {
    registerCodeIndexIpc({ getWorkingDir: getWorkingDirectory });
  }

  // Working directory — the single project folder the app is focused on.
  if (!ipcMain.listenerCount("working-dir:get")) {
    registerWorkingDirectoryIpc({
      getMainWindow: () => mainWindow,
      broadcastToPanels: (ch, ...args) => {
        for (const wc of panelManager.getAllWebContents()) {
          try { wc.send(ch, ...args); } catch { /* ignore */ }
        }
      },
      onWorkingDirChange: () => {
        // VS Code surface removed — nothing to re-point anymore.
      },
      // Re-open a recent entry. Folder-bound entries restore the captured
      // workdir first; non-folder apps leave the current workdir alone.
      // openFreshInternalApp now reuses the existing panel for non-folder
      // apps and only spawns a fresh instance when one doesn't exist (or
      // when a folder-bound app is opened with a different folder).
      openRecent: (entry) => {
        if (!mainWindow) return;
        if (entry.folder) setWorkingDirectory(entry.folder);
        if (entry.kind === "app") {
          openFreshInternalApp(entry.id);
        } else if (entry.kind === "layout") {
          openFreshInternalApp("layouts");
        }
      },
    });
  }

  if (!ipcMain.listenerCount("get-preference")) {
    ipcMain.handle("get-preference", (_e, key: string, defaultVal: unknown) => {
      return getPreference(key, defaultVal);
    });
  }
  if (!ipcMain.listenerCount("tab-list")) {
    ipcMain.handle("tab-list", () => {
      return buildTabState();
    });
  }

  // Check if onboarding is needed BEFORE restoring panels
  // (BrowserViews render above HTML, so they'd cover the onboarding overlay)
  const authenticated = isAuthenticated();
  const needsOnboarding = !authenticated;
  let panelsReady = false;

  // Restore zoom level
  const savedZoom = getPreference<number>("zoom", 1.0);
  if (savedZoom !== 1.0) panelManager.setZoom(savedZoom);

  // Only restore panels if not gated by onboarding
  if (!needsOnboarding) {
    restoring = true;
    openAppsPanelOnly();
    restoring = false;
    panelsReady = true;
    // Hide panels during splash — renderer will show them after splash dismisses
    if (mainWindow) panelManager.hideActive(mainWindow);

    // Cyphers are always closed on exit — no restore needed.
  }

  // Start cloud sync if authenticated and tier allows it
  if (authenticated && canUseSync().allowed) {
    cloudSyncInstance = new CloudSync(noteStore);
    cloudSyncInstance.start();
  }

  // Initialize Pipedream connectors — always attempt so MCP tools are available.
  connectorManager?.init().catch((err) => console.error("[connectors]", err));

  // ── Auto-updater ───────────────────────────────────────────
  // Updates download in the background but are NEVER installed on their own.
  // The user applies them explicitly via "Relaunch to Update" (About page + a
  // bottom-right prompt). No mid-session auto-restart, no install-on-quit —
  // this replaces the old flow that could yank the app out from under the user.
  const autoUpdateEnabled = getPreference<boolean>("autoUpdate", true);
  autoUpdater.autoDownload = autoUpdateEnabled;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  // Latest update the feed has offered this session; `ready` once downloaded.
  let pendingUpdate: { version: string; ready: boolean } | null = null;
  // Set when the user hits "Relaunch to Update" before the download finishes —
  // we then install the moment it lands.
  let installWhenReady = false;

  // Broadcast to EVERY renderer — the shell (splash) and panels like the About
  // page are separate webContents, so both must hear update status to stay in
  // sync. (The old code only messaged mainWindow, so the About panel was deaf.)
  const broadcastUpdate = (payload: { status: string; version?: string; percent?: number; error?: string }) => {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) { try { wc.send("update-status", payload); } catch { /* window gone */ } }
    }
  };

  // Reveal the shell splash (panels are BrowserViews layered over index.html)
  // with an "Updating…" status, then quit + install + relaunch.
  const doUpdateInstall = () => {
    broadcastUpdate({ status: "restarting", version: pendingUpdate?.version });
    if (mainWindow) panelManager.hideActive(mainWindow);
    setTimeout(() => {
      try { autoUpdater.quitAndInstall(false, true); }
      catch (err) { console.error("[auto-update] quitAndInstall failed:", err); }
    }, 1200);
  };
  // The About "Relaunch to Update" button invokes this via the update-install
  // IPC. If the download is still in flight, show the updating splash now and
  // install the moment it lands.
  const requestUpdateInstall = () => {
    if (pendingUpdate?.ready) { doUpdateInstall(); return; }
    installWhenReady = true;
    broadcastUpdate({ status: "restarting", version: pendingUpdate?.version });
    if (mainWindow) panelManager.hideActive(mainWindow);
    autoUpdater.checkForUpdates().catch(() => {});
  };

  autoUpdater.on("update-available", (info: { version: string }) => {
    if (!isNewerVersion(info.version, app.getVersion())) return;
    pendingUpdate = { version: info.version, ready: false };
    broadcastUpdate({ status: "available", version: info.version });
  });
  autoUpdater.on("download-progress", (progress: { percent: number }) => {
    broadcastUpdate({ status: "downloading", percent: Math.round(progress.percent), version: pendingUpdate?.version });
  });
  autoUpdater.on("update-downloaded", (info: { version: string }) => {
    pendingUpdate = { version: info.version, ready: true };
    broadcastUpdate({ status: "ready", version: info.version });
    if (installWhenReady) doUpdateInstall();
  });
  autoUpdater.on("update-not-available", () => {
    pendingUpdate = null;
    broadcastUpdate({ status: "none" });
  });
  autoUpdater.on("error", (err: Error) => {
    console.error("[auto-update] error:", err.message);
    broadcastUpdate({ status: "error", error: err.message });
  });

  // The About page asks for the current state on load so it can show the prompt.
  ipcMain.handle("get-update-status", () => pendingUpdate);

  if (autoUpdateEnabled) {
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 800);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  } else {
    broadcastUpdate({ status: "none" });
  }

  // ── Hot config sync (non-blocking, then periodic) ─
  configSync = new ConfigSync();
  configSync.fetchAll((msg) => {
    mainWindow?.webContents.send("splash-status", msg);
  }).then(() => {
    reloadRemotePatterns();
  }).catch(() => {});
  // Start periodic checks for future updates
  configSync.start(() => {
    reloadRemotePatterns();
  });

  // Global hotkey: Cmd+Y / Ctrl+Y
  registerHotkey(mainWindow!);

  // App menu (Cmd+Q, Cmd+W, etc.)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          {
            label: "Toggle Panel DevTools",
            accelerator: "CmdOrCtrl+Alt+I",
            click: () => panelManager.toggleDevTools(),
          },
          {
            label: "Toggle App DevTools",
            accelerator: "CmdOrCtrl+Shift+I",
            click: () => {
              if (mainWindow) {
                if (mainWindow.webContents.isDevToolsOpened()) {
                  mainWindow.webContents.closeDevTools();
                } else {
                  mainWindow.webContents.openDevTools({ mode: "detach" });
                }
              }
            },
          },
          { type: "separator" },
          { role: "reload" },
          { role: "forceReload" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "close" },
        ],
      },
    ])
  );

  // IPC: window controls
  ipcMain.on("update-install", () => { requestUpdateInstall(); });
  ipcMain.handle("check-for-updates", async () => {
    // `checkForUpdates()` always resolves with the feed's *latest* version —
    // even when it equals the version we're running. Returning that blindly
    // makes the UI show "Downloading v<current>…" forever (nothing actually
    // downloads). Only report a version that is genuinely newer.
    try {
      autoUpdater.autoDownload = true;
      const result = await autoUpdater.checkForUpdates();
      const latest = result?.updateInfo?.version;
      if (latest && isNewerVersion(latest, app.getVersion())) return latest;
      return null;
    } catch { return null; }
  });

  ipcMain.on("window-close", () => mainWindow?.close());
  ipcMain.on("window-minimize", () => mainWindow?.minimize());
  ipcMain.on("window-maximize", () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });

  // IPC: refresh panels
  ipcMain.on("panels-refresh", (_e, id?: string) => {
    panelManager.refresh(id);
  });

  // IPC: zoom
  ipcMain.on("panels-zoom", (_e, factor: number) => {
    panelManager.setZoom(factor);
    setPreference("zoom", factor);
  });
  ipcMain.handle("panels-get-zoom", () => panelManager.getZoom());

  // IPC: capture panel screenshots (freeze-frame before hiding)
  ipcMain.handle("capture-panels", async () => {
    if (!mainWindow) return [];
    return panelManager.captureScreenshots(mainWindow);
  });

  // IPC: force ambient context capture
  // IPC: reveal downloaded file in Finder/Explorer
  ipcMain.on("download:show", (_e, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  // IPC: panel visibility (for help overlay)
  ipcMain.on("panels-hide", () => {
    if (mainWindow) panelManager.hideActive(mainWindow);
  });
  let firstPanelReveal = true;
  ipcMain.on("panels-show", () => {
    if (!mainWindow || !panelsReady) return;
    panelManager.hidden = false;
    if (layoutManager.hasSplit) {
      layoutManager.restoreSplit(mainWindow);
    } else {
      panelManager.showActive(mainWindow);
    }
    sendSplitState();
    sendTabState();
    // First reveal — post-splash and post-onboarding — one-time setup.
    if (firstPanelReveal) {
      firstPanelReveal = false;
      // Reload the active panel — sites like Gmail don't render CSS
      // properly when first loaded at zero size.
      if (panelManager.activePanelId) {
        const view = panelManager.getView(panelManager.activePanelId);
        if (view && !view.webContents.isDestroyed()) {
          view.webContents.reload();
        }
      }
    }

  });

  // yo-panel-send/-stop/cmd-palette-open removed with the interactive chat
  // agent panel (YoAgent + yo-panel-ui-vscode.ts).

  // Open a file from a yo-panel file link — defers to the OS default app.
  ipcMain.on("open-in-editor", (_e, filePath: string) => {
    if (typeof filePath !== "string" || !filePath) return;
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(os.homedir(), "yo", filePath);
    void shell.openPath(resolved);
  });

  // File-open router — media open in an internal browser tab; everything else
  // hands off to the OS default app via shell.openPath.
  const BROWSER_EXTS = new Set([
    "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico",
    "mp4", "webm", "mov", "mp3", "wav", "htm", "html",
  ]);
  ipcMain.on("file-open", (_e, filePath: string) => {
    if (!mainWindow || typeof filePath !== "string" || !filePath) return;
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(getWorkingDirectory(), filePath);
    const ext = path.extname(resolved).slice(1).toLowerCase();

    if (BROWSER_EXTS.has(ext)) {
      tabBrowserCounter++;
      const id = `browse-${tabBrowserCounter}`;
      panelManager.addPanel(id, browserHtmlUrl(`file://${resolved}`), undefined, undefined, true);
      panelManager.switchTo(id, mainWindow);
      ensureTab(id);
      sendSplitState();
      sendTabState();
      return;
    }

    void shell.openPath(resolved);
  });

  // Left-rail nav → open the home panel (Settings/Dashboard/Apps/…) at a given
  // section. The home panel is a transient overlay: it does NOT create a tab,
  // and clicking the same rail item again toggles it closed — sliding back to
  // the previously active panel. `pendingHomeSection` covers the cold-start
  // race: the home page grabs it on load via `home:get-pending-section`.
  let pendingHomeSection: { section: string; sub?: string } | null = null;
  let currentHomeSection: { section: string; sub?: string } | null = null;
  ipcMain.on("open-home-section", (_e, section: string, sub?: string) => {
    if (!mainWindow || typeof section !== "string") return;
    const homeActive = panelManager.activePanelId === "home";
    const sameSection = currentHomeSection?.section === section && currentHomeSection?.sub === sub;
    // Toggle: re-clicking the active section slides the home panel back out.
    if (homeActive && sameSection) {
      currentHomeSection = null;
      pendingHomeSection = null;
      panelManager.switchBack(mainWindow);
      sendSplitState();
      sendTabState();
      return;
    }
    currentHomeSection = { section, sub };
    pendingHomeSection = { section, sub };
    const homeApp = appConnector.get("home");
    if (homeApp && !panelManager.hasPanel("home")) createPanelForApp("home", homeApp);
    panelManager.switchTo("home", mainWindow);
    sendSplitState();
    sendTabState();
    panelManager.getView("home")?.webContents.send("home:goto-section", section, sub);
  });
  ipcMain.handle("home:get-pending-section", () => pendingHomeSection);

  // yo-panel-open/-prefill/-dismiss-from-renderer removed with the panel.
  // The Schedules run-history "View run" hand-off (previously window.yo.openYoChat
  // -> "yo-open-chat-from-renderer") was also removed from the renderer side
  // (src/renderer/help/schedules.ts) since there's no surface left to open a
  // run's transcript INTO. No handler is registered for that channel anymore.

  // IPC: Files left rail resize + width persistence
  ipcMain.on("files-rail-resize", (_e, width: number) => {
    panelManager.setLeftInset(width);
  });
  ipcMain.on("files-rail-width-save", (_e, width: number) => {
    setPreference("filesRailWidth", width);
  });
  ipcMain.handle("files-rail-get-width", () => {
    return getPreference<number>("filesRailWidth", 240);
  });

  // get-agent-mode/set-agent-mode removed — they only fed the (now removed)
  // chat panel's permission dropdown (default/plan/acceptEdits/bypassPermissions).

  /** Per-instance (app, folder) bindings. Lets recents:open reuse an
   *  already-open Vibe/Spec/etc panel that's bound to the same folder
   *  instead of spawning a duplicate. Pruned lazily on lookup so a
   *  closed tab's binding drops out. */
  const instanceBindings = new Map<string, { appId: string; folder: string }>();

  /** Find an existing panel bound to (appId, folder). Prunes dead
   *  bindings as it goes. */
  function findInstanceFor(appId: string, folder: string): string | null {
    for (const [pid, b] of instanceBindings) {
      if (!panelManager.hasPanel(pid)) {
        instanceBindings.delete(pid);
        continue;
      }
      if (b.appId === appId && b.folder === folder) return pid;
    }
    return null;
  }

  /** Open the named internal app — reuses an existing instance bound to
   *  the same folder when one exists, otherwise spawns a fresh panel +
   *  tab. Vibe and Spec are folder-bound; clicking Welcome's card with
   *  no folder still spawns a stub. */
  function openFreshInternalApp(baseId: string): void {
    if (!mainWindow) return;
    const app = appConnector.get(baseId);
    if (!app?.url) return;
    const folder = app.requiresFolder ? (getWorkingDirectory() || "") : "";

    // Reuse-on-match. Folder-bound: same (app, folder) → slide to that
    // instance. Non-folder: if the base panel exists, switch to it instead
    // of spawning a duplicate (Dashboard, Apps, Settings, etc. are
    // single-instance from the user's perspective).
    const existing = folder
      ? findInstanceFor(baseId, folder)
      : (panelManager.hasPanel(baseId) ? baseId : null);
    if (existing) {
      panelManager.switchTo(existing, mainWindow);
      ensureTab(existing);
      sendSplitState();
      sendTabState();
      return;
    }

    let instanceId = baseId;
    if (panelManager.hasPanel(baseId)) {
      panelInstanceCounter++;
      instanceId = `${baseId}-${panelInstanceCounter}`;
    }
    createPanelForApp(instanceId, app);
    ensureTab(instanceId);
    panelManager.switchTo(instanceId, mainWindow);
    sendSplitState();
    sendTabState();
    // Folder-bound apps (Workbench, Vibe, Spec) record the instance->folder
    // binding so a subsequent re-open from Recents restores the same folder.
    // The Recents entry itself is added by the panel-focused hook (covers
    // every open path — spawn, dip, tab click, reopen).
    if (app.requiresFolder && folder) {
      instanceBindings.set(instanceId, { appId: baseId, folder });
    }
  }
  // Approval system, ask_user_question, and preview_url (wb-preview:*)
  // callback wiring removed — they only served the interactive chat agent's
  // (YoAgent) SDK MCP tools, which no longer exist. mcp-expose.ts's own
  // preview_url tool (used by run_jammer etc.) is unrelated — it posts to
  // cypherBus directly and was never routed through this machinery.

  // ── Extracted IPC modules ──────────────────────────────
  registerSettingsIpc({
    getPreference, setPreference, getCurrentLimits, broadcastTheme,
    serverGetAuthed, startAuthFlow, isAuthenticated,
    getAccountInfo, getAuthStatus, refreshHeartbeat, logout,
    llmConfig, saveLLMConfig, applyLLMConfig, fetchServerModels,
    session, sendSessionState,
    providerKeys: providerKeysModule, ccBootstrapStatus,
    transcriber, cloudSyncInstance, execCommand,
    getMainWindow: () => mainWindow, panelManager,
  });

  registerAppsIpc({
    appConnector, layoutManager, dripManager, panelManager,
    canAddApp, canSaveLayout,
    getMainWindow: () => mainWindow,
    PICKER_SCRIPT,
  });

  // Installable Glyphh apps (marketplace unit) — capability-scoped windows.
  registerGlyphhAppHost();

  // IPC: grid resize (drag dividers)
  ipcMain.on("grid-drag-end", (_e, type: "col" | "row", index: number, fraction: number) => {
    if (!mainWindow) return;
    // Panels were hidden during drag (panelsHide); mark visible again so
    // window-resize keeps updating bounds via bindResize.
    panelManager.hidden = false;
    if (type === "col") {
      layoutManager.updateColWidth(index, fraction, mainWindow);
    } else {
      layoutManager.updateRowHeight(index, fraction, mainWindow);
    }
    sendSplitState();
    // Persist updated proportions so they survive restart
    const gridInfo = layoutManager.getGridInfo();
    if (gridInfo) {
      setPreference("lastView", {
        type: "grid-full",
        grid: {
          name: "",
          version: 2,
          cols: gridInfo.cols,
          rows: gridInfo.rows,
          colWidths: gridInfo.colWidths,
          rowHeights: gridInfo.rowHeights,
          cells: gridInfo.cells,
        },
      });
    }
  });


  // Settings / home panel IPC — dashboard, MCP servers (relay), connectors, prompts.
  registerHomeIpc({
    mcpManager, connectorManager, canUseMcp,
  });

  // IPC: tabs + URL bar (extracted to tab-ipc.ts)
  registerTabIpc({
    panelManager, layoutManager, appConnector,
    yoInterceptor,
    getMainWindow: () => mainWindow,
    openTabs,
    tabBrowserCounter: { get value() { return tabBrowserCounter; }, set value(v) { tabBrowserCounter = v; } },
    panelInstanceCounter: { get value() { return panelInstanceCounter; }, set value(v) { panelInstanceCounter = v; } },
    panelNavWc,
    resolveAppId, resolveBrowserHome, browserHtmlUrl,
    ensureTab, persistTabs, sendSplitState, sendTabState,
    createPanelForApp,
    setPreference, getPreference,
    URL_BAR_HEIGHT,
  });

  ipcMain.on("open-external", (_e, url: string) => {
    // Only allow http(s) and mailto URLs — block file://, javascript://, etc.
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:") {
        shell.openExternal(url);
      } else {
        console.warn("[open-external] blocked unsafe protocol:", parsed.protocol, url.slice(0, 80));
      }
    } catch {
      console.warn("[open-external] blocked malformed URL:", url.slice(0, 80));
    }
  });

  // Account and billing managed via glyphh.ai/dashboard

  // IPC: support ticket (uses authenticated server call)
  ipcMain.handle("submit-support-ticket", async (_e, ticket: { subject: string; description: string }) => {
    try {
      return await serverPostAuthed("/api/support/ticket", {
        ...ticket,
        appVersion: app.getVersion(),
        os: `${process.platform} ${process.arch}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  // IPC: preferences
  ipcMain.on("set-preference", (_e, key: string, value: unknown) => {
    setPreference(key, value);
    // Live-apply remote mode toggle
    if (key === "remoteEnabled") {
      if (value) voiceRelay?.start();
      else voiceRelay?.stop();
    }
    // Notify every panel/BrowserView so forms reading this pref (e.g. Settings →
    // Agent Defaults) update immediately when it's changed elsewhere (e.g. the
    // compaction modal in the right-rail .Yo agent).
    for (const wc of webContents.getAllWebContents()) {
      try { wc.send("preference-changed", key, value); } catch { /* ignore */ }
    }
  });
  // (get-preference IPC registered earlier, before restorePanels)

  // IPC: relaunch app (for settings that require restart)
  ipcMain.on("relaunch", () => {
    app.relaunch();
    app.exit(0);
  });

  // IPC: onboarding complete — land on the Apps panel after activation
  ipcMain.handle("onboarding-complete", () => {
    openAppsPanelOnly();
    panelsReady = true;
    // Hide panels immediately — the tutorial will show next and it's HTML
    // that gets painted under BrowserViews. panelsShow fires when tutorial closes.
    if (mainWindow) panelManager.hideActive(mainWindow);
    sendSplitState();
  });

  // Configure webviews embedded in the renderer (e.g. app-preview in help overlay)
  (mainWindow?.webContents as any)?.on("did-attach-webview", (_event: unknown, childWc: Electron.WebContents) => {
    childWc.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("about:")) {
        return { action: "deny" };
      }
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: { contextIsolation: true, nodeIntegration: false, partition: "persist:yo" },
        },
      };
    });
  });

  // Tell renderer to check auth gate
  function sendBoot() {
    const hideWelcome = getPreference<boolean>("hideWelcome", false);
    const authStatus = getAuthStatus();
    const currentNeedsOnboarding = !isAuthenticated();
    mainWindow?.webContents.send("boot", {
      authenticated: authStatus.authenticated,
      status: authStatus.status,
      tier: authStatus.tier,
      needsOnboarding: currentNeedsOnboarding,
      hideWelcome,
      theme: (() => { const t = getPreference<string>("theme", "dark"); return t === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : t; })(),
    });
    if (!currentNeedsOnboarding && !panelsReady) {
      restoring = true;
      openAppsPanelOnly();
      restoring = false;
      panelsReady = true;
      sendSplitState();
    } else if (!currentNeedsOnboarding) {
      sendSplitState();
    }
  }

  mainWindow?.webContents.on("did-finish-load", sendBoot);
  if (!mainWindow?.webContents.isLoading()) sendBoot();
}

protocol.registerSchemesAsPrivileged([
  { scheme: "yo-asset", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(boot);

// Handle HTTP Basic Auth prompts (401 WWW-Authenticate) from any webContents
app.on("login", (event, _wc, _details, authInfo, callback) => {
  event.preventDefault();
  const authWin = new BrowserWindow({
    width: 360, height: 260,
    parent: mainWindow || undefined,
    modal: true,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    titleBarStyle: "hidden",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const host = authInfo.host || "This site";
  const realm = authInfo.realm ? ` (${authInfo.realm})` : "";
  const html = `data:text/html,${encodeURIComponent(`<!DOCTYPE html><html><head><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#1a1a1a;color:#e0e0e0;font-family:-apple-system,system-ui,sans-serif;padding:24px;display:flex;flex-direction:column;gap:12px}
    h3{font-size:14px;font-weight:600;color:#fff}
    p{font-size:12px;color:#888}
    input{width:100%;padding:8px 10px;background:#0a0a0a;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none}
    input:focus{border-color:#a855f7}
    .btns{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}
    button{padding:6px 16px;border:none;border-radius:6px;font-size:13px;cursor:pointer}
    .cancel{background:#333;color:#ccc}
    .login{background:#a855f7;color:#000;font-weight:600}
  </style></head><body>
    <h3>Authentication Required</h3>
    <p>${host}${realm} requires credentials.</p>
    <input id="u" type="text" placeholder="Username" autofocus />
    <input id="p" type="password" placeholder="Password" />
    <div class="btns">
      <button class="cancel" onclick="window.close()">Cancel</button>
      <button class="login" id="go">Log In</button>
    </div>
    <script>
      document.getElementById('go').onclick=()=>{
        document.title='AUTH:'+encodeURIComponent(document.getElementById('u').value)+'|'+encodeURIComponent(document.getElementById('p').value);
      };
      document.getElementById('p').onkeydown=(e)=>{if(e.key==='Enter')document.getElementById('go').click()};
      document.getElementById('u').onkeydown=(e)=>{if(e.key==='Enter')document.getElementById('p').focus()};
    </script>
  </body></html>`)}`;
  authWin.loadURL(html);
  authWin.once("ready-to-show", () => authWin.show());
  let answered = false;
  authWin.webContents.on("page-title-updated", (_e, title) => {
    if (!title.startsWith("AUTH:")) return;
    answered = true;
    const parts = title.slice(5).split("|", 2);
    const username = decodeURIComponent(parts[0]);
    const password = decodeURIComponent(parts[1] || "");
    callback(username, password);
    authWin.close();
  });
  authWin.on("closed", () => {
    if (!answered) callback(); // cancel
  });
});

app.on("window-all-closed", () => {
  cleanupAll();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("will-quit", () => {
  cleanupAll();
});

let cleanedUp = false;
function cleanupAll() {
  if (cleanedUp) return;
  cleanedUp = true;
  globalShortcut.unregisterAll();
  disposeCommandWindow();
  cleanupAuthTimers();
  try {
    const tabs = getPreference<string[]>("openTabs", []);
    if (tabs.includes("cypher")) {
      setPreference("openTabs", tabs.filter((t: string) => t !== "cypher"));
    }
  } catch {}
  voiceRelay?.stop();
  cloudSyncInstance?.stop();
  cloudSyncInstance = null;
  configSync?.stop();
  configSync = null;
  terminalManager?.killAll();
  mcpManager?.disconnectAll();
  connectorManager?.cleanup();
  dripManager?.cleanup();
  closeLocalDb();
  closeDataStoreDb();
  usageTracker.flush();
  promptLog.flush();
  // Hard exit if anything keeps the process alive
  setTimeout(() => process.exit(0), 5000).unref();
}
