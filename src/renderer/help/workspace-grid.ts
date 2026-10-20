/**
 * workspace-grid.ts — THE GRID LAYOUT EDITOR's rules, pure (his order,
 * 2026-10-20: "in the modal I want the grid layout editor so a user can
 * adjust the layout on new or edit it").
 *
 * A faithful port of the old Settings → Workspaces grid builder (deleted in
 * 6e6d4b20, help/layouts.ts initBuilderCells / resizeBuilderGrid / cellAt /
 * canMergeRight / canMergeDown / doMergeRight / doMergeDown / doSplit /
 * setStickyCell / the drag's applyDrop / editLayout's load / saveLayout's
 * payload): the same grid model — every position of a cols × rows grid is
 * covered by exactly one cell, a merged cell stored by its top-left with its
 * spans, an empty cell has panelId "" and is never saved. Two changes from
 * the old builder, both so a cell's setup follows it: a split keeps the
 * cell's sticky pin and setup on its top-left piece (the old one dropped
 * them), and picking another panel for a cell drops a setup that belonged to
 * the old panel (an agent's answers stay when it is still an agent).
 *
 * The modal (help/workspace-create.ts) owns the DOM; everything here is data.
 * Unit-tested in test/main/workspace-grid.test.ts.
 */

/** Grids go up to 25×25 — a swarm layout is a wall of terminals, not a 2×2. */
export const MAX_GRID = 25;

/** One cell of the editor's grid. panelId "" = an empty cell. */
export interface GridCell {
  panelId: string;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  /** The app-switch target: opening an app reuses THIS panel. At most one cell is sticky. */
  sticky?: boolean;
  /** Per-cell setup the workspace applies on open (an agent's answers, a Browser URL, a Terminal command). */
  config?: Record<string, unknown>;
}

/** The editor's grid: every position covered by exactly one cell. */
export interface Grid { cols: number; rows: number; cells: GridCell[] }

/** A cell as layouts-list serves it or layouts-save-grid takes it. */
export interface SavedCell {
  panelId: string; col?: number; row?: number; colSpan?: number; rowSpan?: number;
  sticky?: boolean; config?: Record<string, unknown>;
}

const clampDim = (n: unknown, fallback: number): number => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 1 ? Math.min(v, MAX_GRID) : fallback;
};

/** A fresh grid of empty 1×1 cells (initBuilderCells). */
export function emptyGrid(cols: number, rows: number): Grid {
  const c = clampDim(cols, 2), r = clampDim(rows, 1);
  const cells: GridCell[] = [];
  for (let y = 0; y < r; y++) for (let x = 0; x < c; x++) cells.push({ panelId: "", col: x, row: y, colSpan: 1, rowSpan: 1 });
  return { cols: c, rows: r, cells };
}

/** The index of the cell covering (col, row), or -1. */
export function cellAt(g: Grid, col: number, row: number): number {
  return g.cells.findIndex((c) => col >= c.col && col < c.col + c.colSpan && row >= c.row && row < c.row + c.rowSpan);
}

/**
 * A saved workspace's cells → the editor's grid (editLayout): a grid of 1×1s,
 * each saved cell laid on its top-left with its spans, sticky pin and setup,
 * and the 1×1s a merged cell now covers dropped. Spans are clamped to the
 * grid's edges; a cell outside the grid, or one landing on a position an
 * earlier cell already covers, is skipped.
 */
