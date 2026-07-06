/**
 * glyphh-app-services — host-implemented data/runtime services for Glyphh apps
 * (spec v2). These are the capabilities that turn a .glyphh from "a thin UI
 * over one AppleScript" into a real local app:
 *
 *   db.exec          { sql, params? }            per-app SQLite, one statement
 *   cron.schedule    { id, cron, handler, args? } persisted; fires a worker handler
 *   cron.cancel      { id }
 *   cron.list        { }
 *   notify.send      { title, body }             OS notification; click opens the app
 *   connector.status { }                         declared connectors + connected?
 *   connector.tools  { connector? }              tool catalog for declared connectors
 *   connector.call   { connector, tool, args? }  invoke a connector tool (Pipedream via yo-server)
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
 * The host injects resolveApp/openApp at init (initAppServices) so this module
 * never imports glyphh-app-host — host → services → worker, no cycles.
 */

import { Notification } from "electron";
import Database from "better-sqlite3";
import cron, { ScheduledTask } from "node-cron";
import fs from "fs";
import path from "path";
import { initLocalDb } from "./local-db.js";
import { glyphhPath } from "./app-paths.js";
import { AppWorkerSpec, invokeAppWorkerHandler } from "./glyphh-app-worker.js";
import { serverGetAuthed } from "./auth.js";
import {
  getConnectorCatalog,
  refreshConnectorCatalog,
  getCatalogAge,
  callConnectorTool,
} from "./connector-tools-client.js";

// ── wiring (injected by glyphh-app-host at startup) ─────────

interface AppServicesDeps {
  /** Saved-app row → worker spec, or null if the app is gone/has no worker. */
  resolveApp: (slug: string) => Promise<AppWorkerSpec | null>;
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

const MAX_SCHEDULES_PER_APP = 20;

interface ScheduleRow {
  app_slug: string;
  id: string;
  cron: string;
  handler: string;
  args_json: string | null;
}

const armedTasks = new Map<string, ScheduledTask>(); // `${slug}\n${id}` → task

function taskKey(slug: string, id: string): string {
  return `${slug}\n${id}`;
}

function disarm(slug: string, id: string): void {
  const key = taskKey(slug, id);
  const task = armedTasks.get(key);
  if (task) {
    task.stop();
    armedTasks.delete(key);
  }
}

function arm(row: ScheduleRow): void {
  disarm(row.app_slug, row.id);
  const task = cron.schedule(row.cron, () => {
    void fireSchedule(row).catch((err) => {
      console.error(`[glyphh-app] cron "${row.app_slug}/${row.id}" failed:`, err instanceof Error ? err.message : err);
    });
  });
  armedTasks.set(taskKey(row.app_slug, row.id), task);
}

async function fireSchedule(row: ScheduleRow): Promise<void> {
  const spec = await requireDeps().resolveApp(row.app_slug);
  if (!spec) {
    // App was uninstalled (or lost its worker) — retire the schedule.
    cronCancel(row.app_slug, { id: row.id });
    return;
  }
  let args: Record<string, unknown> = {};
  try { args = row.args_json ? JSON.parse(row.args_json) : {}; } catch { /* keep {} */ }
  await invokeAppWorkerHandler(spec, row.handler, args);
}

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

  arm({ app_slug: slug, id, cron: expr, handler, args_json: argsJson });
  return { scheduled: true, id };
}

export function cronCancel(slug: string, args: Record<string, unknown>): { cancelled: boolean } {
  const id = String(args.id || "").trim();
  if (!id) throw new Error("id is required");
  disarm(slug, id);
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

/** Re-arm every persisted schedule (startup). Bad rows are dropped, not fatal. */
function armAllSchedules(): void {
  const rows = initLocalDb()
    .prepare("SELECT app_slug, id, cron, handler, args_json FROM app_schedules")
    .all() as ScheduleRow[];
  for (const row of rows) {
    if (!cron.validate(row.cron)) {
      initLocalDb().prepare("DELETE FROM app_schedules WHERE app_slug = ? AND id = ?").run(row.app_slug, row.id);
      continue;
    }
    arm(row);
  }
}

/** Drop an app's schedules + worker state on reinstall (its worker restarts
 *  and re-registers what it still wants). */
export function resetAppSchedules(slug: string): void {
  for (const key of [...armedTasks.keys()]) {
    if (key.startsWith(`${slug}\n`)) {
      armedTasks.get(key)?.stop();
      armedTasks.delete(key);
    }
  }
  initLocalDb().prepare("DELETE FROM app_schedules WHERE app_slug = ?").run(slug);
}

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

/** Each declared connector + whether the user has a (healthy) account for it. */
export async function connectorStatus(declared: Set<string>): Promise<Array<{ connector: string; connected: boolean; healthy: boolean }>> {
  const res = await serverGetAuthed<{ ok: boolean; accounts?: Array<{ appSlug: string; healthy: boolean }> }>(
    "/api/connectors/accounts"
  ).catch(() => ({ ok: false as const, accounts: [] }));
  const accounts = res.ok && res.accounts ? res.accounts : [];
  return [...declared].map((connector) => {
    const acct = accounts.find((a) => a.appSlug === connector);
    return { connector, connected: !!acct, healthy: !!acct?.healthy };
  });
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

/** Wire the host callbacks and re-arm persisted schedules. Idempotent. */
export function initAppServices(d: AppServicesDeps): void {
  const first = !deps;
  deps = d;
  if (first) armAllSchedules();
}
