/**
 * The app validators — the one contract every builder and the server share.
 * The tests pin the SEVERITY BOUNDARY above all: security blocks a ship,
 * advice never does, because a lint that guesses wrong must not stand between
 * a working app and its user. Two shapes: a SOURCE project (what app_deploy
 * tars) and a BUILT bundle (what the builder zips).
 */

import { describe, it, expect } from "vitest";
import {
  validateAppBundle, validateAppProject, parseAppManifest, lintRemoteAssets,
  checkSqlDialect, KNOWN_CAPABILITIES, RETIRED_CAPABILITIES,
} from "../../src/app-spec/validate.js";

const MANIFEST = JSON.stringify({
  manifestVersion: 3, kind: "glyphh-app", name: "Fence Scout", slug: "fence-scout",
  description: "Scouts fences.", capabilities: ["db.exec", "notify.send"],
});

function bundle(overrides: Record<string, string> = {}): Record<string, string> {
  return { "manifest.json": MANIFEST, "ui/index.html": "<html><body>hi</body></html>", ...overrides };
}

const NEXT_CONFIG = `const base = process.env.GLYPHH_APP_BASE ?? "";
export default { output: "export", trailingSlash: true, basePath: base, assetPrefix: base || ".", images: { unoptimized: true } };`;

function project(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "manifest.json": MANIFEST,
    "package.json": JSON.stringify({ scripts: { build: "next build" }, dependencies: { next: "^15.5.0", react: "^19.0.0", "react-dom": "^19.0.0" } }),
    "next.config.mjs": NEXT_CONFIG,
    "app/layout.js": "export default function L({ children }) { return children; }",
    "app/page.js": "export default function P() { return null; }",
    ...overrides,
  };
}

describe("manifest (shape)", () => {
  it("accepts manifestVersion 3 without an entry", () => {
    const v = validateAppBundle(bundle());
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.manifest?.slug).toBe("fence-scout");
    expect(v.manifest?.manifestVersion).toBe(3);
  });

  it("still parses manifestVersion 2 (older bundles install) but advises the upgrade", () => {
    const m2 = JSON.stringify({ manifestVersion: 2, kind: "glyphh-app", name: "X", slug: "x", entry: "index.html", description: "d" });
    const v = validateAppBundle({ "manifest.json": m2, "ui/index.html": "<p/>" });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toContain("manifestVersion 2");
    expect(parseAppManifest(JSON.stringify({ kind: "glyphh-app", name: "X", slug: "x" }))?.manifestVersion).toBe(2);
  });

  it("rejects an unknown manifestVersion, a missing kind/name/slug, a reserved slug", () => {
    for (const bad of [
      "{not json",
      JSON.stringify({ manifestVersion: 3, name: "x", slug: "x" }),                    // no kind
      JSON.stringify({ manifestVersion: 3, kind: "glyphh-app", slug: "x" }),           // no name
      JSON.stringify({ manifestVersion: 3, kind: "glyphh-app", name: "x", slug: "_x" }), // reserved slug
      JSON.stringify({ manifestVersion: 9, kind: "glyphh-app", name: "x", slug: "x" }),  // unknown version
    ]) {
      expect(validateAppBundle({ "manifest.json": bad, "ui/index.html": "<p/>" }).ok).toBe(false);
    }
  });

  it("glyphh.app.json is no longer a manifest name", () => {
    const v = validateAppBundle({ "glyphh.app.json": MANIFEST, "ui/index.html": "<p/>" });
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain("manifest.json");
  });

  it("normalizes the slug rather than rejecting fixable input", () => {
    const m = parseAppManifest(JSON.stringify({ manifestVersion: 3, kind: "glyphh-app", name: "X", slug: "My App!" }));
    expect(m?.slug).toBe("my-app-");
  });
});

describe("a BUILT bundle", () => {
  it("needs ui/index.html — the export lives under ui/", () => {
    const v = validateAppBundle({ "manifest.json": MANIFEST, "index.html": "<p/>" });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toContain("ui/index.html");
  });
});

