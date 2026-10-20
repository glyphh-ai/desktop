/**
 * memory-needs-model.test.ts — memory runs on the user's embeddings model.
 * With none, memory is OFF: recall injects nothing and capture stores nothing,
 * without a word in the log; writing a page or editing a memory says to add
 * one. With one, both lanes run as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let embeddingsDefault = "";
const handlers = new Map<string, (...a: unknown[]) => unknown>();
const upserts: unknown[] = [];
const searches: unknown[] = [];

vi.mock("electron", () => ({ ipcMain: { handle: (c: string, f: (...a: unknown[]) => unknown) => { handlers.set(c, f); } } }));
vi.mock("../../src/main/stores/preferences-db.js", () => ({ getPreference: (_k: string, d: unknown) => d }));
vi.mock("../../src/main/providers.js", () => ({ defaultModel: (t: string) => (t === "embeddings" ? embeddingsDefault : "") }));
vi.mock("../../src/main/glyphh-app-ai.js", () => ({
  llmChunk: ({ text }: { text: string }) => ({ chunks: [text] }),
  vectorUpsert: async (_slug: string, args: unknown) => { upserts.push(args); return { upserted: 1 }; },
  vectorSearch: async (_slug: string, args: unknown) => { searches.push(args); return { matches: [{ id: "t#0", score: 1, text: "we deploy with a canary" }] }; },
  vectorDelete: () => ({ deleted: 0 }),
  vectorItems: () => [{ id: "turn-a#0", text: "USER: hi", metadata: { source: "turn-a" } }, { id: "turn-a#1", text: "more", metadata: { source: "turn-a" } }],
}));

const M = await import("../../src/main/memory.js");
M.registerMemoryIpc();
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("memory without an embeddings model", () => {
  beforeEach(() => { upserts.length = 0; searches.length = 0; embeddingsDefault = ""; });

  it("is off: recall injects nothing and capture stores nothing, quietly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(M.memoryOn()).toBe(false);
    expect(await M.memoryFacts("how do we deploy?")).toBe("");
    M.memoryCapture("how do we deploy?", "with a canary");
    await settle();
    expect(searches).toEqual([]);
    expect(upserts).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("says to add one when a page is written or a memory edited", async () => {
    await expect(M.writeMemoryPage({ section: "topic", title: "Deploys", summary: "", details: ["canary"] })).rejects.toThrow(M.MEMORY_NEEDS_MODEL);
    expect(await handlers.get("memory-turn-update")!({}, { source: "turn-a", details: ["x"] })).toEqual({ ok: false, error: M.MEMORY_NEEDS_MODEL });
    expect(M.MEMORY_NEEDS_MODEL).toBe("Memory needs an embeddings model. Add one in Settings › Models.");
  });

  it("still counts what is stored, without embedding anything", async () => {
    expect(await handlers.get("memory-stats")!()).toEqual({ ok: true, turns: 1, chunks: 2 });
    expect(searches).toEqual([]);
  });
});

describe("memory with an embeddings model", () => {
  beforeEach(() => { upserts.length = 0; searches.length = 0; embeddingsDefault = "openai::text-embedding-3-small"; });

  it("recalls and captures", async () => {
    expect(M.memoryOn()).toBe(true);
    expect(await M.memoryFacts("how do we deploy?")).toContain("- we deploy with a canary");
    M.memoryCapture("a new question", "a new answer");
    await settle();
    expect(upserts).toHaveLength(1);
  });
});
