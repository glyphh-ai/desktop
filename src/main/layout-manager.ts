/**
 * LayoutManager — grid-based panel layout engine.
 *
 * Supports N×M grids with column/row spans.
 * Layouts stored as JSON in ~/.glyphh/.layouts
 */

import fs from "fs";
import path from "path";
import { BrowserWindow } from "electron";
import type { GlyphhPlacement } from "./screen-layout.js";
import { userScopedPath } from "./app-paths.js";
import { PanelManager } from "./panel-manager";
import { getClient } from "./glyphh-client";
import { appCache } from "./glyphh-client";

// The layout payload inside a `layout`-kind library item (client.layouts).
// The spec stores cols/rows/cells/folderMode but NOT colWidths/rowHeights —
// fractional sizing is reconstructed as equal fractions on load (uniform
// grid), matching the platform Layouts page.
export interface ServerLayout {
  id: string;
  name: string;
  cols: number;
  rows: number;
  cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean; config?: { url?: string; cmd?: string } }>;
  folderMode: "single" | "multi";
  target: "glyphh" | "desktop";
  glyphh?: GlyphhPlacement;
  /** The loop this layout activates on open — its program AND its models. Absent
   *  → the layout has no opinion; the active loop stays as-is. */
  loop?: string;
  /** For that loop: role → catalog model id. Binds each of the loop's slots to a
   *  model when the layout opens. Empty/absent → the loop's own defaults stand. */
  modelSelections?: Record<string, string>;
  /** What the agent's session does when this layout opens: keep the current
   *  one (default), start fresh, or resume the layout's own last session. */
  sessionMode?: "keep" | "new" | "last";
  /** Opening this layout switches the agent to this folder. Absent → the
   *  current working folder stays. */
  folder?: string;
}

const LAYOUTS_CACHE_KEY = "/api/layouts";

/** The server's saved layouts (library kind `layout`), flattened to the spec
 *  shape and cached — shared by the palette, app resolver, and agent tools. */
export function fetchServerLayouts(): Promise<ServerLayout[]> {
  return appCache.cached(LAYOUTS_CACHE_KEY, async () => {
    const items = await getClient().layouts.list();
    const layouts: ServerLayout[] = [];
    for (const item of items) {
      const data = (item.data ?? {}) as Partial<Omit<ServerLayout, "id" | "name">>;
      if (!Array.isArray(data.cells)) continue;
      layouts.push({
        id: item.id,
        name: item.name,
        cols: typeof data.cols === "number" ? data.cols : 1,
        rows: typeof data.rows === "number" ? data.rows : 1,
        cells: data.cells,
        folderMode: data.folderMode === "multi" ? "multi" : "single",
        target: data.target === "desktop" ? "desktop" : "glyphh",
        ...(data.glyphh && typeof data.glyphh === "object" ? { glyphh: data.glyphh as GlyphhPlacement } : {}),
        ...(typeof data.loop === "string" && data.loop ? { loop: data.loop } : {}),
        ...(data.sessionMode === "new" || data.sessionMode === "last" ? { sessionMode: data.sessionMode } : {}),
        ...(typeof data.folder === "string" && data.folder ? { folder: data.folder } : {}),
        ...(data.modelSelections && typeof data.modelSelections === "object"
          ? { modelSelections: data.modelSelections as Record<string, string> }
          : {}),
      });
    }
    return layouts;
  });
}

// ── Grid model ──────────────────────────────────────────────

export interface GridCell {
  panelId: string;
  col: number;      // 0-based column
  row: number;      // 0-based row
  colSpan: number;
  rowSpan: number;
  /** At most one cell per layout: the app-switch target ("sticky" panel). */
  sticky?: boolean;
  /** Per-cell app setup the layout applies on open: the Browser cell's URL,
   *  the Terminal cell's first command (runs after the folder is set). */
  config?: { url?: string; cmd?: string };
}

/** Folder-binding mode for layouts that contain any folder-bound app
 *  (requiresFolder: true). "single" hoists ONE picker to the layout chrome
 *  — all folder-bound panels share that folder. "multi" lets each
 *  folder-bound panel pick its own. Layouts with no folder-bound panels
 *  ignore this field. Default = "single". */
export type LayoutFolderMode = "single" | "multi";

