/**
 * LocalDb — singleton SQLite database for user state.
 *
 * Stores agents, layouts, and preferences in ~/.glyphh/user-state.sqlite.
 * Uses WAL mode for performance.
 *
 * encryptField/decryptField (safeStorage/OS-keychain-backed) exist for the
 * rare genuinely-sensitive local field, but agent system prompts no longer
 * use them (see stores/agent-store-db.ts) — a prompt isn't a secret, and
 * routing it through the keychain meant every agent list/load triggered an
 * OS permission prompt.
 */

import fs from "fs";
import Database from "better-sqlite3";
import { safeStorage } from "electron";
import { userScopedDir, userScopedPath } from "./app-paths.js";

// Per-user: ~/.glyphh/users/<id>/user-state.sqlite once a session is known;
// the legacy machine-global ~/.glyphh/user-state.sqlite pre-auth (adopted by
// the first login — see user-scope.ts). Resolved per open, NOT at import.
const dbPath = () => userScopedPath("user-state.sqlite");

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
  {
    // Persisted cron schedules for installed Glyphh apps (spec v2 —
    // cron.schedule/cancel/list capabilities). Keyed per app so an app can
    // only ever see/replace its own schedules; re-armed at boot by
    // glyphh-app-services.armAllSchedules().
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS app_schedules (
        app_slug TEXT NOT NULL,
        id TEXT NOT NULL,
        cron TEXT NOT NULL,
        handler TEXT NOT NULL,
        args_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (app_slug, id)
      );
    `,
  },
  {
    // Vector memory — sqlite IS the vector db. Embeddings ride as Float32
    // BLOBs (unit-normalized, so cosine = dot product); at session and
    // workspace scale a brute-force scan is sub-millisecond, no extension.
    //   turn_vectors      — short-term memory over a chat's own turns
    //   workspace_vectors — chunked semantic index of the working folder
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS turn_vectors (
        chat_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        PRIMARY KEY (chat_id, at, role)
      );
      CREATE INDEX IF NOT EXISTS idx_turn_vectors_chat ON turn_vectors (chat_id);
      CREATE TABLE IF NOT EXISTS workspace_vectors (
        root TEXT NOT NULL,
        path TEXT NOT NULL,
        chunk_no INTEGER NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        PRIMARY KEY (root, path, chunk_no)
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_vectors_root ON workspace_vectors (root);
    `,
  },
  {
    // Connector tool catalog embeddings — the loop wires only the tools
    // relevant to the ask (the full catalog overflows the local model's 32k
    // window; tool defs are un-squeezable prompt prefix). Encoded once per
    // catalog change, keyed by wire name, content-hashed for incremental
    // re-encoding. find_tools/call_tool reach whatever isn't preselected.
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_vectors (
        name TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        embedding BLOB NOT NULL
      );
    `,
  },
  {
    // Enriched retrieval paragraphs: thin catalog descriptions embed badly, so
    // a cheap back-path model writes a "when you'd reach for this" paragraph
    // per tool and THAT is what gets embedded. Tied to the row's content hash —
    // a changed def re-enriches on the next catalog refresh.
    version: 7,
    sql: `ALTER TABLE tool_vectors ADD COLUMN paragraph TEXT;`,
  },
  {
    // Custom drip presets — LOCAL now (THE PURGE, 2026-09-10): the server's
    // saved_drips lane is gone; the `.drip save` command and the Drips tab
    // both persist here.
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS drips (
        name TEXT PRIMARY KEY,
        recipe TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    // Scheduled loops (the build, 2026-09-10): a schedule binds a LOOP to a
    // CLI AGENT on a cron; runs capture the headless output.
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS loop_schedules (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        loop_slug TEXT NOT NULL,
        cron TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS loop_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        output TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_loop_runs_schedule ON loop_runs (schedule_id, started_at);
    `,
  },
  {
    // TASKS — the collapse (2026-09-10): one primitive, stepped + slotted.
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS task_schedules (
        id TEXT PRIMARY KEY,
        task_slug TEXT NOT NULL,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_slug TEXT NOT NULL,
        schedule_id TEXT,
        started_at TEXT NOT NULL,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        output TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs (task_slug, started_at);
    `,
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
  fs.mkdirSync(userScopedDir(), { recursive: true });
  db = new Database(dbPath());
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
