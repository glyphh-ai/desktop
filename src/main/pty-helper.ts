/**
 * pty-helper — node-pty's spawn-helper must be executable (macOS / Linux).
 *
 * node-pty 1.1.0 publishes prebuilds/<platform>-<arch>/spawn-helper without
 * the execute bit, so every pty spawn fails with "posix_spawnp failed"
 * (2026-10-20, a fresh npm install of @glyphh-ai/desktop). The install script
 * (scripts/postinstall.mjs) sets it; this is checked again before the first
 * spawn, because npm can skip install scripts.
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const req = createRequire(__filename);

/** The spawn-helper paths node-pty may load on this platform. */
export function spawnHelperPaths(ptyDir: string, platform = process.platform, arch = process.arch): string[] {
  if (platform === "win32") return [];
  return [
    path.join(ptyDir, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
    path.join(ptyDir, "build", "Release", "spawn-helper"),
  ];
}

/** Make each spawn-helper that exists executable; returns the ones it changed. */
export function ensureSpawnHelpersExecutable(ptyDir: string, platform = process.platform, arch = process.arch): string[] {
  const fixed: string[] = [];
  for (const file of spawnHelperPaths(ptyDir, platform, arch)) {
    let mode: number;
    try { mode = fs.statSync(file).mode; } catch { continue; }
    if ((mode & 0o111) === 0o111) continue;
    fs.chmodSync(file, mode | 0o755);
    fixed.push(file);
  }
  return fixed;
}

let checked = false;
/** Once per process: node-pty's own folder, made ready to spawn. */
export function ensurePtyReady(): void {
  if (checked) return;
  checked = true;
  try {
    const dir = path.dirname(req.resolve("node-pty/package.json"));
    const fixed = ensureSpawnHelpersExecutable(dir);
    if (fixed.length) console.warn("[pty] made spawn-helper executable", JSON.stringify(fixed));
  } catch (err) {
    console.warn("[pty] could not check spawn-helper", err instanceof Error ? err.message : String(err));
  }
}
