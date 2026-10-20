/**
 * task-slot-pick.test.ts — WHO FILLS A TASK SLOT (his order, 2026-10-07:
 * tasks define cli or glyphh agents with models). The slot's model beats the
 * agent's; an unbound slot is the default Glyphh agent, never the roster's
 * first; a vanished agent fails the run by slot name; a CLI agent runs
 * through its CLI.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_NAME, pickSlotAgent, type SlotRosterEntry } from "../../src/main/task-slot-pick";

const roster: SlotRosterEntry[] = [
  { id: "ag_first", name: "First" },
  { id: "ag_writer", name: "Writer" },
  { id: "ag_coder", name: "Coder" },
];
const contexts: Record<string, { prompt: string; model?: string }> = {
  ag_first: { prompt: "I am first", model: "first-model" },
  ag_writer: { prompt: "Write well.", model: "writer-model" },
  ag_coder: { prompt: "Code well.", model: "claude-sonnet" },
};
const contextOf = (id: string) => contexts[id] ?? null;

describe("pickSlotAgent", () => {
  it("an unbound slot is the default Glyphh agent on the default model with no brief — never the roster's first", () => {
    const b = pickSlotAgent({ name: "main", agent: null }, roster, contextOf);
    expect(b).toEqual({ agentId: null, agentName: DEFAULT_AGENT_NAME, prompt: "" });
    expect(b.model).toBeUndefined();
  });

  it("an unbound slot keeps its own model", () => {
    const b = pickSlotAgent({ name: "main", agent: null, model: "gpt-x" }, roster, contextOf);
    expect(b.model).toBe("gpt-x");
    expect(b.agentId).toBeNull();
  });

  it("the slot's model wins over the agent's", () => {
    const b = pickSlotAgent({ name: "draft", agent: "ag_writer", model: "slot-model" }, roster, contextOf);
    expect(b.model).toBe("slot-model");
    expect(b.prompt).toBe("Write well.");
    expect(b.agentName).toBe("Writer");
  });

  it("without a slot model the agent's own model rides", () => {
    const b = pickSlotAgent({ name: "draft", agent: "ag_writer" }, roster, contextOf);
    expect(b.model).toBe("writer-model");
  });

  it("a slot naming an agent that no longer exists fails by slot name", () => {
    expect(() => pickSlotAgent({ name: "review", agent: "ag_gone" }, roster, contextOf))
      .toThrow(/slot "review" names an agent "ag_gone" that no longer exists/);
  });





  it("blank models are no models", () => {
    const b = pickSlotAgent({ name: "main", agent: "ag_writer", model: "  " }, roster, contextOf);
    expect(b.model).toBe("writer-model");
  });
});
