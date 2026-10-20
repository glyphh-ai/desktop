/**
 * glyphh-app-ai — AI/data services for Glyphh apps (spec v2):
 *
 *   llm.embed        { text | texts, model? }     embeddings on the user's model
 *   llm.chunk        { text, maxChars?, overlap? } split text for embedding pipelines
 *   vector.upsert    { collection, items }        per-app vector store
 *   vector.search    { collection, query|vector, k?, filter? }
 *   vector.delete    { collection, id? }
 *   graph.cypher     { query, params? }           per-app knowledge graph (Kuzu,
 *                                                 embedded — real Cypher)
 *
 * The stores are ON-DEVICE and slug-scoped like the other services: vectors in
 * ~/.glyphh/app-data/<slug>/vectors.sqlite, the graph in graph.kuzu/. Text is
 * embedded with the user's own embeddings model from Settings › Models
 * (embeddings-config.ts), through the router with that provider's key; with no
 * embeddings model, embedding refuses in plain words. Remote chat access (llm.complete / agent.run) lives in
 * glyphh-app-agent.ts and runs on the app's own config-var key.
 *
 * Vector search is exact cosine over Float32 blobs — at desktop scale
 * (≤ ~100k items) that's a few ms and beats shipping an ANN engine.
 */

import Database from "better-sqlite3";
import type { Connection as KuzuConnection, KuzuValue } from "kuzu";
import fs from "fs";
import path from "path";
import { appDataDir } from "./glyphh-app-services.js";
import { glyphhPath } from "./app-paths.js";
import { embedModels, embedWith, offers, resolveEmbedModel } from "./embeddings-config.js";

// kuzu ships a native addon (kuzujs.node) for the per-app GRAPH memory. It's an
// OPTIONAL feature, and on some machines the prebuilt can't load — most often a
// Windows box missing the Microsoft Visual C++ runtime, which surfaces as
// "The specified module could not be found." Load it LAZILY and guarded so a
// load failure disables the graph.* tools rather than crashing the whole app at
// startup with an uncaught exception (the eager top-level import did exactly
// that). Type-only import above is erased at compile time, so it triggers no
// native load.
type KuzuModule = typeof import("kuzu");
let kuzuMod: KuzuModule | null | undefined; // undefined = untried, null = unavailable
function loadKuzu(): KuzuModule | null {
  if (kuzuMod !== undefined) return kuzuMod;
  try {
    kuzuMod = require("kuzu") as KuzuModule;
  } catch (err) {
    kuzuMod = null;
    console.error("[glyphh-app-ai] graph engine (kuzu) unavailable — graph.* tools disabled:", err instanceof Error ? err.message : err);
  }
  return kuzuMod;
}

// ── embeddings (llm.embed) ──────────────────────────────────
const MAX_EMBED_BATCH = 64;
const MAX_EMBED_CHARS = 8_000;
const NO_EMBED_MODEL = "Memory needs an embeddings model. Add one in Settings › Models.";

async function embedTexts(texts: string[], model: string): Promise<number[][]> {
  if (!model) throw new Error(NO_EMBED_MODEL);
  return embedWith(texts.map((t) => String(t).slice(0, MAX_EMBED_CHARS)), model);
}

export async function llmEmbed(args: Record<string, unknown>): Promise<{ model: string; dim: number; vectors: number[][] }> {
  const model = String(args.model || await resolveEmbedModel());
  const texts = Array.isArray(args.texts) ? args.texts.map(String) : args.text ? [String(args.text)] : [];
  if (!texts.length) throw new Error("text or texts is required");
  if (texts.length > MAX_EMBED_BATCH) throw new Error(`max ${MAX_EMBED_BATCH} texts per call`);
  const vectors = await embedTexts(texts, model);
  return { model, dim: vectors[0]?.length || 0, vectors };
}

// ── chunking (llm.chunk) ────────────────────────────────────

/** Paragraph/sentence-aware splitter with overlap — the standard prep step
 *  before llm.embed → vector.upsert. Pure function, no model needed. */
