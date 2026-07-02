/**
 * app-icon-extract — macOS app-icon extraction WITHOUT app.getFileIcon.
 *
 * getFileIcon routes through NSWorkspace/NSImage into Electron's (Rust) image
 * decoder on a ThreadPoolForegroundWorker, and a malformed/unsupported icon
 * representation CHECK-crashes the whole process (SIGTRAP in
 * rust_bmp…Reader::metadata_loaded — seen twice in the wild). So on macOS we
 * extract icons ourselves, fully out-of-process:
 *
 *   1. resolve the .app bundle's .icns (Info.plist CFBundleIconFile, falling
 *      back to the first .icns in Contents/Resources)
 *   2. convert it to PNG with `sips` (separate process — a decoder crash there
 *      can't take Electron down)
 *   3. return it as a data URL
 */

import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

function run(cmd: string, args: string[], timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Locate the .icns for a .app bundle ("" when none found). */
async function resolveIcns(appPath: string): Promise<string> {
  const resources = path.join(appPath, "Contents", "Resources");
  try {
    const plist = path.join(appPath, "Contents", "Info.plist");
    if (fs.existsSync(plist)) {
      const json = await run("plutil", ["-convert", "json", "-o", "-", plist]);
      const info = JSON.parse(json) as { CFBundleIconFile?: string };
      let iconFile = String(info.CFBundleIconFile || "").trim();
      if (iconFile) {
        if (!iconFile.toLowerCase().endsWith(".icns")) iconFile += ".icns";
        const p = path.join(resources, iconFile);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch { /* fall through to the directory scan */ }
  try {
    const f = fs.readdirSync(resources).find((n) => n.toLowerCase().endsWith(".icns"));
    if (f) return path.join(resources, f);
  } catch { /* no Resources dir */ }
  return "";
}

/** PNG data URL for a macOS .app bundle's icon ("" when unresolvable). */
export async function extractMacAppIcon(appPath: string): Promise<string> {
  if (!appPath.endsWith(".app")) return "";
  const icns = await resolveIcns(appPath);
  if (!icns) return "";
  const tmp = path.join(os.tmpdir(), `glyphh-icon-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
  try {
    await run("sips", ["-s", "format", "png", icns, "--out", tmp, "--resampleHeightWidthMax", "128"]);
    const buf = fs.readFileSync(tmp);
    return buf.length ? `data:image/png;base64,${buf.toString("base64")}` : "";
  } catch {
    return "";
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}
