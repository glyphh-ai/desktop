/**
 * The bundle-shape rules as tests — the three failures of 2026-09-17, each
 * pinned so it cannot come back:
 *
 *   1. an installed app that appeared on NO page (no library card)
 *   2. a required connection that rendered as nothing (bare-string deps)
 *   3. a deleted app whose tile stayed on the echo wall (row not matched)
 *
 * plus the authoring gate that stops an agent shipping an app when the user
 * asked for a skill.
 */

import { describe, it, expect } from "vitest";
import path from "path";
import {
  normalizeConnDeps, appCardManifest, appCardSkillMd, GENERATED_MARK,
  rowOwnedByBundle, payloadDirOf, hasAppFace, NO_FACE_ERROR, checkBundlePath,
  WHERE_TO_SEE, checkNoForeignManifest, type AppCardInput,
} from "../../src/shared/bundle-shape";

const card = (over: Partial<AppCardInput> = {}): AppCardInput => ({
  slug: "daily-schedule-reporter",
  name: "Daily Schedule Reporter",
  description: "Reads Gmail and Calendar to build a morning report",
  bundleDir: "/Users/x/.glyphh/custom-apps/daily-schedule-reporter",
  entry: "index.html",
  connectors: ["gmail", "google_calendar"],
  tools: [{ name: "generate_report", description: "Build today's report" }],
  ...over,
});

describe("connection dependencies", () => {
  it("takes the object shape the manifest documents", () => {
    expect(normalizeConnDeps([{ app: "gmail", as: "org" }])).toEqual([{ app: "gmail", as: "org" }]);
  });

  it("takes a bare slug too, which used to blank the whole pane", () => {
    expect(normalizeConnDeps(["gmail", "google_calendar"])).toEqual([
      { app: "gmail", as: "member" },
      { app: "google_calendar", as: "member" },
    ]);
  });

  it("drops entries with no app slug instead of throwing mid-render", () => {
    const raw = [{ app: "gmail" }, { app: "   " }, null, undefined, 7] as never;
    expect(normalizeConnDeps(raw)).toEqual([{ app: "gmail", as: "member" }]);
  });

  it("defaults to the member's own account, never the org's", () => {
    expect(normalizeConnDeps([{ app: "slack" }])[0].as).toBe("member");
  });

  it("answers an empty list for nothing at all", () => {
    expect(normalizeConnDeps(undefined)).toEqual([]);
    expect(normalizeConnDeps(null)).toEqual([]);
  });
});

describe("an installed app's library card", () => {
  it("writes connections in the shape the UI reads and the hub validates", () => {
    const deps = (appCardManifest(card()).dependencies as { connections: unknown }).connections;
    expect(deps).toEqual([{ app: "gmail", as: "member" }, { app: "google_calendar", as: "member" }]);
  });

  it("types the folder as an app, which is what puts it on the Skills page", () => {
    const m = appCardManifest(card());
    expect(m.kind).toBe("glyphh-app");
    expect(m.name).toBe("daily-schedule-reporter");
    expect(m.tools).toEqual(["generate_report"]);
  });

  it("names the payload folder so the reader can find the code", () => {
    expect(appCardManifest(card()).bundle).toBe("/Users/x/.glyphh/custom-apps/daily-schedule-reporter");
  });

  it("claims an icon only when one is actually there", () => {
    expect(appCardManifest(card()).icon).toBeUndefined();
    expect(appCardManifest(card({ hasIcon: true })).icon).toBe("icon.svg");
  });

  it("marks itself generated, which is how a user's edits survive a reinstall", () => {
    expect(appCardSkillMd(card())).toContain(`generated: ${GENERATED_MARK}`);
  });

  it("carries the frontmatter the library lists it by", () => {
    const md = appCardSkillMd(card());
    expect(md.startsWith("---\nname: daily-schedule-reporter\n")).toBe(true);
    expect(md).toContain("type: app");
    expect(md).toContain("description: Reads Gmail and Calendar to build a morning report");
  });

  it("tells an agent the tools and says the connections are required", () => {
    const md = appCardSkillMd(card());
    expect(md).toContain("`generate_report` — Build today's report");
    expect(md).toContain("`gmail` — required");
    expect(md).toContain("`google_calendar` — required");
  });

  it("keeps a one-line description on one line", () => {
    expect(appCardSkillMd(card({ description: "two\nlines  here" }))).toContain("description: two lines here");
  });

  it("says so plainly when an app declares no tools", () => {
    expect(appCardSkillMd(card({ tools: [] }))).toContain("declares no tools");
  });

  it("says so plainly when an app needs no account", () => {
    expect(appCardSkillMd(card({ connectors: [] }))).toContain("It needs no connected account.");
  });
});

