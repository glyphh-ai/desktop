/**
 * mobile-scroll-follow.ts — WHEN the phone transcript may pin itself to the
 * bottom of the stream (his report, 2026-10-05: "the user grabs the page to
 * scroll and unless he goes very slow it hangs up on him").
 *
 * A programmatic scrollTop write against a live touch OR MOMENTUM gesture is
 * the WebKit wedge: touch delivery dies page-wide until a reload. The pin
 * already waited for the finger to lift; it did not wait for the coast that
 * follows a flick — a slow drag has no coast, a fast one does, hence "unless
 * he goes very slow". The gesture now lasts until the scroller goes quiet:
 * finger down → touching; finger up → coasting until no scroll event has
 * arrived for SETTLE_MS; only then may the stream pin again.
 *
 * Pure: the shell owns the timer and the refs; this decides.
 */

export interface FollowGate {
  /** A finger is on the scroller. */
  touching: boolean;
  /** The finger lifted and the scroller may still be coasting. */
  coasting: boolean;
}

/** Quiet time after the last scroll event before a coast counts as over. */
export const SETTLE_MS = 160;

export const IDLE_GATE: FollowGate = Object.freeze({ touching: false, coasting: false });

export type GateEvent = "touchstart" | "touchend" | "scroll" | "settled";

/** The gate after an event. A scroll while the finger is down is still the
 *  touch; a scroll after it lifted is (or restarts) the coast. */
export function gateAfter(ev: GateEvent, g: FollowGate): FollowGate {
  switch (ev) {
    case "touchstart": return { touching: true, coasting: false };
    case "touchend": return { touching: false, coasting: true };
    case "scroll": return g.touching ? g : { touching: false, coasting: true };
    case "settled": return g.touching ? g : { touching: false, coasting: false };
  }
}

/** May the stream write scrollTop now? Only while following and with no
 *  gesture — touch or coast — in flight. */
export function mayPin(g: FollowGate, following: boolean): boolean {
  return following && !g.touching && !g.coasting;
}
