/**
 * surface.ts — ONE LIST FOR EVERYTHING; the web cut collapsed into CAPABILITY
 * CHECKS (his order, 2026-10-06: "Cloud is first and every surface pulls from
 * it. Way less complicated." — after "the web should just be identical to the
 * app").
 *
 * The desktop and the web run the SAME code on every surface — the Echo
 * (wall, dock, search, folders), the workspaces, the ⋮ menu, the Customize
 * page — reading the same server records and prefs. The only
 * differences are CAPABILITIES a browser does not have, checked where the
 * capability is used, never as "two worlds":
 *
 *   nativeWindows   a native app's window (a desktop binary) — the browser
 *                   cannot launch one, so a native app's tile and cell are
 *                   the desktop's alone.
 *   streamedPanels  a page streamed from a worker (the Browser panel, an
 *                   embedded URL page in a grid cell) — not reachable from
 *                   the web, whatever asks.
 *
 * surfaceCaps(web) answers both; surfaceHostsTile / surfaceHostsView /
 * surfaceLayoutCells apply them. On the desktop every check passes.
 *
 * What stays below is NOT a world-split but one of his explicit orders about
 * the web's page: + New closes everything, Close all opens a fresh session,
 * Artifacts / Customize open full screen, the rail header's order,
 * the type tab a net-new user lands on, and the settings rows for a
 * capability the browser lacks. Every rule here is PURE data so the
 * workbench, the settings nav and the tests read the same answer.
 *
 * Unit-tested in test/main/surface.test.ts.
 */

// ── THE CAPABILITY MODEL ───────────────────────────────────────────────────

/** What a surface can host beyond the in-document panels. */
export type SurfaceCaps = { nativeWindows: boolean; streamedPanels: boolean };

/** The desktop hosts everything. */
export const DESKTOP_CAPS: Readonly<SurfaceCaps> = Object.freeze({ nativeWindows: true, streamedPanels: true });
/** A browser launches no native window and reaches no streamed panel. */
export const BROWSER_CAPS: Readonly<SurfaceCaps> = Object.freeze({ nativeWindows: false, streamedPanels: false });

/** The capabilities of this surface. */
export function surfaceCaps(web: boolean): Readonly<SurfaceCaps> {
  return web ? BROWSER_CAPS : DESKTOP_CAPS;
}

/** The one tool view that needs a streamed panel: the Browser. */
export const STREAMED_VIEWS: ReadonlyArray<string> = Object.freeze(["preview"]);

/** Does this surface host a tool view? Every in-document panel (Files,
 *  Terminal, Editor, Diff, Plan, Agents, Artifacts, the house panels) — and
 *  the Browser only where a streamed panel can be. */
export function surfaceHostsView(view: string, caps: Readonly<SurfaceCaps>): boolean {
  return !STREAMED_VIEWS.includes(view) || caps.streamedPanels;
}

/** A wall / dock tile as the workbench carries it (EchoTile's capability-
 *  bearing fields). `archetype` is the app row's appArchetype: "native" is a
 *  desktop binary; "web" a URL tab; "glyphh-app" a Glyphh app; "glyphh-nav"
 *  a section. `cloud` marks a cloud app INSTANCE (the row's launchConfig
 *  names its `instance`); `houseDefault` a house built-in row (no appId). */
export type SurfaceTileIn = {
  kind: "app" | "layout" | "tool" | "agent" | "folder";
  toolView?: string; navKey?: string; archetype?: string | null;
  /** a cloud app instance — installed in the cloud, a panel on every surface */
  cloud?: boolean;
  /** a house built-in row (the glyphh launcher set; carries no appId) */
  houseDefault?: boolean;
  /** a dock nav slot's app (a section tile traded onto the pages) */
  navApp?: { archetype?: string; execPath?: string | null } | null;
};

/** THE ONE RULE FOR THE WALL AND THE DOCK: a surface hosts every layout,
 *  every section, the Glyphh agent, every dock control (New
 *  tab opens a browser tab on the web) and every tool view it can host — the
 *  Browser needs a streamed panel. An APP tile: the desktop (native windows)
 *  hosts every one. A surface WITHOUT native windows hosts ONLY what it can
 *  render itself — a cloud app instance, a house built-in, a nav row; every
 *  saved TAB row (a URL tab, a native app, a bundle with an execPath or a
 *  url) is the desktop's alone (his report, 2026-10-06: "the web based echo
 *  panel is broken again it is showing all the tabs… the echo for web just
 *  needs to filter out the tabs as they can't render on web"). Both surfaces
 *  read the SAME library rows; the filter paints — it never rewrites the
 *  member's saved dock order or folders. */
