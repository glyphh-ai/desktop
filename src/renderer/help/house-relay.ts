/**
 * house-relay.ts — THE HOUSE APPS ON THE WEB, as pure rules.
 *
 * The house apps — Design, Slides, Images, Video, Audio, Drive — are REAL
 * APPS: cloud instances the server installs for every member, each carrying
 * its tools and SKILL.md (his law, 2026-10-06). What is theirs on a surface
 * is the PANEL: an instance of one of these slugs opens the surface's OWN
 * work panel (gdesign / gpoint / gimage / gvideo / gsound / gdrive —
 * code-workbench.ts __wbOpenTool), never its instance's ui frame, and the
 * panel reads ONE store: the member library (shared/house-store.ts).
 *
 * This table is the renderer's COPY of shared/house-store.ts
 * HOUSE_VIEW_OF_APP (the renderer never imports src/shared): main and the
 * web stamp it onto an instance's tab as `tool`; help/agent-menu.ts (the row
 * rule) and the web's shims read it here. test/main/house-relay.test.ts pins
 * the two copies equal.
 */

/** A house app's slug on the desktop → the work panel view that shows it. */
export const HOUSE_VIEW_OF_APP: Readonly<Record<string, string>> = Object.freeze({
  design: "gdesign", slides: "gpoint", images: "gimage", video: "gvideo", audio: "gsound", drive: "gdrive",
});

/** The house views — the panels both surfaces host themselves. */
export const HOUSE_TOOL_VIEWS: ReadonlyArray<string> = Object.freeze(Object.values(HOUSE_VIEW_OF_APP));

/** The house app slugs. */
export const HOUSE_APPS: ReadonlyArray<string> = Object.freeze(Object.keys(HOUSE_VIEW_OF_APP));

/** The house view a tab's launchConfig.tool names, or null for anything else. */
export function houseViewOf(tool: unknown): string | null {
  return typeof tool === "string" && HOUSE_TOOL_VIEWS.includes(tool) ? tool : null;
}
