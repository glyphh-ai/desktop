/**
 * glyphh-app-package — export/import a yo app as a portable `.glyphh` bundle.
 *
 * Concept (VIBE-SPEC "yo app package"): everything is a yo app, and a yo app is
 * a portable unit. A `.glyphh` is just a zip:
 *   manifest.json            # YoAppManifest (the app-connector app shape + version/kind)
 *   code/…                   # (bundled apps only) the built static assets
 *
 * - kind:"web"     — the app is a URL (http/https or yo://). Manifest only.
 * - kind:"bundled" — the app has local assets under a code dir (e.g. a vibe's
 *                    code/). Export adds them under code/ in the zip; import
 *                    extracts to a stable location (~/.glyphh/apps/<id>/code) and
 *                    points the app's url at that index.html.
 *
 * Import dedupes the id so an incoming app never clobbers an existing one, then
 * registers it via app-connector.add(...) so it appears in the user's apps list.
 */

import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import type { AppConnector, CommandMapping, McpConfig } from "./app-connector";
import { glyphhPath } from "./app-paths.js";

// ── Manifest ────────────────────────────────────────────────

export interface YoAppManifest {
  id: string;
  name: string;
  url?: string;
  commands?: Record<string, CommandMapping>;
  mcp?: McpConfig;
  forceWeb?: boolean;
  /** Entry file (relative to code/) for bundled apps. Defaults to index.html. */
  entry?: string;
  version: string;
  kind: "web" | "bundled";
}

const MANIFEST_VERSION = "1";

/** Where imported bundled apps land: ~/.glyphh/apps/<id>/code. */
function importedCodeDir(id: string): string {
  return glyphhPath("apps", id, "code");
}

/** True when a url points at a remote web app (vs a local file/bundle). */
function isWebUrl(url?: string): boolean {
  if (!url) return false;
  return /^https?:\/\//i.test(url) || url.startsWith("yo://");
}

/** Decode a file:// URL to an absolute filesystem path (or undefined). */
export function fileUrlToPath(url?: string): string | undefined {
  if (!url || !/^file:\/\//i.test(url)) return undefined;
  let p = url.replace(/^file:\/\//i, "").replace(/[?#].*$/, "");
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  return p || undefined;
}

// ── Export ──────────────────────────────────────────────────

/**
 * Export a SERVER-backed app (from the org's app library) to a .glyphh bundle.
 * The app record comes from fetchOrgApps, not the legacy appConnector — which is
 * why the old export path silently failed on every real app. When `sourceZip`
 * is provided (the app's built source, downloaded via apps.source()), its files
 * are laid under `code/` and the app exports as a full `kind:"bundled"` copy;
 * otherwise it's a `kind:"web"` manifest describing the launcher.
 */
export function exportServerApp(
  app: { id: string; slug: string; name: string; url: string | null },
  destPath: string,
  sourceZip?: Buffer,
): ExportResult {
  const hasCode = !!sourceZip && sourceZip.byteLength > 0;
  const manifest: YoAppManifest = {
    id: app.slug || app.id,
    name: app.name,
    version: MANIFEST_VERSION,
    kind: hasCode ? "bundled" : "web",
    ...(app.url ? { url: app.url } : {}),
    ...(hasCode ? { entry: "index.html" } : {}),
  };
  try {
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"));
    if (hasCode) {
      // Unpack the built source (a zip) under code/ inside the .glyphh.
      const src = new AdmZip(sourceZip!);
      for (const e of src.getEntries()) {
        if (e.isDirectory) continue;
        zip.addFile(`code/${e.entryName}`, e.getData());
      }
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    zip.writeZip(destPath);
    return { ok: true, path: destPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ExportResult {
  ok: boolean;
  path?: string;
  error?: string;
}

// ── Import ──────────────────────────────────────────────────

export interface ImportResult {
  ok: boolean;
  appId?: string;
  error?: string;
}

/** Dedupe an id against the registry: "notes" → "notes-2" → "notes-3" … */
function uniqueAppId(appConnector: AppConnector, base: string): string {
  const clean = (base || "app").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "app";
  if (!appConnector.hasDirect(clean)) return clean;
  for (let n = 2; n < 1000; n++) {
    const cand = `${clean}-${n}`;
    if (!appConnector.hasDirect(cand)) return cand;
  }
  return `${clean}-${Date.now()}`;
}

/**
 * Import a `.glyphh` bundle: unzip, read manifest.json, dedupe the id, extract
 * bundled code/ (if any) to ~/.glyphh/apps/<id>/code, then register the app so it
 * shows up in the user's apps list. Returns the (possibly deduped) appId.
 */
export function importApp(appConnector: AppConnector, srcPath: string): ImportResult {
  let manifest: YoAppManifest;
  let zip: AdmZip;
  try {
    zip = new AdmZip(srcPath);
    const entry = zip.getEntry("manifest.json");
    if (!entry) return { ok: false, error: "Not a valid .glyphh (missing manifest.json)" };
    manifest = JSON.parse(zip.readAsText(entry)) as YoAppManifest;
  } catch (err) {
    return { ok: false, error: `Could not read bundle: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!manifest || !manifest.id || !manifest.name) {
    return { ok: false, error: "Manifest is missing required fields (id, name)" };
  }

  const appId = uniqueAppId(appConnector, manifest.id);
  const isBundled = manifest.kind === "bundled";

  // Resolve the url. For bundled apps, extract code/ and point at its index.html.
  let url = manifest.url;
  try {
    if (isBundled) {
      const codeEntries = zip.getEntries().filter((e) => e.entryName.startsWith("code/") && !e.isDirectory);
      if (codeEntries.length === 0) {
        return { ok: false, error: "Bundled app has no code/ assets" };
      }
      const dest = importedCodeDir(appId);
      fs.mkdirSync(dest, { recursive: true });
      // Extract the code/ subtree, stripping the leading "code/" prefix.
      for (const e of codeEntries) {
        const rel = e.entryName.slice("code/".length);
        if (!rel) continue;
        const outPath = path.join(dest, rel);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, e.getData());
      }
      const entryRel = manifest.entry && !manifest.entry.startsWith("..") ? manifest.entry : "index.html";
      const entryPath = path.join(dest, entryRel);
      const indexPath = path.join(dest, "index.html");
      url = `file://${fs.existsSync(entryPath) ? entryPath : fs.existsSync(indexPath) ? indexPath : dest}`;
    } else if (!isWebUrl(url)) {
      // A non-bundled app must carry a usable url.
      return { ok: false, error: "Web app manifest has no usable url" };
    }
  } catch (err) {
    return { ok: false, error: `Failed extracting bundle: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const app = appConnector.add(appId, manifest.name, url);
    // Re-attach the rest of the manifest fields that add() doesn't take.
    // (Legacy manifest.mcp configs are ignored — local MCP execution is
    // retired; custom MCP connections live server-side.)
    if (manifest.commands && Object.keys(manifest.commands).length) {
      appConnector.updateCommands(appId, manifest.commands);
    }
    void app;
    return { ok: true, appId };
  } catch (err) {
    return { ok: false, error: `Failed registering app: ${err instanceof Error ? err.message : String(err)}` };
  }
}