export function surfaceHostsTile(t: SurfaceTileIn, caps: Readonly<SurfaceCaps>): boolean {
  switch (t.kind) {
    case "layout": return true;
    case "folder": return true;   // emptied of its members by the caller; an empty folder leaves
    case "agent": return true;
    case "tool":
      if (t.navKey) return true;
      return !!t.toolView && surfaceHostsView(t.toolView, caps);
    case "app": {
      if (caps.nativeWindows) return true;
      const navRow = t.archetype === "glyphh-nav" || t.navApp?.archetype === "glyphh-nav" || !!t.navKey;
      return !!t.cloud || !!t.houseDefault || navRow;
    }
    default: return false;
  }
}

// ── WHAT THE HOME SHELL BOOTS INTO ─────────────────────────────────────────

// ── SETTINGS: THE GROUP PAGES ──────────────────────────────────────────────

/** ONE PAGE (his report, 2026-10-07: "The Build and Customize tabs are
 *  confusing. It should just be one tab"). The two lists below are the
 *  halves of the one Customize page; their names stay for the rows they
 *  list. The library half: Skills, Agents, Apps, Tasks and the Claude Code
 *  plugins. Connections sits beside them (WEB_GROUP_ROWS). */
export const WEB_BUILD_SUBS: ReadonlyArray<string> = Object.freeze(["skills", "agents", "apps", "tasks", "plugins"]);

/** The shape half: empty now. (Tabs, Workspaces, Drips and Schedules left the
 *  page, his orders 2026-10-09: workspaces live in the rail's tray and its +,
 *  Schedules is a page of its own from the rail.) */
export const WEB_CUSTOMIZE_SUBS: ReadonlyArray<string> = Object.freeze([]);

/** THE ONE PAGE'S TAB ORDER (his report, 2026-10-07): Skills, Agents, Apps,
 *  Connections, Plugins, Tabs, Workspaces, Drips, Schedules — Tasks stays a
 *  hidden row (2026-09-17) and so never paints a tab. The Settings nav lists
 *  its rows in this order under the one Customize header. */
export const CUSTOMIZE_TAB_ORDER: ReadonlyArray<string> = Object.freeze(["skills", "agents", "apps", "connections-cfg", "plugins", "tasks"]);


/** The settings nav group header the web's Settings modal does not list —
 *  the rail's Customize page carries those tabs on the web. */
export const WEB_HIDDEN_NAV_GROUPS: ReadonlyArray<string> = Object.freeze(["nav-group-customize"]);

/** The pages the web's Settings modal lists (the test pins this list against
 *  the desktop-only ones so a page can never be on both sides). */
export const WEB_KEPT_SUBS: ReadonlyArray<string> = Object.freeze([
  "general", "appearance", "models", "memory", "artifacts", "connections-cfg",
  "billing",
]);

/** The MCP Server page is the DESKTOP's local MCP door — a capability the
 *  browser lacks (his order, 2026-10-05: "mcp server shouldn't be on the web").
 *  Loops are the CLIs installed on this machine: the browser has none. */
export const WEB_DESKTOP_ONLY_EXTRA: ReadonlyArray<string> = Object.freeze(["mcp", "loops"]);

/** THE RAIL'S MENU ON THE WEB (his order, 2026-10-05: "In web the build,
 *  customize webpanels should be what is shown in the left rail", then
 *  "remove connections and devices from the left rail on web"): Artifacts,
 *  Customize — each opens FULL SCREEN (webPanelOpensFullScreen). Build folded
 *  into Customize (his report, 2026-10-07). Connections and Devices stay
 *  reachable inside Settings. The desktop's rail keeps the same two. */
export const WEB_RAIL_LINKS: ReadonlyArray<{ sub: string; label: string }> = Object.freeze([
  { sub: "artifacts", label: "Artifacts" },
  { sub: "customize", label: "Customize" },
  // A page of its own from the rail (his order, 2026-10-09).
  { sub: "schedules", label: "Schedules" },
]);

/** THE WEB'S FULL-SCREEN PANELS (his order, 2026-10-05: "artifacts -> new
 *  web panel -> open an artifact it opens full screen in place of anything
 *  else showing… The build and customize left rail items go to the same
 *  thing. Those panels open full replacing anything showing in the web. The
 *  close or x on the top right just closes and the agent and any other work
 *  panels open."). Opening one hides the agent card and every open work
 *  panel (kept mounted, state preserved) and paints the panel edge to edge
 *  under a header where the agent header is — "‹ <title>" on the left (back
 *  = close), an X on the right. Closing restores exactly what was showing.
 *  Customize takes this path on the desktop too (GROUP_PAGES); Artifacts
 *  stays an ordinary work panel there. */
