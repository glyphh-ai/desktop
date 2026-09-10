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
import { getClient } from "./glyphh-client";

// The ten built-in work panels (Office / Design / Memory / Media) are
// Apps-page fixtures, not org apps — an install or deploy under their slugs is
// refused at the manifest, where the slug first exists (glyphh-agent-tools.ts
// and apps-ipc.ts refuse the slug-carrying seams the same way).
const BUILTIN_WORKPANELS = new Set(["gpoint", "gdoc", "gsheet", "gdrive", "gdesign", "gimage", "gvideo", "gsound"]);

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
  // The Releases tab builds FOR a specific app — refuse before any upload if
  // the working folder holds a different project, so a stray cwd can't cut a
  // release (or deploy) under the wrong slug.
  if (expectSlug && slug !== expectSlug) {
    throw new Error(`the working folder builds '${slug}', not '${expectSlug}' — open that app's project folder and try again`);
  }

  // Same remote-asset guard the local install runs — hosted apps get the same CSP.
  const textAssets: Record<string, string> = {};
  for (const f of built.files) {
    if (!/\.(html?|css|m?js|jsx|ts|tsx)$/i.test(f.archivePath)) continue;
    try { if (fs.statSync(f.absPath).size < 2_000_000) textAssets[f.archivePath] = fs.readFileSync(f.absPath, "utf8"); }
    catch { /* skip unreadable */ }
  }
  const remote = lintRemoteAssets(textAssets);
  if (remote.length) throw new Error(`build ships remote assets (bundle them instead): ${remote.join("; ")}`);

  // Zip the built STATIC files (index.html at root + assets) — this is the
  // hosted source the server serves directly, not a .glyphh panel bundle.
  const zip = new AdmZip();
  for (const f of built.files) {
    if (f.archivePath === "manifest.json" || /\.glyphh-worker\b/.test(f.archivePath)) continue;
    try { zip.addLocalFile(f.absPath, path.dirname(f.archivePath) || undefined, path.basename(f.archivePath)); }
    catch { /* skip unreadable */ }
  }
  const archive = zip.toBuffer();

  const client = getClient();
  // THE APP ID IS THE IDENTITY (his rule, 2026-08-19): create the entry and
  // address the whole release/deploy chain by the returned GLOBALLY UNIQUE id
  // — the server may mint the slug away from the manifest's (collisions across
  // orgs), and slug-addressing after that targets someone else's app or 404s.
  let appRef = "";
  let liveSlug = slug;
  try {
    const entry = await client.apps.createEntry({ kind: "glyphh", slug, name: manifest.name });
    appRef = entry.id;
    liveSlug = entry.slug || slug;
  } catch {
    // Already registered — find OUR app (never a foreign one) and use its id.
    const mine = await client.apps.mine().catch(() => [] as Array<{ id?: string; slug: string }>);
    const own = mine.find((a) => a.slug === slug);
    if (own?.id) appRef = own.id;
  }
  const ref = appRef || slug;   // old servers: slug keeps working

  // The SERVER owns the version: it releases at the app's steered "next
  // version" (free-patch-bumped) and advances it. Basing on the local
  // manifest's version silently ignored the author's Set on the Releases tab.
  const release = await client.apps.createRelease(ref, {});
  const version = release.version;
  const outcome = await client.apps.uploadSource(ref, release.id, new Uint8Array(archive));
  if (outcome.status !== "ready") {
    return { slug: liveSlug, version, status: outcome.status, error: outcome.error ?? undefined };
  }
  // THE SOURCE OF RECORD rides every desktop build (his bug, 2026-08-25:
  // a button-built app had no snapshot, so the web's build-from-source had
  // nothing to pull — "built locally, it should just work"). Fast-forward
  // from the current head; best-effort, the release itself already stands.
  let sourceWarning: string | undefined;
  try {
    const head = await client.apps.sourceHead(ref).catch(() => null);
    await client.apps.pushSource(ref, new Uint8Array(packProjectSource(dir)), {
      baseHash: head?.head?.hash ?? null,
      note: `build v${version}`,
    });
  } catch (e) {
    // LOUD, not silent (his bug, 2026-08-25: a 404 here cost three round
    // trips) — the release stands, but the user must know web rebuilds
    // did not turn on. A CAS conflict (someone else pushed first) points
    // straight at the merge move (co-working, 2026-09-01).
    const msg = (e as Error).message;
    sourceWarning = /conflict|stale|409|moved/i.test(msg)
      ? `source head MOVED under this build (${msg}) — a collaborator pushed first. Run pull_app({ slug: "${liveSlug}", merge: true }), reconcile the upstream tree into the project, then rebuild.`
      : `source snapshot push failed (${msg}) — web builds stay unavailable for this app`;
  }

  // "No hosting": the build is the deliverable — cut, uploaded, ready, never
  // published to an address.
  if (opts.deploy === false) return { slug: liveSlug, version, status: "ready", ...(sourceWarning ? { error: sourceWarning } : {}) };
  // Deploy EXACTLY the release we just built + uploaded — pinned by id, so a
  // stale "newest ready" (e.g. an old release whose source has since been
  // lost from storage) can never be what actually ships.
  const dep = await client.hosting.deploy({ appSlug: ref, releaseId: release.id });
  return { slug: liveSlug, version, status: "ready", url: dep.url ?? undefined, ...(sourceWarning ? { error: sourceWarning } : {}) };
}

