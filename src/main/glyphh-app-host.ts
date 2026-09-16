/**
 * glyphh-app-host — runtime for installable "Glyphh apps" (the marketplace
 * unit). A Glyphh app is a .glyphh zip:
 *
 *   manifest.json   { manifestVersion, kind:"glyphh-app", name, slug, entry,
 *                     capabilities: ["contacts.search", "messages.send", …],
 *                     window?: { width, height }, description? }
 *   index.html (+ assets)   self-contained UI
 *
 * Install: extract to ~/.glyphh/custom-apps/<slug>/ and create a NORMAL saved-app
 * row on the server (isBrowser:false, appArchetype:"glyphh-app", execPath →
 * the entry html, launchConfig → { capabilities, window }). Riding the
 * saved-app rails means the app shows on the Apps page, in the command
 * overlay, works with .dip and layouts — installed like any other app.
 *
 * Run: each app opens in its own BrowserWindow with a minimal preload that
 * exposes ONLY `glyphh.call(method, args)`. The main process enforces the
 * manifest's capability list per-window — an app can never call a capability
 * it didn't declare at install time.
 *
 * v2 adds the headless side: a `worker` script (hidden sandboxed window, see
 * glyphh-app-worker.ts) whose named handlers back MCP tools and cron firings,
 * plus host services (per-app SQLite, cron, notifications — see
 * glyphh-app-services.ts).
 *
 * Capabilities:
 *   contacts.search { query }        → [{ name, value }]           (macOS)
 *   messages.send   { to, body }     → { sent: true }              (macOS)
 *   db.exec         { sql, params? } → { rows | changes, lastInsertRowid }
 *   cron.schedule   { id, cron, handler, args? } → { scheduled, id }
 *   cron.cancel     { id }           → { cancelled }
 *   cron.list       { }              → [{ id, cron, handler, args? }]
 *   notify.send     { title, body }  → { shown }
 */

import { BrowserWindow, ipcMain, webContents, session } from "electron";
import { execFile } from "child_process";
import AdmZip from "adm-zip";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { userScopedPath, glyphhPath, appsRoot, appDir } from "./app-paths.js";
import { fetchOrgApps, invalidateOrgApps } from "./org-apps.js";
import * as appsStore from "./apps-store.js";
import { getPreference } from "./stores/preferences-db.js";
import { grantAppCaps, revokeAppCaps, getAppGrant } from "./glyphh-app-grants.js";
import { AppWorkerSpec, ensureAppWorker, invokeAppWorkerHandler, stopAppWorker } from "./glyphh-app-worker.js";
import { webFetch, webRead } from "./web-capability.js";
import { lintRemoteAssets } from "@glyphh/sdk";
import {
  initAppServices, dbExec, cronSchedule, cronCancel, cronList, notifySend,
  connectorStatus, connectorTools, connectorCall,
} from "./glyphh-app-services.js";
import { secretValueFromRow, secretKeysFromRow, isHostOnlySecret, isSecretAppReadable } from "./app-secrets.js";
import { fsPick, fsRead, fsWrite } from "./glyphh-app-fs.js";

// ── manifest ────────────────────────────────────────────────

/** An MCP tool an app exposes to the relay (see GLYPHH-APP-SPEC §3). Backed by
 *  exactly one of: a host `capability` (v1, 1:1 passthrough) or a worker
 *  `handler` (v2, app logic runs headless in the app's worker). */
export interface GlyphhAppTool {
  name: string;
  description?: string;
  capability?: string;
  handler?: string;
  inputSchema?: Record<string, unknown>;
}

export interface GlyphhAppManifest {
  manifestVersion: number;
  kind: "glyphh-app";
  name: string;
  slug: string;
  entry: string;
  /** Headless script (v2) — runs in a hidden sandboxed window, registers
   *  handlers via glyphh.handle(). Relative to the bundle root. */
  worker?: string;
  capabilities: string[];
  /** Connector app slugs (Pipedream) this app integrates — e.g.
   *  ["salesforce", "netsuite"]. connector.* capabilities are scoped to this
   *  list. The user connects the accounts once in Glyphh; apps never see
   *  tokens. */
  connectors?: string[];
  tools?: GlyphhAppTool[];
  window?: { width?: number; height?: number };
  /** The release this bundle was cut from. Carried so an imported app arrives
   *  with its version and notes instead of a bare version string. */
  release?: { version: string; notes?: string | null; channel?: "dev" | "live"; releasedAt?: string | null };
  /** The AUTHOR'S org id — stamped at publish time (Phase 3). An installed app's
   *  local home is `apps/<publisherOrgId>/<slug>`, so the same app resolves at
   *  the same relative path on every machine that installs it. Absent on legacy
   *  bundles (they fall back to the installing user's org). */
  publisherOrgId?: string;
  description?: string;
}

const KNOWN_CAPABILITIES = new Set([
  "contacts.search",
  "messages.send",
  "db.exec",
  "cron.schedule",
  "cron.cancel",
  "cron.list",
  "notify.send",
  "connector.status",
  "connector.tools",
  "connector.call",
  "llm.embed",
  "llm.chunk",
  "llm.complete",
  "agent.run",
  "vector.upsert",
  "vector.search",
  "vector.delete",
  "graph.cypher",
  "secrets.get",
  "secrets.list",
  "fs.read",
  "fs.write",
  "fs.pick",
  "web.fetch", "web.read",
]);

/** AppleScript-backed capabilities that only exist on macOS. Everything else
 *  (db/cron/notify) is cross-platform. */
const DARWIN_ONLY_CAPABILITIES = new Set(["contacts.search", "messages.send"]);

function customAppsDir(): string {
  return userScopedPath("custom-apps");
}

/** The active account's org id — the namespace for locally-held apps. Cached
 *  after the first resolve; best-effort (a pre-auth or offline call returns
 *  null and the caller falls back to the legacy flat root). */
