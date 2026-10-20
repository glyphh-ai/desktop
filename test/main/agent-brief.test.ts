import { describe, it, expect, vi, beforeEach } from "vitest";

// The generator's seams: the router credential, the member's prefs, their
// models, and the one model call.
vi.mock("electron", () => ({ ipcMain: { handle: () => {} } }));
let creds: { baseUrl: string; token: string } | null = { baseUrl: "https://gw", token: "k" };
vi.mock("../../src/main/providers", () => ({ routerCreds: async () => creds, routerConfig: () => ({ providers: [], models: [] }) }));
vi.mock("@glyphh/sdk/router", () => ({ createRouterFetch: () => fetch }));
let teamDefault = "anthropic::claude-opus-5";
vi.mock("../../src/main/org-models", () => ({ defaultChatModel: () => teamDefault, modelRef: (m: string) => m.replace(/"/g, "").trim() }));
const sent: Array<{ model: string; content: string }> = [];
vi.mock("@glyphh/sdk/loop", () => ({
  streamMessage: async (o: { body: { model: string; messages: Array<{ content: string }> } }) => {
    sent.push({ model: o.body.model, content: o.body.messages[0]!.content });
    return { content: [{ type: "text", text: "  You research one question at a time.  " }] };
  },
}));

const { generateAgentBrief } = await import("../../src/main/agent-brief");

describe("generateAgentBrief — the wand (his order, 2026-09-29)", () => {
  beforeEach(() => { sent.length = 0; creds = { baseUrl: "https://gw", token: "k" }; teamDefault = "anthropic::claude-opus-5"; });

  it("asks for information first, and spends nothing without it", async () => {
    const r = await generateAgentBrief({ name: " ", description: "" });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/Say what the agent is for first/);
    expect(sent).toEqual([]);
  });

  it("writes on the default chat model, with everything the person typed", async () => {
    teamDefault = "google::gemini-3.8-flash";
    const r = await generateAgentBrief({ name: "Researcher", description: "Cites sources", model: "anthropic::claude-opus-5", draft: "be terse" });
    expect(r).toEqual({ ok: true, brief: "You research one question at a time.", model: "google::gemini-3.8-flash" });
    expect(sent[0]!.model).toBe("google::gemini-3.8-flash");
    // Everything the person typed goes in — the draft is improved, not dropped.
    expect(sent[0]!.content).toContain("Name: Researcher");
    expect(sent[0]!.content).toContain("Cites sources");
    expect(sent[0]!.content).toContain("be terse");
  });

  it("says so when there is no default chat model", async () => {
    teamDefault = "";
    const r = await generateAgentBrief({ name: "X" });
    expect((r as { error: string }).error).toMatch(/Pick a default chat model in Settings › Models/);
  });

  it("no provider set up is a sentence, not a crash", async () => {
    creds = null;
    const r = await generateAgentBrief({ name: "X" });
    expect((r as { error: string }).error).toMatch(/Add a model provider in Settings › Models/);
  });
});
