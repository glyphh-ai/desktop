/**
 * resources/gateway.ts — run a metered model turn.
 *
 * This is the only way a client reaches a model. Provider keys stay server-side
 * (write-only, decrypted for the upstream call alone), so the call ORIGINATES on
 * the server: that is what makes the workspace allow-list, spend logging, and
 * the model-governance audit true at execution time rather than advisory.
 *
 * `complete()` is the single-shot, text-in/text-out path — history folding,
 * summaries, one-shot tool calls. Streaming agent turns ride the session
 * transport, not this.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { GatewayToken } from "../contract/loops.js";
import type { GatewayCompletion, GatewayCompletionInput, MessageTurn, MessageTurnInput, ToolUse,
} from "../contract/gateway.js";


// ── gateway telemetry (org_admin) ────────────────────────────────────────────
// The org's slice of GlyphhRouter's spend log. Metadata only — the
// gateway never stores prompt or completion content, so none exists to read.

export interface GatewayDay {
  day: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  spendUsd: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export interface GatewayBreakdownRow {
  key: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  spendUsd: number;
  avgLatencyMs: number;
}

export interface GatewayMetrics {
  configured: boolean;
  days: GatewayDay[];
  byModel: GatewayBreakdownRow[];
  byProvider: GatewayBreakdownRow[];
  /** Keyed by workspace (role) id — parsed from each key's alias. */
  byRole: GatewayBreakdownRow[];
}


export interface GatewayKey {
  id: string;
  name: string;
  workspaceId: string;
  tokenHint: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface MintedGatewayKey { key: GatewayKey; token: string }

export class GatewayClient {
  constructor(private readonly http: AuthedHttp) {}

  /**
   * THE TOKEN EXCHANGE — the caller's own gateway credential, for the
   * environment a CLI subprocess starts in. Everything it may reach comes
   * from the caller's ROLE, so there is nothing to pass and nothing to forge.
   *
   * IDEMPOTENT: the same credential every session. A client that minted per
   * launch would leave live keys nobody can account for and split its own
   * spend across them.
   *
   * Refuses with E_ENTITLEMENT when the plan doesn't carry the gateway, or
   * its trial window has closed.
   */
  token(): Promise<GatewayToken> {
    return this.http.post<GatewayToken>("/api/gateway/token", {});
  }

  // ── MEMBER SELF-SERVICE KEYS (his ruling, 2026-09-12): paid plan + the
  // org admin's members_mint_keys switch. The key is scoped by the member's
  // role exactly as the device token is. ─────────────────────────────────────

  /** The caller's own keys, plus whether the doors are open (`allowed`). */
  myKeys(): Promise<{ allowed: boolean; reason: string; keys: GatewayKey[] }> {
    return this.http.get<{ allowed: boolean; reason: string; keys: GatewayKey[] }>("/api/gateway/my-keys");
  }

  /** Mint a personal key (shown once). E_ENTITLEMENT when the doors are shut. */
  mintMyKey(name: string, days?: number): Promise<MintedGatewayKey> {
    return this.http.post<MintedGatewayKey>("/api/gateway/my-keys", { name, ...(days ? { days } : {}) });
  }

  /** Revoke one of the caller's OWN keys — anyone else's answers not-found. */
  revokeMyKey(id: string): Promise<void> {
    return this.http.del<void>(`/api/gateway/my-keys/${id}`);
  }

  /** The org switch for member minting (org_admin). */
  memberKeysEnabled(): Promise<{ enabled: boolean }> {
    return this.http.get<{ enabled: boolean }>("/api/org/gateway/member-keys");
  }

  /** Flip it (org_admin). */
  setMemberKeysEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    return this.http.put<{ enabled: boolean }>("/api/org/gateway/member-keys", { enabled });
  }