export function gridFromCells(cols: number, rows: number, splits: ReadonlyArray<SavedCell>): Grid {
  const g = emptyGrid(cols, rows);
  const placed: GridCell[] = [];
  const covers = (o: GridCell, x: number, y: number): boolean => x >= o.col && x < o.col + o.colSpan && y >= o.row && y < o.row + o.rowSpan;
  for (const s of splits) {
    const col = Math.floor(Number(s.col ?? 0)), row = Math.floor(Number(s.row ?? 0));
    if (!(col >= 0 && col < g.cols && row >= 0 && row < g.rows)) continue;
    if (!String(s.panelId ?? "").trim()) continue;
    const cell: GridCell = {
      panelId: String(s.panelId),
      col, row,
      colSpan: Math.max(1, Math.min(Math.floor(Number(s.colSpan ?? 1)) || 1, g.cols - col)),
      rowSpan: Math.max(1, Math.min(Math.floor(Number(s.rowSpan ?? 1)) || 1, g.rows - row)),
    };
    // A cell overlapping one already placed would stack under it: skip it.
    const overlaps = placed.some((o) => {
      for (let y = cell.row; y < cell.row + cell.rowSpan; y++) for (let x = cell.col; x < cell.col + cell.colSpan; x++) if (covers(o, x, y)) return true;
      return false;
    });
    if (overlaps) continue;
    if (s.sticky) cell.sticky = true;
    if (s.config && typeof s.config === "object" && Object.keys(s.config).length) cell.config = { ...s.config };
    placed.push(cell);
  }
  // At most one sticky cell — the first wins.
  let seen = false;
  for (const c of placed) { if (c.sticky) { if (seen) delete c.sticky; seen = true; } }
  const rest = g.cells.filter((e) => !placed.some((o) => covers(o, e.col, e.row)));
  g.cells = [...placed, ...rest].sort((a, b) => (a.row - b.row) || (a.col - b.col));
  return g;
}

/**
 * Resize the grid IN PLACE (resizeBuilderGrid) — assignments survive: cells
 * whose anchor still fits stay, spans clamped to the new edges; only cells a
 * shrink pushes out entirely drop. Newly exposed positions arrive as fresh
 * empty 1×1 cells.
 */
export function resizeGrid(g: Grid, cols: number, rows: number): void {
  g.cols = clampDim(cols, g.cols);
  g.rows = clampDim(rows, g.rows);
  const kept: GridCell[] = [];
  for (const c of g.cells) {
    if (c.col >= g.cols || c.row >= g.rows) continue;
    c.colSpan = Math.min(c.colSpan, g.cols - c.col);
    c.rowSpan = Math.min(c.rowSpan, g.rows - c.row);
    kept.push(c);
  }
  g.cells = kept;
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      if (cellAt(g, x, y) === -1) g.cells.push({ panelId: "", col: x, row: y, colSpan: 1, rowSpan: 1 });
    }
  }
}

/** The cell to the right is ONE cell with this cell's row range. */
export function canMergeRight(g: Grid, idx: number): boolean {
  const cell = g.cells[idx];
  if (!cell || cell.col + cell.colSpan >= g.cols) return false;
  const rightIdx = cellAt(g, cell.col + cell.colSpan, cell.row);
  if (rightIdx < 0) return false;
  const right = g.cells[rightIdx]!;
  return right.col === cell.col + cell.colSpan && right.row === cell.row && right.rowSpan === cell.rowSpan;
}

/** The cell below is ONE cell with this cell's column range. */
export function canMergeDown(g: Grid, idx: number): boolean {
  const cell = g.cells[idx];
  if (!cell || cell.row + cell.rowSpan >= g.rows) return false;
  const belowIdx = cellAt(g, cell.col, cell.row + cell.rowSpan);
  if (belowIdx < 0) return false;
  const below = g.cells[belowIdx]!;
  return below.row === cell.row + cell.rowSpan && below.col === cell.col && below.colSpan === cell.colSpan;
}

/** The cell can be split back into 1×1s. */
export const canSplit = (g: Grid, idx: number): boolean => {
  const c = g.cells[idx];
  return !!c && (c.colSpan > 1 || c.rowSpan > 1);
};

/** Merge the cell with its right neighbour; the neighbour (and its panel and
 *  setup) goes. Returns the merged cell's new index (the new selection). */
