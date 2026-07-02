/**
 * glyphh-app-host — runtime for installable "Glyphh apps" (the marketplace
 * unit). A Glyphh app is a .yoapp zip:
 *
 *   manifest.json   { manifestVersion, kind:"glyphh-app", name, slug, entry,
 *                     capabilities: ["contacts.search", "messages.send", …],
 *                     window?: { width, height }, description? }
 *   index.html (+ assets)   self-contained UI
 *
 * Install: extract to ~/yo/custom-apps/<slug>/ and create a NORMAL saved-app
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
 * v1 capabilities (macOS, AppleScript-backed):
 *   contacts.search { query }  → [{ name, value }] phone/email rows
 *   messages.send  { to, body } → sends via Messages (iMessage, SMS fallback)
 */

import { BrowserWindow, ipcMain } from "electron";
import { execFile } from "child_process";
import AdmZip from "adm-zip";
import fs from "fs";
import os from "os";
import path from "path";
import { serverGetAuthed, serverPostAuthed, serverPatchAuthed } from "./auth.js";

// ── manifest ────────────────────────────────────────────────

/** An MCP tool an app exposes to the relay (see GLYPHH-APP-SPEC §3). */
export interface GlyphhAppTool {
  name: string;
  description?: string;
  capability: string;
  inputSchema?: Record<string, unknown>;
}

export interface GlyphhAppManifest {
  manifestVersion: number;
  kind: "glyphh-app";
  name: string;
  slug: string;
  entry: string;
  capabilities: string[];
  tools?: GlyphhAppTool[];
  window?: { width?: number; height?: number };
  description?: string;
}

const KNOWN_CAPABILITIES = new Set(["contacts.search", "messages.send"]);

function customAppsDir(): string {
  return path.join(os.homedir(), "yo", "custom-apps");
}

/** Parse + validate a glyphh-app manifest ("" slug etc. rejected). */
export function readGlyphhAppManifest(json: string): GlyphhAppManifest | null {
  let m: GlyphhAppManifest;
  try { m = JSON.parse(json); } catch { return null; }
  if (m?.kind !== "glyphh-app") return null;
  if (!m.name || !m.slug || !m.entry) return null;
  m.slug = String(m.slug).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  m.capabilities = Array.isArray(m.capabilities) ? m.capabilities.map(String) : [];
  m.tools = Array.isArray(m.tools)
    ? m.tools.filter((t) => t && typeof t.name === "string" && typeof t.capability === "string")
    : [];
  return m;
}

/** Peek a .yoapp zip's manifest to see if it's a glyphh-app (vs a legacy app). */
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
 * Install a .yoapp glyphh-app bundle: extract it locally and create the
 * server app row. Returns { ok, name } or { ok:false, error }.
 */
export async function installGlyphhAppBundle(zipPath: string): Promise<{ ok: boolean; name?: string; updated?: boolean; error?: string }> {
  let zip: AdmZip;
  try { zip = new AdmZip(zipPath); } catch { return { ok: false, error: "Not a readable .yoapp bundle" }; }
  const entry = zip.getEntry("manifest.json");
  if (!entry) return { ok: false, error: "Bundle has no manifest.json" };
  const manifest = readGlyphhAppManifest(entry.getData().toString("utf8"));
  if (!manifest) return { ok: false, error: "manifest.json is not a valid glyphh-app manifest" };

  const unknown = manifest.capabilities.filter((c) => !KNOWN_CAPABILITIES.has(c));
  if (unknown.length) return { ok: false, error: `Unknown capabilities: ${unknown.join(", ")}` };

  // Every tool must reference a capability the app also declared.
  const badTool = (manifest.tools || []).find((t) => !manifest.capabilities.includes(t.capability));
  if (badTool) return { ok: false, error: `Tool "${badTool.name}" needs undeclared capability "${badTool.capability}"` };

  const dir = path.join(customAppsDir(), manifest.slug);
  fs.mkdirSync(dir, { recursive: true });
  zip.extractAllTo(dir, true);
  const entryPath = path.join(dir, manifest.entry);
  if (!fs.existsSync(entryPath)) return { ok: false, error: `Bundle entry not found after extract: ${manifest.entry}` };

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
    launchConfig: { capabilities: manifest.capabilities, tools: manifest.tools ?? [], window: manifest.window ?? null },
  };
  try {
    const existing = await serverGetAuthed<Array<{ id: string; slug: string }>>("/api/panel-apps")
      .then((apps) => apps.find((a) => a.slug === manifest.slug))
      .catch(() => undefined);
    if (existing) {
      await serverPatchAuthed(`/api/panel-apps/${existing.id}`, fields);
      return { ok: true, name: manifest.name, updated: true };
    }
    await serverPostAuthed("/api/panel-apps", fields);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, name: manifest.name };
}

