/**
 * workspace-index — a local semantic index of the working folder.
 *
 * What it buys, concretely:
 *   tokens  — semantic_search returns the RIGHT ~50-line spans instead of
 *             whole files: reading one 1,500-line file costs ~12k tokens;
 *             three targeted spans cost ~1.5k. On unfamiliar repos it also
 *             replaces the grep-guess-read-repeat loop (each miss is a
 *             full round trip through the model).
 *   quality — matches by MEANING ("where do we validate cron ids"), which
 *             grep only finds when you already know the literal string.
 *
 * Mechanics: files chunk into ~50-line windows on line boundaries, embed
 * locally (free — the llama runtime), and land in workspace_vectors keyed
 * by root. Incremental by mtime: an unchanged file is never re-embedded.
 * Everything is per-user + per-machine local state; nothing syncs.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { getLocalDb } from "./local-db";
import { embedText, embedTexts, dot, packVec, unpackVec } from "./glyphh-agent-embeddings";

const CHUNK_LINES = 50;
const CHUNK_OVERLAP = 8;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES_PER_PASS = 400;
const MAX_EMBEDS_PER_PASS = 300;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".cache", ".turbo", "vendor"]);
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".html", ".css", ".scss",
  ".md", ".txt", ".yml", ".yaml", ".toml", ".sql", ".py", ".rb", ".go", ".rs",
  ".sh", ".zsh", ".svelte", ".vue", ".astro", ".xml", ".svg", ".env.example",
]);

interface Chunk { path: string; chunkNo: number; startLine: number; endLine: number; text: string }

const indexing = new Set<string>(); // roots with a pass in flight

function walk(root: string): Array<{ rel: string; abs: string; mtime: number }> {
  const out: Array<{ rel: string; abs: string; mtime: number }> = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES_PER_PASS) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name.startsWith(".") && name !== ".env.example") continue;
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) stack.push(abs);
        continue;
      }
      if (!TEXT_EXT.has(extname(name).toLowerCase())) continue;
      if (st.size > MAX_FILE_BYTES || st.size === 0) continue;
      out.push({ rel: relative(root, abs), abs, mtime: Math.floor(st.mtimeMs) });
      if (out.length >= MAX_FILES_PER_PASS) break;
    }
  }
  return out;
}

function chunkFile(rel: string, content: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  let no = 0;
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const text = lines.slice(start, end).join("\n").trim();
    if (text.length >= 40) {
      chunks.push({ path: rel, chunkNo: no++, startLine: start + 1, endLine: end, text });
    }
    if (end >= lines.length) break;
  }
  return chunks;
}

/** Incremental index pass over `root`. Serialized per root; embeds only
 *  changed files, caps per pass (the next pass finishes the tail). */
export async function refreshWorkspaceIndex(root: string): Promise<void> {
  if (!root || indexing.has(root)) return;
  indexing.add(root);
  try {
    let db;
    try { db = getLocalDb(); } catch { return; }
    const files = walk(root);
    const known = new Map(
      (db.prepare("SELECT DISTINCT path, mtime FROM workspace_vectors WHERE root = ?").all(root) as Array<{ path: string; mtime: number }>)
        .map((r) => [r.path, r.mtime]),
    );
    // Vanished files leave the index.
    const present = new Set(files.map((f) => f.rel));
    const delFile = db.prepare("DELETE FROM workspace_vectors WHERE root = ? AND path = ?");
    for (const path of known.keys()) if (!present.has(path)) delFile.run(root, path);
    // Changed/new files re-chunk + re-embed (budgeted per pass).
    let embedded = 0;
    const ins = db.prepare(`
      INSERT OR REPLACE INTO workspace_vectors
        (root, path, chunk_no, start_line, end_line, mtime, text, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const f of files) {
      if (embedded >= MAX_EMBEDS_PER_PASS) break;
      if (known.get(f.rel) === f.mtime) continue;
      let content: string;
      try { content = readFileSync(f.abs, "utf8"); } catch { continue; }
      const chunks = chunkFile(f.rel, content);
      if (!chunks.length) { delFile.run(root, f.rel); continue; }
      // The path rides inside the embedded text — file names carry strong
      // intent signal ("glyphh-agent-stream" beats bare code on "streaming").
      const vecs = await embedTexts(chunks.map((c) => `${c.path}\n${c.text}`), "document");
      if (!vecs) return; // embedder unavailable — abandon the pass quietly
      delFile.run(root, f.rel);
      chunks.forEach((c, i) => {
        ins.run(root, c.path, c.chunkNo, c.startLine, c.endLine, f.mtime, c.text, packVec(vecs[i]));
      });
      embedded += chunks.length;
    }
  } finally {
    indexing.delete(root);
  }
}

export interface WorkspaceHit { path: string; startLine: number; endLine: number; score: number; text: string }

/** Meaning-based search over the indexed root. */
export async function semanticSearchWorkspace(root: string, query: string, k = 6): Promise<WorkspaceHit[] | null> {
  let db;
  try { db = getLocalDb(); } catch { return null; }
  const q = await embedText(query, "query");
  if (!q) return null;
  const rows = db.prepare(
    "SELECT path, start_line, end_line, text, embedding FROM workspace_vectors WHERE root = ?",
  ).all(root) as Array<{ path: string; start_line: number; end_line: number; text: string; embedding: Buffer }>;
  return rows
    .map((r) => ({
      path: r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      text: r.text,
      score: dot(q, unpackVec(r.embedding)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(12, k)));
}

/** Top distinct paths for the ask — a one-line hint, not injected content. */
export async function relevantFilesHint(root: string, ask: string): Promise<string> {
  const hits = await semanticSearchWorkspace(root, ask, 8).catch(() => null);
  if (!hits) return "";
  const paths: string[] = [];
  for (const h of hits) {
    if (h.score < 0.32) continue;
    if (!paths.includes(h.path)) paths.push(h.path);
    if (paths.length >= 3) break;
  }
  return paths.length
    ? `(Semantic index suggests these files are most relevant: ${paths.join(", ")} — semantic_search(query) finds the exact spans.)`
    : "";
}

/** How many chunks the root has indexed (status surfaces). */
export function workspaceIndexSize(root: string): number {
  try {
    const db = getLocalDb();
    const r = db.prepare("SELECT COUNT(*) AS n FROM workspace_vectors WHERE root = ?").get(root) as { n: number };
    return r.n;
  } catch { return 0; }
}