async function currentOrgId(): Promise<string | null> {
  // THE PURGE: no server org — locally-held apps live under the flat root
  // (a bundle's publisherOrgId still namespaces marketplace-era installs).
  return null;
}

/** Directories that hold a registered Glyphh app's UI and must get the app-session
 *  egress-sandbox CSP — the copy-install root (custom-apps/) PLUS any IN-PLACE dev
 *  build (a working folder's dist/). Keying the sandbox by REGISTERED APP ROOT, not
 *  a single dir prefix, is what lets a developer's own app run where it lives. */
const REGISTERED_APP_ROOTS = new Set<string>();

/**
 * Register the WORKING FOLDER's built app to run IN PLACE — no copy. This is the
 * develop loop for an app's OWNER: the saved row's execPath points at the built
 * entry inside the working folder (<dir>/dist/index.html), so open_app opens the
 * developer's ACTUAL build and a rebuild shows on the next open. Copy-install
 * (installGlyphhAppBundle) is reserved for installing SOMEONE ELSE's published app,
 * which has no working folder on this machine.
 */
export async function registerAppInPlace(appProjectDir: string, manifestJson: string): Promise<{ ok: boolean; name?: string; error?: string }> {
  const manifest = readGlyphhAppManifest(manifestJson);
  if (!manifest) return { ok: false, error: "invalid glyphh.app.json manifest" };
  const distDir = path.join(appProjectDir, "dist");
  const entryPath = path.join(distDir, "index.html");
  if (!fs.existsSync(entryPath)) return { ok: false, error: "no build found — run `npm run build` first (dist/index.html missing)" };
  if (manifest.capabilities.some((c) => c.startsWith("connector.")) && !(manifest.connectors || []).length) {
    return { ok: false, error: "manifest declares connector.* capabilities but lists no connectors[]" };
  }
  // The built dist IS a sandboxed app root: the session CSP (connect-src 'none')
  // stamps any file:// under a registered root, so an in-place dev build gets the
  // SAME egress lockdown as a copy-installed app.
  REGISTERED_APP_ROOTS.add(distDir);
  const fields = {
    name: manifest.name, slug: manifest.slug, url: null, isBrowser: false,
    execPath: entryPath, appArchetype: "glyphh-app",
    launchConfig: {
      capabilities: manifest.capabilities, connectors: manifest.connectors ?? [],
      tools: manifest.tools ?? [], window: manifest.window ?? null, worker: manifest.worker ?? null,
      ...(manifest.release ? { release: manifest.release } : {}),
    },
  };
  try {
    const existing = await fetchOrgApps().then((apps) => apps.find((a) => a.slug === manifest.slug)).catch(() => undefined);
    if (existing) {
      // Config vars (secrets) are USER data — preserve them across a re-register.
      const secrets = (existing.launchConfig as { secrets?: unknown } | null | undefined)?.secrets;
      if (secrets && typeof secrets === "object") (fields.launchConfig as Record<string, unknown>).secrets = secrets;
      await appsStore.updateEntry(existing.slug, { name: fields.name, nativeRef: fields.execPath, config: fields.launchConfig });
    } else {
      await appsStore.createEntry({ kind: "glyphh", slug: fields.slug, name: fields.name, nativeRef: fields.execPath, config: fields.launchConfig });
    }
    invalidateOrgApps();
    for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send("panel-apps-changed"); }
  } catch (e) {
    return { ok: false, error: `register failed: ${(e as Error).message}` };
  }
  return { ok: true, name: manifest.name };
}

/** What a bundle's page may reach through window.glyphh when app.json names no capabilities. */
const BUNDLE_DEFAULT_CAPABILITIES = ["db.exec", "notify.send", "agent.run", "llm.complete", "connector.status", "connector.tools", "connector.call"];

interface BundleManifest {
  name?: string;
  ui?: string;
  /** A built-in work panel (gdesign, gpoint, gimage, gvideo, gsound): the tab opens it instead of the ui. */
  tool?: string;
  tools?: string;
  capabilities?: string[];
  dependencies?: { connections?: Array<{ app?: string; as?: string }> };
}

/** A Glyphh app BUNDLE (SKILL.md + app.json + ui/) in the apps home becomes a
 *  tab: a glyphh-app row whose entry is the bundle's ui, granted the caps it
 *  declares (or the bundle defaults) and its connection dependencies. Idempotent:
 *  a second call updates the row in place. `slug` and `name` let a user make a
 *  second tab for the same bundle under another name. */
export async function registerBundleApp(dir: string, opts: { slug?: string; name?: string } = {}): Promise<{ ok: boolean; slug?: string; name?: string; tool?: string; error?: string }> {
  let m: BundleManifest;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, "app.json"), "utf-8")) as BundleManifest; }
  catch (e) { return { ok: false, error: `app.json unreadable: ${(e as Error).message}` }; }
  const ui = String(m.ui || "ui/index.html");
  const entryPath = path.join(dir, ui);
  if (!fs.existsSync(entryPath)) return { ok: false, error: `the app's ui entry is missing: ${ui}` };
  let tools: unknown[] = [];
  if (m.tools) {
    try { const t = JSON.parse(fs.readFileSync(path.join(dir, m.tools), "utf-8")) as { tools?: unknown[] }; tools = Array.isArray(t.tools) ? t.tools : []; }
    catch { tools = []; }
  }
  const slug = (opts.slug || path.basename(dir)).toLowerCase().trim();
  const name = opts.name || String(m.name || path.basename(dir));
  const capabilities = Array.isArray(m.capabilities) && m.capabilities.length ? m.capabilities.map(String) : BUNDLE_DEFAULT_CAPABILITIES;
  const connectors = (m.dependencies?.connections || []).map((c) => String(c.app || "")).filter(Boolean);
  const config = { capabilities, connectors, tools, bundleDir: dir, ...(m.tool ? { tool: String(m.tool) } : {}) };
  try {
    const existing = await fetchOrgApps().then((apps) => apps.find((a) => a.slug === slug)).catch(() => undefined);
    if (existing) {
      const secrets = (existing.launchConfig as { secrets?: unknown } | null | undefined)?.secrets;
      await appsStore.updateEntry(slug, { name, kind: "glyphh", nativeRef: entryPath, config: secrets && typeof secrets === "object" ? { ...config, secrets } : config });
    } else {
      await appsStore.createEntry({ kind: "glyphh", slug, name, nativeRef: entryPath, config });
    }
    invalidateOrgApps();
    for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send("panel-apps-changed"); }
  } catch (e) {
    return { ok: false, error: `register failed: ${(e as Error).message}` };
  }
  return { ok: true, slug, name, ...(m.tool ? { tool: String(m.tool) } : {}) };
}

