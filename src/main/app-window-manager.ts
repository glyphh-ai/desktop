/**
 * AppWindowManager — one real OS window per opened app (5b of the app-shell
 * rewrite). Each window is a native-framed BrowserWindow hosting
 * app-window.html: a thin chrome strip (app name + globe URL-row toggle,
 * ported from the retired canvas-chrome) over a full-bleed <webview> on the
 * shared persist:yo session. The terminal is the one special case — it loads
 * terminal.html + terminal-preload directly (its PTY IPC is global).
 *
 * Geometry is Node-controlled (Electron screen module) — windows cascade on
 * the display under the cursor. Layouts open in two modes:
 *   - "window": ONE window hosting layout-window.html with the cells tiled
 *     inside it as webviews (CSS grid).
 *   - "screen": one window PER cell, tiled across the display's work area
 *     using the layout's grid fractions.
 *
 * Every <webview> reports its WebContents id keyed by app slug (via
 * app-window-preload) so the MCP relay's RPA tools can target apps by name.
 */

import { BrowserWindow, ipcMain, nativeTheme, screen, shell, webContents } from "electron";
import path from "path";
import { getPreference } from "./stores/preferences-db";
import { PanelManager } from "./panel-manager";

export interface AppWindowSpec {
  /** Stable identity — one window per slug; re-opening focuses it. */
  slug: string;
  name: string;
  /** http(s) URL for webview apps, or "yo://terminal" for the terminal. */
  url: string;
  /** Block native-app redirects (slack:// etc.) and desktop-app prompts. */
  forceWeb?: boolean;
}

const CASCADE_STEP = 32;
const DEFAULT_W = 1100;
const DEFAULT_H = 760;

const windows = new Map<string, { win: BrowserWindow; spec: AppWindowSpec }>();
/** slug → WebContents id of the app's <webview> (reported by the preload). */
const webviewIds = new Map<string, number>();
/** slug → original app URL, for force-web apps only (parent for native→web mapping). */
const forceWebApps = new Map<string, string>();
const forceWebConfigured = new WeakSet<Electron.WebContents>();
let cascade = 0;

ipcMain.on("app-window-webview-attached", (_e, slug: string, wcId: number) => {
  if (typeof slug === "string" && typeof wcId === "number") {
    webviewIds.set(slug, wcId);
    if (forceWebApps.has(slug)) {
      const wc = webContents.fromId(wcId);
      if (wc && !wc.isDestroyed()) applyForceWeb(slug, wc);
    }
  }
});

/**
 * Force-web treatment for an app's webview — same mechanics the old
 * BrowserView panels had (PanelManager): block native-protocol redirects
 * (slack://, zoommtg://, …) and map them back to the web client, block
 * download/get-started page redirects, police popups the same way, and
 * inject the banner-hiding script on every load.
 */
function applyForceWeb(slug: string, wc: Electron.WebContents): void {
  if (forceWebConfigured.has(wc)) return;
  forceWebConfigured.add(wc);
  const parentUrl = forceWebApps.get(slug) || wc.getURL();

  wc.on("will-navigate", (e, url) => {
    if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("about:")) {
      e.preventDefault();
      const web = PanelManager.nativeToWebUrl(url, parentUrl);
      if (web) void wc.loadURL(web);
      return;
    }
    try {
      const u = new URL(url);
      if (/\/(get-started|download|desktop|install|apps)\b/i.test(u.pathname)) {
        console.log(`[app-window:${slug}:forceWeb] blocked redirect to:`, url);
        e.preventDefault();
      }
    } catch { /* malformed URL */ }
  });

  // Replaces the generic popup handler set at attach time — force-web apps
  // map native-protocol popups back into the webview instead of the OS.
  wc.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("about:")) {
      const web = PanelManager.nativeToWebUrl(url, parentUrl);
      if (web) void wc.loadURL(web);
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        webPreferences: { contextIsolation: true, nodeIntegration: false, partition: "persist:yo" },
      },
    };
  });

  // Popups that open https:// then bounce to slack:// — block the bounce,
  // send the parent to the web client, and close the popup.
  wc.on("did-create-window", (child) => {
    child.webContents.on("will-navigate", (e, navUrl) => {
      if (!navUrl.startsWith("http://") && !navUrl.startsWith("https://") && !navUrl.startsWith("about:")) {
        console.log(`[app-window:${slug}:forceWeb] child blocked:`, navUrl.slice(0, 120));
        e.preventDefault();
        const web = PanelManager.nativeToWebUrl(navUrl, parentUrl);
        if (web) void wc.loadURL(web);
        setTimeout(() => { if (!child.isDestroyed()) child.close(); }, 300);
      }
    });
  });

  const inject = () => { void wc.executeJavaScript(PanelManager.FORCE_WEB_JS).catch(() => {}); };
  wc.on("did-finish-load", inject);
  if (!wc.isLoading()) inject();
}

