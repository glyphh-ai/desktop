/**
 * embeddings-config.test.ts — memory and search embed with the user's own
 * embeddings model from Settings › Models, through the router's /embeddings
 * wire with that provider's key. With no embeddings model there is nothing to
 * embed with (no built-in fallback), and the settings IPC says so.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "glyphh-embed-"));
const handlers = new Map<string, (...a: unknown[]) => unknown>();
vi.mock("electron", () => ({ ipcMain: { handle: (c: string, f: (...a: unknown[]) => unknown) => { handlers.set(c, f); } } }));
vi.mock("../../src/main/app-paths.js", () => ({ userScopedPath: (...p: string[]) => join(home, ...p) }));
vi.mock("../../src/main/memory.js", () => ({
  registerMemoryIpc: () => undefined,
  MEMORY_NEEDS_MODEL: "Memory needs an embeddings model. Add one in Settings › Models.",
}));

const P = await import("../../src/main/providers.js");
const cfg = await import("../../src/main/embeddings-config.js");

const calls: Array<{ url: string; init: RequestInit }> = [];
beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]) vi.stubEnv(k, "");
  calls.length = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const input = (JSON.parse(String(init.body)) as { input: string[] }).input;
    return new Response(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: [t.length, 1] })) }));
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("the user's embeddings model", () => {
  it("offers nothing and resolves to nothing with no embeddings model, and refuses to embed", async () => {
    P.saveProvider({ kind: "openai", apiKey: "sk-oai" });
    P.saveModel({ provider: "openai", model: "gpt-5.1", type: "chat" });
    expect(await cfg.embedModels()).toEqual([]);
    expect(await cfg.resolveEmbedModel()).toBe("");
    await expect(cfg.embedWith(["a"], "")).rejects.toThrow("Memory needs an embeddings model. Add one in Settings › Models.");
    expect(calls).toHaveLength(0);
  });

  it("offers the embeddings-type models and resolves to the default one", async () => {
    P.saveProvider({ kind: "openai", apiKey: "sk-oai" });
    P.saveModel({ provider: "openai", model: "text-embedding-3-small", type: "embeddings" });
    P.saveModel({ provider: "openai", model: "text-embedding-3-large", type: "embeddings", label: "Large" });
    expect(await cfg.embedModels()).toEqual([
      { id: "openai::text-embedding-3-small", name: "text-embedding-3-small", providerSlug: "OpenAI" },
      { id: "openai::text-embedding-3-large", name: "Large", providerSlug: "OpenAI" },
    ]);
    expect(await cfg.resolveEmbedModel()).toBe("openai::text-embedding-3-small");
    P.setDefault("embeddings", "openai::text-embedding-3-large");
    expect(cfg.selectedEmbedModel()).toBe("openai::text-embedding-3-large");
  });

  it("embeds through the model's provider with its key", async () => {
    P.saveProvider({ kind: "openai", apiKey: "sk-oai" });
    P.saveModel({ provider: "openai", model: "text-embedding-3-small", type: "embeddings" });
    expect(await cfg.embedWith(["abc", "de"], "openai::text-embedding-3-small")).toEqual([[3, 1], [2, 1]]);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-oai");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ model: "text-embedding-3-small", input: ["abc", "de"] });
    await expect(cfg.embedWith(["a"], "gone::model")).rejects.toThrow('No provider serves the embeddings model "gone::model"');
  });

  it("says Anthropic has no embeddings", async () => {
    P.saveProvider({ kind: "anthropic", apiKey: "sk-ant" });
    P.saveModel({ provider: "anthropic", model: "claude-embed", type: "embeddings" });
    await expect(cfg.embedWith(["a"], "anthropic::claude-embed")).rejects.toThrow("Anthropic has no embeddings models");
  });

  it("knows a model by its id or its bare name, and nothing else", () => {
    const models = [{ id: "openai::text-embedding-3-small", name: "x", providerSlug: "OpenAI" }];
    expect(cfg.offers(models, "openai::text-embedding-3-small")).toBe(true);
    expect(cfg.offers(models, "text-embedding-3-small")).toBe(true);
    expect(cfg.offers(models, "local::hashed-words-512")).toBe(false);
    expect(cfg.routeName("openai::text-embedding-3-large")).toBe("text-embedding-3-large");
    expect(cfg.routeName("bare")).toBe("bare");
  });

  it("answers the settings IPC with the user's models, and sets only one of them", async () => {
    cfg.registerEmbeddingsIpc();
    expect(await handlers.get("embeddings-config-get")!()).toEqual({ ok: true, model: "", models: [] });
    P.saveProvider({ kind: "openai", apiKey: "sk-oai" });
    P.saveModel({ provider: "openai", model: "a-embed", type: "embeddings" });
    P.saveModel({ provider: "openai", model: "b-embed", type: "embeddings" });
    expect(await handlers.get("embeddings-config-set")!({}, { model: "openai::b-embed" })).toEqual({ ok: true, model: "openai::b-embed" });
    expect(await handlers.get("embeddings-config-set")!({}, { model: "openai::gpt-5.1" })).toEqual({ ok: false, error: "openai::gpt-5.1 is not one of your embeddings models" });
    expect(await handlers.get("embeddings-config-get")!()).toMatchObject({ ok: true, model: "openai::b-embed" });
  });
});
