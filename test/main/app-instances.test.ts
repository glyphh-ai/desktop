/**
 * app-instances.test.ts — the pure side of app instances
 * (src/shared/app-instances.ts): the create request a bundle makes, the tab
 * row an instance gets, the one list (instances + tabs, one row per slug),
 * the panel URL, the Apps-page card; and the desktop door
 * (src/main/app-instances.ts), which has no cloud and so no instances.
 */
import { describe, expect, it } from "vitest";
import {
  callPathOf, instanceCardOf, instanceDetailOf, instanceKeyOfRow, instanceRequestOf, instanceTabOpen, instanceTabRow, instanceToolRows,
  mergeAppRows, panelPathOf, panelUrlOf, resolveInstance, tabConfigOf, instanceCardId, isInstanceCardId, instanceKeyOfCardId,
  releaseOf, rollbackTargetOf,
  type AppInstanceSummary,
} from "../../src/shared/app-instances.js";
import type { TabRowLike } from "../../src/shared/member-library.js";

const SHA = "a".repeat(64);
const MANIFEST = {
  manifestVersion: 2, kind: "glyphh-app", name: "Expense Desk", slug: "expense-desk", entry: "index.html",
  capabilities: ["db.exec", "notify.send"], connectors: ["gmail"],
  tools: [{ name: "list_expenses", description: "Every expense", capability: "db.exec", inputSchema: { type: "object" } }],
  window: { width: 900 }, release: { version: "1.2.0" }, description: "Expenses, filed.",
};
const ORG: AppInstanceSummary = {
  key: "expense-desk", slug: "expense-desk", kind: "org", access: "everyone", public: false, status: "ready", members: [], orgConnectionId: null,
  bundle: { sha256: SHA, bytes: 1234 }, manifest: { name: "Expense Desk", tools: MANIFEST.tools, capabilities: MANIFEST.capabilities, connectors: ["gmail"], description: "Expenses, filed." },
  url: "/app-host/expense-desk/",
};
const PERSONAL: AppInstanceSummary = { ...ORG, key: "notes~u1", slug: "notes", kind: "personal", manifest: { name: "Notes", tools: [], capabilities: [], connectors: [] }, url: "/app-host/notes~u1/" };
const tab = (over: Partial<TabRowLike>): TabRowLike => ({
  id: "crm", kind: "web", slug: "crm", name: "CRM", prodUrl: "https://crm", nativeRef: null, config: null, description: "", access: "members", owned: true,
  latestVersion: null, version: "0.1.0", secretNames: [], requiredConnections: [], listing: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...over,
});
/** A glyphh row from before the cloud: its entry a file on a machine. */
const LOCAL = tab({ id: "expense-desk", kind: "glyphh", slug: "expense-desk", name: "Expense Desk (local)", nativeRef: "/Users/me/.glyphh/apps/expense-desk/index.html", config: { capabilities: ["db.exec"], secrets: { K: "v" } } });

describe("instanceRequestOf — the create body a bundle makes", () => {
  it("carries slug, kind, the zip's identity and the manifest as it is", () => {
    const req = instanceRequestOf(MANIFEST, { sha256: SHA, sizeBytes: 1234 }, "org");
    expect(req).toEqual({ slug: "expense-desk", kind: "org", bundle: { sha256: SHA, sizeBytes: 1234 }, manifest: { ...MANIFEST, slug: "expense-desk" } });
  });
  it("refuses what the server would: a bad slug, kind, sha or size", () => {
    expect(() => instanceRequestOf({ ...MANIFEST, slug: "Bad Slug" }, { sha256: SHA, sizeBytes: 1 }, "org")).toThrow(/slug/);
    expect(() => instanceRequestOf(MANIFEST, { sha256: "nope", sizeBytes: 1 }, "org")).toThrow(/sha256/);
    expect(() => instanceRequestOf(MANIFEST, { sha256: SHA, sizeBytes: 0 }, "org")).toThrow(/sizeBytes/);
    expect(() => instanceRequestOf(MANIFEST, { sha256: SHA, sizeBytes: 1 }, "team" as never)).toThrow(/kind/);
  });
});

