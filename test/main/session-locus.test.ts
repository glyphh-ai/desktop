/**
 * session-locus.test.ts — where a session runs, as pure rules (his orders,
 * 2026-10-04): the ONE recents filter the rail and the dropdown share (loop +
 * place + type + search), the folder picker's two sections and its default
 * per surface, the lock on a desktop session whose folder the attached
 * desktop has not granted, and "cloud stays cloud".
 */
import { describe, expect, it } from "vitest";
import {
  defaultLocus, newSessionSource, filterRecents, folderGranted, locusFilterOf, loopFilterOf, pickerSections, recentsFilterActive, recentsKeeps,
  sessionLocked, sourceLocus, LOCUS_LOCKED_HINT, sessionIsBlank, type RecentsRowLike,
  defaultWebFolder, filterPickerRows, pickerRecent, PICKER_RECENT_MAX,
  folderAfterPick, canWalkUp,
} from "../../src/renderer/help/session-locus";

const row = (p: Partial<RecentsRowLike> & { title: string }): RecentsRowLike =>
  ({ cwd: "", loopKey: "glyphh", locus: "local", ...p });

const rows: RecentsRowLike[] = [
  row({ title: "fix the sync bug", cwd: "/Users/me/code/app", loopKey: "glyphh", locus: "local" }),
  row({ title: "blog post", loopKey: "glyphh", locus: "cloud" }),
  row({ title: "claude refactor", cwd: "/Users/me/code/app", loopKey: "claude", locus: "local" }),
  row({ title: "triage mail", loopKey: "glyphh", locus: "local" }),
];

describe("the one recents filter", () => {
  it("keeps everything with nothing picked", () => {
    expect(filterRecents(rows, { loops: [], locus: "" })).toHaveLength(4);
    expect(recentsFilterActive({ loops: [], locus: "" })).toBe(false);
  });

  it("narrows by loop: one or several, the rest drop out", () => {
    expect(filterRecents(rows, { loops: ["claude"], locus: "" }).map((r) => r.title)).toEqual(["claude refactor"]);
    expect(filterRecents(rows, { loops: ["claude", "glyphh"], locus: "" })).toHaveLength(4);
    expect(filterRecents(rows, { loops: ["codex"], locus: "" })).toHaveLength(0);
    expect(recentsFilterActive({ loops: ["codex"], locus: "" })).toBe(true);
  });

  it("narrows by place — This desktop / Cloud — on top of the loop filter", () => {
    expect(filterRecents(rows, { loops: [], locus: "cloud" }).map((r) => r.title)).toEqual(["blog post"]);
    expect(filterRecents(rows, { loops: [], locus: "local" })).toHaveLength(3);
    expect(filterRecents(rows, { loops: ["claude"], locus: "local" }).map((r) => r.title)).toEqual(["claude refactor"]);
    expect(filterRecents(rows, { loops: ["claude"], locus: "cloud" })).toHaveLength(0);
    expect(recentsFilterActive({ loops: [], locus: "cloud" })).toBe(true);
  });

  it("applies the search exactly as the rail does", () => {
    expect(filterRecents(rows, { loops: [], locus: "", query: "APP" }).map((r) => r.title)).toEqual(["fix the sync bug", "claude refactor"]);
  });

  it("a loop filter naming none of the loops a list can hold is no filter there", () => {
    const cliOnly = new Set(["claude", "codex"]);
    expect(recentsKeeps(rows[2]!, { loops: ["glyphh"], among: cliOnly, locus: "" })).toBe(true);
    expect(recentsKeeps(rows[2]!, { loops: ["codex"], among: cliOnly, locus: "" })).toBe(false);
    expect(recentsFilterActive({ loops: ["glyphh"], among: cliOnly, locus: "" })).toBe(false);
  });

  it("coerces the stored loop pick: a list of ids, deduplicated; anything else is every loop", () => {
    expect(loopFilterOf(["claude", "codex", "claude", " ", 3])).toEqual(["claude", "codex"]);
    expect(loopFilterOf("claude")).toEqual([]);
    expect(loopFilterOf(null)).toEqual([]);
  });

  it("a row with no locus stamp is the desktop's", () => {
    expect(recentsKeeps(row({ title: "old", locus: undefined }), { loops: [], locus: "local" })).toBe(true);
    expect(recentsKeeps(row({ title: "old", locus: undefined }), { loops: [], locus: "cloud" })).toBe(false);
  });

  it("coerces the stored pref", () => {
    expect(locusFilterOf("cloud")).toBe("cloud");
    expect(locusFilterOf("local")).toBe("local");
    expect(locusFilterOf("everywhere")).toBe("");
    expect(locusFilterOf(null)).toBe("");
  });
});

