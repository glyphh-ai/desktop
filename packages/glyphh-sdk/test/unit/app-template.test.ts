/**
 * The Next.js app template ships INSIDE the SDK (appTemplateFiles()) and as a
 * folder (templates/app-next). They are one thing: the generated module must
 * match the folder byte for byte, and the template must pass the project
 * validator with no errors — a builder that starts from it starts green.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { appTemplateFiles, validateAppProject, GLYPHH_APP_SPEC } from "../../src/app-spec/index.js";

const FOLDER = join(__dirname, "..", "..", "templates", "app-next");

function readFolder(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else files[relative(dir, abs).split("\\").join("/")] = readFileSync(abs, "utf8");
    }
  };
  walk(dir);
  return files;
}

describe("templates/app-next", () => {
  it("is what appTemplateFiles() returns (run `npm run gen:app-template` after editing the folder)", () => {
    expect(appTemplateFiles()).toEqual(readFolder(FOLDER));
  });

  it("returns a fresh copy each call", () => {
    const a = appTemplateFiles();
    a["manifest.json"] = "{}";
    expect(appTemplateFiles()["manifest.json"]).not.toBe("{}");
  });

  it("carries the files the spec names", () => {
    const files = appTemplateFiles();
    for (const p of ["manifest.json", "package.json", "next.config.mjs", "app/layout.js", "app/page.js", "worker.js", "README.md"]) {
      expect(files[p], p).toBeTruthy();
    }
  });

  it("passes the project validator with no errors and no warnings", () => {
    const v = validateAppProject(appTemplateFiles());
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.manifest?.manifestVersion).toBe(3);
    expect(v.manifest?.tools.map((t) => t.name)).toEqual(["add_note"]);
  });

  it("has the next.config the spec prescribes and no entry in the manifest", () => {
    const files = appTemplateFiles();
    const cfg = files["next.config.mjs"]!;
    for (const needle of ["output: \"export\"", "trailingSlash: true", "process.env.GLYPHH_APP_BASE", "unoptimized: true"]) {
      expect(cfg).toContain(needle);
    }
    expect(JSON.parse(files["manifest.json"]!)).not.toHaveProperty("entry");
    expect(JSON.parse(files["package.json"]!).scripts.build).toBe("next build");
  });

  it("the spec text describes this spec — Next.js, Postgres, Neo4j, the one install door by path; nothing hosted", () => {
    for (const needle of ["manifestVersion", "next.config.mjs", "GLYPHH_APP_BASE", "$1", "Cypher", "app_install { dir", "glyphh_app_scaffold", "app_build_status", "app_pin", "{ ok: true, result }"]) {
      expect(GLYPHH_APP_SPEC).toContain(needle);
    }
    // app_deploy is gone (2026-10-07): the folder goes up by path, never as base64 through the model.
    for (const gone of ["<slug>.glyphh.app", ".glyphh.app origin", "glyphh.app.json", "publish", "SQLite", "CREATE NODE TABLE Person", "update_app", "vite", "app_deploy", "bundleBase64"]) {
      expect(GLYPHH_APP_SPEC.includes(gone), gone).toBe(false);
    }
  });
});