describe("instanceTabRow — the tab record an instance gets", () => {
  it("is a glyphh row with no local entry whose config names the instance", () => {
    const row = instanceTabRow(ORG, MANIFEST, null, "2026-10-04T10:00:00.000Z");
    expect(row.kind).toBe("glyphh");
    expect(row.nativeRef).toBeNull();
    expect(row.prodUrl).toBeNull();
    expect(row.config).toMatchObject({ instance: "expense-desk", instanceKind: "org", capabilities: ["db.exec", "notify.send"], connectors: ["gmail"], workbench: true, release: { version: "1.2.0" } });
    expect(row.version).toBe("1.2.0");
    expect(row.requiredConnections).toEqual([{ slug: "gmail", actAs: "user", connected: false }]);
    expect(instanceKeyOfRow(row)).toBe("expense-desk");
  });
  it("retargets a row from before the cloud: entry gone, identity, dates and config vars kept", () => {
    const row = instanceTabRow(ORG, MANIFEST, LOCAL, "2026-10-04T10:00:00.000Z");
    expect(row.nativeRef).toBeNull();
    expect(row.id).toBe("expense-desk");
    expect(row.createdAt).toBe(LOCAL.createdAt);
    expect(row.config).toMatchObject({ instance: "expense-desk", secrets: { K: "v" } });
    expect(instanceKeyOfRow(row)).toBe("expense-desk");
  });
  it("with no manifest, reads the instance's own summary", () => {
    const row = instanceTabRow(PERSONAL, null, null, "2026-10-04T10:00:00.000Z");
    expect(row.name).toBe("Notes");
    expect(tabConfigOf(PERSONAL)).toMatchObject({ instance: "notes~u1", instanceKind: "personal", tools: [] });
  });
});

