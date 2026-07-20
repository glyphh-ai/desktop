/**
 * Glyphh app PACKAGING — the fs-bound half of shipping an app: built-project
 * detection, dist-only file collection, and the project .gitignore.
 *
 * The spec text and ALL validation live in @glyphh/client (app-spec/): one
 * authority shared by this desktop, external builders, and the server, so a
 * bundle that passes here passes everywhere. This module only touches disk.
 */

import fs from "node:fs";
import path from "node:path";

/** Standard .gitignore for a Glyphh app project — keeps deps and build output
 *  (and secrets) out of history. Written by git_init. */
export const APP_GITIGNORE = [
  "# Dependencies",
  "node_modules/",
  "",
  "# Build output (shipped via update_app, never committed)",
  "dist/",
  "",
  "# Env / secrets",
  ".env",
  ".env.*",
  "",
  "# OS / editor cruft",
  ".DS_Store",
  "*.log",
  "",
].join("\n");


// ── Built-project detection + dist-only file collection ─────────────────────

export interface InstallFile { archivePath: string; absPath: string }

/** The manifest filename this project uses (new spec prefers glyphh.app.json;
 *  legacy uses manifest.json). Null when neither exists. */
export function manifestPathIn(dir: string): string | null {
  for (const name of ["glyphh.app.json", "manifest.json"]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function walk(dir: string, base = ""): InstallFile[] {
  const out: InstallFile[] = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(abs, rel));
    else if (st.isFile()) out.push({ archivePath: rel, absPath: abs });
  }
  return out;
}

/**
 * A BUILT Vite project = a manifest at root + a dist/ dir with index.html.
 * The installable bundle flattens dist/ to the archive root (so entry stays
 * "index.html" — identical layout to legacy single-file apps, so the host's
 * serving, CSP, and egress guards are unchanged) and adds the manifest
 * (normalized to manifest.json, entry=index.html) + worker.js if present.
 * Returns null when the folder isn't a built project (→ caller uses the
 * legacy whole-folder path).
 */
export function collectBuiltProject(dir: string): { files: InstallFile[]; manifestJson: string } | null {
  const manifestPath = manifestPathIn(dir);
  if (!manifestPath) return null;
  const distDir = path.join(dir, "dist");
  if (!fs.existsSync(path.join(distDir, "index.html"))) return null; // not built (or legacy)

  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { return null; }
  if (manifest?.kind !== "glyphh-app") return null;
  // The flattened bundle serves index.html from the root.
  manifest.entry = "index.html";

  const files: InstallFile[] = walk(distDir); // dist/* → bundle root
  const workerName = typeof manifest.worker === "string" ? manifest.worker.trim() : "";
  if (workerName) {
    const workerAbs = path.join(dir, workerName);
    if (fs.existsSync(workerAbs)) files.push({ archivePath: path.basename(workerName), absPath: workerAbs });
    manifest.worker = path.basename(workerName);
  }
  return { files, manifestJson: JSON.stringify(manifest, null, 2) };
}
