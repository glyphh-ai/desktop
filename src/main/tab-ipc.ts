import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import type { PanelManager } from "./panel-manager";
import type { LayoutManager } from "./layout-manager";
import type { AppConnector } from "./app-connector";
import type { PanelCommandInterceptor } from "./panel-commands";

interface TabIpcDeps {
  panelManager: PanelManager;
  layoutManager: LayoutManager;
  appConnector: AppConnector;
  panelCommands: PanelCommandInterceptor;
  getMainWindow: () => BrowserWindow | null;
  openTabs: string[];
  tabBrowserCounter: { value: number };
  panelInstanceCounter: { value: number };
  panelNavWc: Record<string, Electron.WebContents>;
  resolveAppId: (panelId: string | null | undefined) => string;
  resolveBrowserHome: () => string;
  browserHtmlUrl: (initialUrl?: string) => string;
  ensureTab: (id: string | null | undefined) => void;
  persistTabs: () => void;
  sendSplitState: () => void;
  sendTabState: () => void;
  createPanelForApp: (instanceId: string, app: { id: string; url?: string; forceWeb?: boolean }) => void;
  setPreference: (key: string, value: unknown) => void;
  getPreference: <T>(key: string, fallback: T) => T;
  URL_BAR_HEIGHT: number;
}

