/**
 * byok-client — direct-to-provider streaming using the user's local API key.
 *
 * Phase 3 of THE-PIVOT-BYOK. Replaces the proxy round-trip with a fetch
 * straight to the provider's HTTPS endpoint. Adapters keep their old
 * shape (runByokStream(provider, req, sink, signal)) so the call sites
 * are a 1-line swap.
 *
 * Wire formats per provider:
 *   • anthropic     — POST /v1/messages          (Anthropic SSE: `event: <type>\ndata: <json>`)
 *   • openai        — POST /v1/chat/completions  (OpenAI SSE: `data: <json>` + `data: [DONE]`)
 *                     OR  POST /v1/responses      for GPT-5 / o-series reasoning
 *                     models, which are NOT served by chat/completions (they 404
 *                     with "only supported in v1/responses"). Different request
 *                     + SSE shape (`event: response.output_text.delta`).
 *   • xai           — POST /v1/chat/completions  (OpenAI-compatible)
 *   • perplexity    — POST /chat/completions     (OpenAI-compatible)
 *   • google/gemini — POST /v1beta/models/<model>:streamGenerateContent?alt=sse
 *
 * No SDK bundles — keeps yo-client lean and avoids version drift across
 * five separate SDKs. We pay one-time complexity to parse three SSE
 * dialects (Anthropic / OpenAI-style / Gemini SSE) and that's it.
 */

import {
  ProviderNotConfiguredError,
  type LLMProvider, type AdapterMessage, type AdapterTurnRequest, type AdapterTurnSink,
} from "./agent-adapter";
import * as providerKeys from "../provider-keys";

interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
}

const PROVIDER_TO_KEY: Record<LLMProvider, providerKeys.ProviderId> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  xai: "xai",
  perplexity: "perplexity",
};

export async function runByokStream(
  provider: LLMProvider,
  req: AdapterTurnRequest,
  sink: AdapterTurnSink,
  signal?: AbortSignal,
): Promise<string> {
  const key = await providerKeys.getKey(PROVIDER_TO_KEY[provider]);
  if (!key) throw new ProviderNotConfiguredError(provider);

  if (provider === "anthropic") return runAnthropic(key, req, sink, signal);
  if (provider === "google") return runGemini(key, req, sink, signal);
  // openai / xai / perplexity — all chat-completions compatible
  const baseUrl =
    provider === "openai"     ? "https://api.openai.com/v1" :
    provider === "xai"        ? "https://api.x.ai/v1" :
    /* perplexity */            "https://api.perplexity.ai";

  if (provider === "openai") {
    // GPT-5 and the o-series reasoning models are served ONLY by /v1/responses.
    if (openAINeedsResponsesApi(req.model)) {
      return runOpenAIResponses(baseUrl, key, req, sink, signal);
    }
    // Otherwise prefer chat/completions, but fall back to the Responses API if
    // OpenAI rejects the model as Responses-only. The 404 lands before any text
    // streams (res.ok is false), so retrying is safe — nothing was emitted yet.
    try {
      return await runChatCompletions(provider, baseUrl, key, req, sink, signal);
    } catch (err) {
      if (err instanceof Error && /only supported in v1\/responses/i.test(err.message)) {
        return runOpenAIResponses(baseUrl, key, req, sink, signal);
      }
      throw err;
    }
  }

  return runChatCompletions(provider, baseUrl, key, req, sink, signal);
}

/** OpenAI model families served only by the Responses API (not chat/completions):
 *  the GPT-5 line and the o-series reasoning models (o1/o3/o4). Matched loosely
 *  by prefix so dated/suffixed ids (gpt-5-mini, o3-2025-…, o4-mini) are covered. */
function openAINeedsResponsesApi(model: string): boolean {
  const m = model.trim().toLowerCase();
  return /^(gpt-5|o1|o3|o4)\b/.test(m) || /^(gpt-5|o1|o3|o4)-/.test(m);
}

// ── Anthropic ──────────────────────────────────────────────────────────────

