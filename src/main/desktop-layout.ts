/**
 * desktop-layout — open a DESKTOP-target layout ON the desktop: the old
 * "the whole desktop adjusts to the layout" behavior, rebuilt on the new model.
 *
 * Each WEB cell opens as a real OS window (a Glyphh-chromed webview window on
 * the shared persist:yo session) positioned + sized to its grid cell on the
 * primary display's work area. NATIVE cells launch their OS apps (position is
 * theirs — macOS/Windows do not let us place another app's window). Glyphh
 * itself collapses to the rail so the layout owns the screen.
 *
 * Windows opened here are tracked per layout name; re-opening a layout closes
 * the previous set first, so `.dip <layout>` is idempotent.
 */

import { BrowserWindow } from "electron";
import path from "node:path";
import type { ServerApp } from "./app-resolver.js";
import { placeGlyphhForLayout, setRailCollapsed, type GlyphhPlacement } from "./screen-layout.js";
import { openNativeTracked, openWebTracked, trackedWinId } from "./window-tiling.js";
import { osWindowsTrusted, setWindowBounds } from "./os-window-manager.js";
import { getMainWindowRef } from "./main-window-ref.js";

/** Legacy cell ids for the built-in tools, normalized to tool:<ViewKind>. */
const TOOL_ALIASES: Record<string, string> = {
  browser: "tool:preview", terminal: "tool:terminal", term: "tool:terminal",
};
const toolIdOf = (panelId: string): string | null => {
  const key = panelId.trim().toLowerCase();
  if (key.startsWith("tool:")) return key;
  return TOOL_ALIASES[key] ?? null;
};

/**
 * A workbench tool as its own OS window: the home page in solo mode
 * (?solo=tool:<kind>) — full preload/session, chrome hidden, one slot
 * filling the viewport. An Electron window, so positioning is exact and
 * needs no Accessibility grant.
 */
