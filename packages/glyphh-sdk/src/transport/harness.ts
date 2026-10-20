/**
 * harness.ts — the `glyphh.harness/v1` client: run an interactive turn against a
 * hosted HARNESS SESSION POD and stream its frames durably.
 *
 *   POST /run { prompt, threadId?, mode?, … }  → { runId, sessionId, wire }
 *   frames: WS `/ws` ({type:"attach",run_id,from}) when reachable, with
 *   GET /runs/:id/frames?from=<seq> (exclusive) as the replay/reconnect path
 *   POST /runs/:id/answer resolves a parked ask/approval; POST /runs/:id/stop aborts
 *
 * DURABLE RECONNECT (the same story as transport/run.ts): the driver tracks the
 * highest `seq` delivered; on a WS drop it catches up over the frames endpoint
 * with jittered backoff and resubscribes from the cursor, deduping replays.
 *
 * WS AUTH CAVEAT: the pod authorizes the upgrade by `Authorization` header ONLY
 * — a browser `WebSocket` cannot send one, so against an auth-enabled pod the
 * WS attempt is rejected and the driver settles into polling the frames
 * endpoint (fetch carries the bearer fine). Node callers can inject a
 * header-capable factory (`ws`) via `run.webSocket` to get the live socket.
 */

import { backoffDelay, sleep, type BackoffOptions } from "./backoff.js";
import { apiErrorFor, ConnectError, ProtocolError } from "../core/errors.js";
import type { FetchLike } from "../core/http.js";
import type { TokenProvider } from "../auth/credential-provider.js";
import type { Logger } from "../core/logger.js";
import {
  HARNESS_WIRE_VERSION,
  isHarnessWireFrame,
  type HarnessAnswer,
  type HarnessPermission,
  type HarnessRunAck,
  type HarnessRunBody,
  type HarnessRunResult,
  type HarnessWireFrame,
} from "../contract/harness.js";

const DEFAULT_POLL_MS = 500;
const DEFAULT_MAX_RECONNECTS = 6;
const TAPE_CAP = 5000; // mirrors the pod's replay ring

/** The socket shape the driver needs — satisfied by the browser/Node global
 *  `WebSocket` and by `ws`. Events are wired via the `on*` properties. */
export interface HarnessWsLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
}

/** A WS factory. `headers` carries the bearer — the default (global WebSocket)
 *  CANNOT send it and only works against auth-off pods; pass a `ws`-backed
 *  factory in Node to authenticate the upgrade. */
export type HarnessWsFactory = (url: string, headers: Record<string, string>) => HarnessWsLike;

export interface HarnessRunOptions {
  /** Consecutive transport failures tolerated before the run fails (default 6). */
  maxReconnects?: number;
  backoff?: BackoffOptions;
  /** Frame-poll interval when the WS path is unavailable (default 500ms). */
  pollMs?: number;
  logger?: Logger;
  /** WS factory; defaults to the global `WebSocket` when present. Pass `null`
   *  to disable the socket path entirely (poll only). */
  webSocket?: HarnessWsFactory | null;
}

export interface HarnessClientOptions {
  /** The pod's base URL (the provisioned session's `runtimeUrl`). */
  baseUrl: string;
  /** Bearer supplier — the session's `gy_rk_` runtime token. */
  token?: TokenProvider;
  fetchImpl?: FetchLike;
  run?: HarnessRunOptions;
}

/** Everything `start()` accepts: the run body plus a client-side abort signal. */
export interface HarnessStartOptions extends HarnessRunBody {
  signal?: AbortSignal;
}

// ── The workspace FS surface (pod /fs/* — see rrotor harness/fs-routes.ts) ───
// Shapes REPLICATE the desktop wb bridge (app preload.ts / working-directory.ts)
// so the web workbench renders pod answers identically to desktop ones. On a
// SHARED pod every call names its session `scope` (the client thread/chat id);
// a dedicated pod ignores it (the token binds the workspace).

export interface HarnessFsEntry { name: string; path: string; kind: "dir" | "file" }
export interface HarnessFsSearchEntry extends HarnessFsEntry { rel: string }
export interface HarnessFsInfo { root: string; isRepo: boolean; branch?: string }
export interface HarnessFsEvent { seq: number; type: "file-changed" | "git-changed"; path?: string }
export interface HarnessFsEventsPage { seq: number; root: string; events: HarnessFsEvent[] }

