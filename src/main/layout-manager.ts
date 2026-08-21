/**
 * Layouts — the server-backed layout library (yo-server /api/layouts) with a
 * per-user offline cache.
 *
 * The BrowserView grid engine that used to live here is gone: a layout no
 * longer tiles main-owned views. Opening a layout goes through app-resolver's
 * openLayoutByName, which turns every cell into a renderer-owned workbench
 * panel. What remains is the CRUD + server sync the Layouts page and the
 * layouts-* IPC ride on.
 */

import fs from "fs";
import path from "path";
import { userScopedPath } from "./app-paths.js";
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
  cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean; config?: { url?: string; cmd?: string; keepAlive?: boolean } }>;
  folderMode: "single" | "multi";
  target: "glyphh" | "desktop";
  /** DESKTOP layouts only: where Glyphh itself sits while the layout owns the
   *  screen (top bar by default; see screen-layout.ts GlyphhPlacement). */
  glyphh?: { mode: "top" | "rail" | "left" | "right" | "none"; fraction?: number };
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
  /** The SPACE this layout belongs to — which agent rides it (chat | cowork |
   *  code). Absent → derived from content (dev tool panels ⇒ code, else
   *  cowork). One layout, one space: dual use means two layouts. */
  space?: "chat" | "cowork" | "code";
}

const LAYOUTS_CACHE_KEY = "/api/layouts";

// The agent anchor used to be baked into each layout as a `glyphh` placement; it is now
// a GLOBAL device setting owned by the agent. Any saved layout still carrying that field
// is migrated ONCE (background, best-effort) so nothing lingers to move the agent.
let strippedLegacyAnchors = false;
async function stripLegacyLayoutAnchors(items: Array<{ id: string; name: string; data?: unknown }>): Promise<void> {
  if (strippedLegacyAnchors) return;
  strippedLegacyAnchors = true;
  const stale = items.filter((it) => it.data && typeof it.data === "object" && "glyphh" in (it.data as object));
  if (stale.length === 0) return;
  for (const it of stale) {
    try {
      const { glyphh: _drop, ...clean } = it.data as Record<string, unknown>;
      await getClient().layouts.save({ id: it.id, name: it.name, data: clean });
    } catch { /* best-effort — a failed strip just retries next boot */ }
  }
  if (stale.length) { strippedLegacyAnchors = true; appCache.invalidate(LAYOUTS_CACHE_KEY); }
}

/** The server's saved layouts (library kind `layout`), flattened to the spec
 *  shape and cached — shared by the palette, app resolver, and agent tools. */
export function fetchServerLayouts(): Promise<ServerLayout[]> {
  return appCache.cached(LAYOUTS_CACHE_KEY, async () => {
    const items = await getClient().layouts.list();
    // Migrate away any legacy per-layout anchor, once, in the background.
    void stripLegacyLayoutAnchors(items);
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
        ...(typeof data.loop === "string" && data.loop ? { loop: data.loop } : {}),
        ...(data.sessionMode === "new" || data.sessionMode === "last" ? { sessionMode: data.sessionMode } : {}),
        ...(typeof data.folder === "string" && data.folder ? { folder: data.folder } : {}),
        ...(data.space === "chat" || data.space === "cowork" || data.space === "code" ? { space: data.space } : {}),
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
  config?: { url?: string; cmd?: string; keepAlive?: boolean };
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
  cols: number;           // 1–25
  rows: number;           // 1–25
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
  /** The loop this layout activates on open — its program AND its models. */
  loop?: string;
  /** For that loop: role → catalog model id. */
  modelSelections?: Record<string, string>;
  /** Session behavior on open: keep (default) | new | last. */
  sessionMode?: "keep" | "new" | "last";
  /** Folder the agent switches to on open. */
  folder?: string;
  /** The space this layout belongs to (chat | cowork | code). Absent →
   *  derived from content at open time. */
  space?: "chat" | "cowork" | "code";
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

// Per-user offline cache of the server layout library — resolved at CALL
// time (not import) so it follows the signed-in account (app-paths scoping).
const layoutsFile = () => userScopedPath(".layouts");

// ── LayoutManager ───────────────────────────────────────────

export class LayoutManager {
  private layouts: Map<string, GridLayout> = new Map();
  private serverIds: Map<string, string> = new Map();   // layout name → server UUID

  constructor() {
    this.load();                              // local cache first (instant, offline-safe)
    void this.refreshAndList().catch(() => {}); // then reconcile with the server
  }

  // ── Layout CRUD ───────────────────────────────────────────

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
      ...(sl.loop ? { loop: sl.loop } : {}),
      ...(sl.modelSelections ? { modelSelections: sl.modelSelections } : {}),
      ...(sl.sessionMode ? { sessionMode: sl.sessionMode } : {}),
      ...(sl.folder ? { folder: sl.folder } : {}),
      ...(sl.space ? { space: sl.space } : {}),
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
      ...(grid.loop ? { loop: grid.loop } : {}),
      ...(grid.modelSelections && Object.keys(grid.modelSelections).length ? { modelSelections: grid.modelSelections } : {}),
      ...(grid.sessionMode && grid.sessionMode !== "keep" ? { sessionMode: grid.sessionMode } : {}),
      ...(grid.folder ? { folder: grid.folder } : {}),
      ...(grid.space ? { space: grid.space } : {}),
    };
    const id = this.serverIds.get(grid.name);
    const saved = await getClient().layouts.save({ name: grid.name, data: body, ...(id ? { id } : {}) });
    this.serverIds.set(grid.name, saved.id);
    appCache.invalidate(LAYOUTS_CACHE_KEY);
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