// Same map main.ts uses for the in-dashboard browser panel — the standalone
// browser window opens at the Appearance-tab homepage too.
const BROWSER_HOMES: Record<string, string> = {
  google: "https://www.google.com",
  claude: "https://claude.ai",
  chatgpt: "https://chatgpt.com",
  gemini: "https://gemini.google.com",
};

export function resolveBrowserHomeUrl(): string {
  const pref = getPreference<string>("browserHomepage", "claude");
  if (pref === "custom") return getPreference<string>("browserHomepageUrl", "") || BROWSER_HOMES.claude;
  return BROWSER_HOMES[pref] || BROWSER_HOMES.claude;
}

function rendererFile(name: string): string {
  return `file://${path.join(__dirname, "..", "renderer", name)}`;
}

function allowWebviewPopups(win: BrowserWindow): void {
  // Webview popups (OAuth flows, target=_blank) — allow http(s) as real
  // windows on the same session, everything else goes to the OS browser.
  (win.webContents as any).on("did-attach-webview", (_e: unknown, childWc: Electron.WebContents) => {
    childWc.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        void shell.openExternal(url).catch(() => {});
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
}

/** Themed window background — matches styles.css --bg so a freshly created
 *  window paints as a themed tile instead of flashing white while its shell
 *  page (and the webview content behind it) loads. */
function themedBackground(): string {
  const t = getPreference<string>("theme", "dark");
  if (t === "light") return "#f5f5f5";
  if (t === "purple") return "#140a1f";
  if (t === "aurora") return "#0a0610";
  if (t === "system") return nativeTheme.shouldUseDarkColors ? "#1a1a1c" : "#f5f5f5";
  return "#1a1a1c"; // dark
}

function makeWindow(slug: string, spec: AppWindowSpec, fileUrl: string, opts: { preload?: string; webviewTag?: boolean }, bounds?: Electron.Rectangle): BrowserWindow {
  const win = new BrowserWindow({
    ...(bounds ?? {}),
    width: bounds?.width ?? DEFAULT_W,
    height: bounds?.height ?? DEFAULT_H,
    title: spec.name,
    show: false,
    backgroundColor: themedBackground(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      ...(opts.preload ? { preload: opts.preload } : {}),
      ...(opts.webviewTag ? { webviewTag: true } : {}),
    },
  });
  if (opts.webviewTag) allowWebviewPopups(win);
  void win.loadURL(fileUrl);
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (windows.get(slug)?.win === win) windows.delete(slug);
    webviewIds.delete(slug);
  });
  windows.set(slug, { win, spec });
  return win;
}

function createAppWindow(spec: AppWindowSpec, bounds?: Electron.Rectangle): BrowserWindow {
  if (spec.url === "yo://terminal") {
    // Terminal renders directly (xterm + PTY IPC), no webview shell.
    return makeWindow(spec.slug, spec, rendererFile("terminal.html"), {
      preload: path.join(__dirname, "terminal-preload.js"),
    }, bounds);
  }
  if (spec.forceWeb) forceWebApps.set(spec.slug, spec.url);
  const q = new URLSearchParams({ slug: spec.slug, name: spec.name, url: spec.url });
  return makeWindow(spec.slug, spec, `${rendererFile("app-window.html")}?${q.toString()}`, {
    preload: path.join(__dirname, "app-window-preload.js"),
    webviewTag: true,
  }, bounds);
}

function cascadeBounds(): Electron.Rectangle {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const offset = (cascade++ % 8) * CASCADE_STEP;
  const width = Math.min(DEFAULT_W, area.width);
  const height = Math.min(DEFAULT_H, area.height);
  return {
    x: Math.min(area.x + 60 + offset, area.x + area.width - width),
    y: Math.min(area.y + 40 + offset, area.y + area.height - height),
    width,
    height,
  };
}

/** Open (or focus) the app's window, cascaded on the display under the cursor. */
export function openAppWindow(spec: AppWindowSpec): void {
  const existing = windows.get(spec.slug);
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.focus();
    return;
  }
  createAppWindow(spec, cascadeBounds());
}

/** Slide a Glyphh app window in from the left, ending full-screen (work area).
 *  Used by `.dip <app>` / the command overlay so a single app opens big with a
 *  quick left→right motion. Re-opening an app just brings it full-screen. */
export function openAppWindowSlide(spec: AppWindowSpec): void {
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const target: Electron.Rectangle = { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
  const existing = windows.get(spec.slug);
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.setBounds(target);
    existing.win.focus();
    return;
  }
  const start: Electron.Rectangle = { ...target, x: wa.x - wa.width };
  const win = createAppWindow(spec, start);
  animateSlideX(win, start.x, target.x, wa.y, wa.width, wa.height);
}

function animateSlideX(win: BrowserWindow, fromX: number, toX: number, y: number, w: number, h: number): void {
  const steps = 14;
  let i = 0;
  const timer = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(timer); return; }
    i++;
    const t = Math.min(1, i / steps);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    win.setBounds({ x: Math.round(fromX + (toX - fromX) * eased), y, width: w, height: h });
    if (i >= steps) { clearInterval(timer); if (!win.isDestroyed()) win.setBounds({ x: toX, y, width: w, height: h }); }
  }, 16);
}

