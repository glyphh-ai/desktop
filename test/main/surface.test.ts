/**
 * surface.test.ts — ONE LIST FOR EVERYTHING; the web cut collapsed into
 * capability checks (src/renderer/help/surface.ts + web-surface.ts's
 * DESKTOP_ONLY_SUBS; his order, 2026-10-06: "Cloud is first and every
 * surface pulls from it"). The capability model, the one rule for the wall
 * and the dock, the one rule per workspace cell, the boot surfaces, the tool
 * views, and his explicit orders about the web's page that are not world
 * splits.
 */
import { describe, it, expect } from "vitest";
import {
  surfaceCaps, DESKTOP_CAPS, BROWSER_CAPS, surfaceHostsView, surfaceHostsTile, STREAMED_VIEWS,
  surfaceLayoutCells, workspaceOpenLines, LAYOUT_AGENT_CELL, type LayoutApp,
  WEB_BUILD_SUBS, WEB_CUSTOMIZE_SUBS, WEB_KEPT_SUBS, WEB_HIDDEN_NAV_GROUPS, WEB_HIDDEN_RAIL, WEB_HIDDEN_SETTINGS_ROWS, WEB_RAIL_LINKS,
  DESKTOP_TOOL_VIEWS, toolViewsHosted, WEB_TOOL_VIEWS, webToolAllowed, webToolReachable, WEB_UNREACHABLE_VIEWS,
  agentCardMovable, webNewSessionInPlace,
  webFullScreenPanels, webPanelOpensFullScreen, panelOpensFullScreen, GROUP_PAGES, groupOfSub, webFullScreenTitle, WEB_FULL_SCREEN_TITLES, WEB_GROUP_ROWS, WEB_CUT_ROW_CLASS, webGroupPanelKept, webNewClosesEverything, 
  WEB_RAIL_WORDMARK, webRailWordmark, webCloseAllOpensNew,
  workspaceOpenClosesHosts,
  CUSTOMIZE_TAB_ORDER, GROUP_PAGE_ALIASES, groupPageKey } from "../../src/renderer/help/surface.js";
import { DESKTOP_ONLY_SUBS } from "../../src/renderer/help/web-surface.js";

describe("THE CAPABILITY MODEL (his order, 2026-10-06: one list, capability checks, never two worlds)", () => {
  it("the desktop hosts everything; a browser has no native window and no streamed panel", () => {
    expect(surfaceCaps(false)).toEqual({ nativeWindows: true, streamedPanels: true });
    expect(surfaceCaps(true)).toEqual({ nativeWindows: false, streamedPanels: false });
    expect(surfaceCaps(false)).toBe(DESKTOP_CAPS);
    expect(surfaceCaps(true)).toBe(BROWSER_CAPS);
    expect(Object.isFrozen(DESKTOP_CAPS)).toBe(true);
    expect(Object.isFrozen(BROWSER_CAPS)).toBe(true);
  });
  it("the Browser is the one streamed view; every in-document panel is hosted everywhere", () => {
    expect([...STREAMED_VIEWS]).toEqual(["preview"]);
    expect(surfaceHostsView("preview", DESKTOP_CAPS)).toBe(true);
    expect(surfaceHostsView("preview", BROWSER_CAPS)).toBe(false);
    for (const v of ["files", "terminal", "monaco", "diff", "plan", "artifacts", "gdesign", "gpoint", "gimage", "gvideo", "gsound", "gdrive"]) {
      expect(surfaceHostsView(v, DESKTOP_CAPS)).toBe(true);
      expect(surfaceHostsView(v, BROWSER_CAPS)).toBe(true);
    }
  });
});