export const webFullScreenPanels: ReadonlyArray<string> = Object.freeze(["artifacts", "customize", "schedules"]);
export function webPanelOpensFullScreen(key: string): boolean {
  return webFullScreenPanels.includes(key);
}
/** THE GROUP PAGE (his order, 2026-10-07): ONE Customize page. Customize and
 *  Artifacts open FULL SCREEN on BOTH surfaces, over the panels, one at a time
 *  — only a close, no expand (his order, 2026-10-09: "i still want customize
 *  and artifacts to open full screen. Closing each other and over the top of
 *  the other panels"). */
export const GROUP_PAGES: ReadonlyArray<string> = Object.freeze(["customize"]);
export type GroupPage = "customize";
export function panelOpensFullScreen(key: string, _web: boolean): boolean {
  return webPanelOpensFullScreen(key);
}
/** A DEAD PAGE KEY RESOLVES TO THE ONE PAGE (his report, 2026-10-07): a saved
 *  dock slot, a wall card, a remembered rail section or an older caller
 *  naming "build" opens Customize. */
export const GROUP_PAGE_ALIASES: Readonly<Record<string, GroupPage>> = Object.freeze({ build: "customize" });
export function groupPageKey(key: string): string {
  return GROUP_PAGE_ALIASES[key] ?? key;
}
/** The group page a settings row is a tab of, or null for a plain settings
 *  page. Every such row opens its page, never the modal, on both surfaces. */
export function groupOfSub(sub: string): GroupPage | null {
  return WEB_GROUP_ROWS.includes(sub) ? "customize" : null;
}
/** The header's title per full-screen panel ("‹ Artifacts"). */
export const WEB_FULL_SCREEN_TITLES: Readonly<Record<string, string>> = Object.freeze({ artifacts: "Artifacts", customize: "Customize", schedules: "Schedules" });
export function webFullScreenTitle(key: string): string {
  return WEB_FULL_SCREEN_TITLES[key] ?? key;
}

/** THE CUSTOMIZE PAGE IS THE SAME ON BOTH SURFACES (his order, 2026-10-05:
 *  "why is the web build tab different than the desktop one?"). The page
 *  lists its tabs ONE way on both hosts: the group's nav rows that are not
 *  `.hidden` (navigation.ts groupTabs), in CUSTOMIZE_TAB_ORDER. The web's
 *  Settings modal therefore never marks those rows `.hidden`: it marks them
 *  WEB_CUT_ROW_CLASS (CSS-hidden in the Settings nav only), and their panels
 *  stay mounted for the full-screen page to adopt. */
export const WEB_CUT_ROW_CLASS = "web-cut-row";
/** The settings rows the Customize page owns: every tab of the one page. */
export const WEB_GROUP_ROWS: ReadonlyArray<string> = Object.freeze([...WEB_BUILD_SUBS, "connections-cfg", ...WEB_CUSTOMIZE_SUBS]);
/** Is this settings row a group page's — its panel stays MOUNTED (not
 *  CSS-hidden) and its nav row wears WEB_CUT_ROW_CLASS, never `.hidden`? */
export function webGroupPanelKept(sub: string): boolean {
  return WEB_GROUP_ROWS.includes(sub);
}

/** + NEW ON THE WEB CLOSES EVERYTHING (his order, 2026-10-05: "no matter
 *  what page is up clicking new in the left rail closes whatever is open and
 *  shows the new session page"): the full-screen page, every open work
 *  panel and app card go, and the fresh session is what shows. The desktop
 *  keeps its panels (New there is another panel on a new session). */
export function webNewClosesEverything(web: boolean): boolean {
  return web;
}

/** THE WORDMARK holds the chrome spot on the web (the traffic lights' spot on
 *  the desktop; his order, 2026-10-05). */
export const WEB_RAIL_WORDMARK = ".app-rail-logo";
/** Does the wordmark hold the chrome spot here? Web only. */
export function webRailWordmark(web: boolean): boolean {
  return web;
}

/** The rail's More toggle — hidden on the web (ids and selectors, applied by
 *  web-surface.ts). Customize left this list on 2026-10-05: it is the rail's
 *  full-screen page now. */
export const WEB_HIDDEN_RAIL: ReadonlyArray<string> = Object.freeze([
  "#rail-more-toggle",
  // The Workspaces tray (2026-10-08) is the desktop's: workspaces are kept there.
  "#rail-layouts-vsplit", "#rail-layouts-head", "#rail-layouts-body",
]);

