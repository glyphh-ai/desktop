/**
 * glyphh-embeddings — local embedding vectors from a DEDICATED embedder.
 *
 * Chat-model embeddings were tested and are unusable for retrieval (mean
 * or last pooling, raw or centered: ≤1/4 on intent queries — anisotropy
 * swamps the signal). nomic-embed-text-v1.5 Q8 (~139MB, Apache-2.0) with
 * its task prefixes scores 4/5 on the same fixtures with wide margins, so
 * a second tiny llama-server owns embeddings on its own port:
 *
 *   chat  — llama-server :8089 (will/glyphh GGUF, unchanged)
 *   embed — llama-server :8090 (nomic, ~250MB RSS, loads in ~2s, lazy)
 *
 * The model auto-downloads to userData/models on first need. Everything
 * is free, private, on-device. Every failure path answers null and the
 * memory features degrade to silent no-ops — the loop never blocks.
 *
 * Vectors are unit-normalized, so cosine similarity is a dot product.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app } from "electron";
import { getPreference } from "./stores/preferences-db";

const EMBED_PORT = 8090;
const EMBED_MODEL_FILE = "nomic-embed-text-v1.5.Q8_0.gguf";
const EMBED_MODEL_URL =
  "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf";
const BATCH = 16;
const MAX_CHARS = 2000; // ≈500 tokens — comfortably inside the 2048 serve window

let child: ChildProcess | null = null;
let starting: Promise<boolean> | null = null;
let downloadFailed = false; // one attempt per launch — no retry storms offline

const base = () => `http://127.0.0.1:${EMBED_PORT}`;

function serverBin(): string {
  const pref = String(getPreference("glyphhServerBin", "")).trim();
  for (const c of [...(pref ? [pref] : []), "/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server"]) {
    if (existsSync(c)) return c;
  }
  return "llama-server";
}

async function modelPath(): Promise<string | null> {
  const pref = String(getPreference("glyphhEmbedModelPath", "")).trim();
  if (pref && existsSync(pref)) return pref;
  const dir = join(app.getPath("userData"), "models");
  const dest = join(dir, EMBED_MODEL_FILE);
  if (existsSync(dest)) return dest;
  if (downloadFailed) return null;
  try {
    mkdirSync(dir, { recursive: true });
    console.log(`[embeddings] downloading ${EMBED_MODEL_FILE} (~139MB)…`);
    const res = await fetch(EMBED_MODEL_URL);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const tmp = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(tmp));
    renameSync(tmp, dest);
    console.log("[embeddings] embedder model ready");
    return dest;
  } catch (err) {
    downloadFailed = true;
    console.warn(`[embeddings] model download failed (memory features off this session): ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function healthy(timeoutMs = 1200): Promise<boolean> {
  try {
    const r = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

/** Bring the embedder up (idempotent, lazy). false = unavailable for now. */
async function ensureEmbedServing(): Promise<boolean> {
  if (await healthy()) return true;
  if (starting) return starting;
  starting = (async () => {
    const model = await modelPath();
    if (!model) return false;
    try {
      const c = spawn(serverBin(), [
        "-m", model,
        "--host", "127.0.0.1", "--port", String(EMBED_PORT),
        // Non-causal encoder: batch must cover the context window.
        "-c", "2048", "-ub", "2048", "-b", "2048", "-ngl", "99",
        "--embeddings", "--pooling", "mean",
      ], { stdio: ["ignore", "ignore", "ignore"] });
      child = c;
      c.on("exit", () => { if (child === c) child = null; });
    } catch { return false; }
    for (let i = 0; i < 30; i++) {
      if (await healthy()) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  })();
  try { return await starting; } finally { starting = null; }
}

/** Kill the embedder (app quit). */
export function stopEmbedServer(): void {
  if (child) { try { child.kill(); } catch { /* already gone */ } child = null; }
}

function normalize(v: number[]): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

/** Embed texts (batched). `kind` applies nomic's trained task prefixes —
 *  queries and documents live in ONE space but enter it differently.
 *  null = embedder unavailable right now. */
export async function embedTexts(texts: string[], kind: "query" | "document"): Promise<Float32Array[] | null> {
  if (!texts.length) return [];
  if (!(await ensureEmbedServing())) return null;
  const prefix = kind === "query" ? "search_query: " : "search_document: ";
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => prefix + t.slice(0, MAX_CHARS));
    try {
      const res = await fetch(`${base()}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: batch }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const j = await res.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
      const rows = (j.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== batch.length) return null;
      for (const r of rows) out.push(normalize(r.embedding ?? []));
    } catch {
      return null;
    }
  }
  return out;
}

/** One text → one vector (or null). */
export async function embedText(text: string, kind: "query" | "document" = "query"): Promise<Float32Array | null> {
  const r = await embedTexts([text], kind);
  return r?.[0] ?? null;
}

/** Unit vectors → cosine = dot. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function packVec(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function unpackVec(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