describe("THE WALL AND THE DOCK ARE ONE (surfaceHostsTile)", () => {
  // The tiles as code-workbench's appTileOf / navTileFor build them: a URL
  // tab (archetype "web"), a native app, a Glyphh bundle with an execPath, a
  // cloud instance (`cloud`), a house built-in (`houseDefault`), a nav row.
  const tiles = {
    layout: { kind: "layout" as const },
    folder: { kind: "folder" as const },
    agent: { kind: "agent" as const },
    cli: { kind: "tool" as const, toolView: "terminal", cliAgent: { id: "claude" } },
    urlTab: { kind: "app" as const, archetype: "web" },
    native: { kind: "app" as const, archetype: "native" },
    nativeNav: { kind: "app" as const, navApp: { archetype: "native", execPath: "/Applications/Notes.app" } },
    bundle: { kind: "app" as const, archetype: "glyphh-app" },
    cloudInstance: { kind: "app" as const, archetype: "glyphh-app", cloud: true },
    houseBuiltIn: { kind: "app" as const, houseDefault: true },
    houseTool: { kind: "tool" as const, toolView: "gdesign" },
    navRow: { kind: "app" as const, archetype: "glyphh-nav" },
    navSlot: { kind: "app" as const, navApp: { archetype: "glyphh-nav" } },
    browser: { kind: "tool" as const, toolView: "preview" },
    files: { kind: "tool" as const, toolView: "files" },
  };
  const navKeys = ["glyphh", "newtab", "settings", "cc", "closeall", "agent:claude"];
  it("the desktop keeps everything", () => {
    for (const t of Object.values(tiles)) expect(surfaceHostsTile(t, DESKTOP_CAPS)).toBe(true);
    for (const k of navKeys) expect(surfaceHostsTile({ kind: "tool", navKey: k }, DESKTOP_CAPS)).toBe(true);
  });
  it("a browser keeps every layout, the agent, every CLI, every dock control, every hosted view — and of the APP tiles only a cloud instance, a house built-in and a nav row", () => {
    for (const t of [tiles.layout, tiles.folder, tiles.agent, tiles.cli, tiles.cloudInstance, tiles.houseBuiltIn, tiles.houseTool, tiles.navRow, tiles.navSlot, tiles.files]) {
      expect(surfaceHostsTile(t, BROWSER_CAPS)).toBe(true);
    }
    for (const k of navKeys) expect(surfaceHostsTile({ kind: "tool", navKey: k }, BROWSER_CAPS)).toBe(true);
    expect(surfaceHostsTile({ kind: "app", navKey: "settings" }, BROWSER_CAPS)).toBe(true);
  });
  it("a browser drops every saved TAB row (his report, 2026-10-06): a URL tab, a native app, a bundle — and the streamed Browser", () => {
    expect(surfaceHostsTile(tiles.urlTab, BROWSER_CAPS)).toBe(false);
    expect(surfaceHostsTile({ kind: "app", archetype: "web", isBrowser: true, url: "https://mail.google.com" } as never, BROWSER_CAPS)).toBe(false);
    expect(surfaceHostsTile(tiles.native, BROWSER_CAPS)).toBe(false);
    expect(surfaceHostsTile(tiles.nativeNav, BROWSER_CAPS)).toBe(false);
    expect(surfaceHostsTile(tiles.bundle, BROWSER_CAPS)).toBe(false);
    expect(surfaceHostsTile({ kind: "app" }, BROWSER_CAPS)).toBe(false);
    expect(surfaceHostsTile(tiles.browser, BROWSER_CAPS)).toBe(false);
    // a tool tile with no view and no slot names nothing to host
    expect(surfaceHostsTile({ kind: "tool" }, BROWSER_CAPS)).toBe(false);
    expect(surfaceHostsTile({ kind: "tool" }, DESKTOP_CAPS)).toBe(false);
  });
  it("one function, both surfaces: the two answers differ only on the tab rows (URL tab, native, bundle) and the Browser", () => {
    const differ = Object.entries(tiles).filter(([, t]) => surfaceHostsTile(t, DESKTOP_CAPS) !== surfaceHostsTile(t, BROWSER_CAPS)).map(([k]) => k);
    expect(differ.sort()).toEqual(["browser", "bundle", "native", "nativeNav", "urlTab"]);
  });
});