// ── run ─────────────────────────────────────────────────────

const windows = new Map<string, BrowserWindow>();          // slug → window
const grantedCaps = new Map<number, Set<string>>();        // webContents id → capabilities

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

/** Open (or focus) an installed Glyphh app from its saved-app row. */
export function openGlyphhApp(row: GlyphhAppRow): { ok: boolean; error?: string } {
  const entryPath = String(row.execPath || "");
  if (!entryPath || !fs.existsSync(entryPath)) {
    return { ok: false, error: "App bundle is missing on this machine — re-install it" };
  }
  const existing = windows.get(row.slug);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return { ok: true };
  }

  const lc = (row.launchConfig || {}) as { capabilities?: unknown; window?: { width?: number; height?: number } | null };
  const caps = Array.isArray(lc.capabilities) ? lc.capabilities.map(String).filter((c) => KNOWN_CAPABILITIES.has(c)) : [];
  const win = new BrowserWindow({
    width: lc.window?.width || 460,
    height: lc.window?.height || 640,
    title: row.name,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "glyphh-app-preload.js"),
    },
  });
  grantedCaps.set(win.webContents.id, new Set(caps));
  void win.loadFile(entryPath);
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (windows.get(row.slug) === win) windows.delete(row.slug);
  });
  win.webContents.on("destroyed", () => grantedCaps.delete(win.webContents.id));
  windows.set(row.slug, win);
  return { ok: true };
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
 * Run a host capability — the ONE place a capability is implemented, shared by
 * the UI IPC path (window) and the MCP tool path (relay, headless). Callers
 * enforce the capability grant BEFORE calling this.
 */
async function runCapability(method: string, args: Record<string, unknown>): Promise<unknown> {
  if (process.platform !== "darwin") throw new Error("this capability is macOS-only for now");
  if (method === "contacts.search") return contactsSearch(String(args.query || ""));
  if (method === "messages.send") { await messagesSend(String(args.to || ""), String(args.body || "")); return { sent: true }; }
  throw new Error(`unknown capability: ${method}`);
}

// ── Install from a base64 bundle (MCP app_install / apps.install) ────────────

/** Install a .yoapp handed over as base64 (Claude deploying an app it built). */
export async function installGlyphhAppBundleFromBase64(bundleBase64: string): Promise<{ ok: boolean; name?: string; updated?: boolean; error?: string }> {
  const b64 = String(bundleBase64 || "").replace(/^data:[^,]*,/, "");
  if (!b64) return { ok: false, error: "bundleBase64 is required" };
  const tmp = path.join(os.tmpdir(), `glyphh-app-${process.pid}-${Buffer.from(b64).length}.yoapp`);
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
  launchConfig?: { capabilities?: string[]; tools?: GlyphhAppTool[] } | null;
}

/** Every installed Glyphh app + the MCP tools it exposes (for app_list_tools). */
export async function listInstalledAppTools(): Promise<Array<{ app: string; name: string; tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>> {
  const apps = await serverGetAuthed<AppRow[]>("/api/panel-apps").catch(() => []);
  return apps
    .filter((a) => isGlyphhAppRow(a))
    .map((a) => ({
      app: a.slug,
      name: a.name,
      tools: (a.launchConfig?.tools || []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    }))
    .filter((a) => a.tools.length > 0);
}

/** Run an installed app's declared MCP tool headlessly (for app_call_tool). */
export async function callAppTool(appSlug: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const key = String(appSlug || "").trim().toLowerCase();
  const apps = await serverGetAuthed<AppRow[]>("/api/panel-apps").catch(() => []);
  const app = apps.find((a) => isGlyphhAppRow(a) && a.slug.toLowerCase() === key);
  if (!app) throw new Error(`unknown app: ${appSlug}`);
  const tool = (app.launchConfig?.tools || []).find((t) => t.name === toolName);
  if (!tool) throw new Error(`app "${appSlug}" has no tool "${toolName}"`);
  const declared = app.launchConfig?.capabilities || [];
  if (!declared.includes(tool.capability)) throw new Error(`tool "${toolName}" uses undeclared capability`);
  return runCapability(tool.capability, args || {});
}

// ── IPC ─────────────────────────────────────────────────────

let registered = false;

/** Register the glyphh-app IPC surface (idempotent; call once at startup). */
export function registerGlyphhAppHost(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle("glyphh-app:call", async (event, method: string, args: unknown) => {
    const caps = grantedCaps.get(event.sender.id);
    const m = String(method || "");
    if (!caps || !caps.has(m)) {
      return { ok: false, error: `capability not granted: ${m}` };
    }
    try {
      return { ok: true, result: await runCapability(m, (args || {}) as Record<string, unknown>) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