/** Settings rows for a CAPABILITY the browser lacks: the streamed web
 *  panels (General). The dock's rows (Appearance → Show the dock, auto-hide,
 *  reveal) show on the web: the web's Echo carries the dock. */
export const WEB_HIDDEN_SETTINGS_ROWS: ReadonlyArray<string> = Object.freeze([
  "#streamed-panels-row",
  "#rail-layouts-row",
  // The loops are the desktop's CLIs: the web runs Glyphh's own loop alone.
  "#agent-defaults-head",
  "#default-loop-row",
  "#default-view-row",
  "#cli-gateway-row",
]);

// ── THE TOOL VIEWS ─────────────────────────────────────────────────────────

/** The workbench's in-document tool views in the ⋮ menu's order; the
 *  Browser among them needs a streamed panel. */
export const DESKTOP_TOOL_VIEWS: ReadonlyArray<string> = Object.freeze(["files", "terminal", "monaco", "preview", "diff", "plan"]);

/** The tool views this surface hosts, in the one order. */
export function toolViewsHosted(caps: Readonly<SurfaceCaps>): ReadonlyArray<string> {
  return Object.freeze(DESKTOP_TOOL_VIEWS.filter((v) => surfaceHostsView(v, caps)));
}

/** The tool views the browser hosts: the desktop's list through BROWSER_CAPS
 *  (no streamed Browser). */
export const WEB_TOOL_VIEWS: ReadonlyArray<string> = toolViewsHosted(BROWSER_CAPS);

/** Is this tool view hosted on the web? */
export function webToolAllowed(view: string): boolean {
  return surfaceHostsView(view, BROWSER_CAPS);
}

/** The views the web's workbench door (__wbOpenTool) refuses outright: the
 *  Browser is a page streamed from a worker — a capability the browser lacks,
 *  whatever asks (the rail's More, a saved wall, an agent tool). */
export const WEB_UNREACHABLE_VIEWS: ReadonlyArray<string> = STREAMED_VIEWS;
export function webToolReachable(view: string): boolean {
  return surfaceHostsView(view, BROWSER_CAPS);
}

/** THE PANELS MOVE ON THE WEB — THE AGENT TOO (his review of the web cut,
 *  2026-10-05: "the panels are not movable", then "the glyphh agent panel
 *  should be draggable too… like it was before, not fixed in place"). The
 *  web seats the agent as a card and nothing else is on the page, so with
 *  its head hidden there was nothing to grab, and the flow's drag refused
 *  the agent as a source and as a swap target. On the web the agent card is
 *  a movable flow panel like any other: its head is the drag handle, it
 *  reorders among the panels and drives to a side, and the seams resize it.
 *  It still owns its column — nothing stacks under it. The desktop keeps its
 *  own rule (the agent never reflowed by a drag), untouched. */
export function agentCardMovable(web: boolean): boolean {
  return web;
}

/** + NEW ON THE WEB (his report, 2026-10-05: the rail's + New did nothing).
 *  The web's one agent is in-document and never instanced, so the desktop's
 *  "another panel, told to start clean" has no panel to mint: `activateGlyphh`
 *  found the seated card and only repainted it. With the agent seated the
 *  web starts the new session IN that card (help/code.ts newSessionInPlace,
 *  bound as __glyphhNewSession); with none seated it opens the agent as
 *  before. The desktop is untouched (always false). */
export function webNewSessionInPlace(web: boolean, agentSeated: boolean): boolean {
  return web && agentSeated;
}

/** CLOSE ALL PANELS ON THE WEB OPENS A NEW SESSION (his order, 2026-10-05:
 *  "close all panels in web -> closes all panels -> opens new either work
 *  or code depending on what was opened last"). Every card closes; on the
 *  web the agent then starts a fresh session in place in the rail's current
 *  type (its type tab is "what was opened last"). The desktop only closes. */
export function webCloseAllOpensNew(web: boolean): boolean {
  return web;
}

// ── WORKSPACE CELLS: THE SAME CAPABILITY RULE PER CELL ─────────────────────

/** A workspace cell as the layout rows carry it: `tool:<view>` or an app's id / slug. */
export type LayoutCellIn = { panelId: string };
/** An installed-app row as the ⋮ menu reads it (agent-menu-ui.ts
 *  installedRowsOf) or the wall's rows carry it: kind "glyphh" = a Glyphh app,
 *  "web" = a URL tab, "native" = a desktop binary. */