describe("WORKSPACE CELLS: the same capability rule per cell (surfaceLayoutCells)", () => {
  const apps: LayoutApp[] = [
    { slug: "crm", id: "crm", name: "CRM", kind: "glyphh" },
    { slug: "slides", id: "slides", name: "Slides", kind: "glyphh" },
    { slug: "gmail", id: "gmail", name: "Gmail", kind: "web" },
    { slug: "notes", id: "notes", name: "Notes", kind: "native" },
  ];
  const cell = (panelId: string) => ({ panelId });
  it("with desktop caps nothing is skipped but an unknown id and an empty cell", () => {
    const plan = surfaceLayoutCells([cell("tool:files"), cell("tool:preview"), cell("tool:artifacts"), cell("CRM"), cell("gmail"), cell("notes"), cell("tool:coding"), cell("ghost"), cell("")], apps, DESKTOP_CAPS);
    expect(plan.keep).toEqual([
      { kind: "tool", view: "files" }, { kind: "tool", view: "preview" }, { kind: "tool", view: "artifacts" },
      { kind: "app", slug: "crm", name: "CRM" }, { kind: "app", slug: "gmail", name: "Gmail" }, { kind: "app", slug: "notes", name: "Notes" },
      { kind: "agent" },
    ]);
    expect(plan.skipped).toEqual(['the app "ghost" (not in your library)', "an empty cell"]);
  });
  it("with browser caps the Browser, an embedded URL tab and a native app are skipped, each named by the capability it needs; the rest opens", () => {
    const plan = surfaceLayoutCells([cell("tool:files"), cell("tool:terminal"), cell("tool:preview"), cell("tool:artifacts"), cell("CRM"), cell("gmail"), cell("notes"), cell("tool:coding")], apps, BROWSER_CAPS);
    expect(plan.keep).toEqual([
      { kind: "tool", view: "files" }, { kind: "tool", view: "terminal" }, { kind: "tool", view: "artifacts" },
      { kind: "app", slug: "crm", name: "CRM" }, { kind: "agent" },
    ]);
    expect(plan.skipped).toEqual([
      "the preview panel (needs a streamed panel)",
      'the tab "Gmail" (an embedded page needs a streamed panel)',
      'the app "Notes" (needs a native window)',
    ]);
  });
  it("a loop's own cell (agent:<cli>) is an agent cell on every surface, never an app missing from the library", () => {
    for (const caps of [DESKTOP_CAPS, BROWSER_CAPS]) {
      const plan = surfaceLayoutCells([cell("agent:codex"), cell("AGENT:claude")], [], caps);
      expect(plan.keep).toEqual([{ kind: "agent" }, { kind: "agent" }]);
      expect(plan.skipped).toEqual([]);
    }
  });
  it("a saved cell may name a view by its older alias; an unnamed tool cell is named", () => {
    expect(surfaceLayoutCells([cell("tool:editor")], [], BROWSER_CAPS).keep).toEqual([{ kind: "tool", view: "monaco" }]);
    expect(surfaceLayoutCells([cell("tool:browser")], [], BROWSER_CAPS).skipped[0]).toContain("preview");
    expect(surfaceLayoutCells([cell("tool:browser")], [], DESKTOP_CAPS).keep).toEqual([{ kind: "tool", view: "preview" }]);
    expect(surfaceLayoutCells([cell("tool:")], [], DESKTOP_CAPS).skipped).toEqual(["an unnamed panel"]);
  });
  it("the agent's own cell is kept on both; an app matches by slug or id, any case", () => {
    expect(LAYOUT_AGENT_CELL).toBe("tool:coding");
    for (const caps of [DESKTOP_CAPS, BROWSER_CAPS]) {
      expect(surfaceLayoutCells([cell("TOOL:CODING"), cell("Slides")], apps, caps).keep).toEqual([{ kind: "agent" }, { kind: "app", slug: "slides", name: "Slides" }]);
    }
  });
  it("empty and malformed cells are named, never thrown on", () => {
    expect(surfaceLayoutCells([cell(""), cell("   "), { panelId: undefined as never }], apps, BROWSER_CAPS).skipped).toEqual(["an empty cell", "an empty cell", "an empty cell"]);
    expect(surfaceLayoutCells([], [], DESKTOP_CAPS)).toEqual({ keep: [], skipped: [] });
  });
  it("the toasts: nothing kept → one error line; something skipped → one line listing it; all kept → quiet", () => {
    expect(workspaceOpenLines("Dev", { keep: [], skipped: ['the app "Notes" (needs a native window)'] }))
      .toEqual({ error: 'Nothing in "Dev" opens here', info: null });
    expect(workspaceOpenLines("Dev", { keep: [{ kind: "tool", view: "files" }], skipped: ["a", "b"] }))
      .toEqual({ error: null, info: "Skipped here: a, b" });
    expect(workspaceOpenLines("Dev", { keep: [{ kind: "tool", view: "files" }], skipped: [] })).toEqual({ error: null, info: null });
  });
});

