/**
 * session.ts — the public rotor surface. A `Session` binds a rotor + memory scope;
 * `turn()` runs it and returns a {@link Run} (async-iterable events + terminal
 * promise, durable across reconnects). `attach()` resumes watching a run; `resume()`
 * drives an interrupted (HITL) run to completion.
 */

import { UnsupportedError } from "../core/errors.js";
import { driveTurn, driveAttach, type Run, type RunOptions } from "../transport/run.js";
import type { Transport } from "../transport/transport.js";
import type { RunResult } from "../protocol/events.js";

export interface SessionConfig {
  /** Rotor to run: a name resolved server-side, an inline document, or YAML/JSON source. */
  rotor: unknown;
  /** Memory-tier scope; generated server-side if absent. */
  sessionId?: string;
  /** Fallback model. */
  model?: string;
  /** Reconnect/backoff/logging for this session's runs. */
  run?: RunOptions;
}

export class Session {
  constructor(
    private readonly transport: Transport,
    private readonly config: SessionConfig,
  ) {}

  /** Run a turn. Returns immediately with a Run whose events stream + done resolves. */
  turn(prompt: string, opts: { inputs?: Record<string, unknown>; signal?: AbortSignal } = {}): Run {
    const inputs: Record<string, unknown> = {
      prompt,
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(opts.inputs ?? {}),
    };
    return driveTurn(
      this.transport,
      { rotor: this.config.rotor, inputs, session: this.config.sessionId, signal: opts.signal },
      this.config.run,
    );
  }

  /** Resume watching an existing run from a cursor (default: from the beginning). */
  attach(runId: string, opts: { from?: number } = {}): Run {
    return driveAttach(this.transport, runId, opts.from ?? -1, this.config.run);
  }

  /** Human-in-the-loop: continue an interrupted run to its terminal result. */
  resume(runId: string, payload: Record<string, unknown> = {}): Promise<RunResult> {
    return this.transport.resume(runId, payload);
  }

  /** Attachments require runtime endpoints not yet shipped (SDK spec §7/§10). */
  attach_file(): Promise<never> {
    return Promise.reject(new UnsupportedError("attachments require runtime endpoints not yet shipped"));
  }
}