describe("which saved-app row a bundle folder owns", () => {
  const dir = "/Users/x/.glyphh/users/u1/apps/standup-board";

  it("matches the recorded bundle dir", () => {
    expect(rowOwnedByBundle({ slug: "standup-board", config: { bundleDir: dir } }, dir)).toBe(true);
  });

  it("matches an entry file living inside the folder", () => {
    expect(rowOwnedByBundle({ slug: "whatever", nativeRef: `${dir}/ui/index.html` }, dir)).toBe(true);
  });

  it("matches an installed app by slug, which had no bundleDir at all", () => {
    const row = { slug: "standup-board", kind: "glyphh", nativeRef: "/Users/x/.glyphh/custom-apps/standup-board/index.html" };
    expect(rowOwnedByBundle(row, dir)).toBe(true);
  });

  it("never takes a web or native row of the same name with it", () => {
    expect(rowOwnedByBundle({ slug: "standup-board", kind: "web", nativeRef: null }, dir)).toBe(false);
  });

  it("leaves another app's row alone", () => {
    expect(rowOwnedByBundle({ slug: "design", kind: "glyphh", nativeRef: "/Users/x/.glyphh/custom-apps/design/index.html" }, dir)).toBe(false);
  });
});

describe("the payload folder a delete may remove", () => {
  const apps = "/Users/x/.glyphh/apps";
  const custom = "/Users/x/.glyphh/custom-apps";

  it("takes the org-scoped install folder, not just the entry's own directory", () => {
    expect(payloadDirOf(`${apps}/org_1/recall/ui/index.html`, apps, custom)).toBe(path.join(apps, "org_1", "recall"));
  });

  it("takes the legacy flat install folder", () => {
    expect(payloadDirOf(`${custom}/recall/index.html`, apps, custom)).toBe(path.join(custom, "recall"));
  });

  it("refuses anything outside both roots, so a folder the user picked is safe", () => {
    expect(payloadDirOf("/Users/x/code/my-app/index.html", apps, custom)).toBeNull();
  });

  it("refuses the roots themselves and a bare child of the org root", () => {
    expect(payloadDirOf(`${apps}/index.html`, apps, custom)).toBeNull();
    expect(payloadDirOf(`${apps}/org_1/index.html`, apps, custom)).toBeNull();
    expect(payloadDirOf(`${custom}/index.html`, apps, custom)).toBeNull();
  });

  it("refuses the shared host folders", () => {
    expect(payloadDirOf(`${custom}/_libs/react/index.js`, apps, custom)).toBeNull();
  });

  it("refuses nothing at all", () => {
    expect(payloadDirOf(null, apps, custom)).toBeNull();
    expect(payloadDirOf("", apps, custom)).toBeNull();
  });
});

describe("what an agent may author as an app", () => {
  it("counts a ui entry as a face", () => {
    expect(hasAppFace(["ui/index.html", "worker.js"])).toBe(true);
    expect(hasAppFace(["index.html"])).toBe(true);
  });

  it("refuses a worker with tools and no face, which is a task", () => {
    expect(hasAppFace(["worker.js", "tools/manifest.json"])).toBe(false);
    expect(NO_FACE_ERROR).toContain('type "task"');
    expect(NO_FACE_ERROR).toContain('type "skill"');
  });

  it("refuses a path that climbs out of the bundle", () => {
    expect(() => checkBundlePath("../../etc/passwd")).toThrow(/bad file path/);
    expect(() => checkBundlePath("/etc/passwd")).toThrow(/bad file path/);
    expect(() => checkBundlePath("   ")).toThrow(/bad file path/);
  });

  it("refuses an absolute path instead of quietly filing it in the bundle", () => {
    expect(() => checkBundlePath("/ui/index.html")).toThrow(/relative path/);
    expect(() => checkBundlePath("C:\\windows\\system32")).toThrow(/relative path/);
  });

  it("keeps a relative path as it is", () => {
    expect(checkBundlePath("scripts/report.js")).toBe("scripts/report.js");
    expect(checkBundlePath(" ui/index.html ")).toBe("ui/index.html");
  });

  it("refuses a climb hidden inside a longer path", () => {
    expect(() => checkBundlePath("ui/../../secrets.json")).toThrow(/bad file path/);
  });

  it("keeps a name that merely contains dots", () => {
    expect(checkBundlePath("data/v1..2/notes.md")).toBe("data/v1..2/notes.md");
  });

  it("refuses a skill that smuggles in an app's manifest", () => {
    expect(() => checkNoForeignManifest("skill", ["SKILL.md", "app.json"])).toThrow(/cannot ship app\.json/);
    expect(() => checkNoForeignManifest("skill", ["task.json"])).toThrow(/type:"task"/);
    expect(() => checkNoForeignManifest("task", [".claude-plugin/plugin.json"])).toThrow(/type:"plugin"/);
  });

  it("lets each kind ship its own manifest", () => {
    expect(() => checkNoForeignManifest("app", ["app.json", "ui/index.html"])).not.toThrow();
    expect(() => checkNoForeignManifest("task", ["task.json", "run.js"])).not.toThrow();
    expect(() => checkNoForeignManifest("skill", ["SKILL.md", "scripts/report.js"])).not.toThrow();
  });

  it("can say where every kind is seen, so an answer never invents a page", () => {
    for (const kind of ["skill", "app", "task", "plugin"] as const) {
      expect(WHERE_TO_SEE[kind]).toMatch(/Settings/);
    }
  });
});
