/**
 * library-types.ts — renderer-side mirrors of the SDK's library contracts.
 *
 * The renderer cannot import from @glyphh/sdk (preload boundary), so the
 * wire shapes are restated here. They cross the bridge verbatim from the SDK —
 * if a field changes there, it changes here.
 */

/** The `{ ok, data | error }` envelope every library IPC handler returns. */
export interface LibEnvelope { ok: boolean; data?: unknown; error?: string }

/** Unwrap an envelope, throwing its error so callers keep one code path. */
export function unwrap<T>(env: LibEnvelope): T {
  if (!env.ok) throw new Error(env.error || "request failed");
  return env.data as T;
}

// ── Loops ────────────────────────────────────────────────────────────────────

export interface LoopRole {
  name: string;
  label?: string;
  description?: string;
  default?: string | null;
}

export interface LoopManifest {
  version?: number;
  /** The loop's KIND: a normal work `turn`, or a `memory` loop whose role
   *  slots power the memory rotor (not selectable for agents). */
  type?: "turn" | "memory";
  roles?: LoopRole[];
  skills?: string[];
  connections?: string[];
  memory?: { read?: boolean; write?: boolean };
  layout?: string;
}

export interface LoopSummary {
  id: string;
  slug: string;
  scope: "personal" | "org";
  ownerUserId: string | null;
  name: string;
  description: string;
  builtIn: boolean;
  updatedAt: string;
}

export interface Loop extends LoopSummary {
  manifest: LoopManifest;
  code: string;
}

// ── Skills ───────────────────────────────────────────────────────────────────

export interface SkillManifest {
  version?: number;
  whenToUse?: string;
  allowedTools?: string[];
  requires?: string[];
  schedule?: string | null;
  model?: string | null;
}

export interface SkillSummary {
  id: string;
  slug: string;
  /** `personal` = the author's own; `org` = shared with every member. */
  scope?: "personal" | "org";
  name: string;
  description: string;
  hasCode: boolean;
  builtIn?: boolean;
  schedule: string | null;
  updatedAt: string;
}

export interface Skill extends SkillSummary {
  manifest: SkillManifest;
  prompt: string;
  code: string;
}

// ── Agents ───────────────────────────────────────────────────────────────────

export interface GuardrailsPolicy {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  windowSeconds?: number;
  windowTokens?: number;
  windowCalls?: number;
  maxConcurrent?: number;
}

/** An agent — a STANDING WORKER (main/local-agents.ts). The pre-purge shape
 *  minus `scope`/`ownerUserId`: sharing was server-enforced and there is no
 *  server behind this any more. `prompt` and `model` are the additions —
 *  the standing instruction, and an override on the loop's own model. */
export interface AgentSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** The standing instruction every one of its runs opens with. */
  prompt: string;
  /** The CLI loop it runs on (a cli-agents id). Null when it is a PROVIDER
   *  agent — an agent is one or the other, never both. */
  loopId: string | null;
  /** The provider slug when this is a provider+model agent (no CLI). */
  provider: string;
  /** Model override; "" = the loop's own. */
  model: string;
  skills: string[];
  apps: string[];
  live: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Agent extends AgentSummary {
  guardrails: GuardrailsPolicy | null;
}

export interface AgentTask {
  id: string;
  agentId: string;
  name: string;
  /** A task spec (~/.glyphh/tasks) or a skill (~/.glyphh/skills). The
   *  pre-purge "loop" kind IS this "task" kind — the store was renamed. */
  kind: "task" | "skill";
  target: string;
  args: Record<string, unknown>;
  cron: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

/** One firing of a task — an entry in the agent's run feed. */
export interface AgentTaskRun {
  id: string;
  startedAt: string;
  durationMs: number | null;
  status: string;
  error: string | null;
  output: string | null;
}
