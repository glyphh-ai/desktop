/**
 * glyphh-app-services — host-implemented data services for Glyphh app PANELS
 * (spec v2):
 *
 *   db.exec          { sql, params? }            per-app SQLite, one statement
 *   cron.schedule    { id, cron, handler, args? } persisted definition only
 *   cron.cancel      { id }
 *   cron.list        { }
 *   notify.send      { title, body }             OS notification; click opens the app
 *   connector.status { }                         declared connectors + connected?
 *   connector.tools  { connector? }              tool catalog for declared connectors
 *   connector.call   { connector, tool, args? }  invoke a connector tool (Pipedream via yo-server)
 *
 * EXECUTION LIVES IN THE CLOUD. This machine never runs an app worker and
 * never fires a schedule — the cloud rrotor owns both (apps never run
 * locally). cron.* here is a local DEFINITION store only: rows persist so a
 * panel's schedule CRUD keeps working, but nothing arms and nothing fires on
 * this machine.
 *
 * connector.* is what turns apps into integrations: an app declares the
 * connections it needs (manifest `connectors: ["salesforce","netsuite"]`) and
 * the host scopes every connector.* call to that list. Auth stays user-level —
 * the user connects Salesforce ONCE in Glyphh and every app that declared it
 * can use it; the app never sees tokens.
 *
 * Isolation model: every service call carries the calling app's slug (from its
 * capability grant) and is scoped to that slug — an app's database lives in
 * ~/.glyphh/app-data/<slug>/data.sqlite and its schedules are keyed by slug. Apps
 * cannot name another app's resources; there is no cross-app surface at all.
 *
 * The host injects openApp at init (initAppServices) so this module never
 * imports glyphh-app-host — no cycles.
 */

import { Notification } from "electron";
import Database from "better-sqlite3";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import { initLocalDb } from "./local-db.js";
import { glyphhPath } from "./app-paths.js";
import { getClient } from "./glyphh-client.js";
import {
  getConnectorCatalog,
  refreshConnectorCatalog,
  getCatalogAge,
  callConnectorTool,
} from "./connector-tools-client.js";

// ── wiring (injected by glyphh-app-host at startup) ─────────

interface AppServicesDeps {
  /** Open the app's UI window (notification click). */
  openApp: (slug: string) => void;
}

let deps: AppServicesDeps | null = null;

function requireDeps(): AppServicesDeps {
  if (!deps) throw new Error("app services not initialized");
  return deps;
}

// ── per-app SQLite (db.exec) ────────────────────────────────

const appDbs = new Map<string, Database.Database>();

export function appDataDir(slug: string): string {
  return glyphhPath("app-data", slug);
}

function getAppDb(slug: string): Database.Database {
  const existing = appDbs.get(slug);
  if (existing && existing.open) return existing;
  const dir = appDataDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "data.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 3000");
  db.pragma("foreign_keys = ON");
  appDbs.set(slug, db);
  return db;
}

/** Statements that reach outside the app's own database file (or reconfigure
 *  the engine) are host-only. better-sqlite3's prepare() is single-statement,
 *  and SQLite trigger bodies can't contain these, so a leading-keyword check
 *  is sufficient. */
const FORBIDDEN_SQL = /^\s*(ATTACH|DETACH|PRAGMA|VACUUM)\b/i;

export function dbExec(slug: string, args: Record<string, unknown>): { rows?: unknown[]; changes?: number; lastInsertRowid?: number } {
  const sql = String(args.sql || "").trim();
  if (!sql) throw new Error("sql is required");
  if (FORBIDDEN_SQL.test(sql)) throw new Error("ATTACH/DETACH/PRAGMA/VACUUM are not available to apps");
  const db = getAppDb(slug);
  const stmt = db.prepare(sql);
  const params = args.params;
  const bound = Array.isArray(params) ? params : params && typeof params === "object" ? [params] : [];
  if (stmt.reader) return { rows: stmt.all(...bound) };
  const info = stmt.run(...bound);
  return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
}

// ── cron (cron.schedule / cron.cancel / cron.list) ──────────
//
// DEFINITIONS ONLY. Nothing arms and nothing fires on this machine — the
// cloud runtime owns app workers and schedules (apps never run locally).

const MAX_SCHEDULES_PER_APP = 20;