function majorOf(wire: string): string {
  const m = /\/v(\d+)/.exec(wire);
  return m ? m[1]! : wire;
}

function defaultWsFactory(): HarnessWsFactory | null {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (!Ctor) return null;
  // The standard constructor takes no headers — auth-enabled pods reject the
  // upgrade and the driver falls back to polling (see module doc).
  return (url: string) => new Ctor(url) as HarnessWsLike;
}

/**
 * The handle for one harness run: subscribe to frames with `on()` (late
 * subscribers replay the retained tape first), resolve pauses with `answer()`,
 * abort with `stop()`, and await `done` for the terminal result. An `error`
 * FRAME resolves `done` (with `error` set); only transport-level failure
 * rejects it.
 */
export class HarnessRun {
  private readonly subs = new Set<(f: HarnessWireFrame) => void>();
  private readonly tape: HarnessWireFrame[] = [];
  private text = "";
  private settledFlag = false;
  private stopping = false;
  /** Aborts the driver loop (and any in-flight fetch/socket) on settle/stop. */
  readonly controller = new AbortController();

  private resolveStarted!: (ack: HarnessRunAck) => void;
  private rejectStarted!: (e: unknown) => void;
  private resolveDone!: (r: HarnessRunResult) => void;
  private rejectDone!: (e: unknown) => void;

  /** Resolves with the `POST /run` ack (runId/sessionId/wire). */
  readonly whenStarted: Promise<HarnessRunAck> = new Promise((res, rej) => {
    this.resolveStarted = res;
    this.rejectStarted = rej;
  });
  /** The terminal result. Rejects only on transport failure. */
  readonly done: Promise<HarnessRunResult> = new Promise((res, rej) => {
    this.resolveDone = res;
    this.rejectDone = rej;
  });

  constructor(private readonly ops: { answer: (run: HarnessRun, id: string, reply: HarnessAnswer) => Promise<void>; stop: (run: HarnessRun) => Promise<void>; setPermission: (run: HarnessRun, mode: HarnessPermission) => Promise<void>; inject: (run: HarnessRun, text: string) => Promise<void> }) {
    // Same safety net as transport/run.ts: a start failure rejects BOTH
    // promises; a consumer watching only one must not crash the host process.
    void this.whenStarted.catch(() => {});
    void this.done.catch(() => {});
  }

  private _runId: string | undefined;
  get runId(): string | undefined {
    return this._runId;
  }
  get settled(): boolean {
    return this.settledFlag;
  }

  /** Subscribe to frames: the retained tape replays first, then live frames.
   *  Returns the unsubscribe function. */
  on(fn: (frame: HarnessWireFrame) => void): () => void {
    for (const f of this.tape) fn(f);
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  /** Resolve a parked `approval` ({allow}) or `ask` ({answers}) frame. */
  answer(id: string, reply: HarnessAnswer): Promise<void> {
    return this.ops.answer(this, id, reply);
  }

  /** Change the permission mode of THIS in-flight run (POST /runs/:id/permission).
   *  The pod re-reads it on the next gate decision, so a plan→auto flip unblocks a
   *  running turn without waiting for the next run. A settled run no-ops. */
  setPermission(mode: HarnessPermission): Promise<void> {
    if (this.settledFlag) return Promise.resolve();
    return this.ops.setPermission(this, mode);
  }

  /** Add a USER message to THIS in-flight run (POST /runs/:id/inject). The pod
   *  queues it and the engine starts a fresh turn at the next between-turn
   *  boundary — steering the run without stopping it. Rejects (409) once the
   *  run stops taking input; a settled run no-ops. */
  inject(text: string): Promise<void> {
    if (this.settledFlag) return Promise.resolve();
    return this.ops.inject(this, text);
  }

  /** Abort the run: best-effort `POST /runs/:id/stop` (the pod frees its slot
   *  and emits done{stopped}), then resolve `done` as stopped locally. */
  async stop(): Promise<void> {
    if (this.stopping || this.settledFlag) return;
    this.stopping = true;
    try {
      await this.ops.stop(this);
    } catch {
      /* unreachable pod — the local settle below is still honest */
    }
    this.finish({ runId: this._runId ?? "", stopped: true, text: this.text });
  }

  // ── driver-internal ────────────────────────────────────────────────────────
  /** @internal */ setAck(ack: HarnessRunAck): void {
    this._runId = ack.runId;
    this.resolveStarted(ack);
  }
  /** @internal Deliver one deduped frame. Returns true when it was terminal. */
  emitFrame(frame: HarnessWireFrame): boolean {
    if (this.settledFlag) return true;
    this.tape.push(frame);
    if (this.tape.length > TAPE_CAP) this.tape.splice(0, this.tape.length - TAPE_CAP);
    if (frame.type === "delta") this.text += frame.delta;
    for (const fn of this.subs) {
      try {
        fn(frame);
      } catch {
        /* a broken subscriber never takes the run down */
      }
    }
    if (frame.type === "done") {
      this.finish({ runId: this._runId ?? frame.runId, stopped: frame.stopped, text: this.text });
      return true;
    }
    if (frame.type === "error") {
      this.finish({ runId: this._runId ?? frame.runId, stopped: false, text: this.text, error: frame.error });
      return true;
    }
    return false;
  }
  /** @internal */ finish(result: HarnessRunResult): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    this.controller.abort();
    this.resolveDone(result);
  }
  /** @internal */ fail(err: unknown): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    this.controller.abort();
    this.rejectStarted(err);
    this.rejectDone(err);
  }
}

