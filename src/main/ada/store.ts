/**
 * AdaStore — the SQL fact store (port of glyphh-adaL's SqlFactStore).
 *
 * Two tables: ada_thoughts (the prose + metadata) and fact_slots (one row
 * per filled universal-schema slot — the query surface). The eight closed
 * ops execute as FIXED, parameterized SQL over the indexed slots table:
 * the LLM only ever picks an op and fills values — no model-generated SQL
 * exists anywhere in this path, so the runaway-query class is excluded by
 * construction. Writes are versioned by key (v1, v2, … with is_current
 * flipping); an absent slot is a structural ∅ — refuse, don't confabulate.
 *
 * The DB handle is injected (initAdaStore) — main passes local-db's
 * better-sqlite3 instance; tests pass their own.
 */

import type BetterSqlite3 from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { sanitizeUniversal, tokenize, scoreThought, normValue, type UniversalFacts } from "./schema";

const CANDIDATE_LIMIT = 400; // recall candidate pool (matches adaL)
const ENTITY_CAP = 1000;     // max names returned by `who`

export type AdaOp =
  | { op: "refuse" }
  | { op: "lookup"; person: string; slot: string }
  | { op: "prev"; person: string; slot: string }
  | { op: "count"; conditions: Record<string, string> }
  | { op: "count_not"; slot: string; value: string }
  | { op: "top"; slot: string; k?: number; predicate_contains?: string }
  | { op: "who"; conditions: Record<string, string> }
  | { op: "compare"; slot: string; a: string; b: string };

export interface AdaTold { thoughtId: string; slots: number; key?: string; version?: number }

let db: BetterSqlite3.Database | null = null;

