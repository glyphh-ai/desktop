/**
 * LocalDb — singleton SQLite database for user state.
 *
 * Stores agents, layouts, and preferences in ~/yo/user-state.sqlite.
 * Uses WAL mode for performance.
 *
 * encryptField/decryptField (safeStorage/OS-keychain-backed) exist for the
 * rare genuinely-sensitive local field, but agent system prompts no longer
 * use them (see stores/agent-store-db.ts) — a prompt isn't a secret, and
 * routing it through the keychain meant every agent list/load triggered an
 * OS permission prompt.
 */

import path from "path";
import os from "os";
import fs from "fs";
import Database from "better-sqlite3";
import { safeStorage } from "electron";

const YO_DIR = path.join(os.homedir(), "yo");
const DB_PATH = path.join(YO_DIR, "user-state.sqlite");

let db: Database.Database | null = null;

// ── Encryption helpers ─────────────────────────────────────

/**
 * Encrypt a string field using safeStorage (OS keychain).
 * Returns a base64-encoded ciphertext string suitable for TEXT columns.
 * Falls back to plaintext when safeStorage is unavailable.
 */
export function encryptField(plaintext: string): string {
  if (!plaintext) return "";
  if (safeStorage.isEncryptionAvailable()) {
    const buf = safeStorage.encryptString(plaintext);
    return buf.toString("base64");
  }
  return plaintext;
}

/**
 * Decrypt a base64-encoded ciphertext back to plaintext.
 * Gracefully handles legacy plaintext values (not base64-encoded).
 */
export function decryptField(ciphertext: string): string {
  if (!ciphertext) return "";
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const buf = Buffer.from(ciphertext, "base64");
      return safeStorage.decryptString(buf);
    } catch {
      // Likely plaintext from before encryption was enabled
      return ciphertext;
    }
  }
  return ciphertext;
}

// ── Schema migrations ──────────────────────────────────────

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'local',
        role TEXT,
        system_prompt_enc TEXT,
        joinable INTEGER NOT NULL DEFAULT 0,
        apps_json TEXT,
        skills_json TEXT,
        builtin_tools_json TEXT,
        mcp_servers_json TEXT,
        guardrails_json TEXT,
        remote_json TEXT,
        config_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS layouts (
        name TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'standard',
        layout_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE agents ADD COLUMN avatar_url TEXT;
      ALTER TABLE agents ADD COLUMN bio TEXT;
    `,
  },
  {
    // system_prompt_enc (safeStorage/OS-keychain-encrypted) is retired — an
    // agent's system prompt isn't a secret, and encrypting it meant every
    // agent list/load touched the OS keychain, which is the "safe storage
    // is annoying" prompt users were hitting on every boot. New plain
    // column; agent-store-db.ts migrates any legacy encrypted rows to it
    // on first read (a one-time decrypt, never again after that).
    version: 3,
    sql: `ALTER TABLE agents ADD COLUMN system_prompt TEXT;`,
  },
];

function runMigrations(database: Database.Database): void {
  // Ensure migrations table exists
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (database.prepare("SELECT version FROM _migrations").all() as Array<{ version: number }>)
      .map((r) => r.version)
  );

  const insert = database.prepare("INSERT INTO _migrations (version) VALUES (?)");

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    database.exec(migration.sql);
    insert.run(migration.version);
  }
}

// ── Public API ─────────────────────────────────────────────

/**
 * Initialize the local database. Must be called early in app startup
 * (after app.ready so safeStorage is available).
 */
export function initLocalDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(YO_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

/**
 * Get the active database instance. Throws if not initialized.
 */
export function getLocalDb(): Database.Database {
  if (!db) throw new Error("local-db not initialized — call initLocalDb() first");
  return db;
}

/**
 * Close the database (call on app quit).
 */
export function closeLocalDb(): void {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
}
