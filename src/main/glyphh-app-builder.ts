/**
 * App install path — validate + package + install a Glyphh app from source.
 *
 * The one-shot LLM builder (create_app / buildGlyphhApp) is retired: frontier
 * agents build apps as REAL Vite projects in the working folder now, and the
 * loop ships them through update_app → updateAppFromWorkdir → the host's
 * install gate. Two shapes are handled:
 *   - BUILT Vite project (glyphh.app.json + dist/index.html) → package the
 *     compiled dist/ (flattened) + manifest + worker; source never ships.
 *   - Legacy single-file app (manifest.json + inline index.html) → package the
 *     working folder's files as before.
 */

import AdmZip from "adm-zip";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getExplicitWorkingDirectory } from "./working-directory";
import { validateBundle, type Bundle } from "./glyphh-app-oracle";
import { collectBuiltProject, manifestPathIn, lintNoRemoteAssets, type InstallFile } from "./glyphh-app-spec";
import { installGlyphhAppBundle } from "./glyphh-app-host";

/** Zip a text Bundle and run it through the host's real install gate. */
async function packageAndInstall(bundle: Bundle): Promise<{ ok: boolean; name?: string; error?: string }> {
  const zip = new AdmZip();
  for (const [file, content] of Object.entries(bundle)) {
    zip.addFile(file, Buffer.from(content, "utf8"));
  }
  return installZip(zip);
}

/** Zip on-disk files (binary-safe) + a normalized manifest, then install. */
async function packageBuiltAndInstall(files: InstallFile[], manifestJson: string): Promise<{ ok: boolean; name?: string; error?: string }> {
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(manifestJson, "utf8"));
  for (const f of files) {
    if (f.archivePath === "manifest.json") continue; // manifest is authoritative above
    try { zip.addLocalFile(f.absPath, path.dirname(f.archivePath) || undefined, path.basename(f.archivePath)); }
    catch { /* unreadable file — skip */ }
  }
  return installZip(zip);
}

async function installZip(zip: AdmZip): Promise<{ ok: boolean; name?: string; error?: string }> {
  const tmp = path.join(os.tmpdir(), `glyphh-build-${Date.now().toString(36)}.glyphh`);
  fs.writeFileSync(tmp, zip.toBuffer());
  try {
    return await installGlyphhAppBundle(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* tmp gone */ }
  }
}

/** The app-source directory inside the working folder: the root when it holds
 *  a manifest (glyphh.app.json | manifest.json), else the newest subfolder that
 *  does. */
function resolveAppDir(wd: string): string {
  if (manifestPathIn(wd)) return wd;
  const sub = fs.readdirSync(wd)
    .map((n) => path.join(wd, n))
    .filter((p) => { try { return fs.statSync(p).isDirectory() && manifestPathIn(p) !== null; } catch { return false; } })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!sub) throw new Error("no glyphh.app.json / manifest.json in the working folder — nothing to update");
  return sub;
}

/**
 * The iteration loop's return path: re-validate + re-install the app from the
 * WORKING FOLDER's source. Built Vite projects ship their compiled dist/;
 * legacy single-file apps ship their folder files. The agent edits + rebuilds,
 * calls update_app, and the installed app catches up.
 */
export async function updateAppFromWorkdir(
  lookup?: (slug: string) => string[] | null,
): Promise<{ slug: string; name: string; warnings: string[] }> {
  const wd = getExplicitWorkingDirectory();
  if (!wd) throw new Error("no working folder is set");
  const dir = resolveAppDir(wd);

  // ── Built Vite project: package dist/ (compiled) — never src/node_modules ──
  const built = collectBuiltProject(dir);
  if (built) {
    // Defense in depth over the runtime CSP: refuse a bundle whose built
    // assets reference remote code, even though the CSP would block it.
    const textAssets: Record<string, string> = {};
    for (const f of built.files) {
      if (!/\.(html?|css|m?js|jsx|ts|tsx)$/i.test(f.archivePath)) continue;
      try { if (fs.statSync(f.absPath).size < 2_000_000) textAssets[f.archivePath] = fs.readFileSync(f.absPath, "utf8"); }
      catch { /* skip unreadable */ }
    }
    const remote = lintNoRemoteAssets({ ...textAssets, "manifest.json": built.manifestJson });
    if (remote.length) throw new Error(`build ships remote assets (bundle them instead): ${remote.join("; ")}`);

    const r = await packageBuiltAndInstall(built.files, built.manifestJson);
    if (!r.ok) throw new Error(r.error || "install failed");
    const m = JSON.parse(built.manifestJson) as { slug: string; name: string };
    return { slug: m.slug, name: r.name || m.name, warnings: [] };
  }

  // ── Legacy single-file app: package the folder's text files as before ─────
  const bundle: Bundle = {};
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f);
    try {
      if (fs.statSync(abs).isFile() && fs.statSync(abs).size < 512_000) bundle[f] = fs.readFileSync(abs, "utf8");
    } catch { /* unreadable — skip */ }
  }
  const remote = lintNoRemoteAssets(bundle);
  if (remote.length) throw new Error(`app references remote assets (inline or bundle them instead): ${remote.join("; ")}`);
  const v = validateBundle(bundle, lookup);
  if (!v.ok) throw new Error(`source fails validation: ${v.errors.join("; ")}`);
  const r = await packageAndInstall(bundle);
  if (!r.ok) throw new Error(r.error || "install failed");
  return { slug: v.manifest!.slug, name: r.name || v.manifest!.name, warnings: v.warnings };
}