describe("the tool views — one list through the caps", () => {
  it("the desktop's list is the one list; the browser's is the same minus the streamed Browser", () => {
    expect([...DESKTOP_TOOL_VIEWS]).toEqual(["files", "terminal", "monaco", "preview", "diff", "plan"]);
    expect([...toolViewsHosted(DESKTOP_CAPS)]).toEqual([...DESKTOP_TOOL_VIEWS]);
    expect([...WEB_TOOL_VIEWS]).toEqual(["files", "terminal", "monaco", "diff", "plan"]);
    expect([...toolViewsHosted(BROWSER_CAPS)]).toEqual([...WEB_TOOL_VIEWS]);
    expect(webToolAllowed("preview")).toBe(false);
    expect(webToolAllowed("files")).toBe(true);
  });
  it("the workbench door refuses the streamed Browser from every caller on the web — a capability, not a world", () => {
    expect([...WEB_UNREACHABLE_VIEWS]).toEqual(["preview"]);
    expect(webToolReachable("preview")).toBe(false);
    for (const v of WEB_TOOL_VIEWS) expect(webToolReachable(v)).toBe(true);
  });
});

describe("settings — the one Customize page is the same on both surfaces; only capability rows hide", () => {
  it("the library half: Skills, Agents, Apps, Tasks, plugins (Connections beside them)", () => {
    expect([...WEB_BUILD_SUBS]).toEqual(["skills", "agents", "apps", "tasks", "plugins"]);
    expect(WEB_BUILD_SUBS).not.toContain("connections-cfg");
  });
  it("the shape half: Tabs, Workspaces, Drips, Schedules", () => {
    expect([...WEB_CUSTOMIZE_SUBS]).toEqual([]);
  });
  it("ONE page's tab order (his report, 2026-10-07): Skills, Agents, Apps, Connections, Plugins, Tabs, Workspaces, Drips, Schedules — Tasks last, a hidden row", () => {
    expect([...CUSTOMIZE_TAB_ORDER]).toEqual(["skills", "agents", "apps", "connections-cfg", "plugins", "tasks"]);
    expect([...CUSTOMIZE_TAB_ORDER].sort()).toEqual([...WEB_GROUP_ROWS].sort());   // every row of the page, once
    expect(Object.isFrozen(CUSTOMIZE_TAB_ORDER)).toBe(true);
  });
  it("every Customize tab is a group row on both surfaces — panel mounted, never `.hidden`", () => {
    expect([...WEB_GROUP_ROWS]).toEqual([...WEB_BUILD_SUBS, "connections-cfg", ...WEB_CUSTOMIZE_SUBS]);
    for (const sub of WEB_GROUP_ROWS) expect(webGroupPanelKept(sub)).toBe(true);
    for (const sub of ["remote", "mcp", "general", "artifacts"]) expect(webGroupPanelKept(sub)).toBe(false);
    expect(WEB_CUT_ROW_CLASS).toBe("web-cut-row");
    expect(WEB_CUT_ROW_CLASS).not.toBe("hidden");
  });
  it("DESKTOP_ONLY_SUBS carries the group rows (CSS-hidden in the modal's nav only) plus the desktop's capability pages: plugins, the local MCP server", () => {
    for (const sub of [...WEB_BUILD_SUBS, ...WEB_CUSTOMIZE_SUBS, "plugins", "mcp", "loops"]) expect(DESKTOP_ONLY_SUBS.has(sub)).toBe(true);
  });
  it("what the modal keeps is never also hidden", () => {
    for (const sub of WEB_KEPT_SUBS) expect(DESKTOP_ONLY_SUBS.has(sub)).toBe(false);
    for (const sub of ["general", "appearance", "memory", "artifacts", "billing", "connections-cfg"]) {
      expect(WEB_KEPT_SUBS).toContain(sub);
    }
    expect(WEB_KEPT_SUBS).not.toContain("mcp");
  });
  it("the rail's menu is Artifacts, Customize, Schedules (his orders, 2026-10-05, 2026-10-07, 2026-10-09)", () => {
    expect(WEB_RAIL_LINKS.map((l) => l.label)).toEqual(["Artifacts", "Customize", "Schedules"]);
    expect(WEB_RAIL_LINKS.map((l) => l.sub)).toEqual(["artifacts", "customize", "schedules"]);
    expect(WEB_RAIL_LINKS.map((l) => l.sub)).not.toContain("build");
    for (const sub of ["connections-cfg"]) {
      expect(WEB_RAIL_LINKS.map((l) => l.sub)).not.toContain(sub);
      expect(WEB_KEPT_SUBS).toContain(sub);   // still a Settings page
    }
  });
  it("the hidden settings rows are ONLY a capability the browser lacks (streamed panels); the dock's rows show; the rail hides only More", () => {
    expect([...WEB_HIDDEN_SETTINGS_ROWS]).toEqual(["#streamed-panels-row", "#rail-layouts-row", "#agent-defaults-head", "#default-loop-row", "#default-view-row", "#cli-gateway-row"]);
    expect([...WEB_HIDDEN_NAV_GROUPS]).toEqual(["nav-group-customize"]);
    expect([...WEB_HIDDEN_RAIL]).toEqual(["#rail-more-toggle", "#rail-layouts-vsplit", "#rail-layouts-head", "#rail-layouts-body"]);
    expect(WEB_HIDDEN_RAIL).not.toContain(WEB_RAIL_WORDMARK);
  });
});

