/**
 * sse-transport.ts — the SSE implementation of {@link Transport}. Zero special
 * infra: server→client over an `EventSource`-style stream parsed off `fetch`'s
 * `ReadableStream`, client→server over `POST`. Covers everything; the WS transport
 * layers duplex control on the same event model.
 */

import { parseSse } from "../protocol/sse.js";
import { apiErrorFor, ConnectError } from "../core/errors.js";
import type { FetchLike } from "../core/http.js";
import type { TokenProvider } from "../auth/credential-provider.js";
import type { RunResult, WireEvent } from "../protocol/events.js";
import type { Transport, TurnRequest } from "./transport.js";

export interface SseTransportOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  /** Bearer supplier for the runtime (auth is plumbed even before the runtime enforces it). */
  token?: TokenProvider;
}

export class SseTransport implements Transport {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly token: TokenProvider | undefined;

  constructor(opts: SseTransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.token = opts.token;
  }

  openTurn(req: TurnRequest): AsyncIterable<WireEvent> {
    return this.stream("POST", "/run", { rotor: req.rotor, inputs: req.inputs ?? {}, session: req.session }, req.signal);
  }

  attach(runId: string, from: number): AsyncIterable<WireEvent> {
    return this.stream("GET", `/runs/${encodeURIComponent(runId)}/events?from=${from}`, undefined);
  }

  async resume(runId: string, payload: Record<string, unknown>): Promise<RunResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/resume`, {
      method: "POST",
      headers: await this.headers({ json: true }),
      body: JSON.stringify(payload),
    }).catch((e) => {
      throw new ConnectError(`resume ${runId} failed`, e);
    });
    if (!res.ok) throw await this.toError(res);
    const body = (await res.json()) as { run_id: string; status: string; terminal: string; outputs: unknown; error?: { name?: string; cause?: string; remediation?: string } };
    return {
      runId: body.run_id,
      status: body.status,
      terminal: body.terminal,
      outputs: body.outputs,
      ...(body.error ? { error: { code: body.error.name ?? "E_FAILED", detail: body.error.cause ?? "", remediation: body.error.remediation ?? "" } } : {}),
    };
  }

  private async *stream(method: string, path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<WireEvent> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: await this.headers({ json: body !== undefined, sse: true }),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      throw new ConnectError(`stream ${path} failed`, e);
    }
    if (!res.ok) throw await this.toError(res);
    if (!res.body) throw new ConnectError(`stream ${path} returned no body`);
    yield* parseSse(res.body);
  }

  private async headers(opts: { json?: boolean; sse?: boolean }): Promise<Record<string, string>> {
    const h: Record<string, string> = { accept: opts.sse ? "text/event-stream" : "application/json" };
    if (opts.json) h["content-type"] = "application/json";
    if (this.token) h["authorization"] = `Bearer ${await this.token()}`;
    return h;
  }

  private async toError(res: Response): Promise<Error> {
    const text = await res.text().catch(() => "");
    let code = "E_INTERNAL";
    let message = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text) as { error?: string | { code?: string; detail?: string }; detail?: string };
      const err = j.error;
      code = (typeof err === "object" ? err?.code : err) ?? code;
      message = (typeof err === "object" ? err?.detail : undefined) ?? j.detail ?? message;
    } catch {
      /* non-JSON body */
    }
    return apiErrorFor({ code, message, httpStatus: res.status });
  }
}
