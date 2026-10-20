/**
 * contract/agents.ts — AGENTS and the tasks they fire.
 *
 * An agent is a standing worker. It runs a LOOP, and that loop's manifest is what
 * it may be pointed at: its model/app/skill selections are validated against the
 * manifest's offer rather than chosen freely. A coding agent can hand work off to
 * one; a live agent keeps its own process up and its tasks armed.
 *
 * Ownership follows connections — a member authors their own, an org_admin shares
 * one org-wide.
 *
 * GUARDRAILS. An agent carries the org's policy shape, applied under it. The org
 * level is a CEILING: an agent can only tighten, never widen. Enforce
 * `guardrailsEffective` (the resolved per-key minimum), never `guardrails`.
 */

/** Same shape as the org's guardrails policy. Every value is an upper bound. */
export interface GuardrailsPolicy {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  windowSeconds?: number;
  windowTokens?: number;
  windowCalls?: number;
  maxConcurrent?: number;
}

/** What an agent has been pointed at, within its loop's offer. */
export interface AgentSelections {
  /** Loop role name → catalog model id. Fills the loop's model slots. */
  roles?: Record<string, string>;
  /** Skill slugs this agent may call — a subset of the loop's. */
  skills?: string[];
  /** App slugs this agent may drive. */
  apps?: string[];
}

export type AgentScope = "personal" | "org";

export interface AgentSummary {
  id: string;
  slug: string;
  scope: AgentScope;
  ownerUserId: string | null;
  name: string;
  description: string;
  /** The loop this agent runs; null = the built-in Default loop. */
  loopId: string | null;
  /** Whether this agent should be kept live (process up, tasks armed). */
  live: boolean;
  /** What it is pointed at — role→model, skills. Cards render the model cast. */
  selections: AgentSelections;
  updatedAt: string;
}

export interface Agent extends AgentSummary {
  /** The agent's OWN policy as set. Null when it just inherits the org's. */
  guardrails: GuardrailsPolicy | null;
  /** The policy it ACTUALLY runs under: org ∧ agent, per key. Enforce this one. */
  guardrailsEffective: GuardrailsPolicy | null;
}

/** What a task fires. `target` is a skill slug, a loop slug, or an app slug
 *  (with the command name in `args`). */
export type AgentTaskKind = "skill" | "loop" | "app_command";

/**
 * A BINDING, not a program: something that already exists, plus arguments and a
 * schedule. "Every day at midnight, send an email to Y" is the send-email skill
 * bound to a cron and an argument — not a second copy of that skill.
 */
export interface AgentTask {
  id: string;
  agentId: string;
  name: string;
  kind: AgentTaskKind;
  target: string;
  args: Record<string, unknown>;
  cron: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

/** A live agent with its enabled tasks — what a runner arms on start. */
export interface LiveAgent extends Agent {
  tasks: AgentTask[];
}

export interface CreateAgentInput {
  slug: string;
  scope?: AgentScope;
  name: string;
  description?: string;
  loopId?: string | null;
  selections?: AgentSelections;
  guardrails?: GuardrailsPolicy | null;
  live?: boolean;
}

export interface UpdateAgentInput {
  slug?: string;
  scope?: AgentScope;
  name?: string;
  description?: string;
  loopId?: string | null;
  selections?: AgentSelections;
  guardrails?: GuardrailsPolicy | null;
  live?: boolean;
}

export interface CreateAgentTaskInput {
  name: string;
  kind: AgentTaskKind;
  target: string;
  args?: Record<string, unknown>;
  cron: string;
  enabled?: boolean;
}

export interface UpdateAgentTaskInput {
  name?: string;
  kind?: AgentTaskKind;
  target?: string;
  args?: Record<string, unknown>;
  cron?: string;
  enabled?: boolean;
}

/** One firing of a task — an entry in the agent's run feed. */
export interface AgentTaskRun {
  id: string;
  startedAt: string;
  durationMs: number | null;
  status: string;
  error: string | null;
  /** What the run produced — the feed entry's body. */
  output: string | null;
}
