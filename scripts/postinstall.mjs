#!/usr/bin/env node
/**
 * postinstall — make the native modules load in Electron WITHOUT a compiler.
 *
 * node-pty (1.1+) and kuzu ship ready-built Node-API binaries, which Electron
 * loads as they are. better-sqlite3 is the one module built against V8, so it
 * needs the binary made for Electron's ABI: prebuild-install downloads it from
 * better-sqlite3's own GitHub releases. Only if that download fails (an
 * Electron too new to have one yet, no network) does it fall back to
 * electron-rebuild, which compiles and so needs Xcode / build tools.
 *
 * The old postinstall ran electron-rebuild over EVERY native module, which
 * compiled node-pty from source and failed on any Mac without the Command Line
 * Tools (2026-10-20).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function electronVersion() {
  try { return require("electron/package.json").version; } catch { return null; }
}

function moduleDir(name) {
  try { return path.dirname(require.resolve(`${name}/package.json`)); } catch { return null; }
}

// node-pty 1.1.0 publishes its spawn-helper without the execute bit, and every
// terminal then fails with "posix_spawnp failed" (src/main/pty-helper.ts checks
// it again at the first spawn, for an install that skipped scripts).
const ptyDir = moduleDir("node-pty");
if (ptyDir && process.platform !== "win32") {
  for (const file of [path.join(ptyDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"), path.join(ptyDir, "build", "Release", "spawn-helper")]) {
    try { fs.chmodSync(file, fs.statSync(file).mode | 0o755); } catch { /* not on this platform */ }
  }
}

const version = electronVersion();
const sqliteDir = moduleDir("better-sqlite3");
if (!version || !sqliteDir) {
  console.log("[glyphh] postinstall: electron or better-sqlite3 is not installed here, nothing to do");
  process.exit(0);
}

const prebuildBin = (() => {
  try { return require.resolve("prebuild-install/bin.js", { paths: [sqliteDir] }); } catch { return null; }
})();

if (prebuildBin) {
  try {
    execFileSync(process.execPath, [prebuildBin, "--runtime", "electron", "--target", version, "--arch", process.arch, "--platform", process.platform], { cwd: sqliteDir, stdio: "inherit" });
    console.log(`[glyphh] better-sqlite3 ready for Electron ${version}`);
    process.exit(0);
  } catch {
    console.warn(`[glyphh] no ready-built better-sqlite3 for Electron ${version}; building it instead (needs build tools)`);
  }
}

const rebuildBin = (() => {
  try { return require.resolve("@electron/rebuild/lib/cli.js"); } catch { return null; }
})();
if (!rebuildBin) {
  console.error("[glyphh] could not prepare better-sqlite3 for Electron: @electron/rebuild is missing");
  process.exit(1);
}
execFileSync(process.execPath, [rebuildBin, "--only", "better-sqlite3", "--version", version], { stdio: "inherit" });