export function mergeRight(g: Grid, idx: number): number {
  if (!canMergeRight(g, idx)) return idx;
  const cell = g.cells[idx]!;
  const rightIdx = cellAt(g, cell.col + cell.colSpan, cell.row);
  cell.colSpan += g.cells[rightIdx]!.colSpan;
  g.cells.splice(rightIdx, 1);
  return g.cells.indexOf(cell);
}

/** Merge the cell with the one below; the lower one goes. Returns the new index. */
export function mergeDown(g: Grid, idx: number): number {
  if (!canMergeDown(g, idx)) return idx;
  const cell = g.cells[idx]!;
  const belowIdx = cellAt(g, cell.col, cell.row + cell.rowSpan);
  cell.rowSpan += g.cells[belowIdx]!.rowSpan;
  g.cells.splice(belowIdx, 1);
  return g.cells.indexOf(cell);
}

/** Split a merged cell into 1×1s; its panel, pin and setup stay on the top-left piece. */
export function splitCell(g: Grid, idx: number): void {
  const cell = g.cells[idx];
  if (!cell || (cell.colSpan === 1 && cell.rowSpan === 1)) return;
  const pieces: GridCell[] = [];
  for (let y = cell.row; y < cell.row + cell.rowSpan; y++) {
    for (let x = cell.col; x < cell.col + cell.colSpan; x++) {
      if (y === cell.row && x === cell.col) {
        pieces.push({
          panelId: cell.panelId, col: x, row: y, colSpan: 1, rowSpan: 1,
          ...(cell.sticky ? { sticky: true } : {}),
          ...(cell.config ? { config: cell.config } : {}),
        });
      } else pieces.push({ panelId: "", col: x, row: y, colSpan: 1, rowSpan: 1 });
    }
  }
  g.cells.splice(idx, 1, ...pieces);
}

/** Mark exactly one cell sticky, or clear it (setStickyCell). An empty cell can't be sticky. */
export function setSticky(g: Grid, idx: number, on: boolean): void {
  const target = g.cells[idx];
  const allow = on && !!target?.panelId;
  g.cells.forEach((c, i) => {
    if (allow && i === idx) c.sticky = true;
    else delete c.sticky;
  });
}

/** A workspace cell that seats an agent: the Glyphh agent (tool:coding) or a loop's own cell (agent:<cli>). */
const isAgentId = (panelId: string): boolean => {
  const p = panelId.trim().toLowerCase();
  return p === "tool:coding" || p.startsWith("agent:");
};

/**
 * Put a panel in a cell (the cell picker). "" empties it (its pin goes too).
 * A setup belongs to its panel: another panel drops it — except an agent
 * swapped for an agent, whose answers stay.
 */
export function assignPanel(g: Grid, idx: number, panelId: string): void {
  const cell = g.cells[idx];
  if (!cell) return;
  const next = String(panelId ?? "").trim();
  if (next === cell.panelId) return;
  const keepSetup = !!next && isAgentId(next) && isAgentId(cell.panelId);
  cell.panelId = next;
  if (!keepSetup) delete cell.config;
  if (!next) delete cell.sticky;
}

/** Write (or clear) one key of a cell's setup; an emptied setup drops off the cell. */
export function setCellConfig(g: Grid, idx: number, key: string, value: unknown): void {
  const cell = g.cells[idx];
  if (!cell) return;
  const cfg: Record<string, unknown> = { ...(cell.config ?? {}) };
  if (value === undefined || value === null || value === "") delete cfg[key];
  else cfg[key] = value;
  if (Object.keys(cfg).length) cell.config = cfg;
  else delete cell.config;
}

/** Cell indices in reading order — top row left to right, then down. */
export function readingOrder(g: Grid): number[] {
  return g.cells.map((_, i) => i).sort((a, b) => (g.cells[a]!.row - g.cells[b]!.row) || (g.cells[a]!.col - g.cells[b]!.col));
}

export type DropMode = "before" | "after" | "swap";

