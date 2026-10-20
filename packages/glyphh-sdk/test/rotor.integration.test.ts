/**
 * Rotor transport ↔ a REAL openrotor runtime. Per the SDK spec, the transport is
 * exercised against an actual `openrotor serve`, not a mock. Skipped unless the
 * runtime URL + a rotor file are provided:
 *
 *   openrotor serve -p 8899
 *   GLYPHH_RUNTIME_URL=http://127.0.0.1:8899 \
 *   GLYPHH_ROTOR_PATH=../openrotor/rotors/base.rotor.yaml \
 *   npm test
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createClient, isWireEvent, type TurnEvent } from "../src/index.js";

const RUNTIME = process.env.GLYPHH_RUNTIME_URL;
const ROTOR_PATH = process.env.GLYPHH_ROTOR_PATH;
const suite = RUNTIME && ROTOR_PATH ? describe : describe.skip;

suite("rotor transport ↔ live openrotor", () => {
  const rotor = ROTOR_PATH ? readFileSync(ROTOR_PATH, "utf8") : "";
  const client = createClient({ url: RUNTIME ?? "" });

  it("streams a turn open → step* → answer → done with monotonic seq", async () => {
    const session = client.session({ rotor, url: RUNTIME! });
    const run = session.turn("hello from the SDK");

    const evs: TurnEvent[] = [];
    for await (const ev of run.events) evs.push(ev);
    const wire = evs.filter(isWireEvent);

    expect(wire[0]!.kind).toBe("open");
    expect(wire.at(-1)!.kind).toBe("done");
    expect(wire.some((e) => e.kind === "step")).toBe(true);
    const seqs = wire.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // monotonic

    const result = await run.done;
    expect(result.runId).toMatch(/^run-/);
    expect(result.status).toBeTruthy();
  }, 30_000);

  it("attaches to a completed run from a cursor and replays the tail once", async () => {
    const session = client.session({ rotor, url: RUNTIME! });
    const live = session.turn("attach me");
    for await (const _ev of live.events) void _ev;
    const runId = await live.whenRunId;

    const replay = session.attach(runId, { from: 2 });
    const evs: TurnEvent[] = [];
    for await (const ev of replay.events) evs.push(ev);
    const wire = evs.filter(isWireEvent);
    expect(wire.every((e) => e.seq > 2)).toBe(true);
    expect(wire.at(-1)!.kind).toBe("done");
  }, 30_000);
});
