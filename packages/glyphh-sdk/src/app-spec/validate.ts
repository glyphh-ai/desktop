/**
 * app-spec/validate.ts — the ONE validator for Glyphh apps.
 *
 * This is the authority every surface shares. The builder runs it on the
 * project it was handed and on the bundle it made, an external builder
 * (Claude Code, CI, anything speaking the SDK) runs it before shipping, and
 * the server runs the same rules again — because the server trusts no
 * client, and nothing unsafe for a user or against policy may deploy.
 *
 * Two shapes, two functions:
 *
 *   validateAppProject(files) — a SOURCE folder: manifest.json + package.json
 *   (next) + a next.config that exports + app/ or pages/ + worker.js?.
 *
 *   validateAppBundle(bundle) — a BUILT bundle: manifest.json + ui/index.html
 *   + worker.js? — what the builder zips and the app server serves.
 *
 * Two severities, deliberately:
 *
 *   ERRORS — the shape (an app the platform cannot represent) and the
 *   SECURITY lines (remote code references, a worker reaching for network or
 *   node, an app exposing agent.run as a tool). These block a ship anywhere.
 *
 *   WARNINGS — advice: capability cross-references, cron shapes, connector
 *   grounding, retired names. The runtime refuses these at call time on its
 *   own, so a lint that guesses wrong must never block a ship — it informs
 *   the builder.
 *
 * Pure functions, no fs, no Electron — runnable in any JS environment, which
 * is the point: the spec is only portable if its enforcement is.
 */

/** A project or bundle as text: path → file content. */
export type AppBundle = Record<string, string>;

/** The canonical manifest file name. */
export const APP_MANIFEST = "manifest.json";

/** The manifest versions this validator reads. 3 is the Next.js spec (no
 *  `entry`); 2 still parses so older bundles install. */
export const MANIFEST_VERSIONS: ReadonlySet<number> = new Set([2, 3]);

/** The complete capability surface a worker (and the UI) may call through
 *  glyphh.call on the app server. */
export const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set([
  "db.exec",
  "vector.upsert", "vector.search", "vector.delete",
  "graph.cypher",
  "cron.schedule", "cron.cancel", "cron.list",
  "notify.send",
  "connector.status", "connector.tools", "connector.call",
  "secrets.get", "secrets.list",
  "app.call",
  // The member library's house kinds (image, video, audio, file, folder,
  // design, deck) as the calling member, and image generation through the
  // gateway — the house apps' two capabilities (2026-10-06).
  "library.list", "library.get", "library.put", "library.remove", "library.fileGet", "library.filePut",
  "images.generate",
  // RPA ON A TAB from an app's panel UI (his order, 2026-10-07: "give apps …
  // the ability to call the rpa tooling"): the mapped commands and sequences
  // of the member's tabs, on the desktop the panel is open on. A worker on
  // the app server has no machine and gets a precise refusal.
  "rpa.commands", "rpa.run", "rpa.sequence",
]);

/** Names that used to be capabilities and refuse on the app server now, with
 *  what replaced each. Declaring one warns; the runtime refuses the call. */
export const RETIRED_CAPABILITIES: ReadonlyMap<string, string> = new Map([
  ["llm.complete", "the agent writes and calls your tools with the result"],
  ["llm.embed", "vector.upsert embeds text itself"],
  ["llm.chunk", "split text in the worker"],
  ["agent.run", "the agent is the caller, never a capability"],
  ["contacts.search", "the google_contacts connector"],
  ["messages.send", "the gmail or slack connector"],
  ["web.fetch", "a connector"],
  ["web.read", "a connector"],
]);

/** Worker sandbox boundary: no direct network, no node. Every side effect goes
 *  through glyphh.call — the sandbox also blocks these at runtime; refusing at
 *  validation keeps a broken worker from shipping at all. */
