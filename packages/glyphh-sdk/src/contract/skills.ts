/**
 * contract/skills.ts — the org's SKILL library. A skill is the unit a loop calls:
 * a manifest, an instruction prompt, and an optional program.
 *
 * A prompt-only skill is instructions an agent reads and acts on. A skill with code
 * runs its program deterministically, taking agent turns where it chooses. Both are
 * stored and governed by the control plane and executed by the client runner — the
 * same sandbox loops run in.
 *
 * Members read; org_admins build. Skills are addressed by slug or id: the UI holds
 * ids, and a loop's manifest references skills by slug.
 */

/** One declared input or output of a skill. */
export interface SkillIO {
  name: string;
  type: string;
  description?: string;
}

/**
 * WHAT a skill needs and when to reach for it. `whenToUse` is the selection signal
 * — what an agent (or a loop's author) reads to decide this is the right skill.
 */
export interface SkillManifest {
  /** Manifest shape version, for forward migration. */
  version?: number;
  /** When an agent should reach for this skill. */
  whenToUse?: string;
  inputs?: SkillIO[];
  outputs?: SkillIO[];
  /** Tool names the skill may call (qualified, e.g. `gmail.send`). */
  allowedTools?: string[];
  /** Connection slugs the skill needs. */
  requires?: string[];
  /** Cron expression when the skill runs on a schedule; null/absent = on demand. */
  schedule?: string | null;
  /** Catalog model id this skill prefers. Subject to the caller's allow-list. */
  model?: string | null;
}

export interface SkillSummary {
  id: string;
  /** Stable per-org handle — how loops and the CLI name a skill. */
  slug: string;
  name: string;
  description: string;
  /** True when the skill carries a program (not prompt-only). */
  hasCode: boolean;
  /** Synthesized platform default — immutable, listed for every org. */
  builtIn?: boolean;
  /** The cron expression, when this skill is scheduled. */
  schedule: string | null;
  updatedAt: string;
}

export interface Skill extends SkillSummary {
  manifest: SkillManifest;
  /** The instruction body — the old SKILL.md markdown. */
  prompt: string;
  /** The optional program. Empty for a prompt-only skill. */
  code: string;
}

export interface CreateSkillInput {
  slug: string;
  name: string;
  description?: string;
  manifest?: SkillManifest;
  prompt?: string;
  code?: string;
}

export interface UpdateSkillInput {
  slug?: string;
  name?: string;
  description?: string;
  manifest?: SkillManifest;
  prompt?: string;
  code?: string;
}