/** Open (or move) a Glyphh app window at exact screen bounds — used to tile a
 *  web/webview app into a layout cell. */
export function openAppWindowAt(spec: AppWindowSpec, bounds: Electron.Rectangle): void {
  const existing = windows.get(spec.slug);
  if (existing && !existing.win.isDestroyed()) {
    existing.win.setBounds(bounds);
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.focus();
    return;
  }
  createAppWindow(spec, bounds);
}

export function focusAppWindow(slug: string): boolean {
  const entry = windows.get(slug);
  if (!entry || entry.win.isDestroyed()) return false;
  if (entry.win.isMinimized()) entry.win.restore();
  entry.win.focus();
  return true;
}

export function closeAppWindow(slug: string): boolean {
  const entry = windows.get(slug);
  if (!entry || entry.win.isDestroyed()) return false;
  entry.win.close();
  return true;
}

export interface AppWindowInfo {
  app: string;
  name: string;
  url: string | null;
  title: string | null;
  focused: boolean;
}

export function listAppWindows(): AppWindowInfo[] {
  const out: AppWindowInfo[] = [];
  for (const [slug, { win, spec }] of windows) {
    if (win.isDestroyed()) continue;
    const wc = getAppWebContents(slug);
    out.push({
      app: slug,
      name: spec.name,
      url: wc ? wc.getURL() : spec.url,
      title: wc ? wc.getTitle() : spec.name,
      focused: win.isFocused(),
    });
  }
  return out;
}

/** Live WebContents of the app's <webview> — the RPA target. Null when the
 *  app isn't open (or is the terminal, which has no web page to drive). */
export function getAppWebContents(slug: string): Electron.WebContents | null {
  const id = webviewIds.get(slug);
  if (id === undefined) return null;
  const wc = webContents.fromId(id);
  return wc && !wc.isDestroyed() ? wc : null;
}

// ── Layouts ────────────────────────────────────────────────

/** Server saved_layouts shape (saved-layout-service): equal-fraction grid. */
export interface LayoutSpec {
  name: string;
  cols: number;
  rows: number;
  cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
}

export type ResolveApp = (panelId: string) => AppWindowSpec | null;

/**
 * "screen" mode: one window per cell, tiled across the display under the
 * cursor using the layout's grid fractions — OS-level tiling, Node-controlled.
 */
export function openLayoutOnScreen(layout: LayoutSpec, resolveApp: ResolveApp): string[] {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const colW = area.width / layout.cols;
  const rowH = area.height / layout.rows;
  const opened: string[] = [];

  for (const cell of layout.cells) {
    const spec = resolveApp(cell.panelId);
    if (!spec) continue;
    const bounds: Electron.Rectangle = {
      x: Math.round(area.x + cell.col * colW),
      y: Math.round(area.y + cell.row * rowH),
      width: Math.round(cell.colSpan * colW),
      height: Math.round(cell.rowSpan * rowH),
    };
    const existing = windows.get(spec.slug);
    if (existing && !existing.win.isDestroyed()) {
      existing.win.setBounds(bounds);
      if (existing.win.isMinimized()) existing.win.restore();
      existing.win.focus();
    } else {
      createAppWindow(spec, bounds);
    }
    opened.push(spec.slug);
  }
  return opened;
}

/**
 * "window" mode: ONE regular window hosting the whole layout, cells tiled
 * inside it as webviews (layout-window.html renders the CSS grid).
 */
export function openLayoutInWindow(layout: LayoutSpec, resolveApp: ResolveApp): string[] {
  const cells = layout.cells
    .map((cell) => {
      const spec = resolveApp(cell.panelId);
      if (!spec || !spec.url.startsWith("http")) return null;
      if (spec.forceWeb) forceWebApps.set(spec.slug, spec.url);
      return { slug: spec.slug, name: spec.name, url: spec.url, col: cell.col, row: cell.row, colSpan: cell.colSpan, rowSpan: cell.rowSpan };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
  if (cells.length === 0) return [];

  const slug = `layout:${layout.name}`;
  const existing = windows.get(slug);
  if (existing && !existing.win.isDestroyed()) existing.win.close();

  const grid = { name: layout.name, cols: layout.cols, rows: layout.rows, cells };
  const q = new URLSearchParams({ grid: JSON.stringify(grid) });
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  makeWindow(slug, { slug, name: layout.name, url: "" }, `${rendererFile("layout-window.html")}?${q.toString()}`, {
    preload: path.join(__dirname, "app-window-preload.js"),
    webviewTag: true,
  }, {
    x: area.x + 40,
    y: area.y + 30,
    width: Math.min(Math.round(area.width * 0.9), area.width - 80),
    height: Math.min(Math.round(area.height * 0.9), area.height - 60),
  });
  return cells.map((c) => c.slug);
}

export function closeAllAppWindows(): void {
  for (const { win } of windows.values()) {
    if (!win.isDestroyed()) win.close();
  }
  windows.clear();
  webviewIds.clear();
}