/** The bundle is gone: drop every tab that pointed into its folder. */
export async function unregisterBundleApp(dir: string): Promise<void> {
  const rows = await appsStore.mine();
  for (const r of rows) {
    if ((r.config as { bundleDir?: string } | null)?.bundleDir === dir) await appsStore.removeEntry(r.slug);
  }
  invalidateOrgApps();
  for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send("panel-apps-changed"); }
}

/** Parse + validate a glyphh-app manifest ("" slug etc. rejected). */
export function readGlyphhAppManifest(json: string): GlyphhAppManifest | null {
  let m: GlyphhAppManifest;
  try { m = JSON.parse(json); } catch { return null; }
  if (m?.kind !== "glyphh-app") return null;
  if (!m.name || !m.slug || !m.entry) return null;
  m.slug = String(m.slug).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  // Leading-underscore slugs are reserved for host dirs under custom-apps/
  // (e.g. _libs, the shared UI-library bundles apps load relatively).
  if (m.slug.startsWith("_")) return null;
  m.capabilities = Array.isArray(m.capabilities) ? m.capabilities.map(String) : [];
  m.connectors = Array.isArray(m.connectors)
    ? [...new Set(m.connectors.map((c) => String(c).trim().toLowerCase()).filter((c) => /^[a-z0-9_-]+$/.test(c)))]
    : [];
  m.worker = typeof m.worker === "string" && m.worker.trim() ? m.worker.trim() : undefined;
  m.tools = Array.isArray(m.tools)
    ? m.tools.filter(
        (t) =>
          t &&
          typeof t.name === "string" &&
          // exactly one backing: a host capability OR a worker handler
          (typeof t.capability === "string") !== (typeof t.handler === "string")
      )
    : [];
  return m;
}

/** Peek a .glyphh zip's manifest to see if it's a glyphh-app (vs a legacy app). */
export function isGlyphhAppBundle(zipPath: string): boolean {
  try {
    const entry = new AdmZip(zipPath).getEntry("manifest.json");
    if (!entry) return false;
    return JSON.parse(entry.getData().toString("utf8"))?.kind === "glyphh-app";
  } catch {
    return false;
  }
}

// ── install ─────────────────────────────────────────────────

/**
 * Install a .glyphh glyphh-app bundle: extract it locally and create the
 * server app row. Returns { ok, name } or { ok:false, error }.
 */
