/**
 * router.test.ts — the in-process model router: a Messages call to the
 * router's address is answered by the provider that serves the model (Anthropic
 * relayed as is, the rest translated to and from OpenAI chat-completions),
 * anything else passes straight through, and the voice calls go to the
 * provider's audio routes. A fake fetch stands in for every provider.
 */

import { describe, expect, it } from "vitest";
import {
  MODEL_TYPES, ROUTER_BASE_URL, anthropicBody, baseUrlOf, claudeTakesEffort, createRouterFetch, embed, guessModelType,
  listProviderModels, modelId, resolveModel, synthesize, transcribe,
  type FetchLike, type RouterConfig,
} from "../../src/router/index.js";
import { assembleStream, sseEvents } from "../../src/loop/messages.js";

const config: RouterConfig = {
  providers: [
    { id: "anthropic", kind: "anthropic", name: "Anthropic", apiKey: "sk-ant" },
    { id: "openai", kind: "openai", name: "OpenAI", apiKey: "sk-oai" },
    { id: "ollama", kind: "openai-compatible", name: "Ollama", baseUrl: "http://localhost:11434/v1/" },
    { id: "gem", kind: "gemini", name: "Gemini" },
  ],
  models: [
    { id: "anthropic::claude-opus-5-5", provider: "anthropic", model: "claude-opus-5-5", type: "chat" },
    { id: "openai::gpt-5.1", provider: "openai", model: "gpt-5.1", type: "chat" },
    { id: "ollama::qwen3", provider: "ollama", model: "qwen3", type: "chat" },
  ],
};