describe("mergeAppRows — THE LIST", () => {
  it("lists tab rows and every instance no tab names, one row per slug (an old row never beside its instance)", () => {
    const rows = mergeAppRows([ORG, PERSONAL], [tab({}), LOCAL], "2026-10-04T00:00:00.000Z");
    expect(rows.map((r) => r.slug).sort()).toEqual(["crm", "expense-desk", "notes"]);
    const desk = rows.find((r) => r.slug === "expense-desk")!;
    // The instance is the app; the local copy is hidden behind it.
    expect(desk.execPath).toBeNull();
    expect(desk.appArchetype).toBe("glyphh-app");
    expect(desk.launchConfig).toMatchObject({ instance: "expense-desk", instanceStatus: "ready", instanceAccess: "everyone" });
    const notes = rows.find((r) => r.slug === "notes")!;
    expect(notes.launchConfig).toMatchObject({ instance: "notes~u1", instanceKind: "personal" });
  });
  it("lists an old row that has no instance once, as it is, with no extra flag", () => {
    const rows = mergeAppRows([], [LOCAL, LOCAL]);
    expect(rows).toHaveLength(1);
    expect(rows[0].execPath).toBe(LOCAL.nativeRef);
    expect(rows[0].launchConfig).not.toHaveProperty("data");
    expect(rows[0].launchConfig).not.toHaveProperty("legacyLocal");
  });
  it("an org instance wins a personal one of the same slug for the row", () => {
    const mine = { ...PERSONAL, key: "expense-desk~u1", slug: "expense-desk" };
    const rows = mergeAppRows([mine, ORG], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].launchConfig?.instance).toBe("expense-desk");
  });
  it("a glyphh tab with no instance behind it and no bundle on this machine is not listed — it is a row left over from a delete (his report, 2026-10-07)", () => {
    const dead = tab({ id: "daily-brief", kind: "glyphh", slug: "daily-brief", name: "Daily Brief", config: { instance: "daily-brief~u1" }, nativeRef: null });
    const bare = tab({ id: "messages", kind: "glyphh", slug: "messages", name: "Messages", config: null, nativeRef: null });
    expect(mergeAppRows([], [dead, bare]).map((r) => r.slug)).toEqual([]);
    // Its instance back → the row lists with the instance; a local bundle lists on its own.
    expect(mergeAppRows([{ ...PERSONAL, key: "daily-brief~u1", slug: "daily-brief" }], [dead]).map((r) => r.slug)).toEqual(["daily-brief"]);
    expect(mergeAppRows([], [LOCAL]).map((r) => r.slug)).toEqual([LOCAL.slug]);
    // A URL tab is never an app row's business.
    expect(mergeAppRows([], [tab({ id: "mail", kind: "web", slug: "mail", name: "Mail", prodUrl: "https://mail" })]).map((r) => r.slug)).toEqual(["mail"]);
  });
  it("a tab that names an instance carries its live status", () => {
    const named = tab({ id: "expense-desk", kind: "glyphh", slug: "expense-desk", name: "Expense Desk", config: { instance: "expense-desk" } });
    const rows = mergeAppRows([{ ...ORG, status: "stopped" }], [named]);
    expect(rows[0].launchConfig).toMatchObject({ instance: "expense-desk", instanceStatus: "stopped" });
  });

  // THE HOUSE APPS ARE APPS (his law, 2026-10-06): Images, Drive and the rest
  // are instances the server installs for every member, listed like any
  // instance — nothing synthesizes a row for them. What is theirs: the slug
  // names the built-in panel, stamped on the tab as `tool`, the one key every
  // open door reads (the wall tile, the ⋮ menu, Settings → Apps → Open).
  it("a HOUSE app's instance names its built-in panel (`tool`) — on its own tab, and on a tab the server wrote without it; no instance, no row", () => {
    const images: AppInstanceSummary = { ...PERSONAL, key: "images~u1", slug: "images", manifest: { name: "Images", tools: [{ name: "save_image" }], capabilities: ["library.*"], connectors: [] }, url: "/app-host/images~u1/" };
    const at = "2026-10-06T00:00:00.000Z";
    expect(instanceTabRow(images, null, null, at).config).toMatchObject({ instance: "images~u1", instanceKind: "personal", tool: "gimage", workbench: true });
    expect(instanceTabRow(PERSONAL, null, null, at).config).not.toHaveProperty("tool");
    // Settings → Apps → Open: the panel for a house app, the instance's UI for any other.
    expect(instanceTabOpen(instanceTabRow(images, null, null, at))).toEqual({ slug: "images", name: "Images", tool: "gimage" });
    expect(instanceTabOpen(instanceTabRow(PERSONAL, null, null, at))).toEqual({ slug: "notes", name: "Notes" });
    // The list: a bare tab the server wrote for the instance still carries the panel.
    const bare = tab({ id: "images", kind: "glyphh", slug: "images", name: "Images", config: { instance: "images~u1" } });
    const rows = mergeAppRows([images, PERSONAL], [bare], at);
    expect(rows.map((r) => r.slug)).toEqual(["images", "notes"]);
    expect(rows[0].launchConfig).toMatchObject({ instance: "images~u1", tool: "gimage", instanceStatus: "ready" });
    expect(rows[1].launchConfig).not.toHaveProperty("tool");
    // A tab's own tool wins; nothing is listed that is not installed.
    const own = tab({ id: "drive", kind: "glyphh", slug: "drive", name: "Drive", config: { instance: "drive~u1", tool: "gdrive" } });
    expect(mergeAppRows([{ ...images, key: "drive~u1", slug: "drive" }], [own], at)[0].launchConfig).toMatchObject({ tool: "gdrive" });
    expect(mergeAppRows([], [], at)).toEqual([]);
  });
});

describe("the panel URL", () => {
  it("is the server's proxy at the release's ui/ tree with a trailing slash (the app server resolves index.html), the key encoded", () => {
    expect(panelPathOf("expense-desk")).toBe("/app-host/expense-desk/ui/");
    expect(panelPathOf("notes~u1")).toBe("/app-host/notes~u1/ui/");
    expect(panelUrlOf("https://api.glyphh.ai/", "expense-desk")).toBe("https://api.glyphh.ai/app-host/expense-desk/ui/");
    expect(callPathOf("a b")).toBe("/app-host/a%20b/call");
  });
});

describe("releases on the summary", () => {
  it("release n reads off the row; rollback = n-1, nothing before release 1 or with nothing deployed", () => {
    expect(releaseOf(ORG)).toBeNull();
    expect(releaseOf({ release: 3 })).toBe(3);
    expect(releaseOf({ release: 0 })).toBeNull();
    expect(rollbackTargetOf({ release: 3 })).toBe(2);
    expect(rollbackTargetOf({ release: 1 })).toBeNull();
    expect(rollbackTargetOf({ release: null })).toBeNull();
    expect(rollbackTargetOf(null)).toBeNull();
  });
});

