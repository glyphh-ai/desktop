/**
 * glyphh-app-services — this machine's per-app data home and the one store
 * service left on it.
 *
 *   appDataDir(slug)   ~/.glyphh/users/<id>/app-data/<slug> — the house
 *                      panels' libraries (media-local.ts), the artifacts and
 *                      the semantic stores keep their files here
 *   db.exec            { sql, params? }  one statement on a slug's own SQLite
 *                      — a task's data lane (task-runner.ts `data`)
 *
 * An installed Glyphh app runs on its cloud instance (his order, 2026-10-06);
 * its db, cron and notifications are the instance's. Nothing here serves one.
 *
 * Isolation model: every call carries the calling slug and is scoped to it —
 * a database lives in app-data/<slug>/data.sqlite and nothing can name
 * another slug's file.
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { userScopedPath } from "./app-paths.js";

// ── per-slug SQLite (db.exec) ───────────────────────────────

const appDbs = new Map<string, Database.Database>();

export function appDataDir(slug: string): string {
  return userScopedPath("app-data", slug);
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

/** Statements that reach outside the slug's own database file (or reconfigure
 *  the engine) are host-only. better-sqlite3's prepare() is single-statement,
 *  and SQLite trigger bodies can't contain these, so a leading-keyword check
 *  is sufficient. */
const FORBIDDEN_SQL = /^\s*(ATTACH|DETACH|PRAGMA|VACUUM)\b/i;

export function dbExec(slug: string, args: Record<string, unknown>): { rows?: unknown[]; changes?: number; lastInsertRowid?: number } {
  const sql = String(args.sql || "").trim();
  if (!sql) throw new Error("sql is required");
  if (FORBIDDEN_SQL.test(sql)) throw new Error("ATTACH/DETACH/PRAGMA/VACUUM are not available here");
  const db = getAppDb(slug);
  const stmt = db.prepare(sql);
  const params = args.params;
  const bound = Array.isArray(params) ? params : params && typeof params === "object" ? [params] : [];
  if (stmt.reader) return { rows: stmt.all(...bound) };
  const info = stmt.run(...bound);
  return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
}