async function runAnthropic(
  apiKey: string, req: AdapterTurnRequest, sink: AdapterTurnSink, signal?: AbortSignal,
): Promise<string> {
  // Anthropic's /v1/messages requires `system` separate from `messages`.
  const systemParts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of req.messages) {
    if (m.role === "system") systemParts.push(m.content);
    else messages.push({ role: m.role, content: m.content });
  }

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 4096,
    stream: true,
    messages,
  };
  if (systemParts.length > 0) body.system = systemParts.join("\n\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`anthropic ${res.status}: ${text.slice(0, 300)}`);
  }

  let fullText = "";
  const usage: UsageInfo = { input_tokens: 0, output_tokens: 0 };

  await consumeSSE(res.body, (frame) => {
    if (!frame.data) return;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(frame.data); } catch { return; }
    const type = (payload.type as string) || frame.event;
    if (type === "content_block_delta") {
      const delta = (payload as { delta?: { type?: string; text?: string } }).delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        fullText += delta.text;
        sink.onText?.(delta.text);
      }
    } else if (type === "message_start") {
      const msg = (payload as { message?: { usage?: { input_tokens?: number } } }).message;
      if (msg?.usage?.input_tokens != null) usage.input_tokens = msg.usage.input_tokens;
    } else if (type === "message_delta") {
      const u = (payload as { usage?: { output_tokens?: number } }).usage;
      if (u?.output_tokens != null) usage.output_tokens = u.output_tokens;
    } else if (type === "error") {
      const message = ((payload as { error?: { message?: string } }).error?.message) || "anthropic stream error";
      sink.onError?.(message);
      throw new Error(message);
    }
  }, signal);

  sink.onUsage?.({ ...usage, yos_amount: 0 });
  return fullText;
}

// ── OpenAI / xAI / Perplexity (chat-completions style) ─────────────────────

async function runChatCompletions(
  provider: LLMProvider,
  baseUrl: string,
  apiKey: string,
  req: AdapterTurnRequest,
  sink: AdapterTurnSink,
  signal?: AbortSignal,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: req.model,
    stream: true,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (req.maxTokens != null) body.max_tokens = req.maxTokens;
  // OpenAI's newer Responses API exposes usage by default in stream;
  // `stream_options: { include_usage: true }` makes the final chunk
  // carry token counts. Other compatible providers ignore it harmlessly.
  body.stream_options = { include_usage: true };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`${provider} ${res.status}: ${text.slice(0, 300)}`);
  }

  let fullText = "";
  const usage: UsageInfo = { input_tokens: 0, output_tokens: 0 };

  await consumeSSE(res.body, (frame) => {
    if (!frame.data || frame.data === "[DONE]") return;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(frame.data); } catch { return; }
    const choices = (payload as { choices?: Array<{ delta?: { content?: string }; message?: { content?: string }; finish_reason?: string }> }).choices;
    const choice = choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      fullText += delta;
      sink.onText?.(delta);
    } else {
      // Fallback: some compatible providers (e.g. Perplexity) deliver the whole
      // answer in `message.content` on a chunk instead of streaming deltas.
      const msg = choice?.message?.content;
      if (typeof msg === "string" && msg.length > fullText.length) {
        const added = msg.slice(fullText.length);
        fullText = msg;
        sink.onText?.(added);
      }
    }
    const u = (payload as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
    if (u) {
      if (u.prompt_tokens != null) usage.input_tokens = u.prompt_tokens;
      if (u.completion_tokens != null) usage.output_tokens = u.completion_tokens;
    }
  }, signal);

  sink.onUsage?.({ ...usage, yos_amount: 0 });
  return fullText;
}

// ── OpenAI Responses API (GPT-5 / o-series reasoning models) ───────────────