/** Where in a cell the pointer is, as fractions of its box: the leading edge
 *  (left/top ~28%) inserts before, the trailing edge after, the middle swaps. */
export function dropModeAt(fx: number, fy: number): DropMode {
  if (fx < 0.28 || fy < 0.28) return "before";
  if (fx > 0.72 || fy > 0.72) return "after";
  return "swap";
}

/**
 * A drag's drop (the old builder's applyDrop). Contents move, geometry stays:
 * mid-cell SWAPS two cells' contents; an edge INSERTS the dragged contents
 * before/after the target in reading order, flowing everything between
 * along. A FULL-HEIGHT single-column cell dropped on an edge moves AS A
 * COLUMN — its span travels with it — unless a merged cell straddles either
 * boundary, which falls through to the contents flow.
 */
export function applyDrop(g: Grid, fromIdx: number, toIdx: number, mode: DropMode): void {
  if (fromIdx === toIdx || !g.cells[fromIdx] || !g.cells[toIdx]) return;
  if (mode !== "swap") {
    const c = g.cells[fromIdx]!;
    const t = g.cells[toIdx]!;
    if (c.colSpan === 1 && c.rowSpan >= g.rows) {
      const from = c.col;
      let to = mode === "before" ? t.col : t.col + t.colSpan;
      if (to > from) to--;   // the removal shifts everything past the source left
      // A merged cell straddling the insertion boundary — read in the
      // columns as they stand once the source column is out (the old
      // builder read it before the shift and let a straddler overlap).
      const crossesBoundary = g.cells.some((o) => {
        if (o === c) return false;
        const oc = o.col > from ? o.col - 1 : o.col;
        return oc < to && oc + o.colSpan > to;
      });
      if (!crossesBoundary && to !== from) {
        for (const o of g.cells) if (o !== c && o.col > from) o.col--;
        for (const o of g.cells) if (o !== c && o.col >= to) o.col++;
        c.col = to;
        return;
      }
      if (to === from) return;
    }
  }
  type Contents = { panelId: string; sticky?: boolean; config?: Record<string, unknown> };
  const order = readingOrder(g);
  const contents: Contents[] = order.map((ci) => ({ panelId: g.cells[ci]!.panelId, sticky: g.cells[ci]!.sticky, config: g.cells[ci]!.config }));
  const src = order.indexOf(fromIdx);
  let dst = order.indexOf(toIdx);
  if (mode === "swap") {
    [contents[src], contents[dst]] = [contents[dst]!, contents[src]!];
  } else {
    const [moved] = contents.splice(src, 1);
    if (src < dst) dst--;
    contents.splice(mode === "before" ? dst : dst + 1, 0, moved!);
  }
  order.forEach((ci, p) => {
    const cell = g.cells[ci]!;
    const k = contents[p]!;
    cell.panelId = k.panelId;
    if (k.sticky) cell.sticky = true; else delete cell.sticky;
    if (k.config) cell.config = k.config; else delete cell.config;
  });
}

/** The cells a save writes: the assigned ones, in reading order, in layouts-save-grid's shape. */
export function gridCells(g: Grid): Array<Required<Pick<GridCell, "panelId" | "col" | "row" | "colSpan" | "rowSpan">> & Pick<GridCell, "sticky" | "config">> {
  return readingOrder(g)
    .map((i) => g.cells[i]!)
    .filter((c) => c.panelId)
    .map((c) => ({
      panelId: c.panelId, col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan,
      ...(c.sticky ? { sticky: true } : {}),
      ...(c.config && Object.keys(c.config).length ? { config: { ...c.config } } : {}),
    }));
}

/** n equal fractions. */
export const evenFractions = (n: number): number[] => Array.from({ length: Math.max(1, n) }, () => 1 / Math.max(1, n));

/** The column widths (or row heights) a save writes: the workspace's own when
 *  the count is unchanged — a user's seams survive an edit that keeps the
 *  shape — else even. */
