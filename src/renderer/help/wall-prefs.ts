/**
 * wall-prefs.ts — the SIDEBAR's one tray option, as a pure value + reader.
 *
 * THE WORKSPACES TRAY (his orders, 2026-10-08): the Tabs tray and its
 * tabs-per-row slider are gone ("remove the tabs option… and default the
 * workspaces on. that makes much more sense"). Workspaces sits at the
 * bottom of the rail under a drag line, ON by default; Appearance can still
 * turn it off. Settings writes the pref, then dispatches
 * RAIL_SECTIONS_CHANGED_EVENT; the rail re-reads (help/code.ts
 * applyRailSectionsVisibility).
 *
 * Kept free of `window` so it can be tested without a DOM.
 */

export const RAIL_SHOW_LAYOUTS_PREF = "railShowLayouts";
export const RAIL_SHOW_DEFAULT = true;
export const RAIL_SECTIONS_CHANGED_EVENT = "glyphh:rail-sections-changed";
/** A stored value → shown? On unless the member turned it off. */
export function railTrayShown(v: unknown): boolean { return v !== false; }

/** The Workspaces tray's dragged height (px). 0 = the CSS default. */
export const RAIL_LAYOUTS_H_PREF = "railLayoutsH";
export const RAIL_LAYOUTS_MIN_H = 80;
/** The tray never takes more than this share of the rail's height. */
export const RAIL_LAYOUTS_MAX_SHARE = 0.75;
export function clampRailLayoutsH(h: unknown, railH: number): number {
  const n = Number(h);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const max = Math.max(RAIL_LAYOUTS_MIN_H, Math.round(railH * RAIL_LAYOUTS_MAX_SHARE));
  return Math.max(RAIL_LAYOUTS_MIN_H, Math.min(max, Math.round(n)));
}
