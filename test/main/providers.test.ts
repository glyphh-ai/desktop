/**
 * providers.test.ts — the user's providers, models and keys
 * (~/.glyphh/users/local/providers.json): seeded from a key in the environment
 * or the first local build's key file, edited by Settings › Models, read by
 * the router with environment keys filled in, and shown with keys masked.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "glyphh-providers-"));
vi.mock("../../src/main/app-paths.js", () => ({ userScopedPath: (...p: string[]) => join(home, ...p) }));

const P = await import("../../src/main/providers.js");
const ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const stored = (): P.ProvidersFile => JSON.parse(readFileSync(join(home, "providers.json"), "utf-8")) as P.ProvidersFile;

describe("before anything is saved", () => {
  it("is empty with no key anywhere, and the loop has no credential", async () => {
    expect(P.readStoredProviders()).toEqual({ providers: [], models: [], defaults: {} });
    expect(P.hasChatModel()).toBe(false);
    expect(await P.routerCreds()).toBeNull();
    expect(P.defaultModel("chat")).toBe("");
  });

  it("stands up a provider per environment key with its starter models, the key never written", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    process.env.OPENAI_API_KEY = "sk-oai-env";
    const f = P.readStoredProviders();
    expect(f.providers.map((p) => p.id)).toEqual(["anthropic", "openai"]);
    expect(f.providers.every((p) => !p.apiKey)).toBe(true);
    expect(f.defaults).toEqual({ chat: "anthropic::claude-opus-5-5", transcription: "openai::gpt-4o-mini-transcribe", speech: "openai::gpt-4o-mini-tts", embeddings: "openai::text-embedding-3-small" });
    expect(P.routerConfig().providers.map((p) => p.apiKey)).toEqual(["sk-ant-env", "sk-oai-env"]);
    expect(P.hasChatModel()).toBe(true);
    expect(await P.routerCreds()).toEqual({ baseUrl: "http://glyphh-router.local", token: "glyphh-router" });
  });

  it("adopts the Anthropic key the first local build saved in provider-keys.json", () => {
    writeFileSync(join(home, "provider-keys.json"), JSON.stringify({ anthropic: " sk-ant-legacy " }));
    const f = P.readStoredProviders();
    expect(f.providers).toEqual([{ id: "anthropic", kind: "anthropic", name: "Anthropic", apiKey: "sk-ant-legacy" }]);
    expect(f.models.map((m) => m.id)).toEqual(["anthropic::claude-opus-5-5", "anthropic::claude-fable-5-1", "anthropic::claude-sonnet-5-5", "anthropic::claude-haiku-5-5"]);
  });
});

describe("Settings › Models edits", () => {
  it("adds a provider with an id from its name, keeps its key on an empty save, and clears it on request", () => {
    const p = P.saveProvider({ kind: "openai", name: "My OpenAI", apiKey: " sk-1 " });
    expect(p).toEqual({ id: "my-openai", kind: "openai", name: "My OpenAI", apiKey: "sk-1" });
    expect(statSync(join(home, "providers.json")).mode & 0o777).toBe(0o600);
    expect(P.saveProvider({ id: "my-openai", kind: "openai", name: "Renamed", apiKey: "" }).apiKey).toBe("sk-1");
    expect(P.saveProvider({ id: "my-openai", kind: "openai", clearKey: true })).toEqual({ id: "my-openai", kind: "openai", name: "OpenAI" });
    expect(P.saveProvider({ kind: "openai", name: "My OpenAI" }).id).toBe("my-openai-2");
  });

  it("needs a base URL for an OpenAI-compatible provider and a known kind", () => {
    expect(() => P.saveProvider({ kind: "openai-compatible", name: "Ollama" })).toThrow("needs a base URL");
    expect(P.saveProvider({ kind: "openai-compatible", name: "Ollama", baseUrl: " http://localhost:11434/v1 " }).baseUrl).toBe("http://localhost:11434/v1");
    expect(() => P.saveProvider({ kind: "nope" as P.ProviderKind })).toThrow("unknown provider kind");
  });

  it("adds, retypes and removes models; defaults follow; a removed provider takes its models and defaults", () => {
    P.saveProvider({ kind: "openai", name: "OpenAI", apiKey: "k" });
    P.saveModel({ provider: "openai", model: "gpt-5.1", type: "chat" });
    P.saveModel({ provider: "openai", model: "whisper-1", type: "chat" });
    P.saveModel({ provider: "openai", model: "whisper-1", type: "transcription", label: "Whisper" });
    expect(P.modelsOfType("transcription")).toEqual([{ id: "openai::whisper-1", provider: "openai", model: "whisper-1", type: "transcription", label: "Whisper" }]);
    expect(P.defaultModel("chat")).toBe("openai::gpt-5.1");
    expect(P.setDefault("transcription", "openai::whisper-1")).toMatchObject({ transcription: "openai::whisper-1" });
    expect(P.setDefault("voice", "nova").voice).toBe("nova");
    // A default must name a model of its type.
    expect(P.setDefault("speech", "openai::gpt-5.1")).not.toHaveProperty("speech");
    expect(P.setDefault("voice", "")).not.toHaveProperty("voice");
    P.removeModel("openai::gpt-5.1");
    expect(P.modelsOfType("chat")).toEqual([]);
    P.removeProvider("openai");
    expect(stored()).toEqual({ providers: [], models: [], defaults: {} });
    expect(() => P.saveModel({ provider: "gone", model: "x", type: "chat" })).toThrow("no provider gone");
    P.saveProvider({ kind: "anthropic", apiKey: "k" });
    expect(() => P.saveModel({ provider: "anthropic", model: " ", type: "chat" })).toThrow("a model needs a name");
    expect(() => P.saveModel({ provider: "anthropic", model: "x", type: "hologram" as P.ModelType })).toThrow("unknown model type");
  });

  it("drops anything malformed when the file is read", () => {
    writeFileSync(join(home, "providers.json"), JSON.stringify({
      providers: [{ id: "a", kind: "anthropic" }, { id: "", kind: "openai" }, { id: "b", kind: "weird" }],
      models: [{ provider: "a", model: "m", type: "chat" }, { provider: "zz", model: "m", type: "chat" }, { provider: "a", model: "n", type: "hologram" }],
      defaults: { chat: "a::m", speech: "a::m", voice: 3 },
    }));
    expect(P.readStoredProviders()).toEqual({
      providers: [{ id: "a", kind: "anthropic", name: "Anthropic" }],
      models: [{ id: "a::m", provider: "a", model: "m", type: "chat" }],
      defaults: { chat: "a::m" },
    });
  });
});

describe("embeddings, image and video models", () => {
  it("stores each type, keeps a default per type, and seeds an embeddings model with an OpenAI or Gemini key", () => {
    P.saveProvider({ kind: "openai", apiKey: "k" });
    P.saveModel({ provider: "openai", model: "text-embedding-3-large", type: "embeddings" });
    P.saveModel({ provider: "openai", model: "gpt-image-1", type: "image" });
    P.saveModel({ provider: "openai", model: "sora-2", type: "video" });
    expect(P.modelsOfType("embeddings").map((m) => m.id)).toEqual(["openai::text-embedding-3-large"]);
    expect(P.modelsOfType("image").map((m) => m.id)).toEqual(["openai::gpt-image-1"]);
    expect(P.modelsOfType("video").map((m) => m.id)).toEqual(["openai::sora-2"]);
    expect(P.defaultModel("embeddings")).toBe("openai::text-embedding-3-large");
    expect(P.setDefault("image", "openai::gpt-image-1")).toMatchObject({ image: "openai::gpt-image-1" });
    expect(P.setDefault("video", "openai::sora-2")).toMatchObject({ video: "openai::sora-2" });
    expect(P.setDefault("embeddings", "openai::sora-2")).not.toHaveProperty("embeddings");
    expect(stored().defaults).toEqual({ image: "openai::gpt-image-1", video: "openai::sora-2" });
    // Chat, transcription and speech are untouched by the new types.
    expect(P.defaultModel("chat")).toBe("");
    expect(P.hasChatModel()).toBe(false);

    rmSync(join(home, "providers.json"));
    process.env.GEMINI_API_KEY = "g";
    expect(P.readStoredProviders().defaults).toEqual({ chat: "gemini::gemini-2.5-pro", embeddings: "gemini::gemini-embedding-001" });
  });
});

describe("what Settings shows", () => {
  it("masks keys, saying whether each is set and where it comes from", () => {
    P.saveProvider({ kind: "openai", apiKey: "sk-abcdef1234" });
    P.saveProvider({ kind: "anthropic" });
    P.saveProvider({ kind: "openai-compatible", name: "LM Studio", baseUrl: "http://localhost:1234/v1" });
    process.env.ANTHROPIC_API_KEY = "sk-ant-zzzz9999";
    const v = P.providersView();
    expect(v.providers).toEqual([
      { id: "openai", kind: "openai", name: "OpenAI", keySet: true, keyFrom: "saved", keyHint: "…1234" },
      { id: "anthropic", kind: "anthropic", name: "Anthropic", keySet: true, keyFrom: "environment", keyHint: "…9999" },
      { id: "lm-studio", kind: "openai-compatible", name: "LM Studio", baseUrl: "http://localhost:1234/v1", keySet: false, keyFrom: null, keyHint: "" },
    ]);
    expect(JSON.stringify(v)).not.toContain("sk-abcdef1234");
  });

  it("counts a chat model only when its provider can be called", () => {
    P.saveProvider({ kind: "gemini" });
    P.saveModel({ provider: "google-gemini", model: "gemini-2.5-pro", type: "chat" });
    expect(P.hasChatModel()).toBe(false);
    process.env.GEMINI_API_KEY = "g";
    expect(P.hasChatModel()).toBe(true);
    P.saveProvider({ kind: "openai-compatible", name: "Ollama", baseUrl: "http://x/v1" });
    P.saveModel({ provider: "ollama", model: "qwen3", type: "chat" });
    delete process.env.GEMINI_API_KEY;
    expect(P.hasChatModel()).toBe(true);
    expect(P.providerIdFor("!!!", [])).toBe("provider");
  });
});
