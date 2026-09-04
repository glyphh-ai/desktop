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
 *
 * Two layers on top of the raw index:
 *
 *   ENRICHMENT — thin catalog descriptions embed badly (parameter noise, no
 *   intent language), so a cheap model writes a retrieval PARAGRAPH per tool
 *   ("what it does, when you'd reach for it, how a user would phrase the
 *   ask") and that paragraph is what gets embedded and what find_tools
 *   shows. One back-path call per ~16 tools, once per content change,
 *   best-effort: the index works un-enriched, just duller.
 *
 *   WORKING SET — tools the session actually called are pinned into the
 *   next run's wire set ahead of ranking. Most sessions ride ~5 tools
 *   repeatedly; retrieval should be a first-touch cost, not a per-turn one.
 */

import { createHash } from "crypto";
import { getLocalDb } from "./local-db";
import { embedText, embedTexts, dot, packVec, unpackVec } from "./glyphh-agent-embeddings";
import { getClient } from "./glyphh-client";
import type { ConnectorWireDef } from "./glyphh-agent-tools";

const TOOL_K = 24;         // most connector tools a single run wires
const SEM_MIN = 0.3;       // nomic cosine floor for "related to the ask"
const TOKEN_BUDGET = 7000; // ≈ tokens the wired tool JSON may cost (of 32k)
const SMALL_ENOUGH = 12;   // catalogs this small skip selection entirely

/** Descriptions shorter than this get the enrichment pass; longer ones
 *  already carry enough intent language to embed on their own. */
const THIN_DESC = 200;
/** Enrichment batching: tools per model call, and calls per refresh — a big
 *  catalog converges over a few refreshes instead of burning credits at once. */
const ENRICH_BATCH = 16;
const ENRICH_MAX_CALLS = 8;

const est = (s: string) => Math.ceil(s.length / 3.2);

const toolHash = (d: ConnectorWireDef) =>
  createHash("sha1").update(`${d.name}\n${d.description}`).digest("hex");

interface VecRow { name: string; hash: string; embedding: Buffer; paragraph: string | null }

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
  // A changed def resets paragraph to NULL — the enrichment pass owns it.
  const ins = db.prepare("INSERT OR REPLACE INTO tool_vectors (name, hash, embedding, paragraph) VALUES (?, ?, ?, NULL)");
  missing.forEach((d, i) => ins.run(d.name, toolHash(d), packVec(vecs[i])));
}

// ── Enrichment — the back-path paragraph writer ──────────────────────────────

let enriching = false;

/** The most recently started live agent run — background work attributes to
 *  it when present (his rule, 2026-08-25). */
function activeRunId(): string | null {
  try {
    // Lazy import avoids a cycle: glyphh-agent-tools imports this module.
    const mod = require("./glyphh-agent-tools") as { activeAgentRuns?: Map<string, { runId: string; startedAt: number }> };
    const runs = [...(mod.activeAgentRuns?.values() ?? [])];
    if (!runs.length) return null;
    runs.sort((a, b) => b.startedAt - a.startedAt);
    return runs[0]!.runId;
  } catch {
    return null;
  }
}

/** The cheapest capable model in the org's catalog — the back-path doctrine:
 *  enrichment never rides the session's frontier model. */
async function enricherModel(): Promise<string | null> {
  try {
    const models = await getClient().models.available();
    if (!models.length) return null;
    const cheap = models.find((m) => /haiku|mini|flash|small|nano|lite|3b|7b|8b|1\.7b/i.test(m.id) || /haiku|mini|flash|small|nano|lite/i.test(m.name));
    // No cheap model in the caller's catalog → skip enrichment. The old
    // models[0] fallback rode the list's alphabetical head — a frontier
    // model — for a background nicety, and its refusal surfaced as the
    // live run's error.
    return cheap?.id ?? null;
  } catch {
    return null;
  }
}

/** Write retrieval paragraphs for thin-description tools that lack one, then
 *  re-embed those rows with the paragraph. Fire-and-forget; capped per call
 *  so a huge catalog converges across refreshes instead of in one bill. */
export async function enrichToolVectors(defs: ConnectorWireDef[]): Promise<void> {
  if (enriching) return;
  enriching = true;
  try {
    let db: ReturnType<typeof getLocalDb>;
    try { db = getLocalDb(); } catch { return; }
    const rows = new Map(
      (db.prepare("SELECT name, hash, paragraph FROM tool_vectors").all() as Array<{ name: string; hash: string; paragraph: string | null }>)
        .map((r) => [r.name, r] as const),
    );
    const need = defs.filter((d) => {
      const row = rows.get(d.name);
      return row && row.hash === toolHash(d) && !row.paragraph && d.description.length < THIN_DESC;
    });
    if (!need.length) return;
    const model = await enricherModel();
    if (!model) return;

    const upd = db.prepare("UPDATE tool_vectors SET paragraph = ?, embedding = ? WHERE name = ? AND hash = ?");
    for (let call = 0; call < ENRICH_MAX_CALLS && call * ENRICH_BATCH < need.length; call++) {
      const batch = need.slice(call * ENRICH_BATCH, (call + 1) * ENRICH_BATCH);
      const listing = batch.map((d) => `- ${d.name}: ${d.description}`).join("\n");
      let text: string;
      try {
        text = await getClient().gateway.text({
          // Honest ledger: this is BACKGROUND enrichment, not a worker turn —
          // and it books against the run that triggered it when one is live.
          service: "enrichment",
          ...(activeRunId() ? { runId: activeRunId()! } : {}),
          model,
          messages: [
            {
              role: "system",
              content:
                "You write retrieval documents for a tool search index. For EACH tool listed, write ONE plain paragraph (2-3 sentences, no markdown): what it does, when someone would reach for it, and two short example asks a user might phrase (quoted, comma-separated). Mention the product/vendor by name and natural synonyms for the action. Output STRICT JSON: an object mapping each tool name to its paragraph. No other text.",
            },
            { role: "user", content: listing },
          ],
          maxTokens: 220 * batch.length,
        });
      } catch {
        return; // out of credits / offline — try again on a later refresh
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;
      } catch {
        continue; // one malformed batch shouldn't stop the rest
      }
      const good = batch.filter((d) => typeof parsed[d.name] === "string" && (parsed[d.name] as string).trim().length > 40);
      if (!good.length) continue;
      const vecs = await embedTexts(good.map((d) => `${d.name} — ${(parsed[d.name] as string).trim()}`), "document");
      if (!vecs) return;
      good.forEach((d, i) => upd.run((parsed[d.name] as string).trim().slice(0, 1200), packVec(vecs[i]), d.name, toolHash(d)));
    }
  } finally {
    enriching = false;
  }
}

