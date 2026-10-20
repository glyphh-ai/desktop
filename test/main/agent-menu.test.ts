/**
 * agent-menu.test.ts — the agent window's ONE ⋮ menu, as data
 * (src/renderer/help/agent-menu.ts; his orders, 2026-10-05, and 2026-10-06:
 * ONE MENU ON BOTH SURFACES — one frozen list; Apps = the installed apps (the
 * cloud instances, the one list); Agents / CLIs on both surfaces, a CLI
 * opening on the session's folder, the rows saying so when a desktop path has
 * no desktop; Workspaces = the one list; the Browser row only where a
 * streamed panel can be). Apps, Agents / CLIs and Workspaces are expandable
 * sections, COLLAPSED on every open. The Session section exists only for an
 * open session, and no section is ever empty.
 */
import { describe, it, expect } from "vitest";
import {
  agentMenuModel, appRowOpen, toolViewsFor, toolRowsFor, sessionRowsFor, glyphhAppsOnly, sectionHeadLabel,
  menuFoldState, toggleFold, isExpanded,
  CONNECT_DESKTOP_LINK, APPS_SECTION_LABEL, TOOLS_SECTION_LABEL, SESSION_SECTION_LABEL,
  CODE_TOOL_VIEWS, MENU_SECTION_ORDER, COLLAPSIBLE_SECTIONS, GLYPHH_APP_KIND,
  WORKSPACES_SECTION_LABEL, workspaceRows,
  type MenuAppRow, type MenuSection, menuLocusOf } from "../../src/renderer/help/agent-menu.js";
import { WEB_TOOL_VIEWS, DESKTOP_TOOL_VIEWS } from "../../src/renderer/help/surface.js";

const MAC = { id: "m1", name: "Chris's MacBook" };
/** Rows of every kind, as the one list may hold them (the installed list — glyphhAppsOnly keeps the Glyphh apps). */
const apps: MenuAppRow[] = [
  { slug: "gmail", name: "Gmail", kind: "web", icon: "/webicon?u=x", machineId: "m1", machineName: MAC.name },
  { slug: "slides", name: "Slides", kind: "glyphh", icon: "data:image/png;base64,AAAA", machineId: "m1", machineName: MAC.name },
  { slug: "linear", name: "Linear", kind: "web", icon: null, machineId: "m1", machineName: MAC.name },
  { slug: "notes", name: "Notes", kind: "native", icon: null, machineId: "m1", machineName: MAC.name },
  { slug: "crm", name: "CRM", kind: "glyphh", icon: null, machineId: "m1", machineName: MAC.name },
];
const cloudApp: MenuAppRow = { slug: "crm", name: "CRM", kind: "glyphh", machineId: "", machineName: "the cloud", cloud: true };
const SPACES = [{ name: "Dev" }, { name: "Writing" }];
const section = <K extends MenuSection["kind"]>(m: { sections: MenuSection[] }, kind: K): Extract<MenuSection, { kind: K }> | undefined =>
  m.sections.find((s): s is Extract<MenuSection, { kind: K }> => s.kind === kind);
const kinds = (m: { sections: MenuSection[] }): string[] => m.sections.map((s) => s.kind);

describe("ONE MENU ON BOTH SURFACES (his order, 2026-10-06) — one frozen list", () => {
  it("the one list: Panels, Session, Apps, Workspaces — frozen", () => {
    expect([...MENU_SECTION_ORDER]).toEqual(["tools", "session", "apps", "workspaces"]);
    expect(Object.isFrozen(MENU_SECTION_ORDER)).toBe(true);
  });
  it("a full menu on each surface paints in exactly that order, the same labels", () => {
    for (const surface of ["web", "desktop"] as const) {
      const m = agentMenuModel({ surface, session: { pinned: false }, machines: [MAC], installed: [cloudApp], locus: "local", workspaces: SPACES });
      expect(kinds(m)).toEqual([...MENU_SECTION_ORDER]);
      expect(m.sections.map((s) => s.label)).toEqual([TOOLS_SECTION_LABEL, SESSION_SECTION_LABEL, APPS_SECTION_LABEL, WORKSPACES_SECTION_LABEL]);
    }
  });
  it("the rows are identical on both surfaces but for the Browser — a streamed panel the browser does not reach", () => {
    const desk = agentMenuModel({ surface: "desktop", session: { pinned: false }, installed: [cloudApp], workspaces: SPACES });
    const web = agentMenuModel({ surface: "web", session: { pinned: false }, installed: [cloudApp], workspaces: SPACES });
    const labels = (m: { sections: MenuSection[] }): string[] => m.sections.flatMap((s) => s.rows.map((r) => ("label" in r ? r.label : "name" in r ? r.name : "")));
    expect(labels(desk)).toEqual(["Files", "Terminal", "Editor", "Browser", "Diff", "Plan", "Artifacts", "Rename", "Pin", "New agent panel", "Delete", "CRM", "Dev", "Writing"]);
    expect(labels(web)).toEqual(labels(desk).filter((l) => l !== "Browser"));
  });
});

