/**
 * composer-plus.test.ts — the composer's `+` menu as data (his order,
 * 2026-10-06, Claude's composer as the reference): ONE menu on both surfaces,
 * every row with an icon; the web (the desktop with capability checks) never
 * lists a native row; the toggles call the doors the Settings pages already
 * call; "Manage …" lands where each surface keeps the page.
 */
import { describe, it, expect, vi } from "vitest";
import {
  plusCapsOf, plusMenuRows, manageTargetOf, readSkillRows, toggleSkill, readConnectorRows, toggleConnector,
  readMemoryState, toggleMemory, MEMORY_PREFS, ATTACH_LABEL, ATTACH_SHORTCUT, PLUS_ICONS,
  type PlusApi, type PlusState,
} from "../../src/renderer/help/composer-plus.js";

/** The desktop preload serves every door; the web's contract has no native picker. */
const DESKTOP_HAS = new Set(["glyphhPickAttachments", "pickWorkingDir", "skillsList", "skillSetEnabled", "mcpConnectionsList", "mcpConnectionsUpdate", "getPreference", "setPreference"]);
const WEB_HAS = new Set(["skillsList", "skillSetEnabled", "mcpConnectionsList", "mcpConnectionsUpdate", "getPreference", "setPreference"]);
const desktop = plusCapsOf((n) => DESKTOP_HAS.has(n));
const web = plusCapsOf((n) => WEB_HAS.has(n));
const st = (over: Partial<PlusState> = {}): PlusState => ({ surface: "desktop", space: "code", memoryOn: true, ...over });

describe("the rows, per surface", () => {
  it("desktop: attach ⌘U, Skills › Connectors ›, Memory ✓ — each with an icon — then the folder family", () => {
    const rows = plusMenuRows(desktop, st());
    expect(rows.slice(0, 4).map((r) => r.id)).toEqual(["attach", "skills", "connectors", "memory"]);
    for (const r of rows) expect(r.icon).toMatch(/^<svg/);
    expect(rows[0]).toMatchObject({ label: ATTACH_LABEL, shortcut: ATTACH_SHORTCUT, kind: "action" });
    expect(rows.filter((r) => r.kind === "submenu").map((r) => r.label)).toEqual(["Skills", "Connectors"]);
    expect(rows[3]).toMatchObject({ kind: "check", checked: true });
  });
  it("desktop: the folder family behind the OS pickers (one type since 2026-10-08)", () => {
    const rows = plusMenuRows(desktop, st({ workingFolder: "app" }));
    expect(rows.map((r) => r.id)).toEqual(["attach", "skills", "connectors", "memory", "add-folder", "working-folder", "choose-folder"]);
    expect(rows.find((r) => r.id === "working-folder")?.label).toBe("Working folder: app");
    expect(rows.filter((r) => r.desktopOnly).every((r) => r.codeOnly)).toBe(true);
  });
  it("the Loop section: the session's loop under its own heading, and a CLI loop's route", () => {
    const glyphh = plusMenuRows(desktop, st({ loop: { name: "Glyphh", route: null } }));
    expect(glyphh.map((r) => r.id)).toEqual(["attach", "skills", "connectors", "memory", "loop", "add-folder", "working-folder", "choose-folder"]);
    expect(glyphh.find((r) => r.id === "loop")).toMatchObject({ label: "Loop: Glyphh", kind: "submenu", sectionBefore: "Loop", sepBefore: true });
    const claude = plusMenuRows(desktop, st({ loop: { name: "Claude", route: "Direct" } }));
    expect(claude.map((r) => r.id).slice(4, 6)).toEqual(["loop", "route"]);
    expect(claude.find((r) => r.id === "route")).toMatchObject({ label: "Route: Direct", kind: "submenu" });
    expect(claude.find((r) => r.id === "route")?.sectionBefore).toBeUndefined();
    expect(plusMenuRows(desktop, st({ loop: null })).some((r) => r.id === "loop" || r.id === "route")).toBe(false);
  });
  it("the web never lists a native row — no attach picker, no folder rows, even in Code", () => {
    const rows = plusMenuRows(web, st({ surface: "web" }));
    expect(rows.map((r) => r.id)).toEqual(["skills", "connectors", "memory"]);
    expect(rows.some((r) => r.desktopOnly)).toBe(false);
    expect(rows[0].sepBefore).toBe(false);
  });
  it("a desktop host read with the web's doors shows the same rows as the web (capability, not surface)", () => {
    expect(plusMenuRows(web, st()).map((r) => r.id)).toEqual(plusMenuRows(web, st({ surface: "web" })).map((r) => r.id));
  });
  it("Memory off reads unchecked", () => {
    expect(plusMenuRows(desktop, st({ memoryOn: false })).find((r) => r.id === "memory")).toMatchObject({ checked: false });
  });
  it("every icon is the house stroke glyph", () => {
    for (const svg of Object.values(PLUS_ICONS)) expect(svg).toContain('stroke="currentColor"');
  });
});