export function llmChunk(args: Record<string, unknown>): { chunks: string[] } {
  const text = String(args.text || "");
  if (!text.trim()) return { chunks: [] };
  const maxChars = Math.max(200, Math.min(8_000, Number(args.maxChars) || 1_200));
  const overlap = Math.max(0, Math.min(Math.floor(maxChars / 2), Number(args.overlap) || 150));

  // Split on paragraph, then sentence boundaries; greedily refill windows.
  const parts = text
    .split(/\n{2,}/)
    .flatMap((p) => (p.length <= maxChars ? [p] : p.split(/(?<=[.!?])\s+/)))
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";
  for (let part of parts) {
    while (part.length > maxChars) {          // pathological unbroken runs
      chunks.push(part.slice(0, maxChars));
      part = part.slice(maxChars - overlap);
    }
    if (!current) { current = part; continue; }
    if (current.length + 1 + part.length <= maxChars) {
      current += "\n" + part;
    } else {
      chunks.push(current);
      current = (overlap ? current.slice(-overlap) + "\n" : "") + part;
    }
  }
  if (current) chunks.push(current);
  return { chunks };
}

// ── per-app vector store (vector.*) ─────────────────────────

const MAX_UPSERT_ITEMS = 256;
const MAX_COLLECTION_ITEMS = 100_000;

const vecDbs = new Map<string, Database.Database>();