describe("the grant", () => {
  const grants = ["/Users/me/code", "C:\\work\\shoes"];
  it("is a whole-segment prefix, on either separator", () => {
    expect(folderGranted("/Users/me/code", grants)).toBe(true);
    expect(folderGranted("/Users/me/code/app/", grants)).toBe(true);
    expect(folderGranted("/Users/me/codex", grants)).toBe(false);
    expect(folderGranted("C:\\work\\shoes\\web", grants)).toBe(true);
    expect(folderGranted("C:/work/shoes/web", grants)).toBe(true);
    expect(folderGranted("", grants)).toBe(false);
  });

  it("locks a desktop session on the web only when its folder is outside every attached desktop's grants", () => {
    const machines = [{ id: "m1", name: "mbp", folders: ["/Users/me/code"] }];
    expect(sessionLocked({ locus: "local", cwd: "/Users/me/code/app" }, "web", machines)).toBe(false);
    expect(sessionLocked({ locus: "local", cwd: "/Users/me/secret" }, "web", machines)).toBe(true);
    expect(sessionLocked({ locus: "local", cwd: "/Users/me/secret" }, "web", [])).toBe(true);
    // A folderless (Work) thread and a cloud thread are never locked.
    expect(sessionLocked({ locus: "local", cwd: "" }, "web", machines)).toBe(false);
    expect(sessionLocked({ locus: "cloud", cwd: "/x" }, "web", [])).toBe(false);
    // On the desktop itself nothing is locked: the machine is this process.
    expect(sessionLocked({ locus: "local", cwd: "/Users/me/secret" }, "desktop", [])).toBe(false);
  });
});

describe("the picker", () => {
  const spaces = [{ id: "t1", updatedAt: 1, top: ["src"] }];

  it("defaults to the desktop where there is one, else the cloud", () => {
    expect(defaultLocus("desktop", false)).toBe("local");
    expect(defaultLocus("web", true)).toBe("local");
    expect(defaultLocus("web", false)).toBe("cloud");
    expect(defaultLocus("desktop", true)).toBe("local");
  });

  it("a new session is born with the pending pick, on either surface (one type since 2026-10-08)", () => {
    type S = { kind: string; path?: string };
    const same = (a: S, b: S) => a.kind === b.kind && a.path === b.path;
    const cloud: S = { kind: "cloud-new" };
    const deskDefault: S = { kind: "local", path: "/Users/me/yo" };
    expect(newSessionSource("web", deskDefault, deskDefault, same, cloud)).toBe(deskDefault);
    const picked: S = { kind: "local", path: "/Users/me/other" };
    expect(newSessionSource("web", picked, deskDefault, same, cloud)).toBe(picked);
    expect(newSessionSource("desktop", deskDefault, deskDefault, same, cloud)).toBe(deskDefault);
  });

  it("on the desktop: 'On this desktop' then 'In the cloud'", () => {
    const m = pickerSections({ surface: "desktop", machines: [], spaces, bornLocus: null });
    expect(m.sections.map((s) => s.label)).toEqual(["On this desktop", "In the cloud"]);
    expect(m.sections[0].empty).toBeUndefined();
    expect(m.sections[1].spaces).toEqual(spaces);
    expect(m.defaultLocus).toBe("local");
  });

  it("on the web: 'On <machine>' lists that desktop's granted folders; none attached says so and defaults to the cloud", () => {
    const attached = pickerSections({ surface: "web", machines: [{ id: "m1", name: "chris-mbp", folders: ["/Users/me/code"] }], spaces, bornLocus: null });
    expect(attached.sections[0]).toMatchObject({ label: "On chris-mbp", folders: ["/Users/me/code"] });
    expect(attached.defaultLocus).toBe("local");
    const noGrant = pickerSections({ surface: "web", machines: [{ id: "m1", name: "chris-mbp", folders: [] }], spaces, bornLocus: null });
    expect(noGrant.sections[0].empty).toMatch(/No folder is granted/);
    const none = pickerSections({ surface: "web", machines: [], spaces, bornLocus: null });
    expect(none.sections[0].empty).toMatch(/No desktop is attached/);
    expect(none.defaultLocus).toBe("cloud");
  });

  it("cloud stays cloud: a born session locks the other section", () => {
    const cloudBorn = pickerSections({ surface: "desktop", machines: [], spaces, bornLocus: "cloud" });
    expect(cloudBorn.sections[0].locked).toBe(LOCUS_LOCKED_HINT.cloud);
    expect(cloudBorn.sections[1].locked).toBeUndefined();
    const localBorn = pickerSections({ surface: "desktop", machines: [], spaces, bornLocus: "local" });
    expect(localBorn.sections[0].locked).toBeUndefined();
    expect(localBorn.sections[1].locked).toBe(LOCUS_LOCKED_HINT.local);
  });

  it("reads a source's locus", () => {
    expect(sourceLocus({ kind: "local" })).toBe("local");
    expect(sourceLocus({ kind: "cloud-new" })).toBe("cloud");
    expect(sourceLocus({ kind: "cloud-space" })).toBe("cloud");
    expect(sourceLocus(null)).toBe("cloud");
  });
});

