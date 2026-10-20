/**
 * transport.ts — the internal transport seam. The public session/turn API is
 * identical over SSE and WebSocket; a `Transport` abstracts the three verbs the
 * run driver needs. `openTurn` and `attach` return an async stream of WireEvents;
 * `resume` drives an interrupted run and returns its terminal summary.
 */

import type { RunResult, WireEvent } from "../protocol/events.js";

export interface TurnRequest {
  rotor: unknown;
  inputs?: Record<string, unknown>;
  session?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface Transport {
  /** Run a rotor fresh and stream its execution (open → step* → terminal → done). */
  openTurn(req: TurnRequest): AsyncIterable<WireEvent>;
  /** Durable reconnect / watch: replay a run's stream after a cursor. */
  attach(runId: string, from: number): AsyncIterable<WireEvent>;
  /** Continue an interrupted run (HITL). Returns the terminal result. */
  resume(runId: string, payload: Record<string, unknown>): Promise<RunResult>;
}
