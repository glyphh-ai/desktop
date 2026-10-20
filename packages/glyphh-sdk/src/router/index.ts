/**
 * router/index.ts — `@glyphh/sdk/router`: THE MODEL ROUTER, in process.
 *
 * The loop speaks one wire, Anthropic Messages, to one address. On the server
 * that address was the gateway; here it is this router, handed to the loop as
 * its `fetch`: a POST to `${ROUTER_BASE_URL}/v1/messages` is answered by the
 * provider that serves the turn's model, everything else (an MCP server, a web
 * fetch) passes straight through. So every model call the loop makes — a turn,
 * a compaction, a sub-agent on its own model — is routed the same way, and the
 * loop never learns there is more than one provider.
 *
 *   anthropic          relayed as Messages: tool_use, thinking and
 *                      cache_control survive untouched
 *   openai, gemini,    translated to OpenAI chat-completions and back
 *   openai-compatible  (runtime/anthropic-openai.ts, the gateway's converter),
 *                      which is what Gemini, Ollama, LM Studio, OpenRouter,
 *                      Groq and the rest of the open tail speak
 *
 * A model is named `<providerId>::<model>`. A bare name (a chat saved before
 * providers existed) goes to the first provider that lists it, else to the
 * Anthropic provider when it looks like a Claude model.
 */

import { toOpenAIRequest, toAnthropicResponse, createStreamTranslator, type AnthropicRequest } from "../runtime/anthropic-openai.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** How a provider is called. */
export type ProviderKind = "anthropic" | "openai" | "gemini" | "openai-compatible";
export const PROVIDER_KINDS: readonly ProviderKind[] = ["anthropic", "openai", "gemini", "openai-compatible"];

/** What a model is for: the agent's turns, dictation, reading replies aloud,
 *  embedding text for memory and search, or making images and video. */
export type ModelType = "chat" | "transcription" | "speech" | "embeddings" | "image" | "video";
export const MODEL_TYPES: readonly ModelType[] = ["chat", "transcription", "speech", "embeddings", "image", "video"];

export interface RouterProvider {
  id: string;
  kind: ProviderKind;
  name: string;
  /** Required for openai-compatible; the kind's own API otherwise. */
  baseUrl?: string;
  /** Optional for openai-compatible (a local server needs none). */
  apiKey?: string;
}

export interface RouterModel {
  /** `<providerId>::<model>` — what the picker stores and the loop sends. */
  id: string;
  provider: string;
  /** The provider's own name for it. */
  model: string;
  type: ModelType;
  label?: string;
}

export interface RouterConfig {
  providers: readonly RouterProvider[];
  models: readonly RouterModel[];
}

/** The address the loop is pointed at. Never resolved on the network. */
export const ROUTER_BASE_URL = "http://glyphh-router.local";
/** The loop's credential for the router: the router holds the real keys. */
export const ROUTER_TOKEN = "glyphh-router";

const DEFAULT_BASE: Record<Exclude<ProviderKind, "openai-compatible">, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  // Gemini's OpenAI-compatible surface: chat, models, audio and embeddings.
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};

/** Where a provider is called, without a trailing slash; "" when it has none. */
export function baseUrlOf(p: Pick<RouterProvider, "kind" | "baseUrl">): string {
  const base = p.baseUrl?.trim() || (p.kind === "openai-compatible" ? "" : DEFAULT_BASE[p.kind]);
  return base.replace(/\/+$/, "");
}

/** A model id as the picker stores it. */
export const modelId = (providerId: string, model: string): string => `${providerId}::${model}`;

/** The provider and the provider's own model name a model id routes to, or null. */
export function resolveModel(config: RouterConfig, id: string): { provider: RouterProvider; model: string } | null {
  const cut = id.indexOf("::");
  if (cut > 0) {
    const provider = config.providers.find((p) => p.id === id.slice(0, cut));
    return provider ? { provider, model: id.slice(cut + 2) } : null;
  }
  const listed = config.models.find((m) => m.model === id);
  const byList = listed && config.providers.find((p) => p.id === listed.provider);
  if (byList) return { provider: byList, model: id };
  const anthropic = /^claude-/.test(id) ? config.providers.find((p) => p.kind === "anthropic") : undefined;
  return anthropic ? { provider: anthropic, model: id } : null;
}

/** Claude models that take adaptive thinking and an effort (4.6 and later). */
export function claudeTakesEffort(model: string): boolean {
  return /^claude-(opus|sonnet|haiku|fable|mythos)-(4-[6-9]|5)(-\d+)?$/.test(model);
}

/** The loop's request as Anthropic's API takes it: the effort dial goes in
 *  `output_config.effort` and adaptive thinking streams a readable summary, on
 *  the models that take them. The gateway did this translation before. */
export function anthropicBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const { reasoning_effort: effort, ...rest } = body;
  const out: Record<string, unknown> = { ...rest, model };
  if (claudeTakesEffort(model)) {
    out.thinking = { type: "adaptive", display: "summarized" };
    if (typeof effort === "string" && effort) out.output_config = { effort };
  }
  return out;
}

