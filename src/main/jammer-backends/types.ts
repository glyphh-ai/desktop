/**
 * Jammer backend abstraction — the seam that lets a jammer run on an agent
 * loop other than Claude.
 *
 * AgentRunner owns everything provider-agnostic: instance lifecycle, message
 * queueing, idle timers, guardrail enforcement, cypher-bus posting, thread
 * persistence, and renderer status events. A `JammerBackend` owns exactly one
 * provider's agent loop and normalizes its output into the `JammerEvent`
 * stream defined here, so AgentRunner never sees a provider-specific message.
 *
 * Phase 0: only ClaudeBackend exists; `selectBackend` always returns it.
 * Phase 1+ adds Codex (OpenAI) and Gemini (Google) backends behind the same
 * interface, selected per-jammer by `AgentConfig.modelProvider`.
 */

import type { Guardrails } from "../stores/agent-store-db";

/** Spawn config for one jammer. Lives here (not agent-runner) so backends can
 *  import it without a cycle; agent-runner re-exports it for compatibility. */
export interface AgentConfig {
  name: string;
  displayName?: string;
  avatarUrl?: string;
  role: string;
  cwd: string;
  prompt?: string;
  startPrompt: string;
  workspace: string;
  /** Model id passed to the backend. Interpretation is provider-specific. */
  model?: string;
  /** LLM provider — selects the backend. Defaults to "anthropic". */
  modelProvider?: string;
  mcpServers?: Record<string, any>;
  permissionMode?: string;
  cypherId?: string;
  /** True for agents in a local swarm — enables bus message delivery and
   *  turn-budget nudges without the server-cypher machinery. */
  swarm?: boolean;
  /** Resource limits from the jammer's config — enforced by AgentRunner. */
  guardrails?: Guardrails;
}

/** One block of an assistant message — ordered, so the feed can interleave
 *  thinking and tool calls exactly as the model emitted them. */
export type JammerContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/**
 * Normalized event a backend yields per turn. This is the ONLY shape
 * AgentRunner consumes — every provider's stream is translated into it.
 */
export type JammerEvent =
  | { kind: "init"; sessionId: string | null; model?: string; tools?: string[]; mcpServers?: unknown }
  | { kind: "assistant"; blocks: JammerContentBlock[]; parentToolUseId: string | null }
  | { kind: "partial_text"; text: string; index: number }
  | { kind: "tool_start"; id: string; name: string }
  | { kind: "tool_progress"; toolUseId: string; toolName: string; elapsed: number }
  | {
      kind: "result";
      subtype: string;
      text: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      numTurns: number;
      durationMs: number;
      isError: boolean;
    }
  | { kind: "status"; status: string }
  | { kind: "state"; state: unknown };

export interface JammerTurnRequest {
  prompt: string;
  /** When set, continue the prior session rather than starting fresh. */
  resumeSessionId: string | null;
}

/** Callbacks a backend may invoke during its lifetime (provider-agnostic). */
export interface JammerBackendHooks {
  /** Ask the runner to fully stop this jammer (e.g. sandbox-violation strikes). */
  requestStop: () => void;
}

export interface JammerBackend {
  /** Provider id this backend serves — "anthropic", "openai", "google". */
  readonly provider: string;
  /**
   * One-time setup for a jammer: load the SDK/CLI, build run options.
   * Throws on unrecoverable setup failure (AgentRunner surfaces the error).
   */
  init(config: AgentConfig, hooks: JammerBackendHooks): Promise<void>;
  /**
   * Optional pre-flight (e.g. provider auth). Return `ok: false` to abort the
   * start silently — the backend owns any user-facing prompt.
   */
  preflight?(): Promise<{ ok: boolean }>;
  /**
   * Run one turn. Yields normalized events; lets an AbortError propagate when
   * `abort()` is called mid-turn so AgentRunner can report the stop.
   */
  runTurn(req: JammerTurnRequest): AsyncGenerator<JammerEvent>;
  /** Abort the in-flight turn, if any. */
  abort(): void;
}