describe("where Manage goes", () => {
  it("desktop: Skills + Connectors are the Build page's tabs too (his order, 2026-10-07); Memory stays a settings page", () => {
    expect(manageTargetOf("desktop", "skills")).toEqual({ kind: "group", group: "customize", sub: "skills" });
    expect(manageTargetOf("desktop", "connectors")).toEqual({ kind: "group", group: "customize", sub: "connections-cfg" });
    expect(manageTargetOf("desktop", "memory")).toEqual({ kind: "settings", sub: "memory" });
  });
  it("web: Skills + Connectors are the Build page's tabs; Memory stays a settings page", () => {
    expect(manageTargetOf("web", "skills")).toEqual({ kind: "group", group: "customize", sub: "skills" });
    expect(manageTargetOf("web", "connectors")).toEqual({ kind: "group", group: "customize", sub: "connections-cfg" });
    expect(manageTargetOf("web", "memory")).toEqual({ kind: "settings", sub: "memory" });
  });
});

describe("Skills › — the member's skills, toggled through skillSetEnabled", () => {
  it("lists the skill kind, by name, and toggles through the library door", async () => {
    const api: PlusApi = {
      skillsList: vi.fn(async () => ({ ok: true, data: [
        { id: "skill:zeta", name: "Zeta", enabled: true },
        { id: "skill:alpha", name: "Alpha", enabled: false },
      ] })),
      skillSetEnabled: vi.fn(async (id: string, on: boolean) => ({ ok: true, data: { id, name: "x", enabled: on } })),
    };
    const rows = await readSkillRows(api);
    expect(api.skillsList).toHaveBeenCalledWith(["skill"]);
    expect(rows.map((r) => [r.name, r.enabled])).toEqual([["Alpha", false], ["Zeta", true]]);
    const r = await toggleSkill(api, "skill:alpha", true);
    expect(r.ok).toBe(true);
    expect(api.skillSetEnabled).toHaveBeenCalledWith("skill:alpha", true);
  });
  it("a host without the door refuses, a failing door reads empty", async () => {
    expect((await toggleSkill({}, "skill:a", true)).ok).toBe(false);
    expect(await readSkillRows({ skillsList: async () => { throw new Error("down"); } })).toEqual([]);
  });
});

describe("Connectors › — the custom MCP servers, one switch each", () => {
  const api: PlusApi = {
    mcpConnectionsList: vi.fn(async () => ({ ok: true, connections: [
      { slug: "linear-mcp", name: "Linear", enabled: true },
      { slug: "docs", name: "Docs", enabled: false },
    ] })),
    mcpConnectionsUpdate: vi.fn(async () => ({ ok: true })),
  };
  it("the servers, by name, each on or off", async () => {
    const rows = await readConnectorRows(api);
    expect(rows.map((r) => [r.name, r.slug, r.on])).toEqual([["Docs", "docs", false], ["Linear", "linear-mcp", true]]);
  });
  it("a server toggles through mcpConnectionsUpdate", async () => {
    const rows = await readConnectorRows(api);
    const linear = rows.find((r) => r.slug === "linear-mcp")!;
    expect((await toggleConnector(api, linear, false)).ok).toBe(true);
    expect(api.mcpConnectionsUpdate).toHaveBeenCalledWith("linear-mcp", { enabled: false });
    expect(api.mcpConnectionsUpdate).toHaveBeenCalledTimes(1);
  });
  it("a host without the switch refuses; a failing switch reads as an error", async () => {
    const rows = await readConnectorRows(api);
    expect((await toggleConnector({}, rows[0], true)).ok).toBe(false);
    const res = await toggleConnector({ mcpConnectionsUpdate: async () => { throw new Error("down"); } }, rows[0], true);
    expect(res).toEqual({ ok: false, error: "down" });
  });
  it("a host without the read lists nothing; a failing read lists nothing", async () => {
    expect(await readConnectorRows({})).toEqual([]);
    expect(await readConnectorRows({ mcpConnectionsList: async () => { throw new Error("down"); } })).toEqual([]);
  });
});