export function cronSchedule(slug: string, args: Record<string, unknown>): { scheduled: true; id: string } {
  const id = String(args.id || "").trim();
  const expr = String(args.cron || "").trim();
  const handler = String(args.handler || "").trim();
  if (!id || !/^[a-z0-9_-]{1,64}$/i.test(id)) throw new Error("id is required ([a-zA-Z0-9_-], max 64)");
  if (!handler) throw new Error("handler is required");
  if (!cron.validate(expr)) throw new Error(`invalid cron expression: "${expr}"`);

  const db = initLocalDb();
  const count = (db.prepare("SELECT COUNT(*) AS n FROM app_schedules WHERE app_slug = ? AND id != ?").get(slug, id) as { n: number }).n;
  if (count >= MAX_SCHEDULES_PER_APP) throw new Error(`schedule limit reached (${MAX_SCHEDULES_PER_APP} per app)`);

  const argsJson = args.args && typeof args.args === "object" ? JSON.stringify(args.args) : null;
  db.prepare(`
    INSERT INTO app_schedules (app_slug, id, cron, handler, args_json, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (app_slug, id) DO UPDATE SET
      cron = excluded.cron, handler = excluded.handler,
      args_json = excluded.args_json, updated_at = excluded.updated_at
  `).run(slug, id, expr, handler, argsJson);

  // Definition persisted; the cloud runtime is the only place it can fire.
  return { scheduled: true, id };
}

export function cronCancel(slug: string, args: Record<string, unknown>): { cancelled: boolean } {
  const id = String(args.id || "").trim();
  if (!id) throw new Error("id is required");
  const info = initLocalDb().prepare("DELETE FROM app_schedules WHERE app_slug = ? AND id = ?").run(slug, id);
  return { cancelled: info.changes > 0 };
}

export function cronList(slug: string): Array<{ id: string; cron: string; handler: string; args?: unknown }> {
  const rows = initLocalDb()
    .prepare("SELECT id, cron, handler, args_json FROM app_schedules WHERE app_slug = ? ORDER BY id")
    .all(slug) as Array<{ id: string; cron: string; handler: string; args_json: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    cron: r.cron,
    handler: r.handler,
    ...(r.args_json ? { args: JSON.parse(r.args_json) } : {}),
  }));
}

// Schedule definitions live in this machine's local app_schedules table as
// definitions only — no timers, no firing. The cloud runtime owns execution.

// ── connectors (connector.status / connector.tools / connector.call) ──
//
// `declared` is the manifest's `connectors` list, resolved from the caller's
// grant — the only connectors these functions will ever touch for that app.

const CATALOG_MAX_AGE_MS = 5 * 60_000;

async function freshCatalog() {
  if (getCatalogAge() > CATALOG_MAX_AGE_MS) await refreshConnectorCatalog();
  return getConnectorCatalog();
}

function assertDeclaredConnector(declared: Set<string>, connector: string): string {
  const c = String(connector || "").trim().toLowerCase();
  if (!c) throw new Error("connector is required");
  if (!declared.has(c)) throw new Error(`connector not declared in manifest: ${c}`);
  return c;
}

/** Each declared connector + whether the caller can actually reach it.
 *  "Connected" is the SERVER's resolved answer (org-shared + personal, already
 *  narrowed by the workspace grant) — not a local account list. */
export async function connectorStatus(declared: Set<string>): Promise<Array<{ connector: string; connected: boolean; healthy: boolean }>> {
  const reachable = await getClient().connections.list()
    .then((connections) => connections.filter((c) => c.enabled).map((c) => c.slug))
    .catch(() => [] as string[]);
  const set = new Set(reachable);
  return [...declared].map((connector) => ({
    connector,
    connected: set.has(connector),
    healthy: set.has(connector),
  }));
}

/** Tool catalog for the app's declared connectors (optionally one of them). */
export async function connectorTools(declared: Set<string>, args: Record<string, unknown>): Promise<Array<{ connector: string; name: string; description: string; inputSchema: Record<string, unknown> }>> {
  const only = args.connector ? assertDeclaredConnector(declared, String(args.connector)) : null;
  const catalog = await freshCatalog();
  return catalog
    .filter((t) => declared.has(t.slug) && (!only || t.slug === only))
    .map((t) => ({ connector: t.slug, name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/** Invoke a connector tool. Auth lives in yo-server (Pipedream) — the app
 *  never sees tokens, and can only reach connectors it declared. */
export async function connectorCall(declared: Set<string>, args: Record<string, unknown>): Promise<{ result: string }> {
  const connector = assertDeclaredConnector(declared, String(args.connector || ""));
  const tool = String(args.tool || "").trim();
  if (!tool) throw new Error("tool is required");
  const toolArgs = args.args && typeof args.args === "object" ? (args.args as Record<string, unknown>) : {};
  const result = await callConnectorTool(connector, tool, toolArgs);
  return { result };
}

// ── notifications (notify.send) ─────────────────────────────

export function notifySend(slug: string, appName: string, args: Record<string, unknown>): { shown: boolean } {
  const title = String(args.title || appName || "Glyphh").slice(0, 120);
  const body = String(args.body || "").slice(0, 500);
  if (!Notification.isSupported()) return { shown: false };
  const n = new Notification({ title, body });
  n.on("click", () => {
    try { requireDeps().openApp(slug); } catch { /* app may be gone */ }
  });
  n.show();
  return { shown: true };
}

// ── init ────────────────────────────────────────────────────

/** Wire the host callbacks. Idempotent. Nothing arms here — the cloud
 *  runtime owns app workers and schedules. */
export function initAppServices(d: AppServicesDeps): void {
  deps = d;
}
