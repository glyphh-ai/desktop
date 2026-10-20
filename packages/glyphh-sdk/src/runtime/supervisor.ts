/**
 * runtime/supervisor.ts — the ONE local runtime per machine. `ensureLocalRuntime()` is
 * idempotent and atomic across processes: the first client that needs the runtime spawns
 * it (detached, so it outlives that client), every other client attaches to the same one.
 * Node-only (child_process/net/fs) — imported by the CLI + the desktop's main process,
 * NOT the browser/RN bundles. The control plane is not in this path; it still does auth +
 * metering via introspection, but the runtime PROCESS is owned locally.
 *
 * Shape:
 *   1. read ~/.glyphh/runtime.json → health-check → attach (the common case)
 *   2. else take the mkdir lock (breaking a dead holder), double-check, then spawn
 *      `rrotor serve -p <freeport>` detached, poll health, write the discovery record.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readRecord, writeRecord, clearRecord, type RuntimeRecord } from "./discovery.js";
import { tryAcquireLock } from "./lock.js";

/** Bump on a breaking change to the discovery record or spawn contract. */
const SUPERVISOR_VERSION = "1";

export interface LocalRuntime {
  /** Where to open the data-plane stream, e.g. `http://127.0.0.1:53017`. */
  url: string;
  /** Loopback token (present for forward-compat; today's NoAuth runtime ignores it). */
  token: string;
  /** The runtime process id. */
  pid: number;
}

type SpawnLike = (
  cmd: string,
  args: string[],
  opts: { detached: boolean; stdio: [unknown, number, number]; env: NodeJS.ProcessEnv },
) => ChildProcess;

export interface EnsureRuntimeOptions {
  /** State dir (default `$GLYPHH_HOME` or `~/.glyphh`). */
  home?: string;
  /** The `rrotor` executable (default resolves `rrotor` on PATH). */
  bin?: string;
  /** Args inserted BEFORE `serve` — e.g. a script path when `bin` is `node`
   *  (the dev launch of a repo-built entry). */
  preArgs?: string[];
  /** Extra args appended after `serve -p <port>`. */
  args?: string[];
  /** Extra environment for the spawned runtime (e.g. `ROTOR_MODE=harness`).
   *  Merged over the inherited process env; only applies on spawn — attaching
   *  to an already-running runtime never re-shapes its env. */
  env?: Record<string, string | undefined>;
  /** How long to wait for the runtime to come up (default 15s). */
  startTimeoutMs?: number;
  // ── test seams ──────────────────────────────────────────────────────────────
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnLike;
  now?: () => number;
}

interface Ctx {
  home: string;
  recPath: string;
  lockDir: string;
  logPath: string;
  bin: string;
  preArgs: string[];
  args: string[];
  env: Record<string, string | undefined>;
  startTimeoutMs: number;
  fetchImpl: typeof fetch;
  spawnImpl: SpawnLike;
  now: () => number;
}

function defaultHome(): string {
  return process.env.GLYPHH_HOME ?? join(homedir(), ".glyphh");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function isHealthy(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetchImpl(`${url}/healthz`, { method: "GET", signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Return the recorded runtime if it's up, else null. */
async function attachIfHealthy(ctx: Ctx): Promise<LocalRuntime | null> {
  const rec = readRecord(ctx.recPath);
  if (rec && (await isHealthy(rec.url, ctx.fetchImpl))) {
    return { url: rec.url, token: rec.token, pid: rec.pid };
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not allocate a port"))));
    });
  });
}

async function startRuntime(ctx: Ctx): Promise<LocalRuntime> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const token = randomBytes(24).toString("hex");

  const logFd = openSync(ctx.logPath, "a");
  try {
    const child = ctx.spawnImpl(ctx.bin, [...ctx.preArgs, "serve", "-p", String(port), ...ctx.args], {
      detached: true, // own process group → outlives this client
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, ...ctx.env, PORT: String(port) },
    });
    // A missing binary surfaces as an ASYNC 'error' (ENOENT), not a throw —
    // unhandled it is an uncaught exception that crashes the HOST app (the
    // Windows desktop died this way). The health-check loop below already
    // handles "never came up"; the handler just keeps the failure contained.
    child.on?.("error", () => { /* health deadline below reports the failure */ });
    child.unref();
    const pid = child.pid ?? 0;

    const deadline = ctx.now() + ctx.startTimeoutMs;
    while (ctx.now() < deadline) {
      if (await isHealthy(url, ctx.fetchImpl)) {
        const rec: RuntimeRecord = { url, port, pid, token, version: SUPERVISOR_VERSION, startedAt: ctx.now() };
        writeRecord(ctx.recPath, rec);
        return { url, token, pid };
      }
      await sleep(150);
    }
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    throw new Error("the local runtime did not become healthy in time");
  } finally {
    closeSync(logFd);
  }
}

function context(opts: EnsureRuntimeOptions): Ctx {
  const home = opts.home ?? defaultHome();
  return {
    home,
    recPath: join(home, "runtime.json"),
    lockDir: join(home, "runtime.lock"),
    logPath: join(home, "runtime.log"),
    bin: opts.bin ?? process.env.GLYPHH_ROTOR_BIN ?? "rrotor",
    preArgs: opts.preArgs ?? [],
    args: opts.args ?? [],
    env: opts.env ?? {},
    startTimeoutMs: opts.startTimeoutMs ?? 15_000,
    fetchImpl: opts.fetchImpl ?? fetch,
    spawnImpl: opts.spawnImpl ?? (nodeSpawn as unknown as SpawnLike),
    now: opts.now ?? Date.now,
  };
}

/**
 * Return the machine's one local runtime, starting it (once, atomically) if needed.
 * Safe to call concurrently from multiple processes.
 */
export async function ensureLocalRuntime(opts: EnsureRuntimeOptions = {}): Promise<LocalRuntime> {
  const ctx = context(opts);
  mkdirSync(ctx.home, { recursive: true });

  const found = await attachIfHealthy(ctx);
  if (found) return found;

  const deadline = ctx.now() + ctx.startTimeoutMs;
  for (;;) {
    const lock = tryAcquireLock(ctx.lockDir);
    if (lock) {
      try {
        const again = await attachIfHealthy(ctx); // someone may have won while we contended
        return again ?? (await startRuntime(ctx));
      } finally {
        lock.release();
      }
    }
    // Another process holds the lock (starting the runtime) — wait for its record.
    const other = await attachIfHealthy(ctx);
    if (other) return other;
    if (ctx.now() >= deadline) throw new Error("timed out waiting for the local runtime to start");
    await sleep(150);
  }
}

/** The current local runtime, or null if none is running. */
export async function localRuntimeStatus(opts: EnsureRuntimeOptions = {}): Promise<LocalRuntime | null> {
  return attachIfHealthy(context(opts));
}

/** Stop the local runtime (if any) and clear its record. */
export async function stopLocalRuntime(opts: EnsureRuntimeOptions = {}): Promise<boolean> {
  const ctx = context(opts);
  const rec = readRecord(ctx.recPath);
  clearRecord(ctx.recPath);
  if (!rec?.pid) return false;
  try {
    process.kill(rec.pid);
    return true;
  } catch {
    return false; // already gone
  }
}