export function fractionsFor(prev: ReadonlyArray<number> | null | undefined, n: number): number[] {
  return prev && prev.length === n && prev.every((v) => Number.isFinite(v) && v > 0) ? prev.slice() : evenFractions(n);
}

/** The shape of a grid's saved cells — dimensions plus every assigned cell's
 *  panel and slot, in reading order. Two grids with one shape open alike. */
export function gridShapeSig(cols: number, rows: number, cells: ReadonlyArray<SavedCell>): string {
  return `${cols}x${rows}:` + cells
    .filter((c) => String(c.panelId ?? "").trim())
    .map((c) => ({ id: String(c.panelId).trim().toLowerCase(), col: c.col ?? 0, row: c.row ?? 0, cs: c.colSpan ?? 1, rs: c.rowSpan ?? 1 }))
    .sort((a, b) => (a.row - b.row) || (a.col - b.col))
    .map((c) => `${c.id}@${c.col},${c.row},${c.cs},${c.rs}`)
    .join("|");
}

/**
 * The grid, checked for a save (saveLayout's checks plus the workspace's one
 * law): null when it can be saved. `blocked` names a panel a workspace can't
 * hold (a native app opens in its own OS window); `label` names a panel.
 */
export function gridError(g: Grid, blocked: (panelId: string) => boolean = () => false, label: (panelId: string) => string = (p) => p): string | null {
  const assigned = g.cells.filter((c) => c.panelId);
  if (!assigned.length) return "Assign at least one panel to the grid.";
  // THE AGENT IS ALWAYS IN IT (his order: "the layout can not ever not have the agent").
  if (!assigned.some((c) => isAgentId(c.panelId))) return "A workspace always has an agent: put Glyphh or a CLI agent in a cell.";
  const offenders = [...new Set(assigned.filter((c) => blocked(c.panelId)).map((c) => label(c.panelId)))];
  if (offenders.length) {
    return `A workspace can't contain native apps: ${offenders.join(", ")}. A workspace arranges panels inside Glyphh; a native app opens in its own OS window.`;
  }
  return null;
}

// ── What a cell can hold (the cell picker, showCellPicker) ──────────────────

/** The built-in work panels a cell can hold, in the old picker's order.
 *  id = `tool:<ViewKind>`, stored verbatim as the cell's panelId. Echo and
 *  Rail are not offered any more: the Echo surface IS the layout manager and
 *  the rail is the fixed sidebar — a workspace open skips both cells. The
 *  house panels (Slides … Sounds) show only when the member holds the app
 *  that IS that panel. Nothing of a removed feature (Bots, Platform,
 *  Discover, the account pages) is a work panel, so none is listed. */
export const CELL_TOOLS: ReadonlyArray<{ id: string; label: string }> = Object.freeze([
  { id: "tool:preview", label: "Browser" },
  { id: "tool:coding", label: "Glyphh" },
  { id: "tool:diff", label: "Diff" },
  { id: "tool:monaco", label: "Editor" },
  { id: "tool:files", label: "Files" },
  { id: "tool:plan", label: "Plan" },
  { id: "tool:terminal", label: "Terminal" },
  { id: "tool:gpoint", label: "Slides" },
  { id: "tool:gdrive", label: "Drive" },
  { id: "tool:gdesign", label: "Design" },
  { id: "tool:gimage", label: "Image" },
  { id: "tool:gvideo", label: "Video" },
  { id: "tool:gsound", label: "Sounds" },
]);

/** An app row as panel-apps-list serves it (the fields the picker reads). */
export interface PickerAppRow {
  id: string; name: string; slug?: string | null; url?: string | null; isBrowser?: boolean;
  execPath?: string | null; appArchetype?: string | null; launchConfig?: Record<string, unknown> | null;
}

/** Slugs (and nav / tool keys) of features the desktop no longer has — never offered in a cell. */
export const REMOVED_PANELS: ReadonlyArray<string> = Object.freeze(["bots", "platform", "discover", "account", "marketplace", "billing"]);

