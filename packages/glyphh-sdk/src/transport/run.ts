/**
 * run.ts — the `Run` handle + the durable-reconnect driver. This is the headline of
 * the SDK: a dropped connection is invisible to the consumer.
 *
 * The driver streams `openTurn`, tracks the highest `seq` delivered, and — on any
 * mid-run transport drop — reconnects with jittered backoff via `attach(runId,
 * lastSeq)`, dedupes replayed frames (`seq <= lastSeq`), and continues delivering
 * to the same `for await`. Lifecycle `reconnecting`/`reconnected` frames bracket
 * the gap so a client can show a subtle indicator. Works because the runtime
 * persists each StepRecord before streaming it, so every `seq` is durable.
 */

import { AsyncQueue } from "./queue.js";
import { backoffDelay, sleep, type BackoffOptions } from "./backoff.js";
import { ConnectError, ProtocolError } from "../core/errors.js";
import { WIRE_VERSION, type RunResult, type TurnEvent, type WireEvent } from "../protocol/events.js";
import type { Logger } from "../core/logger.js";
import type { Transport, TurnRequest } from "./transport.js";

export interface RunOptions {
  maxReconnects?: number;
  backoff?: BackoffOptions;
  logger?: Logger;
}

/** The handle returned by `turn()`/`attach()`: an async-iterable of events + a
 *  promise-like terminal result. Both work simultaneously. */
export class Run {
  private readonly queue = new AsyncQueue<TurnEvent>();
  private _runId: string | undefined;
  private cancelled = false;
  private readonly controller = new AbortController();

  private resolveRunId!: (id: string) => void;
  private resolveDone!: (r: RunResult) => void;
  private rejectDone!: (e: unknown) => void;

  /** Resolves as soon as the `open` frame arrives (needed for reconnect/resume). */
  readonly whenRunId: Promise<string> = new Promise((r) => (this.resolveRunId = r));
  /** The terminal result of the run. */
  readonly done: Promise<RunResult> = new Promise((res, rej) => {
    this.resolveDone = res;
    this.rejectDone = rej;
  });

  constructor() {
    // Safety net: always observe the terminal promise. A stream failure rejects BOTH
    // `events` (the async iterator) and `done`; a consumer that only iterates events
    // and catches there would otherwise leave `done`'s rejection unhandled — crashing
    // the host process. This no-op handler makes the rejection "observed"; a real
    // `await run.done` still receives it.
    void this.done.catch(() => {});
  }

  get events(): AsyncIterable<TurnEvent> {
    return this.queue;
  }
  get runId(): string | undefined {
    return this._runId;
  }
  /** v1: detach the client from the stream (does not abort the server-side run). */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.controller.abort();
    this.queue.end();
    this.resolveDone({ runId: this._runId ?? "", status: "cancelled", terminal: "detached", outputs: null });
  }

  // ── driver-internal ──────────────────────────────────────────────────────────
  /** @internal */ get signal(): AbortSignal {
    return this.controller.signal;
  }
  /** @internal */ get isCancelled(): boolean {
    return this.cancelled;
  }
  /** @internal */ emit(ev: TurnEvent): void {
    if (!this.cancelled) this.queue.push(ev);
  }
  /** @internal */ setRunId(id: string): void {
    if (!this._runId) {
      this._runId = id;
      this.resolveRunId(id);
    }
  }
  /** @internal */ finish(result: RunResult): void {
    this.queue.end();
    this.resolveDone(result);
  }
  /** @internal */ fail(error: unknown): void {
    if (this.cancelled) return;
    this.queue.fail(error);
    this.rejectDone(error);
  }
}

/** Start a run from a fresh turn, driving it (with reconnect) into `run`. */
export function driveTurn(transport: Transport, req: TurnRequest, opts: RunOptions = {}): Run {
  const run = new Run();
  void drive(transport, run, opts, () => transport.openTurn({ ...req, signal: run.signal }));
  return run;
}

/** Start a run by attaching to an existing run from a cursor. */
export function driveAttach(transport: Transport, runId: string, from: number, opts: RunOptions = {}): Run {
  const run = new Run();
  run.setRunId(runId);
  void drive(transport, run, opts, () => transport.attach(runId, from), from);
  return run;
}

async function drive(
  transport: Transport,
  run: Run,
  opts: RunOptions,
  open: () => AsyncIterable<WireEvent>,
  startCursor = -1,
): Promise<void> {
  const maxReconnects = opts.maxReconnects ?? 6;
  const log = opts.logger;
  const result: RunResult = { runId: run.runId ?? "", status: "", terminal: "", outputs: null };
  let lastSeq = startCursor;
  let attempt = 0;
  let stream = open();

  for (;;) {
    try {
      for await (const ev of stream) {
        if (run.isCancelled) return;
        if (ev.seq <= lastSeq) continue; // dedupe replayed frames
        lastSeq = ev.seq;
        attempt = 0; // progress resets the reconnect backoff

        if (ev.kind === "open") {
          if (majorOf(ev.wire) !== majorOf(WIRE_VERSION)) {
            run.fail(new ProtocolError(`unsupported wire protocol: ${ev.wire} (need ${WIRE_VERSION})`));
            return;
          }
          result.runId = ev.run_id;
          run.setRunId(ev.run_id);
        } else if (ev.kind === "error") {
          result.error = { code: ev.code, detail: ev.detail, remediation: ev.remediation };
        }
        run.emit(ev);
        if (ev.kind === "done") {
          result.status = ev.status;
          result.terminal = ev.terminal;
          result.outputs = ev.outputs;
          run.finish(result);
          return;
        }
      }
      // Stream ended WITHOUT a `done` frame → the connection dropped mid-run.
      if (run.isCancelled) return;
      if (!result.runId) {
        run.fail(new ConnectError("stream closed before the run opened"));
        return;
      }
    } catch (e) {
      if (run.isCancelled) return;
      if (e instanceof ProtocolError) {
        run.fail(e);
        return;
      }
      // fall through to reconnect
      log?.warn("turn stream error; will reconnect", { attempt });
    }

    // ── reconnect ────────────────────────────────────────────────────────────
    if (!result.runId) {
      run.fail(new ConnectError("stream closed before the run opened"));
      return;
    }
    if (attempt >= maxReconnects) {
      run.fail(new ConnectError(`reconnect exhausted after ${attempt} attempts`));
      return;
    }
    attempt++;
    run.emit({ kind: "reconnecting", attempt });
    await sleep(backoffDelay(attempt, opts.backoff), run.signal);
    if (run.isCancelled) return;
    stream = transport.attach(result.runId, lastSeq);
    run.emit({ kind: "reconnected", from: lastSeq });
  }
}

function majorOf(wire: string): string {
  // "rotor.stream/v1" → "1"
  const m = /\/v(\d+)/.exec(wire);
  return m ? m[1]! : wire;
}
