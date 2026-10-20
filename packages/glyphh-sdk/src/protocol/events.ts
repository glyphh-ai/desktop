/**
 * protocol/events.ts — the `rotor.stream/v1` wire contract, mirrored from the
 * runtime (rrotor transport/events.ts). A run streams an ordered sequence, each
 * frame carrying a monotonic `seq` cursor (the resume key):
 *
 *   open → step* → (answer | interrupt | error) → done
 *
 * `TurnEvent` is what the SDK delivers to the consumer: the wire events plus the
 * SDK-level `reconnecting`/`reconnected` lifecycle frames emitted around a durable
 * reconnect (§4 of the SDK spec).
 */

/** Bump only on a breaking wire change; negotiated against the server's `open`. */
export const WIRE_VERSION = "rotor.stream/v1";

export type WireEvent =
  | { seq: number; kind: "open"; wire: string; run_id: string; trace_id: string; rotor: string; session?: string }
  | { seq: number; kind: "step"; step_id: string; type: string; status: string; frames: string[]; tick: number; error?: string }
  | { seq: number; kind: "answer"; text: string }
  | { seq: number; kind: "interrupt"; step_id: string; awaiting: unknown }
  | { seq: number; kind: "error"; code: string; detail: string; remediation: string }
  | { seq: number; kind: "done"; status: string; terminal: string; outputs: unknown };

export type WireEventKind = WireEvent["kind"];

/** SDK-level lifecycle frames (no `seq`) interleaved around a reconnect. */
export type LifecycleEvent =
  | { kind: "reconnecting"; attempt: number }
  | { kind: "reconnected"; from: number };

/** What the consumer's `for await (const ev of run.events)` yields. */
export type TurnEvent = WireEvent | LifecycleEvent;

/** The terminal result of a run, resolved from `run.done`. */
export interface RunResult {
  runId: string;
  status: string;
  terminal: string;
  outputs: unknown;
  /** A run *outcome* error (from an `error` frame) — not a thrown SdkError. */
  error?: { code: string; detail: string; remediation: string };
}

export function isWireEvent(ev: TurnEvent): ev is WireEvent {
  return ev.kind !== "reconnecting" && ev.kind !== "reconnected";
}
