/**
 * The bundle-shape rules as tests: a required connection that rendered as
 * nothing (bare-string deps; his report, 2026-09-17), pinned so it cannot come
 * back, plus the authoring gate that stops an agent shipping an app when the
 * user asked for a skill.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeConnDeps, hasAppFace, NO_FACE_ERROR, checkBundlePath,
  WHERE_TO_SEE, checkNoForeignManifest, connDepNames,
} from "../../src/shared/bundle-shape";

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

describe("the connections a manifest declares, by name", () => {
  it("reads either shape, which is what a run checks a call against", () => {
    expect(connDepNames([{ app: "gmail", as: "org" }, "google_calendar"])).toEqual(["gmail", "google_calendar"]);
  });

  it("answers nothing for nothing, never [undefined]", () => {
    expect(connDepNames(undefined)).toEqual([]);
    expect(connDepNames([{ as: "member" }] as never)).toEqual([]);
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