export class HarnessClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly token: TokenProvider | undefined;
  private readonly opts: HarnessRunOptions;

  constructor(opts: HarnessClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.token = opts.token;
    this.opts = opts.run ?? {};
  }

  /** Abort a run BY ID — the cross-surface stop. A thread observed through the
   *  run-stream broker (a refreshed page, another device) holds no run handle;
   *  the stop button must still reach the executing pod. Best-effort: a run
   *  that already settled answers 4xx and that is fine. */
  async stopRun(runId: string): Promise<void> {
    await this.post(`/runs/${encodeURIComponent(runId)}/stop`, {});
  }

  /** Start a run and drive its frame stream (with durable reconnect) into the
   *  returned handle. Never throws — a start failure rejects the handle's
   *  `whenStarted` and `done`. */
  start(body: HarnessStartOptions): HarnessRun {
    const { signal, ...runBody } = body;
    const run = new HarnessRun({
      answer: async (r, id, reply) => {
        const ack = await r.whenStarted;
        await this.post(`/runs/${encodeURIComponent(ack.runId)}/answer`, { id, ...reply });
      },
      stop: async (r) => {
        const ack = await r.whenStarted;
        await this.post(`/runs/${encodeURIComponent(ack.runId)}/stop`, {});
      },
      setPermission: async (r, mode) => {
        const ack = await r.whenStarted;
        await this.post(`/runs/${encodeURIComponent(ack.runId)}/permission`, { permission: mode });
      },
      inject: async (r, text) => {
        const ack = await r.whenStarted;
        await this.post(`/runs/${encodeURIComponent(ack.runId)}/inject`, { text });
      },
    });
    if (signal?.aborted) void run.stop();
    else signal?.addEventListener("abort", () => void run.stop(), { once: true });
    void this.drive(run, runBody);
    return run;
  }

  // ── the driver ─────────────────────────────────────────────────────────────

  private async drive(run: HarnessRun, body: HarnessRunBody): Promise<void> {
    const log = this.opts.logger;
    let ack: HarnessRunAck;
    try {
      ack = (await this.post("/run", body, run.controller.signal)) as HarnessRunAck;
    } catch (err) {
      run.fail(err);
      return;
    }
    if (majorOf(ack.wire ?? "") !== majorOf(HARNESS_WIRE_VERSION)) {
      run.fail(new ProtocolError(`unsupported harness wire: ${ack.wire} (need ${HARNESS_WIRE_VERSION})`));
      return;
    }
    run.setAck(ack);

    const maxReconnects = this.opts.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
    const pollMs = this.opts.pollMs ?? DEFAULT_POLL_MS;
    let lastSeq = -1;
    let attempt = 0;
    const deliver = (frame: HarnessWireFrame): boolean => {
      if (frame.seq <= lastSeq) return run.settled; // dedupe replays
      lastSeq = frame.seq;
      attempt = 0; // progress resets the reconnect budget
      return run.emitFrame(frame);
    };

    // The socket path: default global WebSocket, injectable, or off (null).
    let wsFactory = this.opts.webSocket === undefined ? defaultWsFactory() : this.opts.webSocket;

    while (!run.settled) {
      if (wsFactory) {
        const seqBefore = lastSeq;
        const outcome = await this.wsAttach(wsFactory, ack.runId, () => lastSeq, deliver, run.controller.signal);
        if (run.settled) return;
        if (outcome === "unavailable") {
          // No socket to be had here (auth-gated upgrade, no ctor) — poll from now on.
          log?.info("harness ws unavailable; polling frames", { run_id: ack.runId });
          wsFactory = null;
        } else if (lastSeq === seqBefore) {
          // A drop that delivered nothing burns a reconnect attempt — a flapping
          // socket must not hot-loop against the pod.
          attempt++;
          if (attempt > maxReconnects) {
            run.fail(new ConnectError(`harness reconnect exhausted after ${attempt} attempts`));
            return;
          }
          log?.warn("harness ws dropped; catching up over frames", { attempt });
          await sleep(backoffDelay(attempt, this.opts.backoff), run.controller.signal);
        }
        // A drop falls through: catch up over the frames endpoint, then retry.
      }
      try {
        const page = (await this.get(`/runs/${encodeURIComponent(ack.runId)}/frames?from=${lastSeq}`, run.controller.signal)) as { frames?: HarnessWireFrame[] };
        for (const f of page.frames ?? []) {
          if (isHarnessWireFrame(f) && deliver(f)) return;
        }
        if (run.settled) return;
        if (!wsFactory) await sleep(pollMs, run.controller.signal);
      } catch (err) {
        if (run.settled) return;
        attempt++;
        if (attempt > maxReconnects) {
          run.fail(new ConnectError(`harness reconnect exhausted after ${attempt} attempts`, err));
          return;
        }
        log?.warn("harness frame fetch failed; will retry", { attempt });
        await sleep(backoffDelay(attempt, this.opts.backoff), run.controller.signal);
      }
    }
  }

  /** One WS attachment: replay past the cursor, then live frames. Resolves
   *  "terminal" when the run finished on this socket, "drop" on a mid-stream
   *  loss (catch up + resubscribe), "unavailable" when no socket could open
   *  (fall back to polling for the rest of the run). */
  private wsAttach(
    factory: HarnessWsFactory,
    runId: string,
    cursor: () => number,
    deliver: (f: HarnessWireFrame) => boolean,
    signal: AbortSignal,
  ): Promise<"terminal" | "drop" | "unavailable"> {
    return new Promise((resolve) => {
      void (async (): Promise<void> => {
        const bearer = this.token ? await this.token() : "";
        const headers: Record<string, string> = {};
        if (bearer) headers["authorization"] = `Bearer ${bearer}`;
        // A BROWSER cannot set WS headers, so the pod also accepts `?token=`
        // (same introspection gate). Without this every browser client failed
        // the upgrade — "HTTP Authentication failed" — and silently degraded
        // to frame POLLING, so web turns arrived in ~1.5s lumps instead of
        // streaming. Header-capable callers (node, the desktop) keep using it.
        const wsBase = `${this.baseUrl.replace(/^http/i, "ws")}/ws`;
        const browser = typeof (globalThis as { document?: unknown }).document !== "undefined";
        const wsUrl = browser && bearer ? `${wsBase}?token=${encodeURIComponent(bearer)}` : wsBase;
        let ws: HarnessWsLike;
        try {
          ws = factory(wsUrl, headers);
        } catch {
          resolve("unavailable");
          return;
        }
        let settled = false;
        let opened = false;
        const finish = (r: "terminal" | "drop" | "unavailable"): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          try {
            ws.close();
          } catch {
            /* already gone */
          }
          resolve(r);
        };
        const onAbort = (): void => finish("drop");
        signal.addEventListener("abort", onAbort, { once: true });
        ws.onopen = (): void => {
          opened = true;
          try {
            ws.send(JSON.stringify({ type: "attach", run_id: runId, from: cursor() }));
          } catch {
            finish("drop");
          }
        };
        ws.onmessage = (ev): void => {
          let msg: unknown;
          try {
            msg = JSON.parse(String(ev.data));
          } catch {
            return; // not ours
          }
          if (isHarnessWireFrame(msg)) {
            if (deliver(msg)) finish("terminal");
            return;
          }
          const control = msg as { type?: string };
          if (control?.type === "error") finish("drop"); // e.g. run evicted server-side
          // ready/pong: ignore
        };
        ws.onerror = (): void => finish(opened ? "drop" : "unavailable");
        ws.onclose = (): void => finish(opened ? "drop" : "unavailable");
      })();
    });
  }

  // ── the workspace FS surface (pod /fs/*) ───────────────────────────────────
  // Thin typed calls over the pod's fs routes; fs-level failures ride IN the
  // returned shape (the pod replicates the desktop's error shapes), so only
  // transport/auth/param failures reject.

  /** The session workspace's root + git identity. */
  fsInfo(opts: { scope?: string } = {}): Promise<HarnessFsInfo> {
    return this.post("/fs/info", opts) as Promise<HarnessFsInfo>;
  }

  /** Immediate children of `dir` (defaults to the workspace root). */
  fsList(opts: { dir?: string; scope?: string } = {}): Promise<{ entries: HarnessFsEntry[]; error?: string }> {
    return this.post("/fs/list", opts) as Promise<{ entries: HarnessFsEntry[]; error?: string }>;
  }

  /** Read a workspace text file (pod-side 1MB cap, desktop-identical error). */
  fsRead(opts: { path: string; scope?: string }): Promise<{ content: string; error?: string }> {
    return this.post("/fs/read", opts) as Promise<{ content: string; error?: string }>;
  }

  /** Write a workspace text file, creating parents (pod-side 2MB cap). */
  fsWrite(opts: { path: string; content: string; scope?: string }): Promise<{ ok: boolean; error?: string }> {
    return this.post("/fs/write", opts) as Promise<{ ok: boolean; error?: string }>;
  }

  /** Unified working-tree diff (staged + unstaged + untracked). */
  fsDiff(opts: { scope?: string } = {}): Promise<{ text: string; error?: string }> {
    return this.post("/fs/diff", opts) as Promise<{ text: string; error?: string }>;
  }

  /** Recursive name search under the workspace root. */
  fsSearch(opts: { query: string; scope?: string }): Promise<{ entries: HarnessFsSearchEntry[]; truncated?: boolean; error?: string }> {
    return this.post("/fs/search", opts) as Promise<{ entries: HarnessFsSearchEntry[]; truncated?: boolean; error?: string }>;
  }

  /** Cursor-poll workspace change events. `from < 0` (or absent) establishes
   *  the cursor without a backlog; poll again with the returned `seq`. */
  fsEvents(opts: { from?: number; scope?: string } = {}): Promise<HarnessFsEventsPage> {
    const qs = new URLSearchParams();
    if (opts.from !== undefined) qs.set("from", String(opts.from));
    if (opts.scope) qs.set("scope", opts.scope);
    const q = qs.toString();
    return this.get(`/fs/events${q ? `?${q}` : ""}`) as Promise<HarnessFsEventsPage>;
  }

  /** The caller's existing pod workspaces (spaces) — newest first. */
  fsSpaces(): Promise<{ spaces: Array<{ id: string; updatedAt: number; top: string[] }> }> {
    return this.get("/fs/spaces") as Promise<{ spaces: Array<{ id: string; updatedAt: number; top: string[] }> }>;
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request("POST", path, body, signal);
  }
  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", path, undefined, signal);
  }

  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers["authorization"] = `Bearer ${await this.token()}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new ConnectError(`harness ${method} ${path} failed`, err);
    }
    if (!res.ok) throw await this.toError(res);
    return res.json().catch(() => ({}));
  }

  private async toError(res: Response): Promise<Error> {
    const text = await res.text().catch(() => "");
    let code = "E_INTERNAL";
    let message = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text) as { error?: string; detail?: string };
      code = j.error ?? code;
      message = j.detail ?? message;
    } catch {
      /* non-JSON body */
    }
    return apiErrorFor({ code, message, httpStatus: res.status });
  }
}
