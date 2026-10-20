/**
 * legacy-app-sweep.ts — THE LOCAL APP FOLDERS ARE DELETED, NO MIGRATION (his
 * word, 2026-10-05: "all apps prior, the usage is zero, will be deleted";
 * 2026-10-06: "actually delete everything from local… Cloud is first").
 *
 * Before the cloud an installed app was a folder on this machine: a bundle in
 * the user's apps home (SKILL.md + app.json + ui/ — the house apps' bundles
 * included; the house panels are built in, not installed), or a `.glyphh`
 * unzipped under ~/.glyphh/apps/<org>/<slug> or the user's custom-apps/<slug>
 * with a glyphh tab row pointing at its entry. There is no local app host any
 * more, so the first sign-in after the cut sweeps those folders once.
 *
 * THE RULE (localAppFolders, pure): a folder in the apps home goes when it is
 * an app on this machine — it holds a bundle manifest (app.json), or its tab
 * row is a glyphh row whose entry is a file here and which names no cloud
 * instance. What stays: a web or native tab's row, a glyphh row that names
 * its instance (that app IS in the cloud; its tab is cloud data), a folder
 * with neither (a parked folder, a link into a dev build). Under the two
 * payload roots every unzipped bundle (a folder with a manifest.json, one or
 * two levels down) and the shared `_libs` go, and a root left empty goes with
 * them; anything else there (an older layout's tab rows) stays. Skills, tasks,
 * plugins, app-data stores and the user's files live elsewhere and are not
 * in reach.
 *
 * ONCE PER USER: a marker file in the user's home records the sweep. Nothing
 * here asks the server, so an offline sign-in sweeps too.
 */

import fs from "fs";
import path from "path";
import { getActiveUserId, GLYPHH_DIR, userScopedPath } from "./app-paths.js";
import { readRow, type LocalAppRow } from "./apps-store.js";
import { instanceKeyOfRow } from "../shared/app-instances.js";

/** A new name: a machine swept under the narrower rule of 2026-10-05 is swept again. */
export const LOCAL_SWEEP_MARKER = ".local-apps-swept";

/** What the sweep knows about one folder in the apps home. */
export interface LocalAppEntry {
  slug: string;
  /** The folder holds a bundle manifest (app.json). */
  hasManifest: boolean;
  /** The folder's tab row, when it has one. */
  row: Pick<LocalAppRow, "kind" | "nativeRef" | "config"> | null;
}

/** THE RULE. The slugs to sweep: every app folder on this machine — each once. */
export function localAppFolders(entries: LocalAppEntry[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const slug = String(e.slug || "").toLowerCase().trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const localRow = !!e.row && e.row.kind === "glyphh" && !!e.row.nativeRef && !instanceKeyOfRow(e.row);
    if (e.hasManifest || localRow) out.push(slug);
  }
  return out;
}

export interface SweepDeps {
  /** The user's apps home (bundle folders and tab rows). */
  appsDir: string;
  /** The roots a `.glyphh` unzipped into: the org-scoped one and the flat one. */
  payloadRoots: string[];
  /** The once-per-user marker file. */
  marker: string;
  readRow: (slug: string) => LocalAppRow | null;
  log: (line: string) => void;
}

export interface SweepResult {
  /** The slugs removed, in order. */
  swept: string[];
  /** The unzipped payload folders removed, in order. */
  payloads: string[];
  /** Why nothing ran: already done for this user. */
  skipped?: "done";
}

const BUNDLE_MANIFEST = "manifest.json";

function subdirs(dir: string): string[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => path.join(dir, e.name)); }
  catch { return []; }
}

/** The unzipped bundles under a payload root: `<root>/<slug>` or
 *  `<root>/<org>/<slug>` holding a manifest.json, and the shared `_libs`. */
export function payloadDirs(root: string): string[] {
  const out: string[] = [];
  for (const one of subdirs(root)) {
    if (path.basename(one).startsWith("_") || fs.existsSync(path.join(one, BUNDLE_MANIFEST))) { out.push(one); continue; }
    for (const two of subdirs(one)) if (fs.existsSync(path.join(two, BUNDLE_MANIFEST))) out.push(two);
  }
  return out;
}

