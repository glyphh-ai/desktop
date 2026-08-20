/**
 * starter-layouts — the workspaces the Chat starters open into.
 *
 * The server seeds Dev, Email and Research at signup
 * (server/src/domains/org/starter-defaults.ts) — that is the source of
 * truth, and the definitions here MIRROR it. The only job on this side is
 * backfill: a user who predates a starter (or deleted it) gets it created
 * for them the first time they reach for it, written to the SERVER through
 * the same library API as any other layout. Nothing is stored client-side.
 *
 * Cells address apps by ROW ID, never by slug — that is the seeder's
 * convention and what the editor and the Layouts page resolve by.
 */

type Cell = { panelId: string; col: number; row: number; colSpan: number; rowSpan: number };
const cell = (panelId: string, col: number, row: number, rowSpan = 1): Cell =>
  ({ panelId, col, row, colSpan: 1, rowSpan });

interface Template {
  name: string;
  cols: number;
  rows: number;
  /** Tool cells are fixed; app cells resolve to ids by their seeded slug. */
  build: (appId: (slug: string) => string | null) => Cell[] | null;
}

const TEMPLATES: Record<"dev" | "email" | "research", Template> = {
  // Files/Diff | Editor/Terminal | the agent full-height on the right.
  dev: {
    name: "Dev", cols: 3, rows: 2,
    build: () => [
      cell("tool:files", 0, 0), cell("tool:diff", 0, 1),
      cell("tool:monaco", 1, 0), cell("tool:releases", 1, 1),
      cell("tool:coding", 2, 0, 2),
    ],
  },
  // The mailbox beside the calendar.
  email: {
    name: "Email", cols: 2, rows: 1,
    build: (appId) => {
      const gmail = appId("gmail"), cal = appId("google-calendar");
      return gmail && cal ? [cell(gmail, 0, 0), cell(cal, 1, 0)] : null;
    },
  },
  // The agent beside NotebookLM — the surface the research skill drives.
  research: {
    name: "Research", cols: 2, rows: 1,
    build: (appId) => {
      const nb = appId("notebooklm");
      return nb ? [cell("tool:coding", 0, 0), cell(nb, 1, 0)] : null;
    },
  },
};

export const STARTER_LAYOUTS = TEMPLATES;

/** Create the layout ON THE SERVER, mirroring the signup seed. Never
 *  overwrites: the name is re-checked against a FRESH list immediately
 *  before the write, so a stale or half-loaded list can't clobber a layout
 *  the user already has under that name. */
async function backfill(t: Template): Promise<void> {
  const fresh = (await window.glyphh.layoutsList?.()) ?? [];
  if (fresh.some((l) => ((l as { name?: string }).name || "").toLowerCase() === t.name.toLowerCase())) return;
  const apps = (await window.glyphh.panelAppsList?.()) ?? [];
  const appId = (slug: string): string | null => {
    const hit = apps.find((a) => ((a as { slug?: string }).slug || "").toLowerCase().includes(slug)) as { id?: string } | undefined;
    return hit?.id ?? null;
  };
  const cells = t.build(appId);
  if (!cells) return;   // a seeded app is missing — better no layout than a broken one
  await window.glyphh.layoutsSaveGrid?.({
    name: t.name,
    cols: t.cols, rows: t.rows,
    colWidths: Array.from({ length: t.cols }, () => 1 / t.cols),
    rowHeights: Array.from({ length: t.rows }, () => 1 / t.rows),
    cells,
    folderMode: "single",
    target: "glyphh",
  });
}

/** Open a starter's workspace, creating it server-side when it's missing. */
export async function openStarterLayout(key: keyof typeof TEMPLATES): Promise<void> {
  const t = TEMPLATES[key];
  try {
    const existing = (await window.glyphh.layoutsList?.()) ?? [];
    // Case-insensitive: a workspace may carry its own lowercase copy, and a
    // second capitalised one would be a duplicate, not a fix.
    const match = existing.find((l) =>
      ((l as { name?: string }).name || "").toLowerCase() === t.name.toLowerCase()) as { name?: string } | undefined;
    // An EMPTY list is ambiguous — a workspace with no layouts reads the
    // same as a list call that failed — so only backfill when the library
    // answered with something. A missing starter is recoverable; writing
    // over a layout because the list came back empty is not.
    if (!match && existing.length) await backfill(t);
    await window.glyphh.layoutsOpen?.(match?.name ?? t.name);
  } catch {
    /* offline — the starter still seeds its prompt */
  }
}
