/** workspace-form.ts — the workspace modal's rules, pure (help/workspace-create.ts). */

import { fractionsFor, gridShapeSig } from "./workspace-grid.js";

/** The modal's answers, checked: null when they can be saved. */
export function workspaceFormError(name: string, existing: ReadonlyArray<string>): string | null {
  const n = name.trim();
  if (!n) return "Give the workspace a name.";
  if (n.length > 60) return "Keep the name under 60 characters.";
  if (existing.some((e) => e.trim().toLowerCase() === n.toLowerCase())) return `A workspace named "${n}" already exists.`;
  return null;
}

// ── How the workspace's agents start ─────────────────────────────────────────

/** The three answers a workspace (and each of its agent cells) gives about
 *  its agent: the loop, the face (chat | terminal, stored "glyphh" | "cli")
 *  and the CLI route (stored "on" | "off"). "" = inherit: the cell from the
 *  workspace, the workspace from the member's defaults. */
export interface AgentStart { loop: string; view: "" | "glyphh" | "cli"; gateway: "" | "on" | "off" }

export const INHERIT: AgentStart = { loop: "", view: "", gateway: "" };

/** Read a stored config (a workspace row, or a cell's config) as the modal's answers. */
export function agentStartOf(cfg: { loop?: unknown; view?: unknown; gateway?: unknown } | null | undefined): AgentStart {
  return {
    loop: typeof cfg?.loop === "string" ? cfg.loop : "",
    view: cfg?.view === "glyphh" || cfg?.view === "cli" ? cfg.view : "",
    gateway: cfg?.gateway === "on" || cfg?.gateway === "off" ? cfg.gateway : "",
  };
}

/** A cell config with the agent answers written in: an inherit removes the
 *  key, so the next level decides; every other key is kept as it was. */
export function withAgentStart<T extends Record<string, unknown>>(cfg: T | undefined, a: AgentStart): T {
  const out: Record<string, unknown> = { ...(cfg ?? {}) };
  for (const k of ["loop", "view", "gateway"] as const) {
    if (a[k]) out[k] = a[k];
    else delete out[k];
  }
  return out as T;
}

/** A workspace cell that seats an agent: the Glyphh agent (tool:coding) or a loop's own cell (agent:<cli>). */
export const isAgentCell = (panelId: string | undefined): boolean => {
  const p = String(panelId ?? "").trim().toLowerCase();
  return p === "tool:coding" || p.startsWith("agent:");
};

/** One cell as layouts-list serves it. */
export interface CellRow { panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean; config?: Record<string, unknown> }
/** One workspace as layouts-list serves it (what an edit needs to write it back whole). */
export interface WorkspaceRow {
  name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[];
  target?: "glyphh" | "desktop"; loop?: string | null; view?: "glyphh" | "cli" | null; gateway?: "on" | "off" | null;
  modelSelections?: Record<string, string>; sessionMode?: "keep" | "new" | "last"; type?: "work" | "code" | null;
  folder?: string | null; space?: "chat" | "cowork" | "code" | null; splits: CellRow[];
}

/** The arrangement the modal's grid editor hands back (workspace-grid.ts gridCells). */
export interface EditedArrangement { cols: number; rows: number; cells: CellRow[] }

/** What the edit modal changes. `cells` is keyed by the cell's index in the
 *  cells being saved (`arrangement.cells` when given, else `splits`). */
export interface WorkspaceEdit {
  model: string;
  session: "keep" | "new" | "last";
  folder: string;
  agent: AgentStart;
  cells: Record<number, AgentStart>;
  /** The grid editor's arrangement; absent = the arrangement exactly as it was. */
  arrangement?: EditedArrangement;
}

/**
 * The `layouts-save-grid` payload for an edited workspace: the arrangement
 * the grid editor hands back (or exactly as it was), every field the modal
 * does not show carried through, the modal's answers written over the rest.
 * An agent cell the modal names gets its answers; every other cell keeps its
 * config untouched. The column widths and row heights stay the workspace's
 * own while their count is unchanged, else they go even.
 */
export function editedWorkspaceGrid(row: WorkspaceRow, e: WorkspaceEdit): Record<string, unknown> {
  const models = { ...(row.modelSelections ?? {}) };
  if (e.model) models.default = e.model;
  else delete models.default;
  const a = e.arrangement;
  const cols = a ? a.cols : row.cols, rows = a ? a.rows : row.rows;
  return {
    name: row.name, cols, rows,
    colWidths: a ? fractionsFor(row.colWidths, cols) : row.colWidths,
    rowHeights: a ? fractionsFor(row.rowHeights, rows) : row.rowHeights,
    cells: (a ? a.cells : row.splits).map((c, i) => {
      const cfg = e.cells[i] && isAgentCell(c.panelId) ? withAgentStart(c.config, e.cells[i]!) : c.config;
      return {
        panelId: c.panelId, col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan,
        ...(c.sticky ? { sticky: true } : {}),
        ...(cfg && Object.keys(cfg).length ? { config: cfg } : {}),
      };
    }),
    ...(row.target ? { target: row.target } : {}),
    ...(row.type ? { type: row.type } : {}),
    ...(row.space ? { space: row.space } : {}),
    sessionMode: e.session,
    folder: e.folder.trim() || null,
    loop: e.agent.loop || null,
    view: e.agent.view || null,
    gateway: e.agent.gateway || null,
    ...(Object.keys(models).length ? { modelSelections: models } : {}),
  };
}

/** A cell's setup, as a stable string (keys sorted) — for comparing two saves. */
const setupSig = (cells: ReadonlyArray<{ panelId: string; col?: number; row?: number; sticky?: boolean; config?: Record<string, unknown> }>): string =>
  cells
    .filter((c) => String(c.panelId ?? "").trim())
    .map((c) => {
      const cfg = c.config ?? {};
      const keys = Object.keys(cfg).sort();
      return `${c.col ?? 0},${c.row ?? 0}:${c.sticky ? "s" : ""}:${JSON.stringify(keys.map((k) => [k, cfg[k]]))}`;
    })
    .sort()
    .join("|");

/**
 * Whether an edit to the OPEN workspace must re-open it to show: its
 * arrangement, a cell's pin or setup, its folder or how its agent starts
 * changed. A model or session answer alone applies on the next open (a
 * re-open for it would only throw away the arrangement the user dragged).
 */
export function editShowsOnScreen(row: WorkspaceRow, saved: Record<string, unknown>): boolean {
  const cells = (Array.isArray(saved.cells) ? saved.cells : []) as CellRow[];
  const cols = Number(saved.cols), rows = Number(saved.rows);
  if (gridShapeSig(row.cols, row.rows, row.splits) !== gridShapeSig(cols, rows, cells)) return true;
  if (setupSig(row.splits) !== setupSig(cells)) return true;
  if ((row.folder || null) !== (saved.folder || null)) return true;
  const before = agentStartOf(row), after = agentStartOf(saved as { loop?: unknown; view?: unknown; gateway?: unknown });
  return before.loop !== after.loop || before.view !== after.view || before.gateway !== after.gateway;
}