/** The folders in the apps home as the rule sees them. */
function readEntries(deps: SweepDeps): LocalAppEntry[] {
  let names: fs.Dirent[] = [];
  try { names = fs.readdirSync(deps.appsDir, { withFileTypes: true }); } catch { return []; }
  const out: LocalAppEntry[] = [];
  for (const e of names) {
    if (e.name.startsWith(".") || !e.isDirectory()) continue;   // a link is a dev build's — never ours to remove
    const dir = path.join(deps.appsDir, e.name);
    out.push({ slug: e.name.toLowerCase(), hasManifest: fs.existsSync(path.join(dir, "app.json")), row: deps.readRow(e.name) });
  }
  return out;
}

/** The sweep, over injected paths (tested under test/main). */
export function sweepLocalAppFolders(deps: SweepDeps): SweepResult {
  if (fs.existsSync(deps.marker)) return { swept: [], payloads: [], skipped: "done" };
  const remove = (dir: string, what: string): boolean => {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; }
    catch (err) { deps.log(`[local-apps] ${what}: ${dir} not removed: ${err instanceof Error ? err.message : String(err)}`); return false; }
  };
  const swept: string[] = [];
  for (const slug of localAppFolders(readEntries(deps))) {
    remove(path.join(deps.appsDir, slug), `"${slug}"`);
    swept.push(slug);
  }
  const payloads: string[] = [];
  for (const root of deps.payloadRoots) {
    for (const dir of payloadDirs(root)) if (remove(dir, "payload")) payloads.push(dir);
    // A root with nothing left in it goes too; one still holding something else stays.
    for (const dir of [...subdirs(root), root]) { try { fs.rmdirSync(dir); } catch { /* not empty, or not there */ } }
  }
  if (swept.length || payloads.length) deps.log(`[local-apps] removed ${swept.length} app folder${swept.length === 1 ? "" : "s"} from this machine${swept.length ? `: ${swept.join(", ")}` : ""}${payloads.length ? ` (and ${payloads.length} unzipped bundle${payloads.length === 1 ? "" : "s"})` : ""}`);
  else deps.log("[local-apps] no app folders on this machine");
  try {
    fs.mkdirSync(path.dirname(deps.marker), { recursive: true });
    fs.writeFileSync(deps.marker, JSON.stringify({ at: new Date().toISOString(), swept, payloads }, null, 2));
  } catch (err) { deps.log(`[local-apps] marker not written: ${err instanceof Error ? err.message : String(err)}`); }
  return { swept, payloads };
}

/** The desktop's run: the signed-in user's apps home and payload roots, the
 *  user's marker. The app list and the wall are refreshed when anything went. */
/** THE MIRRORS GO (his order, 2026-10-07): the tab, workspace and agent
 *  folders the sync kept on this machine. The server holds every record;
 *  nothing is lost. */
export function sweepLibraryMirrors(dirs: string[] = [userScopedPath("apps"), userScopedPath("workspaces"), userScopedPath("agents")]): string[] {
  const gone: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); gone.push(dir); }
    catch (err) { console.warn("[legacy-apps] mirror not removed:", dir, err instanceof Error ? err.message : err); }
  }
  return gone;
}

export async function runLocalAppSweep(): Promise<void> {
  if (!getActiveUserId()) return;
  const mirrors = sweepLibraryMirrors();
  if (mirrors.length) console.info("[legacy-apps] removed library mirrors:", mirrors.join(", "));
  const result = sweepLocalAppFolders({
    appsDir: userScopedPath("apps"),
    payloadRoots: [path.join(GLYPHH_DIR, "apps"), userScopedPath("custom-apps")],
    marker: userScopedPath(LOCAL_SWEEP_MARKER),
    readRow,
    log: (line) => console.info(line),
  });
  if (!result.swept.length && !result.payloads.length) return;
  const { broadcast } = await import("./broadcast.js");
  broadcast("panel-apps-changed");
}