export type LayoutApp = { slug: string; id?: string; name?: string; kind?: string };
/** `agent` = the layout's Glyphh agent cell (tool:coding), kept as is. */
export type LayoutKeep = { kind: "tool"; view: string } | { kind: "app"; slug: string; name: string } | { kind: "agent" };
/** The layout's own Glyphh agent cell. */
export const LAYOUT_AGENT_CELL = "tool:coding";
export type LayoutPlan = { keep: LayoutKeep[]; skipped: string[] };

/** THE CAPABILITY RULE PER CELL, on both surfaces: a tool cell opens when
 *  the surface hosts its view (the Browser needs a streamed panel); a Glyphh
 *  app cell opens; a URL tab cell is an embedded page — a streamed panel; a
 *  native app cell needs a native window; the Glyphh agent's own cell is
 *  kept as is. An id no row
 *  answers to is named. With desktop caps nothing is skipped but an unknown
 *  id. Each skip is one line. */
export function surfaceLayoutCells(cells: ReadonlyArray<LayoutCellIn>, apps: ReadonlyArray<LayoutApp>, caps: Readonly<SurfaceCaps>): LayoutPlan {
  const keep: LayoutKeep[] = [];
  const skipped: string[] = [];
  const rowOf = (id: string): LayoutApp | undefined => {
    const k = id.toLowerCase();
    return apps.find((a) => (a.slug || "").toLowerCase() === k || (a.id || "").toLowerCase() === k);
  };
  for (const c of cells) {
    const id = String(c?.panelId ?? "").trim();
    if (!id) { skipped.push("an empty cell"); continue; }
    if (id.toLowerCase() === LAYOUT_AGENT_CELL) { keep.push({ kind: "agent" }); continue; }
    // A loop's own cell (agent:<cli>) is an agent cell too; it opens as the chat where there is no terminal for it.
    if (/^agent:/i.test(id)) { keep.push({ kind: "agent" }); continue; }
    if (id.startsWith("tool:")) {
      // a saved cell may name a view by its older alias (the open does the same)
      const raw = id.slice(5);
      const view = raw === "editor" ? "monaco" : raw === "browser" ? "preview" : raw;
      if (!view) { skipped.push("an unnamed panel"); continue; }
      if (surfaceHostsView(view, caps)) keep.push({ kind: "tool", view });
      else skipped.push(`the ${view} panel (needs a streamed panel)`);
      continue;
    }
    const row = rowOf(id);
    const name = row?.name || row?.slug || id;
    if (!row) { skipped.push(`the app "${id}" (not in your library)`); continue; }
    if (row.kind === "native") {
      if (caps.nativeWindows) keep.push({ kind: "app", slug: row.slug || id, name });
      else skipped.push(`the app "${name}" (needs a native window)`);
      continue;
    }
    if (row.kind === "web") {
      if (caps.streamedPanels) keep.push({ kind: "app", slug: row.slug || id, name });
      else skipped.push(`the tab "${name}" (an embedded page needs a streamed panel)`);
      continue;
    }
    keep.push({ kind: "app", slug: row.slug || id, name });
  }
  return { keep, skipped };
}

/** The toasts after a workspace opens: nothing kept → one error line;
 *  something skipped → one line listing what. Both null = quiet. */
export function workspaceOpenLines(name: string, plan: LayoutPlan): { error: string | null; info: string | null } {
  const error = plan.keep.length ? null : `Nothing in "${name}" opens here`;
  const info = plan.skipped.length && plan.keep.length ? `Skipped here: ${plan.skipped.join(", ")}` : null;
  return { error, info };
}

/** OPEN WORKSPACE CLOSES ITS HOST FIRST (his order, 2026-10-05: "workspace
 *  -> edit -> open workspace -> close the customize or settings menu and open
 *  the workspace"): what the Workspaces page's Open button closes before the
 *  workspace opens — on the web the full-screen Customize panel; on the
 *  desktop the Settings modal or the Customize work panel, whichever hosts
 *  the page. */
export type WorkspaceOpenHost = "web-full-panel" | "settings-modal" | "customize-panel";
export function workspaceOpenClosesHosts(web: boolean): ReadonlyArray<WorkspaceOpenHost> {
  // Customize is a full-screen page on BOTH surfaces now (his order,
  // 2026-10-07), so the full-screen host closes on both; the desktop
  // still closes its Settings modal and the older Customize work panel too
  // (his report, 2026-10-07: opening a workspace from Customize left panels up).
  return web ? Object.freeze(["web-full-panel"] as WorkspaceOpenHost[]) : Object.freeze(["web-full-panel", "settings-modal", "customize-panel"] as WorkspaceOpenHost[]);
}