const FORBIDDEN_WORKER = /\bfetch\s*\(|\brequire\s*\(|\bimport\s+[\w{*'"]|\bnew\s+WebSocket|\bXMLHttpRequest\b|\bprocess\.(env|platform|exit|cwd)/;

export interface AppManifestTool { name: string; capability?: string; handler?: string; description?: string; inputSchema?: unknown }

export interface ParsedAppManifest {
  manifestVersion: number;
  name: string;
  slug: string;
  description: string;
  worker?: string | undefined;
  capabilities: string[];
  connectors: string[];
  tools: AppManifestTool[];
  [k: string]: unknown;
}

export interface AppValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest: ParsedAppManifest | null;
}

/** Parse + normalize a manifest, or null when it cannot be one at all:
 *  valid JSON, kind "glyphh-app", a known manifestVersion, name + slug, slug
 *  not reserved. */
export function parseAppManifest(json: string): ParsedAppManifest | null {
  let m: Record<string, unknown>;
  try { m = JSON.parse(json) as Record<string, unknown>; } catch { return null; }
  if (m?.kind !== "glyphh-app") return null;
  const version = m.manifestVersion === undefined ? 2 : Number(m.manifestVersion);
  if (!MANIFEST_VERSIONS.has(version)) return null;
  m.manifestVersion = version;
  if (!m.name || !m.slug) return null;
  m.slug = String(m.slug).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if ((m.slug as string).startsWith("_")) return null;
  m.description = typeof m.description === "string" ? m.description : "";
  m.capabilities = Array.isArray(m.capabilities) ? m.capabilities.map(String) : [];
  m.connectors = Array.isArray(m.connectors)
    ? [...new Set((m.connectors as unknown[]).map((c) => String(c).trim().toLowerCase()).filter((c) => /^[a-z0-9_-]+$/.test(c)))]
    : [];
  m.worker = typeof m.worker === "string" && m.worker.trim() ? m.worker.trim() : undefined;
  m.tools = Array.isArray(m.tools)
    ? (m.tools as AppManifestTool[]).filter((t) => t && typeof t.name === "string"
        && (typeof t.capability === "string") !== (typeof t.handler === "string"))
    : [];
  return m as unknown as ParsedAppManifest;
}

// ── Security lint: remote code references in built assets ────────────────────
//
// Absolute http(s):// or protocol-relative // references in a CODE-loading
// position: script/iframe src, <link> href, CSS @import, ES import specifiers.
// The panel's CSP blocks these at runtime; refusing them at validation keeps a
// bundle from shipping them at all. Plain <a href> links are NOT flagged.
const REMOTE_ASSET_RES: RegExp[] = [
  /\bsrc\s*=\s*["']\s*(?:https?:)?\/\/[^"']+/i,
  /<link\b[^>]*\bhref\s*=\s*["']\s*(?:https?:)?\/\/[^"']+/i,
  /@import\s+(?:url\()?\s*["']?\s*(?:https?:)?\/\/[^"')]+/i,
  /\bimport\s+[^;]*from\s*["']\s*(?:https?:)?\/\/[^"']+/i,
  /\bimport\s*\(\s*["']\s*(?:https?:)?\/\/[^"']+/i,
];

/** Scan text assets for remote code references. Empty result = clean. */
export function lintRemoteAssets(files: AppBundle): string[] {
  const errors: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    if (!/\.(html?|css|m?js|jsx|ts|tsx)$/i.test(name)) continue;
    if (/(^|\/)node_modules\//.test(name)) continue;
    for (const re of REMOTE_ASSET_RES) {
      const m = re.exec(content);
      if (m) {
        errors.push(`${name}: remote asset reference not allowed — bundle it at build time instead ("${m[0].slice(0, 80)}…")`);
        break;
      }
    }
  }
  return errors;
}

// ── Advice lints (warnings — the runtime enforces these itself) ─────────────

export function extractConnectorCalls(worker: string): Array<{ connector: string; tool: string }> {
  const out: Array<{ connector: string; tool: string }> = [];
  const re = /connector\.call/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(worker))) {
    const win = worker.slice(m.index, m.index + 500);
    const conn = win.match(/connector\s*:\s*["'`]([^"'`]+)["'`]/);
    const tool = win.match(/tool\s*:\s*["'`]([^"'`]+)["'`]/);
    if (conn && tool) out.push({ connector: conn[1]!, tool: tool[1]! });
  }
  return out;
}

/** glyphh.call targets must be host capabilities — calling the worker's own
 *  handler through glyphh.call errors at runtime. */
export function checkCallTargets(worker: string): string[] {
  const notes: string[] = [];
  const handlers = new Set<string>();
  for (const m of worker.matchAll(/glyphh\.handle\(\s*["'`]([^"'`]+)["'`]/g)) handlers.add(m[1]!);
  for (const m of worker.matchAll(/glyphh\.call\(\s*["'`]([^"'`]+)["'`]/g)) {
    const target = m[1]!;
    if (KNOWN_CAPABILITIES.has(target) || target === "ping") continue;
    if (handlers.has(target)) {
      notes.push(`glyphh.call("${target}") targets the worker's own handler — call the function directly; glyphh.call is for host capabilities only`);
    } else if (RETIRED_CAPABILITIES.has(target)) {
      notes.push(`glyphh.call("${target}") is retired and refuses on the app server — ${RETIRED_CAPABILITIES.get(target)}`);
    } else {
      notes.push(`glyphh.call("${target}") is not a capability. The COMPLETE capability list: ${[...KNOWN_CAPABILITIES].join(", ")}. Workers never call fetch directly.`);
    }
  }
  return [...new Set(notes)];
}

/** cron.schedule expressions must be 5 space-separated fields — HH:MM-style
 *  strings never fire. */
const CRON_FIELD = /^(\*|[0-9*,/-]+)$/;
export function checkCronExpressions(worker: string): string[] {
  const notes: string[] = [];
  if (!worker.includes("cron.schedule")) return notes;
  for (const m of worker.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
    const raw = m[2]!;
    const fields = raw.trim().split(/\s+/);
    const stars = fields.filter((f) => f === "*").length;
    if (fields.length < 4 || stars < 2) continue; // not cron-intended
    if (raw.includes("${")) {
      if (/^\$\{[^}]*\}\s+\*\s+\*\s+\*\s+\*$/.test(raw.trim())) {
        notes.push(`cron template "${raw.trim()}" puts one variable in the minute field — if it holds HH:MM the job never fires; split into minute and hour ("\${mm} \${hh} * * *")`);
      } else if (raw.includes(":") || fields.length !== 5) {
        notes.push(`cron built from a template ("${raw.slice(0, 40)}") — must resolve to 5 space-separated fields (minute hour dom month dow), never HH:MM`);
      }
      continue;
    }
    if (fields.length !== 5 || raw.includes(":") || !fields.every((f) => CRON_FIELD.test(f))) {
      notes.push(`invalid cron expression "${raw}" — needs 5 fields (minute hour dom month dow), e.g. "0 8 * * *" for daily 8am`);
    }
  }
  return notes;
}

/** db.exec statements are Postgres: `?` placeholders and SQLite-only syntax
 *  (AUTOINCREMENT, julianday, datetime('now')) fail at the database. */
export function checkSqlDialect(worker: string): string[] {
  const notes: string[] = [];
  if (!worker.includes("db.exec")) return notes;
  if (/\bsql\s*:\s*(["'`])(?:(?!\1)[\s\S])*?\?(?:(?!\1)[\s\S])*?\1/.test(worker) && !/\$\d/.test(worker)) {
    notes.push('db.exec uses "?" placeholders — Postgres takes $1, $2, … and `params` in that order');
  }
  for (const [re, fix] of [
    [/\bAUTOINCREMENT\b/i, "AUTOINCREMENT → SERIAL (or GENERATED ALWAYS AS IDENTITY)"],
    [/\bjulianday\s*\(/i, "julianday() → now() - timestamptz arithmetic (EXTRACT(EPOCH FROM …))"],
    [/\bdatetime\s*\(\s*['"]now['"]\s*\)/i, "datetime('now') → now()"],
    [/\bCOLLATE\s+NOCASE\b/i, "COLLATE NOCASE → lower(name) in a unique index"],
  ] as const) {
    if (re.test(worker)) notes.push(`db.exec is Postgres, not SQLite: ${fix}`);
  }
  return notes;
}

// ── shared manifest rules ────────────────────────────────────────────────────

function manifestAdvice(m: ParsedAppManifest, warnings: string[]): void {
  const unknown = m.capabilities.filter((c) => !KNOWN_CAPABILITIES.has(c));
  const retired = unknown.filter((c) => RETIRED_CAPABILITIES.has(c));
  for (const c of retired) warnings.push(`capability "${c}" is retired and refuses on the app server — ${RETIRED_CAPABILITIES.get(c)}`);
  const rest = unknown.filter((c) => !RETIRED_CAPABILITIES.has(c));
  if (rest.length) warnings.push(`unknown capabilities (ignored at runtime): ${rest.join(", ")}`);

  const badTool = m.tools.find((t) => t.capability && !m.capabilities.includes(t.capability));
  if (badTool) warnings.push(`tool "${badTool.name}" names capability "${badTool.capability}" that is not in the manifest's capabilities — it will be refused at runtime`);

  const handlerTool = m.tools.find((t) => t.handler);
  if (handlerTool && !m.worker) warnings.push(`tool "${handlerTool.name}" uses a handler but no worker is declared — it cannot run`);

  if (m.capabilities.some((c) => c.startsWith("connector.")) && !m.connectors.length) {
    warnings.push("connector.* capabilities with an empty `connectors` list — connector calls will be refused");
  }
  if (m.manifestVersion < 3) warnings.push("manifestVersion 2 — the Next.js spec is manifestVersion 3 (no `entry`; ui/index.html is the entry)");
  if (!m.description) warnings.push("no description — the hub and the agent read it");
}

function workerAdvice(
  m: ParsedAppManifest,
  workerCode: string,
  warnings: string[],
  lookup?: (slug: string) => string[] | null,
): void {
  warnings.push(...checkCallTargets(workerCode));
  warnings.push(...checkCronExpressions(workerCode));
  warnings.push(...checkSqlDialect(workerCode));
  if (!lookup) return;
  for (const { connector, tool } of extractConnectorCalls(workerCode)) {
    if (!m.connectors.includes(connector)) {
      warnings.push(`connector.call uses "${connector}" but it's not in the manifest connectors list`);
      continue;
    }
    const names = lookup(connector);
    if (!names) { warnings.push(`no live catalog for "${connector}" — tool "${tool}" unverified`); continue; }
    if (!names.includes(tool)) {
      warnings.push(`connector.call tool "${tool}" doesn't exist for "${connector}" (real ones e.g. ${names.slice(0, 3).join(", ")})`);
    }
  }
}

function securityErrors(m: ParsedAppManifest, files: AppBundle, errors: string[]): string | undefined {
  errors.push(...lintRemoteAssets(files));

  if (m.worker && !files[m.worker]) errors.push(`worker "${m.worker}" declared but its code is missing`);
  const workerCode = m.worker ? files[m.worker] : undefined;
  if (workerCode && FORBIDDEN_WORKER.test(workerCode)) {
    errors.push("worker uses forbidden APIs (network/node). Workers have NO direct network access — use connector.call for account APIs and db.exec / vector.* / graph.cypher for data. Declare them in manifest capabilities.");
  }

  const recursive = m.tools.find((t) => t.capability === "agent.run");
  if (recursive) errors.push(`tool "${recursive.name}" cannot expose agent.run as a tool — an app must not run the agent that runs apps`);
  return workerCode;
}

// ── The validators ───────────────────────────────────────────────────────────

/**
 * Validate a BUILT bundle: manifest.json at the root, ui/index.html (the
 * export), worker.js when the manifest declares it. `lookup(slug)` optionally
 * grounds connector calls against a live tool catalog (null = unknown slug →
 * warning only).
 */
export function validateAppBundle(
  bundle: AppBundle,
  lookup?: (slug: string) => string[] | null,
): AppValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const manifestRaw = bundle[APP_MANIFEST];
  if (!manifestRaw) return { ok: false, errors: [`no ${APP_MANIFEST} in the bundle`], warnings, manifest: null };
  const m = parseAppManifest(manifestRaw);
  if (!m) return { ok: false, errors: [`${APP_MANIFEST} rejected — must be valid JSON with kind "glyphh-app", manifestVersion 3 (2 still installs), name, slug (lowercase, no leading underscore)`], warnings, manifest: null };

  if (!bundle["ui/index.html"]) errors.push("no ui/index.html — a bundle carries the Next.js export under ui/");

  const workerCode = securityErrors(m, bundle, errors);
  manifestAdvice(m, warnings);
  if (workerCode) workerAdvice(m, workerCode, warnings, lookup);

  return { ok: errors.length === 0, errors, warnings, manifest: m };
}

/**
 * Validate a SOURCE project (what app_deploy tars and the builder builds):
 * manifest.json, package.json depending on next with a build script, a
 * next.config that exports statically, an app/ or pages/ router, and the
 * worker when declared. Same security lines as the bundle.
 */
export function validateAppProject(
  files: AppBundle,
  lookup?: (slug: string) => string[] | null,
): AppValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const manifestRaw = files[APP_MANIFEST];
  if (!manifestRaw) return { ok: false, errors: [`no ${APP_MANIFEST} at the project root`], warnings, manifest: null };
  const m = parseAppManifest(manifestRaw);
  if (!m) return { ok: false, errors: [`${APP_MANIFEST} rejected — must be valid JSON with kind "glyphh-app", manifestVersion 3, name, slug (lowercase, no leading underscore)`], warnings, manifest: null };

  // ── the Next.js project shape ─────────────────────────────────────────────
  const pkgRaw = files["package.json"];
  if (!pkgRaw) errors.push("no package.json — a Glyphh app is a Next.js project");
  else {
    interface Pkg { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> }
    let pkg: Pkg | null = null;
    try { pkg = JSON.parse(pkgRaw) as Pkg; } catch { errors.push("package.json is not valid JSON"); }
    if (pkg) {
      const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
      if (!deps.next) errors.push("package.json does not depend on next — a Glyphh app is a Next.js project");
      if (!deps.react || !deps["react-dom"]) warnings.push("package.json should depend on react and react-dom");
      if (!/\bnext build\b/.test(pkg.scripts?.build ?? "")) errors.push('package.json scripts.build must run "next build"');
    }
  }

  const configName = ["next.config.mjs", "next.config.js", "next.config.ts"].find((n) => files[n]);
  if (!configName) errors.push("no next.config.mjs — it must set output: 'export', trailingSlash: true, basePath from GLYPHH_APP_BASE, images.unoptimized");
  else {
    const cfg = files[configName]!;
    if (!/output\s*:\s*["'`]export["'`]/.test(cfg)) errors.push(`${configName} must set output: 'export' — the app server serves static files`);
    if (!/trailingSlash\s*:\s*true/.test(cfg)) warnings.push(`${configName} should set trailingSlash: true — /app-host/<key>/ui/ resolves index.html`);
    if (!/GLYPHH_APP_BASE/.test(cfg)) errors.push(`${configName} must take basePath from process.env.GLYPHH_APP_BASE — the builder sets the instance's path`);
    if (!/unoptimized\s*:\s*true/.test(cfg)) warnings.push(`${configName} should set images: { unoptimized: true } — there is no image optimizer in a static export`);
  }

  const hasRouter = Object.keys(files).some((p) => /^(src\/)?(app|pages)\//.test(p));
  if (!hasRouter) errors.push("no app/ (or pages/) directory — nothing for Next.js to build");

  if (Object.keys(files).some((p) => /^(node_modules|\.next|out)\//.test(p))) {
    warnings.push("node_modules/, .next/ or out/ are in the project — the builder makes them; leave them out of the deploy");
  }

  const workerCode = securityErrors(m, files, errors);
  manifestAdvice(m, warnings);
  if (workerCode) workerAdvice(m, workerCode, warnings, lookup);

  return { ok: errors.length === 0, errors, warnings, manifest: m };
}