function openToolWindow(toolId: string, rect: { x: number; y: number; width: number; height: number }): BrowserWindow {
  const win = new BrowserWindow({
    ...rect,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "renderer", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  void win.loadFile(path.join(__dirname, "..", "renderer", "home.html"), { query: { solo: toolId } });
  win.once("ready-to-show", () => win.show());
  return win;
}

interface Cell {
  panelId: string;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

interface DesktopLayoutSpec {
  name: string;
  cols: number;
  rows: number;
  cells: Cell[];
  /** Where Glyphh itself sits while this layout owns the desktop. */
  glyphh?: GlyphhPlacement;
}

interface Rect { x: number; y: number; width: number; height: number }

/** One placed cell of an active layout. `win` = a window we own (tool/panel
 *  webview, or the Glyphh main window); `appId` = a tracked foreign window
 *  (native app / real browser) driven through the AX/user32 layer. */
interface LayoutEntry {
  cell: Cell;
  kind: "owned" | "glyphh" | "tracked";
  win?: BrowserWindow;
  appId?: string;
}

/** Live grid state of an applied desktop layout: column/row boundary lines in
 *  screen px. Resizing any member window moves the boundaries its edges sit
 *  on, and every other member re-tiles to the new grid — the whole desktop
 *  adjusts together. */
interface ActiveLayout {
  xs: number[]; // cols+1 column boundaries
  ys: number[]; // rows+1 row boundaries
  entries: LayoutEntry[];
  applying: boolean;
  cleanup: Array<() => void>;
}

const activeLayouts = new Map<string, ActiveLayout>();

const rectFor = (al: ActiveLayout, cell: Cell): Rect => ({
  x: Math.round(al.xs[cell.col]),
  y: Math.round(al.ys[cell.row]),
  width: Math.round(al.xs[cell.col + cell.colSpan] - al.xs[cell.col]),
  height: Math.round(al.ys[cell.row + cell.rowSpan] - al.ys[cell.row]),
});

/** Re-apply the grid to every member except `skip` (the window the user is
 *  dragging — their bounds are the authority that MOVED the boundaries). */
function applyGrid(al: ActiveLayout, skip?: LayoutEntry): void {
  al.applying = true;
  for (const e of al.entries) {
    if (e === skip) continue;
    const r = rectFor(al, e.cell);
    if (e.win && !e.win.isDestroyed()) {
      try { e.win.setBounds(r); } catch { /* window gone */ }
    } else if (e.appId) {
      const id = trackedWinId(e.appId);
      if (id) void setWindowBounds(id, r);
    }
  }
  setTimeout(() => { al.applying = false; }, 250);
}

const MIN_COL = 120;
const MIN_ROW = 90;

/** A member window finished a move/resize — treat its edges as the new
 *  positions of the boundaries they sit on (inner boundaries only; the layout
 *  area's outer frame stays put) and re-tile everyone else. */
function retileFrom(al: ActiveLayout, source: LayoutEntry): void {
  if (al.applying) return;
  const win = source.win;
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen() || win.isMaximized()) return; // full-screen intent — leave the rest
  const b = win.getBounds();
  const setX = (i: number, v: number): void => {
    if (i <= 0 || i >= al.xs.length - 1) return;
    al.xs[i] = Math.max(al.xs[i - 1] + MIN_COL, Math.min(al.xs[i + 1] - MIN_COL, v));
  };
  const setY = (i: number, v: number): void => {
    if (i <= 0 || i >= al.ys.length - 1) return;
    al.ys[i] = Math.max(al.ys[i - 1] + MIN_ROW, Math.min(al.ys[i + 1] - MIN_ROW, v));
  };
  const { cell } = source;
  setX(cell.col, b.x);
  setX(cell.col + cell.colSpan, b.x + b.width);
  setY(cell.row, b.y);
  setY(cell.row + cell.rowSpan, b.y + b.height);
  applyGrid(al, source);
}

/** Follow move/resize on every window we own. Attached AFTER the initial
 *  placement settles so the layout apply itself never triggers a re-tile. */
function attachRetile(al: ActiveLayout): void {
  for (const e of al.entries) {
    const win = e.win;
    if (!win || win.isDestroyed()) continue;
    const onEnd = (): void => retileFrom(al, e);
    win.on("resized", onEnd);
    win.on("moved", onEnd);
    al.cleanup.push(() => {
      try { win.off("resized", onEnd); win.off("moved", onEnd); } catch { /* gone */ }
    });
  }
}

function closeExisting(name: string): void {
  const al = activeLayouts.get(name);
  if (!al) return;
  for (const fn of al.cleanup) fn();
  for (const e of al.entries) {
    // Owned windows close with the layout; the Glyphh main window stays.
    if (e.kind === "owned" && e.win && !e.win.isDestroyed()) {
      try { e.win.close(); } catch { /* already gone */ }
    }
  }
  activeLayouts.delete(name);
}

/** The web url a row opens at (top-level url, else legacy launchConfig homes). */
function urlOf(app: ServerApp): string {
  const lc = app.launchConfig as { url?: unknown; homepage?: unknown } | null | undefined;
  return (
    app.url ||
    (typeof lc?.url === "string" ? lc.url : "") ||
    (typeof lc?.homepage === "string" ? lc.homepage : "")
  );
}

/**
 * Open `layout` on the desktop. Web cells become positioned webview windows;
 * native cells launch. Returns the names opened, in cell order.
 */
export async function openDesktopLayout(
  layout: DesktopLayoutSpec,
  resolve: (panelId: string) => ServerApp | undefined,
): Promise<string[]> {
  closeExisting(layout.name);
  // A Glyphh CELL means the main window is part of the grid itself — the
  // dock setting is overridden and the grid gets the full work area.
  const hasGlyphhCell = layout.cells.some((cell) => {
    const a = resolve(cell.panelId);
    return !!a && (a.appArchetype === "glyphh-self" || a.slug === "glyphh");
  });
  // Positioning OTHER apps' windows needs the Accessibility grant on macOS —
  // without it every AX move silently no-ops and apps open wherever they
  // like. Fail loudly BEFORE launching anything (webview cells are Glyphh's
  // own windows and don't need it).
  const needsAx = layout.cells.some((cell) => {
    if (toolIdOf(cell.panelId)) return false; // tool windows are Glyphh's own
    const app = resolve(cell.panelId);
    if (!app) return false;
    if (app.appArchetype === "glyphh-self" || app.slug === "glyphh") return false;
    if (app.isBrowser === false || app.execPath) return true;
    const b = (app.launchConfig as { browser?: unknown } | null | undefined)?.browser;
    return typeof b === "string" && b !== "" && b !== "glyphh-panel";
  });
  if (needsAx && process.platform === "darwin" && !(await osWindowsTrusted())) {
    throw new Error(
      "Glyphh can't position app windows — grant Accessibility to Glyphh in "
      + "System Settings → Privacy & Security → Accessibility (remove and re-add it "
      + "if it's already listed), then reopen the layout.",
    );
  }
  // Place Glyphh first (rail / docked edge / untouched) — the returned rect is
  // the screen real estate the layout's app windows tile into. A Glyphh CELL
  // overrides the dock: the grid gets the whole work area and the main window
  // tiles into its cell like any other app.
  const area = placeGlyphhForLayout(hasGlyphhCell ? { mode: "none" } : (layout.glyphh ?? { mode: "rail" }));
  const cols = Math.max(1, layout.cols);
  const rows = Math.max(1, layout.rows);
  const al: ActiveLayout = {
    xs: Array.from({ length: cols + 1 }, (_, i) => area.x + (area.width * i) / cols),
    ys: Array.from({ length: rows + 1 }, (_, i) => area.y + (area.height * i) / rows),
    entries: [],
    applying: false,
    cleanup: [],
  };
  const opened: string[] = [];

  for (const cell of layout.cells) {
    const rect = rectFor(al, cell);
    // Workbench tool cell → its own solo window (Electron: exact placement).
    const toolId = toolIdOf(cell.panelId);
    if (toolId) {
      al.entries.push({ cell, kind: "owned", win: openToolWindow(toolId, rect) });
      opened.push(toolId.slice(5));
      continue;
    }
    const app = resolve(cell.panelId);
    if (!app) continue;
    // Glyphh cell: the main window IS this tile.
    if (app.appArchetype === "glyphh-self" || app.slug === "glyphh") {
      const win = getMainWindowRef();
      if (win && !win.isDestroyed()) {
        setRailCollapsed(false);
        if (win.isMinimized()) win.restore();
        win.setBounds(rect);
        // The expand tween (if the rail was collapsed) animates toward the
        // OLD bounds for ~180ms — re-assert the cell after it settles.
        setTimeout(() => { try { if (!win.isDestroyed()) win.setBounds(rect); } catch { /* window gone */ } }, 320);
        win.show();
        al.entries.push({ cell, kind: "glyphh", win });
        opened.push("Glyphh");
      }
      continue;
    }
    if (app.isBrowser === false || app.execPath) {
      // Native cell: tracked open — launch (or focus this config's own
      // window), adopt the window the launch created, and PLACE it into the
      // cell. Fire-and-forget: same-binary launches serialize internally,
      // and the layout apply shouldn't wait through a cold app start.
      void openNativeTracked(app, rect, true).catch((err) =>
        console.error(`[desktop-layout] native "${app.name}" failed:`, err instanceof Error ? err.message : err));
      al.entries.push({ cell, kind: "tracked", appId: app.id });
      opened.push(app.name);
      continue;
    }
    const url = urlOf(app);
    if (!url) continue;
    const browserPref = typeof app.launchConfig?.browser === "string" ? app.launchConfig.browser : "";
    if (browserPref && browserPref !== "glyphh-panel") {
      // The app declares a REAL browser: open there (window or tab per its
      // config) and tile the hosting browser window into the cell.
      void openWebTracked(app, rect, true).catch((err) =>
        console.error(`[desktop-layout] web "${app.name}" failed:`, err instanceof Error ? err.message : err));
      al.entries.push({ cell, kind: "tracked", appId: app.id });
      opened.push(app.name);
      continue;
    }
    // Default (Glyphh Panel): a Glyphh-chromed webview window on the shared
    // signed-in session, positioned exactly — no adoption needed.
    const win = new BrowserWindow({
      ...rect,
      title: app.name,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: "persist:yo", // the same signed-in web session app panels use
      },
    });
    void win.loadURL(url);
    al.entries.push({ cell, kind: "owned", win });
    opened.push(app.name);
  }

  if (!opened.length) throw new Error(`layout "${layout.name}" has no apps this machine can open`);
  activeLayouts.set(layout.name, al);
  // Attach the shared-edge re-tile AFTER the initial placement (and the
  // Glyphh tween re-assert) settle, so the apply itself never re-tiles.
  setTimeout(() => attachRetile(al), 700);
  return opened;
}