/** An Anthropic-shaped error the loop reads as the provider's own words. */
function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message } }), {
    status, headers: { "content-type": "application/json" },
  });
}

/** The provider's own words from a failed call, kept short. */
async function upstreamError(res: Response, who: string): Promise<Response> {
  const text = await res.text().catch(() => "");
  let said = text.slice(0, 400);
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    said = (typeof j.error === "string" ? j.error : j.error?.message) ?? j.message ?? said;
  } catch { /* plain text */ }
  return errorResponse(res.status, `${who}: ${said || res.statusText}`);
}

/** The headers a provider authenticates with. */
export function authHeaders(p: RouterProvider): Record<string, string> {
  const key = p.apiKey?.trim();
  if (p.kind === "anthropic") return key ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { "anthropic-version": "2023-06-01" };
  return key ? { authorization: `Bearer ${key}` } : {};
}

async function relayAnthropic(p: RouterProvider, model: string, body: Record<string, unknown>, init: RequestInit, upstream: FetchLike): Promise<Response> {
  if (!p.apiKey?.trim()) return errorResponse(401, `${p.name} has no API key — add it in Settings › Models`);
  const res = await upstream(`${baseUrlOf(p)}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...authHeaders(p) },
    body: JSON.stringify(anthropicBody(body, model)),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  return res.ok ? res : upstreamError(res, p.name);
}

async function translateOpenAI(p: RouterProvider, model: string, body: AnthropicRequest, init: RequestInit, upstream: FetchLike): Promise<Response> {
  const base = baseUrlOf(p);
  if (!base) return errorResponse(400, `${p.name} has no base URL — set it in Settings › Models`);
  if (p.kind !== "openai-compatible" && !p.apiKey?.trim()) return errorResponse(401, `${p.name} has no API key — add it in Settings › Models`);
  const streaming = body.stream === true;
  // OpenAI proper wants max_completion_tokens; the compatible tail keeps max_tokens.
  const oai = toOpenAIRequest(body, model, { maxTokensKey: p.kind === "openai" ? "max_completion_tokens" : "max_tokens" });
  // A local server rarely knows the effort field and some refuse it outright.
  if (p.kind === "openai-compatible") delete oai.reasoning_effort;
  oai.stream = streaming;
  const res = await upstream(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(p) },
    body: JSON.stringify(oai),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (!res.ok) return upstreamError(res, p.name);
  const sent = (body.tools ?? []).map((t) => t.name);
  if (!streaming) {
    const json = (await res.json()) as Parameters<typeof toAnthropicResponse>[0];
    return new Response(JSON.stringify(toAnthropicResponse(json, model, sent)), { status: 200, headers: { "content-type": "application/json" } });
  }
  const translator = createStreamTranslator(model, sent);
  const reader = res.body?.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stream = new ReadableStream<Uint8Array>({
    // Read until there is something to hand on: a pull that enqueues nothing
    // is not called again, so a chunk that translates to no frames (an empty
    // reasoning delta, a usage-only chunk) would stall the turn for good.
    async pull(controller) {
      try {
        for (;;) {
          const next = reader ? await reader.read() : { done: true as const, value: undefined };
          if (next.done) {
            controller.enqueue(encoder.encode(translator.end()));
            controller.close();
            return;
          }
          const frames = translator.feed(decoder.decode(next.value, { stream: true }));
          if (frames) { controller.enqueue(encoder.encode(frames)); return; }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) { void reader?.cancel(reason); },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * The loop's `fetch`: the router answers its Messages calls and passes every
 * other request through. `config` is read per call, so a provider or key saved
 * in Settings applies to the very next turn.
 */
export function createRouterFetch(config: () => RouterConfig, upstream: FetchLike = (u, i) => fetch(u, i)): FetchLike {
  return async (input, init) => {
    if (input.replace(/\/+$/, "") !== `${ROUTER_BASE_URL}/v1/messages`) return upstream(input, init);
    let body: Record<string, unknown>;
    try { body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>; }
    catch { return errorResponse(400, "the request body is not JSON"); }
    const id = String(body.model ?? "");
    const route = resolveModel(config(), id);
    if (!route) return errorResponse(400, `No provider serves "${id}" — add it in Settings › Models`);
    try {
      return route.provider.kind === "anthropic"
        ? await relayAnthropic(route.provider, route.model, body, init, upstream)
        : await translateOpenAI(route.provider, route.model, body as unknown as AnthropicRequest, init, upstream);
    } catch (err) {
      if (init.signal?.aborted) throw err;
      return errorResponse(502, `${route.provider.name} is unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

/** The model names a provider offers, from its own list endpoint. */
export async function listProviderModels(p: RouterProvider, upstream: FetchLike = (u, i) => fetch(u, i)): Promise<string[]> {
  const base = baseUrlOf(p);
  if (!base) throw new Error("set a base URL first");
  const url = p.kind === "anthropic" ? `${base}/v1/models?limit=1000` : `${base}/models`;
  const res = await upstream(url, { method: "GET", headers: authHeaders(p), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${p.name} answered ${res.status}`);
  const j = (await res.json()) as { data?: Array<{ id?: string; name?: string }>; models?: Array<{ id?: string; name?: string }> };
  const rows = j.data ?? j.models ?? [];
  // Gemini's list names models "models/<id>"; the chat call wants the bare id.
  const names = rows.map((r) => String(r.id ?? r.name ?? "").replace(/^models\//, "")).filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** A guess at what a listed model is for, so a fetched list arrives typed. */
export function guessModelType(model: string): ModelType {
  if (/embed|(^|[^a-z0-9])(bge|e5)([^a-z0-9]|$)|nomic/i.test(model)) return "embeddings";
  if (/video|(^|[^a-z0-9])(veo|sora|wan|kling)([^a-z]|$)/i.test(model)) return "video";
  if (/flux|sdxl|stable-diffusion|dall-e|gpt-image|imagen/i.test(model)) return "image";
  if (/whisper|transcri|stt/i.test(model)) return "transcription";
  if (/tts|speech/i.test(model)) return "speech";
  return "chat";
}

// ── VOICE: transcription and speech on the OpenAI audio wire ────────────────

/** Speech to text through a provider's `/audio/transcriptions`. */
export async function transcribe(
  p: RouterProvider, model: string, audio: Uint8Array, mime: string, upstream: FetchLike = (u, i) => fetch(u, i),
): Promise<string> {
  if (p.kind === "anthropic") throw new Error(`${p.name} does not transcribe audio`);
  const base = baseUrlOf(p);
  if (!base) throw new Error(`${p.name} has no base URL`);
  const ext = mime.includes("mp4") ? "mp4" : mime.includes("mpeg") ? "mp3" : mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : "webm";
  const form = new FormData();
  form.append("file", new Blob([audio as BlobPart], { type: mime || "audio/webm" }), `speech.${ext}`);
  form.append("model", model);
  const res = await upstream(`${base}/audio/transcriptions`, { method: "POST", headers: authHeaders(p), body: form });
  if (!res.ok) throw new Error(`${p.name} could not transcribe (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = (await res.json()) as { text?: string };
  return String(j.text ?? "");
}

/** Text to speech through a provider's `/audio/speech`; the audio bytes (mp3). */
export async function synthesize(
  p: RouterProvider, model: string, text: string, voice: string | null, upstream: FetchLike = (u, i) => fetch(u, i),
): Promise<Uint8Array> {
  if (p.kind === "anthropic") throw new Error(`${p.name} does not speak`);
  const base = baseUrlOf(p);
  if (!base) throw new Error(`${p.name} has no base URL`);
  const res = await upstream(`${base}/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(p) },
    body: JSON.stringify({ model, input: text, voice: voice || "alloy", response_format: "mp3" }),
  });
  if (!res.ok) throw new Error(`${p.name} could not speak (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ── EMBEDDINGS on the OpenAI /embeddings wire ───────────────────────────────

/** Texts to vectors through a provider's `/embeddings`: OpenAI, Gemini's
 *  OpenAI-compatible surface, Together, Ollama and the rest of the compatible
 *  tail. Anthropic has no embeddings API. One vector per text, in order. */
export async function embed(
  p: RouterProvider, model: string, texts: readonly string[], upstream: FetchLike = (u, i) => fetch(u, i),
): Promise<number[][]> {
  if (p.kind === "anthropic") throw new Error(`${p.name} has no embeddings models — add one from OpenAI, Gemini or an OpenAI-compatible server`);
  const base = baseUrlOf(p);
  if (!base) throw new Error(`${p.name} has no base URL — set it in Settings › Models`);
  if (p.kind !== "openai-compatible" && !p.apiKey?.trim()) throw new Error(`${p.name} has no API key — add it in Settings › Models`);
  if (!texts.length) return [];
  const res = await upstream(`${base}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(p) },
    body: JSON.stringify({ model, input: [...texts] }),
  });
  if (!res.ok) throw new Error(`${p.name} could not embed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = (await res.json()) as { data?: Array<{ index?: number; embedding?: unknown }> };
  const rows = [...(j.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = rows.map((r) => (Array.isArray(r.embedding) ? r.embedding.map(Number) : []));
  if (vectors.length !== texts.length || vectors.some((v) => !v.length)) {
    throw new Error(`${p.name} answered ${vectors.length} embeddings for ${texts.length} texts`);
  }
  return vectors;
}

/** The voices the OpenAI speech wire names. Compatible servers mostly accept these too. */
export const OPENAI_VOICES: readonly string[] = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

export { startRouterServer, tokenMatches, presented, roughTokens, type RouterServer } from "./server.js";
