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
import { writeAgentBriefing, ensureProjectClaudeMd, ensureProjectMcpJson, rewriteAllBriefings } from "./agent-briefing";
import { CommandParser } from "./command-parser";
import { SkillEngine } from "./skill-engine";
import { registerHotkey } from "./hotkey";
import { isAuthenticated, initAuth, startAuthFlow, getAuthStatus, getAccountInfo, logout, cleanupAuthTimers, refreshHeartbeat, setHeartbeatObserver, setReauthHandler, PLATFORM_URL, serverPostAuthed, serverGetAuthed, getAuthToken, hasMcpAccess } from "./auth";
import { CloudSync } from "./cloud-sync";
import { initCapabilities, setOfferEnabled, getCapabilitiesStatus, cleanupCapabilities } from "./capability-sync";
import { CypherBus } from "./cypher-bus";
import { listAgents, getAgent, saveAgent, removeAgent, idAvailable, type AgentConfig as AgentRegistryConfig } from "./stores/agent-store-db";
import { pushAgentProfile, deleteAgentProfile, syncAllAgents } from "./agent-sync";
import { loadLLMConfig, saveLLMConfig, LLMConfig } from "./llm-config";
import { LayoutManager } from "./layout-manager";
import { AppConnector } from "./app-connector";
import { canAddApp, canCreateSkill, canSaveLayout, canUseMcp, canUseSync, canUseVoice, getCurrentLimits } from "./entitlements";
import { executeCommand } from "./dom-bridge";
import { getPreference, setPreference } from "./stores/preferences-db";
import { YoInterceptor } from "./yo-interceptor";
import { YoChat } from "./yo-chat";
import * as providerKeysModule from "./provider-keys";
import { bootstrapStatus as ccBootstrapStatus } from "./cc-bootstrap";
import { SessionCache } from "./session-cache";
import { NoteStore } from "./note-store";
import { MemoryStore } from "./memory-store";
import { Transcriber } from "./transcriber";
import { VoiceRelay } from "./voice-relay";
import { smartGrab } from "./smart-grab";
import { scanPanel, formatScan } from "./dom-scanner";
import { resolveShellPath } from "./shell-path";
import { WorkspaceManager } from "./workspace-manager";
import { EventLog } from "./event-log";
// WorkspaceMcpServer removed — workspace tools merged into McpExpose
import { InboxRouter } from "./inbox-router";
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
import { RunStore } from "./run-store";
import { startOverlay } from "./overlay-bridge";
import { AgentRunner, AgentConfig } from "./agent-runner";
import { McpExpose, ghRequest } from "./mcp-expose";
import { McpManager } from "./mcp-manager";
import { initRelayClient, reconnectRelay } from "./relay-client";
import { installRelayHandlers } from "./relay-handlers";
import { registerCodeIndexIpc } from "./code-index/ipc";
import { registerWorkingDirectoryIpc, getWorkingDirectory, getWorkingDirRecents, setWorkingDirectory, addRecent } from "./working-directory";
import { DripManager, BUILTIN_EFFECTS } from "./drip-manager";
import { ConnectorManager } from "./connectors";
import { SkillToolRouter } from "./skill-tool-router";
import { SkillScheduler } from "./skill-scheduler";
import { DataStore, closeDataStoreDb } from "./data-store";
import { closeSubstrateDb } from "./substrate/store";
import { registerSettingsIpc } from "./settings-ipc";
import { registerSkillsIpc } from "./skills-ipc";
import { registerAppsIpc } from "./apps-ipc";
import { registerMarketplaceIpc } from "./marketplace-ipc";
import { registerHomeIpc } from "./home-ipc";
import { registerTabIpc } from "./tab-ipc";
import { buildSubstrateDeps } from "./substrate-deps";
import { createCypherSession } from "./cypher-session";
import { initLocalDb, closeLocalDb } from "./local-db";
import { migrateFromFiles } from "./stores/migrate-from-files";
import { setSubstrateToolDeps, listBuiltinYoTools } from "./substrate/tools";
import { getAgentMode } from "./action-gate";
import * as threadStore from "./cypher-thread-store";


let mainWindow: BrowserWindow | null = null;
let panelManager: PanelManager;
let layoutManager: LayoutManager;
let commandParser: CommandParser;
let skillEngine: SkillEngine;
let appConnector: AppConnector;

let terminalManager: TerminalManager;
let agentRunner: AgentRunner;
let noteStore: NoteStore;
let voiceRelay: VoiceRelay | null = null;
let cloudSyncInstance: CloudSync | null = null;
let configSync: ConfigSync | null = null;
let mcpExpose: McpExpose | null = null;
let inboxRouter: InboxRouter | null = null;

/** Start/stop the local MCP-expose server to match the tier — exposing Glyphh
 *  as an MCP server is paid-only. Safe to call repeatedly (boot + heartbeat). */