describe("THE WEB'S FULL-SCREEN PANELS (his order, 2026-10-05: Artifacts / Customize open full, replacing everything; X restores)", () => {
  it("exactly the rail's two open full screen on the web", () => {
    expect([...webFullScreenPanels]).toEqual(["artifacts", "customize", "schedules"]);
    expect(webFullScreenPanels.map((k) => k)).toEqual(WEB_RAIL_LINKS.map((l) => l.sub));
    for (const k of webFullScreenPanels) expect(webPanelOpensFullScreen(k)).toBe(true);
  });
  it("no other panel takes that path — Files, Agents, Settings, an app", () => {
    for (const k of ["files", "agents", "terminal", "settings", "gmail", "", "preview"]) expect(webPanelOpensFullScreen(k)).toBe(false);
  });
  it("the desktop opens Customize full screen too; Artifacts stays a work panel there (his order, 2026-10-07)", () => {
    expect([...GROUP_PAGES]).toEqual(["customize"]);
    // Full screen on BOTH surfaces, Customize and Artifacts alike (his order, 2026-10-09).
    for (const k of GROUP_PAGES) { expect(panelOpensFullScreen(k, false)).toBe(true); expect(panelOpensFullScreen(k, true)).toBe(true); }
    expect(panelOpensFullScreen("artifacts", false)).toBe(true);
    expect(panelOpensFullScreen("artifacts", true)).toBe(true);
    for (const k of ["files", "agents", "settings", "gmail", ""]) { expect(panelOpensFullScreen(k, false)).toBe(false); expect(panelOpensFullScreen(k, true)).toBe(false); }
  });
  it("every Customize settings row names the one page; a plain settings page names none", () => {
    for (const sub of [...WEB_BUILD_SUBS, "connections-cfg", ...WEB_CUSTOMIZE_SUBS]) expect(groupOfSub(sub)).toBe("customize");
    for (const sub of ["general", "appearance", "memory", "devices", "mcp", "remote", "artifacts", "usage", ""]) expect(groupOfSub(sub)).toBeNull();
  });
  it("a dead page key resolves to the one page: 'build' opens Customize; a live key is itself (his report, 2026-10-07)", () => {
    expect(GROUP_PAGE_ALIASES).toEqual({ build: "customize" });
    expect(groupPageKey("build")).toBe("customize");
    for (const k of ["customize", "artifacts", "apps", "layouts", ""]) expect(groupPageKey(k)).toBe(k);
    expect(panelOpensFullScreen(groupPageKey("build"), true)).toBe(true);   // the web's full screen, through the alias
    expect(panelOpensFullScreen("build", true)).toBe(false);   // only through the alias
  });
  it("the header reads '‹ Artifacts' / '‹ Customize'; a dead key gets no title of its own", () => {
    expect(webFullScreenTitle("artifacts")).toBe("Artifacts");
    expect(webFullScreenTitle("customize")).toBe("Customize");
    expect(webFullScreenTitle(groupPageKey("build"))).toBe("Customize");
    expect(Object.keys(WEB_FULL_SCREEN_TITLES).sort()).toEqual([...webFullScreenPanels].sort());
    expect(webFullScreenTitle("wat")).toBe("wat");
  });
  it("the lists are frozen", () => {
    expect(Object.isFrozen(webFullScreenPanels)).toBe(true);
    expect(Object.isFrozen(WEB_RAIL_LINKS)).toBe(true);
  });
});

