/**
 * tool-vectors — semantic tool selection for the Glyphh loop.
 *
 * The governed connector catalog is far too big to wire into every turn:
 * tool defs are part of the prompt prefix the router can never squeeze, and
 * a few hundred Pipedream tools alone overflow the local model's 32k window.
 * So the catalog is ENCODED ONCE per change — the same on-device nomic
 * embedder that powers turn recall and workspace search, incremental by
 * content hash — and each run wires only the tools related to the ask:
 * one query embedding + a brute-force dot scan, sub-millisecond at catalog
 * scale. Anything the preselection drops stays reachable in-run through
 * find_tools → call_tool.
 */

import { createHash } from "crypto";
import { getLocalDb } from "./local-db";
import { embedText, embedTexts, dot, packVec, unpackVec } from "./glyphh-agent-embeddings";
import type { ConnectorWireDef } from "./glyphh-agent-tools";

const TOOL_K = 24;         // most connector tools a single run wires
const SEM_MIN = 0.3;       // nomic cosine floor for "related to the ask"
const TOKEN_BUDGET = 7000; // ≈ tokens the wired tool JSON may cost (of 32k)
const SMALL_ENOUGH = 12;   // catalogs this small skip selection entirely

const est = (s: string) => Math.ceil(s.length / 3.2);

const toolHash = (d: ConnectorWireDef) =>
  createHash("sha1").update(`${d.name}\n${d.description}`).digest("hex");

/** Encode new/changed defs, prune vanished ones. Idempotent; embedder-down
 *  degrades to a no-op (selection then leans on the lexical score). */
export async function indexToolVectors(defs: ConnectorWireDef[]): Promise<void> {
  let db: ReturnType<typeof getLocalDb>;
  try { db = getLocalDb(); } catch { return; }
  const have = new Map(
    (db.prepare("SELECT name, hash FROM tool_vectors").all() as Array<{ name: string; hash: string }>)
      .map((r) => [r.name, r.hash] as const),
  );
  const names = new Set(defs.map((d) => d.name));
  const del = db.prepare("DELETE FROM tool_vectors WHERE name = ?");
  for (const name of have.keys()) if (!names.has(name)) del.run(name);
  const missing = defs.filter((d) => have.get(d.name) !== toolHash(d));
  if (!missing.length) return;
  const vecs = await embedTexts(missing.map((d) => `${d.name} — ${d.description}`), "document");
  if (!vecs) return;
  const ins = db.prepare("INSERT OR REPLACE INTO tool_vectors (name, hash, embedding) VALUES (?, ?, ?)");
  missing.forEach((d, i) => ins.run(d.name, toolHash(d), packVec(vecs[i])));
}

const tokenize = (s: string) =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));

/** Word-overlap score — the safety net when the embedder is down, and a
 *  boost for asks that name the app outright ("check my gmail"). */
function lexScore(askTokens: Set<string>, d: ConnectorWireDef): number {
  if (!askTokens.size) return 0;
  const toks = tokenize(`${d.name} ${d.description}`);
  let hits = 0;
  for (const t of askTokens) if (toks.has(t)) hits++;
  return hits / Math.sqrt(askTokens.size);
}

export interface RankedTool {
  def: ConnectorWireDef;
  semantic: number;
  lexical: number;
  score: number;
}

/** Rank the catalog against a query: pre-encoded vectors + lexical overlap.
 *  Semantic scores read the tool_vectors table (encoded at catalog refresh);
 *  the only turn-time embedding is the query itself. */
export async function rankConnectorTools(query: string, defs: ConnectorWireDef[]): Promise<RankedTool[]> {
  const askTokens = tokenize(query);
  let sem: Map<string, number> | null = null;
  const q = await embedText(query.slice(0, 2000), "query").catch(() => null);
  if (q) {
    try {
      const db = getLocalDb();
      sem = new Map();
      const rows = db.prepare("SELECT name, embedding FROM tool_vectors").all() as Array<{ name: string; embedding: Buffer }>;
      for (const r of rows) sem.set(r.name, dot(q, unpackVec(r.embedding)));
    } catch { sem = null; }
  }
  return defs
    .map((def) => {
      const semantic = sem?.get(def.name) ?? 0;
      const lexical = lexScore(askTokens, def);
      return { def, semantic, lexical, score: semantic + Math.min(lexical, 1) * 0.4 };
    })
    .sort((a, b) => b.score - a.score);
}

/** The wire set for one run: top-scored tools related to the ask, capped by
 *  count AND token budget, returned in catalog order so the prompt prefix
 *  stays byte-stable across runs that select the same set. */
export async function selectConnectorTools(ask: string, defs: ConnectorWireDef[]): Promise<ConnectorWireDef[]> {
  if (defs.length <= SMALL_ENOUGH) return defs;
  const ranked = await rankConnectorTools(ask, defs);
  const picked = new Set<string>();
  let spent = 0;
  for (const r of ranked) {
    if (picked.size >= TOOL_K) break;
    if (r.semantic < SEM_MIN && r.lexical === 0) continue; // unrelated to the ask
    const cost = est(JSON.stringify(r.def));
    if (spent + cost > TOKEN_BUDGET) continue;
    picked.add(r.def.name);
    spent += cost;
  }
  return defs.filter((d) => picked.has(d.name));
}