/**
 * Co-working pull (docs/app-ownership.md): fetch the app's SOURCE-OF-RECORD
 * snapshot from the control plane into the working folder, so a collaborator
 * (or the owner on another machine) picks up the latest tree and enters the
 * normal edit → build → update_app loop. Read access is the server's call —
 * owner, any collaborator, or an org admin of the publisher org.
 */
export async function pullAppSource(slug: string, opts: { hash?: string; merge?: boolean } = {}): Promise<{ slug: string; hash: string; dir: string; files: number; merged?: boolean }> {
  refuseBuiltinWorkpanel(slug);
  const wd = getExplicitWorkingDirectory();
  if (!wd) throw new Error("no working folder is set — set one first, the source extracts there");

  const client = getClient();
  // An explicit hash restores THAT snapshot (the History tab's Restore);
  // otherwise the chain head.
  let hash = opts.hash ?? null;
  if (!hash) {
    const head = await client.apps.sourceHead(slug);
    if (!head.head) {
      throw new Error(`'${slug}' has no source snapshot yet — a desktop build (its owner's deploy) creates the first one`);
    }
    hash = head.head.hash;
  }
  const bytes = await client.apps.pullSource(slug, hash);
  const zip = new AdmZip(Buffer.from(bytes));

  // MERGE mode (co-working, his order 2026-09-01): never overwrite local work.
  // The snapshot extracts BESIDE the project (.glyphh/upstream-<hash>) and the
  // AGENT reconciles the two trees — an LLM three-way beats conflict markers
  // for the people building these apps.
  if (opts.merge) {
    const projectDir = (() => { try { return resolveAppDir(wd); } catch { return wd; } })();
    const dest = path.join(projectDir, ".glyphh", `upstream-${hash.slice(0, 12)}`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    zip.extractAllTo(dest, true);
    return { slug, hash, dir: dest, files: entries.length, merged: true };
  }

  // Destination: the working folder itself when it IS this app's project;
  // otherwise <workdir>/<slug>. A non-empty destination must already be this
  // app (its manifest names the slug) — never overwrite a stranger's tree.
  let dest = path.join(wd, slug);
  const wdManifest = manifestPathIn(wd);
  if (wdManifest) {
    try {
      const m = JSON.parse(fs.readFileSync(wdManifest, "utf8")) as { slug?: string };
      if (m.slug === slug) dest = wd;
      else throw new Error(`the working folder holds '${m.slug ?? "another app"}', not '${slug}' — open a different folder`);
    } catch (e) {
      if (e instanceof Error && e.message.includes("working folder holds")) throw e;
      // unreadable manifest — fall through to the <workdir>/<slug> subfolder
    }
  }
  if (dest !== wd && fs.existsSync(dest)) {
    const destManifest = manifestPathIn(dest);
    const nonEmpty = fs.readdirSync(dest).length > 0;
    if (nonEmpty && !destManifest) {
      throw new Error(`'${dest}' already exists and is not a Glyphh app project — move it aside or pull into an empty folder`);
    }
    if (destManifest) {
      try {
        const m = JSON.parse(fs.readFileSync(destManifest, "utf8")) as { slug?: string };
        if (m.slug && m.slug !== slug) {
          throw new Error(`'${dest}' holds '${m.slug}', not '${slug}' — move it aside first`);
        }
      } catch (e) {
        if (e instanceof Error && (e.message.includes("move it aside") || e.message.includes("not a Glyphh app"))) throw e;
        // unreadable manifest — same-named folder, treat as this app's stale copy
      }
    }
  }
  fs.mkdirSync(dest, { recursive: true });
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  zip.extractAllTo(dest, true);
  return { slug, hash, dir: dest, files: entries.length };
}

/**
 * COMMIT the working folder's source as a snapshot with a message — the light
 * git's `git commit` (his order, 2026-09-01). Pure versioning: no build, no
 * install, no deploy. Fast-forwards from the current head; a moved head
 * surfaces as the merge instruction, same as a build's push.
 */
export async function commitAppSource(message: string): Promise<{ slug: string; hash: string; noop: boolean }> {
  const wd = getExplicitWorkingDirectory();
  if (!wd) throw new Error("no working folder is set");
  const dir = appDirInWorkdir(wd);
  const slug = slugOfDir(dir);
  if (!slug) throw new Error("the working folder holds no app project (glyphh.app.json / manifest.json)");
  refuseBuiltinWorkpanel(slug);
  const client = getClient();
  const head = await client.apps.sourceHead(slug).catch(() => null);
  const out = await client.apps.pushSource(slug, new Uint8Array(packProjectSource(dir)), {
    baseHash: head?.head?.hash ?? null,
    note: message.slice(0, 500),
  });
  return { slug, hash: out.hash, noop: !!out.noop };
}

// ── R2 versioning surface (his order, 2026-09-01): the diff panel + History
// tab read these. An app is "R2-versioned" when its project folder carries a
// manifest AND the control plane holds a source snapshot chain for its slug.

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
  const slug = slugOfDir(dir);
  if (!slug) return { slug: null, localHash: null, head: null, drifted: false, history: [] };
  const { hash: localHash } = localTreeHash(dir);
  const client = getClient();
  const head = await client.apps.sourceHead(slug).then((r) => r.head).catch(() => null);
  const history = head ? await client.apps.sourceHistory(slug).catch(() => []) : [];
  return { slug, localHash, head, drifted: !!head && head.hash !== localHash, history };
}

