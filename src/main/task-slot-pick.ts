/**
 * task-slot-pick.ts — WHO FILLS A TASK SLOT, as one pure decision.
 *
 * His order (2026-10-07): "allow agents and tasks to define cli or glyphh
 * agents with models". A slot names an agent, or nothing, and may carry its
 * own model and its own lane. The rules, in order:
 *
 *   - the SLOT's model wins over the agent's own: the task author chose it
 *     for this step (before, the agent's model silently beat the slot's);
 *   - an UNBOUND slot (no agent) runs as the default Glyphh agent on the
 *     org/default model with an empty brief — never, silently, as whichever
 *     agent happens to sort first in the roster;
 *   - a slot naming an agent that no longer exists FAILS the run, naming the
 *     slot, instead of running as someone else.
 *
 * Every slot runs on the Glyphh loop (the CLI lane went on 2026-10-08).
 *
 * Pure: the roster and the agent's standing context are handed in, so the
 * decision is testable without a library or a database.
 */

/** One agent as the roster offers it to a slot. */
export interface SlotRosterEntry { id: string; name: string }

/** What a task.json slot says. */
export interface SlotShape { name: string; agent: string | null; model?: string }

/** What an agent brings to a run: its standing brief and its own model. */
export interface SlotAgentContext { prompt: string; model?: string }

export interface SlotBinding {
  agentId: string | null;
  agentName: string;
  /** The standing brief that rides ahead of the step's prompt ("" when unbound). */
  prompt: string;
  /** The model the step runs on; undefined = the org/default model. */
  model?: string;
}

export const DEFAULT_AGENT_NAME = "Default Glyphh agent";

export function pickSlotAgent(
  slot: SlotShape,
  roster: SlotRosterEntry[],
  contextOf: (agentId: string) => SlotAgentContext | null,
): SlotBinding {
  const slotModel = slot.model && String(slot.model).trim() ? String(slot.model).trim() : undefined;
  if (!slot.agent) {
    // Unbound: the default Glyphh agent.
    return { agentId: null, agentName: DEFAULT_AGENT_NAME, prompt: "", ...(slotModel ? { model: slotModel } : {}) };
  }
  const who = roster.find((a) => a.id === slot.agent);
  if (!who) {
    throw new Error(`slot "${slot.name}" names an agent "${slot.agent}" that no longer exists — pick another on the task's Agents tab`);
  }
  const ctx = contextOf(who.id);
  // THE SLOT'S MODEL WINS; the agent's own is the fallback.
  const model = slotModel ?? (ctx?.model && String(ctx.model).trim() ? String(ctx.model).trim() : undefined);
  return {
    agentId: who.id,
    agentName: who.name,
    prompt: ctx?.prompt || "",
    ...(model ? { model } : {}),
  };
}
