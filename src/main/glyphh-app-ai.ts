/**
 * glyphh-app-ai — AI/data services for Glyphh apps (spec v2):
 *
 *   llm.embed        { text | texts, model? }     local embeddings (ONNX, on-device)
 *   llm.chunk        { text, maxChars?, overlap? } split text for embedding pipelines
 *   llm.complete     { prompt, system?, model? }  one-shot completion via the
 *                                                 user's Glyphh LLM (credits/BYOK)
 *   vector.upsert    { collection, items }        per-app vector store
 *   vector.search    { collection, query|vector, k?, filter? }
 *   vector.delete    { collection, id? }
 *   graph.upsertNode { id, label?, props? }       per-app property graph
 *   graph.upsertEdge { from, to, type, props? }
 *   graph.neighbors  { id, depth?, direction?, type? }
 *   graph.match      { label?, props?, limit? }
 *   graph.deleteNode { id }   graph.deleteEdge { from, to, type }
 *
 * Everything is on-device and slug-scoped like the other services: vectors in
 * ~/yo/app-data/<slug>/vectors.sqlite, the graph in graph.sqlite. Embeddings
 * run locally via @huggingface/transformers + onnxruntime (already shipped);
 * the model downloads once to ~/yo/models. llm.complete is the ONE remote
 * call — it rides sdk-llm's platform proxy (credits) exactly like Glyphh's
 * own agent, so apps get intelligence without ever holding a key.
 *
 * Vector search is exact cosine over Float32 blobs — at desktop scale
 * (≤ ~100k items) that's a few ms and beats shipping an ANN engine. The
 * graph is a property graph on SQLite with recursive-CTE traversal; the
 * capability surface is engine-agnostic so an embedded Cypher engine (Kuzu)
 * can replace the backend later without touching apps.
 */

import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { sdkComplete } from "./sdk-llm.js";
import { appDataDir } from "./glyphh-app-services.js";

// ── local embeddings (llm.embed) ────────────────────────────

const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
const MAX_EMBED_BATCH = 64;
const MAX_EMBED_CHARS = 8_000;

// @huggingface/transformers is ESM-only; this file compiles to CommonJS.
const dynamicImport = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<any>;

const embedders = new Map<string, Promise<any>>(); // model → pipeline promise

function getEmbedder(model: string): Promise<any> {
  let p = embedders.get(model);
  if (!p) {
    p = (async () => {
      const tf = await dynamicImport("@huggingface/transformers");
      tf.env.cacheDir = path.join(os.homedir(), "yo", "models");
      return tf.pipeline("feature-extraction", model);
    })();
    p.catch(() => embedders.delete(model)); // failed load shouldn't poison retries
    embedders.set(model, p);
  }
  return p;
}

async function embedTexts(texts: string[], model: string): Promise<number[][]> {
  const clipped = texts.map((t) => String(t).slice(0, MAX_EMBED_CHARS));
  const extractor = await getEmbedder(model);
  const out = await extractor(clipped, { pooling: "mean", normalize: true });
  return out.tolist() as number[][];
}