// ── Working set — tools this session actually used stay wired ────────────────

const PIN_CAP = 12;
/** A pin is a prior about THIS stretch of work, not about the machine —
 *  entries age out instead of waiting on a session-lifecycle hook. */
const PIN_TTL_MS = 45 * 60 * 1000;
const used = new Map<string, number>(); // wire name → last-used ts

export function noteToolUsed(name: string): void {
  used.delete(name);
  used.set(name, Date.now());
  while (used.size > PIN_CAP) {
    const oldest = used.keys().next().value;
    if (oldest === undefined) break;
    used.delete(oldest);
  }
}

function pinnedNames(): string[] {
  const floor = Date.now() - PIN_TTL_MS;
  for (const [name, ts] of used) if (ts < floor) used.delete(name);
  return [...used.keys()].reverse(); // most recent first
}

/** New session, clean slate — yesterday's tools are not a prior for today. */
export function resetToolWorkingSet(): void {
  used.clear();
}

// ── Ranking ──────────────────────────────────────────────────────────────────

const tokenize = (s: string) =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));

/** Word-overlap score — the safety net when the embedder is down, and a
 *  boost for asks that name the app outright ("check my gmail"). */
function lexScore(askTokens: Set<string>, d: ConnectorWireDef, blurb: string | null): number {
  if (!askTokens.size) return 0;
  const toks = tokenize(`${d.name} ${d.description} ${blurb ?? ""}`);
  let hits = 0;
  for (const t of askTokens) if (toks.has(t)) hits++;
  return hits / Math.sqrt(askTokens.size);
}

export interface RankedTool {
  def: ConnectorWireDef;
  semantic: number;
  lexical: number;
  score: number;
  /** The enriched retrieval paragraph when one exists — what find_tools shows. */
  blurb: string | null;
}

/** Rank the catalog against a query: pre-encoded vectors + lexical overlap.
 *  Semantic scores read the tool_vectors table (encoded at catalog refresh);
 *  the only turn-time embedding is the query itself. */
export async function rankConnectorTools(query: string, defs: ConnectorWireDef[]): Promise<RankedTool[]> {
  const askTokens = tokenize(query);
  let rows: Map<string, { sem: number; paragraph: string | null }> | null = null;
  const q = await embedText(query.slice(0, 2000), "query").catch(() => null);
  try {
    const db = getLocalDb();
    const all = db.prepare("SELECT name, embedding, paragraph FROM tool_vectors").all() as VecRow[];
    rows = new Map();
    for (const r of all) rows.set(r.name, { sem: q ? dot(q, unpackVec(r.embedding)) : 0, paragraph: r.paragraph });
  } catch { rows = null; }
  return defs
    .map((def) => {
      const row = rows?.get(def.name);
      const semantic = row?.sem ?? 0;
      const blurb = row?.paragraph ?? null;
      const lexical = lexScore(askTokens, def, blurb);
      return { def, semantic, lexical, score: semantic + Math.min(lexical, 1) * 0.4, blurb };
    })
    .sort((a, b) => b.score - a.score);
}

/** The wire set for one run: the session's WORKING SET first (tools already
 *  used stay wired — retrieval is a first-touch cost), then top-scored tools
 *  related to the ask, capped by count AND token budget, returned in catalog
 *  order so the prompt prefix stays byte-stable across runs that select the
 *  same set. */
export async function selectConnectorTools(ask: string, defs: ConnectorWireDef[]): Promise<ConnectorWireDef[]> {
  if (defs.length <= SMALL_ENOUGH) return defs;
  const byName = new Map(defs.map((d) => [d.name, d] as const));
  const picked = new Set<string>();
  let spent = 0;
  const take = (d: ConnectorWireDef): boolean => {
    const cost = est(JSON.stringify(d));
    if (spent + cost > TOKEN_BUDGET) return false;
    picked.add(d.name);
    spent += cost;
    return true;
  };
  for (const name of pinnedNames()) {
    const d = byName.get(name);
    if (d && picked.size < TOOL_K) take(d);
  }
  const ranked = await rankConnectorTools(ask, defs);
  for (const r of ranked) {
    if (picked.size >= TOOL_K) break;
    if (picked.has(r.def.name)) continue;
    if (r.semantic < SEM_MIN && r.lexical === 0) continue; // unrelated to the ask
    take(r.def);
  }
  return defs.filter((d) => picked.has(d.name));
}