function getVecDb(slug: string): Database.Database {
  const existing = vecDbs.get(slug);
  if (existing && existing.open) return existing;
  fs.mkdirSync(appDataDir(slug), { recursive: true });
  const db = new Database(path.join(appDataDir(slug), "vectors.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      name TEXT PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items (
      collection TEXT NOT NULL, id TEXT NOT NULL,
      text TEXT, metadata_json TEXT, embedding BLOB NOT NULL,
      PRIMARY KEY (collection, id)
    );
  `);
  vecDbs.set(slug, db);
  return db;
}

function toBlob(vec: number[]): Buffer {
  // Store L2-normalized so search is a pure dot product.
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  const arr = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) arr[i] = vec[i] / norm;
  return Buffer.from(arr.buffer);
}

type Collection = { name: string; model: string; dim: number };

function collectionOf(db: Database.Database, name: string): Collection | undefined {
  return db.prepare("SELECT name, model, dim FROM collections WHERE name = ?").get(name) as Collection | undefined;
}

/** A collection embedded with a model the user no longer has (the old local
 *  hashed-words model, a removed model) follows the model embeds run on now:
 *  every stored text is embedded again, in batches, and an item that came as a
 *  bare vector cannot follow and is dropped. A collection with nothing to carry
 *  over is simply forgotten and made afresh by the next upsert. Nothing moves
 *  while the pinned model is still among the user's embeddings models, or there
 *  is no embeddings model to move to. */
async function repinned(db: Database.Database, slug: string, coll: Collection): Promise<Collection | undefined> {
  const models = await embedModels();
  if (!models.length || offers(models, coll.model)) return coll;
  const next = await resolveEmbedModel();
  if (!next || next === coll.model) return coll;
  const rows = db.prepare("SELECT id, text FROM items WHERE collection = ? AND text IS NOT NULL ORDER BY id").all(coll.name) as
    Array<{ id: string; text: string }>;
  const vectors: number[][] = [];
  for (let at = 0; at < rows.length; at += MAX_EMBED_BATCH) {
    vectors.push(...await embedTexts(rows.slice(at, at + MAX_EMBED_BATCH).map((r) => r.text), next));
  }
  const dim = vectors[0]?.length ?? 0;
  const dropped = (db.prepare("SELECT COUNT(*) AS n FROM items WHERE collection = ? AND text IS NULL").get(coll.name) as { n: number }).n;
  const rewrite = db.prepare("UPDATE items SET embedding = ? WHERE collection = ? AND id = ?");
  db.transaction(() => {
    db.prepare("DELETE FROM items WHERE collection = ? AND text IS NULL").run(coll.name);
    rows.forEach((r, i) => rewrite.run(toBlob(vectors[i]), coll.name, r.id));
    if (dim) db.prepare("UPDATE collections SET model = ?, dim = ? WHERE name = ?").run(next, dim, coll.name);
    else db.prepare("DELETE FROM collections WHERE name = ?").run(coll.name);
  })();
  console.warn(`[glyphh-app-ai] ${slug}/${coll.name}: ${coll.model} is no longer offered; ${rows.length} items embedded again with ${next}, ${dropped} bare vectors dropped`);
  return dim ? { name: coll.name, model: next, dim } : undefined;
}

/** Every collection in an app's vector store, with item counts — the map the
 *  semantic agent tools (glyphh-agent-semantic.ts) read before building. */
export function listCollections(slug: string): Array<{ name: string; model: string; dim: number; items: number }> {
  const db = getVecDb(slug);
  const rows = db.prepare("SELECT name, model, dim FROM collections ORDER BY name").all() as
    Array<{ name: string; model: string; dim: number }>;
  const count = db.prepare("SELECT COUNT(*) AS n FROM items WHERE collection = ?");
  return rows.map((r) => ({ ...r, items: (count.get(r.name) as { n: number }).n }));
}

export async function vectorUpsert(slug: string, args: Record<string, unknown>): Promise<{ upserted: number; collection: string }> {
  const collection = String(args.collection || "").trim();
  if (!/^[a-z0-9_-]{1,64}$/i.test(collection)) throw new Error("collection is required ([a-zA-Z0-9_-])");
  const items = Array.isArray(args.items) ? args.items as Array<Record<string, unknown>> : [];
  if (!items.length) throw new Error("items is required");
  if (items.length > MAX_UPSERT_ITEMS) throw new Error(`max ${MAX_UPSERT_ITEMS} items per call`);

  const db = getVecDb(slug);
  const pinned = collectionOf(db, collection);
  const coll = pinned ? await repinned(db, slug, pinned) : undefined;
  const model = String(args.model || coll?.model || await resolveEmbedModel());
  if (coll && args.model && model !== coll.model) {
    throw new Error(`collection "${collection}" uses model ${coll.model}; delete it to change models`);
  }

  // Embed items that came as text; take provided vectors as-is.
  const needEmbed = items.filter((it) => !Array.isArray(it.vector));
  if (needEmbed.some((it) => !it.text)) throw new Error("each item needs text or vector");
  const embedded = needEmbed.length ? await embedTexts(needEmbed.map((it) => String(it.text)), model) : [];

  const count = (db.prepare("SELECT COUNT(*) AS n FROM items WHERE collection = ?").get(collection) as { n: number }).n;
  if (count + items.length > MAX_COLLECTION_ITEMS) throw new Error(`collection limit reached (${MAX_COLLECTION_ITEMS})`);

  let ei = 0;
  const rows = items.map((it) => {
    const vec = Array.isArray(it.vector) ? (it.vector as number[]).map(Number) : embedded[ei++];
    const id = String(it.id ?? "").trim();
    if (!id) throw new Error("each item needs an id");
    return { id, text: it.text != null ? String(it.text) : null, meta: it.metadata ? JSON.stringify(it.metadata) : null, vec };
  });

  const dim = coll?.dim || rows[0].vec.length;
  const bad = rows.find((r) => r.vec.length !== dim);
  if (bad) throw new Error(`vector dim mismatch: expected ${dim}, got ${bad.vec.length} (id "${bad.id}")`);
  if (!coll) {
    db.prepare("INSERT INTO collections (name, model, dim) VALUES (?, ?, ?)").run(collection, model, dim);
  }

  const upsert = db.prepare(`
    INSERT INTO items (collection, id, text, metadata_json, embedding) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (collection, id) DO UPDATE SET
      text = excluded.text, metadata_json = excluded.metadata_json, embedding = excluded.embedding
  `);
  const tx = db.transaction(() => {
    for (const r of rows) upsert.run(collection, r.id, r.text, r.meta, toBlob(r.vec));
  });
  tx();
  return { upserted: rows.length, collection };
}

export async function vectorSearch(slug: string, args: Record<string, unknown>): Promise<{ matches: Array<{ id: string; score: number; text?: string; metadata?: unknown }> }> {
  const collection = String(args.collection || "").trim();
  const db = getVecDb(slug);
  const pinned = collectionOf(db, collection);
  const coll = pinned ? await repinned(db, slug, pinned) : undefined;
  if (!coll) throw new Error(`unknown collection: ${collection}`);
  const k = Math.max(1, Math.min(100, Number(args.k) || 10));

  let queryVec: number[];
  if (Array.isArray(args.vector)) queryVec = (args.vector as number[]).map(Number);
  else if (args.query) queryVec = (await embedTexts([String(args.query)], coll.model))[0];
  else throw new Error("query or vector is required");
  if (queryVec.length !== coll.dim) throw new Error(`vector dim mismatch: expected ${coll.dim}`);
  const q = new Float32Array(toBlob(queryVec).buffer, 0, coll.dim);

  const filter = args.filter && typeof args.filter === "object" ? (args.filter as Record<string, unknown>) : null;
  const rows = db.prepare("SELECT id, text, metadata_json, embedding FROM items WHERE collection = ?")
    .all(collection) as Array<{ id: string; text: string | null; metadata_json: string | null; embedding: Buffer }>;

  const scored: Array<{ id: string; score: number; text?: string; metadata?: unknown }> = [];
  for (const row of rows) {
    let metadata: Record<string, unknown> | undefined;
    if (filter) {
      metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
      if (!Object.entries(filter).every(([key, val]) => (metadata as Record<string, unknown>)[key] === val)) continue;
    }
    const v = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, coll.dim);
    let dot = 0;
    for (let i = 0; i < coll.dim; i++) dot += q[i] * v[i];
    scored.push({
      id: row.id,
      score: dot,
      text: row.text ?? undefined,
      metadata: metadata ?? (row.metadata_json ? JSON.parse(row.metadata_json) : undefined),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return { matches: scored.slice(0, k) };
}

export function vectorItems(slug: string, collection: string): Array<{ id: string; text: string | null; metadata: unknown }> {
  const db = getVecDb(slug);
  if (!collectionOf(db, collection)) return [];
  const rows = db.prepare("SELECT id, text, metadata_json FROM items WHERE collection = ?").all(collection) as Array<{ id: string; text: string | null; metadata_json: string | null }>;
  return rows.map((r) => { let m: unknown = null; try { m = r.metadata_json ? JSON.parse(r.metadata_json) : null; } catch { m = null; } return { id: r.id, text: r.text, metadata: m }; });
}

export function vectorDelete(slug: string, args: Record<string, unknown>): { deleted: number } {
  const collection = String(args.collection || "").trim();
  if (!collection) throw new Error("collection is required");
  const db = getVecDb(slug);
  if (args.id != null) {
    const info = db.prepare("DELETE FROM items WHERE collection = ? AND id = ?").run(collection, String(args.id));
    return { deleted: info.changes };
  }
  const info = db.prepare("DELETE FROM items WHERE collection = ?").run(collection);
  db.prepare("DELETE FROM collections WHERE name = ?").run(collection);
  return { deleted: info.changes };
}

// ── per-app knowledge graph (graph.cypher — Kuzu, embedded) ──
//
// A real graph database, not a table dressed up as one: Kuzu is an embedded,
// in-process graph engine that speaks Cypher (structured property graphs,
// MATCH patterns, variable-length paths, shortest path, aggregations). Each
// app gets its own database directory at ~/.glyphh/app-data/<slug>/graph.kuzu.
//
// The app owns its schema — Kuzu is schema-full, so the first calls are DDL:
//   graph.cypher { query: "CREATE NODE TABLE Account (name STRING, arr DOUBLE, PRIMARY KEY (name))" }
//   graph.cypher { query: "CREATE REL TABLE Owns (FROM Account TO Account)" }
//   graph.cypher { query: "MATCH (a:Account)-[:Owns*1..3]->(b) WHERE a.arr > $t RETURN b", params: { t: 100000 } }

const graphDbs = new Map<string, KuzuConnection>();

function getGraphConn(slug: string): KuzuConnection {
  const existing = graphDbs.get(slug);
  if (existing) return existing;
  const kuzu = loadKuzu();
  if (!kuzu) {
    throw new Error(
      "The local graph engine (kuzu) couldn't load on this machine, so graph.* tools are unavailable. "
      + "On Windows this usually means the Microsoft Visual C++ Redistributable (2015–2022, x64) needs to be installed.",
    );
  }
  fs.mkdirSync(appDataDir(slug), { recursive: true });
  const db = new kuzu.Database(path.join(appDataDir(slug), "graph.kuzu"));
  const conn = new kuzu.Connection(db);
  graphDbs.set(slug, conn);
  return conn;
}

/** Run a Cypher statement against the app's own Kuzu graph. With `params`,
 *  the statement is prepared and executed with $-parameters. Multi-statement
 *  strings run in order; the LAST statement's rows are returned. */
export async function graphCypher(slug: string, args: Record<string, unknown>): Promise<{ rows: unknown[] }> {
  const query = String(args.query || "").trim();
  if (!query) throw new Error("query is required");
  const conn = getGraphConn(slug);
  const params = args.params && typeof args.params === "object"
    ? (args.params as Record<string, KuzuValue>)
    : null;

  let result: any;
  if (params) {
    const prepared = await conn.prepare(query);
    result = await conn.execute(prepared, params);
  } else {
    result = await conn.query(query);
  }

  const results: any[] = Array.isArray(result) ? result : [result];
  try {
    return { rows: await results[results.length - 1].getAll() };
  } finally {
    for (const r of results) { try { r.close(); } catch { /* already closed */ } }
  }
}
