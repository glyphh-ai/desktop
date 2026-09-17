/**
 * Semantic-stack agent tools — the primitives the RAG and Knowledge-Graph
 * loops orchestrate (docs/semantic-stack.md).
 *
 * Thin, governed wrappers over the per-app AI substrate (glyphh-app-ai.ts):
 * every tool targets a NAMED APP's own stores (vectors.sqlite + graph.kuzu in
 * app-data/<slug>/), because the semantic layer must travel with the app it
 * belongs to — build here, run anywhere the app runs. Nothing writes into
 * desktop-global state.
 *
 * Connection-sourced ingestion goes through connections.runTool — the same
 * workspace-grant gate as every connector call the agent makes.
 *
 * RESTORED from add3f592^ (his order, 2026-09-14) — the purge took these as
 * collateral of the engine move. The old in-main action gate is gone with
 * that engine: these now serve over the LOCAL MCP SERVER, and the CLI's own
 * permission mode is the gate (safe/ask/auto — cli-agents' vocabulary).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { llmChunk, vectorUpsert, vectorSearch, graphCypher, listCollections } from "./glyphh-app-ai.js";
import { getExplicitWorkingDirectory } from "./working-directory.js";
import { getClient } from "./glyphh-client.js";
import { callGatewayToolText } from "./gateway-mcp.js";

interface SemanticToolDef {
  name: string;
  doc: string;
  run: (args: Record<string, unknown>) => Promise<string>;
}

const MAX_FILES = 50;
const MAX_FILE_BYTES = 1_000_000;
const OUT_CAP = 8_000;
const capOut = (s: string) => (s.length > OUT_CAP ? `${s.slice(0, OUT_CAP)}\n…(truncated, ${s.length} chars total)` : s);

const appSlug = (a: Record<string, unknown>): string => {
  const slug = String(a.app ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) throw new Error("app is required — the target app's slug ([a-z0-9-])");
  return slug;
};

const collectionName = (a: Record<string, unknown>): string => {
  const c = String(a.collection ?? "").trim();
  if (!/^[a-z0-9_-]{1,64}$/i.test(c)) throw new Error("collection is required ([a-zA-Z0-9_-])");
  return c;
};

/** Resolve a caller path INSIDE the working folder — the agent's file jail. */
function workspacePath(p: string): string {
  const root = getExplicitWorkingDirectory();
  if (!root) throw new Error("no working folder is set — open one first");
  const abs = isAbsolute(p) ? p : resolve(root, p);
  if (relative(root, abs).startsWith("..")) throw new Error(`path escapes the working folder: ${p}`);
  return abs;
}

/** Chunk one text and upsert it into the app's collection with stable ids. */
async function indexText(
  slug: string, collection: string, sourceId: string, text: string, chunkChars: number,
): Promise<number> {
  const { chunks } = llmChunk({ text, maxChars: chunkChars });
  if (!chunks.length) return 0;
  // Batches of 32 keep each upsert under the per-call item cap and each ONNX
  // embed pass small enough not to starve the event loop.
  let done = 0;
  for (let i = 0; i < chunks.length; i += 32) {
    const batch = chunks.slice(i, i + 32).map((c, j) => ({
      id: `${sourceId}#${i + j}`,
      text: c,
      metadata: { source: sourceId, chunk: i + j },
    }));
    const { upserted } = await vectorUpsert(slug, { collection, items: batch });
    done += upserted;
  }
  return done;
}

