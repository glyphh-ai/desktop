/**
 * Transport unit tests — deterministic, with a fake fetch that emits SSE. Proves
 * turn streaming order, the headline durable-reconnect (drop mid-run → attach from
 * cursor → no gap, no duplicate seq), and wire-version rejection.
 */

import { describe, it, expect } from "vitest";
import { SseTransport } from "../../src/transport/sse-transport.js";
import { driveTurn } from "../../src/transport/run.js";
import { isWireEvent, type TurnEvent, type WireEvent } from "../../src/protocol/events.js";
import { ProtocolError } from "../../src/core/errors.js";
import type { FetchLike } from "../../src/core/http.js";

function baseSeq(wire = "rotor.stream/v1"): WireEvent[] {
  return [
    { seq: 0, kind: "open", wire, run_id: "run-123", trace_id: "t", rotor: "base@0.1.0" },
    { seq: 1, kind: "step", step_id: "ask", type: "ask", status: "ok", frames: [], tick: 1 },
    { seq: 2, kind: "step", step_id: "plan", type: "plan", status: "ok", frames: [], tick: 2 },
    { seq: 3, kind: "step", step_id: "execute", type: "execute", status: "ok", frames: [], tick: 3 },
    { seq: 4, kind: "answer", text: "hi" },
    { seq: 5, kind: "done", status: "ok", terminal: "end", outputs: { answer: "hi" } },
  ];
}

function sseResponse(events: WireEvent[], truncateAfter?: number): Response {
  const enc = new TextEncoder();
  const frames = [": rotor.stream/v1\n\n"];
  for (const ev of events.slice(0, truncateAfter)) frames.push(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe("SSE transport + run driver", () => {
  it("streams a turn in order to done, resolving runId + result", async () => {
    const events = baseSeq();
    const fetchImpl: FetchLike = async () => sseResponse(events);
    const run = driveTurn(new SseTransport({ baseUrl: "http://rt", fetchImpl }), { rotor: "base" });

    const evs = await collect(run.events);
    expect(evs.filter(isWireEvent).map((e) => e.kind)).toEqual(["open", "step", "step", "step", "answer", "done"]);
    expect(await run.whenRunId).toBe("run-123");
    expect(await run.done).toMatchObject({ runId: "run-123", status: "ok", terminal: "end" });
  });

  it("durably reconnects: drop mid-run → attach from cursor → no gap, no dup", async () => {
    const events = baseSeq();
    let runCalls = 0;
    // POST /run drops after 3 frames (open, step, step); GET …/events replays the full tape.
    const fetchImpl: FetchLike = async (url) => {
      const u = String(url);
      if (u.endsWith("/run")) {
        runCalls++;
        return sseResponse(events, 3); // truncated → stream closes without `done`
      }
      if (u.includes("/events")) return sseResponse(events); // full replay; driver dedupes seq<=cursor
      throw new Error(`unexpected ${u}`);
    };
    const run = driveTurn(new SseTransport({ baseUrl: "http://rt", fetchImpl }), { rotor: "base" }, { backoff: { baseMs: 0, capMs: 0 } });

    const evs = await collect(run.events);
    const wire = evs.filter(isWireEvent);
    expect(wire.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]); // every seq exactly once, in order
    expect(evs.some((e) => e.kind === "reconnecting")).toBe(true);
    expect(evs.some((e) => e.kind === "reconnected")).toBe(true);
    expect(runCalls).toBe(1);
    expect((await run.done).status).toBe("ok");
  });

  it("rejects an unsupported wire major version with ProtocolError", async () => {
    const fetchImpl: FetchLike = async () => sseResponse(baseSeq("rotor.stream/v2"));
    const run = driveTurn(new SseTransport({ baseUrl: "http://rt", fetchImpl }), { rotor: "base" });
    await expect(run.done).rejects.toBeInstanceOf(ProtocolError);
  });

  it("cancel() detaches: events end and done resolves 'cancelled'", async () => {
    const events = baseSeq();
    const fetchImpl: FetchLike = async () => sseResponse(events);
    const run = driveTurn(new SseTransport({ baseUrl: "http://rt", fetchImpl }), { rotor: "base" });
    run.cancel();
    expect((await run.done).status).toBe("cancelled");
  });
});