describe("Connectors › — Pipedream apps join the servers", () => {
  const api: PlusApi = {
    mcpConnectionsList: async () => ({ ok: true, connections: [{ slug: "linear-mcp", name: "Linear", enabled: true }] }),
    pipedreamAccounts: async () => ({ ok: true, data: [
      { app: "gmail", appName: "Gmail", icon: null, enabled: true },
      { app: "gmail", appName: "Gmail", icon: null, enabled: true },
      { app: "slack", appName: "Slack", icon: null, enabled: false },
      { app: "zoom", appName: "Zoom", icon: null, enabled: true, dead: true },
    ] }),
    pipedreamAppEnable: vi.fn(async () => ({ ok: true })),
    mcpConnectionsUpdate: vi.fn(async () => ({ ok: true })),
  };
  it("one row per connected app, by name with the servers, a dead account left out", async () => {
    const rows = await readConnectorRows(api);
    expect(rows.map((r) => [r.key, r.kind, r.on])).toEqual([["pd:gmail", "pd", true], ["mcp:linear-mcp", "mcp", true], ["pd:slack", "pd", false]]);
  });
  it("an app toggles through pipedreamAppEnable, never the server switch", async () => {
    const rows = await readConnectorRows(api);
    expect(await toggleConnector(api, rows.find((r) => r.key === "pd:slack")!, true)).toEqual({ ok: true });
    expect(api.pipedreamAppEnable).toHaveBeenCalledWith("slack", true);
    expect(api.mcpConnectionsUpdate).not.toHaveBeenCalled();
    expect((await toggleConnector({}, rows[0]!, true)).ok).toBe(false);
    expect(await toggleConnector({ pipedreamAppEnable: async () => ({ ok: false, error: "nope" }) }, rows[0]!, true)).toEqual({ ok: false, error: "nope" });
  });
  it("a failing account read still lists the servers", async () => {
    const rows = await readConnectorRows({ ...api, pipedreamAccounts: async () => { throw new Error("down"); } });
    expect(rows.map((r) => r.key)).toEqual(["mcp:linear-mcp"]);
  });
});

describe("Memory ✓ — the member's preference (there is no per-session flag)", () => {
  const prefs = (over: Record<string, unknown>): { api: PlusApi; set: ReturnType<typeof vi.fn> } => {
    const store: Record<string, unknown> = { [MEMORY_PREFS.accepted]: "2026-10-01", ...over };
    const set = vi.fn((k: string, v: unknown) => { store[k] = v; });
    return { api: { getPreference: async (k, d) => (k in store ? store[k] : d), setPreference: set }, set };
  };
  it("on = accepted and memoryInject not false", async () => {
    expect(await readMemoryState(prefs({}).api)).toEqual({ accepted: true, on: true });
    expect(await readMemoryState(prefs({ [MEMORY_PREFS.inject]: false }).api)).toEqual({ accepted: true, on: false });
    expect(await readMemoryState(prefs({ [MEMORY_PREFS.accepted]: "" }).api)).toEqual({ accepted: false, on: false });
  });
  it("off writes both switches the Settings page has; on writes them back", () => {
    const { api, set } = prefs({});
    expect(toggleMemory(api, { accepted: true, on: true })).toBe("off");
    expect(set.mock.calls).toEqual([[MEMORY_PREFS.inject, false], [MEMORY_PREFS.capture, false]]);
    expect(toggleMemory(api, { accepted: true, on: false })).toBe("on");
    expect(set.mock.calls.slice(2)).toEqual([[MEMORY_PREFS.inject, true], [MEMORY_PREFS.capture, true]]);
  });
  it("before the policy is accepted nothing is written — the page is the door", () => {
    const { api, set } = prefs({ [MEMORY_PREFS.accepted]: "" });
    expect(toggleMemory(api, { accepted: false, on: false })).toBe("needs-policy");
    expect(set).not.toHaveBeenCalled();
  });
});


describe("connector rows wear the Connections page's logos (his order, 2026-10-06)", () => {
  it("a server with an iconUrl wears it; one without wears its monogram", async () => {
    vi.stubGlobal("window", {});   // the icon helper reads the API base off window; none here
    const { readConnectorRows } = await import("../../src/renderer/help/composer-plus");
    const api = {
      mcpConnectionsList: async () => ({ ok: true, connections: [
        { slug: "miro", name: "Miro Developer App", enabled: true, iconUrl: "https://cdn/miro.png" },
        { slug: "docs", name: "Docs", enabled: true, iconUrl: null },
      ] }),
    };
    const rows = await readConnectorRows(api as never);
    const miro = rows.find((r) => r.key === "mcp:miro")!;
    const docs = rows.find((r) => r.key === "mcp:docs")!;
    expect(miro.icon).toContain("<img");
    expect(miro.icon).toContain("cdn/miro.png");
    expect(docs.icon).toContain("drop-icon-initial");
    expect(docs.icon).not.toContain("<img");
    vi.unstubAllGlobals();
  });
});
