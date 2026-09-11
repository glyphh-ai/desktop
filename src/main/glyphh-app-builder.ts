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
import { createHash } from "node:crypto";
import { getExplicitWorkingDirectory } from "./working-directory";
import { validateAppBundle, lintRemoteAssets, type AppBundle } from "@glyphh/sdk";
import { collectBuiltProject, manifestPathIn, type InstallFile } from "./glyphh-app-spec";
import { installGlyphhAppBundle, registerAppInPlace } from "./glyphh-app-host";
import * as appsStore from "./apps-store";

// The ten built-in work panels (Office / Design / Memory / Media) are
// Apps-page fixtures, not org apps — an install or deploy under their slugs is
// refused at the manifest, where the slug first exists (glyphh-agent-tools.ts
// and apps-ipc.ts refuse the slug-carrying seams the same way).
const BUILTIN_WORKPANELS = new Set(["gpoint", "gdoc", "gsheet", "gdrive"]);

/** Throw the refusal when a workdir manifest names a built-in work panel. */
function refuseBuiltinWorkpanel(slug: string): void {
  if (BUILTIN_WORKPANELS.has(slug)) {
    throw new Error("work panels are built in — they cannot be altered or removed");
  }
}

/** Zip a text Bundle and run it through the host's real install gate. */
async function packageAndInstall(bundle: AppBundle): Promise<{ ok: boolean; name?: string; error?: string }> {
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
): Promise<{ slug: string; name: string; warnings: string[]; entryPath?: string }> {
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
    const remote = lintRemoteAssets({ ...textAssets, "manifest.json": built.manifestJson });
    if (remote.length) throw new Error(`build ships remote assets (bundle them instead): ${remote.join("; ")}`);

    const m = JSON.parse(built.manifestJson) as { slug: string; name: string };
    refuseBuiltinWorkpanel(m.slug);
    // RUN IN PLACE (his rule, 2026-08-30): register the working folder's build where
    // it lives — no copy into custom-apps. open_app then opens the developer's ACTUAL
    // build (a rebuild shows on the next open); copy-install (installGlyphhAppBundle)
    // is reserved for installing someone else's PUBLISHED app.
    const r = await registerAppInPlace(dir, built.manifestJson);
    if (!r.ok) throw new Error(r.error || "register failed");
    // Name WHERE it registered — "success" without the path made a
    // stale-row open failure undiagnosable (2026-09-09).
    return { slug: m.slug, name: r.name || m.name, warnings: [], entryPath: path.join(dir, "dist", "index.html") };
  }

  // ── Legacy single-file app: package the folder's text files as before ─────
  const bundle: AppBundle = {};
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f);
    try {
      if (fs.statSync(abs).isFile() && fs.statSync(abs).size < 512_000) bundle[f] = fs.readFileSync(abs, "utf8");
    } catch { /* unreadable — skip */ }
  }
  const remote = lintRemoteAssets(bundle);
  if (remote.length) throw new Error(`app references remote assets (inline or bundle them instead): ${remote.join("; ")}`);
  const v = validateAppBundle(bundle, lookup);
  if (!v.ok) throw new Error(`source fails validation: ${v.errors.join("; ")}`);
  refuseBuiltinWorkpanel(v.manifest!.slug);
  const r = await packageAndInstall(bundle);
  if (!r.ok) throw new Error(r.error || "install failed");
  return { slug: v.manifest!.slug, name: r.name || v.manifest!.name, warnings: v.warnings };
}

/**
 * PUBLISH the working folder's built app to the web at <slug>.glyphh.app.
 *
 * Unlike updateAppFromWorkdir (which installs the app LOCALLY on this machine),
 * this ships the compiled dist/ to the control plane: ensure the owned app
 * entry exists, cut a release, upload the static source (the server builds +
 * serves it), and deploy it live. Returns the release outcome — `ready` with a
 * public URL, or `failed` with the build error to fix.
 */
/** Folders never packed into the SOURCE snapshot — build products + machinery
 *  (mirrors the pod's source-sync rules; the two must agree byte-for-byte so
 *  identical trees hash identically). */
const SOURCE_EXCLUDES = new Set(["node_modules", "dist", ".git", ".glyphh", "build", ".next", "coverage"]);

/** Pack the PROJECT SOURCE (not dist) as the deterministic snapshot archive. */
function packProjectSource(dir: string): Buffer {
  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SOURCE_EXCLUDES.has(e.name)) walk(rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) {
        files.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  walk("");
  files.sort();
  const zip = new AdmZip();
  for (const rel of files) zip.addFile(rel, fs.readFileSync(path.join(dir, rel)));
  return zip.toBuffer();
}