async function runOpenAIResponses(
  baseUrl: string,
  apiKey: string,
  req: AdapterTurnRequest,
  sink: AdapterTurnSink,
  signal?: AbortSignal,
): Promise<string> {
  // Responses API takes `input` (not `messages`); a system message maps to a
  // "developer" role item, and the output cap is `max_output_tokens` (which for
  // reasoning models also covers hidden reasoning tokens).
  const input = req.messages.map((m) => ({
    role: m.role === "system" ? "developer" : m.role,
    content: m.content,
  }));

  const body: Record<string, unknown> = {
    model: req.model,
    stream: true,
    input,
  };
  if (req.maxTokens != null) body.max_output_tokens = req.maxTokens;

  const res = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`openai ${res.status}: ${text.slice(0, 300)}`);
  }

  let fullText = "";
  const usage: UsageInfo = { input_tokens: 0, output_tokens: 0 };

  await consumeSSE(res.body, (frame) => {
    if (!frame.data || frame.data === "[DONE]") return;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(frame.data); } catch { return; }
    const type = (payload.type as string) || frame.event;
    if (type === "response.output_text.delta") {
      const delta = (payload as { delta?: string }).delta;
      if (typeof delta === "string" && delta.length > 0) {
        fullText += delta;
        sink.onText?.(delta);
      }
    } else if (type === "response.completed" || type === "response.incomplete") {
      const u = (payload as { response?: { usage?: { input_tokens?: number; output_tokens?: number } } }).response?.usage;
      if (u) {
        if (u.input_tokens != null) usage.input_tokens = u.input_tokens;
        if (u.output_tokens != null) usage.output_tokens = u.output_tokens;
      }
    } else if (type === "response.failed" || type === "error" || type === "response.error") {
      const message =
        (payload as { response?: { error?: { message?: string } } }).response?.error?.message ||
        (payload as { error?: { message?: string } }).error?.message ||
        "openai responses stream error";
      sink.onError?.(message);
      throw new Error(`openai: ${message}`);
    }
  }, signal);

  sink.onUsage?.({ ...usage, yos_amount: 0 });
  return fullText;
}

// ── Google Gemini ──────────────────────────────────────────────────────────

async function runGemini(
  apiKey: string, req: AdapterTurnRequest, sink: AdapterTurnSink, signal?: AbortSignal,
): Promise<string> {
  // Gemini's API treats system instructions separately and uses
  // role "user"/"model" instead of "user"/"assistant".
  const systemParts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  for (const m of req.messages) {
    if (m.role === "system") { systemParts.push(m.content); continue; }
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }

  const body: Record<string, unknown> = { contents };
  if (req.maxTokens != null) body.generationConfig = { maxOutputTokens: req.maxTokens };
  if (systemParts.length > 0) body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };

  // Normalize the model id: callers sometimes pass a "models/…" prefix, which
  // would double up in the path and 404. Strip it (and any stray whitespace).
  const modelId = req.model.trim().replace(/^models\//, "");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`google ${res.status}: ${text.slice(0, 300)}`);
  }

  let fullText = "";
  const usage: UsageInfo = { input_tokens: 0, output_tokens: 0 };

  await consumeSSE(res.body, (frame) => {
    if (!frame.data) return;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(frame.data); } catch { return; }
    const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates;
    const text = candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text === "string" && text.length > 0) {
      fullText += text;
      sink.onText?.(text);
    }
    const u = (payload as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }).usageMetadata;
    if (u) {
      if (u.promptTokenCount != null) usage.input_tokens = u.promptTokenCount;
      if (u.candidatesTokenCount != null) usage.output_tokens = u.candidatesTokenCount;
    }
  }, signal);

  sink.onUsage?.({ ...usage, yos_amount: 0 });
  return fullText;
}

// ── SSE parser ─────────────────────────────────────────────────────────────

interface ParsedFrame { event: string; data: string }

function parseFrame(frame: string): ParsedFrame {
  const out: ParsedFrame = { event: "message", data: "" };
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") out.event = value;
    else if (field === "data") out.data = out.data ? out.data + "\n" + value : value;
  }
  return out;
}

async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: ParsedFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (!frame.trim()) continue;
        onFrame(parseFrame(frame));
      }
    }
    if (buffer.trim()) onFrame(parseFrame(buffer));
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}