const removed = (v: unknown): boolean => typeof v === "string" && REMOVED_PANELS.includes(v.trim().toLowerCase());

/** The house views this member holds: an installed house app (by slug), or a tab whose launch names the view. */
export function heldHouseViews(rows: ReadonlyArray<PickerAppRow>, houseViewOfApp: Readonly<Record<string, string>>): Set<string> {
  const held = new Set<string>();
  const views = Object.values(houseViewOfApp);
  for (const a of rows) {
    const view = houseViewOfApp[(a.slug || "").toLowerCase()];
    if (view) held.add(view);
    const tool = a.launchConfig && typeof a.launchConfig.tool === "string" ? a.launchConfig.tool : "";
    if (views.includes(tool)) held.add(tool);
  }
  return held;
}

/** The work panels the picker offers: the base tools always, a house panel only when held. */
export function cellPickerTools(held: ReadonlySet<string>, houseViews: ReadonlyArray<string>): Array<{ id: string; label: string }> {
  return CELL_TOOLS.filter((t) => { const v = t.id.slice(5); return !houseViews.includes(v) || held.has(v); }).map((t) => ({ ...t }));
}

/** The apps the picker offers — the Apps page's list: web apps with a URL,
 *  native apps, Glyphh apps; never the Glyphh row itself (the agent is the
 *  Glyphh tool), a navigation row, or a removed feature. Sorted by name. */
export function cellPickerApps(rows: ReadonlyArray<PickerAppRow>): Array<{ id: string; label: string }> {
  return rows
    .filter((a) => (a.url || a.isBrowser === false || a.appArchetype === "glyphh-app")
      && a.appArchetype !== "glyphh-self" && a.appArchetype !== "glyphh-nav" && a.slug !== "glyphh"
      && !removed(a.slug) && !removed(a.launchConfig?.nav) && !removed(a.launchConfig?.tool))
    .map((a) => ({ id: a.id, label: a.name || a.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The app row a cell names — by id, by slug, or by id with a "-2" style suffix. */
export function resolveAppRow(rows: ReadonlyArray<PickerAppRow>, panelId: string): PickerAppRow | undefined {
  const k = panelId.trim().toLowerCase();
  const base = k.replace(/-\d+$/, "");
  return rows.find((a) => a.id.toLowerCase() === k || (a.slug || "").toLowerCase() === k)
    ?? rows.find((a) => a.id.toLowerCase() === base);
}

/** A workspace is a grid of PANELS inside the Glyphh window; a native app
 *  opens in its own OS window, so it is the one thing a cell cannot hold
 *  (cellBlocked). Tools, agents, Glyphh apps and unknown ids pass. */
export function cellBlocked(panelId: string, app: PickerAppRow | undefined): boolean {
  if (panelId.startsWith("tool:") || panelId.startsWith("agent:") || panelId === "agents-tabbed") return false;
  if (!app || app.appArchetype === "glyphh-self" || app.appArchetype === "glyphh-app") return false;
  return app.isBrowser === false || !!app.execPath;
}

/** A cell's name in the grid: a tool's label, an agent's loop name, an app's name, else the raw id. */
export function cellLabel(panelId: string, apps: ReadonlyArray<PickerAppRow>, loopName: (id: string) => string): string {
  if (!panelId) return "—";
  if (panelId.startsWith("tool:")) return CELL_TOOLS.find((t) => t.id === panelId)?.label ?? panelId.slice(5);
  if (panelId.startsWith("agent:")) return loopName(panelId.slice(6));
  if (panelId === "agents-tabbed") return "Loops (tabbed)";
  return resolveAppRow(apps, panelId)?.name || panelId;
}

/** The agent cells, in reading order — the modal asks each one's answers. */
export function agentCellIndices(g: Grid): number[] {
  return readingOrder(g).filter((i) => isAgentId(g.cells[i]!.panelId));
}
