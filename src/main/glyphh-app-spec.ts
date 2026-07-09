/**
 * Glyphh app build spec (Vite-static era) + the install-time hardening that
 * backs it.
 *
 * Apps are REAL projects now — a frontier agent scaffolds a Vite + React + TS
 * + Tailwind app in the working folder, runs the build, and ships the compiled
 * `dist/` through update_app. Deps (tailwind, three.js, framer-motion, any
 * npm) are bundled AT BUILD TIME; nothing is fetched at runtime. The host CSP
 * (script-src 'self' file:, connect-src 'none') already makes runtime CDN
 * loads structurally impossible — this module adds the defense-in-depth lint
 * and the dist-only packaging that keep source/node_modules out of the bundle.
 *
 * Electron-free so it stays unit-testable.
 */

import fs from "node:fs";
import path from "node:path";

// ── The agent-facing contract (injected into the loop's system prompt) ──────

export const GLYPHH_APP_SPEC = `## Building a Glyphh app

A Glyphh app is a REAL project you build in the working folder, then ship with
update_app(). Build it however makes the best app — Vite + React + TypeScript +
Tailwind is the recommended stack. Use any npm libraries you want (three.js,
framer-motion, chart.js, d3, …) — they are bundled at build time. Make it
genuinely beautiful.

### Project layout (working folder root)
- glyphh.app.json   — the manifest (see below)
- package.json      — your deps + a "build" script
- vite.config.ts    — MUST set \`base: './'\` so built asset paths are relative
- index.html + src/ — your app (React/TS/Tailwind/whatever)
- worker.js         — OPTIONAL headless tool logic (only if the app exposes handler-backed tools)

### The build → ship flow
1. Scaffold the project and write your code.
2. run_command("npm install") then run_command("npm run build") — Vite emits dist/.
3. update_app() — packages dist/ (the compiled UI) + glyphh.app.json + worker.js
   and installs it. It NEVER ships src/ or node_modules.
Re-run build + update_app after any change, or the installed app runs the old code.

### Hard runtime limits (the host enforces these — a build that violates them is REJECTED at install)
- NO runtime network from the UI: no remote <script>/<link>, no CDN, no fetch to
  outside origins. Everything must be bundled into dist/ at build time. This is a
  security boundary, not a style rule.
- NO external URLs in your built HTML/JS assets. Vite with \`base: './'\` keeps all
  asset refs local — do that.
- The UI reaches the host ONLY through window.glyphh.call(method, args) (the IPC
  bridge). All data access, connectors, storage go through declared capabilities.

### glyphh.app.json
STRICT JSON. Required: "manifestVersion": 2, "kind": "glyphh-app", "name",
"slug" (lowercase [a-z0-9_-], no leading underscore), "entry": "index.html",
"description". Recommended for the marketplace: "version" (semver), "icon"
(emoji), "category", "keywords", "about".
Optional: "worker": "worker.js", "window": {width,height}, "capabilities": [...],
"connectors": [...] (Pipedream app slugs), "tools": [...].
Each tool: { "name", "description", "handler" XOR "capability", "inputSchema" }.
Rules: exactly one of handler|capability; every capability a tool uses is in
top-level capabilities; any connector.* capability needs a non-empty connectors
list; NEVER expose agent.run as a tool.

### worker.js (headless, sandboxed — only if the app has handler tools)
SDK only: glyphh.handle("name", async (args) => result) registers a tool/cron
handler; await glyphh.call(cap, args) → {ok,result}|{ok:false,error};
glyphh.app.slug. NO fetch / require / import / network / node — every side
effect goes through glyphh.call(). State lives in db.exec.

Legacy single-file apps (manifest.json + inline index.html, no build) still
install — but new apps should be real Vite projects.

### Version control (git — the workspace is a real repo)
Before building, git_init() the working folder — it creates the repo, writes a
.gitignore (node_modules/, dist/, .env), and makes the first commit. Then:
- Work on a BRANCH (git_branch("feature/…")), never straight on the default branch.
- NEVER commit node_modules/ or dist/ (the .gitignore handles this — don't override it).
- Commit in small, meaningful steps with real messages ("add three.js starfield",
  not "update"). Commit after a green \`npm run build\`, not mid-broken-state.`;

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

// ── Defense-in-depth: reject remote assets in built output ──────────────────

// Absolute http(s):// or protocol-relative // references in a CODE-loading
// position: script/iframe src, <link> href (stylesheets/modulepreload), CSS
// @import, or an ES import specifier. The CSP already blocks these at runtime;
// this refuses them at INSTALL so a bundle can't even ship them. Plain <a href>
// links are NOT flagged — they're not a code vector and navigation is already
// egress-guarded.
const REMOTE_ASSET_RES: RegExp[] = [
  /\bsrc\s*=\s*["']\s*(?:https?:)?\/\/[^"']+/i,
  /<link\b[^>]*\bhref\s*=\s*["']\s*(?:https?:)?\/\/[^"']+/i,
  /@import\s+(?:url\()?\s*["']?\s*(?:https?:)?\/\/[^"')]+/i,
  /\bimport\s+[^;]*from\s*["']\s*(?:https?:)?\/\/[^"']+/i,
  /\bimport\s*\(\s*["']\s*(?:https?:)?\/\/[^"']+/i,
];

/** Scan text assets (HTML/CSS/JS) for remote references. Returns human errors;
 *  empty = clean. Data URIs and local/relative paths pass. */
export function lintNoRemoteAssets(files: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    if (!/\.(html?|css|m?js|jsx|ts|tsx)$/i.test(name)) continue;
    for (const re of REMOTE_ASSET_RES) {
      const m = re.exec(content);
      if (m) {
        errors.push(`${name}: remote asset reference not allowed — bundle it at build time instead ("${m[0].slice(0, 80)}…")`);
        break; // one per file is enough signal
      }
    }
  }
  return errors;
}

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
