/**
 * contract/gateway.ts — the metered model call. The gateway is the ONE egress for
 * model traffic: it resolves the sent model against the org's catalog, decrypts the
 * org's provider key (never exposed to any client), calls upstream, and meters the
 * tokens against the caller + workspace.
 *
 * It speaks OpenAI chat-completions on both edges — including in its RESPONSE, which
 * is returned verbatim rather than in the SDK's `{ data }` envelope, so an
 * OpenAI-shaped client can point at it unchanged.
 */

export interface GatewayMessage {
  role: string;
  content: string;
}

export interface GatewayCompletionInput {
  /** Billing service line for this call ('enrichment' | 'memory-rotor') —
   *  background work declares itself so the ledger stays honest. */
  service?: string;
  /** The turn this call belongs to (x-glyphh-run) — ties background work to
   *  the run that caused it. */
  runId?: string;
  /** Catalog id (`provider::model`) or the bare model id. */
  model: string;
  messages: GatewayMessage[];
  temperature?: number;
  seed?: number;
  maxTokens?: number;
}

export interface GatewayChoice {
  index: number;
  message: GatewayMessage;
  finish_reason: string | null;
}

export interface GatewayUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** An OpenAI-shaped chat completion, exactly as the gateway returns it. */
export interface GatewayCompletion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: GatewayChoice[];
  usage?: GatewayUsage;
}

// ── Anthropic Messages (the tool-capable turn) ───────────────────────────────

/** A tool the model may call, in Anthropic's shape. */
export interface MessageTool {
  name: string;
  description?: string;
  input_schema?: unknown;
}

/** One tool the model decided to call. */
export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface MessageTurnInput {
  /** Catalog model id or bare id. */
  model: string;
  /** The conversation so far, in Anthropic shape (content string or blocks). */
  messages: Array<{ role: string; content: unknown }>;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: MessageTool[];
}

// ── anonymous guest chat (no account) ────────────────────────────────────────

/** A minted guest token — a self-verifying credential for the guest surface only. */
export interface GuestToken {
  token: string;
  /** The server-minted, client-persisted id that scopes the ephemeral guest session. */
  guestId: string;
  /** Seconds until the token must be re-issued. */
  expiresIn: number;
  /** The one model a guest is forced onto (server-enforced). */
  model: string;
}

/** A guest chat turn — Anthropic-Messages shaped. The model is IGNORED (forced to Mistral). */
export interface GuestTurnInput {
  messages: Array<{ role: string; content: unknown }>;
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * A completed turn, flattened to what a loop actually branches on: what the model
 * said, what it wants to call, and why it stopped. `toolUses` being non-empty with
 * `stopReason: "tool_use"` is the signal to run tools and come back.
 */
export interface MessageTurn {
  text: string;
  toolUses: ToolUse[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
  /** The raw assistant content blocks, to append verbatim to the conversation. */
  content: unknown[];
}