function syncMcpExpose(): void {
  const me = mcpExpose;
  if (!me) return;
  const shouldRun = hasMcpAccess();
  if (shouldRun && !me.isRunning) {
    me.start().then((r) => {
      if (r.ok) console.log("[mcp-expose] started (paid tier)");
      else console.error("[mcp-expose] failed to start:", r.error);
    }).catch(() => {});
  } else if (!shouldRun && me.isRunning) {
    me.stop();
    console.log("[mcp-expose] stopped (not a paid tier)");
  }
}
let mcpManager: McpManager | null = null;
let dripManager: DripManager | null = null;
let connectorManager: ConnectorManager | null = null;
let skillToolRouter: SkillToolRouter | null = null;
let skillScheduler: SkillScheduler | null = null;

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
    console.log(`[local-db] migrated from files: ${migrationResult.agents} agents, ${migrationResult.layouts} layouts, ${migrationResult.prefs} prefs`);
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
    skillEngine?.setLLMConfig(config);
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
  skillEngine = new SkillEngine();
  // Skills are server-authoritative now (yo-server's saved_skills, authored by
  // the assistant). Mirror them into the local execution cache on boot; the
  // Skills tab re-syncs on open, so a pre-auth miss here is harmless.
  void skillEngine.refreshFromServer({ force: true });
  // Broadcast a `skills-changed` event whenever anything touches the
  // skills directory — covers both the skillEngine API path (CRUD via
  // the Skills app) AND the agent writing skill files directly via its
  // Write tool. Renderer subscribes via window.yo.onSkillsChanged.
  let skillsBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  const broadcastSkillsChanged = () => {
    if (skillsBroadcastTimer) clearTimeout(skillsBroadcastTimer);
    skillsBroadcastTimer = setTimeout(() => {
      try { mainWindow?.webContents.send("skills-changed"); } catch { /* */ }
      for (const wc of panelManager?.getAllWebContents() ?? []) {
        try { wc.send("skills-changed"); } catch { /* */ }
      }
    }, 120);
  };
  skillEngine.onChange(broadcastSkillsChanged);
  try {
    fs.watch(skillEngine.getSkillsDir(), { recursive: true, persistent: false }, () => {
      broadcastSkillsChanged();
    });
  } catch (err) {
    // recursive isn't supported on Linux without polling — fall back
    // silently; the skillEngine.onChange path still fires for in-app CRUD.
    console.warn("[skills-watch] could not watch", skillEngine.getSkillsDir(), err);
  }
  appConnector = new AppConnector();

  const dataStore = new DataStore();

  // Workspace registry — { slug, name, rootDir } per workspace, persisted to
  // ~/yo/workspaces.json. Single source of truth for the active workspace.
  // On first init, migrates from the legacy `activeWorkspace` preference and
  // ensures a "default" workspace bound to the user's home dir.
  const workspaceManager = new WorkspaceManager();
  workspaceManager.init();

  const workspaceGetter = (): string => workspaceManager.getActiveSlug();

  // Phase 3: workspace event log + MCP server. The server is started on-demand
  // when the first code-terminal launches (no need to bind a port if no agent
  // is running). EventLog is the canonical writer for events.jsonl.
  const eventLog = new EventLog((slug) => workspaceManager.workspaceDir(slug));
  // Phase 4: orchestrator-mediated push. Watches each workspace's events.jsonl
  // and drains subscription-matched events into per-agent inbox files.
  inboxRouter = new InboxRouter(workspaceManager, eventLog);

  // MCP expose — exposes Glyphh as a local MCP server. This is a paid-tier
  // feature, so it is NOT started here unconditionally; the heartbeat observer
  // starts it once the tier is confirmed paid (and stops it on downgrade).
  mcpExpose = new McpExpose();
  mcpExpose.setWorkspaceGetter(workspaceGetter);
  mcpExpose.setWorkspaceBackend(eventLog, workspaceManager);
  syncMcpExpose();

  // MCP Manager — always init so tools are ready when the agent needs them.
  // Tier gates apply at the UI level (add/connect), not at boot.
  mcpManager = new McpManager();
  mcpManager.setAppConnector(appConnector);
  mcpManager.init().catch((err) => console.error("[mcp-manager]", err));

  // Relay client — persistent WebSocket to yo-server so external MCP callers
  // can drive this instance. No-op until the user sets a client token.
  initRelayClient();
  mcpManager.on("changed", () => {
    mainWindow?.webContents.send("mcp-changed");
  });

  // Skill system — tool router, runner dependencies, scheduler
  skillToolRouter = new SkillToolRouter();
  skillToolRouter.setYoTools(listBuiltinYoTools());
  skillToolRouter.setMcpManager(mcpManager);
  skillEngine.setMcpManager(mcpManager);
  skillScheduler = new SkillScheduler(skillEngine);
  skillScheduler.start();

  // Tool registry deps — provides dependencies to substrate/tools.ts
  setSubstrateToolDeps({
    sessionCache: { get: () => session.get() },
    noteStore: {
      search: (q, n) => noteStore.search(q, n),
      write: (title, content, source) => noteStore.write(title, content, source),
    },
    memoryStore: { save: (content, category) => memoryStore.save(content, category as any) },
    skillEngine: {
      process: (content, skillName) => skillEngine.process(content, skillName),
      listSkillsDetailed: () => skillEngine.listSkillsDetailed(),
      getSkill: (name) => { const s = skillEngine.getSkill(name); return s ? { manifest: s.manifest as any, prompt: s.prompt, folderPath: s.folderPath } : null; },
      writeSkill: (name, manifest, prompt) => skillEngine.writeSkill(name, manifest as any, prompt),
      deleteSkill: (name) => skillEngine.deleteSkill(name),
      readSkillFile: (name, rel) => skillEngine.readSkillFile(name, rel),
      writeSkillFile: (name, rel, content) => skillEngine.writeSkillFile(name, rel, content),
      listSkillFiles: (name) => skillEngine.listSkillFiles(name),
      runSkill: (name, input, opts) => skillEngine.runSkill(name, input, opts),
      getRunHistory: (name) => skillEngine.getRunHistory(name) as any,
      hasRunner: (name) => skillEngine.hasRunner(name),
    },
    dripManager: {
      listCustoms: () => dripManager!.listCustoms(),
      saveCustom: (name: string, recipe: string) => dripManager!.saveCustom(name, recipe),
      deleteCustom: (name: string) => dripManager!.deleteCustom(name),
      listBuiltinEffects: () => BUILTIN_EFFECTS.slice(),
    },
    layoutManager: {
      listLayouts: () => layoutManager.listLayouts() as any,
      getLayout: (name: string) => layoutManager.getLayout(name) as any,
      saveLayout: (grid: any) => layoutManager.saveLayout(grid),
      deleteLayout: (name: string) => layoutManager.deleteLayout(name),
    },
    dataStore: {
      get: (ns, key) => dataStore.get(ns, key),
      set: (ns, key, val) => dataStore.set(ns, key, val),
      delete: (ns, key) => dataStore.delete(ns, key),
      list: (ns, prefix?, limit?) => dataStore.list(ns, prefix, limit),
      query: (ns, filter, limit?) => dataStore.query(ns, filter, limit),
      keys: (ns) => dataStore.keys(ns),
      count: (ns) => dataStore.count(ns),
      clear: (ns) => dataStore.clear(ns),
      listNamespaces: () => dataStore.listNamespaces(),
    },
    mcpRouter: (() => {
      const shortToQualified = new Map<string, string>();
      return {
        resolveAll: () => {
          if (!mcpManager) {
            console.warn("[mcp-router] mcpManager not available");
            return [];
          }
          shortToQualified.clear();
          const allTools = mcpManager.getAllTools();
          if (allTools.length === 0) {
            const servers = mcpManager.getServerStates();
            const summary = servers.map(s => `${s.config.id}: ${s.status}`).join(", ");
            if (servers.length > 0) {
              console.warn(`[mcp-router] 0 tools resolved. Server states: ${summary}`);
            }
          }
          return allTools.map((t) => {
            const short = `${t.serverId.replace(/-/g, "_")}__${t.name.replace(/-/g, "_")}`;
            shortToQualified.set(short, t.qualifiedName);
            return { name: short, description: t.description || "", input_schema: t.inputSchema };
          });
        },
        callMcp: (name: string, input: Record<string, unknown>) => {
          const qualified = shortToQualified.get(name) || name;
          return mcpManager!.callTool(qualified, input);
        },
        hasTool: (name: string) => shortToQualified.has(name),
      };
    })(),
    workspace: {
      teamStatus: () => {
        const wsSlug = workspaceGetter();
        const ws = workspaceManager.get(wsSlug);
        if (!ws) return `Unknown workspace: ${wsSlug}`;
        const agents = workspaceManager.listAgents(wsSlug);
        const status = eventLog.teamStatus(wsSlug, agents);
        return JSON.stringify({
          workspace: ws.slug,
          rootDir: ws.rootDir,
          agents: status.map((s) => ({ ...s, lastPostAt: s.lastPostTs ? new Date(s.lastPostTs).toISOString() : null })),
        }, null, 2);
      },
      readLog: (filter: Record<string, unknown>) => {
        const wsSlug = workspaceGetter();
        const events = eventLog.read(wsSlug, {
          tags: Array.isArray(filter.tags) ? filter.tags as string[] : undefined,
          from: Array.isArray(filter.from) ? filter.from as string[] : undefined,
          to: typeof filter.to === "string" ? filter.to : undefined,
          since: typeof filter.since === "number" ? filter.since : undefined,
          until: typeof filter.until === "number" ? filter.until : undefined,
          kinds: Array.isArray(filter.kinds) ? filter.kinds as any : undefined,
          limit: typeof filter.limit === "number" ? filter.limit : undefined,
        });
        return JSON.stringify({ count: events.length, events }, null, 2);
      },
      postTo: (agent: string, body: string, kind?: string) => {
        const wsSlug = workspaceGetter();
        const evt = eventLog.append(wsSlug, {
          from: ".yo",
          to: agent,
          tags: [`to:${agent}`],
          kind: (kind as any) || "post",
          body,
        });
        return JSON.stringify({ sent: true, ts: evt.ts });
      },
      post: (body: string, tags?: string[], kind?: string) => {
        const wsSlug = workspaceGetter();
        const evt = eventLog.append(wsSlug, {
          from: ".yo",
          tags: tags || ["broadcast"],
          kind: (kind as any) || "post",
          body,
        });
        return JSON.stringify({ sent: true, ts: evt.ts });
      },
      readAgent: (name: string, kind?: string) => {
        const wsSlug = workspaceGetter();
        if (kind === "log") {
          const events = eventLog.read(wsSlug, { from: [name] });
          return JSON.stringify({ agent: name, events }, null, 2);
        }
        const text = eventLog.readScratchpad(wsSlug, name);
        return text || `(${name} has no scratchpad yet)`;
      },
      broadcastAndWait: async (body: string, tags: string[], kind: string | undefined, timeoutMs: number) => {
        const wsSlug = workspaceGetter();
        const evt = eventLog.append(wsSlug, {
          from: ".yo",
          tags,
          kind: (kind as any) || "question",
          body,
        });
        const sentTs = evt.ts;
        const deadline = Date.now() + timeoutMs;
        const pollInterval = 2000;
        const responses: Array<{ from: string; body: string; ts: number; kind: string }> = [];
        const seenTs = new Set<number>();

        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, pollInterval));
          const recent = eventLog.read(wsSlug, { since: sentTs, limit: 50 });
          for (const r of recent) {
            if (r.from === ".yo" || r.from === "user") continue;
            if (r.ts <= sentTs) continue;
            if (seenTs.has(r.ts)) continue;
            seenTs.add(r.ts);
            responses.push({ from: r.from, body: r.body, ts: r.ts, kind: r.kind });
          }
        }

        return JSON.stringify({
          broadcast: { body, ts: sentTs },
          responses,
          waitedMs: Date.now() - sentTs,
          timedOut: responses.length === 0,
        }, null, 2);
      },
    },
  });

  // Pipedream Connectors — managed OAuth connections (Advanced tier)
  connectorManager = new ConnectorManager();
  connectorManager.setMcpManager(mcpManager);
  connectorManager.setAppConnector(appConnector);
  connectorManager.on("changed", () => {
    mainWindow?.webContents.send("connectors-changed");
  });

  // Run persistence — skill/schedule task runs (~/yo/chats/run-*.md).
  // Deterministic file I/O only; no LLM involved (see run-store.ts).
  const runStore = new RunStore();

  // NOTE: prompt-only skills (no SKILL.js) used to fall back to running their
  // instructions through the full interactive chat agent (YoAgent). That
  // agent has been removed entirely, so skillEngine no longer has an
  // agentic-runner fallback — see skill-engine.ts's runSkill()/process(),
  // which now fail clearly for prompt-only skills instead of silently
  // calling an internal LLM.

  // Persist every completed task run as a `type: run` chat (Activity + history).
  skillEngine.onRunComplete((run) => {
    try {
      runStore.saveRunChat({
        skillName: run.skillName,
        trigger: run.trigger,
        output: run.output,
        error: run.error,
        startedAt: run.startedAt,
        instructions: skillEngine.getSkill(run.skillName)?.prompt,
      });
      mainWindow?.webContents.send("runs-changed");
    } catch {}
  });

  // Waz manager (.waz popup chat agent) removed with the interactive chat
  // agent it was built on (YoAgent) — see yo-agent.ts deletion notes.

  // Terminal manager — pty processes for terminal panels
  terminalManager = new TerminalManager();
  terminalManager.init();

  // Cypher bus — canonical message bus for inter-agent communication
  const cypherBus = new CypherBus(
    (wsSlug) => {
      const map = getPreference<Record<string, string>>("workspaceCypher", {});
      return map[wsSlug] ?? null;
    },
    eventLog,
  );

  // Track jammer preview panels so we can clean them up on cypher wrap/leave
  const jammerPreviewPanels = new Set<string>();

  // React to local bus events — local side-effects only (preview panels).
  // Swarm activity itself streams into the yo panel; see the forwarder below.
  cypherBus.onPost((_wsSlug, event) => {
    // Handle preview_url — create a browser panel for the jammer's URL
    if (event.kind === "preview_url" && event.meta?.url && mainWindow && !mainWindow.isDestroyed()) {
      const url = String(event.meta.url);
      const panelId = `jammer-preview-${event.from}`;
      const title = String(event.meta.title || `Preview: ${event.from}`);
      console.log(`[jammer-preview] opening panel="${panelId}" url="${url}" title="${title}"`);
      if (!panelManager.hasPanel(panelId)) {
        panelManager.addPanel(panelId, url);
      }
      panelManager.switchTo(panelId, mainWindow);
      jammerPreviewPanels.add(panelId);
    }
  });

  agentRunner = new AgentRunner();
  agentRunner.setBus(cypherBus);
  agentRunner.setUsagePoster((cypherId, agentId, inputTokens, outputTokens) => {
    serverPostAuthed(`/api/cyphers/${encodeURIComponent(cypherId)}/events`, {
      kind: "usage",
      by_agent_id: agentId,
      payload: { input_tokens: inputTokens, output_tokens: outputTokens, description: `turn by ${agentId}` },
    }).catch((err) => console.warn("[usage-poster] failed:", err instanceof Error ? err.message : err));
  });
  mcpExpose.setBus(cypherBus);

  // Session cache — in-memory yo/sup content store
  const session = new SessionCache();
  session.setOnCapture(() => {});

  // yo/dip/drip interceptor — injected into ALL app panels
  const yoInterceptor = new YoInterceptor(appConnector, skillEngine, session);
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
  const cwWcWorkspace = new Map<number, string>(); // cypher webContents.id → workspace slug

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
  // Slugs that map to home.html with ?section=<slug>. Dashboard shell (5a):
  // Agents/Schedules/Layouts/Skills/Drips/Settings management moved to
  // yo-platform (server-side) — "apps" is the only local section left, the
  // Dashboard's Apps-tab webview container.
  const HOME_SECTION_SLUGS: Record<string, string> = {
    "yo://apps": "apps",
    "yo://skills": "skills",
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
  const memoryStore = new MemoryStore();

  // Transcriber — OpenAI Whisper API for voice input
  const transcriber = new Transcriber();

  layoutManager = new LayoutManager(panelManager);
  commandParser = new CommandParser(panelManager, skillEngine, layoutManager, appConnector, session);
  let restoring = false;

  // LLM engine for inline yo/sup execution
  const yoChat = new YoChat(panelManager);
  applyLLMConfig(llmConfig);
  yoInterceptor.setYoChat(yoChat);
  commandParser.setYoChat(yoChat);

  // Global keytap overlay (macOS): native CGEventTap helper intercepts dot-commands
  // typed in ANY app and shows an inline braille spinner at the caret while we work.
  // DISABLED by default — spawning the helper triggers the macOS Accessibility /
  // Input-Monitoring permission prompt on launch, which we don't want yet. Flip the
  // `overlayEnabled` pref to turn it back on. When enabled, `overlayAgentEnabled`
  // further controls whether the .yo/.dip/.sup agent triggers are live (vs. .drip only).
  if (getPreference<boolean>("overlayEnabled", false)) {
    const overlayBin = app.isPackaged
      ? path.join(process.resourcesPath, "overlay", "keytap")
      : path.join(__dirname, "overlay", "keytap");
    // Agent-backed triggers (.yo/.sup/.peace) were removed with YoAgent — only
    // .dip/.drip remain live regardless of `overlayAgentEnabled`.
    const overlayTriggers = ".dip,.drip";
    startOverlay(
      (cmd) => commandParser.execute(cmd),
      () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } },
      overlayBin,
      overlayTriggers,
    );
  }

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

  /** Brand favicon URL for an agent-<slug> panel based on its model. Pulls
   *  the same Google S2 favicons used in model-badges.ts so the tab matches
   *  the in-app .Sup <Brand> header. Returns null when the panel isn't an
   *  agent panel or the brand has no mark. */
  function agentPanelFavicon(id: string): string | null {
    if (!id.startsWith("agent-")) return null;
    const slug = id.slice("agent-".length);
    const cfg = getAgent(slug);
    const model = (cfg?.model_name || "").toLowerCase();
    let brand = "generic";
    if (!model || model.startsWith("claude")) brand = "anthropic";
    else if (model.startsWith("gpt") || model.startsWith("codex")) brand = "openai";
    else if (model.startsWith("gemini")) brand = "google";
    else if (model.startsWith("grok")) brand = "xai";
    else if (model.startsWith("pplx")) brand = "perplexity";
    const hosts: Record<string, string> = {
      anthropic: "claude.ai",
      openai: "chatgpt.com",
      google: "gemini.google.com",
      xai: "grok.com",
      perplexity: "perplexity.ai",
    };
    const host = hosts[brand];
    return host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : null;
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

  // Panel interaction + layout tools — wired via substrate-deps.ts
  // Agent-convened council: auto-fill members from configured providers if the
  // agent didn't pick any, open the Council app, convene, and let the panel run.
  const { getDefaultModel: getDefaultProviderModel } = require("./provider-models") as typeof import("./provider-models");

  /**
   * Shared council member-builder. Fills members from explicit picks, falling
   * back to the user's configured providers (Settings → Providers) at their
   * default model with a generic distinct-perspective startup prompt. Returns
   * fewer than 2 members when not enough providers are configured — callers
   * must guard on `members.length >= 2`. Reused by the agent-convened council
   * and the Phase-4 council-backed vibe planner.
   */
  setSubstrateToolDeps(buildSubstrateDeps({
    mainWindow,
    panelManager,
    appConnector,
    openTabs,
    getTabBrowserCounter: () => tabBrowserCounter,
    setTabBrowserCounter: (n) => { tabBrowserCounter = n; },
    ensureTab,
    scanPanel,
    formatScan,
    smartGrab,
    executeCommand,
    browserHtmlUrl,
    execCommand,
    swarmCreate: runSwarm,
    spawnBackground: runBackground,
    agentRegistry: {
      list: () => listAgents().map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        mode: a.mode,
      })),
      get: (id: string) => {
        const a = getAgent(id);
        return a ? { id: a.id, name: a.name, role: a.role } : null;
      },
    },
  }));

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

  // Swarms are spawned by the yo agent (create_swarm), not opened as a panel.
  commandParser.setCypherOpener(async () => false);

  // Account gate — the heartbeat is the authoritative 14-day-trial check.
  // When it reports the trial expired (or the account disabled) we lock the
  // user out of the workspace: hide the panels and raise the lockout overlay
  // in the renderer. Registered BEFORE initAuth so the first heartbeat (fired
  // fire-and-forget inside initAuth) can never slip past us.
  let accountLocked = false;
  setHeartbeatObserver((hb) => {
    // Tier may have changed (free <-> paid). The relay + the local MCP-expose
    // server are paid-only, so re-evaluate both on every heartbeat — this also
    // starts them once the boot heartbeat finally lands, and tears them down on
    // a downgrade.
    reconnectRelay();
    syncMcpExpose();
    const locked = hb.status === "expired" || hb.status === "disabled";
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

  // Lockout overlay's "I've upgraded" button — force a fresh heartbeat. If the
  // account is active again the observer above fires "account-unlocked"; the
  // renderer also uses the returned status to message a still-expired account.
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

  // Resume capability publishing if the user had "Offer Usage" on
  void initCapabilities();

  // Broadcast a sub-agent lifecycle event to every panel — any open Workbench
  // Sub-Agents view picks it up. Single source used by the Task tool (via
  // yoAgent.onSubAgent) AND the local swarm / call_agent path (via the bus
  // below), so both kinds of sub-agent stream into the same panel.
  // Replayable per-agent event log so a Workbench opened AFTER an agent started
  // can fetch a snapshot and reconstruct the live stream (late-join). The store
  // inside the workbench already survives view open/close within a window, but a
  // window that didn't exist when the spawn was broadcast missed it entirely —
  // this log is what the new window replays. Keyed by sub-agent id; the spawn is
  // always kept at index 0, finished agents are dropped so only running ones
  // replay, and the tail is bounded so a long transcript can't grow unbounded.
  const liveSubAgentLog = new Map<string, any[]>();
  const SUBAGENT_LOG_CAP = 4000;
  const broadcastSubAgent = (evt: {
    id: string;
    kind: "spawn" | "text" | "token" | "tool" | "tool_result" | "result" | "error";
    source?: "task" | "yo-agent";
    name?: string;
    description?: string;
    text?: string;
    toolId?: string;
    toolName?: string;
    toolInput?: unknown;
    toolOutput?: string;
  }): void => {
    if (evt.kind === "spawn") {
      liveSubAgentLog.set(evt.id, [evt]);
    } else {
      const log = liveSubAgentLog.get(evt.id);
      if (log) {
        log.push(evt);
        // Bound memory: always keep the spawn (index 0) + most recent events.
        if (log.length > SUBAGENT_LOG_CAP) log.splice(1, log.length - SUBAGENT_LOG_CAP);
        // Terminal event: stop retaining so only still-running agents replay.
        if (evt.kind === "result" || evt.kind === "error") liveSubAgentLog.delete(evt.id);
      }
    }
    for (const pwc of panelManager.getAllWebContents()) {
      try { pwc.send("subagent:event", evt); } catch { /* noop */ }
    }
  };
  // Snapshot of every sub-agent still running, as ordered event logs. A Workbench
  // replays these on mount so its Sub-Agents view attaches to in-flight agents
  // regardless of whether the window was open when they spawned.
  if (!ipcMain.listenerCount("subagent:list-running")) {
    ipcMain.handle("subagent:list-running", () => Array.from(liveSubAgentLog.values()).map((log) => log.slice()));
  }

  // Detached background agents the yo agent spawned via spawn_background. We
  // accumulate each one's streamed transcript (agent_result on the bus only
  // carries a "completed N turns" summary, not the agent's actual output), and
  // when it finishes we hand that transcript back to the yo conversation as a
  // follow-up turn so the agent can act on the result. Keyed by agent id.
  const backgroundSpawns = new Map<string, { name: string; transcript: string }>();
  // Push the live count of in-flight background agents to the yo panel so it can
  // show a persistent "N running" indicator (the main turn spinner clears as
  // soon as the spawning turn ends, even while detached agents keep working).
  const notifyBgCount = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("yo-panel-bg-count", backgroundSpawns.size);
    }
  };

  // Render a bus event as a one-line transcript fragment for the Sub-Agents
  // panel. Mirrors the inline feed's vocabulary (thinking / tool / status /
  // coordination) but flattened to plain text since the panel streams a
  // monospace transcript per agent.
  const busEventToTranscript = (event: { kind: string; to?: string; body: string; meta?: Record<string, unknown> }): string | null => {
    const body = (event.body || "").trim();
    switch (event.kind) {
      case "agent_thinking": return body ? `${body}\n` : null;
      case "agent_tool_use": {
        const tool = typeof event.meta?.tool_name === "string" ? event.meta.tool_name : "tool";
        return `\n→ ${tool}${body ? ` ${body}` : ""}\n`;
      }
      case "status": return body ? `· ${body}\n` : null;
      case "assign_task": return `\n⇢ assigned${event.to ? ` to ${event.to}` : ""}: ${body}\n`;
      case "accept_task": return `✓ accepted: ${body}\n`;
      case "complete_task": return `✓ completed: ${body}\n`;
      case "request_review": return `⊙ review requested: ${body}\n`;
      case "report_status": return `· ${body}\n`;
      default: return body ? `${body}\n` : null;
    }
  };

  // Forward local swarm bus events into the yo panel as inline activity.
  // The bus is in-process — this is the single, immediate source (no server
  // round-trip, no SSE replay, no duplicates).
  const DRIP_MIN_INTERVAL_MS = 1500;
  let lastDripRenderAt = 0;
  cypherBus.onPost((_wsSlug, event) => {
    // Drip effects play as a window-level overlay, not a feed row.
    if (event.kind === "drip") {
      const now = Date.now();
      if (now - lastDripRenderAt >= DRIP_MIN_INTERVAL_MS) {
        lastDripRenderAt = now;
        const recipe = typeof event.meta?.recipe === "string" ? event.meta.recipe : "fireworks";
        try { dripManager?.execute([recipe]); } catch { /* ignore */ }
      }
      return;
    }
    // Everything else → the yo panel, rendered inline with the conversation.
    const activity = {
      from: event.from,
      to: event.to,
      kind: event.kind,
      body: event.body,
      tags: event.tags,
      ts: Date.now(),
      meta: event.meta,
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("yo-panel-swarm-activity", activity);
    }
    // Also stream the agent's activity into the Workbench Sub-Agents panel,
    // keyed by `swarm:<agentId>` so it lands in the tab spawned by runSwarm.
    // This is what makes call_agent / create_swarm visible in the panel — the
    // SDK's forwardSubagentText only covers the native Task tool.
    if (event.from) {
      const subId = `swarm:${event.from}`;
      const bg = backgroundSpawns.get(event.from);
      if (event.kind === "agent_result") {
        // Hand-back text: a full-loop agent's result body is just a turn-count
        // summary ("Completed turn (N turns…)"), so its real output is the
        // streamed transcript. A read-only agent's full output IS the body.
        const body = (event.body || "").trim();
        const isTurnSummary = /^Completed turn/i.test(body);
        const transcript = bg ? bg.transcript.trim() : "";
        const final = isTurnSummary ? transcript : (body || transcript);
        // Avoid duplicating text in the panel: if we already streamed deltas
        // (transcript non-empty), the result line adds nothing — just close it.
        const panelText = transcript ? undefined : (busEventToTranscript(event) || undefined);
        broadcastSubAgent({ id: subId, kind: "result", text: panelText });
        if (bg) {
          backgroundSpawns.delete(event.from);
          notifyBgCount();
          const summary = final.slice(-6000) || "(the agent produced no text output)";
          mainWindow?.webContents.send("yo-panel-background-result", {
            id: event.from, name: bg.name, ok: true, text: summary,
          });
        }
      } else if (event.kind === "agent_error") {
        broadcastSubAgent({ id: subId, kind: "error", text: event.body || undefined });
        if (bg) {
          backgroundSpawns.delete(event.from);
          notifyBgCount();
          mainWindow?.webContents.send("yo-panel-background-result", {
            id: event.from, name: bg.name, ok: false, text: event.body || "the agent failed",
          });
        }
      } else {
        const frag = busEventToTranscript(event);
        if (frag) {
          broadcastSubAgent({ id: subId, kind: "token", text: frag });
          if (bg) bg.transcript += frag;
        }
      }
    }
  });

  // Sync all joinable agents to server on boot (fire-and-forget)
  if (isAuthenticated()) void syncAllAgents(listAgents());

  // ── Register cypher-panel IPC handlers BEFORE restorePanels ──
  // (The cypher panel calls these during init; if they're not yet registered
  //  we get "No handler registered" errors.)
  if (!ipcMain.listenerCount("cypher-workspace-path")) {
    ipcMain.handle("cypher-workspace-path", (_e, cypherId: string) => {
      const base = path.join(os.homedir(), ".yo", "cyphers", cypherId, "jammers");
      try { if (fs.existsSync(base)) return base; } catch {}
      return null;
    });
  }
  if (!ipcMain.listenerCount("cypher-list-dir")) {
    ipcMain.handle("cypher-list-dir", (_e, dirPath: string) => {
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        return entries
          .filter((e) => !e.name.startsWith("."))
          .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
          .sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
      } catch { return []; }
    });
  }
  if (!ipcMain.listenerCount("cypher-read-file")) {
    ipcMain.handle("cypher-read-file", (_e, filePath: string) => {
      try {
        const buf = fs.readFileSync(filePath);
        const isBinary = buf.includes(0);
        if (isBinary) return { content: buf.toString("base64"), binary: true };
        return { content: buf.toString("utf-8"), binary: false };
      } catch { return { content: "", binary: false }; }
    });
  }
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

  if (!ipcMain.listenerCount("cypher-gh-tree")) {
    ipcMain.handle("cypher-gh-tree", async () => {
      return mcpExpose?.getRepoTree() ?? null;
    });
  }
  if (!ipcMain.listenerCount("cypher-gh-file")) {
    ipcMain.handle("cypher-gh-file", async (_e, filePath: string) => {
      return mcpExpose?.getRepoFile(filePath) ?? null;
    });
  }
  if (!ipcMain.listenerCount("cypher-project-info")) {
    ipcMain.handle("cypher-project-info", async (_e, cypherId: string) => {
      try {
        const r = await serverGetAuthed<{ project?: { gh_project_url?: string }; linked_repos?: string[] }>(
          `/api/projects/by-cypher/${encodeURIComponent(cypherId)}`,
        );
        return {
          gh_project_url: (r as any)?.project?.gh_project_url || null,
          linked_repos: (r as any)?.linked_repos || [],
        };
      } catch { return null; }
    });
  }
  if (!ipcMain.listenerCount("cypher-project-board")) {
    ipcMain.handle("cypher-project-board", async (_e, cypherId: string) => {
      try {
        const r = await serverGetAuthed<{ project?: { id: string }; items?: Array<{ id: string; title: string; status: string; assignee_user_id?: string; pr_url?: string | null }> }>(
          `/api/projects/by-cypher/${encodeURIComponent(cypherId)}?with=items`,
        );
        return { items: (r as any)?.items || [] };
      } catch { return { items: [] }; }
    });
  }
  if (!ipcMain.listenerCount("cypher-item-detail")) {
    ipcMain.handle("cypher-item-detail", async (_e, cypherId: string, itemId: string) => {
      try {
        const projR = await serverGetAuthed<{ project?: { slug: string } }>(`/api/projects/by-cypher/${encodeURIComponent(cypherId)}`);
        const slug = projR?.project?.slug;
        if (!slug) return null;
        return await serverGetAuthed(`/api/projects/${encodeURIComponent(slug)}/items/${encodeURIComponent(itemId)}/detail`);
      } catch { return null; }
    });
  }
  if (!ipcMain.listenerCount("cypher-open-jammer-preview")) {
    ipcMain.on("cypher-open-jammer-preview", (_e, agentId: string, url: string) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const panelId = `jammer-preview-${agentId}`;
      if (!panelManager.hasPanel(panelId)) {
        panelManager.addPanel(panelId, url);
      }
      panelManager.switchTo(panelId, mainWindow);
      jammerPreviewPanels.add(panelId);
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
    cloudSyncInstance.setWorkspaceGetter(workspaceGetter);
    cloudSyncInstance.start();
  }

  // Initialize Pipedream connectors — always attempt so MCP tools are available.
  connectorManager?.init().catch((err) => console.error("[connectors]", err));

  // ── Auto-updater ───────────────────────────────────────────
  const autoUpdateEnabled = getPreference<boolean>("autoUpdate", true);

  autoUpdater.autoDownload = autoUpdateEnabled;
  autoUpdater.autoInstallOnAppQuit = autoUpdateEnabled;
  autoUpdater.logger = null;

  // macOS has no install-on-quit — electron-updater's MacUpdater extends
  // AppUpdater, not BaseUpdater, so autoInstallOnAppQuit is a no-op there.
  // A downloaded update only applies when quitAndInstall() runs. Without
  // that the app re-downloads the same update every launch and never moves
  // off the old version (the "stuck downloading" loop). We auto-install a
  // downloaded update during boot, bounded to ONE attempt per version so a
  // failing install can never loop forever.
  const appStartedAt = Date.now();
  const updateAttempt = getPreference<{ version: string; tried: boolean } | null>(
    "pendingUpdateInstall",
    null,
  );
  // If a prior attempt's version is now <= the running version, the update
  // applied (or was surpassed) — clear the marker. If it's still newer the
  // install failed; keep the marker so we don't re-attempt that exact version.
  if (updateAttempt && !isNewerVersion(updateAttempt.version, app.getVersion())) {
    setPreference("pendingUpdateInstall", null);
  }

  autoUpdater.on("update-available", (info: { version: string }) => {
    mainWindow?.webContents.send("update-status", {
      status: "available",
      version: info.version,
    });
  });

  autoUpdater.on("download-progress", (progress: { percent: number }) => {
    mainWindow?.webContents.send("update-status", {
      status: "downloading",
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on("update-downloaded", (info: { version: string }) => {
    mainWindow?.webContents.send("update-status", {
      status: "ready",
      version: info.version,
    });
    if (!autoUpdateEnabled) return;
    // Don't re-attempt the exact version whose install already failed —
    // leave the in-app "restart to update" button as the manual fallback.
    if (updateAttempt?.tried && updateAttempt.version === info.version) return;
    // Only auto-restart while still near boot, so we don't yank the app out
    // from under someone mid-session. Past the window, the manual button
    // (and the next launch) still apply it.
    if (Date.now() - appStartedAt > 10 * 60 * 1000) return;
    setPreference("pendingUpdateInstall", { version: info.version, tried: true });
    // We're committing to the restart — tell the renderer so it holds the splash
    // with a stand-by message rather than flashing the workspace for a moment.
    mainWindow?.webContents.send("update-status", {
      status: "restarting",
      version: info.version,
    });
    // Let the splash paint the stand-by message before we restart into the update.
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(true, true);
      } catch (err) {
        console.error("[auto-update] quitAndInstall failed:", err);
      }
    }, 1500);
  });

  autoUpdater.on("update-not-available", () => {
    // Lets the boot-gate stop holding the splash — nothing to wait for.
    mainWindow?.webContents.send("update-status", { status: "none" });
  });

  autoUpdater.on("error", (err: Error) => {
    console.error("[auto-update] error:", err.message);
    mainWindow?.webContents.send("update-status", {
      status: "error",
      error: err.message,
    });
  });

  if (autoUpdateEnabled) {
    // Check early (small settle delay only) so that if an update is available
    // its download is surfaced on the splash — the boot-gate holds the loading
    // screen and shows a progress bar while an update is in flight.
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 800);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  } else {
    // Auto-update off — tell the splash there's nothing to wait for.
    mainWindow?.webContents.send("update-status", { status: "none" });
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
  ipcMain.on("update-install", () => {
    autoUpdater.quitAndInstall(false, true);
  });
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
  // yo://agent removed — the right-rail Yo is the only chat surface now.
  // The agents:open-as-app channel becomes a no-op so renderers don't
  // crash if they still try to call it.
  ipcMain.handle("agents:open-as-app", () => false);

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
    mcpExpose: mcpExpose!, session, sendSessionState,
    providerKeys: providerKeysModule, ccBootstrapStatus,
    transcriber, cloudSyncInstance, execCommand,
    getMainWindow: () => mainWindow, panelManager, runStore,
  });

  registerSkillsIpc({
    skillEngine, mcpManager, appConnector, skillScheduler, canCreateSkill, listBuiltinYoTools,
    // Route the skill's SKILL.md through the shared file-open path
    // (media → browser tab, everything else → OS default app).
    openSkillPath: (absPath: string) => { ipcMain.emit("file-open", null as never, absPath); },
  });

  // Standalone prompt schedules (decoupled from skills).
  {
    const { registerSchedulesIpc } = require("./schedules-ipc") as typeof import("./schedules-ipc");
    registerSchedulesIpc({
      saveRunChat: (opts) => runStore.saveRunChat(opts),
      deleteRunsForSkill: (name: string) => runStore.deleteRunsForSkill(name),
    });
  }

  registerAppsIpc({
    appConnector, layoutManager, dripManager, panelManager,
    canAddApp, canSaveLayout,
    getMainWindow: () => mainWindow,
    PICKER_SCRIPT,
  });

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


  registerMarketplaceIpc({
    serverGetAuthed, serverPostAuthed,
    listAgents, getAgent, saveAgent, removeAgent, idAvailable,
    pushAgentProfile, deleteAgentProfile,
    setOfferEnabled, getCapabilitiesStatus,
  });

  // Settings / home panel IPC — dashboard, MCP servers, connectors, prompts.
  registerHomeIpc({
    mcpExpose: mcpExpose!, mcpManager, connectorManager, canUseMcp,
  });

  // ── Local swarm session (cypher-session.ts) ──────────────────────
  const { spawnSwarm, spawnEphemeral } = createCypherSession({
    agentRunner,
    workspaceManager,
    mcpExpose: mcpExpose!,
    cypherBus,
    getAgent,
  });

  // runSwarm — the single entry shared by the create_swarm substrate tool
  // (the yo agent) and mcp-expose. Resolves a roster, drafts a manifest,
  // spawns locally; the swarm's activity streams inline into the yo panel.
  async function runSwarm(goal: string, agentIds?: string[], size?: number): Promise<string> {
    const g = (goal || "").trim();
    if (!g) return "A goal is required.";
    if (!mainWindow || mainWindow.isDestroyed()) return "Workspace window unavailable.";
    const library = listAgents();
    if (library.length === 0) {
      return "No agents in the library yet — create some in the Agents tab first.";
    }
    let roster: string[];
    if (agentIds && agentIds.length > 0) {
      const missing = agentIds.filter((id) => !library.some((a) => a.id === id));
      if (missing.length > 0) return `Unknown agent id(s): ${missing.join(", ")}.`;
      roster = agentIds;
    } else {
      const n = Math.max(1, Math.min(library.length, size || 3));
      roster = library.slice(0, n).map((a) => a.id);
    }
    const { draftSwarm } = await import("./swarm-draft");
    const manifest = draftSwarm({ goal: g, workspace: workspaceManager.getActive().slug, agentIds: roster });
    // Workspace prep — the swarm shares the .yo project folder, so make sure
    // its CLAUDE.md and MCP config are in place before any agent starts.
    const ws = workspaceManager.getActive();
    try { ensureProjectClaudeMd(ws); } catch { /* */ }
    if (mcpExpose?.isRunning) {
      const mcpUrl = `http://127.0.0.1:${mcpExpose.getPort()}/mcp`;
      const tokens = mcpExpose.getTokens();
      const token = tokens.length > 0 ? tokens[0].token : mcpExpose.generateToken("workspace-agent").token;
      try { ensureProjectMcpJson(ws, mcpUrl, token); } catch { /* */ }
    }
    // Tell the yo panel a swarm is starting — it caches the roster (for
    // model badges) and the swarm's bus activity then streams in inline.
    const swarmStart = {
      title: manifest.title, goal: manifest.goal,
      agents: manifest.agents.map((a) => {
        const reg = library.find((r) => r.id === a.agentId);
        return {
          id: a.agentId, position: a.position,
          provider: reg?.model_provider, model: reg?.model_name,
        };
      }),
    };
    mainWindow.webContents.send("yo-panel-swarm-start", swarmStart);
    // Spawn a Sub-Agents panel tab per roster agent, keyed `swarm:<agentId>`
    // to match the bus activity routed in cypherBus.onPost above. This is the
    // call_agent / create_swarm equivalent of the Task tool's spawn event.
    for (const a of manifest.agents) {
      const reg = library.find((r) => r.id === a.agentId);
      const nm = reg?.name || a.agentId;
      broadcastSubAgent({
        id: `swarm:${a.agentId}`,
        kind: "spawn",
        source: "yo-agent",
        name: nm,
        description: g,
      });
      // Register for result hand-back so the yo agent hears each agent's
      // outcome (call_agent / create_swarm), the same way spawn_background does.
      backgroundSpawns.set(a.agentId, { name: nm, transcript: "" });
    }
    notifyBgCount();
    const res = await spawnSwarm(manifest, mainWindow.webContents);
    if (!res.ok) return `Swarm failed to start: ${res.error || "unknown error"}`;
    return `Swarm started — ${res.spawned ?? 0} agent(s): ${roster.join(", ")}. `
      + `The leader decomposes the goal and assigns work to the others over the bus. `
      + `Their activity streams inline into this conversation as it happens — there is `
      + `no separate panel. Tell the user the swarm is running and its activity will `
      + `appear here; do not claim to watch a panel or poll for results yourself.`;
  }

  mcpExpose!.setSwarmRunner(runSwarm);

  // runBackground — the spawn_background substrate tool. Launches ONE detached
  // ephemeral agent (not from the library), returns immediately, and registers
  // it for result hand-back so the yo agent hears back when it finishes.
  async function runBackground(prompt: string, role?: string): Promise<string> {
    const p = (prompt || "").trim();
    if (!p) return "A prompt (the task) is required.";
    if (!mainWindow || mainWindow.isDestroyed()) return "Workspace window unavailable.";
    const id = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const name = (role || "").trim() || "helper";
    // Share the .yo project folder — make sure CLAUDE.md + MCP config exist
    // before the agent starts (same prep runSwarm does).
    const ws = workspaceManager.getActive();
    try { ensureProjectClaudeMd(ws); } catch { /* best-effort */ }
    if (mcpExpose?.isRunning) {
      const mcpUrl = `http://127.0.0.1:${mcpExpose.getPort()}/mcp`;
      const tokens = mcpExpose.getTokens();
      const token = tokens.length > 0 ? tokens[0].token : mcpExpose.generateToken("workspace-agent").token;
      try { ensureProjectMcpJson(ws, mcpUrl, token); } catch { /* best-effort */ }
    }
    // Spawn the Sub-Agents panel tab (keyed `swarm:<id>` to match the bus
    // activity routed in cypherBus.onPost) and register for hand-back.
    broadcastSubAgent({ id: `swarm:${id}`, kind: "spawn", source: "yo-agent", name, description: p });
    backgroundSpawns.set(id, { name, transcript: "" });
    notifyBgCount();
    const res = await spawnEphemeral(mainWindow.webContents, { id, role, prompt: p });
    if (!res.ok) {
      backgroundSpawns.delete(id);
      notifyBgCount();
      broadcastSubAgent({ id: `swarm:${id}`, kind: "error", text: res.error || "failed to start" });
      return `Background agent failed to start: ${res.error || "unknown error"}`;
    }
    return `Background agent "${name}" started (id ${id}). It runs detached — its activity streams into the `
      + `Sub-Agents panel and its result is handed back to you as a new message when it finishes. Tell the user `
      + `it's running; do not poll for it or claim to watch a panel yourself.`;
  }

  ipcMain.handle("cypher-thread-load-agent", (_e, cypherId: string, agentName: string) => {
    return threadStore.loadAgent(cypherId, agentName);
  });

  ipcMain.handle("cypher-feed-load", (_e, cypherId: string, limit?: number) => {
    return threadStore.loadFeed(cypherId, limit ?? 200);
  });

  ipcMain.handle("cypher-thread-list-agents", (_e, cypherId: string) => {
    return threadStore.listAgentThreads(cypherId);
  });

  // Billing/account managed via web dashboard — no client-side checkout needed

  // IPC: cypher workspace — agents come from the user's Agents registry
  ipcMain.handle("cw:get-agents", () => {
    return listAgents().map((a) => ({
      name: a.id,
      role: a.role || a.name || "agent",
      prompt: a.systemPrompt,
    }));
  });

  ipcMain.handle("cw:add-agent", (e, name: string, role: string, prompt?: string) => {
    const wsSlug = cwWcWorkspace.get(e.sender.id) || workspaceManager.getActive().slug;
    const result = workspaceManager.createAgent(wsSlug, { name, role, prompt });
    if (!result.ok) return { ok: false, error: result.error };
    const agent = result.agent;
    const ws = workspaceManager.get(wsSlug)!;
    const allAgents = workspaceManager.listAgents(wsSlug);
    rewriteAllBriefings(ws, allAgents);
    writeAgentBriefing(ws, agent, allAgents);
    return { ok: true };
  });

  // Agent runner IPC: start/stop SDK-driven agents
  function buildAgentConfig(wsSlug: string, agentId: string): AgentConfig | null {
    const agent = getAgent(agentId);
    if (!agent) return null;
    const ws = workspaceManager.get(wsSlug);
    if (!ws) return null;
    const map = getPreference<Record<string, string>>("workspaceCypher", {});
    const cypherId = map[wsSlug] || undefined;
    const role = agent.role || "agent";
    const startPrompt = cypherId
      ? `You are agent "${agent.id}" (${role}). Read .yo/agents/${agent.id}.md for your role briefing. Messages from teammates arrive automatically. Say "Ready" and wait for instructions.`
      : `You are agent "${agent.id}" (${role}). Read .yo/agents/${agent.id}.md for your role briefing. Then check .yo/inbox/${agent.id}.md for pending tasks. If the inbox is empty or doesn't exist, say "Ready" and wait for instructions.`;
    return {
      name: agent.id,
      role,
      cwd: ws.rootDir,
      prompt: agent.systemPrompt,
      startPrompt,
      workspace: wsSlug,
      cypherId,
      model: agent.model_name,
      modelProvider: agent.model_provider,
      guardrails: agent.guardrails,
    };
  }

  ipcMain.on("cw:agent:start", (e, agentName: string) => {
    const wsSlug = cwWcWorkspace.get(e.sender.id) || workspaceManager.getActive().slug;
    const config = buildAgentConfig(wsSlug, agentName);
    if (!config) return;
    agentRunner.startAgent(e.sender, config).catch((err) => {
      console.error(`[agent-runner] failed to start agent "${agentName}":`, err);
    });
  });

  ipcMain.on("cw:agent:stop", (e, agentName: string) => {
    agentRunner.stopAgent(e.sender.id, agentName);
  });

  ipcMain.on("cw:agent:send", (e, agentName: string, message: string) => {
    agentRunner.sendMessage(e.sender.id, agentName, message);
  });

  // ── Cypher binding (workspace slug → cypher id) ──────────

  function getActiveCypherId(): string | undefined {
    const wsSlug = workspaceManager.getActive().slug;
    const map = getPreference<Record<string, string>>("workspaceCypher", {});
    return map[wsSlug] || undefined;
  }

  ipcMain.handle("cw:cypher-status", async () => {
    const wsSlug = workspaceManager.getActive().slug;
    const cypherId = getActiveCypherId();
    if (!cypherId) return { associated: false, layout_name: wsSlug };
    try {
      const r = await serverGetAuthed<{
        cypher: { id: string; slug: string; title: string; status: string; type: string };
        kitty_balance: number;
      }>(`/api/cyphers/${encodeURIComponent(cypherId)}`);
      let jammers = 0;
      try {
        const j = await serverGetAuthed<{ jammers: Array<{ left_at: string | null }> }>(
          `/api/cyphers/${encodeURIComponent(cypherId)}/jammers`,
        );
        jammers = j.jammers.filter((x) => !x.left_at).length;
      } catch { /* ignore */ }
      return {
        associated: true, layout_name: wsSlug,
        cypher_id: r.cypher.id, slug: r.cypher.slug, title: r.cypher.title,
        status: r.cypher.status, type: r.cypher.type,
        kitty: r.kitty_balance, jammers,
      };
    } catch (err) {
      const map = getPreference<Record<string, string>>("workspaceCypher", {});
      const next = { ...map };
      delete next[wsSlug];
      setPreference("workspaceCypher", next);
      return { associated: false, layout_name: wsSlug, error: err instanceof Error ? err.message : "fetch failed" };
    }
  });

  ipcMain.handle("cw:cypher-create-and-publish", async (_e, input: Record<string, unknown>) => {
    const wsSlug = workspaceManager.getActive().slug;
    try {
      const create = await serverPostAuthed<{ ok: boolean; cypher?: { id: string }; error?: string }>(
        "/api/cyphers", input,
      );
      if (!create.ok || !create.cypher) return { ok: false, error: create.error || "create failed" };
      const cypherId = create.cypher.id;
      const deposit = Number(input.initial_kitty_deposit ?? 0);
      const pub = await serverPostAuthed<{ ok: boolean; cypher?: { id: string; slug: string }; kitty_balance?: number; error?: string }>(
        `/api/cyphers/${encodeURIComponent(cypherId)}/publish`,
        { initial_kitty_deposit: deposit },
      );
      if (!pub.ok) return { ok: false, error: pub.error || "publish failed" };
      const map = getPreference<Record<string, string>>("workspaceCypher", {});
      setPreference("workspaceCypher", { ...map, [wsSlug]: cypherId });
      return { ok: true, cypher: pub.cypher, kitty_balance: pub.kitty_balance };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "publish failed" };
    }
  });

  ipcMain.handle("cw:cypher-disassociate", async () => {
    const wsSlug = workspaceManager.getActive().slug;
    const map = getPreference<Record<string, string>>("workspaceCypher", {});
    const next = { ...map };
    delete next[wsSlug];
    setPreference("workspaceCypher", next);
    return { ok: true };
  });

  // IPC: tabs + URL bar (extracted to tab-ipc.ts)
  registerTabIpc({
    panelManager, layoutManager, appConnector,
    yoInterceptor, agentRunner,
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
  cleanupAuthTimers();
  cleanupCapabilities();
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
  // agentRunner instances are aborted when their webContents are destroyed
  mcpExpose?.stop();
  inboxRouter?.stop();
  mcpManager?.disconnectAll();
  connectorManager?.cleanup();
  dripManager?.cleanup();
  closeLocalDb();
  closeDataStoreDb();
  closeSubstrateDb();
  usageTracker.flush();
  promptLog.flush();
  // Hard exit if anything keeps the process alive
  setTimeout(() => process.exit(0), 5000).unref();
}