export async function installGlyphhAppBundle(zipPath: string): Promise<{ ok: boolean; name?: string; updated?: boolean; error?: string; connectors?: string[] }> {
  let zip: AdmZip;
  try { zip = new AdmZip(zipPath); } catch { return { ok: false, error: "Not a readable .glyphh bundle" }; }
  const entry = zip.getEntry("manifest.json");
  if (!entry) return { ok: false, error: "Bundle has no manifest.json" };
  const manifest = readGlyphhAppManifest(entry.getData().toString("utf8"));
  if (!manifest) return { ok: false, error: "manifest.json is not a valid glyphh-app manifest" };

  const unknown = manifest.capabilities.filter((c) => !KNOWN_CAPABILITIES.has(c));
  // NAME THE ALTERNATIVES (his rule, 2026-08-25): a bare refusal sent an agent
  // grepping the packaged asar for this very list. The set is small — print it.
  if (unknown.length) {
    return {
      ok: false,
      error: `Unknown capabilities: ${unknown.join(", ")}. Valid capabilities are: ${[...KNOWN_CAPABILITIES].sort().join(", ")}. ` +
        `Connector access is declared as capability "connector.call" (plus "connector.tools"/"connector.status"), with the ACCOUNTS named in the manifest's "connectors" array — never as connector.<name>.`,
    };
  }

  // Every capability-backed tool must reference a capability the app also
  // declared; every handler-backed tool needs the manifest to ship a worker.
  const badTool = (manifest.tools || []).find((t) => t.capability && !manifest.capabilities.includes(t.capability));
  if (badTool) return { ok: false, error: `Tool "${badTool.name}" needs undeclared capability "${badTool.capability}"` };
  const handlerTool = (manifest.tools || []).find((t) => t.handler);
  if (handlerTool && !manifest.worker) {
    return { ok: false, error: `Tool "${handlerTool.name}" uses a handler but the manifest declares no worker` };
  }
  // connector.* capabilities are meaningless without a connectors list (every
  // call would fail the declared-connector check) — refuse loudly instead.
  if (manifest.capabilities.some((c) => c.startsWith("connector.")) && !(manifest.connectors || []).length) {
    return { ok: false, error: "connector.* capabilities require a non-empty `connectors` list in the manifest" };
  }
  // A manifest tool backed by agent.run would let the agent call itself
  // (agent → tool → agent → …). Keep the loop non-recursive.
  const recursiveTool = (manifest.tools || []).find((t) => t.capability === "agent.run");
  if (recursiveTool) {
    return { ok: false, error: `Tool "${recursiveTool.name}" cannot expose agent.run as a tool` };
  }

  // Defense in depth over the runtime CSP: refuse a bundle whose HTML/CSS/JS
  // references remote code (CDN, external <script>/<link>, remote import) —
  // catches hand-crafted or imported .glyphh files, not just update_app builds.
  const textEntries: Record<string, string> = {};
  for (const e of zip.getEntries()) {
    if (e.isDirectory || !/\.(html?|css|m?js|jsx|ts|tsx)$/i.test(e.entryName)) continue;
    if (e.header.size > 2_000_000) continue;
    try { textEntries[e.entryName] = e.getData().toString("utf8"); } catch { /* skip */ }
  }
  const remote = lintRemoteAssets(textEntries);
  if (remote.length) return { ok: false, error: `Bundle references remote assets (bundle them at build time): ${remote[0]}` };

  // Install lands in the app's org-scoped local home apps/<author-org>/<slug>.
  // The author's org rides in the bundle (publisherOrgId, Phase 3); a legacy
  // bundle without it installs under THIS user's org. If the org can't be
  // resolved (pre-auth/offline), fall back to the legacy flat root so an install
  // never hard-fails on a path decision.
  const ownerOrg = manifest.publisherOrgId || (await currentOrgId());
  const dir = ownerOrg ? appDir(ownerOrg, manifest.slug) : path.join(customAppsDir(), manifest.slug);
  fs.mkdirSync(dir, { recursive: true });
  zip.extractAllTo(dir, true);
  const entryPath = path.join(dir, manifest.entry);
  if (!fs.existsSync(entryPath)) return { ok: false, error: `Bundle entry not found after extract: ${manifest.entry}` };
  if (manifest.worker && !fs.existsSync(path.join(dir, manifest.worker))) {
    return { ok: false, error: `Bundle worker not found after extract: ${manifest.worker}` };
  }

  // Register as a normal saved app — same rails as everything else. Re-import
  // of the same slug UPDATES the existing row (so "update the app" works)
  // instead of failing on the unique-slug constraint.
  const fields = {
    name: manifest.name,
    slug: manifest.slug,
    url: null,
    isBrowser: false,
    execPath: entryPath,
    appArchetype: "glyphh-app",
    launchConfig: {
      capabilities: manifest.capabilities,
      connectors: manifest.connectors ?? [],
      tools: manifest.tools ?? [],
      window: manifest.window ?? null,
      worker: manifest.worker ?? null,
      // What the installer sees on the Releases tab: this app came from a bundle,
      // and the bundle knows which build it is.
      ...(manifest.release ? { release: manifest.release } : {}),
    },
  };
  let updated = false;
  try {
    const existing = await fetchOrgApps()
      .then((apps) => apps.find((a) => a.slug === manifest.slug))
      .catch(() => undefined);
    if (existing) {
      // Config vars (launchConfig.secrets) are USER data, not bundle data —
      // they must survive app updates, which otherwise replace launchConfig.
      const secrets = existing.launchConfig?.secrets;
      if (secrets && typeof secrets === "object") {
        (fields.launchConfig as Record<string, unknown>).secrets = secrets;
      }
      await appsStore.updateEntry(existing.slug, {
        name: fields.name,
        nativeRef: fields.execPath,
        config: fields.launchConfig,
      });
      updated = true;
    } else {
      await appsStore.createEntry({
        // Its own kind: the config below is the BUNDLE CONTRACT (capabilities,
        // connectors, tools, worker), which the native allowlist rejects.
        kind: "glyphh",
        slug: fields.slug,
        name: fields.name,
        nativeRef: fields.execPath,
        config: fields.launchConfig,
      });
    }
    invalidateOrgApps();
    // Tell every open window the app library changed so the Apps page
    // re-fetches — without this, an app installed over the MCP relay
    // doesn't appear until the user manually reloads.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("panel-apps-changed");
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // (Re)install: kill any running worker so the next invoke runs the new
  // code, then warm-start it so the app can (re-)register its cron schedules
  // immediately — without this, a freshly deployed background app would sit
  // dead until something else invoked it.
  stopAppWorker(manifest.slug);
  if (manifest.worker) {
    void ensureAppWorker({
      slug: manifest.slug,
      name: manifest.name,
      appDir: dir,
      workerFile: manifest.worker,
      capabilities: manifest.capabilities,
      connectors: manifest.connectors ?? [],
    }).catch((err) => console.error(`[glyphh-app] worker warm-start "${manifest.slug}" failed:`, err instanceof Error ? err.message : err));
  }
  return { ok: true, name: manifest.name, updated: updated || undefined, connectors: manifest.connectors ?? [] };
}

// ── run ─────────────────────────────────────────────────────


export interface GlyphhAppRow {
  name: string;
  slug: string;
  execPath?: string | null;
  launchConfig?: Record<string, unknown> | null;
}

/** True when a saved-app row is an installed Glyphh app — by archetype, or
 *  structurally (its executable is an .html entry, which must never be spawned
 *  as a program). The structural check keeps routing correct even if the
 *  archetype field was dropped somewhere. */
export function isGlyphhAppRow(row: { appArchetype?: string | null; execPath?: string | null }): boolean {
  if (row.appArchetype === "glyphh-app") return true;
  return !!row.execPath && /\.html?$/i.test(row.execPath);
}

/** The capability + connector grant a row's UI/preview should receive — the
 *  declared caps filtered to ones the host actually knows. Shared by the
 *  standalone window (openGlyphhApp) and the in-app preview grant. */
function grantsFromRow(row: { launchConfig?: Record<string, unknown> | null }): { caps: string[]; connectors: string[] } {
  const lc = (row.launchConfig || {}) as { capabilities?: unknown; connectors?: unknown };
  const caps = Array.isArray(lc.capabilities) ? lc.capabilities.map(String).filter((c) => KNOWN_CAPABILITIES.has(c)) : [];
  const connectors = Array.isArray(lc.connectors) ? lc.connectors.map(String) : [];
  return { caps, connectors };
}

/** An installed app renders its own local UI and reaches the host only through
 *  granted capabilities — it must never navigate to, or open, a remote page.
 *  Paired with the app-session CSP (which blocks fetch/XHR/img egress), this
 *  closes the UI window's outbound network. Navigation is allowed only within the
 *  app's own bundle dir (`appDir`, for multi-page apps); everything else denied. */
function attachAppWindowEgressGuards(wc: Electron.WebContents, appDir: string): void {
  const root = appDir + path.sep;
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  const guard = (e: Electron.Event, url: string) => {
    if (!url.startsWith("file://")) { e.preventDefault(); return; }
    try { if (!fileURLToPath(url).startsWith(root)) e.preventDefault(); }
    catch { e.preventDefault(); }
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
}

// ── capabilities (macOS AppleScript) ────────────────────────

function osa(script: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Contacts matching `query` — phone + email rows, capped at 12 people. */
async function contactsSearch(query: string): Promise<Array<{ name: string; value: string }>> {
  const q = esc(String(query || "").trim());
  if (!q) return [];
  const out = await osa(`
tell application "Contacts"
  set AppleScript's text item delimiters to linefeed
  set acc to {}
  set ppl to (every person whose name contains "${q}")
  if (count of ppl) > 12 then set ppl to items 1 thru 12 of ppl
  repeat with p in ppl
    set pn to name of p
    repeat with ph in phones of p
      set end of acc to pn & tab & (value of ph)
    end repeat
    repeat with em in emails of p
      set end of acc to pn & tab & (value of em)
    end repeat
  end repeat
  return acc as text
end tell`);
  return out.split("\n").map((l) => l.split("\t")).filter((f) => f.length >= 2 && f[0].trim())
    .map((f) => ({ name: f[0].trim(), value: f[1].trim() }));
}

/** Send via Messages — iMessage first, SMS-relay fallback. */
async function messagesSend(to: string, body: string): Promise<void> {
  const t = esc(String(to || "").trim());
  const b = esc(String(body || ""));
  if (!t) throw new Error("recipient is required");
  if (!b) throw new Error("message is required");
  const attempt = (serviceType: string) => osa(`
tell application "Messages"
  set svc to 1st service whose service type = ${serviceType}
  send "${b}" to participant "${t}" of svc
end tell`);
  try {
    await attempt("iMessage");
  } catch (imErr) {
    try { await attempt("SMS"); }
    catch { throw imErr instanceof Error ? imErr : new Error(String(imErr)); }
  }
}

/**
 * Run a host capability — the ONE place capability calls are dispatched,
 * shared by the UI IPC path (window), the worker path (headless app logic),
 * and the MCP tool path (relay). Callers enforce the capability grant BEFORE
 * calling this; `slug`/`appName` identify the calling app so services
 * (db/cron/notify) stay scoped to it.
 */
async function runCapability(
  slug: string,
  appName: string,
  method: string,
  args: Record<string, unknown>,
  connectors: Set<string> = new Set(),
  senderWc?: Electron.WebContents
): Promise<unknown> {
  if (DARWIN_ONLY_CAPABILITIES.has(method) && process.platform !== "darwin") {
    throw new Error(`capability ${method} is macOS-only for now`);
  }
  switch (method) {
    case "contacts.search":  return contactsSearch(String(args.query || ""));
    case "messages.send":    await messagesSend(String(args.to || ""), String(args.body || "")); return { sent: true };
    case "db.exec":          return dbExec(slug, args);
    case "cron.schedule":    return cronSchedule(slug, args);
    case "cron.cancel":      return cronCancel(slug, args);
    case "cron.list":        return cronList(slug);
    case "notify.send":      return notifySend(slug, appName, args);
    case "connector.status": return connectorStatus(connectors);
    case "connector.tools":  return connectorTools(connectors, args);
    case "connector.call":   return connectorCall(connectors, args);
    case "web.fetch":        return webFetch(args);
    case "web.read":         return webRead(args);
    case "llm.embed":        throw new Error("this capability is retired — Glyphh makes no model calls; the driving agent (your CLI) does this itself");
    case "llm.chunk":        throw new Error("this capability is retired — Glyphh makes no model calls; the driving agent (your CLI) does this itself");
    case "llm.complete":
    case "agent.run":
      throw new Error("this capability is retired — Glyphh makes no model calls; the driving agent (your CLI) does this itself");
    case "secrets.get": {
      const key = String(args.key || "").trim();
      if (!key) throw new Error("key is required");
      const app = await findAppRow(slug);
      // Default-deny. Credential-shaped vars (provider API keys, tokens,
      // secrets) are HOST-ONLY forever; everything else is host-only too UNLESS
      // the user explicitly marked it "readable by app code" on the Config Vars
      // tab. The trusted runtime (llm.complete / agent.run / LLM-proxy wrappers)
      // still uses host-only keys in the main process and returns only results —
      // so a key lent to an untrusted remote agent can never be read back out.
      if (isHostOnlySecret(key)) {
        throw new Error(`"${key}" is host-only — the Glyphh runtime uses it for you (llm.complete / agent.run) and never exposes the value to app code.`);
      }
      if (!isSecretAppReadable(app?.launchConfig as Record<string, unknown> | undefined, key)) {
        throw new Error(`"${key}" is not app-readable — turn on "Readable by app code" for it on the app's Config Vars tab to expose its value.`);
      }
      const value = secretValueFromRow(app?.launchConfig as Record<string, unknown> | undefined, key);
      if (value == null) throw new Error(`config var not set: ${key} — the user sets it on the app's Config Vars tab`);
      return { value };
    }
    case "secrets.list": {
      const app = await findAppRow(slug);
      return secretKeysFromRow(app?.launchConfig as Record<string, unknown> | undefined);
    }
    case "vector.upsert":    throw new Error("this capability is retired — Glyphh makes no model calls; the driving agent (your CLI) does this itself");
    case "vector.search":    throw new Error("this capability is retired — Glyphh makes no model calls; the driving agent (your CLI) does this itself");
    case "vector.delete":    throw new Error("this capability is retired — Glyphh makes no model calls; the driving agent (your CLI) does this itself");
    case "graph.cypher":     throw new Error("this capability is retired — Glyphh makes no model calls; the driving agent (your CLI) does this itself");
    // Filesystem is brokered + user-scoped: fs.pick (interactive OS dialog)
    // grants a root; read/write only resolve under a granted root. See glyphh-app-fs.
    case "fs.pick":          return fsPick(senderWc, args, slug);
    case "fs.read":          return fsRead(slug, args);
    case "fs.write":         return fsWrite(slug, args);
    default: throw new Error(`unknown capability: ${method}`);
  }
}

// ── Install from a base64 bundle (MCP app_install / apps.install) ────────────

/** Install a .glyphh handed over as base64 (Claude deploying an app it built). */
export async function installGlyphhAppBundleFromBase64(bundleBase64: string): Promise<{ ok: boolean; name?: string; updated?: boolean; error?: string; connectors?: string[] }> {
  const b64 = String(bundleBase64 || "").replace(/^data:[^,]*,/, "");
  if (!b64) return { ok: false, error: "bundleBase64 is required" };
  const tmp = path.join(os.tmpdir(), `glyphh-app-${process.pid}-${Buffer.from(b64).length}.glyphh`);
  try {
    fs.writeFileSync(tmp, Buffer.from(b64, "base64"));
    return await installGlyphhAppBundle(tmp);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

// ── Discovery + headless invocation (relay: apps.listTools / apps.callTool) ──

interface AppRow {
  slug: string;
  name: string;
  appArchetype?: string | null;
  execPath?: string | null;
  launchConfig?: { capabilities?: string[]; connectors?: string[]; tools?: Array<GlyphhAppTool & { run?: string; input?: Record<string, unknown> }>; worker?: string | null; bundleDir?: string } | null;
}

/** Tools the user set to Never on the app's Tools tab (Settings → Build → Apps). */
function hiddenAppTools(slug: string): Set<string> {
  const list = getPreference<unknown>(`appHiddenTools:${slug}`, []);
  return new Set(Array.isArray(list) ? list.map(String) : []);
}

/** Saved-app row → the spec needed to run its worker (null if it has none). */
function workerSpecFromRow(row: AppRow): AppWorkerSpec | null {
  const workerFile = row.launchConfig?.worker;
  const entryPath = String(row.execPath || "");
  if (!workerFile || !entryPath) return null;
  return {
    slug: row.slug,
    name: row.name,
    appDir: path.dirname(entryPath),
    workerFile,
    capabilities: (row.launchConfig?.capabilities || []).filter((c) => KNOWN_CAPABILITIES.has(c)),
    connectors: row.launchConfig?.connectors || [],
  };
}

async function findAppRow(slug: string): Promise<AppRow | undefined> {
  const key = String(slug || "").trim().toLowerCase();
  // The shared row types launchConfig loosely; AppRow narrows it to the
  // Glyphh-app keys this module reads.
  const apps = await fetchOrgApps().catch(() => []) as AppRow[];
  return apps.find((a) => isGlyphhAppRow(a) && a.slug.toLowerCase() === key);
}

/** Key auto-pickup for llm.complete / agent.run: with no explicit apiKey, use
 *  the app's config var named <PROVIDER>_API_KEY (Config Vars tab). The key
 *  is the APP's, held encrypted per-app — Glyphh has no key store of its own. */
function withAppApiKey(app: AppRow, args: Record<string, unknown>): Record<string, unknown> {
  if (args.apiKey) return args;
  const provider = String(args.provider || "anthropic").toUpperCase();
  const key = secretValueFromRow(app.launchConfig as Record<string, unknown>, `${provider}_API_KEY`);
  return key ? { ...args, apiKey: key } : args;
}

/** Every installed Glyphh app + the MCP tools it exposes (for app_list_tools). */
export async function listInstalledAppTools(): Promise<Array<{ app: string; name: string; tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>> {
  // The shared row types launchConfig loosely; AppRow narrows it to the
  // Glyphh-app keys this module reads.
  const apps = await fetchOrgApps().catch(() => []) as AppRow[];
  return apps
    .filter((a) => isGlyphhAppRow(a))
    .map((a) => {
      const hidden = hiddenAppTools(a.slug);
      return {
        app: a.slug,
        name: a.name,
        tools: (a.launchConfig?.tools || []).filter((t) => !hidden.has(t.name)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? t.input })),
      };
    })
    .filter((a) => a.tools.length > 0);
}

/** Run an installed app's declared MCP tool headlessly (for app_call_tool).
 *  Capability tools pass straight through to the host; handler tools run the
 *  app's own logic in its worker. */
export async function callAppTool(appSlug: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const app = await findAppRow(appSlug);
  if (!app) throw new Error(`unknown app: ${appSlug}`);
  const tool = (app.launchConfig?.tools || []).find((t) => t.name === toolName);
  if (!tool) throw new Error(`app "${appSlug}" has no tool "${toolName}"`);
  if (hiddenAppTools(app.slug).has(toolName)) throw new Error(`tool "${toolName}" is set to Never for this app`);

  // A bundle tool (Settings → Build → Apps): `run` is a script in the bundle
  // with the tool's input as JSON on stdin and its JSON answer on stdout.
  if (tool.run) {
    const dir = app.launchConfig?.bundleDir || path.dirname(String(app.execPath || ""));
    const [script, ...rest] = tool.run.split(/\s+/);
    if (!script) throw new Error(`tool "${toolName}" names no script`);
    const file = path.resolve(dir, script);
    if (!file.startsWith(path.resolve(dir) + path.sep)) throw new Error(`tool "${toolName}" reaches outside its bundle`);
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [file, ...rest], { cwd: dir, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", GLYPHH_APP: app.slug } }, (err, stdout, stderr) => {
        if (err) { reject(new Error(String(stderr || err.message).trim().slice(0, 2000))); return; }
        const out = String(stdout).trim();
        try { resolve(out ? JSON.parse(out) : { ok: true }); } catch { resolve({ output: out }); }
      });
      child.stdin?.end(JSON.stringify(args || {}));
    });
  }

  if (tool.handler) {
    const spec = workerSpecFromRow(app);
    if (!spec) throw new Error(`tool "${toolName}" needs a worker but the app has none — re-install it`);
    return invokeAppWorkerHandler(spec, tool.handler, args || {});
  }

  const declared = app.launchConfig?.capabilities || [];
  if (!tool.capability || !declared.includes(tool.capability)) throw new Error(`tool "${toolName}" uses undeclared capability`);
  return runCapability(app.slug, app.name, tool.capability, args || {}, new Set(app.launchConfig?.connectors || []));
}

// ── IPC ─────────────────────────────────────────────────────

let registered = false;

/** Preview webContents ids that already have a teardown-revoke listener, so
 *  repeated preview-open calls on the reused preview <webview> don't stack up. */
const previewRevokeWired = new Set<number>();

/** CSP applied to installed-app UI documents (file:// under custom-apps/). Apps
 *  render from their own local + inline assets and reach the host only over the
 *  glyphh.call IPC bridge (not governed by CSP), so ALL remote loads and
 *  connect-src (fetch/XHR/WebSocket/beacon) are blocked — a conforming-but-
 *  malicious app can't exfiltrate the data it holds. file:/data:/blob: stay
 *  allowed for local resource types so ../_libs/* and sibling assets still load. */
const APP_UI_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' file:",
  "style-src 'self' 'unsafe-inline' file:",
  "img-src 'self' data: blob: file:",
  "font-src 'self' data: file:",
  "media-src 'self' data: blob: file:",
  "worker-src 'self' blob: file:",
  "connect-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * One-time relocation of legacy flat installs (custom-apps/<slug>) into the
 * org-scoped layout (apps/<org>/<slug>), repointing each saved row's execPath.
 * Best-effort + idempotent: an app whose org can't be resolved, or whose target
 * already exists, is left where it is (it keeps working — custom-apps stays
 * CSP-covered). Runs post-auth from registerGlyphhAppHost; a pre-auth boot just
 * migrates on the next launch. `_libs` and non-glyphh rows are skipped.
 */
async function migrateCustomAppsToOrgScoped(): Promise<void> {
  try {
    const legacyRoot = customAppsDir();
    if (!fs.existsSync(legacyRoot)) return;
    const orgId = await currentOrgId();
    if (!orgId) return;
    const legacyPrefix = legacyRoot + path.sep;
    const rows = await fetchOrgApps().catch(() => []);
    let moved = 0;
    for (const row of rows) {
      const execPath = String(row.execPath || "");
      if (!execPath.startsWith(legacyPrefix) || !isGlyphhAppRow(row)) continue;
      const sourceDir = path.join(legacyRoot, row.slug);
      if (!fs.existsSync(sourceDir)) continue;
      const targetDir = appDir(orgId, row.slug);
      if (fs.existsSync(targetDir)) continue; // already migrated or a name clash — leave the legacy copy
      try {
        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        fs.renameSync(sourceDir, targetDir);
        const newExec = path.join(targetDir, path.relative(sourceDir, execPath));
        await appsStore.updateEntry(row.slug, { nativeRef: newExec });
        moved++;
      } catch (e) {
        console.error(`[glyphh-app] migrate ${row.slug} → org-scoped failed:`, e instanceof Error ? e.message : e);
      }
    }
    if (moved) {
      invalidateOrgApps();
      for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send("panel-apps-changed"); }
    }
  } catch (e) {
    console.error("[glyphh-app] org-scope migration failed:", e instanceof Error ? e.message : e);
  }
}