describe("EXPANDABLE SECTIONS, COLLAPSED ON OPEN (his review, 2026-10-05)", () => {
  it("Apps and Workspaces are the collapsible ones, with a count on the head", () => {
    expect([...COLLAPSIBLE_SECTIONS]).toEqual(["apps", "workspaces"]);
    const m = agentMenuModel({ surface: "web", session: null, machines: [MAC], installed: apps, locus: "local" });
    const a = section(m, "apps")!;
    expect(a.collapsible).toBe(true);
    expect(a.count).toBe(2);
    expect(sectionHeadLabel(a.label, a.count)).toBe("Apps · 2");
    expect(section(m, "tools")).not.toHaveProperty("collapsible");
  });
  it("a fresh open expands nothing; a toggle opens one fold and a second closes it", () => {
    const folds = menuFoldState();
    for (const k of ["apps", "workspaces"]) expect(isExpanded(folds, k)).toBe(false);
    expect(toggleFold(folds, "apps")).toBe(true);
    expect(isExpanded(folds, "apps")).toBe(true);
    expect(toggleFold(folds, "apps")).toBe(false);
    expect(isExpanded(folds, "apps")).toBe(false);
  });
});

describe("APPS = THE INSTALLED GLYPHH APPS, THE ONE LIST (his orders, 2026-10-05 / 06)", () => {
  it("the filter keeps kind \"glyphh\" rows only: URL tabs, native apps and unkinded rows drop", () => {
    expect(GLYPHH_APP_KIND).toBe("glyphh");
    expect(glyphhAppsOnly(apps).map((r) => r.slug)).toEqual(["slides", "crm"]);
    expect(glyphhAppsOnly([{ slug: "x", name: "X", machineId: "m1", machineName: "" }])).toEqual([]);
    expect(glyphhAppsOnly([{ slug: "x", name: "X", kind: "glyphh-app", machineId: "m1", machineName: "" }])).toEqual([]);
  });
  it("the cloud instances list on both surfaces, enabled, no note, no link — with or without a desktop", () => {
    for (const surface of ["web", "desktop"] as const) for (const machines of [[], [MAC]]) {
      const m = agentMenuModel({ surface, session: null, machines, installed: [cloudApp] });
      const a = section(m, "apps")!;
      expect(a.enabled).toBe(true);
      expect(a.rows.map((r) => r.slug)).toEqual(["crm"]);
      expect(a.rows[0]!.cloud).toBe(true);
      expect(a.count).toBe(1);
      expect(a.note).toBeNull();
      expect(a.link).toBeNull();
    }
  });
  it("the installed list is the ONE list: an attached desktop adds nothing to it (his order, 2026-10-06)", () => {
    const m = agentMenuModel({ surface: "web", session: null, machines: [MAC], installed: [cloudApp, { ...cloudApp, slug: "slides", name: "Slides" }] });
    const a = section(m, "apps")!;
    expect(a.rows.map((r) => r.slug)).toEqual(["crm", "slides"]);
    expect(a.rows.every((r) => r.cloud)).toBe(true);
    const none = agentMenuModel({ surface: "web", session: null, machines: [MAC] });
    expect(section(none, "apps")!.rows).toEqual([]);
  });
  it("with nothing installed anywhere the fold says 'Apps · 0' — no line under it (his order, 2026-10-05)", () => {
    for (const surface of ["web", "desktop"] as const) {
      const a = section(agentMenuModel({ surface, session: null, machines: [], installed: [] }), "apps")!;
      expect(a.enabled).toBe(true);
      expect(a.rows).toEqual([]);
      expect(a.count).toBe(0);
      expect(a.note).toBeNull();
      expect(a.link).toBeNull();
    }
  });
  it("one row per slug; a row without a slug is dropped; the first machine is the menu's", () => {
    const mm = agentMenuModel({
      surface: "web", session: null,
      machines: [MAC, { id: "m2", name: "Other" }],
      installed: [...apps, { slug: "Slides", name: "Slides", kind: "glyphh", machineId: "", machineName: "the cloud", cloud: true }, { slug: "", name: "ghost", kind: "glyphh", machineId: "", machineName: "" }],
    });
    expect(section(mm, "apps")!.rows.map((r) => r.slug)).toEqual(["slides", "crm"]);
    expect(mm.machine).toEqual(MAC);
  });
});