export async function llmEmbed(args: Record<string, unknown>): Promise<{ model: string; dim: number; vectors: number[][] }> {
  const model = String(args.model || DEFAULT_EMBED_MODEL);
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

// ── completion (llm.complete) ───────────────────────────────

const MAX_PROMPT_CHARS = 100_000;

/** One-shot completion through the user's Glyphh LLM (platform proxy /
 *  credits — same path as Glyphh's own agent). Apps never hold keys and
 *  never pick a vendor; the user's Glyphh config decides. */
export async function llmComplete(args: Record<string, unknown>): Promise<{ text: string; usage?: { input_tokens: number; output_tokens: number } }> {
  const prompt = String(args.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`prompt too long (max ${MAX_PROMPT_CHARS} chars)`);
  const system = String(args.system || "You are a helpful assistant inside a Glyphh app. Answer concisely.");
  const result = await sdkComplete({ system, prompt, model: args.model ? String(args.model) : undefined });
  return { text: result.text, usage: result.usage };
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

function collectionOf(db: Database.Database, name: string): { name: string; model: string; dim: number } | undefined {
  return db.prepare("SELECT name, model, dim FROM collections WHERE name = ?").get(name) as
    { name: string; model: string; dim: number } | undefined;
}

export async function vectorUpsert(slug: string, args: Record<string, unknown>): Promise<{ upserted: number; collection: string }> {
  const collection = String(args.collection || "").trim();
  if (!/^[a-z0-9_-]{1,64}$/i.test(collection)) throw new Error("collection is required ([a-zA-Z0-9_-])");
  const items = Array.isArray(args.items) ? args.items as Array<Record<string, unknown>> : [];
  if (!items.length) throw new Error("items is required");
  if (items.length > MAX_UPSERT_ITEMS) throw new Error(`max ${MAX_UPSERT_ITEMS} items per call`);

  const db = getVecDb(slug);
  let coll = collectionOf(db, collection);
  const model = String(args.model || coll?.model || DEFAULT_EMBED_MODEL);
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
  const coll = collectionOf(db, collection);
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

// ── per-app property graph (graph.*) ────────────────────────

const graphDbs = new Map<string, Database.Database>();

function getGraphDb(slug: string): Database.Database {
  const existing = graphDbs.get(slug);
  if (existing && existing.open) return existing;
  fs.mkdirSync(appDataDir(slug), { recursive: true });
  const db = new Database(path.join(appDataDir(slug), "graph.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY, label TEXT, props_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS edges (
      src TEXT NOT NULL, dst TEXT NOT NULL, type TEXT NOT NULL, props_json TEXT,
      PRIMARY KEY (src, dst, type)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges (dst);
    CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes (label);
  `);
  graphDbs.set(slug, db);
  return db;
}

interface NodeOut { id: string; label?: string; props?: unknown }
interface EdgeOut { from: string; to: string; type: string; props?: unknown }

function nodeOut(r: { id: string; label: string | null; props_json: string | null }): NodeOut {
  return { id: r.id, label: r.label ?? undefined, props: r.props_json ? JSON.parse(r.props_json) : undefined };
}
function edgeOut(r: { src: string; dst: string; type: string; props_json: string | null }): EdgeOut {
  return { from: r.src, to: r.dst, type: r.type, props: r.props_json ? JSON.parse(r.props_json) : undefined };
}

export function graphUpsertNode(slug: string, args: Record<string, unknown>): { upserted: true; id: string } {
  const id = String(args.id || "").trim();
  if (!id) throw new Error("id is required");
  const label = args.label != null ? String(args.label) : null;
  const props = args.props && typeof args.props === "object" ? JSON.stringify(args.props) : null;
  getGraphDb(slug).prepare(`
    INSERT INTO nodes (id, label, props_json, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (id) DO UPDATE SET
      label = COALESCE(excluded.label, nodes.label),
      props_json = COALESCE(excluded.props_json, nodes.props_json),
      updated_at = excluded.updated_at
  `).run(id, label, props);
  return { upserted: true, id };
}

export function graphUpsertEdge(slug: string, args: Record<string, unknown>): { upserted: true } {
  const src = String(args.from || "").trim();
  const dst = String(args.to || "").trim();
  const type = String(args.type || "").trim();
  if (!src || !dst || !type) throw new Error("from, to, and type are required");
  const db = getGraphDb(slug);
  // Auto-create endpoint nodes so bulk edge loads don't need a node pass first.
  const touch = db.prepare("INSERT INTO nodes (id) VALUES (?) ON CONFLICT (id) DO NOTHING");
  touch.run(src);
  touch.run(dst);
  const props = args.props && typeof args.props === "object" ? JSON.stringify(args.props) : null;
  db.prepare(`
    INSERT INTO edges (src, dst, type, props_json) VALUES (?, ?, ?, ?)
    ON CONFLICT (src, dst, type) DO UPDATE SET props_json = excluded.props_json
  `).run(src, dst, type, props);
  return { upserted: true };
}

/** Traverse from a node up to `depth` hops (default 1, max 5), optionally
 *  restricted by edge type and direction ("out" | "in" | "both"). */
export function graphNeighbors(slug: string, args: Record<string, unknown>): { nodes: NodeOut[]; edges: EdgeOut[] } {
  const id = String(args.id || "").trim();
  if (!id) throw new Error("id is required");
  const depth = Math.max(1, Math.min(5, Number(args.depth) || 1));
  const direction = args.direction === "in" ? "in" : args.direction === "both" ? "both" : "out";
  const type = args.type != null ? String(args.type) : null;
  const db = getGraphDb(slug);

  // Iterative BFS with prepared per-hop statements (clearer than a recursive
  // CTE once direction/type options enter the picture, and equally fast at
  // these depths).
  const ids = new Set<string>([id]);
  let frontier = [id];
  const outStmt = db.prepare(`SELECT dst AS next FROM edges WHERE src = ?${type ? " AND type = ?" : ""}`);
  const inStmt = db.prepare(`SELECT src AS next FROM edges WHERE dst = ?${type ? " AND type = ?" : ""}`);
  for (let hop = 0; hop < depth && frontier.length; hop++) {
    const nextFrontier: string[] = [];
    for (const cur of frontier) {
      const rows: Array<{ next: string }> = [];
      if (direction !== "in") rows.push(...(type ? outStmt.all(cur, type) : outStmt.all(cur)) as Array<{ next: string }>);
      if (direction !== "out") rows.push(...(type ? inStmt.all(cur, type) : inStmt.all(cur)) as Array<{ next: string }>);
      for (const r of rows) {
        if (!ids.has(r.next)) { ids.add(r.next); nextFrontier.push(r.next); }
      }
    }
    frontier = nextFrontier;
  }

  const idList = [...ids];
  const ph = idList.map(() => "?").join(",");
  const nodes = (db.prepare(`SELECT id, label, props_json FROM nodes WHERE id IN (${ph})`).all(...idList) as
    Array<{ id: string; label: string | null; props_json: string | null }>).map(nodeOut);
  const edges = (db.prepare(`SELECT src, dst, type, props_json FROM edges WHERE src IN (${ph}) AND dst IN (${ph})`)
    .all(...idList, ...idList) as Array<{ src: string; dst: string; type: string; props_json: string | null }>).map(edgeOut);
  return { nodes, edges };
}

/** Find nodes by label and/or exact prop values. */
export function graphMatch(slug: string, args: Record<string, unknown>): { nodes: NodeOut[] } {
  const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));
  const label = args.label != null ? String(args.label) : null;
  const props = args.props && typeof args.props === "object" ? (args.props as Record<string, unknown>) : null;
  const db = getGraphDb(slug);
  const where: string[] = [];
  const params: unknown[] = [];
  if (label) { where.push("label = ?"); params.push(label); }
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      where.push("json_extract(props_json, ?) = ?");
      params.push(`$.${key}`, val as string | number);
    }
  }
  const sql = `SELECT id, label, props_json FROM nodes${where.length ? " WHERE " + where.join(" AND ") : ""} LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as Array<{ id: string; label: string | null; props_json: string | null }>;
  return { nodes: rows.map(nodeOut) };
}

export function graphDeleteNode(slug: string, args: Record<string, unknown>): { deleted: boolean } {
  const id = String(args.id || "").trim();
  if (!id) throw new Error("id is required");
  const db = getGraphDb(slug);
  db.prepare("DELETE FROM edges WHERE src = ? OR dst = ?").run(id, id);
  const info = db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
  return { deleted: info.changes > 0 };
}

export function graphDeleteEdge(slug: string, args: Record<string, unknown>): { deleted: boolean } {
  const src = String(args.from || "").trim();
  const dst = String(args.to || "").trim();
  const type = String(args.type || "").trim();
  if (!src || !dst || !type) throw new Error("from, to, and type are required");
  const info = getGraphDb(slug).prepare("DELETE FROM edges WHERE src = ? AND dst = ? AND type = ?").run(src, dst, type);
  return { deleted: info.changes > 0 };
}