export interface GridLayout {
  name: string;
  version: 2;
  cols: number;           // 1–4
  rows: number;           // 1–4
  colWidths: number[];    // fractions summing to ~1
  rowHeights: number[];   // fractions summing to ~1
  cells: GridCell[];
  /** "single" (default) or "multi". Only meaningful when at least one
   *  cell's app declares requiresFolder. Saved layouts do NOT bake in
   *  a folder — folder is provided at load time. */
  folderMode?: LayoutFolderMode;
  /** Where the layout opens: "glyphh" (default — panels tile inside the
   *  Glyphh window) or "desktop" (cells open ON the desktop: native apps
   *  launch, web apps open as positioned webview windows). */
  target?: "glyphh" | "desktop";
  /** Desktop layouts: where Glyphh itself sits (rail/left/right/none). */
  glyphh?: GlyphhPlacement;
  /** The loop this layout activates on open — its program AND its models. */
  loop?: string;
  /** For that loop: role → catalog model id. */
  modelSelections?: Record<string, string>;
  /** Session behavior on open: keep (default) | new | last. */
  sessionMode?: "keep" | "new" | "last";
  /** Folder the agent switches to on open. */
  folder?: string;
}

/** Per-cell bounds for renderer overlays (URL bars in grid) */
export interface CellBounds {
  panelId: string;
  x: number;
  y: number;
  width: number;
}

/** Full grid state sent to renderer for handles + chips */
export interface GridSplitInfo {
  panelIds: string[];
  name: string;
  cols: number;
  rows: number;
  colWidths: number[];
  rowHeights: number[];
  cells: GridCell[];
  cellBounds?: CellBounds[];
}

// ── Legacy types (migration only) ───────────────────────────

interface LegacySplit {
  panelId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LegacyLayout {
  name: string;
  splits: LegacySplit[];
}

// ── Constants ───────────────────────────────────────────────

// Per-user offline cache of the server layout library — resolved at CALL
// time (not import) so it follows the signed-in account (app-paths scoping).
const layoutsFile = () => userScopedPath(".layouts");
const TITLEBAR_HEIGHT = 38;
const SPLIT_GAP = 8;
const CELL_URL_HEIGHT = 22;

// ── LayoutManager ───────────────────────────────────────────

export class LayoutManager {
  private layouts: Map<string, GridLayout> = new Map();
  private serverIds: Map<string, string> = new Map();   // layout name → server UUID
  private activeGrid: GridLayout | null = null;
  private suspendedGrid: GridLayout | null = null;
  private boundWindow: BrowserWindow | null = null;
  private lastCellBounds: CellBounds[] = [];

  constructor(private panelManager: PanelManager) {
    this.load();                              // local cache first (instant, offline-safe)
    void this.refreshAndList().catch(() => {}); // then reconcile with the server
  }

  /** Grid always starts below titlebar (global URL bar is hidden in grid mode) */
  private get gridTop(): number {
    return TITLEBAR_HEIGHT;
  }

  /** Public: does the active split/grid contain a browser cell? Used to decide
   *  URL-bar visibility for the whole grid (independent of which cell is focused). */
  gridHasBrowser(): boolean {
    return this.gridContainsBrowser();
  }

  /** True if the active grid has any browser-type panel in its cells. */
  private gridContainsBrowser(): boolean {
    if (!this.activeGrid) return false;
    return this.activeGrid.cells.some((c) => {
      const id = c.panelId;
      return id === "browser" || id.startsWith("browse-") || id.startsWith("browser-");
    });
  }

  /** Whether per-cell URL bars should be shown in grid mode.
   *  Only when the grid has at least one browser panel — internal yo://
   *  apps (Agent / Plan / Workbench / …) don't have URLs to show, so
   *  drawing empty URL bars above them is just chrome noise. */
  private get cellUrlBars(): boolean {
    return this.gridContainsBrowser() && this.panelManager.topInset > 0;
  }

  // ── Split commands ──────────────────────────────────────

  /** Two panels side by side */
  splitTwo(leftId: string, rightId: string, win: BrowserWindow, ratio = 0.5): boolean {
    if (!this.panelManager.getOrCreateView(leftId, win)) return false;
    if (!this.panelManager.getOrCreateView(rightId, win)) return false;

    this.suspendedGrid = null;
    this.activeGrid = {
      name: "",
      version: 2,
      cols: 2,
      rows: 1,
      colWidths: [ratio, 1 - ratio],
      rowHeights: [1],
      cells: [
        { panelId: leftId, col: 0, row: 0, colSpan: 1, rowSpan: 1 },
        { panelId: rightId, col: 1, row: 0, colSpan: 1, rowSpan: 1 },
      ],
    };
    this.applyGrid(win, true);
    this.bindResize(win);
    return true;
  }

