/**
 * starter-layouts — the workspaces the Chat starters open into.
 *
 * A starter card is a whole setup, not just a prompt: "Build an app" opens
 * the dev layout, "Triage my inbox" opens the email layout, "Research a
 * topic" opens the research layout beside NotebookLM. Each template is a
 * real layout — saved into the user's library the first time it is used, so
 * from then on it lives on the Layouts page and can be edited like any
 * other. An existing layout with the same name always wins: we never
 * overwrite what the user has made.
 */

import type { Space } from "./space-meta.js";

export interface LayoutTemplate {
  name: string;
  space: Space;
  cols: number;
  rows: number;
  colWidths: number[];
  rowHeights: number[];
  sessionMode: "keep" | "new" | "last";
  cells: Array<{
    panelId: string; col: number; row: number; colSpan: number; rowSpan: number;
    sticky?: boolean; config?: { url?: string; cmd?: string; keepAlive?: boolean };
  }>;
}

/** The NotebookLM app the research skill drives over RPA. The cell is
 *  skipped harmlessly when the app isn't installed. */
const NOTEBOOKLM = "notebooklm-f90d39da";

export const STARTER_LAYOUTS: Record<"dev" | "email" | "research", LayoutTemplate> = {
  // The agent down the left, the code it is writing on the right.
  dev: {
    name: "Dev", space: "code", cols: 2, rows: 2,
    colWidths: [0.52, 0.48], rowHeights: [0.62, 0.38], sessionMode: "last",
    cells: [
      { panelId: "tool:coding", col: 0, row: 0, colSpan: 1, rowSpan: 2 },
      { panelId: "tool:editor", col: 1, row: 0, colSpan: 1, rowSpan: 1 },
      { panelId: "tool:terminal", col: 1, row: 1, colSpan: 1, rowSpan: 1 },
    ],
  },
  // The agent beside the actual mailbox.
  email: {
    name: "Email", space: "cowork", cols: 2, rows: 1,
    colWidths: [0.42, 0.58], rowHeights: [1], sessionMode: "last",
    cells: [
      { panelId: "tool:coding", col: 0, row: 0, colSpan: 1, rowSpan: 1 },
      { panelId: "tool:preview", col: 1, row: 0, colSpan: 1, rowSpan: 1, config: { url: "https://mail.google.com" } },
    ],
  },
  // The agent beside NotebookLM — the surface the research skill drives.
  research: {
    name: "Research", space: "cowork", cols: 2, rows: 1,
    colWidths: [0.4, 0.6], rowHeights: [1], sessionMode: "last",
    cells: [
      { panelId: "tool:coding", col: 0, row: 0, colSpan: 1, rowSpan: 1 },
      { panelId: NOTEBOOKLM, col: 1, row: 0, colSpan: 1, rowSpan: 1 },
    ],
  },
};

/**
 * Open a starter's layout, creating it on first use. Resolves once the
 * layout is on screen (or immediately if there's nothing to open) so the
 * caller can seed the composer into it.
 */
export async function openStarterLayout(key: keyof typeof STARTER_LAYOUTS): Promise<void> {
  const t = STARTER_LAYOUTS[key];
  try {
    const existing = (await window.yo.layoutsList?.()) ?? [];
    const known = existing.some((l) => (l as { name?: string }).name === t.name);
    if (!known) {
      await window.yo.layoutsSaveGrid?.({
        name: t.name,
        cols: t.cols, rows: t.rows,
        colWidths: t.colWidths, rowHeights: t.rowHeights,
        cells: t.cells,
        folderMode: "single",
        target: "glyphh",
        sessionMode: t.sessionMode,
        space: t.space,
      });
    }
    await window.yo.layoutsOpen?.(t.name);
  } catch {
    /* offline or the library refused — the starter still seeds its prompt */
  }
}