describe("a SOURCE project", () => {
  it("accepts the Next.js shape", () => {
    const v = validateAppProject(project());
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("needs package.json with next + a next build script", () => {
    expect(validateAppProject(project({ "package.json": JSON.stringify({ dependencies: { react: "1" }, scripts: { build: "vite build" } }) })).errors.join(" "))
      .toMatch(/depend on next.*next build|next build.*depend on next/s);
    const { "package.json": _drop, ...noPkg } = project();
    expect(validateAppProject(noPkg).ok).toBe(false);
  });

  it("needs a next.config that exports statically with the base from GLYPHH_APP_BASE", () => {
    const v = validateAppProject(project({ "next.config.mjs": "export default { basePath: '/x' };" }));
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toContain("output: 'export'");
    expect(v.errors.join(" ")).toContain("GLYPHH_APP_BASE");
  });

  it("needs an app/ or pages/ router", () => {
    const { "app/layout.js": _l, "app/page.js": _p, ...noRouter } = project();
    expect(validateAppProject(noRouter).errors.join(" ")).toContain("app/");
    expect(validateAppProject({ ...noRouter, "pages/index.js": "export default () => null" }).ok).toBe(true);
  });

  it("warns, never blocks, when build output is in the folder", () => {
    const v = validateAppProject(project({ "out/index.html": "<p/>", "node_modules/x/index.js": "module.exports = 1" }));
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toContain("node_modules");
  });
});

describe("security (errors — block a ship anywhere)", () => {
  it("refuses remote code references in built assets", () => {
    const v = validateAppBundle(bundle({ "ui/index.html": `<script src="https://cdn.example.com/x.js"></script>` }));
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain("remote asset");
  });

  it("plain <a href> links are not code — they pass", () => {
    expect(lintRemoteAssets({ "ui/index.html": `<a href="https://example.com">docs</a>` })).toEqual([]);
  });

  it("refuses a worker that reaches for network or node — in a bundle and in a project", () => {
    const m = JSON.stringify({ manifestVersion: 3, kind: "glyphh-app", name: "X", slug: "x", worker: "worker.js" });
    const worker = `const r = await fetch("https://x.example");`;
    expect(validateAppBundle({ "manifest.json": m, "ui/index.html": "<p/>", "worker.js": worker }).errors.join(" ")).toContain("forbidden APIs");
    expect(validateAppProject(project({ "manifest.json": m, "worker.js": worker })).errors.join(" ")).toContain("forbidden APIs");
  });

  it("refuses exposing agent.run as a tool", () => {
    const m = JSON.stringify({
      manifestVersion: 3, kind: "glyphh-app", name: "X", slug: "x",
      capabilities: ["agent.run"], tools: [{ name: "loop", capability: "agent.run" }],
    });
    expect(validateAppBundle({ "manifest.json": m, "ui/index.html": "<p/>" }).ok).toBe(false);
  });

  it("refuses a declared worker whose file is missing", () => {
    const m = JSON.stringify({ manifestVersion: 3, kind: "glyphh-app", name: "X", slug: "x", worker: "worker.js" });
    expect(validateAppBundle({ "manifest.json": m, "ui/index.html": "<p/>" }).ok).toBe(false);
  });
});

describe("advice (warnings — never block)", () => {
  it("unknown capabilities and bad tool xrefs warn but ship", () => {
    const m = JSON.stringify({
      manifestVersion: 3, kind: "glyphh-app", name: "X", slug: "x",
      capabilities: ["db.exec", "made.up"],
      tools: [{ name: "t", capability: "notify.send" }], // not in capabilities
    });
    const v = validateAppBundle({ "manifest.json": m, "ui/index.html": "<p/>" });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toContain("made.up");
    expect(v.warnings.join(" ")).toContain('tool "t"');
  });

  it("retired capabilities (llm.*, messages.send, contacts.search) warn with the replacement", () => {
    const m = JSON.stringify({
      manifestVersion: 3, kind: "glyphh-app", name: "X", slug: "x", worker: "worker.js",
      capabilities: ["llm.complete", "messages.send"],
    });
    const v = validateAppBundle({ "manifest.json": m, "ui/index.html": "<p/>", "worker.js": `await glyphh.call("contacts.search", { q: "x" });` });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toContain("llm.complete");
    expect(v.warnings.join(" ")).toContain("gmail or slack");
    expect(v.warnings.join(" ")).toContain("google_contacts");
    for (const c of RETIRED_CAPABILITIES.keys()) expect(KNOWN_CAPABILITIES.has(c)).toBe(false);
    expect(KNOWN_CAPABILITIES.has("app.call")).toBe(true);
  });

  it("bad cron shapes and self-call targets warn but ship", () => {
    const m = JSON.stringify({ manifestVersion: 3, kind: "glyphh-app", name: "X", slug: "x", worker: "worker.js" });
    const worker = `
      glyphh.handle("scan", async () => 1);
      await glyphh.call("cron.schedule", { expr: "08:00 * * *" });
      await glyphh.call("scan", {});
    `;
    const v = validateAppBundle({ "manifest.json": m, "ui/index.html": "<p/>", "worker.js": worker });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toContain("cron");
    expect(v.warnings.join(" ")).toContain("own handler");
  });

  it("SQLite habits in db.exec warn: ? placeholders, AUTOINCREMENT, julianday", () => {
    const notes = checkSqlDialect(`
      await glyphh.call("db.exec", { sql: "CREATE TABLE IF NOT EXISTS p (id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT)" });
      await glyphh.call("db.exec", { sql: "SELECT julianday('now') - julianday(t) FROM p WHERE n = ?", params: [1] });
    `);
    expect(notes.join(" ")).toContain("$1");
    expect(notes.join(" ")).toContain("SERIAL");
    expect(notes.join(" ")).toContain("julianday");
    expect(checkSqlDialect(`await glyphh.call("db.exec", { sql: "INSERT INTO p (t) VALUES ($1)", params: [t] });`)).toEqual([]);
  });

  it("grounds connector calls against a live catalog when given one", () => {
    const m = JSON.stringify({
      manifestVersion: 3, kind: "glyphh-app", name: "X", slug: "x", worker: "worker.js",
      capabilities: ["connector.call"], connectors: ["gmail"],
    });
    const worker = `await glyphh.call("connector.call", { connector: "gmail", tool: "Send Emailz" });`;
    const v = validateAppBundle(
      { "manifest.json": m, "ui/index.html": "<p/>", "worker.js": worker },
      (slug) => (slug === "gmail" ? ["Send Email", "Modify Labels"] : null),
    );
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toContain("doesn't exist");
  });
});