export async function deployAppFromWorkdir(expectSlug?: string, opts: { deploy?: boolean } = {}): Promise<{ slug: string; version: string; status: string; url?: string; error?: string }> {
  // THE PURGE (2026-09-10): the build IS the deliverable, and it lives HERE.
  // No control plane, no upload, no hosting — validate the working folder's
  // built project, register it to run in place (the same rails update_app
  // rides), and advance the LOCAL row's version so the Releases surface has
  // an honest story. Sharing an app's source is git's job now.
  void opts;
  const wd = getExplicitWorkingDirectory();
  if (!wd) throw new Error("no working folder is set");
  const dir = resolveAppDir(wd);

  const built = collectBuiltProject(dir);
  if (!built) {
    throw new Error("no built app found — for a Vite project run `npm run build` first (needs glyphh.app.json + dist/index.html)");
  }
  const manifest = JSON.parse(built.manifestJson) as { slug: string; name: string; version?: string };
  const slug = manifest.slug;
  refuseBuiltinWorkpanel(slug);
  // The Releases tab builds FOR a specific app — refuse if the working folder
  // holds a different project, so a stray cwd can't cut under the wrong slug.
  if (expectSlug && slug !== expectSlug) {
    throw new Error(`the working folder builds '${slug}', not '${expectSlug}' — open that app's project folder and try again`);
  }

  // Same remote-asset guard the local install runs.
  const textAssets: Record<string, string> = {};
  for (const f of built.files) {
    if (!/\.(html?|css|m?js|jsx|ts|tsx)$/i.test(f.archivePath)) continue;
    try { if (fs.statSync(f.absPath).size < 2_000_000) textAssets[f.archivePath] = fs.readFileSync(f.absPath, "utf8"); }
    catch { /* skip unreadable */ }
  }
  const remote = lintRemoteAssets(textAssets);
  if (remote.length) throw new Error(`build ships remote assets (bundle them instead): ${remote.join("; ")}`);

  const r = await registerAppInPlace(dir, built.manifestJson);
  if (!r.ok) return { slug, version: "", status: "failed", error: r.error };

  // Version: bump the local row's patch (a manifest version seeds the first).
  const row = (await appsStore.mine()).find((a) => a.slug === slug);
  const base = row?.version || manifest.version || "0.1.0";
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(base);
  const version = m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "0.1.1";
  await appsStore.markBuilt(slug, version);
  return { slug, version, status: "ready" };
}

export async function pullAppSource(slug: string, _opts: { hash?: string; merge?: boolean } = {}): Promise<{ slug: string; hash: string; dir: string; files: number; merged?: boolean }> {
  refuseBuiltinWorkpanel(slug);
  // THE PURGE: the source-of-record service is retired — app source shares
  // through git now (clone/pull the project repo into the working folder).
  throw new Error("app source sync is retired — share this app's project through git (clone or pull its repo into the working folder)");
}

export async function commitAppSource(_message: string): Promise<{ slug: string; hash: string; noop: boolean }> {
  // THE PURGE: retired with the source-of-record service — use git.
  throw new Error("app source snapshots are retired — commit this project with git instead");
}

export interface R2SourceStatus {
  slug: string | null;
  localHash: string | null;
  head: { hash: string; parentHash: string | null; createdAt: string; createdByEmail: string | null } | null;
  /** Local tree ≠ the R2 head — the drift flag. */
  drifted: boolean;
  history: Array<{ hash: string; parentHash: string | null; createdAt: string; createdByEmail: string | null; isHead: boolean }>;
}

/** The app project dir inside a working folder — the folder itself when it
 *  isn't an app project (the R2 lane then reports slug null, not an error). */
export function appDirInWorkdir(wd: string): string {
  try { return resolveAppDir(wd); } catch { return wd; }
}

/** The folder's app slug, or null when it isn't an app project. */
function slugOfDir(dir: string): string | null {
  const mf = manifestPathIn(dir);
  if (!mf) return null;
  try { return (JSON.parse(fs.readFileSync(mf, "utf8")) as { slug?: string }).slug ?? null; }
  catch { return null; }
}

/** sha256 of the deterministic source archive — comparable with the server's
 *  snapshot hashes (both sides hash the same packProjectSource bytes). */
function localTreeHash(dir: string): { archive: Buffer; hash: string } {
  const archive = packProjectSource(dir);
  const hash = createHash("sha256").update(archive).digest("hex");
  return { archive, hash };
}

export async function r2SourceStatus(dir: string): Promise<R2SourceStatus> {
  // THE PURGE: no remote source-of-record — the lane reports the local hash
  // and no head, so every consumer (fs.r2Diff, the History tab) sees a
  // clean "nothing remote" state instead of an error.
  const slug = slugOfDir(dir);
  if (!slug) return { slug: null, localHash: null, head: null, drifted: false, history: [] };
  const { hash: localHash } = localTreeHash(dir);
  return { slug, localHash, head: null, drifted: false, history: [] };
}

export async function r2DiffWorkdir(dir: string): Promise<{ status: R2SourceStatus; text: string; error?: string }> {
  // THE PURGE: no remote head to diff against — the lane answers empty.
  const status = await r2SourceStatus(dir);
  return { status, text: "" };
}