const hardenedAppSessions = new WeakSet<Electron.Session>();

/** Inject APP_UI_CSP onto installed-app UI documents loaded in `ses`. Idempotent
 *  per session. Only the top document under custom-apps/ is stamped; the worker
 *  shell is skipped (it ships its own stricter meta CSP). */
function hardenAppSession(ses: Electron.Session): void {
  if (hardenedAppSessions.has(ses)) return;
  hardenedAppSessions.add(ses);
  // Every dir that can hold a locally-held app's UI must get the sandbox CSP:
  // the org-scoped root (apps/<org>/<slug>), the legacy flat root (custom-apps/),
  // and any registered in-place dev build. Widening here is strictly ADDITIVE —
  // it only ever ADDS the egress lockdown to more file:// documents.
  const prefixRoots = [appsRoot() + path.sep, customAppsDir() + path.sep, appsStore.APPS_DIR() + path.sep];
  ses.webRequest.onHeadersReceived({ urls: ["file://*/*"] }, (details, callback) => {
    const headers = details.responseHeaders || {};
    if (details.resourceType === "mainFrame" && !details.url.includes(".glyphh-worker.html")) {
      let underAppRoot = false;
      try {
        const fp = fileURLToPath(details.url);
        underAppRoot =
          prefixRoots.some((r) => fp.startsWith(r)) ||
          [...REGISTERED_APP_ROOTS].some((r) => fp === r || fp.startsWith(r + path.sep));
      } catch { /* not a plain file path */ }
      if (underAppRoot) {
        for (const k of Object.keys(headers)) {
          if (/^content-security-policy/i.test(k)) delete headers[k];
        }
        headers["Content-Security-Policy"] = [APP_UI_CSP];
      }
    }
    callback({ responseHeaders: headers });
  });
}