export function initAdaStore(database: BetterSqlite3.Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ada_thoughts (
      thought_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL DEFAULT 'main',
      content TEXT NOT NULL,
      speaker TEXT NOT NULL DEFAULT 'incoming',
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at REAL NOT NULL,
      last_accessed REAL NOT NULL,
      extra_data TEXT NOT NULL DEFAULT '{}',
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_thought_accessed ON ada_thoughts(last_accessed DESC);
    CREATE INDEX IF NOT EXISTS idx_thought_archived ON ada_thoughts(archived);
    CREATE TABLE IF NOT EXISTS fact_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      space_id TEXT NOT NULL DEFAULT 'main',
      thought_id TEXT NOT NULL,
      entity TEXT,
      layer TEXT NOT NULL,
      role TEXT NOT NULL,
      value TEXT NOT NULL,
      predicate TEXT,
      key TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      is_current INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_slots_lrv ON fact_slots(space_id, layer, role, value, is_current);
    CREATE INDEX IF NOT EXISTS idx_slots_entity ON fact_slots(space_id, entity, is_current);
    CREATE INDEX IF NOT EXISTS idx_slots_key ON fact_slots(space_id, key, version);
    CREATE INDEX IF NOT EXISTS idx_slots_thought ON fact_slots(thought_id);
  `);
}

function d(): BetterSqlite3.Database {
  if (!db) throw new Error("Ada store not initialized");
  return db;
}

const SPACE = "main";

// ── Write surface ──────────────────────────────────────────────────────────

/** Store pre-structured facts (no LLM in the path — used by indexers and
 *  the enricher's output alike). Versioned when `key` is given. */
export function adaTellRaw(text: string, facts: unknown, opts?: { key?: string; speaker?: string }): AdaTold {
  const clean = sanitizeUniversal(facts);
  const key = opts?.key?.trim() || undefined;
  const database = d();

  // Idempotency guards. Unkeyed: exact content dedupe. Keyed: if the
  // CURRENT version's content is identical, skip — sync jobs can re-tell
  // the whole catalog on a timer without version churn; only real drift
  // versions.
  if (key) {
    const cur = database.prepare(
      `SELECT t.thought_id, t.content, s.version FROM fact_slots s
         JOIN ada_thoughts t ON t.thought_id = s.thought_id
         WHERE s.space_id = ? AND s.key = ? AND s.is_current = 1 LIMIT 1`,
    ).get(SPACE, key) as { thought_id: string; content: string; version: number } | undefined;
    if (cur && cur.content === text) return { thoughtId: cur.thought_id, slots: 0, key, version: cur.version };
  } else {
    const dup = database.prepare(
      "SELECT thought_id FROM ada_thoughts WHERE space_id = ? AND archived = 0 AND lower(content) = lower(?)",
    ).get(SPACE, text) as { thought_id: string } | undefined;
    if (dup) return { thoughtId: dup.thought_id, slots: 0 };
  }

  const thoughtId = randomUUID().replace(/-/g, "").slice(0, 32);
  const now = Date.now() / 1000;
  let version = 1;

  const write = database.transaction(() => {
    if (key) {
      const row = database.prepare(
        "SELECT MAX(version) AS v FROM fact_slots WHERE space_id = ? AND key = ?",
      ).get(SPACE, key) as { v: number | null };
      version = (row?.v ?? 0) + 1;
      database.prepare(
        "UPDATE fact_slots SET is_current = 0 WHERE space_id = ? AND key = ?",
      ).run(SPACE, key);
    }
    database.prepare(
      "INSERT INTO ada_thoughts (thought_id, space_id, content, speaker, created_at, last_accessed, extra_data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(thoughtId, SPACE, text, opts?.speaker || "incoming", now, now,
      JSON.stringify({ universal: clean, ...(key ? { key, version } : {}) }));

    const entity = normValue(clean.entity?.name || "");
    const predicate = normValue(clean.relational?.predicate || "") || null;
    const ins = database.prepare(
      "INSERT INTO fact_slots (space_id, thought_id, entity, layer, role, value, predicate, key, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    let slots = 0;
    for (const [layer, roles] of Object.entries(clean)) {
      for (const [role, value] of Object.entries(roles)) {
        ins.run(SPACE, thoughtId, entity || null, layer, role, normValue(value), predicate, key ?? null, version);
        slots++;
      }
    }
    return slots;
  });

  const slots = write();
  return { thoughtId, slots, ...(key ? { key, version } : {}) };
}

// ── The closed op set (fixed SQL templates — port of ops.py semantics) ────

const splitSlot = (slot: string): [string, string] => {
  const i = slot.indexOf(".");
  return i < 0 ? [slot, ""] : [slot.slice(0, i), slot.slice(i + 1)];
};

/** Distinct current entities matching ALL {layer.role: value} conditions. */
function entitiesWhere(conditions: Record<string, string>): string[] {
  const entries = Object.entries(conditions || {});
  if (!entries.length) return [];
  const parts: string[] = [];
  const params: string[] = [];
  for (const [slot, value] of entries) {
    const [layer, role] = splitSlot(slot);
    parts.push(
      "SELECT DISTINCT entity FROM fact_slots WHERE space_id = ? AND is_current = 1 AND entity IS NOT NULL AND layer = ? AND role = ? AND value = ?",
    );
    params.push(SPACE, layer, role, normValue(value));
  }
  const sql = parts.join(" INTERSECT ") + ` LIMIT ${ENTITY_CAP}`;
  return (d().prepare(sql).all(...params) as Array<{ entity: string }>).map((r) => r.entity);
}

function countWhere(layer: string, role: string, value: string): number {
  const r = d().prepare(
    "SELECT COUNT(DISTINCT entity) AS n FROM fact_slots WHERE space_id = ? AND is_current = 1 AND entity IS NOT NULL AND layer = ? AND role = ? AND value = ?",
  ).get(SPACE, layer, role, normValue(value)) as { n: number };
  return r.n;
}

/** Entity profile: slot → set of current values (for lookup/prev/count_not). */
function profileFor(person: string): Record<string, string[]> | null {
  const p = normValue(person);
  let rows = d().prepare(
    "SELECT layer, role, value FROM fact_slots WHERE space_id = ? AND is_current = 1 AND entity = ?",
  ).all(SPACE, p) as Array<{ layer: string; role: string; value: string }>;
  if (!rows.length) {
    rows = d().prepare(
      "SELECT layer, role, value FROM fact_slots WHERE space_id = ? AND is_current = 1 AND entity LIKE ?",
    ).all(SPACE, `%${p}%`) as typeof rows;
  }
  if (!rows.length) return null;
  const prof: Record<string, string[]> = {};
  for (const r of rows) {
    const slot = `${r.layer}.${r.role}`;
    (prof[slot] ??= []).push(r.value);
  }
  return prof;
}

export function adaExecuteOp(op: AdaOp): string {
  switch (op.op) {
    case "refuse":
      return "I don't know.";
    case "lookup": {
      const prof = profileFor(op.person);
      const vals = prof?.[op.slot];
      return vals?.length ? [...new Set(vals)].sort().join(", ") : "I don't know.";
    }
    case "prev": {
      const [layer, role] = splitSlot(op.slot);
      const row = d().prepare(
        `SELECT value FROM fact_slots WHERE space_id = ? AND layer = ? AND role = ?
           AND (entity = ? OR key = ?) AND is_current = 0 ORDER BY version DESC LIMIT 1`,
      ).get(SPACE, layer, role, normValue(op.person), op.person) as { value: string } | undefined;
      return row ? row.value : "I don't know.";
    }
    case "count":
      return String(entitiesWhere(op.conditions).length);
    case "count_not": {
      const [layer, role] = splitSlot(op.slot);
      const v = normValue(op.value);
      const r = d().prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT entity FROM fact_slots
             WHERE space_id = ? AND is_current = 1 AND entity IS NOT NULL AND layer = ? AND role = ?
             GROUP BY entity
             HAVING SUM(CASE WHEN value = ? THEN 1 ELSE 0 END) = 0
         )`,
      ).get(SPACE, layer, role, v) as { n: number };
      return String(r.n);
    }
    case "top": {
      const [layer, role] = splitSlot(op.slot);
      const k = Math.max(1, Math.min(50, Number(op.k) || 5));
      const pred = op.predicate_contains ? normValue(op.predicate_contains) : null;
      const rows = d().prepare(
        `SELECT value, COUNT(DISTINCT COALESCE(entity, thought_id)) AS n FROM fact_slots
           WHERE space_id = ? AND is_current = 1 AND layer = ? AND role = ?
           ${pred ? "AND predicate LIKE ?" : ""}
           GROUP BY value ORDER BY n DESC, value ASC LIMIT ?`,
      ).all(...(pred ? [SPACE, layer, role, `%${pred}%`, k] : [SPACE, layer, role, k])) as Array<{ value: string; n: number }>;
      return rows.length ? rows.map((r) => `${r.value} (${r.n})`).join(", ") : "none";
    }
    case "who": {
      const names = entitiesWhere(op.conditions);
      return names.length ? names.sort().join(", ") : "none";
    }
    case "compare": {
      const [layer, role] = splitSlot(op.slot);
      const ca = countWhere(layer, role, op.a);
      const cb = countWhere(layer, role, op.b);
      if (ca === cb) return `equal (${ca} each)`;
      const winner = ca > cb ? op.a : op.b;
      return `${winner} (${Math.max(ca, cb)} vs ${Math.min(ca, cb)})`;
    }
    default:
      throw new Error(`unknown op ${JSON.stringify((op as { op?: string }).op)} (valid: lookup, prev, count, count_not, top, who, compare, refuse)`);
  }
}

