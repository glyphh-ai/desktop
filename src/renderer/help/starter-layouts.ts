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

/** NotebookLM — the surface the research skill drives over RPA. It ships as
 *  a default app: the Research starter installs it into the library if the
 *  org doesn't have it, so the layout always has something to open. */
const NOTEBOOKLM = { slug: "notebooklm", name: "NotebookLM", url: "https://notebooklm.google.com" };

/** Make sure a default app exists, and answer with the panel id the layout
 *  should reference (existing rows keep their own slug — we never duplicate
 *  an app the user already has under another name). */
async function ensureDefaultApp(app: { slug: string; name: string; url: string }): Promise<string> {
  try {
    const apps = (await window.yo.panelAppsList?.()) ?? [];
    const host = new URL(app.url).host;
    const hit = apps.find((a) => {
      const row = a as { slug?: string; url?: string | null };
      if ((row.slug || "").toLowerCase().includes(app.slug)) return true;
      try { return !!row.url && new URL(row.url).host === host; } catch { return false; }
    }) as { slug?: string; id?: string } | undefined;
    if (hit) return (hit.slug || hit.id || app.slug).toLowerCase();
    const made = await window.yo.panelAppsCreate?.({ name: app.name, slug: app.slug, url: app.url, isBrowser: true });
    return (made?.app?.slug || app.slug).toLowerCase();
  } catch {
    return app.slug;   // offline — the cell resolves (or is skipped) on the next try
  }
}

export const STARTER_LAYOUTS: Record<"dev" | "email" | "research", LayoutTemplate> = {
  // FALLBACK ONLY — the server seeds "Dev" into every org at signup, so this
  // is used only by a workspace that deleted it. Same shape as the seeded
  // one (files/diff left, editor/terminal middle, agent right) so the two
  // can never drift apart.
  dev: {
    name: "Dev", space: "code", cols: 3, rows: 2,
    colWidths: [0.34, 0.33, 0.33], rowHeights: [0.5, 0.5], sessionMode: "last",
    cells: [
      { panelId: "tool:files", col: 0, row: 0, colSpan: 1, rowSpan: 1 },
      { panelId: "tool:diff", col: 0, row: 1, colSpan: 1, rowSpan: 1 },
      { panelId: "tool:monaco", col: 1, row: 0, colSpan: 1, rowSpan: 1 },
      { panelId: "tool:terminal", col: 1, row: 1, colSpan: 1, rowSpan: 1 },
      { panelId: "tool:coding", col: 2, row: 0, colSpan: 1, rowSpan: 2 },
    ],
  },
  // FALLBACK ONLY — the server seeds "Email" (agent + Gmail + Calendar).
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
      { panelId: "@notebooklm", col: 1, row: 0, colSpan: 1, rowSpan: 1 },
    ],
  },
};

/** An app cell can go stale (the app was deleted, or the layout was saved
 *  while offline). Re-resolve it against the library and re-save, so the
 *  Research layout never opens with a hole where NotebookLM should be. */
async function repairAppCell(t: LayoutTemplate, existing: unknown[]): Promise<void> {
  const row = (existing as Array<{ name?: string; splits?: Array<{ panelId: string }> }>)
    .find((l) => (l.name || "").toLowerCase() === t.name.toLowerCase());
  const cells = row?.splits ?? [];
  const appCell = cells.find((c) => !c.panelId.startsWith("tool:"));
  const apps = (await window.yo.panelAppsList?.()) ?? [];
  const known = apps.some((a) => {
    const r = a as { slug?: string; id?: string };
    return (r.slug || "").toLowerCase() === (appCell?.panelId || "").toLowerCase()
      || (r.id || "").toLowerCase() === (appCell?.panelId || "").toLowerCase();
  });
  if (!appCell || known) return;
  const slug = await ensureDefaultApp(NOTEBOOKLM);
  await window.yo.layoutsSaveGrid?.({
    name: t.name, cols: t.cols, rows: t.rows,
    colWidths: t.colWidths, rowHeights: t.rowHeights,
    cells: cells.map((c) => (c === appCell ? { ...c, panelId: slug } : c)) as LayoutTemplate["cells"],
    folderMode: "single", target: "glyphh", sessionMode: t.sessionMode, space: t.space,
  });
}

/**
 * Open a starter's layout, creating it on first use. Resolves once the
 * layout is on screen (or immediately if there's nothing to open) so the
 * caller can seed the composer into it.
 */
export async function openStarterLayout(key: keyof typeof STARTER_LAYOUTS): Promise<void> {
  const t = STARTER_LAYOUTS[key];
  try {
    const existing = (await window.yo.layoutsList?.()) ?? [];
    // Case-INSENSITIVE: the server seeds "Dev"/"Email" into every org and
    // some carry lowercase "email"/"research". Matching exactly would add a
    // second, capitalised copy of a layout the user already has.
    const match = existing.find((l) =>
      ((l as { name?: string }).name || "").toLowerCase() === t.name.toLowerCase()) as { name?: string } | undefined;
    const known = !!match;
    const openName = match?.name ?? t.name;
    if (!known) {
      // "@notebooklm" resolves to a real panel id, installing the default
      // app first if the org doesn't have it yet.
      const cells = [];
      for (const cell of t.cells) {
        cells.push(cell.panelId === "@notebooklm"
          ? { ...cell, panelId: await ensureDefaultApp(NOTEBOOKLM) }
          : cell);
      }
      await window.yo.layoutsSaveGrid?.({
        name: t.name,
        cols: t.cols, rows: t.rows,
        colWidths: t.colWidths, rowHeights: t.rowHeights,
        cells,
        folderMode: "single",
        target: "glyphh",
        sessionMode: t.sessionMode,
        space: t.space,
      });
    }
    else if (key === "research") await repairAppCell(t, existing);
    await window.yo.layoutsOpen?.(openName);
  } catch {
    /* offline or the library refused — the starter still seeds its prompt */
  }
}
