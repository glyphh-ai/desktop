/**
 * app-list.ts — THE app list. One function, both surfaces.
 *
 * The echo wall and the left rail show the same apps, so they compute that
 * set HERE rather than each applying its own filter. They had drifted: the
 * wall required a deployed url and dropped nav rows, the rail also kept
 * url-less native rows and skipped the house defaults entirely — and on top
 * of that the rail hand-injected a fixed Design tile that outlived its own
 * panel (his report, 2026-09-11: "why is that list not the same list as the
 * echo panel?" / "I want the left rail to be THE SAME AS THE ONE IN THE ECHO
 * PANEL — it is correct").
 *
 * The echo panel's rule is the correct one, so it is the rule here. Anything
 * that wants to change what either surface shows changes this file, and both
 * move together.
 */

/** The shape both surfaces need off an app row. Callers pass their own
 *  richer row types through — everything else rides along untouched. */
export interface AppRowLite {
  id: string;
  slug?: string | null;
  name: string;
  url?: string | null;
  appArchetype?: string | null;
}


/**
 * Is this row an APP on the wall?
 *
 * - `glyphh-self` is the agent's own row — the Glyphh mark is the way in,
 *   not a tile in the list.
 * - `glyphh-nav` rows are navigation pages; the left rail owns navigation.
 * - No url means not deployed: a glyphh app in development belongs on the
 *   Apps page, not the consumption surfaces (his rule, 2026-08-25).
 */
export const wallAppRow = (a: { url?: string | null; appArchetype?: string | null }): boolean =>
  a.appArchetype !== "glyphh-self" && a.appArchetype !== "glyphh-nav" && (!!a.url || a.appArchetype === "glyphh-app");

const keyOf = (a: { slug?: string | null; id: string }): string => (a.slug || a.id).toLowerCase();

/**
 * The visible app set: the member's own rows. (No house defaults join them:
 * nothing is a default app for anyone, his order 2026-10-09.)
 */
export function visibleAppRows<T extends AppRowLite>(rows: T[] | null | undefined): T[] {
  const all = (rows || []).filter(wallAppRow);
  // Glyphh apps lead — the org's own work before anything vendored in.
  all.sort((x, y) => (y.appArchetype === "glyphh-app" ? 1 : 0) - (x.appArchetype === "glyphh-app" ? 1 : 0));
  return all;
}