  /** N panels in a single row */
  splitN(panelIds: string[], win: BrowserWindow): boolean {
    for (const id of panelIds) {
      if (!this.panelManager.getOrCreateView(id, win)) return false;
    }
    const n = panelIds.length;
    this.suspendedGrid = null;
    this.activeGrid = {
      name: "",
      version: 2,
      cols: n,
      rows: 1,
      colWidths: Array(n).fill(1 / n),
      rowHeights: [1],
      cells: panelIds.map((id, i) => ({
        panelId: id, col: i, row: 0, colSpan: 1, rowSpan: 1,
      })),
    };
    this.applyGrid(win, true);
    this.bindResize(win);
    return true;
  }

  /** Multi-row grid from row arrays, e.g. [["claude","gpt"],["gemini","code"]] */
  splitGrid(rows: string[][], win: BrowserWindow): boolean {
    const numRows = rows.length;
    const numCols = Math.max(...rows.map((r) => r.length));

    const cells: GridCell[] = [];
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        if (!this.panelManager.getOrCreateView(rows[r][c], win)) return false;
        // Last panel in a row spans remaining columns
        const colSpan = c === rows[r].length - 1 ? numCols - c : 1;
        cells.push({
          panelId: rows[r][c], col: c, row: r, colSpan, rowSpan: 1,
        });
      }
    }

