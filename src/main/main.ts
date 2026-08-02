/**
 * Yo — Electron main process.
 *
 * Boots the app, registers the global hotkey, creates the main window, and
 * hosts the home surface (home-view.ts) — one persistent BrowserView; all
 * workspace apps are renderer-owned webview panels inside its workbench.
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

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeTheme, net, protocol, session as electronSession, shell, systemPreferences, webContents } from "electron";

// Stop Chromium from encrypting its own internal cookie/session storage via
// the OS keychain ("Chrome Safe Storage" on macOS). This is separate from
// anything our own code does (app-secrets.ts and auth.ts avoid safeStorage
// already) — it's Chromium's automatic behavior for
// ANY persistent session partition (e.g. `persist:yo`, used by webviews and
// browser tabs), and it's what was still triggering a keychain prompt on
// every launch. In an unsigned/dev build, macOS can't remember the "Always
// Allow" grant across relaunches (the app's signature changes each build),
// so it re-prompts every single time. Must be set before app is ready.
app.commandLine.appendSwitch("use-mock-keychain");

import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";
import { glyphhPath } from "./app-paths.js";
import { HomeView } from "./home-view";
import { CommandParser } from "./command-parser";
import { registerHotkey } from "./hotkey";
import { isAuthenticated, initAuth, restoreUserScopeFromSidecar, startAuthFlow, getAuthStatus, getAccountInfo, logout, cleanupAuthTimers, refreshHeartbeat, setHeartbeatObserver, setReauthHandler, PLATFORM_URL } from "./auth";
import { LayoutManager } from "./layout-manager";
import { canSaveLayout, canUseCustomMcp } from "./entitlements";
import { getPreference, setPreference } from "./stores/preferences-db";
import { initAdaStore } from "./ada/store";
import { registerAdaSync } from "./ada/indexer";
import { registerAdaIpc } from "./ada/ipc";
import { getLocalDb } from "./local-db";
import { SessionCache } from "./session-cache";
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
import { setMainWindowRef } from "./main-window-ref";
import { isBackgroundEnabled, isQuitting, markQuitting, shouldHideOnClose, syncBackgroundMode, setReopenHandler } from "./background-mode";
import { initRailCollapse } from "./screen-layout";
import { McpManager } from "./mcp-manager";
import { startMcpOAuthRefresh, stopMcpOAuthRefresh } from "./mcp-oauth-refresh";
import { syncLocalMcpServer, stopLocalMcpServer } from "./local-mcp-server";
import { stopAllAppWorkers } from "./glyphh-app-worker";
import { stopAllSchedules } from "./glyphh-app-services";
import { installRelayHandlers } from "./relay-handlers";
import { installAttachHandlers } from "./attach-handlers";
import { installRpaHandlers, registerRpaTarget, unregisterRpaTarget } from "./rpa";
import { registerWorkingDirectoryIpc, getWorkingDirectory, setWorkingDirectory } from "./working-directory";
import { registerWorkbenchTerminalIpc } from "./wb-terminal";
import { registerWbAppRegistry, openAppByRef, openBrowserAt } from "./app-resolver";
import { DripManager, setDripManagerInstance } from "./drip-manager";
import { ConnectorManager } from "./connectors";
import { closeDataStoreDb } from "./data-store";
import { registerSettingsIpc, LIGHT_THEMES } from "./settings-ipc";
import { registerModelsIpc } from "./models-ipc";
import { getClient } from "./glyphh-client";
import { registerAppsIpc } from "./apps-ipc";
import { registerGlyphhIpc, shutdownGlyphh } from "./glyphh-agent";
import { registerLibraryIpc } from "./library-ipc";
import { startAgentScheduler, stopAgentScheduler } from "./agent-scheduler";
import { registerGlyphhAppHost } from "./glyphh-app-host";
import { registerHomeIpc } from "./home-ipc";
import { initLocalDb, closeLocalDb } from "./local-db";
import { setUserScopeReloader, onUserChange } from "./user-scope";
import { migrateFromFiles } from "./stores/migrate-from-files";


let mainWindow: BrowserWindow | null = null;
let homeView: HomeView;
let layoutManager: LayoutManager;
let commandParser: CommandParser;

let mcpManager: McpManager | null = null;
let dripManager: DripManager | null = null;
let connectorManager: ConnectorManager | null = null;


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
  // Share the main-window handle with modules that can't import main.ts
  // (app-resolver focuses it when the "Glyphh" system app is opened).
  setMainWindowRef(mainWindow);
  initRailCollapse(mainWindow);

  // Request macOS mic entitlement (triggers OS permission dialog on first use)
  if (process.platform === "darwin") {
    systemPreferences.askForMediaAccess("microphone").catch(() => {});
  }

  // Media permission for the main window renderer
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

  // Background mode: closing the window HIDES it (the process stays resident so
  // scheduled loops/skills + the attach socket keep running) instead of
  // quitting. A real Quit (tray/⌘Q sets isQuitting) closes for real.
  mainWindow.on("close", (e) => {
    if (shouldHideOnClose()) { e.preventDefault(); mainWindow?.hide(); }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    // Not background mode (or a real Quit): closing the main window quits the
    // app. Auxiliary windows (hidden app workers, overlays, per-app windows) can
    // keep window-all-closed from firing AND can block app.quit() from ever
    // reaching will-quit — leaving a zombie process with no window and no tray.
    // So tear everything down here directly (idempotent) and arm the hard-exit
    // backstop BEFORE asking to quit, so nothing can strand the process.
    if (!isBackgroundEnabled() || isQuitting()) {
      cleanupAll();
      app.quit();
    }
  });

  // Refresh auth/tier when window regains focus (e.g. returning from billing portal)
  mainWindow.on("focus", () => {
    refreshHeartbeat().catch(() => {});
  });
}

async function boot() {
  // The RUNTIME name — the menu bar, Quit item, and About panel read this,
  // overriding package.json productName. It said "Yo" long after the rebrand.
  app.setName("Glyphh");

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

  // Scope to the last signed-in user BEFORE the DB opens — otherwise every
  // boot-time read (window bounds, prefs) hits the default-scope DB while
  // post-auth writes land in the user's, and nothing survives a restart.
  restoreUserScopeFromSidecar();
  // Initialize local SQLite database (agents, layouts, preferences)
  initLocalDb();
  // Ada — schema-on-write fact memory. A PROVIDER, not the handle: local-db
  // reopens on user-scope switches and Ada must follow the live connection.
  initAdaStore(() => getLocalDb());
  registerAdaIpc();
  registerAdaSync(); // mirror the workspace catalog into facts (idempotent)
  const migrationResult = migrateFromFiles();
  if (migrationResult.migrated) {
    console.log(`[local-db] migrated from files: ${migrationResult.layouts} layouts, ${migrationResult.prefs} prefs, ${migrationResult.prefsV2} stranded prefs`);
  }

  // Load LLM config (provider + model selection only)

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

  // ── glyphh-preview:// — streams a local file into the Browser panel's
  // iframe (which cannot navigate to file:// itself). Default session only:
  // app webviews live on persist:yo, and installed-app documents carry a
  // default-src 'none' CSP, so neither can reach this scheme.
  protocol.handle("glyphh-preview", (request) => {
    const u = new URL(request.url);
    let p = decodeURIComponent(u.pathname);
    if (process.platform === "win32") p = p.replace(/^\//, "").replace(/\//g, "\\");
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
      return new Response(`preview not found: ${p}`, { status: 404 });
    }
    return net.fetch(pathToFileURL(p).toString());
  });

  // Backward compat: redirect file:// requests for chart.umd.min.js from skill folders
  const skillsDir = glyphhPath("skills");
  electronSession.defaultSession.webRequest.onBeforeRequest(
    { urls: ["file://*chart.umd.min.js"] },
    (details: { url: string }, callback: (response: { redirectURL?: string }) => void) => {
      if (details.url.includes(skillsDir)) {
        callback({ redirectURL: `file://${path.join(rendererDir, "chart.umd.min.js")}` });
      } else {
        callback({});
      }
    },
  );

  // MCP Manager — the client-side catalog view; all MCP execution is
  // server-side (connector tools + custom MCP connections).
  mcpManager = new McpManager();

  // Local MCP server — the loopback (127.0.0.1) MCP surface for same-machine
  // LLMs. The cloud relay that let external callers reach in was removed; this
  // is the only remaining MCP surface, and it shares the handler registry.
  void syncLocalMcpServer().catch((err) => console.error("[local-mcp] sync failed:", err));

  // Identity switch → hard renderer reload so no DOM/JS state from the
  // previous account survives (per-user stores re-scope in user-scope.ts).
  setUserScopeReloader(() => { mainWindow?.webContents.reload(); });
  // …and reset every main-process singleton holding per-user state in memory
  // (closures over the `let` bindings — all assigned long before any switch).
  onUserChange(() => {
    layoutManager?.resetForUserChange();
    connectorManager?.clearUserState();
    mcpManager?.setConnectorCatalog([]);
  });

  // Pipedream Connectors — managed OAuth connections (Advanced tier)
  connectorManager = new ConnectorManager();
  connectorManager.setMcpManager(mcpManager);
  connectorManager.on("changed", () => {
    mainWindow?.webContents.send("connectors-changed");
  });
  // Connect-flow progress (OAuth window closed → verifying → done) — drives
  // the renderer's app-level loading overlay.
  connectorManager.on("connect-progress", (p) => {
    mainWindow?.webContents.send("connectors-connect-progress", p);
  });

  // Session cache — in-memory yo/sup content store
  const session = new SessionCache();
  session.setOnCapture(() => {});

  const initialTheme = getPreference<string>("theme", "dark");
  // Map themed ids (purple/aurora/prism/…) to a base mode nativeTheme accepts.
  nativeTheme.themeSource = initialTheme === "system" ? "system" : LIGHT_THEMES.has(initialTheme) ? "light" : "dark";

  nativeTheme.on("updated", () => {
    if (getPreference<string>("theme", "dark") !== "system") return;
    const resolved = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    broadcastTheme(resolved);
  });

  // Helper: send theme to every webContents — the shell, the home view, its
  // workbench webviews, and any ghost/solo windows.
  function broadcastTheme(resolved: string) {
    for (const wc of webContents.getAllWebContents()) {
      try { if (!wc.isDestroyed()) wc.send("theme-changed", resolved); } catch { /* window gone */ }
    }
  }

  // The home surface — one persistent BrowserView owned here; workspace apps
  // are renderer-owned <webview> panels inside its workbench.
  homeView = new HomeView();
  // Persist zoom when changed via keyboard shortcut in the home view
  homeView.setOnZoomChange((factor) => {
    setPreference("zoom", factor);
  });

  // Relay panel + RPA handlers. The WebSocket itself was started earlier;
  // handlers are looked up at request time, so registering them here is fine.
  installRelayHandlers({
    getMcpManager: () => mcpManager,
  });
  // loops.run / skills.run / agents.run / scrape.page — the attach socket's
  // extra capabilities, on the same registry.
  installAttachHandlers();
  // rpa.* drive an open app panel. The renderer registers each panel's
  // slug → webContents id so main can resolve the live view.
  installRpaHandlers();
  ipcMain.on("wb:rpa-register", (_e, slug: string, wcId: number) => registerRpaTarget(String(slug), Number(wcId)));
  ipcMain.on("wb:rpa-unregister", (_e, slug: string) => unregisterRpaTarget(String(slug)));

  layoutManager = new LayoutManager();
  commandParser = new CommandParser();


  // OS windows, the command palette, and the keytap overlay are retired —
  // apps open as workbench panels beside the agent (wb:app-cmd), reported
  // back by the renderer for panels_list / Glyphh's list tools.
  registerWbAppRegistry();

  // Push session state to renderer
  const sendSessionState = () => {
    mainWindow?.webContents.send("session-changed", session.getInfo());
  };

  const execCommand = async (cmd: string) => {
    const result = await commandParser.execute(cmd);
    sendSessionState();
    return result;
  };

  // EVERY renderer-facing handler registers BEFORE the first window loads —
  // the home panel's boot modules invoke get-preference immediately, and a
  // handler registered after createWindow loses that race ("No handler
  // registered for …" at every launch).
  // Code workbench terminals — per-id pty bridge (wb-term:* namespace).
  if (!ipcMain.listenerCount("wb-term:spawn")) {
    registerWorkbenchTerminalIpc();
    // The agent's whole IPC surface — sessions, context, runs, permissions.
    // Without this the composer has no handlers to call and simply spins.
    registerGlyphhIpc();
    // The library pages: loops, skills, agents.
    registerLibraryIpc();
    // Live agents' scheduled tasks fire while the app runs.
    startAgentScheduler();
  }

  if (!ipcMain.listenerCount("get-preference")) {
    ipcMain.handle("get-preference", (_e, key: string, defaultVal: unknown) => {
      return getPreference(key, defaultVal);
    });
  }

  // ⌘⇧Space anywhere on the system: front Glyphh and open the command
  // center (the renderer's opener applies the desktop-overlay preference).
  globalShortcut.register("CommandOrControl+Shift+Space", () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      const homes = webContents.getAllWebContents().filter((wc) => {
        try { return !wc.isDestroyed() && /home\.html/.test(wc.getURL()); } catch { return false; }
      });
      for (const wc of homes) wc.send("home:open-cc");
    } catch { /* window mid-teardown */ }
  });

  // Create window
  await createWindow();
  // Background mode: rebuild the window when the tray asks, and reflect the
  // current setting (tray + launch-at-login) now.
  setReopenHandler(() => { void createWindow(); });
  syncBackgroundMode();

  // Drip effects
  dripManager = new DripManager();
  setDripManagerInstance(dripManager);
  if (mainWindow) dripManager.setMainWindow(mainWindow);
  commandParser.setDripManager(dripManager);

  // Account gate — the heartbeat reports the account status. When it reports
  // the account disabled (an admin action) we lock the user out of the
  // workspace: hide the home view and raise the lockout overlay in the renderer.
  // Registered BEFORE initAuth so the first heartbeat (fired fire-and-forget
  // inside initAuth) can never slip past us.
  let accountLocked = false;
  setHeartbeatObserver((hb) => {
    // The rail's identity chip repaints from this — without it, logging out
    // and back in as a DIFFERENT account kept showing the previous user's
    // name for the whole app run (the renderer filled it once at boot).
    mainWindow?.webContents.send("account-updated", getAccountInfo());
    const locked = hb.status === "disabled";
    if (locked === accountLocked) return;
    accountLocked = locked;
    // Set the lock FIRST and unconditionally (independent of mainWindow
    // timing). While locked the home view refuses to attach, so nothing can
    // paint over the lockout overlay.
    homeView.setLocked(locked);
    if (locked) {
      if (mainWindow) homeView.hide(mainWindow);
      mainWindow?.webContents.send("account-locked", {
        status: hb.status,
        upgradeUrl: `${PLATFORM_URL}/billing`,
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
      homeView.hide(mainWindow);
      mainWindow.webContents.send("show-onboarding");
    }
  });

  // Initialize auth — restore session, schedule refresh, start heartbeat.
  // Hard 3s timeout so splash never hangs if server is unreachable.
  await Promise.race([initAuth(), new Promise((r) => setTimeout(r, 3000))]);

  // Keep OAuth-authed remote MCP connections alive: refresh their tokens ahead
  // of expiry and re-stamp the server-side connection header (the server dials
  // the endpoint, so we can't react to its 401s). Self-guards when signed out.
  startMcpOAuthRefresh();

  // Working directory — the single project folder the app is focused on.
  if (!ipcMain.listenerCount("working-dir:get")) {
    registerWorkingDirectoryIpc({
      getMainWindow: () => mainWindow,
      broadcastToPanels: (ch, ...args) => {
        const home = homeView.webContents;
        if (home) {
          try { home.send(ch, ...args); } catch { /* ignore */ }
        }
      },
      onWorkingDirChange: () => {
        // VS Code surface removed — nothing to re-point anymore.
      },
      // Re-open a recent entry. Folder-bound entries restore the captured
      // workdir first; non-folder apps leave the current workdir alone.
      // Apps open through the modern resolver (workbench panels / nav
      // sections); a layout recent lands on the Layouts section.
      openRecent: (entry) => {
        if (!mainWindow) return;
        if (entry.folder) setWorkingDirectory(entry.folder);
        const ref = entry.kind === "layout" ? "layouts" : entry.id;
        void openAppByRef(ref).catch(() => { /* app no longer resolvable */ });
      },
    });
  }

  // Check if onboarding is needed BEFORE loading the home view
  // (a BrowserView renders above HTML, so it'd cover the onboarding overlay)
  const authenticated = isAuthenticated();
  const needsOnboarding = !authenticated;
  let panelsReady = false;

  // Restore zoom level
  const savedZoom = getPreference<number>("zoom", 1.0);
  if (savedZoom !== 1.0) homeView.setZoom(savedZoom);

  // Start loading home.html behind the splash — the renderer reveals it via
  // panels-show once the splash dismisses. Skipped while onboarding gates.
  if (!needsOnboarding) {
    if (mainWindow) homeView.ensureCreated(mainWindow);
    panelsReady = true;
  }

  // Start cloud sync if authenticated and tier allows it

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
  // Every updater step lands in userData/updater.log — "it closed and never
  // came back" was undiagnosable with the logger nulled.
  const updaterLogPath = path.join(app.getPath("userData"), "updater.log");
  const upLog = (level: string, ...args: unknown[]): void => {
    try { fs.appendFileSync(updaterLogPath, `${new Date().toISOString()} ${level} ${args.map(String).join(" ")}\n`); } catch { /* disk */ }
  };
  autoUpdater.logger = {
    info: (...a: unknown[]) => upLog("INFO", ...a),
    warn: (...a: unknown[]) => upLog("WARN", ...a),
    error: (...a: unknown[]) => upLog("ERROR", ...a),
    debug: (...a: unknown[]) => upLog("DEBUG", ...a),
  } as unknown as typeof autoUpdater.logger;

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

  // Reveal the shell splash (the home view is a BrowserView layered over
  // index.html) with an "Updating…" status, then quit + install + relaunch.
  const doUpdateInstall = () => {
    broadcastUpdate({ status: "restarting", version: pendingUpdate?.version });
    if (mainWindow) homeView.hide(mainWindow);
    setTimeout(() => {
      upLog("INFO", "install: begin teardown");
      // Tear down BEFORE the installer runs: children (ptys, the agent
      // subprocess) and background handles die here, so when NSIS checks for
      // a running copy the answer is already no. markQuitting also disarms
      // the hide-on-close/tray keep-alives for the quit that follows.
      markQuitting();
      // quitAndInstall closes every window — our window-all-closed handler
      // then fires a PLAIN app.quit(), and with autoInstallOnAppQuit=false a
      // plain quit that wins the race exits WITHOUT installing: app closed,
      // installer never ran, version unchanged. Silence it for this quit.
      app.removeAllListeners("window-all-closed");
      // Long backstop: the 4s hard-exit inside cleanupAll killed the process
      // mid-handoff and aborted the install the same way.
      cleanupAll(30_000);
      // Hand the single-instance lock back BEFORE the installer runs: the
      // relaunched new version arrives while this process is still dying,
      // and without this it lost the lock race and exited on the spot —
      // "the app closed and never came back" after every update.
      try { app.releaseSingleInstanceLock(); } catch { /* already released */ }
      upLog("INFO", "install: calling quitAndInstall");
      try { autoUpdater.quitAndInstall(false, true); }
      catch (err) { upLog("ERROR", "quitAndInstall failed:", err instanceof Error ? err.message : String(err)); }
    }, 1200);
  };
  // The About "Relaunch to Update" button invokes this via the update-install
  // IPC. If the download is still in flight, show the updating splash now and
  // install the moment it lands.
  const requestUpdateInstall = () => {
    if (pendingUpdate?.ready) { doUpdateInstall(); return; }
    installWhenReady = true;
    broadcastUpdate({ status: "restarting", version: pendingUpdate?.version });
    if (mainWindow) homeView.hide(mainWindow);
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
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 800).unref();
    // .unref() so this recurring check never keeps the process alive on quit.
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000).unref();
  } else {
    broadcastUpdate({ status: "none" });
  }

  // Global hotkey: Cmd+Y / Ctrl+Y
  registerHotkey(mainWindow!);
  // Ghost Mode: Cmd+Shift+G / Ctrl+Shift+G — coding agent as a translucent overlay.

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
            click: () => homeView.toggleDevTools(),
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
          // ⌘W routes through the renderer: close the top workbench panel
          // first; the renderer calls window-close itself when nothing is
          // open. A bare { role: "close" } killed the window while users
          // meant "close this panel".
          {
            label: "Close",
            accelerator: "CmdOrCtrl+W",
            click: () => { mainWindow?.webContents.send("close-gesture"); },
          },
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

  // IPC: refresh the home view
  ipcMain.on("panels-refresh", () => {
    homeView.reload();
  });

  // IPC: zoom
  ipcMain.on("panels-zoom", (_e, factor: number) => {
    homeView.setZoom(factor);
    setPreference("zoom", factor);
  });
  ipcMain.handle("panels-get-zoom", () => homeView.getZoom());

  // IPC: reveal downloaded file in Finder/Explorer
  ipcMain.on("download:show", (_e, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  // IPC: home view visibility — hidden while a shell overlay (splash,
  // onboarding, tutorial, lockout) must be visible above it.
  ipcMain.on("panels-hide", () => {
    if (mainWindow) homeView.hide(mainWindow);
  });
  ipcMain.on("panels-show", () => {
    if (!mainWindow || !panelsReady) return;
    homeView.show(mainWindow);
  });

  // yo-panel-send/-stop/cmd-palette-open removed with the interactive chat
  // agent panel (YoAgent + yo-panel-ui-vscode.ts).

  // Open a file from a yo-panel file link — defers to the OS default app.
  ipcMain.on("open-in-editor", (_e, filePath: string) => {
    if (typeof filePath !== "string" || !filePath) return;
    const resolved = path.isAbsolute(filePath) ? filePath : glyphhPath(filePath);
    void shell.openPath(resolved);
  });

  // File-open router — media open in the workbench Browser panel (the
  // glyphh-preview:// scheme streams local files, since the panel's webview
  // can't navigate to file:// itself); everything else hands off to the OS
  // default app via shell.openPath.
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
      const posix = resolved.split(path.sep).join("/");
      const previewUrl = "glyphh-preview://local" +
        (posix.startsWith("/") ? "" : "/") +
        posix.split("/").map(encodeURIComponent).join("/");
      openBrowserAt(previewUrl);
      return;
    }

    void shell.openPath(resolved);
  });

  // yo-panel-open/-prefill/-dismiss-from-renderer removed with the panel.
  // The Schedules run-history "View run" hand-off (previously window.glyphh.openYoChat
  // -> "yo-open-chat-from-renderer") was also removed from the renderer side
  // (src/renderer/help/schedules.ts) since there's no surface left to open a
  // run's transcript INTO. No handler is registered for that channel anymore.

  // Approval system, ask_user_question, and preview_url (wb-preview:*)
  // callback wiring removed — they only served the interactive chat agent's
  // (YoAgent) SDK MCP tools, which no longer exist. mcp-expose.ts's own
  // preview_url tool (used by run_jammer etc.) is unrelated — it posts to
  // cypherBus directly and was never routed through this machinery.

  // ── Extracted IPC modules ──────────────────────────────
  registerModelsIpc();
  registerSettingsIpc({
    getPreference, setPreference, broadcastTheme,
    startAuthFlow, isAuthenticated,
    getAccountInfo, getAuthStatus, refreshHeartbeat, logout,
    session, sendSessionState,
    execCommand,
    getMainWindow: () => mainWindow,
    hidePanels: () => { if (mainWindow) homeView.hide(mainWindow); },
  });

  registerAppsIpc({
    layoutManager, dripManager,
    canSaveLayout,
    getMainWindow: () => mainWindow,
  });

  // Installable Glyphh apps (marketplace unit) — capability-scoped windows.
  registerGlyphhAppHost();

  // Settings / home panel IPC — dashboard, MCP servers (relay), connectors, prompts.
  registerHomeIpc({
    mcpManager, connectorManager, canUseCustomMcp,
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
      // The ticket input is subject + description only — fold the build info in.
      return await getClient().support.ticket({
        subject: ticket.subject,
        description: `${ticket.description}\n\n— Glyphh Desktop ${app.getVersion()} (${process.platform} ${process.arch})`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  // IPC: preferences
  ipcMain.on("set-preference", (_e, key: string, value: unknown) => {
    setPreference(key, value);
    // Notify every panel/BrowserView so forms reading this pref (e.g. Settings →
    // Agent Defaults) update immediately when it's changed elsewhere (e.g. the
    // compaction modal in the right-rail .Yo agent).
    for (const wc of webContents.getAllWebContents()) {
      try { wc.send("preference-changed", key, value); } catch { /* ignore */ }
    }
  });
  // (get-preference IPC registered earlier, before the first window loads)

  // IPC: relaunch app (for settings that require restart)
  ipcMain.on("relaunch", () => {
    app.relaunch();
    app.exit(0);
  });

  // IPC: onboarding complete — start loading Home behind the tutorial
  ipcMain.handle("onboarding-complete", () => {
    if (mainWindow) homeView.ensureCreated(mainWindow);
    panelsReady = true;
    // Keep the view detached — the tutorial shows next and it's HTML that
    // gets painted under BrowserViews. panelsShow fires when tutorial closes.
    if (mainWindow) homeView.hide(mainWindow);
  });

  // The app-preview <webview> (Apps page) previews installed glyphh-apps, whose
  // UI calls window.glyphh.call — so it needs the same preload the standalone app
  // window gets (openGlyphhApp). A webview's preload is fixed when its guest is
  // created, so it must be set here at will-attach time (setting it later is
  // ignored). Inert for ordinary web-app previews: glyphh-app:call rejects any
  // webContents without a capability grant (granted per-app via preview-open).
  (mainWindow?.webContents as any)?.on(
    "will-attach-webview",
    (_event: unknown, webPreferences: Electron.WebPreferences) => {
      webPreferences.preload = path.join(__dirname, "glyphh-app-preload.js");
    },
  );

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
      if (mainWindow) homeView.ensureCreated(mainWindow);
      panelsReady = true;
    }
  }

  mainWindow?.webContents.on("did-finish-load", sendBoot);
  if (!mainWindow?.webContents.isLoading()) sendBoot();
}

protocol.registerSchemesAsPrivileged([
  { scheme: "yo-asset", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // Local-file previews for the workbench Browser panel. Chromium refuses
  // file:// subframe navigation (and the panel iframe is sandboxed), so the
  // renderer loads glyphh-preview://local/<path> and main streams the file.
  // stream:true so video/PDF get ranged responses.
  { scheme: "glyphh-preview", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ── Single instance ──────────────────────────────────────────
// Without this, a second launch (or a background-resident copy from an earlier
// session) runs alongside the first — and the Windows updater then hangs
// forever on "an existing version is running": the updating instance exits,
// but NSIS finds the other one. A half-finished install after that is how a
// mixed-binary tree (agent subprocess access violations) happens. One instance,
// ever; a second launch fronts the existing window instead.
// The lock can be briefly held by a DYING copy of the app — most commonly
// the old version tearing down while the auto-updater relaunches the new
// one. Retry for a few seconds before concluding we're a true second
// launch; exiting immediately here is what made updated installs "never
// come back".
const startWithLock = (attempt: number): void => {
  if (app.requestSingleInstanceLock()) {
    app.on("second-instance", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
    void app.whenReady().then(boot);
    return;
  }
  if (attempt < 3) setTimeout(() => startWithLock(attempt + 1), 1200);
  else app.exit(0);
};
startWithLock(0);

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
  // Stay resident in background mode (tray keeps the process + scheduler alive).
  if (isBackgroundEnabled() && !isQuitting()) return;
  cleanupAll();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// An explicit Quit (⌘Q, menu, tray) must tear down even in background mode —
// mark it so the window's close guard stops hiding.
app.on("before-quit", () => { markQuitting(); });

// A missing helper binary (spawn ENOENT surfaces as an ASYNC uncaught
// exception) must degrade the feature, never crash the app into the OS error
// dialog. Anything landing here is a bug to fix — but the user keeps working.
process.on("uncaughtException", (err) => {
  console.error("[main] uncaught exception (survived):", err?.stack || err);
});

app.on("will-quit", () => {
  cleanupAll();
});

let cleanedUp = false;
function cleanupAll(backstopMs = 4000) {
  if (cleanedUp) return;
  cleanedUp = true;
  // Arm the hard-exit FIRST: if any teardown step below throws, the process must
  // still die rather than zombie. .unref() so it never keeps the loop alive on
  // its own — a clean teardown exits well before this fires. The UPDATE path
  // passes a much longer budget: process.exit(0) during quitAndInstall's
  // handoff KILLS the installer — the app closed, nothing installed.
  setTimeout(() => process.exit(0), backstopMs).unref();
  try {
    const tabs = getPreference<string[]>("openTabs", []);
    if (tabs.includes("cypher")) {
      setPreference("openTabs", tabs.filter((t: string) => t !== "cypher"));
    }
  } catch {}
  // Each step is isolated so one failure can't strand the rest (or the exit).
  // Order: unregister shortcuts, stop timers/loops, kill children, then close
  // the background handles + hidden app-worker windows that otherwise keep the
  // Node event loop alive and window-all-closed from firing.
  const steps: Array<[string, () => void]> = [
    ["globalShortcut", () => globalShortcut.unregisterAll()],
    ["mcpOAuthRefresh", () => stopMcpOAuthRefresh()],
    ["authTimers", () => cleanupAuthTimers()],
    ["glyphh", () => shutdownGlyphh()],
    ["agentScheduler", () => stopAgentScheduler()],
    ["connectors", () => connectorManager?.cleanup()],
    ["drips", () => dripManager?.cleanup()],
    ["localMcpServer", () => stopLocalMcpServer()],
    ["appWorkers", () => stopAllAppWorkers()],
    ["schedules", () => stopAllSchedules()],
    ["localDb", () => closeLocalDb()],
    ["dataStoreDb", () => closeDataStoreDb()],
  ];
  for (const [name, fn] of steps) {
    try { fn(); } catch (err) { console.warn(`[quit] cleanup step "${name}" failed:`, err); }
  }
}
