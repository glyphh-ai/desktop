/**
 * yo-app-package — export/import a yo app as a portable `.yoapp` bundle.
 *
 * Concept (VIBE-SPEC "yo app package"): everything is a yo app, and a yo app is
 * a portable unit. A `.yoapp` is just a zip:
 *   manifest.json            # YoAppManifest (the app-connector app shape + version/kind)
 *   code/…                   # (bundled apps only) the built static assets
 *
 * - kind:"web"     — the app is a URL (http/https or yo://). Manifest only.
 * - kind:"bundled" — the app has local assets under a code dir (e.g. a vibe's
 *                    code/). Export adds them under code/ in the zip; import
 *                    extracts to a stable location (~/yo/apps/<id>/code) and
 *                    points the app's url at that index.html.
 *
 * Import dedupes the id so an incoming app never clobbers an existing one, then
 * registers it via app-connector.add(...) so it appears in the user's apps list.
 */

import fs from "fs";
import path from "path";
import os from "os";
import AdmZip from "adm-zip";
import type { AppConnector, CommandMapping, McpConfig } from "./app-connector";

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

/** Where imported bundled apps land: ~/yo/apps/<id>/code. */
function importedCodeDir(id: string): string {
  return path.join(os.homedir(), "yo", "apps", id, "code");
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

/**
 * The local folder to bundle for a file:// app. If the url points at a file
 * (e.g. .../code/index.html), we bundle its containing folder so sibling assets
 * (JS/CSS/images of a multi-file app) come along; if it points at a folder, we
 * bundle that folder. Returns undefined for remote/non-file apps.
 */
export function localBundleDir(url?: string): string | undefined {
  const p = fileUrlToPath(url);
  if (!p) return undefined;
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return p;
    if (st.isFile()) return path.dirname(p);
  } catch { /* missing path */ }
  return undefined;
}

// ── Export ──────────────────────────────────────────────────

export interface ExportResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * Export an app to a `.yoapp` zip at destPath.
 *
 * bundledCodeDir lets a caller (e.g. a vibe Ship-as-static flow) point at a
 * local assets dir to bundle. When omitted, an app is exported as kind:"web"
 * (manifest only) — its url carries everything needed to re-register it.
 */
export function exportApp(
  appConnector: AppConnector,
  appId: string,
  destPath: string,
  bundledCodeDir?: string,
): ExportResult {
  const app = appConnector.get(appId);
  if (!app) return { ok: false, error: `App "${appId}" not found` };

  const hasBundle = !!bundledCodeDir && fs.existsSync(bundledCodeDir);
  const kind: YoAppManifest["kind"] = hasBundle ? "bundled" : "web";

  // For a bundled app, record which file inside code/ is the entry point so
  // import can re-point the url at the right file (not always index.html).
  let entry: string | undefined;
  if (hasBundle) {
    const filePath = fileUrlToPath(app.url);
    if (filePath) {
      const rel = path.relative(bundledCodeDir!, filePath);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        entry = rel.split(path.sep).join("/");
      }
    }
  }

  const manifest: YoAppManifest = {
    id: app.id,
    name: app.name,
    version: MANIFEST_VERSION,
    kind,
    ...(app.url ? { url: app.url } : {}),
    ...(app.commands && Object.keys(app.commands).length ? { commands: app.commands } : {}),
    ...(app.mcp ? { mcp: app.mcp } : {}),
    ...(app.forceWeb ? { forceWeb: true } : {}),
    ...(entry ? { entry } : {}),
  };

  try {
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"));
    if (hasBundle) {
      // Lay the build under code/ inside the zip.
      zip.addLocalFolder(bundledCodeDir!, "code");
    }
    // Ensure the destination dir exists.
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    zip.writeZip(destPath);
    return { ok: true, path: destPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
 * Import a `.yoapp` bundle: unzip, read manifest.json, dedupe the id, extract
 * bundled code/ (if any) to ~/yo/apps/<id>/code, then register the app so it
 * shows up in the user's apps list. Returns the (possibly deduped) appId.
 */
export function importApp(appConnector: AppConnector, srcPath: string): ImportResult {
  let manifest: YoAppManifest;
  let zip: AdmZip;
  try {
    zip = new AdmZip(srcPath);
    const entry = zip.getEntry("manifest.json");
    if (!entry) return { ok: false, error: "Not a valid .yoapp (missing manifest.json)" };
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
    if (manifest.commands && Object.keys(manifest.commands).length) {
      appConnector.updateCommands(appId, manifest.commands);
    }
    if (manifest.mcp) appConnector.setMcp(appId, manifest.mcp);
    if (manifest.forceWeb) appConnector.updateForceWeb(appId, true);
    void app;
    return { ok: true, appId };
  } catch (err) {
    return { ok: false, error: `Failed registering app: ${err instanceof Error ? err.message : String(err)}` };
  }
}