describe("the default folder on the web (his report, 2026-10-04)", () => {
  const machines = [{ id: "m1", name: "chris-mbp", folders: ["/Users/me/code", "/Users/me/docs"] }];

  it("is the first granted folder when nothing was used yet", () => {
    expect(defaultWebFolder({ machines, recents: [] })).toBe("/Users/me/code");
  });

  it("is the last used folder when it is inside a grant — skipping ungranted ones", () => {
    expect(defaultWebFolder({ machines, recents: ["/tmp/scratch", "/Users/me/docs/book", "/Users/me/code"] })).toBe("/Users/me/docs/book");
  });

  it("keeps a stored pick that is still granted, and drops one that is not", () => {
    expect(defaultWebFolder({ machines, recents: ["/Users/me/code/app"], stored: "/Users/me/docs" })).toBe("/Users/me/docs");
    expect(defaultWebFolder({ machines, recents: ["/Users/me/code/app"], stored: "/private/etc" })).toBe("/Users/me/code/app");
  });

  it("is empty when no folder is granted — there is no folder a turn could use", () => {
    expect(defaultWebFolder({ machines: [{ id: "m1", name: "x", folders: [] }], recents: ["/Users/me/code"] })).toBe("");
    expect(defaultWebFolder({ machines: [], recents: ["/Users/me/code"] })).toBe("");
  });
});

describe("the picker's rows — the last five, searchable (his order, 2026-10-04)", () => {
  const spaces = [
    { id: "s-old", label: "old thing", updatedAt: 1 },
    { id: "s-new", label: "newest", updatedAt: 9 },
    { id: "s-mid", label: "middle", updatedAt: 5 },
    { id: "s-4", label: "four", updatedAt: 4 },
    { id: "s-3", label: "three", updatedAt: 3 },
    { id: "s-2", label: "two", updatedAt: 2 },
  ];
  const recents = ["/Users/me/code/app", "/Users/me/code/sdk", "/Users/me/code/web", "/Users/me/docs/book", "/Users/me/code/cli", "/Users/me/code/server", "/tmp/x"];

  it("lists the current folder first, then the last used, capped at five, no duplicates", () => {
    const r = pickerRecent({ surface: "desktop", current: "/Users/me/code/sdk", recents, granted: [], spaces: [] });
    expect(r.desktop).toEqual(["/Users/me/code/sdk", "/Users/me/code/app", "/Users/me/code/web", "/Users/me/docs/book", "/Users/me/code/cli"]);
    expect(r.desktop).toHaveLength(PICKER_RECENT_MAX);
  });

  it("on the web offers only folders inside a grant", () => {
    const r = pickerRecent({ surface: "web", current: "/tmp/x", recents, granted: ["/Users/me/code"], spaces: [] });
    expect(r.desktop).toEqual(["/Users/me/code/app", "/Users/me/code/sdk", "/Users/me/code/web", "/Users/me/code/cli", "/Users/me/code/server"]);
    expect(r.desktop).not.toContain("/tmp/x");
    expect(r.desktop).not.toContain("/Users/me/docs/book");
  });

  it("lists cloud folders newest first, the current one first, capped at five", () => {
    const r = pickerRecent({ surface: "web", current: "", recents: [], granted: [], spaces, currentSpace: "s-old" });
    expect(r.cloud.map((c) => c.id)).toEqual(["s-old", "s-new", "s-mid", "s-4", "s-3"]);
    const plain = pickerRecent({ surface: "web", current: "", recents: [], granted: [], spaces });
    expect(plain.cloud.map((c) => c.id)).toEqual(["s-new", "s-mid", "s-4", "s-3", "s-2"]);
  });

  it("searches both sections by substring, case-insensitively, like the recents search", () => {
    const rows = pickerRecent({ surface: "desktop", current: "", recents, granted: [], spaces });
    const hit = filterPickerRows(rows, "CODE/A");
    expect(hit.desktop).toEqual(["/Users/me/code/app"]);
    expect(hit.cloud).toEqual([]);
    const cloudHit = filterPickerRows(rows, "mid");
    expect(cloudHit.cloud.map((c) => c.id)).toEqual(["s-mid"]);
    expect(filterPickerRows(rows, "  ")).toBe(rows);
  });
});

