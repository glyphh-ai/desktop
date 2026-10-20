/**
 * Harness transport unit tests — deterministic, with a fake fetch (and a fake
 * WS) speaking `glyphh.harness/v1`. Proves start→frames→done ordering, the
 * durable reconnect (poll retry from the cursor, no gap, no duplicate seq),
 * the WS→poll fallback, answer/stop plumbing, and wire-version rejection.
 */

import { describe, it, expect } from "vitest";
import { HarnessClient, type HarnessWsLike } from "../../src/transport/harness.js";
import { HARNESS_WIRE_VERSION, type HarnessFrame, type HarnessWireFrame } from "../../src/contract/harness.js";
import { ApiError, ConnectError, ProtocolError } from "../../src/core/errors.js";
import type { FetchLike } from "../../src/core/http.js";

const RUN_ID = "run-h1";

function tape(frames: HarnessFrame[]): HarnessWireFrame[] {
  return frames.map((f, i) => ({ ...f, seq: i, runId: RUN_ID, at: 1000 + i }));
}

function baseTape(): HarnessWireFrame[] {
  return tape([
    { type: "tool", phase: "start", name: "Read" },
    { type: "delta", delta: "hi " },
    { type: "delta", delta: "there" },
    { type: "tool", phase: "done", name: "Read", title: "read a file" },
    { type: "done", stopped: false },
  ]);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ack = { runId: RUN_ID, sessionId: "sess_1", wire: HARNESS_WIRE_VERSION };

/** A fetch that acks /run and serves the frame tape past ?from= (exclusive). */
function podFetch(frames: HarnessWireFrame[], hooks: { onRun?: (body: unknown) => void; failFramesTimes?: number; posts?: Array<{ path: string; body: unknown }> } = {}): FetchLike {
  let framesFailures = hooks.failFramesTimes ?? 0;
  return async (url, init) => {
    const u = String(url);
    const path = u.replace(/^https?:\/\/[^/]+/, "");
    if (path === "/run") {
      hooks.onRun?.(JSON.parse(String(init?.body ?? "{}")));
      return json(200, ack);
    }
    if (/\/frames\?from=/.test(path)) {
      if (framesFailures > 0) {
        framesFailures--;
        throw new Error("boom");
      }
      const from = Number(/from=(-?\d+)/.exec(path)![1]);
      return json(200, { runId: RUN_ID, status: "running", frames: frames.filter((f) => f.seq > from) });
    }
    if (/\/(answer|stop)$/.test(path)) {
      hooks.posts?.push({ path, body: init?.body ? JSON.parse(String(init.body)) : {} });
      return json(200, { ok: true });
    }
    throw new Error(`unexpected ${path}`);
  };
}

const client = (fetchImpl: FetchLike, run: object = {}): HarnessClient =>
  new HarnessClient({ baseUrl: "http://pod", fetchImpl, run: { webSocket: null, pollMs: 0, backoff: { baseMs: 0, capMs: 0 }, ...run } });

describe("harness client (poll path)", () => {
  it("starts a run, streams frames in order, resolves done with the full text", async () => {
    let runBody: unknown;
    const pod = client(podFetch(baseTape(), { onRun: (b) => (runBody = b) }));
    const run = pod.start({ prompt: "hello", threadId: "cthread1", mode: "chat" });

    const seen: HarnessWireFrame[] = [];
    run.on((f) => seen.push(f));

    expect(await run.whenStarted).toMatchObject({ runId: RUN_ID, wire: HARNESS_WIRE_VERSION });
    const result = await run.done;
    expect(result).toEqual({ runId: RUN_ID, stopped: false, text: "hi there" });
    expect(seen.map((f) => f.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(runBody).toMatchObject({ prompt: "hello", threadId: "cthread1", mode: "chat" });
  });

  it("late subscribers replay the retained tape first", async () => {
    const pod = client(podFetch(baseTape()));
    const run = pod.start({ prompt: "hello" });
    await run.done;
    const seen: number[] = [];
    run.on((f) => seen.push(f.seq));
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it("durably reconnects: a failed frames poll retries from the cursor — no gap, no dup", async () => {
    const pod = client(podFetch(baseTape(), { failFramesTimes: 2 }));
    const run = pod.start({ prompt: "hello" });
    const seqs: number[] = [];
    run.on((f) => seqs.push(f.seq));
    expect((await run.done).text).toBe("hi there");
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
  });

  it("fails the run when reconnects are exhausted", async () => {
    const pod = client(podFetch(baseTape(), { failFramesTimes: 99 }), { maxReconnects: 2 });
    const run = pod.start({ prompt: "hello" });
    await expect(run.done).rejects.toBeInstanceOf(ConnectError);
  });

  it("an error FRAME resolves done (with error set) — the transport did its job", async () => {
    const frames = tape([{ type: "delta", delta: "partial" }, { type: "error", error: "no model catalog" }]);
    const run = client(podFetch(frames)).start({ prompt: "hello" });
    expect(await run.done).toEqual({ runId: RUN_ID, stopped: false, text: "partial", error: "no model catalog" });
  });

  it("rejects an unsupported wire version with ProtocolError", async () => {
    const fetchImpl: FetchLike = async () => json(200, { ...ack, wire: "glyphh.harness/v2" });
    await expect(client(fetchImpl).start({ prompt: "x" }).done).rejects.toBeInstanceOf(ProtocolError);
  });

  it("surfaces a 409 at-capacity start as a rejection", async () => {
    const fetchImpl: FetchLike = async () => json(409, { error: "at-capacity", detail: "pod full" });
    const run = client(fetchImpl).start({ prompt: "x" });
    await expect(run.done).rejects.toBeInstanceOf(ApiError);
    await expect(run.whenStarted).rejects.toMatchObject({ code: "at-capacity" });
  });

  it("answer() posts the ask/approval reply to the run", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const pod = client(podFetch(baseTape(), { posts }));
    const run = pod.start({ prompt: "hello" });
    await run.answer("ask-1", { answers: ["yes"] });
    expect(posts).toEqual([{ path: `/runs/${RUN_ID}/answer`, body: { id: "ask-1", answers: ["yes"] } }]);
    await run.done;
  });

  it("stop() posts stop and resolves done as stopped", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    // A tape that never terminates — only stop() can settle it.
    const pod = client(podFetch(tape([{ type: "delta", delta: "spin" }]), { posts }), { pollMs: 1 });
    const run = pod.start({ prompt: "hello" });
    await run.whenStarted;
    await run.stop();
    expect(posts).toEqual([{ path: `/runs/${RUN_ID}/stop`, body: {} }]);
    expect(await run.done).toMatchObject({ stopped: true, text: "spin" });
  });

  it("an aborted signal stops the run", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const pod = client(podFetch(tape([{ type: "delta", delta: "x" }]), { posts }), { pollMs: 1 });
    const ac = new AbortController();
    const run = pod.start({ prompt: "hello", signal: ac.signal });
    await run.whenStarted;
    ac.abort();
    expect(await run.done).toMatchObject({ stopped: true });
    expect(posts.some((p) => p.path.endsWith("/stop"))).toBe(true);
  });

  it("sends the runtime bearer on every pod call", async () => {
    const auths: string[] = [];
    const inner = podFetch(baseTape());
    const fetchImpl: FetchLike = async (url, init) => {
      auths.push(String((init?.headers as Record<string, string>)?.authorization ?? ""));
      return inner(url, init);
    };
    const pod = new HarnessClient({ baseUrl: "http://pod", fetchImpl, token: async () => "gy_rk_test", run: { webSocket: null, pollMs: 0 } });
    await pod.start({ prompt: "hello" }).done;
    expect(auths.every((a) => a === "Bearer gy_rk_test")).toBe(true);
  });
});

// ── the WS path ──────────────────────────────────────────────────────────────

/** A scriptable fake socket: `script(ws)` runs after the attach message. */
class FakeWs implements HarnessWsLike {
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  constructor(private readonly script: (ws: FakeWs) => void) {
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
    queueMicrotask(() => this.script(this));
  }
  close(): void {
    this.closed = true;
  }
  deliver(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

describe("harness client (ws path)", () => {
  it("attaches over WS from the cursor and streams to done", async () => {
    const frames = baseTape();
    let attach: unknown;
    const factory = (): FakeWs =>
      new FakeWs((ws) => {
        attach = ws.sent[0];
        ws.deliver({ type: "ready", wire: HARNESS_WIRE_VERSION });
        for (const f of frames) ws.deliver(f);
      });
    const fetchImpl = podFetch(frames);
    const pod = new HarnessClient({ baseUrl: "http://pod", fetchImpl, run: { webSocket: factory, backoff: { baseMs: 0, capMs: 0 } } });
    const run = pod.start({ prompt: "hello" });
    const seqs: number[] = [];
    run.on((f) => seqs.push(f.seq));
    expect((await run.done).text).toBe("hi there");
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
    expect(attach).toEqual({ type: "attach", run_id: RUN_ID, from: -1 });
  });

  it("a WS drop mid-run catches up over the frames endpoint — no gap, no dup", async () => {
    const frames = baseTape();
    let sockets = 0;
    const factory = (): FakeWs => {
      sockets++;
      return new FakeWs((ws) => {
        // First socket: two frames then a hard drop. Later sockets: drop at once.
        if (sockets === 1) {
          ws.deliver(frames[0]);
          ws.deliver(frames[1]);
        }
        ws.onclose?.();
      });
    };
    const pod = new HarnessClient({ baseUrl: "http://pod", fetchImpl: podFetch(frames), run: { webSocket: factory, backoff: { baseMs: 0, capMs: 0 } } });
    const run = pod.start({ prompt: "hello" });
    const seqs: number[] = [];
    run.on((f) => seqs.push(f.seq));
    expect((await run.done).text).toBe("hi there");
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
  });

  it("an auth-rejected socket (never opens) falls back to polling for the run", async () => {
    let tried = 0;
    const factory = (): HarnessWsLike => {
      tried++;
      const ws: HarnessWsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onerror: null, onclose: null };
      queueMicrotask(() => ws.onerror?.()); // rejected upgrade — never opened
      return ws;
    };
    const pod = new HarnessClient({ baseUrl: "http://pod", fetchImpl: podFetch(baseTape()), run: { webSocket: factory, pollMs: 0 } });
    expect((await pod.start({ prompt: "hello" }).done).text).toBe("hi there");
    expect(tried).toBe(1); // unavailable is permanent for the run — no WS hammering
  });
});