describe("his explicit orders about the web's page — not world splits", () => {
  it("+ New on the web closes everything first; the desktop keeps its panels (his order, 2026-10-05)", () => {
    expect(webNewClosesEverything(true)).toBe(true);
    expect(webNewClosesEverything(false)).toBe(false);
  });
  it("the rail header's order is the desktop's on both; the wordmark holds the chrome spot on the web only", () => {
    expect(WEB_RAIL_WORDMARK).toBe(".app-rail-logo");
    expect(webRailWordmark(true)).toBe(true);
    expect(webRailWordmark(false)).toBe(false);
  });
  it("the panels move on the web — the agent too (his review, 2026-10-05); the desktop keeps its rule", () => {
    expect(agentCardMovable(true)).toBe(true);
    expect(agentCardMovable(false)).toBe(false);
  });
  it("+ New with the web's one agent seated starts the new session IN it (his report, 2026-10-05)", () => {
    expect(webNewSessionInPlace(true, true)).toBe(true);
    expect(webNewSessionInPlace(true, false)).toBe(false);
    expect(webNewSessionInPlace(false, true)).toBe(false);
    expect(webNewSessionInPlace(false, false)).toBe(false);
  });
  it("Close all on the web opens a fresh session; the desktop only closes (his order, 2026-10-05)", () => {
    expect(webCloseAllOpensNew(true)).toBe(true);
    expect(webCloseAllOpensNew(false)).toBe(false);
  });
  it("Open workspace closes its host first: the web's full-screen Customize; the desktop's Settings modal or Customize panel", () => {
    expect([...workspaceOpenClosesHosts(true)]).toEqual(["web-full-panel"]);
    // the desktop's Build / Customize are full-screen pages too (2026-10-07): that host closes on both
    expect([...workspaceOpenClosesHosts(false)]).toEqual(["web-full-panel", "settings-modal", "customize-panel"]);
    expect(Object.isFrozen(workspaceOpenClosesHosts(true))).toBe(true);
  });
});
