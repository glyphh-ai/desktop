/**
 * node-pty's spawn-helper ships without the execute bit (node-pty 1.1.0);
 * the first spawn makes it executable, and leaves a good one alone.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSpawnHelpersExecutable, spawnHelperPaths } from "../../src/main/pty-helper.js";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "glyphh-pty-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function helper(rel: string, mode: number): string {
  const file = join(dir, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, mode);
  return file;
}

describe("spawn-helper", () => {
  it("looks in the platform's prebuild and the local build, never on Windows", () => {
    expect(spawnHelperPaths(dir, "darwin", "arm64")).toEqual([
      join(dir, "prebuilds", "darwin-arm64", "spawn-helper"),
      join(dir, "build", "Release", "spawn-helper"),
    ]);
    expect(spawnHelperPaths(dir, "win32", "x64")).toEqual([]);
  });

  it("makes a non-executable helper executable and leaves a good one alone", () => {
    const bad = helper("prebuilds/darwin-arm64/spawn-helper", 0o644);
    const good = helper("build/Release/spawn-helper", 0o755);
    expect(ensureSpawnHelpersExecutable(dir, "darwin", "arm64")).toEqual([bad]);
    expect(statSync(bad).mode & 0o111).toBe(0o111);
    expect(statSync(good).mode & 0o777).toBe(0o755);
    expect(ensureSpawnHelpersExecutable(dir, "darwin", "arm64")).toEqual([]);
  });

  it("skips helpers that are not there", () => {
    expect(ensureSpawnHelpersExecutable(dir, "linux", "x64")).toEqual([]);
  });
});