export const SEMANTIC_TOOLS: SemanticToolDef[] = [
  {
    name: "semantic_collections",
    doc: "semantic_collections(app) — the app's vector collections (name, model, items) and knowledge-graph tables. The map of an app's semantic layer.",
    run: async (a) => {
      const slug = appSlug(a);
      // An empty/unbuilt store is a normal answer, not an error — the loops
      // call this first to decide whether to build or extend.
      let collections: unknown[] = [];
      try { collections = listCollections(slug); } catch { collections = []; }
      let tables: unknown[] = [];
      try {
        const { rows } = await graphCypher(slug, { query: "CALL SHOW_TABLES() RETURN *" });
        tables = rows;
      } catch { tables = []; }
      return capOut(JSON.stringify({ app: slug, collections, graphTables: tables }, null, 2));
    },
  },
  {
    name: "index_files",
    doc: "index_files(app, collection, paths, chunkChars?) — read working-folder files, chunk, embed, and upsert into the app's vector collection. Text files only; ids are <path>#<n>.",
    run: async (a) => {
      const slug = appSlug(a);
      const collection = collectionName(a);
      const paths = Array.isArray(a.paths) ? a.paths.map(String) : [];
      if (!paths.length) return "ERROR: paths is required — a list of working-folder files";
      if (paths.length > MAX_FILES) return `ERROR: max ${MAX_FILES} files per call`;
      const chunkChars = Math.max(200, Math.min(4000, Number(a.chunkChars) || 1500));
      const report: string[] = [];
      let total = 0;
      for (const p of paths) {
        try {
          const abs = workspacePath(p);
          if (!existsSync(abs)) { report.push(`${p}: not found`); continue; }
          if (statSync(abs).size > MAX_FILE_BYTES) { report.push(`${p}: too large (>1MB)`); continue; }
          const text = readFileSync(abs, "utf-8");
          const n = await indexText(slug, collection, p, text, chunkChars);
          total += n;
          report.push(`${p}: ${n} chunks`);
        } catch (err) {
          report.push(`${p}: error — ${err instanceof Error ? err.message : err}`);
        }
      }
      return capOut(`indexed ${total} chunks into ${slug}/${collection}\n${report.join("\n")}`);
    },
  },
  {
    name: "index_text",
    doc: "index_text(app, collection, id, text, chunkChars?) — chunk + embed raw text (a paste, an upload, a generated summary) into the app's vector collection under a stable source id.",
    run: async (a) => {
      const slug = appSlug(a);
      const collection = collectionName(a);
      const id = String(a.id ?? "").trim();
      const text = String(a.text ?? "");
      if (!id) return "ERROR: id is required — a stable source id for these chunks";
      if (!text.trim()) return "ERROR: text is required";
      const chunkChars = Math.max(200, Math.min(4000, Number(a.chunkChars) || 1500));
      const n = await indexText(slug, collection, id, text, chunkChars);
      return `indexed ${n} chunks into ${slug}/${collection} under "${id}"`;
    },
  },
  {
    name: "index_connection",
    doc: "index_connection(app, collection, slug, tool, props?) — run a connector tool (Drive list/read, Gmail search, …) and index its output. Rides the workspace connection grants like every connector call.",
    run: async (a) => {
      const app = appSlug(a);
      const collection = collectionName(a);
      const connSlug = String(a.slug ?? "").trim();
      const connTool = String(a.tool ?? "").trim();
      if (!connSlug || !connTool) return "ERROR: slug and tool are required (a connection + one of its tools)";
      const props = a.props && typeof a.props === "object" ? (a.props as Record<string, unknown>) : {};
      const result = { ret: await callGatewayToolText(connSlug, connTool, props) };
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      if (!text || text === "null") return "connector returned nothing to index";
      const sourceId = `${connSlug}/${connTool}`;
      const n = await indexText(app, collection, sourceId, text, 1500);
      return `indexed ${n} chunks from ${sourceId} into ${app}/${collection}`;
    },
  },
  {
    name: "vector_search",
    doc: "vector_search(app, collection, query, k?, filter?) — semantic retrieval from the app's vector collection. Returns the top-k chunks with scores + source metadata.",
    run: async (a) => {
      const slug = appSlug(a);
      const collection = collectionName(a);
      const query = String(a.query ?? "").trim();
      if (!query) return "ERROR: query is required";
      const { matches } = await vectorSearch(slug, {
        collection, query,
        k: Math.max(1, Math.min(50, Number(a.k) || 8)),
        ...(a.filter && typeof a.filter === "object" ? { filter: a.filter } : {}),
      });
      return capOut(JSON.stringify(matches, null, 2));
    },
  },
  {
    name: "graph_query",
    doc: "graph_query(app, cypher) — Cypher against the app's embedded Kuzu knowledge graph. Reads (MATCH/RETURN/CALL SHOW) gate as reads; CREATE/MERGE/SET/DELETE gate as writes. Create node/rel tables first (CREATE NODE TABLE …).",
    run: async (a) => {
      const slug = appSlug(a);
      const q = String(a.cypher ?? "").trim();
      if (!q) return "ERROR: cypher is required";
      const { rows } = await graphCypher(slug, { query: q });
      return capOut(JSON.stringify(rows, null, 2));
    },
  },
];