  /**
   * One metered completion. Refused (402) when the org's key is over budget — this
   * is a prepaid system with no arrears, and there is no free local fallback, so
   * callers should surface that rather than silently degrading.
   */
  complete(input: GatewayCompletionInput): Promise<GatewayCompletion> {
    const { maxTokens, service, runId, ...rest } = input;
    const headers: Record<string, string> = {};
    // Billing attribution: background work declares its SERVICE line
    // (enrichment, memory-rotor) and, when it belongs to a turn, the RUN id —
    // so the ledger never books it as an anonymous worker call.
    if (service) headers["x-glyphh-service"] = service;
    if (runId) headers["x-glyphh-run"] = runId;
    return this.http.post<GatewayCompletion>(
      "/api/gateway/v1/chat/completions",
      { ...rest, ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}) },
      // The gateway answers an OpenAI body verbatim, not the `{ data }` envelope.
      { raw: true, ...(Object.keys(headers).length ? { headers } : {}) },
    );
  }

  /**
   * An Anthropic Messages turn, returned as the RAW streaming response.
   *
   * This is what an agent loop rides: the body (SSE or JSON) is relayed to the
   * caller untouched, and the status is theirs to read — an Agent SDK uses 429/529
   * to decide when to retry, so reinterpreting them here would break it.
   *
   * The caller supplies the Anthropic-shaped body; the SDK supplies the path, the
   * base URL, and the bearer. Nothing addresses the control plane directly.
   */
  messages(
    body: unknown,
    opts: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Response> {
    return this.http.stream("/api/gateway/v1/messages", body, opts);
  }

  /**
   * One tool-capable turn, buffered and flattened.
   *
   * `complete()` cannot carry tools: chat-completions has no tool_use blocks, so a
   * model's decision to call something is lost. This rides the Messages edge
   * instead, which is why an agent loop uses it and a summary does not.
   *
   * Returns what a loop branches on — text, the tools it wants to call, why it
   * stopped — plus the raw content blocks, which must be appended to the
   * conversation verbatim so the model sees its own call when the result comes
   * back.
   */
  async turn(input: MessageTurnInput): Promise<MessageTurn> {
    const { maxTokens, ...rest } = input;
    // STREAM the wire even though the result is buffered: a non-streaming
    // request writes NOTHING until the provider finishes, and a long turn
    // (mistral-large chewing a 70-tool packet) outlives Heroku's 30s router
    // window — surfacing as `model turn failed (503): <!DOCTYPE html`. With
    // SSE the message_start frame lands in milliseconds, so the connection
    // stays alive for as long as the turn actually takes.
    const res = await this.messages({
      ...rest,
      // Anthropic requires max_tokens; a caller that omits it still gets a turn.
      max_tokens: maxTokens ?? 4096,
      stream: true,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`model turn failed (${res.status}): ${body.slice(0, 300)}`);
    }
    if (!res.body) throw new Error("model turn failed: empty response body");

    // Assemble the buffered turn from the SSE events. Unknown events (the
    // gateway's trailing glyphh_usage frame included) are ignored.
    type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; thinking?: string; signature?: string; data?: string };
    const blocks: Block[] = [];
    const partialJson = new Map<number, string>();
    let stopReason = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;
    let streamError = "";

    const handle = (ev: Record<string, unknown>): void => {
      const type = ev.type as string;
      if (type === "message_start") {
        const usage = (ev.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
        inputTokens = Math.max(0, Math.trunc(usage?.input_tokens ?? 0));
      } else if (type === "content_block_start") {
        const idx = Number(ev.index) || 0;
        const cb = (ev.content_block ?? {}) as Block;
        // text, tool_use and thinking are assembled from their deltas; a
        // redacted_thinking block arrives whole and is kept verbatim. Nothing
        // else is slotted, and never coerced to text: a coerced block came
        // back as `{type:"text", text:""}` in `content`, and replaying that
        // transcript is an Anthropic 400 ("text content blocks must be
        // non-empty"). A thinking block replays only whole — text AND
        // signature — so both are accumulated (his order, 2026-10-04: the
        // effort dial reaches the model through the gateway, and its
        // reasoning must survive the next tool round).
        if (cb.type === "tool_use") blocks[idx] = { type: "tool_use", id: cb.id ?? "", name: cb.name ?? "", input: {} };
        else if (cb.type === "text") blocks[idx] = { type: "text", text: "" };
        else if (cb.type === "thinking") blocks[idx] = { type: "thinking", thinking: cb.thinking ?? "", signature: cb.signature ?? "" };
        else if (cb.type === "redacted_thinking") blocks[idx] = { type: "redacted_thinking", data: cb.data ?? "" };
      } else if (type === "content_block_delta") {
        const idx = Number(ev.index) || 0;
        const delta = ev.delta as { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string } | undefined;
        const block = blocks[idx];
        if (!block) return;
        if (delta?.type === "text_delta" && delta.text) block.text = (block.text ?? "") + delta.text;
        else if (delta?.type === "input_json_delta" && delta.partial_json) {
          partialJson.set(idx, (partialJson.get(idx) ?? "") + delta.partial_json);
        } else if (delta?.type === "thinking_delta" && delta.thinking) block.thinking = (block.thinking ?? "") + delta.thinking;
        else if (delta?.type === "signature_delta" && delta.signature) block.signature = (block.signature ?? "") + delta.signature;
      } else if (type === "message_delta") {
        const d = ev as { delta?: { stop_reason?: string }; usage?: { output_tokens?: number } };
        if (d.delta?.stop_reason) stopReason = d.delta.stop_reason;
        if (d.usage?.output_tokens != null) outputTokens = Math.max(0, Math.trunc(d.usage.output_tokens));
      } else if (type === "error") {
        streamError = (ev.error as { message?: string } | undefined)?.message ?? "stream error";
      }
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const dispatch = (frame: string): void => {
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data) return;
      try { handle(JSON.parse(data) as Record<string, unknown>); } catch { /* keep-alives / non-JSON */ }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        dispatch(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    }
    if (buf.trim()) dispatch(buf);
    if (streamError) throw new Error(`model turn failed: ${streamError}`);

    // Tool inputs stream as raw JSON fragments — parse each block's whole.
    for (const [idx, raw] of partialJson) {
      const block = blocks[idx];
      if (!block || block.type !== "tool_use") continue;
      try { block.input = JSON.parse(raw) as Record<string, unknown>; } catch { block.input = {}; }
    }

    // Empty text blocks are dropped, not returned: Claude opens (and closes)
    // a text block with zero deltas ahead of a tool_use, and a loop replays
    // `content` verbatim as the next assistant message — Anthropic rejects an
    // empty text block on the way back in.
    const present = blocks.filter((b): b is Block => !!b && !(b.type === "text" && !b.text));
    const toolUses: ToolUse[] = present
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id ?? "", name: b.name ?? "", input: b.input ?? {} }));
    return {
      text: present.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
      toolUses,
      stopReason,
      usage: { inputTokens, outputTokens },
      content: present,
    };
  }

  /** The completion's text, or "" — the common case for utility turns. */
  async text(input: GatewayCompletionInput): Promise<string> {
    const completion = await this.complete(input);
    return completion.choices?.[0]?.message?.content ?? "";
  }

  /** The org's gateway telemetry window (org_admin). `workspaceId` narrows to one role's traffic. */
  metrics(opts: { days?: 1 | 7 | 30 | 90; workspaceId?: string } = {}): Promise<GatewayMetrics> {
    const qs = new URLSearchParams();
    if (opts.days) qs.set("days", String(opts.days));
    if (opts.workspaceId) qs.set("workspaceId", opts.workspaceId);
    const s = qs.toString();
    return this.http.get<GatewayMetrics>(`/api/org/gateway/metrics${s ? `?${s}` : ""}`);
  }

  // ── the keys the gateway hands out (org_admin) ─────────────────────────────
  // Each key is bound to ONE role: the role fixes the model list and whose
  // vendor credential burns underneath. The token rides the mint response
  // ONCE; the registry stores name/hint/lifetime only.

  keys(): Promise<GatewayKey[]> {
    return this.http.get<GatewayKey[]>("/api/org/gateway/keys");
  }

  createKey(input: { name: string; workspaceId: string; days?: number }): Promise<MintedGatewayKey> {
    return this.http.post<MintedGatewayKey>("/api/org/gateway/keys", input);
  }

  revokeKey(id: string): Promise<void> {
    return this.http.del<void>(`/api/org/gateway/keys/${encodeURIComponent(id)}`);
  }
}