    this.suspendedGrid = null;
    this.activeGrid = {
      name: "",
      version: 2,
      cols: numCols,
      rows: numRows,
      colWidths: Array(numCols).fill(1 / numCols),
      rowHeights: Array(numRows).fill(1 / numRows),
      cells,
    };
    this.applyGrid(win, true);
    this.bindResize(win);
    return true;
  }

  /** Apply a full GridLayout directly (from visual builder or IPC) */
  applyGridLayout(grid: GridLayout, win: BrowserWindow): boolean {
    for (const cell of grid.cells) {
      if (!this.panelManager.getOrCreateView(cell.panelId, win)) return false;
    }
    this.suspendedGrid = null;
    this.activeGrid = JSON.parse(JSON.stringify(grid));
    this.applyGrid(win, true);
    this.bindResize(win);
    return true;
  }

  // ── Resize ────────────────────────────────────────────────

  /** Update column border position (fraction = cumulative x position of border) */
  updateColWidth(index: number, fraction: number, win: BrowserWindow): void {
    const grid = this.activeGrid;
    if (!grid || index < 0 || index >= grid.cols - 1) return;

    let leftEdge = 0;
    for (let i = 0; i < index; i++) leftEdge += grid.colWidths[i];
    const rightEdge = leftEdge + grid.colWidths[index] + grid.colWidths[index + 1];

    const minW = 0.1;
    const clamped = Math.max(leftEdge + minW, Math.min(rightEdge - minW, fraction));
    grid.colWidths[index] = clamped - leftEdge;
    grid.colWidths[index + 1] = rightEdge - clamped;

    this.applyGrid(win);
    this.persistActiveIfNamed();
  }

  /** Update row border position (fraction = cumulative y position of border) */
  updateRowHeight(index: number, fraction: number, win: BrowserWindow): void {
    const grid = this.activeGrid;
    if (!grid || index < 0 || index >= grid.rows - 1) return;

    let topEdge = 0;
    for (let i = 0; i < index; i++) topEdge += grid.rowHeights[i];
    const bottomEdge = topEdge + grid.rowHeights[index] + grid.rowHeights[index + 1];

    const minH = 0.1;
    const clamped = Math.max(topEdge + minH, Math.min(bottomEdge - minH, fraction));
    grid.rowHeights[index] = clamped - topEdge;
    grid.rowHeights[index + 1] = bottomEdge - clamped;

    this.applyGrid(win);
    this.persistActiveIfNamed();
  }

  /** If the active grid is a named layout, persist updated widths/heights back */
  private persistActiveIfNamed(): void {
    const grid = this.activeGrid;
    if (!grid || !grid.name) return;
    const saved = this.layouts.get(grid.name);
    if (!saved) return;
    saved.colWidths = [...grid.colWidths];
    saved.rowHeights = [...grid.rowHeights];
    this.persist();
  }

  /** Backward-compat: update ratio for a 2-column split */
  updateSplitRatio(ratio: number, win: BrowserWindow): void {
    this.updateColWidth(0, ratio, win);
  }

  // ── Layout CRUD ───────────────────────────────────────────

  /** Apply a named layout */
  apply(name: string, win: BrowserWindow): boolean {
    const layout = this.layouts.get(name);
    if (!layout) return false;
    this.suspendedGrid = null;
    this.activeGrid = JSON.parse(JSON.stringify(layout));
    this.applyGrid(win, true);
    this.bindResize(win);
    return true;
  }

  /** Save a grid layout */
  /** Save locally at once; the returned promise resolves when the SERVER has
   *  the row too. Callers that reload-from-server right after a save (the
   *  Layouts page does) must await it, or refreshAndList's server-is-truth
   *  replace reverts them to the pre-save state — the stale-cards bug. */
  saveLayout(grid: GridLayout): Promise<void> {
    this.layouts.set(grid.name, grid);
    this.persist();
    return this.persistToServer(grid).catch(() => { /* offline — local copy stands */ });
  }

  /** Delete a layout. Same server-side await contract as saveLayout. */
  async deleteLayout(name: string): Promise<boolean> {
    if (!this.layouts.has(name)) return false;
    this.layouts.delete(name);
    this.persist();
    const id = this.serverIds.get(name);
    this.serverIds.delete(name);
    appCache.invalidate(LAYOUTS_CACHE_KEY);
    if (id) await getClient().layouts.delete(id).catch(() => { /* offline */ });
    return true;
  }

  /** List all layouts */
  listLayouts(): GridLayout[] {
    return Array.from(this.layouts.values());
  }

  // ── Server sync (library kind `layout` — the same library the
  // platform Layouts page writes to) ─────────────────────────────────

  /** Refresh the local cache from the server, then return the list. Used by
   *  the layouts-list IPC so the Layouts tab shows server truth. Non-fatal
   *  offline / pre-auth — the local cache stands in. */
  async refreshAndList(): Promise<GridLayout[]> {
    try {
      const serverLayouts = await fetchServerLayouts();
      // Server is TRUTH: replace, never merge. Merging kept locally-cached
      // entries (deleted elsewhere, or a previous signed-in account's) alive
      // forever — the local file is only an offline stand-in.
      this.layouts.clear();
      this.serverIds.clear();
      for (const sl of serverLayouts) {
        this.serverIds.set(sl.name, sl.id);
        this.layouts.set(sl.name, this.fromServer(sl));
      }
      this.persist();
    } catch { /* offline / pre-auth — keep local cache */ }
    return this.listLayouts();
  }

  /** Build a client GridLayout from a server layout, reconstructing equal
   *  column/row fractions (the server model doesn't store them). */
  private fromServer(sl: ServerLayout): GridLayout {
    const cols = Math.max(1, sl.cols);
    const rows = Math.max(1, sl.rows);
    return {
      name: sl.name,
      version: 2,
      cols,
      rows,
      colWidths: Array(cols).fill(1 / cols),
      rowHeights: Array(rows).fill(1 / rows),
      cells: sl.cells,
      folderMode: sl.folderMode,
      target: sl.target,
      ...(sl.glyphh ? { glyphh: sl.glyphh } : {}),
      ...(sl.loop ? { loop: sl.loop } : {}),
      ...(sl.modelSelections ? { modelSelections: sl.modelSelections } : {}),
      ...(sl.sessionMode ? { sessionMode: sl.sessionMode } : {}),
      ...(sl.folder ? { folder: sl.folder } : {}),
    };
  }

  /** Push a layout to the server (create or update, keyed by name→id). */
  private async persistToServer(grid: GridLayout): Promise<void> {
    const body = {
      name: grid.name,
      cols: grid.cols,
      rows: grid.rows,
      cells: grid.cells.map((c) => ({ panelId: c.panelId, col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan, sticky: c.sticky, ...(c.config ? { config: c.config } : {}) })),
      folderMode: grid.folderMode ?? "single",
      target: grid.target ?? "glyphh",
      ...(grid.glyphh ? { glyphh: grid.glyphh } : {}),
      ...(grid.loop ? { loop: grid.loop } : {}),
      ...(grid.modelSelections && Object.keys(grid.modelSelections).length ? { modelSelections: grid.modelSelections } : {}),
      ...(grid.sessionMode && grid.sessionMode !== "keep" ? { sessionMode: grid.sessionMode } : {}),
      ...(grid.folder ? { folder: grid.folder } : {}),
    };
    const id = this.serverIds.get(grid.name);
    const saved = await getClient().layouts.save({ name: grid.name, data: body, ...(id ? { id } : {}) });
    this.serverIds.set(grid.name, saved.id);
    appCache.invalidate(LAYOUTS_CACHE_KEY);
  }

  /** Get a layout by name */
  getLayout(name: string): GridLayout | undefined {
    return this.layouts.get(name);
  }


  /** Rename a panelId across all saved layouts and the active grid. */
  renamePanelId(oldId: string, newId: string): void {
    let changed = false;
    for (const layout of this.layouts.values()) {
      for (const cell of layout.cells) {
        if (cell.panelId === oldId) {
          cell.panelId = newId;
          changed = true;
        }
      }
    }
    if (this.activeGrid) {
      for (const cell of this.activeGrid.cells) {
        if (cell.panelId === oldId) cell.panelId = newId;
      }
    }
    if (changed) this.persist();
  }

  /** Check if a name is a layout command */
  isLayout(name: string): boolean {
    return this.layouts.has(name);
  }

  // ── State queries ─────────────────────────────────────────

  /** Fully close any layout — active AND suspended — so nothing re-applies it. */
  clearSplit(): void {
    this.activeGrid = null;
    this.suspendedGrid = null;
  }

  get hasSplit(): boolean {
    return this.activeGrid !== null;
  }

  restoreSplit(win: BrowserWindow): void {
    if (this.activeGrid) this.applyGrid(win);
  }

  suspendSplit(): void {
    if (this.activeGrid) {
      this.suspendedGrid = this.activeGrid;
      this.activeGrid = null;
    }
  }

  resumeSplit(win: BrowserWindow): boolean {
    if (!this.suspendedGrid) return false;
    this.activeGrid = this.suspendedGrid;
    this.suspendedGrid = null;
    this.applyGrid(win, true);
    this.bindResize(win);
    return true;
  }

  getSuspendedGridInfo(): GridSplitInfo | null {
    if (!this.suspendedGrid) return null;
    return {
      panelIds: this.suspendedGrid.cells.map((c) => c.panelId),
      name: this.suspendedGrid.name || "",
      cols: this.suspendedGrid.cols,
      rows: this.suspendedGrid.rows,
      colWidths: [...this.suspendedGrid.colWidths],
      rowHeights: [...this.suspendedGrid.rowHeights],
      cells: this.suspendedGrid.cells.map((c) => ({ ...c })),
    };
  }

  clearSuspended(): void {
    this.suspendedGrid = null;
  }

  setSuspendedGrid(grid: GridLayout): void {
    this.suspendedGrid = grid;
  }

  /** Swap one cell's panel by cell index */
  swapPanel(index: number, newPanelId: string, win: BrowserWindow): void {
    if (!this.activeGrid || index < 0 || index >= this.activeGrid.cells.length) return;
    this.activeGrid.cells[index].panelId = newPanelId;
    this.applyGrid(win);
  }

  /**
   * Swap the panel currently occupying a cell (identified by its panel ID) with a new
   * panel, animating only that cell — the rest of the layout stays untouched.
   * Returns false when there is no active grid or the source panel isn't in it
   * (caller should fall back to a full switchTo in that case).
   */
  swapCellAnimated(sourcePanelId: string, newPanelId: string, win: BrowserWindow): boolean {
    const grid = this.activeGrid;
    if (!grid) return false;

    const cellIdx = grid.cells.findIndex((c) => c.panelId === sourcePanelId);
    if (cellIdx < 0) return false;
    if (sourcePanelId === newPanelId) return true;

    const cell = grid.cells[cellIdx];
    const [rawW, h] = win.getContentSize();
    const left = this.panelManager.leftInset;
    const w = rawW - this.panelManager.rightInset - left;
    const contentHeight = h - this.gridTop - this.panelManager.bottomInset;

    // Cumulative column / row positions (fractions → pixels)
    const cumCol = [0];
    for (const cw of grid.colWidths) cumCol.push(cumCol[cumCol.length - 1] + cw);
    const cumRow = [0];
    for (const rh of grid.rowHeights) cumRow.push(cumRow[cumRow.length - 1] + rh);

    const halfGap = Math.floor(SPLIT_GAP / 2);
    let x = left + Math.floor(cumCol[cell.col] * w);
    let cellW = Math.floor(cumCol[cell.col + cell.colSpan] * w) - Math.floor(cumCol[cell.col] * w);
    let y = Math.floor(cumRow[cell.row] * contentHeight);
    let cellH = Math.floor(cumRow[cell.row + cell.rowSpan] * contentHeight) - y;

    if (cell.col > 0)                          { x += halfGap; cellW -= halfGap; }
    if (cell.col + cell.colSpan < grid.cols)   { cellW -= halfGap; }
    if (cell.row > 0)                          { y += halfGap; cellH -= halfGap; }
    if (cell.row + cell.rowSpan < grid.rows)   { cellH -= halfGap; }

    const urlOffset = this.cellUrlBars ? CELL_URL_HEIGHT : 0;
    const finalBounds = {
      x,
      y: this.gridTop + y + urlOffset,
      width: Math.max(cellW, 1),
      height: Math.max(cellH - urlOffset, 1),
    };

    const oldView = this.panelManager.getView(sourcePanelId);
    if (!oldView) return false;

    const newView = this.panelManager.getOrCreateView(newPanelId, win);
    if (!newView) return false;

    // Update grid state before animating
    grid.cells[cellIdx].panelId = newPanelId;

    // Slide new view in from the right edge of this cell
    const oldBounds = { ...oldView.getBounds() };
    newView.setBounds({ ...finalBounds, x: finalBounds.x + cellW });
    newView.setAutoResize({ width: false, height: false });
    this.panelManager.attachView(win, newView);

    this.panelManager.slideViews(
      win,
      [{ view: oldView, bounds: oldBounds }],
      [{ view: newView, finalBounds }],
      cellW,
      220,
      () => {
        newView.setAutoResize({ width: false, height: false });
        newView.webContents.focus();
      },
    );
    return true;
  }

  /** Legacy-compatible split info (panelIds + first col ratio for old renderer) */
  getSplitInfo(): { panelIds: string[]; ratio: number } | null {
    if (!this.activeGrid) return null;
    return {
      panelIds: this.activeGrid.cells.map((c) => c.panelId),
      ratio: this.activeGrid.cols >= 2 ? this.activeGrid.colWidths[0] : 0.5,
    };
  }

  /** Full grid info for the renderer (handles, chips, builder) */
  getGridInfo(): GridSplitInfo | null {
    if (!this.activeGrid) return null;
    return {
      panelIds: this.activeGrid.cells.map((c) => c.panelId),
      name: this.activeGrid.name || "",
      cols: this.activeGrid.cols,
      rows: this.activeGrid.rows,
      colWidths: [...this.activeGrid.colWidths],
      rowHeights: [...this.activeGrid.rowHeights],
      cells: this.activeGrid.cells.map((c) => ({ ...c })),
      cellBounds: this.lastCellBounds.length > 0 ? [...this.lastCellBounds] : undefined,
    };
  }

  // ── Grid rendering ────────────────────────────────────────

  private applyGrid(win: BrowserWindow, animate = false) {
    const grid = this.activeGrid;
    if (!grid) return;

    const [rawW, h] = win.getContentSize();
    const left = this.panelManager.leftInset;
    const w = rawW - this.panelManager.rightInset - left;
    const contentHeight = h - this.gridTop - this.panelManager.bottomInset;

    // Capture old views for animation
    const oldViews = animate && !this.panelManager.isAnimating
      ? win.getBrowserViews().map((v) => ({ view: v, bounds: { ...v.getBounds() } }))
      : [];

    // Remove old views (unless animating — slideViews handles cleanup)
    if (!animate || oldViews.length === 0) {
      this.panelManager.detachAllViews(win);
    }

    // Cumulative column positions (fractions)
    const cumCol = [0];
    for (const cw of grid.colWidths) cumCol.push(cumCol[cumCol.length - 1] + cw);

    // Cumulative row positions (fractions)
    const cumRow = [0];
    for (const rh of grid.rowHeights) cumRow.push(cumRow[cumRow.length - 1] + rh);

    const halfGap = Math.floor(SPLIT_GAP / 2);

    // Compute final bounds for each cell
    const newViews: Array<{ view: import("electron").BrowserView; finalBounds: Electron.Rectangle }> = [];
    let firstView: import("electron").BrowserView | null = null;
    const urlOffset = this.cellUrlBars ? CELL_URL_HEIGHT : 0;
    this.lastCellBounds = [];
    const addedViews = new Set<import("electron").BrowserView>();

    for (const cell of grid.cells) {
      const view = this.panelManager.getOrCreateView(cell.panelId, win);
      if (!view || addedViews.has(view)) continue;
      addedViews.add(view);
      if (!firstView) firstView = view;

      // Raw pixel bounds from grid fractions
      let x = left + Math.floor(cumCol[cell.col] * w);
      let cellW = Math.floor(cumCol[cell.col + cell.colSpan] * w) - Math.floor(cumCol[cell.col] * w);
      let y = Math.floor(cumRow[cell.row] * contentHeight);
      let cellH = Math.floor(cumRow[cell.row + cell.rowSpan] * contentHeight) - y;

      // Inset at internal borders for drag handles
      if (cell.col > 0) { x += halfGap; cellW -= halfGap; }
      if (cell.col + cell.colSpan < grid.cols) { cellW -= halfGap; }
      if (cell.row > 0) { y += halfGap; cellH -= halfGap; }
      if (cell.row + cell.rowSpan < grid.rows) { cellH -= halfGap; }

      // Record cell top-left for renderer URL bar overlay (before URL offset)
      this.lastCellBounds.push({
        panelId: cell.panelId,
        x,
        y: this.gridTop + y,
        width: Math.max(cellW, 1),
      });

      const finalBounds = {
        x,
        y: this.gridTop + y + urlOffset,
        width: Math.max(cellW, 1),
        height: Math.max(cellH - urlOffset, 1),
      };

      if (animate && oldViews.length > 0) {
        // Position off-screen; slideViews will animate in
        view.setBounds({ ...finalBounds, x: finalBounds.x + w });
        view.setAutoResize({ width: false, height: false });
        this.panelManager.attachView(win, view);
        newViews.push({ view, finalBounds });
      } else {
        this.panelManager.attachView(win, view);
        view.setBounds(finalBounds);
        view.setAutoResize({ width: false, height: false });
      }
    }

    // Animate if we have old views to slide out
    if (animate && oldViews.length > 0 && newViews.length > 0) {
      this.panelManager.slideViews(win, oldViews, newViews, w, undefined, () => {
        if (firstView) firstView.webContents.focus();
      });
    } else if (firstView) {
      firstView.webContents.focus();
    }
  }

  private bindResize(win: BrowserWindow) {
    if (this.boundWindow === win) return;
    this.boundWindow = win;
    win.on("resize", () => {
      if (this.activeGrid && !this.panelManager.isHidden && !this.panelManager.isAnimating) this.applyGrid(win);
    });
  }

  // ── Persistence ───────────────────────────────────────────

  private load() {
    try {
      const raw = JSON.parse(fs.readFileSync(layoutsFile(), "utf-8")) as unknown[];
      let needsMigration = false;
      for (const item of raw) {
        const obj = item as Record<string, unknown>;
        if (obj.version === 2) {
          const grid = obj as unknown as GridLayout;
          this.layouts.set(grid.name, grid);
        } else {
          const legacy = obj as unknown as LegacyLayout;
          const migrated = this.migrateLayout(legacy);
          this.layouts.set(migrated.name, migrated);
          needsMigration = true;
        }
      }
      if (needsMigration) this.persist();
    } catch {
      // No layouts yet
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(layoutsFile()), { recursive: true });
    fs.writeFileSync(
      layoutsFile(),
      JSON.stringify(Array.from(this.layouts.values()), null, 2),
      "utf-8",
    );
  }

  /** Identity switch: drop the previous account's layouts entirely, reload
   *  the (re-scoped) local cache, then pull server truth. Without this, the
   *  in-main-process map keeps serving the OLD user's layouts forever. */
  resetForUserChange(): void {
    this.layouts.clear();
    this.serverIds.clear();
    this.load();
    void this.refreshAndList().catch(() => {});
  }

  private migrateLayout(legacy: LegacyLayout): GridLayout {
    const n = legacy.splits.length;
    return {
      name: legacy.name,
      version: 2,
      cols: n,
      rows: 1,
      colWidths: legacy.splits.map((s) => s.width),
      rowHeights: [1],
      cells: legacy.splits.map((s, i) => ({
        panelId: s.panelId,
        col: i,
        row: 0,
        colSpan: 1,
        rowSpan: 1,
      })),
    };
  }
}