describe("the Apps-page card and the tool rows", () => {
  it("a card stands for the instance, with no folder", () => {
    const card = instanceCardOf(ORG, "2026-10-04T00:00:00.000Z");
    expect(card).toMatchObject({ id: "app-instance:expense-desk", type: "app", source: "app", dir: "", fileCount: 0, enabled: true, author: "your organization", tool: null });
    // A house app's card is Glyphh's and wears its panel's mark; the manifest's description rides (his report, 2026-10-07).
    const house = instanceCardOf({ ...ORG, slug: "design", kind: "personal", manifest: { ...ORG.manifest, name: "Design", description: "The member's design systems" } });
    expect(house).toMatchObject({ author: "Glyphh", tool: "gdesign", description: "The member's design systems", name: "Design" });
    expect(card.instance.tools).toEqual(["list_expenses"]);
    expect(card.instance.release).toBeNull();
    expect(isInstanceCardId(card.id)).toBe(true);
    expect(instanceKeyOfCardId(instanceCardId("notes~u1"))).toBe("notes~u1");
    const detail = instanceDetailOf(ORG);
    expect(detail.frontmatter).toMatchObject({ instance: "expense-desk", kind: "org", status: "ready" });
    expect(detail.frontmatter).not.toHaveProperty("release");
    expect(detail.body).toContain("nothing deployed yet");
    expect(detail.body).toContain("`list_expenses` — Every expense");
    expect(detail.files).toEqual([]);
  });
  it("the detail's page is the release's SKILL.md when it ships one, frontmatter stripped (his order, 2026-10-07)", () => {
    const skill = "---\nname: app-expense-desk\ndescription: Expenses.\n---\n\n# Expense Desk\n\nFile and find expenses.\n\n## Tools\n\n- `list_expenses` — every expense.\n";
    const detail = instanceDetailOf({ ...ORG, release: 2, skill });
    expect(detail.body.startsWith("# Expense Desk")).toBe(true);
    expect(detail.body).not.toContain("name: app-expense-desk");
    expect(detail.body).not.toContain("Installed in the cloud"), "the app's own page, not the synthesized one";
    expect(instanceDetailOf({ ...ORG, skill: "  " }).body).toContain("Installed in the cloud");
  });
  it("the card and the detail carry the pinned release", () => {
    const live = { ...ORG, release: 4 };
    expect(instanceCardOf(live).instance.release).toBe(4);
    const detail = instanceDetailOf(live);
    expect(detail.frontmatter.release).toBe("4");
    expect(detail.body).toContain("release 4");
  });
  it("tool rows are the gateway's shape, keyed by instance, instances without tools left out", () => {
    expect(instanceToolRows([ORG, PERSONAL])).toEqual([
      { app: "expense-desk", name: "Expense Desk", kind: "org", status: "ready", tools: [{ name: "list_expenses", description: "Every expense", inputSchema: { type: "object" } }] },
    ]);
  });
  it("resolves a ref by key, by slug (org first), or the member's personal one", () => {
    const mine = { ...PERSONAL, key: "expense-desk~u1", slug: "expense-desk" };
    expect(resolveInstance([mine, ORG], "expense-desk", "u1")?.key).toBe("expense-desk");
    expect(resolveInstance([mine, ORG], "expense-desk~u1", "u1")?.key).toBe("expense-desk~u1");
    expect(resolveInstance([mine], "expense-desk", "u1")?.key).toBe("expense-desk~u1");
    expect(resolveInstance([ORG], "nothing", "u1")).toBeUndefined();
  });
});

// ── the desktop door: there is no cloud, so there are no instances ──────────
const main = await import("../../src/main/app-instances.js");

describe("the desktop door with no cloud", () => {
  it("lists no app tools and refuses a call by name", async () => {
    expect(await main.listInstanceTools()).toEqual([]);
    await expect(main.callInstanceTool("expense-desk", "list_expenses", {})).rejects.toThrow(/no Glyphh app "expense-desk" to run "list_expenses"/);
  });
});