// ── Lexical recall (candidate pool from SQL, scored in-process) ──────────

export function adaRecall(query: string, k = 5): Array<{ content: string; score: number }> {
  const qTokens = new Set(tokenize(query));
  if (!qTokens.size) return [];
  // Candidate pool: thoughts whose content OR any slot value contains any
  // query token (LIKE, cheap at desktop scale), newest-accessed first.
  const toks = [...qTokens].slice(0, 8);
  const likes = toks.map(() => "t.content LIKE ? OR EXISTS (SELECT 1 FROM fact_slots s WHERE s.thought_id = t.thought_id AND s.value LIKE ?)").join(" OR ");
  const params: unknown[] = [SPACE];
  for (const t of toks) params.push(`%${t}%`, `%${t}%`);
  const rows = d().prepare(
    `SELECT t.thought_id, t.content, t.extra_data FROM ada_thoughts t
       WHERE t.space_id = ? AND t.archived = 0 AND (${likes})
       ORDER BY t.last_accessed DESC LIMIT ${CANDIDATE_LIMIT}`,
  ).all(...params) as Array<{ thought_id: string; content: string; extra_data: string }>;

  const scored = rows.map((r) => {
    let universal: UniversalFacts = {};
    try { universal = (JSON.parse(r.extra_data)?.universal as UniversalFacts) || {}; } catch { /* legacy row */ }
    return { content: r.content, score: scoreThought({ content: r.content, universal }, qTokens) };
  }).filter((r) => r.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ── History + stats ────────────────────────────────────────────────────────

export function adaHistory(key: string): Array<{ version: number; content: string }> {
  const rows = d().prepare(
    `SELECT DISTINCT s.version, t.content FROM fact_slots s
       JOIN ada_thoughts t ON t.thought_id = s.thought_id
       WHERE s.space_id = ? AND s.key = ? ORDER BY s.version ASC`,
  ).all(SPACE, key.trim()) as Array<{ version: number; content: string }>;
  return rows;
}

export function adaStats(): { thoughts: number; slots: number; keys: number } {
  const t = d().prepare("SELECT COUNT(*) AS n FROM ada_thoughts WHERE space_id = ? AND archived = 0").get(SPACE) as { n: number };
  const s = d().prepare("SELECT COUNT(*) AS n FROM fact_slots WHERE space_id = ? AND is_current = 1").get(SPACE) as { n: number };
  const k = d().prepare("SELECT COUNT(DISTINCT key) AS n FROM fact_slots WHERE space_id = ? AND key IS NOT NULL").get(SPACE) as { n: number };
  return { thoughts: t.n, slots: s.n, keys: k.n };
}
