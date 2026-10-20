/**
 * pipedream-view.test.ts — the Connections page's Pipedream logic that needs
 * no DOM (renderer/help/pipedream-view.ts).
 */

import { describe, expect, it } from "vitest";
import { connectProgressText, mergeApps, pdAppRows, projectIdProblem } from "../../src/renderer/help/pipedream-view.js";

const acct = (id: string, app: string, over: Record<string, unknown> = {}) => ({
  id, app, appName: app.toUpperCase(), icon: null as string | null, healthy: true, dead: false, createdAt: "", enabled: true, ...over,
});

describe("pdAppRows", () => {
  it("one row per app by name, every account kept, healthy when any account works", () => {
    const rows = pdAppRows([
      acct("a1", "slack", { healthy: false }),
      acct("a2", "gmail", { icon: "https://img/g.png" }),
      acct("a3", "slack", { icon: "https://img/s.png" }),
      acct("a4", "zoom", { dead: true, enabled: false }),
      acct("a5", ""),
    ]);
    expect(rows.map((r) => [r.app, r.accounts.length, r.healthy, r.enabled, r.icon])).toEqual([
      ["gmail", 1, true, true, "https://img/g.png"],
      ["slack", 2, true, true, "https://img/s.png"],
      ["zoom", 1, false, false, null],
    ]);
  });
});

describe("mergeApps", () => {
  it("appends a page without repeating an app", () => {
    const have = [{ slug: "a" }, { slug: "b" }];
    expect(mergeApps(have, [{ slug: "b" }, { slug: "c" }, { slug: "c" }])).toEqual([{ slug: "a" }, { slug: "b" }, { slug: "c" }]);
  });
});

describe("connectProgressText", () => {
  it("narrates the hand-off to the browser, and nothing once done", () => {
    expect(connectProgressText(undefined)).toBe("");
    expect(connectProgressText({ phase: "opening", app: "gmail" })).toBe("Opening Pipedream…");
    expect(connectProgressText({ phase: "waiting", app: "gmail", url: "https://x" })).toBe("Finish connecting in the Pipedream window…");
    expect(connectProgressText({ phase: "done", app: "gmail", ok: true })).toBe("");
  });
});

describe("projectIdProblem", () => {
  it("wants proj_ and an id", () => {
    expect(projectIdProblem(" proj_abc123 ")).toBe("");
    expect(projectIdProblem("")).toMatch(/required/);
    expect(projectIdProblem("abc")).toMatch(/proj_abc123/);
  });
});
