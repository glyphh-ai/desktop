/**
 * glyphh-app-package — export a yo app as a portable `.glyphh` bundle.
 *
 * Concept (VIBE-SPEC "yo app package"): everything is a yo app, and a yo app is
 * a portable unit. A `.glyphh` is just a zip:
 *   manifest.json            # YoAppManifest (the app shape + version/kind)
 *   code/…                   # (bundled apps only) the built static assets
 *
 * - kind:"web"     — the app is a URL (http/https or yo://). Manifest only.
 * - kind:"bundled" — the app carries its built static assets under code/.
 *
 * Import of the modern glyphh-app bundle lives in glyphh-app-host
 * (installGlyphhAppBundle); the legacy local-registry import died with the
 * local app connector.
 */

import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";

// ── Manifest ────────────────────────────────────────────────

/** DOM command mapping a legacy manifest could carry (kept for bundle-format
 *  compatibility — the desktop no longer executes these). */
interface CommandMapping {
  selector: string;
  action: string;
  description?: string;
  text?: string;
}

/** Legacy local-MCP config a manifest could carry (ignored on import — custom
 *  MCP connections live server-side now). */
interface McpConfig {
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

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
  /**
   * The RELEASE this bundle was taken from — version, notes, when it went live, and
   * the listing identity that is not machine-specific.
   *
   * Without it an exported app arrives as a version string with no story: the
   * receiving side cannot tell what changed, what the app is called in a storefront,
   * or which build it is looking at. Media beyond the icon is deliberately NOT
   * bundled — a 50MB demo video inside every file is a real cost for a marginal gain,
   * so the listing keeps it and the bundle points at the app.
   */
  release?: {
    version: string;
    notes: string | null;
    channel: "dev" | "live";
    releasedAt: string | null;
    tagline?: string | null;
    category?: string | null;
  };
}

const MANIFEST_VERSION = "1";

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
  app: {
    id: string; slug: string; name: string; url: string | null;
    release?: YoAppManifest["release"];
  },
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
    ...(app.release ? { release: app.release } : {}),
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