describe("WHERE AN APPS ROW OPENS — the same rule on both surfaces", () => {
  const house = { slug: "design", name: "Design", kind: "glyphh", tool: "gdesign" };
  const bundle = { slug: "crm", name: "CRM", kind: "glyphh" };
  it("a house row — a Glyphh app whose tool names a house panel — opens that panel, on both surfaces", () => {
    for (const surface of ["web", "desktop"] as const) {
      expect(appRowOpen(house, surface)).toEqual({ open: "house-panel", view: "gdesign" });
      for (const [tool, view] of [["gpoint", "gpoint"], ["gimage", "gimage"], ["gvideo", "gvideo"], ["gsound", "gsound"], ["gdrive", "gdrive"]]) {
        expect(appRowOpen({ kind: "glyphh", tool }, surface)).toEqual({ open: "house-panel", view });
      }
    }
  });
  it("every other installed app opens as a panel on THIS surface — nothing opens on a desktop from the web (his order, 2026-10-06)", () => {
    expect(appRowOpen(cloudApp, "web")).toEqual({ open: "panel" });
    expect(appRowOpen(cloudApp, "desktop")).toEqual({ open: "panel" });
    expect(appRowOpen(bundle, "desktop")).toEqual({ open: "panel" });
    expect(appRowOpen(bundle, "web")).toEqual({ open: "panel" });
    expect(appRowOpen({ ...bundle, tool: null }, "web")).toEqual({ open: "panel" });
    // A tool that is not a house panel (the streamed Browser) is not a house row either.
    expect(appRowOpen({ kind: "glyphh", tool: "preview" }, "web")).toEqual({ open: "panel" });
  });
  it("only a Glyphh app counts as a house row — a URL tab or native app with a tool field is not", () => {
    expect(appRowOpen({ kind: "web", tool: "gdesign" }, "web")).toEqual({ open: "panel" });
    expect(appRowOpen({ kind: "native", tool: "gdesign" }, "web")).toEqual({ open: "panel" });
  });
  it("the model carries the row's tool through to the painter", () => {
    const m = agentMenuModel({ surface: "web", session: null, machines: [MAC], installed: [{ ...house, machineId: "", machineName: "the cloud", cloud: true }, ...apps] });
    const rows = section(m, "apps")!.rows;
    expect(rows.find((r) => r.slug === "design")?.tool).toBe("gdesign");
    expect(rows.find((r) => r.slug === "crm")?.tool).toBeUndefined();
  });
  it("the locus reads off a session source", () => {
    expect(menuLocusOf({ kind: "local" })).toBe("local");
    expect(menuLocusOf({ kind: "cloud-repo" })).toBe("cloud");
    expect(menuLocusOf(null)).toBe("cloud");
  });
});

