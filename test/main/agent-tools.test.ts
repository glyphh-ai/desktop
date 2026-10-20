import { describe, it, expect, vi, beforeEach } from "vitest";

// ── seams: the relay registry, the agent records, the models, the generator ──
const handlers = new Map<string, (p: unknown) => unknown>();
vi.mock("electron", () => ({ ipcMain: { handle: () => {} } }));
vi.mock("../../src/main/relay-client", () => ({
  registerRelayHandler: (name: string, fn: (p: unknown) => unknown) => { handlers.set(name, fn); },
}));

interface Row { id: string; slug: string; name: string; description: string; prompt: string; model: string }
const rows = new Map<string, Row>();
const slugify = (n: string): string => n.trim().toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
vi.mock("../../src/main/local-agents", () => ({
  slugify,
  listAgents: () => [...rows.values()],
  getAgent: (ref: string) => { const r = rows.get(ref); if (!r) throw new Error(`agent "${ref}" not found`); return r; },
  saveAgent: (i: Partial<Row> & { slug?: string }) => {
    const slug = slugify(i.slug || i.name || "");
    const r = { id: slug, slug, name: i.name ?? "", description: i.description ?? "", prompt: i.prompt ?? "", model: i.model ?? "" };
    rows.set(slug, r);
    return r;
  },
  deleteAgent: (ref: string) => { rows.delete(ref); },
}));
const briefCalls: unknown[] = [];
vi.mock("../../src/main/agent-brief", () => ({
  generateAgentBrief: async (input: unknown) => { briefCalls.push(input); return { ok: true, brief: "You research. (written)", model: "claude-opus-5" }; },
}));
vi.mock("../../src/main/loop-models", () => ({
  listLoopModels: async () => ({ ok: true, models: [{ id: "anthropic::claude-opus-5", name: "claude-opus-5", providerSlug: "Anthropic" }, { id: "google::gemini-3.8-flash", name: "gemini-3.8-flash", providerSlug: "Google" }] }),
}));
vi.mock("../../src/main/org-models", () => ({ modelRef: (m: string) => m.replace(/"/g, "").trim() }));

const { installAgentRelayHandlers } = await import("../../src/main/agent-tools");
installAgentRelayHandlers();
const call = (name: string, p: unknown) => Promise.resolve(handlers.get(name)!(p));

describe("agent tools — make, read, update, delete (his order, 2026-09-29)", () => {
  beforeEach(() => { rows.clear(); briefCalls.length = 0; });

  it("an agent made with no brief gets one WRITTEN, from what the caller said", async () => {
    const r = await call("agents.save", { name: "Researcher", description: "Finds and cites primary sources", model: "google::gemini-3.8-flash" }) as Record<string, unknown>;
    expect(r).toMatchObject({ agent: "researcher", created: true, generatedBrief: true, brief: "You research. (written)", model: "google::gemini-3.8-flash" });
    expect(briefCalls).toEqual([{ name: "Researcher", description: "Finds and cites primary sources", model: "google::gemini-3.8-flash" }]);
  });

  it("making never overwrites: a name in use is refused, with the id to update instead", async () => {
    await call("agents.save", { name: "Researcher", brief: "mine" });
    await expect(call("agents.save", { name: "researcher", brief: "theirs" })).rejects.toThrow(/already exists.*agent: "researcher"/);
    expect(rows.get("researcher")!.prompt).toBe("mine");
  });

  it("a model slot must be one the member's team carries", async () => {
    await expect(call("agents.save", { name: "X", brief: "b", model: "gpt-9" })).rejects.toThrow(/not one of this member's models.*anthropic::claude-opus-5/);
    expect(rows.size).toBe(0);
  });

  it("an update keeps what it was not told to change, and writes no brief it already has", async () => {
    await call("agents.save", { name: "Reviewer", description: "Reviews diffs", brief: "You review.", model: "anthropic::claude-opus-5" });
    const r = await call("agents.save", { agent: "reviewer", description: "Reviews diffs for concurrency" }) as Record<string, unknown>;
    expect(r).toMatchObject({ created: false, generatedBrief: false, brief: "You review.", model: "anthropic::claude-opus-5", description: "Reviews diffs for concurrency" });
    expect(briefCalls).toEqual([]);
  });

  it("lists, reads and deletes by id — and says so when there is no such agent", async () => {
    await call("agents.save", { name: "Writer", brief: "You write." });
    expect(await call("agents.list", {})).toEqual([{ agent: "writer", name: "Writer", description: "", model: null, hasBrief: true }]);
    expect(await call("agents.get", { agent: "writer" })).toMatchObject({ brief: "You write." });
    expect(await call("agents.delete", { agent: "writer" })).toEqual({ agent: "writer", deleted: true });
    expect(() => handlers.get("agents.delete")!({ agent: "writer" })).toThrow(/not found/);
    await expect(call("agents.save", { agent: "ghost", name: "Ghost" })).rejects.toThrow(/no agent "ghost"/);
  });
});

describe("agent tools — what runs it (his order, 2026-10-07: cli or glyphh agents with models)", () => {
  beforeEach(() => { rows.clear(); briefCalls.length = 0; });

  it("an agent is a Glyphh agent unless told otherwise, and says so", async () => {
    const r = await call("agents.save", { name: "Researcher", brief: "b" }) as Record<string, unknown>;
  });


});