/** Unified diff of the R2 HEAD → the local tree, via `git diff --no-index`
 *  over two temp extractions of the SAME packProjectSource filter (no repo
 *  needed; node_modules/dist never pollute either side). */
export async function r2DiffWorkdir(dir: string): Promise<{ status: R2SourceStatus; text: string; error?: string }> {
  const status = await r2SourceStatus(dir);
  if (!status.slug || !status.head) return { status, text: "" };
  if (!status.drifted) return { status, text: "" };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glyphh-r2diff-"));
  try {
    const headDir = path.join(tmp, "head");
    const localDir = path.join(tmp, "local");
    const headBytes = await getClient().apps.pullSource(status.slug, status.head.hash);
    new AdmZip(Buffer.from(headBytes)).extractAllTo(headDir, true);
    new AdmZip(localTreeHash(dir).archive).extractAllTo(localDir, true);
    const { execFile } = await import("node:child_process");
    const text = await new Promise<string>((resolve, reject) => {
      execFile("git", ["diff", "--no-index", "--unified=3", "--no-color", "head", "local"],
        { cwd: tmp, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => {
          // --no-index exits 1 when the trees differ — that IS the diff.
          if (err && (err as { code?: number }).code !== 1 && !stdout) reject(err);
          else resolve(stdout);
        });
    });
    // head/local prefixes → plain a/ b/ paths, so the renderer's parser reads
    // it exactly like a git diff.
    return { status, text: text.replaceAll("a/head/", "a/").replaceAll("b/local/", "b/").replaceAll(" head/", " ").replaceAll(" local/", " ") };
  } catch (e) {
    return { status, text: "", error: (e as Error).message };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp reaper's problem */ }
  }
}
