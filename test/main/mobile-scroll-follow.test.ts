import { describe, expect, it } from "vitest";
import { gateAfter, IDLE_GATE, mayPin, SETTLE_MS, type FollowGate } from "../../web/src/mobile-scroll-follow";

const run = (events: Parameters<typeof gateAfter>[0][], from: FollowGate = IDLE_GATE): FollowGate =>
  events.reduce((g, ev) => gateAfter(ev, g), from);

describe("the phone transcript's follow gate (his report, 2026-10-05)", () => {
  it("pins while idle and following", () => {
    expect(mayPin(IDLE_GATE, true)).toBe(true);
    expect(mayPin(IDLE_GATE, false)).toBe(false);
  });

  it("never pins with a finger down, scrolls included", () => {
    const g = run(["touchstart", "scroll", "scroll"]);
    expect(g).toEqual({ touching: true, coasting: false });
    expect(mayPin(g, true)).toBe(false);
  });

  it("a flick keeps the gate shut through the coast — the finger lifted but the page still moves", () => {
    const lifted = run(["touchstart", "scroll", "touchend"]);
    expect(mayPin(lifted, true)).toBe(false);
    const coasting = run(["scroll", "scroll"], lifted);
    expect(coasting).toEqual({ touching: false, coasting: true });
    expect(mayPin(coasting, true)).toBe(false);
  });

  it("the coast ends when the scroller goes quiet, and the pin may resume", () => {
    const g = run(["touchstart", "touchend", "scroll", "settled"]);
    expect(g).toEqual(IDLE_GATE);
    expect(mayPin(g, true)).toBe(true);
  });

  it("a slow drag with no coast settles the same way", () => {
    expect(run(["touchstart", "scroll", "touchend", "settled"])).toEqual(IDLE_GATE);
  });

  it("a new touch during a coast is a touch, and a stale settle cannot reopen it", () => {
    const g = run(["touchstart", "touchend", "scroll", "touchstart"]);
    expect(g).toEqual({ touching: true, coasting: false });
    expect(gateAfter("settled", g)).toEqual(g);
    expect(mayPin(g, true)).toBe(false);
  });

  it("the quiet window is short enough to keep the stream close behind a flick", () => {
    expect(SETTLE_MS).toBeGreaterThanOrEqual(100);
    expect(SETTLE_MS).toBeLessThanOrEqual(300);
  });
});