describe("the session's type decides the panels — one list through the caps", () => {
  it("Code: the one Developer-tools list, Browser included on the desktop, then Artifacts", () => {
    expect([...CODE_TOOL_VIEWS]).toEqual([...DESKTOP_TOOL_VIEWS, "artifacts"]);
    expect([...toolViewsFor("desktop")]).toEqual([...CODE_TOOL_VIEWS]);
    expect([...toolViewsFor("web")]).toEqual([...WEB_TOOL_VIEWS, "artifacts"]);
    expect(toolRowsFor("desktop").map((t) => t.label)).toEqual(["Files", "Terminal", "Editor", "Browser", "Diff", "Plan", "Artifacts"]);
  });
  it("⋮ Panels lists Artifacts on both surfaces and for both types, last (his order, 2026-10-05)", () => {
    for (const surface of ["web", "desktop"] as const) for (const mode of ["work", "code"] as const) {
      const views = toolViewsFor(surface, mode);
      expect(views[views.length - 1]).toBe("artifacts");
      expect(toolRowsFor(surface, mode).map((t) => t.label).pop()).toBe("Artifacts");
    }
  });
  it("a fresh landing has no Session section; an open session has Rename / Pin / New agent panel / Delete", () => {
    expect(sessionRowsFor(null)).toEqual([]);
    expect(sessionRowsFor({ pinned: false }).map((r) => `${r.action}:${r.label}${r.danger ? "!" : ""}`))
      .toEqual(["rename:Rename", "pin:Pin", "new-panel:New agent panel", "delete:Delete!"]);
    expect(sessionRowsFor({ pinned: true })[1]!.label).toBe("Unpin");
    const fresh = agentMenuModel({ surface: "desktop", session: null });
    expect(kinds(fresh)).toEqual(["tools", "apps", "workspaces"]);
  });
  it("never an empty dropdown, never an empty section — every combination", () => {
    for (const surface of ["web", "desktop"] as const) {
      for (const mode of ["work", "code"] as const) {
        for (const session of [null, { pinned: false }]) {
          for (const machines of [[], [MAC]]) {
            for (const locus of ["local", "cloud", undefined] as const) {
              const m = agentMenuModel({ surface, mode, session, machines, apps: [], locus });
              expect(m.sections.length).toBeGreaterThan(0);
              for (const s of m.sections) {
                // An EMPTY Apps fold is allowed: "Apps · 0" says it, no line under it (his order, 2026-10-05).
                if (s.kind === "apps") expect(s.note).toBeNull();
                // An empty Workspaces fold still holds "Create workspace…" (the menu's UI paints it; 2026-10-08).
                else if (s.kind === "workspaces") expect(s.count).toBe(s.rows.length);
                else expect(s.rows.length).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    }
  });
});

describe("WORKSPACES — the one list, the last fold on both surfaces", () => {
  it("lists the member's workspaces by name, collapsible with a count, LAST — on either surface, with or without a desktop, on either locus", () => {
    for (const surface of ["web", "desktop"] as const) for (const machines of [[MAC], []]) for (const locus of ["local", "cloud"] as const) {
      const m = agentMenuModel({ surface, session: null, machines, apps: [], locus, workspaces: SPACES });
      const w = section(m, "workspaces")!;
      expect(w).toBeDefined();
      expect(w.collapsible).toBe(true);
      expect(w.count).toBe(2);
      expect(w.label).toBe(WORKSPACES_SECTION_LABEL);
      expect(w.rows).toEqual([{ name: "Dev" }, { name: "Writing" }]);
      expect(sectionHeadLabel(w.label, w.count)).toBe("Workspaces · 2");
      expect(kinds(m)[kinds(m).length - 1]).toBe("workspaces");
    }
  });
  it("no workspaces → the fold is still there, empty, for Create workspace… (his order, 2026-10-08)", () => {
    for (const workspaces of [[], undefined, [{ name: "" }, { name: "   " }]]) {
      const m = agentMenuModel({ surface: "web", session: null, machines: [MAC], apps, workspaces });
      const s = section(m, "workspaces") as { count: number; rows: unknown[] } | undefined;
      expect(s?.count).toBe(0);
      expect(s?.rows).toEqual([]);
    }
  });
  it("the rows: trimmed names, one per name (case-insensitive), blanks dropped", () => {
    expect(workspaceRows([{ name: " Dev " }, { name: "dev" }, { name: "" }, { name: "Writing" }])).toEqual([{ name: "Dev" }, { name: "Writing" }]);
  });
  it("the fold starts collapsed like the others", () => {
    const folds = menuFoldState();
    expect(isExpanded(folds, "workspaces")).toBe(false);
    expect(toggleFold(folds, "workspaces")).toBe(true);
  });
});
