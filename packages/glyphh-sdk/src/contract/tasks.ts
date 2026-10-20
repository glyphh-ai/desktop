/**
 * contract/tasks.ts — the org's TASK library. A task is a program: a manifest
 * declaring what it may reach, and a `.js` file that drives it.
 *
 * The program is a mostly-deterministic state machine — it decides when to read and
 * write memory, which skills to call in what order, and where an agent turn belongs
 * — so a team can encode "my web development loop" instead of re-prompting its way
 * there each time. The control plane stores and governs loops; they RUN on the
 * client, where the working folder, apps, and layouts are. Model turns inside a loop
 * still go out through the gateway like every other model call.
 *
 * RENAMED from `loops` (2026-09-12): these became TASKS. "Loop" now means
 * a CLI pre-config (contract/loops.ts) — two different things that shared a
 * word, which is the confusion this rename ends.
 *
 * Members pick a task; org_admins build them. The built-in "Default" loop (id and
 * slug `default`, `builtIn: true`) is the general catch-all and is immutable.
 */

/**
 * One model slot a loop declares. The program refers to it by `name`
 * (`ctx.agent("planner", …)`); everything else exists so a picker can render it.
 *
 * A role DECLARES a slot, it does not bind one — `default` is a suggestion, and a
 * caller whose workspace disallows it simply falls back. A loop declaring one role
 * gets one dropdown; a planner-and-coder loop gets two, each labelled with what it
 * is for.
 */
export interface TaskRole {
  /** Stable key the program uses. */
  name: string;
  /** Human label for the picker. Defaults to `name`. */
  label?: string;
  /** What this slot is FOR — shown beside the dropdown. */
  description?: string;
  /** The modality this slot must be filled by: chat | image | video | speech |
   *  transcription. The picker only offers models of this modality. Default 'chat'. */
  modality?: string;
  /** Catalog model id to prefer. Falls back to the platform default. */
  default?: string | null;
}

/** WHAT a loop may reach. */
export interface TaskManifest {
  /** Manifest shape version, for forward migration. */
  version?: number;
  /** The loop's KIND. A normal work `turn`; a `memory` loop whose role slots
   *  (encoder / reasoner / governor) power the memory rotor; or a `rover` loop
   *  that HOPS models — every model call roves to the next bound slot, never
   *  the same model twice in a row (memory/hot-prompt carries the context, so
   *  the swap is free). Default `turn`. */
  type?: "turn" | "memory" | "rover";
  /** The model slots this loop declares. */
  roles?: TaskRole[];
  /** Skill slugs the loop may call. */
  skills?: string[];
  /** Connection slugs the loop may use. */
  connections?: string[];
  /** The loop's MEMORY POLICY: `read` gates recall-before-the-turn, `write`
   *  gates persist-after; topK/threshold tune the semantic recall; `entity`
   *  names the fact owner (default `user`). Rides the run body to the runtime
   *  as HarnessMemoryPolicy. */
  memory?: { read?: boolean; write?: boolean; topK?: number; threshold?: number; entity?: string };
  /** Layout the workspace re-orients to while this loop is active. Desktop only —
   *  a CLI run has no layout and ignores it. */
  layout?: string;
}

export interface TaskSummary {
  id: string;
  /** Stable per-org handle — how a loop is named outside the UI. */
  slug: string;
  name: string;
  description: string;
  /** The manifest's `type` discriminator, surfaced on summaries so LIST
   *  consumers (loop dropdowns) can hide memory loops without fetching every
   *  manifest. Absent means `turn`. */
  type?: TaskManifest["type"];
  builtIn: boolean;
  updatedAt: string;
}

export interface Task extends TaskSummary {
  manifest: TaskManifest;
  /** The loop program. Empty for a loop that has not been written yet. */
  code: string;
}

export interface CreateTaskInput {
  slug: string;
  name: string;
  description?: string;
  manifest?: TaskManifest;
  code?: string;
}

export interface UpdateTaskInput {
  slug?: string;
  name?: string;
  description?: string;
  manifest?: TaskManifest;
  code?: string;
}

/** One slot, resolved for a caller: what it is, what it is set to, what it could be. */
export interface ResolvedTaskRole {
  name: string;
  label: string;
  description: string;
  /** The modality this slot is typed to — the picker filters choices to it. */
  modality: string;
  /** The model this role will run on. Null when the caller may use none. */
  modelId: string | null;
  /**
   * Where that answer came from. A picker shows this so a user can tell an
   * inherited default from their own choice:
   *   selection — the caller picked it   loop — the loop author suggested it
   *   platform  — the super_admin default fallback — first allowed, nothing else set
   */
  source: "selection" | "loop" | "platform" | "fallback" | "none";
  /** Everything the caller could choose, already governance-filtered and priced —
   *  a picker that shows a model without its cost makes the choice blind. */
  choices: Array<{
    id: string;
    name: string;
    providerSlug: string;
    modality: string;
    contextWindow: number | null;
    maxOutputTokens: number | null;
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
    isPlatformDefault: boolean;
    /** The gateway can serve this model right now (routable + keyed). Absent on
     *  older servers = assume ready. Rover pools and auto-binding skip false. */
    gatewayReady?: boolean;
  }>;
}