export function registerTabIpc(deps: TabIpcDeps): void {
  const {
    panelManager, layoutManager, appConnector,
    getMainWindow, openTabs, tabBrowserCounter, panelInstanceCounter,
    panelNavWc,
    resolveAppId, resolveBrowserHome, browserHtmlUrl,
    ensureTab, persistTabs, sendSplitState, sendTabState,
    createPanelForApp,
    setPreference, getPreference, URL_BAR_HEIGHT,
  } = deps;

  // ── Tab handlers ──────────────────────────────────────────

  ipcMain.on("tab-switch", (_e, id: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    if (id === "__layout__") {
      // Clicking the layout tab restores the grid (from active or suspended)
      if (!layoutManager.hasSplit) {
        layoutManager.resumeSplit(mainWindow);
      } else {
        layoutManager.restoreSplit(mainWindow);
      }
      const gridInfo = layoutManager.getGridInfo();
      if (gridInfo) {
        setPreference("lastView", {
          type: "grid-full",
          grid: { name: "", version: 2, cols: gridInfo.cols, rows: gridInfo.rows, colWidths: gridInfo.colWidths, rowHeights: gridInfo.rowHeights, cells: gridInfo.cells },
        });
        setPreference("suspendedLayout", null);
      }
    } else {
      // Suspend grid so the layout tab persists
      layoutManager.suspendSplit();
      panelManager.switchTo(id, mainWindow);
      setPreference("lastView", { type: "panel", id });

      // Persist suspended grid for restart
      const suspended = layoutManager.getSuspendedGridInfo();
      if (suspended) {
        setPreference("suspendedLayout", {
          version: 2, name: suspended.name, cols: suspended.cols, rows: suspended.rows,
          colWidths: suspended.colWidths, rowHeights: suspended.rowHeights, cells: suspended.cells,
        });
      }
    }
    sendSplitState();
    sendTabState();
  });

  ipcMain.on("tab-reorder", (_e, newOrder: string[]) => {
    // Filter to ids that actually exist in openTabs, always keeping home first
    const existing = new Set(openTabs);
    const sanitized = newOrder.filter((id) => existing.has(id) && id !== "__layout__");
    // Preserve any open tabs the renderer didn't include (shouldn't happen, but safe)
    for (const id of openTabs) {
      if (!sanitized.includes(id)) sanitized.push(id);
    }
    openTabs.length = 0;
    openTabs.push(...sanitized);
    persistTabs();
    sendTabState();
  });

  ipcMain.on("tab-close", (_e, id: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;

    // Closing the layout tab clears the grid (active or suspended)
    if (id === "__layout__") {
      const gridInfo = layoutManager.getGridInfo() || layoutManager.getSuspendedGridInfo();
      if (gridInfo) {
        for (const panelId of gridInfo.panelIds) {
          const idx = openTabs.indexOf(panelId);
          if (idx >= 0) openTabs.splice(idx, 1);
          panelManager.closePanel(panelId, mainWindow);
        }
      }
      layoutManager.clearSplit();
      layoutManager.clearSuspended();
      setPreference("suspendedLayout", null);
      // Switch to first remaining tab
      if (openTabs.length > 0) {
        panelManager.switchTo(openTabs[0], mainWindow);
      }
      persistTabs();
      sendSplitState();
      sendTabState();
      applyUrlBarForActive();
      return;
    }

    const idx = openTabs.indexOf(id);
    if (idx < 0) return;
    openTabs.splice(idx, 1);
    persistTabs();
    const nextId = openTabs[Math.min(idx, openTabs.length - 1)];
    panelManager.closePanel(id, mainWindow, nextId);
    // Clean up saved browser URL
    if (resolveAppId(id) === "browser") {
      const saved = getPreference<Record<string, string>>("browserTabUrls", {});
      delete saved[id];
      setPreference("browserTabUrls", saved);
    }
    sendSplitState();
    sendTabState();
    // The active panel changed — re-evaluate the URL bar so it doesn't linger
    // after the browser (or the last tab) is closed.
    applyUrlBarForActive();
  });

  ipcMain.on("tab-close-all", () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;

    // Close every non-pinned tab. Pinned tabs (home) stay so the user always
    // has a place to land. Reuse the existing single-close path per id so
    // layout/browser bookkeeping (suspended grid clear, browserTabUrls
    // cleanup, etc.) stays in one place.
    const ids = openTabs.filter((id) => id !== "home");
    for (const id of ids) {
      const idx = openTabs.indexOf(id);
      if (idx < 0) continue;

      if (id === "__layout__") {
        const gridInfo = layoutManager.getGridInfo() || layoutManager.getSuspendedGridInfo();
        if (gridInfo) {
          for (const panelId of gridInfo.panelIds) {
            const pidx = openTabs.indexOf(panelId);
            if (pidx >= 0) openTabs.splice(pidx, 1);
            panelManager.closePanel(panelId, mainWindow);
          }
        }
        layoutManager.clearSplit();
        layoutManager.clearSuspended();
        setPreference("suspendedLayout", null);
        const layoutIdx = openTabs.indexOf("__layout__");
        if (layoutIdx >= 0) openTabs.splice(layoutIdx, 1);
        continue;
      }

      openTabs.splice(idx, 1);
      panelManager.closePanel(id, mainWindow);
      if (resolveAppId(id) === "browser") {
        const saved = getPreference<Record<string, string>>("browserTabUrls", {});
        delete saved[id];
        setPreference("browserTabUrls", saved);
      }
    }
    persistTabs();
    // Land on the pinned home tab if it's there, else nothing active.
    if (openTabs.includes("home")) {
      panelManager.switchTo("home", mainWindow);
    }
    sendSplitState();
    sendTabState();
    applyUrlBarForActive();
  });

  ipcMain.on("tab-new", () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    tabBrowserCounter.value++;
    const id = `browse-${tabBrowserCounter.value}`;
    const homeUrl = resolveBrowserHome();
    panelManager.addPanel(id, browserHtmlUrl(homeUrl), undefined, undefined, true);
    panelManager.switchTo(id, mainWindow);
    ensureTab(id);
    sendSplitState();
    sendTabState();
  });

  ipcMain.on("tab-new-app", (_e, appId: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    const app = appConnector.get(appId);
    if (!app?.url) return;

    layoutManager.suspendSplit();

    // System apps (Dashboard, Apps, Agents, Vibes, Councils, Schedules,
    // Layouts, Skills, Drips, Settings, Welcome) and `home` are singletons:
    // there's only ever one of each. Opening one that's already open just
    // slides to the existing panel — no second tab, no second instance.
    // User apps keep "already open → spawn new instance" so users can have
    // two Browsers, two Vibes on different folders, etc.
    const isSingleton = appId === "home" || app.kind === "system";

    if (isSingleton) {
      if (!panelManager.hasPanel(appId)) createPanelForApp(appId, app);
      panelManager.switchTo(appId, mainWindow);
      ensureTab(appId);
    } else {
      const alreadyOpen = openTabs.some(t => t === appId || resolveAppId(t) === appId);
      if (alreadyOpen) {
        panelInstanceCounter.value++;
        const instanceId = `${appId}-${panelInstanceCounter.value}`;
        createPanelForApp(instanceId, app);
        panelManager.switchTo(instanceId, mainWindow);
        ensureTab(instanceId);
      } else {
        if (!panelManager.hasPanel(appId)) createPanelForApp(appId, app);
        panelManager.switchTo(appId, mainWindow);
        ensureTab(appId);
      }
    }
    setPreference("lastView", { type: "panel", id: openTabs[openTabs.length - 1] });
    sendSplitState();
    sendTabState();
  });

  // Force a brand-new instance/window of an app (the "New window" menu item).
  ipcMain.on("tab-new-window", (_e, appId: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    const baseId = resolveAppId(appId) || appId;
    const app = appConnector.get(baseId);
    if (!app?.url) return;
    layoutManager.suspendSplit();
    panelInstanceCounter.value++;
    const instanceId = `${baseId}-${panelInstanceCounter.value}`;
    createPanelForApp(instanceId, app);
    ensureTab(instanceId);
    panelManager.switchTo(instanceId, mainWindow);
    setPreference("lastView", { type: "panel", id: openTabs[openTabs.length - 1] });
    sendSplitState();
    sendTabState();
  });

  // Browser tab → "Create App": open Home and route it to the New App form
  // with the URL prefilled. The Home renderer (onOpenNewApp) handles the rest.
  ipcMain.on("create-app-from-tab", (_e, tabId: string, url: string, name: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    const homeApp = appConnector.get("home");
    if (homeApp && !panelManager.hasPanel("home")) createPanelForApp("home", homeApp);
    panelManager.switchTo("home", mainWindow);
    ensureTab("home");
    sendSplitState();
    sendTabState();
    panelManager.getView("home")?.webContents.send("open-new-app", { url, name, tabId });
  });

  // Convert a browser tab into a freshly-created app: open the app as a tab,
  // then close the originating browser tab.
  ipcMain.on("convert-tab-to-app", (_e, tabId: string, appId: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    const app = appConnector.get(appId);
    if (!app?.url) return;
    if (!panelManager.hasPanel(appId)) createPanelForApp(appId, app);
    ensureTab(appId);
    panelManager.switchTo(appId, mainWindow);
    if (tabId && tabId !== "home" && tabId !== appId) {
      const idx = openTabs.indexOf(tabId);
      if (idx >= 0) {
        openTabs.splice(idx, 1);
        panelManager.closePanel(tabId, mainWindow, appId);
        if (resolveAppId(tabId) === "browser") {
          const saved = getPreference<Record<string, string>>("browserTabUrls", {});
          delete saved[tabId];
          setPreference("browserTabUrls", saved);
        }
      }
    }
    setPreference("lastView", { type: "panel", id: appId });
    persistTabs();
    sendSplitState();
    sendTabState();
  });

  // ── URL bar handlers ──────────────────────────────────────

  // Apply initial URL bar state
  if (getPreference<boolean>("showUrlBar", true)) {
    panelManager.setTopInset(URL_BAR_HEIGHT);
  }

  ipcMain.on("url-bar-navigate", (_e, url: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    const id = panelManager.activePanelId;
    if (!id) return;

    // Normalize: add protocol if missing, or search if not a URL
    let target = url.trim();
    if (target && !/^https?:\/\//i.test(target)) {
      if (/^localhost(:\d+)?(\/|$)/i.test(target) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(target)) {
        target = "http://" + target;
      } else if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z]{2,})+/i.test(target)) {
        target = "https://" + target;
      } else {
        target = "https://www.google.com/search?q=" + encodeURIComponent(target);
      }
    }

    const isBrowser = resolveAppId(id) === "browser";
    if (isBrowser) {
      // Navigate the webview guest inside browser.html
      const wc = panelManager.activeWebContents;
      if (wc && !wc.isDestroyed()) {
        wc.executeJavaScript(`(function(){
          const wv = document.querySelector("webview");
          if (wv) { wv.loadURL(${JSON.stringify(target)}); }
          const bar = document.getElementById("url");
          if (bar) bar.value = ${JSON.stringify(target)};
        })()`).catch(() => {});
      }
    } else {
      // Navigate the BrowserView directly
      const wc = panelManager.activeWebContents;
      if (wc && !wc.isDestroyed()) {
        wc.loadURL(target).catch(() => {});
      }
    }
  });

  ipcMain.on("url-bar-back", () => {
    const id = panelManager.activePanelId;
    if (!id) return;
    const nwc = panelNavWc[id];
    if (nwc && !nwc.isDestroyed()) {
      nwc.navigationHistory.goBack();
    }
  });

  ipcMain.on("url-bar-forward", () => {
    const id = panelManager.activePanelId;
    if (!id) return;
    const nwc = panelNavWc[id];
    if (nwc && !nwc.isDestroyed()) {
      nwc.navigationHistory.goForward();
    }
  });

  ipcMain.on("url-bar-refresh", () => {
    const id = panelManager.activePanelId;
    if (!id) return;
    const nwc = panelNavWc[id];
    if (nwc && !nwc.isDestroyed()) {
      nwc.reload();
    }
  });

  // Per-panel nav (for cell URL bars in grid mode)
  ipcMain.on("panel-nav-back", (_e, panelId: string) => {
    const nwc = panelNavWc[panelId];
    if (nwc && !nwc.isDestroyed()) nwc.navigationHistory.goBack();
  });
  ipcMain.on("panel-nav-forward", (_e, panelId: string) => {
    const nwc = panelNavWc[panelId];
    if (nwc && !nwc.isDestroyed()) nwc.navigationHistory.goForward();
  });
  ipcMain.on("panel-nav-refresh", (_e, panelId: string) => {
    const nwc = panelNavWc[panelId];
    if (nwc && !nwc.isDestroyed()) nwc.reload();
  });
  ipcMain.on("panel-nav-to", (_e, panelId: string, url: string) => {
    // Normalize like the main URL bar: bare hosts → https, otherwise search.
    let target = url.trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) {
      if (/^localhost(:\d+)?(\/|$)/i.test(target) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(target)) {
        target = "http://" + target;
      } else if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z]{2,})+/i.test(target)) {
        target = "https://" + target;
      } else {
        target = "https://www.google.com/search?q=" + encodeURIComponent(target);
      }
    }
    // panelNavWc[id] is the navigable webContents itself — for a browser panel
    // that's the <webview> guest (set on did-attach-webview), for a direct app
    // panel it's the BrowserView. Either way, load straight into it.
    const nwc = panelNavWc[panelId];
    if (!nwc || nwc.isDestroyed()) return;
    nwc.loadURL(target).catch(() => {});
  });

  // Recompute URL-bar visibility from the CURRENT active panel and apply it
  // (inset + force). The bar shows only when there's an active panel that is a
  // browser, or the user's global showUrlBar pref is on. Called whenever the
  // active panel changes (incl. closing the last tab) so the bar never lingers.
  function applyUrlBarForActive(): void {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // In a split/grid layout the URL bar is per-cell and belongs to the whole
    // grid, not the focused cell. Deciding from the single active panel would
    // hide the browser cell's URL bar the moment a non-browser cell is focused
    // (and you could no longer change its URL). Base it on whether the grid has
    // any browser instead.
    if (layoutManager.hasSplit) {
      const showBar = layoutManager.gridHasBrowser();
      panelManager.setTopInset(showBar ? URL_BAR_HEIGHT : 0);
      mainWindow.webContents.send("url-bar-force", showBar);
      return;
    }
    const id = panelManager.activePanelId;
    const isBrowser = id ? resolveAppId(id) === "browser" : false;
    const showBar = !!id && (isBrowser || getPreference<boolean>("showUrlBar", false));
    panelManager.setTopInset(showBar ? URL_BAR_HEIGHT : 0);
    mainWindow.webContents.send("url-bar-force", showBar);
  }

  ipcMain.on("url-bar-toggle", (_e, show: boolean) => {
    setPreference("showUrlBar", show);
    applyUrlBarForActive();
  });
}