/**
 * Publish the host-provided UI libraries (Chart.js, three.js, React Flow —
 * built by scripts/build-app-libs.mjs into dist/renderer/app-libs) to
 * ~/.glyphh/custom-apps/_libs/ so every installed app can load them with a
 * relative <script src="../_libs/<name>.js">. Copied (not symlinked) so app
 * pages never reach into the install dir, and refreshed on every startup so
 * they track the running Glyphh version.
 */
function syncAppLibs(): void {
  try {
    const src = path.join(__dirname, "..", "renderer", "app-libs");
    if (!fs.existsSync(src)) return;
    const dst = path.join(customAppsDir(), "_libs");
    fs.mkdirSync(dst, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, file), path.join(dst, file));
    }
  } catch (err) {
    console.error("[glyphh-app] app-libs sync failed:", err instanceof Error ? err.message : err);
  }
}

/** Register the glyphh-app IPC surface (idempotent; call once at startup).
 *  Also wires app services (per-app db, cron re-arm, notifications) — cron
 *  schedules persisted by installed apps come back to life here. */
export function registerGlyphhAppHost(): void {
  if (registered) return;
  registered = true;

  syncAppLibs();
  // Harden the sessions that host installed-app UI pages (standalone window =
  // default session; in-app preview = persist:yo) with the app CSP.
  hardenAppSession(session.defaultSession);
  hardenAppSession(session.fromPartition("persist:yo"));
  // Relocate any legacy flat installs into the org-scoped layout (best-effort,
  // post-auth). Legacy apps keep working either way — custom-apps stays covered.
  void migrateCustomAppsToOrgScoped();

  initAppServices({
    resolveApp: async (slug) => {
      const row = await findAppRow(slug);
      return row ? workerSpecFromRow(row) : null;
    },
    openApp: (slug) => {
      // Workbench panel beside the agent — OS app windows are retired.
      // (Dynamic import: app-resolver imports this module for isGlyphhAppRow.)
      void import("./app-resolver.js").then((m) => m.openAppByRef(slug)).catch(() => {});
    },
  });

  ipcMain.handle("glyphh-app:call", async (event, method: string, args: unknown) => {
    const grant = getAppGrant(event.sender.id);
    const m = String(method || "");
    if (!grant || !grant.caps.has(m)) {
      return { ok: false, error: `capability not granted: ${m}` };
    }
    try {
      return { ok: true, result: await runCapability(grant.slug, grant.name, m, (args || {}) as Record<string, unknown>, grant.connectors, event.sender) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Live in-app preview (Apps page) of an installed glyphh-app. The preview
  // <webview> gets the glyphh preload in main (will-attach-webview), but the
  // bridge is inert until its webContents is granted the app's caps — mirror
  // openGlyphhApp here, then hand back the file:// entry to load so the app's
  // relative ../_libs/* references resolve from custom-apps/<slug>/.
  ipcMain.handle("glyphh-app:preview-open", async (event, previewWcId: unknown, slug: unknown) => {
    const row = await findAppRow(String(slug || ""));
    if (!row) return { ok: false, error: `unknown app: ${slug}` };
    const entryPath = String(row.execPath || "");
    if (!entryPath || !fs.existsSync(entryPath)) {
      // The LOCAL bundle is per-machine; R2/hosting is the source of record.
      // An app built on another machine still has a LIVE DEPLOYMENT to show —
      // open that instead of a dead-end error page (his report, 2026-09-09:
      // "FortessAI Marketing failed to open: App bundle is missing").
      try {
        const mine = await appsStore.mine();
        const hosted = mine.find((a) => a.slug === row.slug || a.id === row.slug)?.prodUrl;
        if (hosted) return { ok: true, fileUrl: hosted, hosted: true };
      } catch { /* offline — fall through to the honest error */ }
      // NAME THE PATH. The bare "bundle is missing" cost an hour of blind
      // hunting (2026-09-09): the row said WHERE it looked and the error
      // hid it. With the path visible, "stale row / dist mid-rebuild /
      // wrong folder registered" is a one-glance diagnosis.
      return {
        ok: false,
        error: entryPath
          ? `App bundle is missing at ${entryPath} (the registered row's entry) and it has no live deployment — rebuild + update_app from its project folder, or re-install it`
          : "This app's row has no local entry registered and no live deployment — build it (update_app) or install it",
      };
    }
    // Cover this app's dir with the egress-sandbox CSP — custom-apps/ apps are
    // already under the copy-install root; an IN-PLACE dev build (execPath in a
    // working folder's dist/) is registered here so its file:// gets the CSP too.
    REGISTERED_APP_ROOTS.add(path.dirname(entryPath));
    // Only grant to a webContents that is genuinely a webview guest of the
    // calling window — never an arbitrary id handed in by the renderer.
    const guest = typeof previewWcId === "number" ? webContents.fromId(previewWcId) : undefined;
    if (!guest || guest.hostWebContents !== event.sender) {
      return { ok: false, error: "invalid preview target" };
    }
    const { caps, connectors } = grantsFromRow(row);
    grantAppCaps(guest.id, row.slug, row.name, caps, connectors);
    // The preview <webview> is reused across apps; a later grant overwrites this
    // one in place, and teardown drops it. (Web-app previews call preview-clear.)
    // Wire the teardown-revoke once per guest so repeated switches don't pile up
    // listeners on the same long-lived webContents.
    if (!previewRevokeWired.has(guest.id)) {
      previewRevokeWired.add(guest.id);
      guest.once("destroyed", () => { revokeAppCaps(guest.id); previewRevokeWired.delete(guest.id); });
    }
    return { ok: true, fileUrl: pathToFileURL(entryPath).toString() };
  });

  // Switching the preview to a web app (or closing the detail) — drop any grant
  // left on the reused preview webContents so a web page can't inherit caps.
  ipcMain.handle("glyphh-app:preview-clear", (_event, previewWcId: unknown) => {
    if (typeof previewWcId === "number") revokeAppCaps(previewWcId);
    return { ok: true };
  });

  // Invoke an installed app's declared tool locally (Apps page "Test" button) —
  // runs the real tool via callAppTool (worker handler or host capability).
  ipcMain.handle("glyphh-app:call-tool", async (_e, slug: string, tool: string, args: unknown) => {
    try {
      return { ok: true, result: await callAppTool(String(slug || ""), String(tool || ""), (args || {}) as Record<string, unknown>) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
