/**
 * run-stream.ts — the CONSUMER side of the run-stream broker. A surface opening a
 * thread asks for its active run, then subscribes to that run's durable frame stream
 * (replay from a cursor, then follow live). This is what makes "open a thread anywhere,
 * see the live turn" work — regardless of where the run executes (pod or desktop).
 *
 *   activeRun(threadId) → runId | null           (GET /api/threads/:id/active-run)
 *   subscribe(runId)    → { on, done, stop }      (POST /api/run-stream/:runId, SSE)
 *
 * The handle mirrors the harness/relay run handle (`on`/`done`/`stop`) so callers
 * render attached frames with the exact same code they render a live turn with.
 */

import type { AuthedHttp } from "../core/authed-http.js";

export type RunStreamFrame = { type: string; [k: string]: unknown };

export interface RunStreamHandle {
  on(cb: (frame: RunStreamFrame) => void): () => void;
  /** Resolves when the run settles (terminal frame) or the stream ends. */
  readonly done: Promise<void>;
  /** Last Redis stream id delivered — the cursor to resume from after a drop. */
  lastId(): string;
  /** True once a terminal (done/error) frame arrived — distinguishes a genuine end
   *  from a dropped/half-open socket (which must be reconnected, not treated as done). */
  endedTerminal(): boolean;
  stop(): void;
}

export class RunStreamClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The thread's currently-active run id, or null when nothing is running. */
  async activeRun(threadId: string): Promise<string | null> {
    const r = await this.http.get<{ runId: string | null }>(
      `/api/threads/${encodeURIComponent(threadId)}/active-run`,
    );
    return r?.runId ?? null;
  }

  /**
   * THE consumer entry every surface calls: "open this thread and stream whatever is
   * running on it, wherever it runs." Resolves the thread's active run, then tails its
   * frame stream (replay + follow). Returns immediately with a handle; `whenAttached`
   * resolves the runId (or null if nothing is running). Topology-blind by construction —
   * desktop-produced and cloud-produced runs read back identically. No surface should
   * reimplement activeRun+subscribe; they all use this.
   */
  attach(threadId: string, opts: { from?: string } = {}): {
    on(cb: (frame: RunStreamFrame) => void): () => void;
    onRun(cb: (runId: string) => void): () => void;
    stop(): void;
  } {
    const frameCbs = new Set<(f: RunStreamFrame) => void>();
    const runCbs = new Set<(runId: string) => void>();
    let stopped = false;
    let curSub: RunStreamHandle | null = null;
    const POLL_MS = 1500;
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    // Runs whose terminal frame we've already streamed — so we don't re-attach a finished
    // run in the window before the server clears its active-run mapping.
    const finished = new Set<string>();

    void (async () => {
      while (!stopped) {
        let runId: string | null = null;
        try { runId = await this.activeRun(threadId); } catch { runId = null; }
        if (stopped) break;
        // Nothing running (or a run we already streamed) — keep WATCHING, don't stop. THIS
        // is the fix for "opened the thread before the run started": we poll for the next
        // run instead of checking active-run exactly once and giving up.
        if (!runId || finished.has(runId)) { await sleep(POLL_MS); continue; }

        for (const cb of runCbs) cb(runId); // a new run appeared — let the surface reset its per-turn state
        // Stream it, resuming across dropped sockets, until it settles.
        let cursor = opts.from ?? "0";
        let drops = 0;
        let terminal = false;
        while (!stopped && !terminal) {
          curSub = this.subscribe(runId, { from: cursor });
          curSub.on((f) => { for (const cb of frameCbs) cb(f); });
          await curSub.done;
          if (stopped) break;
          const seen = curSub.lastId(); if (seen) cursor = seen;
          if (curSub.endedTerminal()) { terminal = true; break; } // the run actually settled
          drops += 1;
          if (drops > 120) break;           // sustained failure — stop resuming THIS run, poll for the next
          await sleep(Math.min(400 * drops, 3000));
        }
        finished.add(runId);
        if (!stopped) await sleep(300); // brief gap, then watch for the next run on this thread
      }
    })();

    return {
      on: (cb) => { frameCbs.add(cb); return () => { frameCbs.delete(cb); }; },
      onRun: (cb) => { runCbs.add(cb); return () => { runCbs.delete(cb); }; },
      stop: () => { stopped = true; try { curSub?.stop(); } catch { /* already gone */ } },
    };
  }

  /** Subscribe to a run's frame stream: replay from `from` (default "0" = the whole
   *  tape) then follow live until the run settles or `stop()`. Low-level — most callers
   *  want `attach(threadId)`, which resolves the active run for you. */
  subscribe(runId: string, opts: { from?: string } = {}): RunStreamHandle {
    const listeners = new Set<(f: RunStreamFrame) => void>();
    const ctrl = new AbortController();
    let done = false;
    let lastId = opts.from ?? "0";
    let terminal = false;
    let settle: () => void = () => {};
    const donePromise = new Promise<void>((res) => { settle = res; });
    const finish = (): void => { if (done) return; done = true; settle(); };

    const pump = async (): Promise<void> => {
      let resp: Response;
      try {
        resp = await this.http.stream(
          `/api/run-stream/${encodeURIComponent(runId)}`,
          { from: opts.from ?? "0" },
          { headers: { Accept: "text/event-stream" }, signal: ctrl.signal },
        );
      } catch { finish(); return; }
      if (!resp.ok || !resp.body) { finish(); return; }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data:")) continue; // skip ": ok" comments
              const j = line.slice(5).trim();
              if (!j) continue;
              try {
                const env = JSON.parse(j) as { id?: string; frame?: RunStreamFrame };
                if (typeof env.id === "string" && env.id) lastId = env.id; // reconnect cursor
                const frame = env.frame;
                if (frame && typeof frame === "object" && typeof frame.type === "string") {
                  for (const cb of listeners) cb(frame);
                  if (frame.type === "done" || frame.type === "error") { terminal = true; finish(); return; }
                }
              } catch { /* skip a malformed line */ }
            }
          }
        }
      } catch { /* stream error → settle below */ }
      finish();
    };
    void pump();

    return {
      on: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      done: donePromise,
      lastId: () => lastId,
      endedTerminal: () => terminal,
      stop: () => { try { ctrl.abort(); } catch { /* already gone */ } finish(); },
    };
  }
}
