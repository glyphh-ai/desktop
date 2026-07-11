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
import { glyphhPath } from "./app-paths.js";
import { serverGetAuthed, serverPostAuthed, serverPatchAuthed } from "./auth.js";
import { cachedServerGet, invalidateServerCache } from "./server-cache.js";
import { grantAppCaps, revokeAppCaps, getAppGrant } from "./glyphh-app-grants.js";
import { AppWorkerSpec, ensureAppWorker, invokeAppWorkerHandler, stopAppWorker } from "./glyphh-app-worker.js";
import { webFetch, webRead } from "./web-capability.js";
import { lintNoRemoteAssets } from "./glyphh-app-spec.js";
import {
  initAppServices, dbExec, cronSchedule, cronCancel, cronList, notifySend,
  connectorStatus, connectorTools, connectorCall,
} from "./glyphh-app-services.js";
import {
  llmEmbed, llmChunk,
  vectorUpsert, vectorSearch, vectorDelete,
  graphCypher,
} from "./glyphh-app-ai.js";
import { agentRun } from "./glyphh-app-agent.js";
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
  return glyphhPath("custom-apps");
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
  if (unknown.length) return { ok: false, error: `Unknown capabilities: ${unknown.join(", ")}` };

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
  const remote = lintNoRemoteAssets(textEntries);
  if (remote.length) return { ok: false, error: `Bundle references remote assets (bundle them at build time): ${remote[0]}` };

  const dir = path.join(customAppsDir(), manifest.slug);
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
    },
  };
  let updated = false;
  try {
    const existing = await serverGetAuthed<Array<{ id: string; slug: string; launchConfig?: Record<string, unknown> | null }>>("/api/panel-apps")
      .then((apps) => apps.find((a) => a.slug === manifest.slug))
      .catch(() => undefined);
    if (existing) {
      // Config vars (launchConfig.secrets) are USER data, not bundle data —
      // they must survive app updates, which otherwise replace launchConfig.
      const secrets = existing.launchConfig?.secrets;
      if (secrets && typeof secrets === "object") {
        (fields.launchConfig as Record<string, unknown>).secrets = secrets;
      }
      await serverPatchAuthed(`/api/panel-apps/${existing.id}`, fields);
      updated = true;
    } else {
      await serverPostAuthed("/api/panel-apps", fields);
    }
    invalidateServerCache("/api/panel-apps");
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
    case "llm.embed":        return llmEmbed(args);
    case "llm.chunk":        return llmChunk(args);
    case "llm.complete": {
      // One-shot completion = agent.run with no tools and a single turn.
      // Same auth model: the APP's own config-var key, nothing Glyphh-level.
      const app = await findAppRow(slug);
      if (!app) throw new Error(`unknown app: ${slug}`);
      const result = await agentRun(
        slug, appName,
        withAppApiKey(app, { ...args, tools: [], maxTurns: 1 }),
        { tools: [], dispatch: () => Promise.reject(new Error("llm.complete has no tools")) }
      );
      return { text: result.text, usage: result.usage };
    }
    case "agent.run": {
      const app = await findAppRow(slug);
      if (!app) throw new Error(`unknown app: ${slug}`);
      return agentRun(slug, appName, withAppApiKey(app, args), {
        tools: (app.launchConfig?.tools || []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        // Re-enters callAppTool so every agent tool call is re-validated
        // against the app's declared tools/capabilities.
        dispatch: (tool, targs) => callAppTool(slug, tool, targs),
      });
    }
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
    case "vector.upsert":    return vectorUpsert(slug, args);
    case "vector.search":    return vectorSearch(slug, args);
    case "vector.delete":    return vectorDelete(slug, args);
    case "graph.cypher":     return graphCypher(slug, args);
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
  launchConfig?: { capabilities?: string[]; connectors?: string[]; tools?: GlyphhAppTool[]; worker?: string | null } | null;
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
  const apps = await cachedServerGet<AppRow[]>("/api/panel-apps").catch(() => []);
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
  const apps = await cachedServerGet<AppRow[]>("/api/panel-apps").catch(() => []);
  return apps
    .filter((a) => isGlyphhAppRow(a))
    .map((a) => ({
      app: a.slug,
      name: a.name,
      tools: (a.launchConfig?.tools || []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    }))
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

const hardenedAppSessions = new WeakSet<Electron.Session>();

/** Inject APP_UI_CSP onto installed-app UI documents loaded in `ses`. Idempotent
 *  per session. Only the top document under custom-apps/ is stamped; the worker
 *  shell is skipped (it ships its own stricter meta CSP). */
function hardenAppSession(ses: Electron.Session): void {
  if (hardenedAppSessions.has(ses)) return;
  hardenedAppSessions.add(ses);
  const root = customAppsDir() + path.sep;
  ses.webRequest.onHeadersReceived({ urls: ["file://*/*"] }, (details, callback) => {
    const headers = details.responseHeaders || {};
    if (details.resourceType === "mainFrame" && !details.url.includes(".glyphh-worker.html")) {
      let underCustomApps = false;
      try { underCustomApps = fileURLToPath(details.url).startsWith(root); } catch { /* not a plain file path */ }
      if (underCustomApps) {
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
      return { ok: false, error: "App bundle is missing on this machine — re-install it" };
    }
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
