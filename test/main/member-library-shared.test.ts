/**
 * member-library-shared.test.ts — the member library's record shapes
 * (shared/member-library.ts): how each local record projects to its row, what
 * never rides (a tab's config vars), the agent row both surfaces build, the
 * server-first merge, and the thread locus the rail badges by.
 */
import { describe, expect, it } from "vitest";
import {
  appRowKind,
  agentClock, buildAgentRow, buildScheduleData, buildTabRow, bundleDataOf, bundleOfPageId, bundlePageId, bundleRowOf, dripId, dripRecordOf,
  filesClock, filesSignature, isCronShape, isDripData, isGridLayout, isScheduleData, layoutRowOf, mergeServerFirst, mergeTabLocal,
  normalizeRemoteRow, rowClock, scheduleViewOf, sqlClock, tabClock, tabRecordOf, tabRowOf, threadLocus,
  workspaceClock, workspaceId, workspaceSurfaceOf, type GridLayoutLike, type TabRowLike,
} from "../../src/shared/member-library.js";

const GRID: GridLayoutLike = { name: "Research Desk", version: 2, cols: 2, rows: 1, colWidths: [0.5, 0.5], rowHeights: [1], cells: [{ panelId: "tool:coding", col: 0, row: 0, colSpan: 1, rowSpan: 1, sticky: true, config: { folder: "/w" } }], loop: "glyphh", sessionMode: "new", updatedAt: 1_700_000 };
const TAB: TabRowLike = { id: "crm", kind: "web", slug: "crm", name: "CRM", prodUrl: "https://crm", nativeRef: null, config: { iconUrl: "https://i", env: { TOKEN: "s3cret" }, apiKey: "k", vars: { A: 1 } }, description: "", access: "members", owned: true, latestVersion: null, version: "0.1.0", secretNames: ["TOKEN"], requiredConnections: [{ slug: "gmail", actAs: "me", connected: true }], listing: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-04T10:00:00.123Z" };

describe("workspaces", () => {
  it("the folder id is the name, slugged; the row is layout-manager's layouts-list shape with the clock", () => {
    expect(workspaceId(" Research Desk ")).toBe("research-desk");
    expect(workspaceId("")).toBe("workspace");
    const row = layoutRowOf(GRID);
    expect(row).toEqual({ name: "Research Desk", cols: 2, rows: 1, colWidths: [0.5, 0.5], rowHeights: [1], target: "glyphh", loop: "glyphh", view: null, gateway: null, modelSelections: {}, sessionMode: "new", type: null, folder: null, space: null, splits: [{ panelId: "tool:coding", col: 0, row: 0, colSpan: 1, rowSpan: 1, sticky: true, config: { folder: "/w" } }], updatedAt: 1_700_000 });
    expect(workspaceClock(GRID)).toBe(1_700_000);
    expect(workspaceClock({ ...GRID, updatedAt: undefined })).toBe(0);
    expect(isGridLayout(GRID)).toBe(true);
    expect(isGridLayout({ name: "x" })).toBe(false);
  });
  it("a workspace carries the SURFACE it was made on (his order, 2026-10-06); one without the stamp predates it and is a desktop's", () => {
    expect(workspaceSurfaceOf({ ...GRID, surface: "web" })).toBe("web");
    expect(workspaceSurfaceOf({ ...GRID, surface: "desktop" })).toBe("desktop");
    expect(workspaceSurfaceOf(GRID)).toBe("desktop");
    expect(workspaceSurfaceOf({ surface: "cloud" as never })).toBe("desktop");
    expect(workspaceSurfaceOf(null)).toBe("desktop");
    // the stamp rides the row untouched — the list filters, the row keeps every workspace
    expect(layoutRowOf({ ...GRID, surface: "web" })).toEqual(layoutRowOf(GRID));
  });
  it("the TYPE rides the row (his report, 2026-10-07: saved, never read back); junk reads null", () => {
    expect(layoutRowOf({ ...GRID, type: "code" }).type).toBe("code");
    expect(layoutRowOf({ ...GRID, type: "work" }).type).toBe("work");
    expect(layoutRowOf({ ...GRID, type: "" as never }).type).toBeNull();
  });
  it("the agents' start face and CLI route ride the row; junk reads null", () => {
    const row = layoutRowOf({ ...GRID, view: "cli", gateway: "on" });
    expect(row.view).toBe("cli");
    expect(row.gateway).toBe("on");
    expect(layoutRowOf({ ...GRID, view: "x" as never, gateway: "maybe" as never })).toMatchObject({ view: null, gateway: null });
  });
});

describe("app tabs", () => {
  it("config vars NEVER ride: env/vars and any secret-named key are stripped; the rest of the config does", () => {
    const rec = tabRecordOf(TAB);
    expect(rec.config).toEqual({ iconUrl: "https://i" });
    expect(rec.secretNames).toEqual(["TOKEN"]);      // the NAMES are library data; the values never were
    expect(tabRecordOf({ ...TAB, config: { env: {} } }).config).toEqual({});
    expect(tabRecordOf({ ...TAB, config: null }).config).toBeNull();
  });
  it("a pull keeps the machine's config vars under the server's fields", () => {
    const remote: TabRowLike = { ...tabRecordOf(TAB), name: "CRM 2", config: { iconUrl: "https://new" } };
    expect(mergeTabLocal(remote, TAB)).toMatchObject({ name: "CRM 2", config: { iconUrl: "https://new", env: { TOKEN: "s3cret" }, apiKey: "k", vars: { A: 1 } } });
    expect(mergeTabLocal(remote, null)).toBe(remote);
  });
  it("the clock is the ISO stamp, millisecond-exact; the row is org-apps' projection", () => {
    expect(tabClock(TAB)).toBe(Date.parse("2026-10-04T10:00:00.123Z"));
    expect(tabRowOf(TAB)).toMatchObject({ id: "crm", slug: "crm", isBrowser: true, url: "https://crm", appArchetype: "web", iconUrl: "https://i", connectionIds: ["gmail"], mcp: null, commands: {}, system: false });
    expect(tabRowOf({ ...TAB, kind: "glyphh" })).toMatchObject({ isBrowser: false, appArchetype: "glyphh-app" });
  });
  it("buildTabRow is apps-store's createEntry/updateEntry row", () => {
    const made = buildTabRow({ kind: "native", slug: "Mail", name: "Mail", nativeRef: "/Applications/Mail.app" }, null, "2026-10-04T00:00:00.000Z");
    expect(made).toMatchObject({ id: "mail", slug: "mail", kind: "native", nativeRef: "/Applications/Mail.app", prodUrl: null, owned: true, version: "0.1.0", access: "members", createdAt: "2026-10-04T00:00:00.000Z" });
    const edited = buildTabRow({ name: "Mail 2", access: "public" }, made, "2026-10-05T00:00:00.000Z");
    expect(edited).toMatchObject({ name: "Mail 2", access: "public", nativeRef: "/Applications/Mail.app", createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z" });
    expect(() => buildTabRow({ name: "x" }, null, "")).toThrow(/slug/);
  });
});

describe("agents", () => {
  it("buildAgentRow is local-agents' saveAgent row — the same on both surfaces", () => {
    const made = buildAgentRow({ name: "Ada Lovelace", prompt: "p", guardrails: { maxInputTokens: "12" as unknown as number, windowCalls: 0 } }, null, "2026-10-04T00:00:00.000Z");
    expect(made).toEqual({ id: "ada-lovelace", slug: "ada-lovelace", name: "Ada Lovelace", description: "", prompt: "p", provider: "", model: "", skills: [], apps: [], live: true, guardrails: { maxInputTokens: 12, maxOutputTokens: null, windowSeconds: null, windowTokens: null, windowCalls: null, maxConcurrent: null }, createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z" });
    const edited = buildAgentRow({ live: false, guardrails: {} }, made, "2026-10-05T00:00:00.000Z");
    expect(edited).toMatchObject({ slug: "ada-lovelace", name: "Ada Lovelace", prompt: "p", live: false, guardrails: null, createdAt: "2026-10-04T00:00:00.000Z" });
    expect(agentClock(edited)).toBe(Date.parse("2026-10-05T00:00:00.000Z"));
    expect(() => buildAgentRow({}, null, "")).toThrow(/name/);
  });
});

describe("skills and tasks", () => {
  it("the record's data is SKILL.md's frontmatter + body (+ task.json); the page id is the desktop's <source>:<name>", () => {
    const data = bundleDataOf("task", "digest", "---\nname: digest\ndescription: >-\n  Daily\n  digest\n---\n\nBody\n", false, { name: "digest", program: "run.js" });
    expect(data).toEqual({ name: "digest", description: "Daily digest", frontmatter: { name: "digest", description: "Daily digest" }, body: "\nBody\n", enabled: false, type: "task", manifest: { name: "digest", program: "run.js" } });
    expect(bundlePageId("skill", "notes")).toBe("glyphh:notes");
    expect(bundlePageId("task", "digest")).toBe("task:digest");
    expect(bundleOfPageId("glyphh:notes")).toEqual({ kind: "skill", id: "notes" });
    expect(bundleOfPageId("claude:notes")).toBeNull();
    expect(bundleOfPageId("app:x")).toBeNull();
    expect(bundleRowOf("skill", "notes", { ...data, type: "skill" }, 5_000, 3)).toMatchObject({ id: "glyphh:notes", source: "glyphh", type: "skill", name: "digest", fileCount: 3, updatedAt: new Date(5_000).toISOString() });
  });
  it("a manifest's signature is order-free; its clock is the newest mtime", () => {
    const a = [{ path: "b", size: 1, mtime: 5, sha256: "2" }, { path: "a", size: 1, mtime: 9, sha256: "1" }];
    expect(filesSignature(a)).toBe(filesSignature([...a].reverse()));
    expect(filesSignature(a)).not.toBe(filesSignature([{ ...a[0], sha256: "x" }, a[1]]));
    expect(filesClock(a)).toBe(9);
  });
});

describe("the remote row and the merge", () => {
  it("normalizeRemoteRow turns the since-page's numeric deletedAt into the ISO string reconcile wants", () => {
    expect(normalizeRemoteRow({ id: "x", updatedAt: 5, deletedAt: 5_000 })).toEqual({ id: "x", updatedAt: 5, deletedAt: new Date(5_000).toISOString() });
    expect(normalizeRemoteRow({ id: "x", updatedAt: 5, deletedAt: "2026-10-04T00:00:00.000Z" }).deletedAt).toBe("2026-10-04T00:00:00.000Z");
    expect(normalizeRemoteRow({ id: "x", updatedAt: 5 }).deletedAt).toBeNull();
    expect(normalizeRemoteRow({ id: "x", updatedAt: 5, deletedAt: null, data: 1 })).toEqual({ id: "x", updatedAt: 5, deletedAt: null, data: 1 });
  });
  it("mergeServerFirst: the server's row wins a tie; the relay fills what the server lacks", () => {
    const key = (r: { k: string }) => r.k;
    expect(mergeServerFirst([{ k: "a", from: "srv" }], [{ k: "a", from: "desk" }, { k: "b", from: "desk" }], key)).toEqual([{ k: "a", from: "srv" }, { k: "b", from: "desk" }]);
  });
});

describe("thread locus", () => {
  it("local = a local source, a bound folder, or this store's own chat; cloud = a cloud source or a server-adopted stub", () => {
    expect(threadLocus({ source: { kind: "local", path: "/w" } })).toBe("local");
    expect(threadLocus({ source: { kind: "cloud-new" } })).toBe("cloud");
    expect(threadLocus({ source: { kind: "cloud-repo", repo: "o/r" }, workdir: "/w" })).toBe("cloud");
    expect(threadLocus({ workdir: "/w" })).toBe("local");
    expect(threadLocus({ messages: [{ role: "user" }] })).toBe("local");
    expect(threadLocus({ messages: [], messageCount: 4 })).toBe("cloud");
    expect(threadLocus({})).toBe("local");
  });
});

describe("drips (2026-10-04: a preset is a db row with cloud storage)", () => {
  it("the id is the lowercased name; the record is { name, recipe } with the recipe's spacing normalised", () => {
    expect(dripId("  Party Time ")).toBe("party time");
    expect(dripRecordOf("Party", "  3   confetti\tfireworks ")).toEqual({ name: "party", recipe: "3 confetti fireworks" });
    expect(isDripData({ name: "p", recipe: "x" })).toBe(true);
    expect(isDripData("confetti")).toBe(false);
    expect(isDripData({ name: "p" })).toBe(false);
  });
  it("a SQLite row's clock is its updated_ms, else its SQL datetime (UTC) or ISO stamp, else 0", () => {
    expect(sqlClock("2026-10-04 10:00:00")).toBe(Date.parse("2026-10-04T10:00:00Z"));
    expect(sqlClock("2026-10-04T10:00:00.250Z")).toBe(Date.parse("2026-10-04T10:00:00.250Z"));
    expect(sqlClock("")).toBe(0);
    expect(sqlClock(null)).toBe(0);
    expect(rowClock(1_234.9, "2026-10-04 10:00:00")).toBe(1_234);
    expect(rowClock(null, "2026-10-04 10:00:00")).toBe(Date.parse("2026-10-04T10:00:00Z"));
    expect(rowClock(0, null)).toBe(0);
  });
});

describe("schedules (the record both surfaces build)", () => {
  it("buildScheduleData fills the shape from an input, keeping what an edit leaves unnamed; the name falls back to the target", () => {
    expect(buildScheduleData({ cron: " 0 9  * * 1-5 ", target: "digest" })).toEqual({ name: "digest", cron: "0 9 * * 1-5", kind: "task", target: "digest", agentId: null, ownerAgentId: null, args: {}, enabled: true });
    const cur = buildScheduleData({ name: "Brief", cron: "30 8 * * *", kind: "skill", target: "brief", agentId: "a", ownerAgentId: "bot", args: { n: 1 }, enabled: false });
    expect(buildScheduleData({ cron: "0 8 * * *", target: "brief", enabled: null }, cur)).toEqual({ ...cur, cron: "0 8 * * *" });
    expect(buildScheduleData({ cron: cur.cron, target: cur.target, agentId: null, args: "junk" }, cur)).toMatchObject({ agentId: null, args: {} });
    expect(buildScheduleData({ cron: "0 8 * * *", target: "brief", kind: "loop" })).toMatchObject({ kind: "task" });
  });
  it("isScheduleData / isCronShape guard what the server hands back and what the web types in", () => {
    expect(isScheduleData({ cron: "0 9 * * *", target: "x", kind: "task" })).toBe(true);
    expect(isScheduleData({ cron: "0 9 * * *", target: "x", kind: "loop" })).toBe(false);
    expect(isScheduleData(null)).toBe(false);
    expect(isCronShape("0 9 * * 1-5")).toBe(true);
    expect(isCronShape("*/15 * * * *")).toBe(true);
    expect(isCronShape("weekdays at 9am")).toBe(false);
    expect(isCronShape("0 9 * *")).toBe(false);
  });
  it("scheduleViewOf is the Schedules page's row: the record's fields, args as JSON, the machine's run columns null", () => {
    const data = buildScheduleData({ name: "Digest", cron: "0 9 * * *", target: "digest", args: { n: 1 } });
    expect(scheduleViewOf("s1", data, 5_000, "Ada")).toEqual({
      id: "s1", name: "Digest", kind: "task", target: "digest", cron: "0 9 * * *", enabled: true, agentId: null, agentName: "Ada", ownerAgentId: null,
      args: '{"n":1}', createdAt: new Date(5_000).toISOString(), updatedAt: 5_000, lastRunAt: null, lastStatus: null, lastError: null,
    });
    expect(scheduleViewOf("s1", { ...data, agentId: "a" }, 5_000).agentName).toBe("a");
  });
});

describe("appRowKind — what kind of row a desktop's panelApps.list hands over", () => {
  it("a Glyphh app bundle is \"glyphh\"; a URL tab \"web\"; an OS app \"native\"", () => {
    expect(appRowKind({ system: false, appArchetype: "glyphh-app", url: null, execPath: "/x/app.json" })).toBe("glyphh");
    expect(appRowKind({ system: false, appArchetype: "glyphh-app", url: null, execPath: null })).toBe("glyphh");   // a cloud instance, no local entry
    expect(appRowKind({ system: false, appArchetype: "web", url: "https://mail.google.com", execPath: null })).toBe("web");
    expect(appRowKind({ system: false, appArchetype: null, url: "https://linear.app", execPath: null })).toBe("web");
    expect(appRowKind({ system: false, appArchetype: "native", url: null, execPath: "/Applications/Notes.app" })).toBe("native");
    expect(appRowKind({ system: false, appArchetype: null, url: null, execPath: "/Applications/Notes.app" })).toBe("native");
  });
  it("the system rows (the Glyphh self row, the nav rows) and an unopenable row are null", () => {
    expect(appRowKind({ system: true, appArchetype: "glyphh-self", url: null, execPath: null })).toBeNull();
    expect(appRowKind({ system: true, appArchetype: "glyphh-nav", url: null, execPath: null })).toBeNull();
    expect(appRowKind({ system: false, appArchetype: null, url: null, execPath: null })).toBeNull();
  });
});
