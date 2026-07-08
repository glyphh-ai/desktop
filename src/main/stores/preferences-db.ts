/**
 * PreferencesDb — SQLite-backed key-value store for user preferences.
 *
 * The only preferences store: every main-process module and the renderer
 * (via settings-ipc) read and write through here. The legacy JSON store
 * (~/.glyphh/.preferences) is retired — migrate-from-files.ts copies it
 * into the preferences table once and the file is never touched again.
 *
 * Backed by the local-db singleton; callers run after initLocalDb().
 */

import { getLocalDb } from "../local-db";

// ── Public API ─────────────────────────────────────────────

/**
 * Get a preference value by key. Returns `defaultValue` if not found.
 */
export function getPreference<T = unknown>(key: string, defaultValue?: T): T {
  // Resilient by contract: IPC handlers race boot (before initLocalDb) and
  // quit (after close) — a preference read answers its default instead of
  // throwing through the handler.
  let db;
  try { db = getLocalDb(); } catch { return defaultValue as T; }
  const row = db.prepare(
    "SELECT value FROM preferences WHERE key = ?"
  ).get(key) as { value: string } | undefined;
  if (!row) return defaultValue as T;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as unknown as T;
  }
}

/**
 * Set a preference value. Serializes to JSON.
 */
export function setPreference(key: string, value: unknown): void {
  const db = getLocalDb();
  db.prepare(
    "INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)"
  ).run(key, JSON.stringify(value));
}