describe("the pick is the folder (his report, 2026-10-05: the web picker would not change directories)", () => {
  it("a local pick with a path IS the folder, whatever the workdir held", () => {
    expect(folderAfterPick({ kind: "local", path: "/Users/me/code/app/src" }, "/Users/me/code/app")).toBe("/Users/me/code/app/src");
    expect(folderAfterPick({ kind: "local", path: "/Users/me/code/server" }, "")).toBe("/Users/me/code/server");
  });
  it("a machine-only pick keeps the folder it had", () => {
    expect(folderAfterPick({ kind: "local", path: "" }, "/Users/me/code/app")).toBe("/Users/me/code/app");
    expect(folderAfterPick({ kind: "local" }, "")).toBe("");
  });
  it("a cloud pick clears it — the worker's workspace is the folder", () => {
    expect(folderAfterPick({ kind: "cloud-new" }, "/Users/me/code/app")).toBe("");
    expect(folderAfterPick({ kind: "cloud-space", path: "x" }, "/Users/me/code/app")).toBe("");
  });
});

describe("walking up in the folder browser (his report, 2026-10-05)", () => {
  const grant = "/Users/me/code";
  it("steps up from a sub-folder as far as the grant, never past it", () => {
    expect(canWalkUp({ path: "/Users/me/code/app/src", parent: "/Users/me/code/app" }, grant)).toBe(true);
    expect(canWalkUp({ path: "/Users/me/code/app", parent: "/Users/me/code" }, grant)).toBe(true);
    expect(canWalkUp({ path: "/Users/me/code", parent: "/Users/me" }, grant)).toBe(false);
    expect(canWalkUp({ path: "/Users/me/codex", parent: "/Users/me" }, grant)).toBe(false);
  });
  it("the listing's own parent: null is the first word", () => {
    expect(canWalkUp({ path: "/Users/me/code", parent: null }, grant)).toBe(false);
    expect(canWalkUp({ path: "/Users/me/code/app", parent: null }, null)).toBe(false);
  });
  it("without a ceiling any parent will do; separators and trailing slashes do not matter", () => {
    expect(canWalkUp({ path: "/a/b", parent: "/a" }, null)).toBe(true);
    expect(canWalkUp({ path: "C:\\code\\app", parent: "C:\\code" }, "C:/code/")).toBe(true);
  });
});

describe("sessionIsBlank — only a thread with no turns anywhere follows the type switch", () => {
  it("a fresh session is blank", () => {
    expect(sessionIsBlank({ messages: [] })).toBe(true);
    expect(sessionIsBlank({})).toBe(true);
    expect(sessionIsBlank({ messages: [], messageCount: 0 })).toBe(true);
  });
  it("a thread with turns loaded is not blank", () => {
    expect(sessionIsBlank({ messages: [{ role: "user" }] })).toBe(false);
  });
  it("a thread adopted from the server, unread (messageCount only), is NOT blank", () => {
    expect(sessionIsBlank({ messages: [], messageCount: 7 })).toBe(false);
    expect(sessionIsBlank({ messageCount: 1 })).toBe(false);
  });
});
