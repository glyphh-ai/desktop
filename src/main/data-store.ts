/**
 * Data store — namespaced key-value store with JSON query support.
 *
 * Shares the substrate SQLite database. Each namespace (typically a skill or
 * vibe name) gets its own key-space. Values are JSON blobs, queryable via
 * SQLite json_extract for field-level filtering.
 *
 * Schema:
 *   kv(namespace TEXT, key TEXT, value TEXT, updated_at INTEGER,
 *      PRIMARY KEY(namespace, key))
 */

import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import { glyphhPath } from "./app-paths.js";

const SUBSTRATE_DIR = glyphhPath("substrate");
const DB_PATH = path.join(SUBSTRATE_DIR, "memory.sqlite");

let db: Database.Database | null = null;

function ensureDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(SUBSTRATE_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(namespace, key)
    );
    CREATE INDEX IF NOT EXISTS idx_kv_namespace ON kv (namespace);
  `);
  return db;
}

export function closeDataStoreDb(): void {
  if (db) { try { db.close(); } catch {} db = null; }
}

export interface KVEntry {
  key: string;
  value: unknown;
  updatedAt: number;
}

export class DataStore {
  get(namespace: string, key: string): unknown | null {
    const d = ensureDb();
    const row = d.prepare(
      "SELECT value FROM kv WHERE namespace = ? AND key = ?"
    ).get(namespace, key) as { value: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }

  set(namespace: string, key: string, value: unknown): void {
    const d = ensureDb();
    d.prepare(
      "INSERT OR REPLACE INTO kv (namespace, key, value, updated_at) VALUES (?, ?, ?, ?)"
    ).run(namespace, key, JSON.stringify(value) ?? "null", Date.now());
  }

  delete(namespace: string, key: string): boolean {
    const d = ensureDb();
    const result = d.prepare(
      "DELETE FROM kv WHERE namespace = ? AND key = ?"
    ).run(namespace, key);
    return result.changes > 0;
  }

  list(namespace: string, prefix?: string, limit = 100): KVEntry[] {
    const d = ensureDb();
    let sql = "SELECT key, value, updated_at AS updatedAt FROM kv WHERE namespace = ?";
    const params: unknown[] = [namespace];
    if (prefix) {
      sql += " AND key LIKE ?";
      params.push(prefix + "%");
    }
    sql += " ORDER BY key LIMIT ?";
    params.push(limit);
    const rows = d.prepare(sql).all(...params) as Array<{ key: string; value: string; updatedAt: number }>;
    return rows.map(r => ({
      key: r.key,
      value: (() => { try { return JSON.parse(r.value); } catch { return r.value; } })(),
      updatedAt: r.updatedAt,
    }));
  }

  query(namespace: string, filter: Record<string, unknown>, limit = 100): KVEntry[] {
    const d = ensureDb();
    const conditions = ["namespace = ?"];
    const params: unknown[] = [namespace];
    for (const [field, val] of Object.entries(filter)) {
      conditions.push("json_extract(value, ?) = ?");
      params.push("$." + field, typeof val === "string" ? val : JSON.stringify(val));
    }
    const sql = `SELECT key, value, updated_at AS updatedAt FROM kv WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);
    const rows = d.prepare(sql).all(...params) as Array<{ key: string; value: string; updatedAt: number }>;
    return rows.map(r => ({
      key: r.key,
      value: (() => { try { return JSON.parse(r.value); } catch { return r.value; } })(),
      updatedAt: r.updatedAt,
    }));
  }

  keys(namespace: string): string[] {
    const d = ensureDb();
    const rows = d.prepare(
      "SELECT key FROM kv WHERE namespace = ? ORDER BY key"
    ).all(namespace) as Array<{ key: string }>;
    return rows.map(r => r.key);
  }

  count(namespace: string): number {
    const d = ensureDb();
    const row = d.prepare(
      "SELECT COUNT(*) AS n FROM kv WHERE namespace = ?"
    ).get(namespace) as { n: number };
    return row.n;
  }

  clear(namespace: string): number {
    const d = ensureDb();
    const result = d.prepare(
      "DELETE FROM kv WHERE namespace = ?"
    ).run(namespace);
    return result.changes;
  }

  listNamespaces(): string[] {
    const d = ensureDb();
    const rows = d.prepare(
      "SELECT DISTINCT namespace FROM kv ORDER BY namespace"
    ).all() as Array<{ namespace: string }>;
    return rows.map(r => r.namespace);
  }
}
