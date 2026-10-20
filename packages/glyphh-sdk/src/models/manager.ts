/**
 * models/manager.ts — the LOCAL MODEL SERVER. `ensureLocalModel(id)` gives you an
 * OpenAI-compatible endpoint for a local GGUF: it downloads the weights once (into the
 * shared `$GLYPHH_HOME/models`), starts a detached `llama-server` (one per model, singleton
 * across processes via a lock + discovery file), health-checks it, and returns its url. This
 * is the compute the user owns — free to Glyphh. Node-only; injectable download/spawn/fetch
 * so the singleton logic is testable without a real download or the llama binary.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { tryAcquireLock } from "../runtime/lock.js";
import { findLocalModel, type LocalModelSpec } from "./catalog.js";

export interface LocalModelServer {
  /** OpenAI-compatible base url, e.g. `http://127.0.0.1:52xxx`. */
  url: string;
  /** The model id (the catalog id / what to send as `model`). */
  model: string;
  pid: number;
}

type SpawnLike = (cmd: string, args: string[], opts: {
  detached: boolean; stdio: [unknown, number, number]; env: NodeJS.ProcessEnv;
}) => ChildProcess;

export interface ModelManagerOptions {
  home?: string;
  /** The `llama-server` executable (default resolves it on PATH / GLYPHH_LLAMA_BIN). */
  llamaBin?: string;
  startTimeoutMs?: number;
  /** Called to fetch the GGUF to `dest`; default streams `spec.ggufUrl`. */
  download?: (spec: LocalModelSpec, dest: string) => Promise<void>;
  spawnImpl?: SpawnLike;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Progress: 0..1 during download, then health polling. */
  onProgress?: (phase: "download" | "starting", ratio: number) => void;
}

interface Record_ { url: string; port: number; pid: number; model: string; gguf: string; startedAt: number; }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function modelsHome(opts: ModelManagerOptions): string {
  return join(opts.home ?? process.env.GLYPHH_HOME ?? join(homedir(), ".glyphh"), "models");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

async function healthy(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetchImpl(`${url}/health`, { method: "GET", signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Default download: stream the GGUF to disk. */
async function streamDownload(spec: LocalModelSpec, dest: string, fetchImpl: typeof fetch, onProgress?: ModelManagerOptions["onProgress"]): Promise<void> {
  const res = await fetchImpl(spec.ggufUrl);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const tmp = `${dest}.part`;
  const { createWriteStream } = await import("node:fs");
  const out = createWriteStream(tmp);
  let got = 0;
  try {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(value);
      got += value.byteLength;
      if (total) onProgress?.("download", got / total);
    }
  } finally {
    out.end();
  }
  const { renameSync } = await import("node:fs");
  renameSync(tmp, dest);
}

/** The machine's server for `id`, starting it (download + serve) if needed. Safe under concurrency. */
export async function ensureLocalModel(id: string, opts: ModelManagerOptions = {}): Promise<LocalModelServer> {
  const spec = findLocalModel(id);
  if (!spec) throw new Error(`unknown local model: ${id}`);
  const home = modelsHome(opts);
  mkdirSync(home, { recursive: true });
  const recPath = join(home, `${id}.json`);
  const lockDir = join(home, `${id}.lock`);
  const logPath = join(home, `${id}.log`);
  const gguf = join(home, spec.fileName);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const spawnImpl = opts.spawnImpl ?? (nodeSpawn as unknown as SpawnLike);
  const now = opts.now ?? Date.now;
  const startTimeoutMs = opts.startTimeoutMs ?? 120_000;

  const attach = async (): Promise<LocalModelServer | null> => {
    try {
      const rec = JSON.parse(readFileSync(recPath, "utf8")) as Record_;
      if (rec?.url && (await healthy(rec.url, fetchImpl))) return { url: rec.url, model: rec.model, pid: rec.pid };
    } catch {
      /* none */
    }
    return null;
  };

  const found = await attach();
  if (found) return found;

  const deadline = now() + startTimeoutMs;
  for (;;) {
    const lock = tryAcquireLock(lockDir);
    if (lock) {
      try {
        const again = await attach();
        if (again) return again;
        // Download the weights once.
        if (!existsSync(gguf)) {
          const dl = opts.download ?? ((s, d) => streamDownload(s, d, fetchImpl, opts.onProgress));
          await dl(spec, gguf);
        }
        // Serve.
        const port = await freePort();
        const url = `http://127.0.0.1:${port}`;
        const bin = opts.llamaBin ?? process.env.GLYPHH_LLAMA_BIN ?? "llama-server";
        const logFd = openSync(logPath, "a");
        let pid = 0;
        try {
          const child = spawnImpl(
            bin,
            // --jinja applies the GGUF's own chat template — required for tool calling
            // on Qwen-family models; harmless for plain chat.
            ["-m", gguf, "--host", "127.0.0.1", "--port", String(port), "-c", String(spec.contextWindow), "--jinja"],
            { detached: true, stdio: ["ignore", logFd, logFd], env: process.env },
          );
          // Missing llama-server = ASYNC 'error' (ENOENT), not a throw. Unhandled
          // it crashes the HOST app; handled, the health deadline below reports
          // "local model unavailable" like any other startup failure.
          (child as ChildProcess).on?.("error", () => { /* deadline path reports it */ });
          child.unref();
          pid = child.pid ?? 0;
        } finally {
          closeSync(logFd);
        }
        while (now() < deadline) {
          if (await healthy(url, fetchImpl)) {
            const rec: Record_ = { url, port, pid, model: id, gguf, startedAt: now() };
            writeFileSync(recPath, JSON.stringify(rec), { mode: 0o600 });
            return { url, model: id, pid };
          }
          opts.onProgress?.("starting", 1);
          await sleep(300);
        }
        if (pid) {
          try {
            process.kill(pid);
          } catch {
            /* gone */
          }
        }
        throw new Error(`${id} did not become healthy in time`);
      } finally {
        lock.release();
      }
    }
    const other = await attach();
    if (other) return other;
    if (now() >= deadline) throw new Error(`timed out waiting for ${id} to start`);
    await sleep(300);
  }
}

/** The running server for `id`, or null. */
export async function localModelStatus(id: string, opts: ModelManagerOptions = {}): Promise<LocalModelServer | null> {
  const recPath = join(modelsHome(opts), `${id}.json`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const rec = JSON.parse(readFileSync(recPath, "utf8")) as Record_;
    if (rec?.url && (await healthy(rec.url, fetchImpl))) return { url: rec.url, model: rec.model, pid: rec.pid };
  } catch {
    /* none */
  }
  return null;
}

/** Stop the local server for `id` (if any). */
export async function stopLocalModel(id: string, opts: ModelManagerOptions = {}): Promise<boolean> {
  const recPath = join(modelsHome(opts), `${id}.json`);
  let rec: Record_ | null = null;
  try {
    rec = JSON.parse(readFileSync(recPath, "utf8")) as Record_;
  } catch {
    /* none */
  }
  try {
    rmSync(recPath, { force: true });
  } catch {
    /* gone */
  }
  if (!rec?.pid) return false;
  try {
    process.kill(rec.pid);
    return true;
  } catch {
    return false;
  }
}