interface Call { url: string; init: RequestInit }
function fake(answer: (url: string, init: RequestInit) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, init }); return answer(url, init); } };
}
const sse = (frames: string[]): Response =>
  new Response(frames.map((f) => `data: ${f}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const turn = (model: string, extra: Record<string, unknown> = {}): RequestInit => ({
  method: "POST",
  body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: "user", content: "hi" }], stream: true, ...extra }),
});
const headersOf = (c: Call): Record<string, string> => c.init.headers as Record<string, string>;

describe("resolveModel", () => {
  it("routes a full id to its provider, a bare id by the list, a bare Claude name to Anthropic", () => {
    expect(resolveModel(config, "openai::gpt-5.1")).toMatchObject({ provider: { id: "openai" }, model: "gpt-5.1" });
    expect(resolveModel(config, "qwen3")).toMatchObject({ provider: { id: "ollama" }, model: "qwen3" });
    expect(resolveModel(config, "claude-sonnet-5-5")).toMatchObject({ provider: { id: "anthropic" }, model: "claude-sonnet-5-5" });
    expect(resolveModel(config, "nobody::x")).toBeNull();
    expect(resolveModel(config, "mystery")).toBeNull();
    expect(modelId("openai", "gpt-5.1")).toBe("openai::gpt-5.1");
  });

  it("knows each kind's address and trims a custom one", () => {
    expect(baseUrlOf({ kind: "anthropic" })).toBe("https://api.anthropic.com");
    expect(baseUrlOf({ kind: "openai" })).toBe("https://api.openai.com/v1");
    expect(baseUrlOf({ kind: "gemini" })).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(baseUrlOf({ kind: "openai-compatible" })).toBe("");
    expect(baseUrlOf({ kind: "openai-compatible", baseUrl: " http://x/v1/ " })).toBe("http://x/v1");
  });
});

describe("anthropicBody", () => {
  it("moves the effort dial into output_config and turns on adaptive thinking on the models that take them", () => {
    expect(claudeTakesEffort("claude-opus-5-5")).toBe(true);
    expect(claudeTakesEffort("claude-sonnet-4-6")).toBe(true);
    expect(claudeTakesEffort("claude-haiku-4-5")).toBe(false);
    expect(anthropicBody({ model: "x", reasoning_effort: "high", max_tokens: 5 }, "claude-opus-5-5")).toEqual({
      model: "claude-opus-5-5", max_tokens: 5, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" },
    });
    expect(anthropicBody({ model: "x", reasoning_effort: "high" }, "claude-haiku-4-5")).toEqual({ model: "claude-haiku-4-5" });
    expect(anthropicBody({ model: "x" }, "claude-opus-5-5")).not.toHaveProperty("output_config");
  });
});

describe("createRouterFetch", () => {
  it("passes every request that is not the router's own straight through", async () => {
    const f = fake(() => new Response("ok"));
    const route = createRouterFetch(() => config, f.fetch);
    const res = await route("http://127.0.0.1:7860/mcp", { method: "POST", body: "{}" });
    expect(await res.text()).toBe("ok");
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:7860/mcp");
  });

  it("relays a Claude model to Anthropic with the provider's key and the bare model name", async () => {
    const f = fake(() => sse(['{"type":"message_stop"}']));
    const route = createRouterFetch(() => config, f.fetch);
    const res = await route(`${ROUTER_BASE_URL}/v1/messages`, turn("anthropic::claude-opus-5-5", { reasoning_effort: "low" }));
    expect(res.status).toBe(200);
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(headersOf(call)["x-api-key"]).toBe("sk-ant");
    expect(headersOf(call)).not.toHaveProperty("authorization");
    const body = JSON.parse(String(call.init.body));
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("translates an OpenAI model's stream into Anthropic events the loop assembles, tool call included", async () => {
    const f = fake(() => sse([
      JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "{\"path\":" } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"a.txt\"}" } }] }, finish_reason: "tool_calls" }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } }),
      "[DONE]",
    ]));
    const route = createRouterFetch(() => config, f.fetch);
    const res = await route(`${ROUTER_BASE_URL}/v1/messages`, turn("openai::gpt-5.1", {
      tools: [{ name: "read_file", description: "read", input_schema: { type: "object" } }],
    }));
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(headersOf(call).authorization).toBe("Bearer sk-oai");
    const sent = JSON.parse(String(call.init.body));
    expect(sent.model).toBe("gpt-5.1");
    expect(sent).toHaveProperty("max_completion_tokens", 100);
    expect(sent.stream).toBe(true);
    const msg = await assembleStream(sseEvents(res.body!));
    expect(msg.content[0]).toMatchObject({ type: "text", text: "Hello" });
    expect(msg.content[1]).toMatchObject({ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.txt" } });
    expect(msg.stop_reason).toBe("tool_use");
  });

  it("keeps reading past chunks that translate to nothing (an empty reasoning delta, a usage-only chunk)", async () => {
    const f = fake(() => sse([
      JSON.stringify({ choices: [{ delta: { role: "assistant", reasoning_content: "" } }] }),
      JSON.stringify({ choices: [{ delta: { role: "assistant", reasoning_content: "" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
      "[DONE]",
    ]));
    const route = createRouterFetch(() => config, f.fetch);
    const res = await route(`${ROUTER_BASE_URL}/v1/messages`, turn("ollama::qwen3"));
    const msg = await assembleStream(sseEvents(res.body!));
    expect(msg.content[0]).toMatchObject({ type: "text", text: "hi" });
    expect(msg.stop_reason).toBe("end_turn");
  });

  it("calls a keyless OpenAI-compatible server at its own address, with max_tokens and no effort field", async () => {
    const f = fake(() => sse([JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }), "[DONE]"]));
    const route = createRouterFetch(() => config, f.fetch);
    await route(`${ROUTER_BASE_URL}/v1/messages`, turn("ollama::qwen3", { reasoning_effort: "high" }));
    const call = f.calls[0]!;
    expect(call.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(headersOf(call)).not.toHaveProperty("authorization");
    const sent = JSON.parse(String(call.init.body));
    expect(sent).toHaveProperty("max_tokens", 100);
    expect(sent).not.toHaveProperty("reasoning_effort");
  });

  it("answers a non-streaming call with an Anthropic message", async () => {
    const f = fake(() => new Response(JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })));
    const route = createRouterFetch(() => config, f.fetch);
    const res = await route(`${ROUTER_BASE_URL}/v1/messages`, turn("openai::gpt-5.1", { stream: false }));
    const body = await res.json() as { content: Array<{ type: string; text?: string }> };
    expect(body.content[0]).toMatchObject({ type: "text", text: "done" });
  });

  it("refuses in plain words: an unknown model, a missing key, a bad body, the provider's own error", async () => {
    const f = fake(() => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 }));
    const route = createRouterFetch(() => config, f.fetch);
    const msg = async (r: Response): Promise<string> => ((await r.json()) as { error: { message: string } }).error.message;

    const unknown = await route(`${ROUTER_BASE_URL}/v1/messages`, turn("nobody::x"));
    expect(unknown.status).toBe(400);
    expect(await msg(unknown)).toContain("Settings › Models");

    const noKey = await route(`${ROUTER_BASE_URL}/v1/messages`, turn("gem::gemini-2.5-pro"));
    expect(noKey.status).toBe(401);
    expect(await msg(noKey)).toBe("Gemini has no API key — add it in Settings › Models");

    const bad = await route(`${ROUTER_BASE_URL}/v1/messages`, { method: "POST", body: "not json" });
    expect(bad.status).toBe(400);

    const upstream = await route(`${ROUTER_BASE_URL}/v1/messages`, turn("openai::gpt-5.1"));
    expect(upstream.status).toBe(404);
    expect(await msg(upstream)).toBe("OpenAI: model not found");
    expect(f.calls).toHaveLength(1);
  });

  it("says the provider is unreachable when the network fails, and rethrows an abort", async () => {
    const route = createRouterFetch(() => config, async () => { throw new Error("ECONNREFUSED"); });
    const res = await route(`${ROUTER_BASE_URL}/v1/messages`, turn("ollama::qwen3"));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("Ollama is unreachable: ECONNREFUSED");
    const ctl = new AbortController();
    ctl.abort();
    await expect(createRouterFetch(() => config, async () => { throw new Error("aborted"); })(`${ROUTER_BASE_URL}/v1/messages`, { ...turn("ollama::qwen3"), signal: ctl.signal })).rejects.toThrow("aborted");
  });

  it("reads the config on every call, so a saved provider applies at once", async () => {
    let cfg: RouterConfig = { providers: [], models: [] };
    const f = fake(() => sse(['{"type":"message_stop"}']));
    const route = createRouterFetch(() => cfg, f.fetch);
    expect((await route(`${ROUTER_BASE_URL}/v1/messages`, turn("anthropic::claude-opus-5-5"))).status).toBe(400);
    cfg = config;
    expect((await route(`${ROUTER_BASE_URL}/v1/messages`, turn("anthropic::claude-opus-5-5"))).status).toBe(200);
  });
});

describe("listProviderModels", () => {
  it("reads each kind's list, strips Gemini's models/ prefix, sorts and dedupes", async () => {
    const f = fake((url) => new Response(JSON.stringify(url.includes("anthropic")
      ? { data: [{ id: "claude-opus-5-5" }, { id: "claude-haiku-5-5" }] }
      : { data: [{ id: "models/gemini-2.5-pro" }, { id: "gemini-2.5-pro" }, { id: "a" }] })));
    expect(await listProviderModels(config.providers[0]!, f.fetch)).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    expect(f.calls[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(await listProviderModels({ ...config.providers[3]!, apiKey: "g" }, f.fetch)).toEqual(["a", "gemini-2.5-pro"]);
    expect(f.calls[1]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models");
  });

  it("says why when it cannot list", async () => {
    await expect(listProviderModels({ id: "x", kind: "openai-compatible", name: "X" }, fake(() => new Response("")).fetch)).rejects.toThrow("set a base URL first");
    await expect(listProviderModels(config.providers[1]!, fake(() => new Response("", { status: 401 })).fetch)).rejects.toThrow("OpenAI answered 401");
  });

  it("guesses a listed model's type from its name", () => {
    expect(guessModelType("whisper-1")).toBe("transcription");
    expect(guessModelType("gpt-4o-mini-transcribe")).toBe("transcription");
    expect(guessModelType("gpt-4o-mini-tts")).toBe("speech");
    expect(guessModelType("gpt-5.1")).toBe("chat");
    for (const m of ["text-embedding-3-small", "gemini-embedding-001", "nomic-embed-text", "bge-m3", "BAAI/bge-large-en-v1.5", "intfloat/multilingual-e5-large"]) expect(guessModelType(m)).toBe("embeddings");
    for (const m of ["black-forest-labs/FLUX.1-schnell", "sdxl-turbo", "stable-diffusion-3.5-large", "dall-e-3", "gpt-image-1", "imagen-4.0-generate-001"]) expect(guessModelType(m)).toBe("image");
    for (const m of ["veo-3.0-generate-preview", "sora-2", "Wan-AI/Wan2.1-T2V-14B", "kling-v2", "hunyuan-video", "some-video-model"]) expect(guessModelType(m)).toBe("video");
    for (const m of ["qwen3", "claude-sonnet-5-5", "gemini-2.5-pro", "gpt-4o-mini-transcribe", "gpt-4o-mini-tts"]) expect(guessModelType(m)).not.toMatch(/embeddings|image|video/);
  });

  it("names every model type the Models page offers", () => {
    expect(MODEL_TYPES).toEqual(["chat", "transcription", "speech", "embeddings", "image", "video"]);
  });
});

describe("voice", () => {
  it("transcribes through the provider's /audio/transcriptions as a form upload", async () => {
    const f = fake(() => new Response(JSON.stringify({ text: "hello there" })));
    const text = await transcribe(config.providers[1]!, "gpt-4o-mini-transcribe", new Uint8Array([1, 2, 3]), "audio/webm", f.fetch);
    expect(text).toBe("hello there");
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(headersOf(call).authorization).toBe("Bearer sk-oai");
    const form = call.init.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect((form.get("file") as File).name).toBe("speech.webm");
  });

  it("speaks through /audio/speech and returns the audio bytes", async () => {
    const f = fake(() => new Response(new Uint8Array([9, 8, 7])));
    const bytes = await synthesize(config.providers[1]!, "gpt-4o-mini-tts", "Hi", "nova", f.fetch);
    expect([...bytes]).toEqual([9, 8, 7]);
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(JSON.parse(String(call.init.body))).toEqual({ model: "gpt-4o-mini-tts", input: "Hi", voice: "nova", response_format: "mp3" });
  });

  it("refuses Anthropic, which has no audio routes, and reports a provider's failure", async () => {
    await expect(transcribe(config.providers[0]!, "x", new Uint8Array(), "audio/webm", fake(() => new Response("")).fetch)).rejects.toThrow("does not transcribe");
    await expect(synthesize(config.providers[0]!, "x", "hi", null, fake(() => new Response("")).fetch)).rejects.toThrow("does not speak");
    await expect(synthesize(config.providers[1]!, "x", "hi", null, fake(() => new Response("nope", { status: 500 })).fetch)).rejects.toThrow("OpenAI could not speak (500): nope");
  });
});

describe("embeddings", () => {
  const vectors = (rows: Array<{ index: number; embedding: number[] }>): Response => new Response(JSON.stringify({ object: "list", data: rows }));

  it("embeds through the provider's /embeddings with its key, one vector per text in order", async () => {
    const f = fake(() => vectors([{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }]));
    expect(await embed(config.providers[1]!, "text-embedding-3-small", ["a", "b"], f.fetch)).toEqual([[1, 0], [0, 1]]);
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/embeddings");
    expect(call.init.method).toBe("POST");
    expect(headersOf(call).authorization).toBe("Bearer sk-oai");
    expect(JSON.parse(String(call.init.body))).toEqual({ model: "text-embedding-3-small", input: ["a", "b"] });
  });

  it("calls Gemini's OpenAI-compatible surface and a keyless compatible server at their own addresses", async () => {
    const f = fake(() => vectors([{ index: 0, embedding: [0.5, 0.5] }]));
    await embed({ ...config.providers[3]!, apiKey: "g" }, "gemini-embedding-001", ["x"], f.fetch);
    await embed(config.providers[2]!, "nomic-embed-text", ["x"], f.fetch);
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/openai/embeddings",
      "http://localhost:11434/v1/embeddings",
    ]);
    expect(headersOf(f.calls[1]!).authorization).toBeUndefined();
  });

  it("makes no call for no texts", async () => {
    const f = fake(() => vectors([]));
    expect(await embed(config.providers[1]!, "m", [], f.fetch)).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses in plain words: Anthropic, no key, no base URL, the provider's error, a short answer", async () => {
    const none = fake(() => new Response("")).fetch;
    await expect(embed(config.providers[0]!, "m", ["a"], none)).rejects.toThrow("Anthropic has no embeddings models");
    await expect(embed(config.providers[3]!, "m", ["a"], none)).rejects.toThrow("Gemini has no API key");
    await expect(embed({ id: "x", kind: "openai-compatible", name: "X" }, "m", ["a"], none)).rejects.toThrow("X has no base URL");
    await expect(embed(config.providers[1]!, "m", ["a"], fake(() => new Response("bad model", { status: 404 })).fetch)).rejects.toThrow("OpenAI could not embed (404): bad model");
    await expect(embed(config.providers[1]!, "m", ["a", "b"], fake(() => vectors([{ index: 0, embedding: [1] }])).fetch)).rejects.toThrow("OpenAI answered 1 embeddings for 2 texts");
  });
});
