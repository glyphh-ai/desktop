/**
 * glyphh-app-agent — the `agent.run` capability: a multi-turn, TOOL-USING
 * agent loop where the agent's tools are the app's own manifest tools. This
 * is what makes a Glyphh app agentic rather than scripted: the app hands the
 * model a goal and its own tool surface, and the model drives.
 *
 *   agent.run {
 *     prompt,                     // the goal
 *     system?,                    // agent persona/instructions
 *     provider?,                  // "anthropic" (default) | "openai" | "google"
 *     model?,                     // provider-specific override
 *     tools?,                     // names of the app's manifest tools to expose (default: all)
 *     maxTurns?,                  // model↔tool round-trips (default 6, max 12)
 *     apiKey?,                    // explicit key; usually omitted — see below
 *   } → { text, turns, toolCalls: [{ tool, args, ok, result|error }], usage? }
 *
 * Auth model — Glyphh itself has NO LLM, NO BYOK, NO agent. Apps are the
 * only agentic surface, and each app brings its own key: the user sets
 * <PROVIDER>_API_KEY on the app's Config Vars tab (encrypted, write-only —
 * see app-secrets.ts) and the host injects it per call. The key belongs to
 * the app, never to Glyphh; there is no global key store.
 *
 * Tool dispatch goes through the host's callAppTool path, so every call is
 * re-validated against the app's declared tools/capabilities. Manifest tools
 * backed by the agent.run capability itself are rejected at install
 * (glyphh-app-host) to keep the loop non-recursive.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

export interface AgentToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface AgentRunDeps {
  /** The app's manifest tools (the allowed universe). */
  tools: AgentToolSpec[];
  /** Re-validated dispatch into the app (worker handler or capability). */
  dispatch: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
}

interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AgentRunResult {
  text: string;
  turns: number;
  toolCalls: ToolCallRecord[];
  usage?: { input_tokens: number; output_tokens: number };
}

const DEFAULT_MAX_TURNS = 6;
const MAX_MAX_TURNS = 12;
const MAX_TOOL_CALLS = 32;
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5",
  google: "gemini-2.5-flash",
};

function defaultSystem(appName: string): string {
  return `You are the agent inside "${appName}", a Glyphh desktop app. Use the provided tools to accomplish the user's goal, then answer concisely with what you did and found.`;
}

/** Dispatch one tool call, recording the outcome; errors flow back to the
 *  model as tool results (agents should see failures, not crash on them). */
async function runTool(
  deps: AgentRunDeps,
  record: ToolCallRecord[],
  tool: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; payload: string }> {
  if (record.length >= MAX_TOOL_CALLS) {
    return { ok: false, payload: `tool-call budget exhausted (${MAX_TOOL_CALLS})` };
  }
  try {
    const result = await deps.dispatch(tool, args || {});
    record.push({ tool, args, ok: true, result });
    return { ok: true, payload: typeof result === "string" ? result : JSON.stringify(result ?? null) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    record.push({ tool, args, ok: false, error });
    return { ok: false, payload: `error: ${error}` };
  }
}

export async function agentRun(
  slug: string,
  appName: string,
  args: Record<string, unknown>,
  deps: AgentRunDeps
): Promise<AgentRunResult> {
  const prompt = String(args.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");
  const provider = String(args.provider || "anthropic").toLowerCase();
  const system = String(args.system || defaultSystem(appName));
  const maxTurns = Math.max(1, Math.min(MAX_MAX_TURNS, Number(args.maxTurns) || DEFAULT_MAX_TURNS));

  // Resolve the exposed tool subset — names must be the app's own tools.
  const requested = Array.isArray(args.tools) ? args.tools.map(String) : null;
  const tools = requested
    ? deps.tools.filter((t) => requested.includes(t.name))
    : deps.tools;
  if (requested && tools.length !== requested.length) {
    const known = new Set(deps.tools.map((t) => t.name));
    const missing = requested.filter((n) => !known.has(n));
    throw new Error(`unknown tools: ${missing.join(", ")} — agent tools must be the app's own manifest tools`);
  }

  const apiKey = String(args.apiKey || "").trim();
  if (!apiKey) {
    throw new Error(
      `no API key for provider "${provider}" — the user adds ${provider.toUpperCase()}_API_KEY on this app's Config Vars tab (app → edit → Config Vars)`
    );
  }
  const model = String(args.model || DEFAULT_MODELS[provider] || "");
  if (provider === "anthropic") return runAnthropic(apiKey, model, prompt, system, tools, maxTurns, deps);
  if (provider === "openai") return runOpenAI(apiKey, model, prompt, system, tools, maxTurns, deps);
  if (provider === "google") return runGemini(apiKey, model, prompt, system, tools, maxTurns, deps);
  throw new Error(`unknown provider: ${provider} (anthropic | openai | google)`);
}

// ── "anthropic" — @anthropic-ai/sdk with an app-supplied key ────────────────

async function runAnthropic(
  apiKey: string,
  model: string,
  prompt: string,
  system: string,
  tools: AgentToolSpec[],
  maxTurns: number,
  deps: AgentRunDeps
): Promise<AgentRunResult> {
  const client = new Anthropic({ apiKey });
  const record: ToolCallRecord[] = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  const toolDefs = tools.map((t) => ({
    name: t.name,
    description: t.description || t.name,
    input_schema: (t.inputSchema || { type: "object", properties: {} }) as Anthropic.Tool["input_schema"],
  }));

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  let text = "";
  for (let turn = 1; turn <= maxTurns; turn++) {
    const resp = await client.messages.create({
      model,
      max_tokens: 4096,
      system,
      messages,
      ...(toolDefs.length ? { tools: toolDefs } : {}),
    });
    usage.input_tokens += resp.usage.input_tokens;
    usage.output_tokens += resp.usage.output_tokens;
    text = resp.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("");

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUses.length || resp.stop_reason !== "tool_use") {
      return { text, turns: turn, toolCalls: record, usage };
    }
    messages.push({ role: "assistant", content: resp.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const { ok, payload } = await runTool(deps, record, tu.name, (tu.input || {}) as Record<string, unknown>);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: payload, is_error: !ok });
    }
    messages.push({ role: "user", content: results });
  }
  return { text, turns: maxTurns, toolCalls: record, usage };
}

// ── "openai" — openai SDK (Responses API) with an app-supplied key ──────────

async function runOpenAI(
  apiKey: string,
  model: string,
  prompt: string,
  system: string,
  tools: AgentToolSpec[],
  maxTurns: number,
  deps: AgentRunDeps
): Promise<AgentRunResult> {
  const client = new OpenAI({ apiKey });
  const record: ToolCallRecord[] = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  const toolDefs = tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description || t.name,
    parameters: (t.inputSchema || { type: "object", properties: {} }) as Record<string, unknown>,
    strict: false,
  }));

  let input: OpenAI.Responses.ResponseInput = [{ role: "user", content: prompt }];
  let text = "";
  for (let turn = 1; turn <= maxTurns; turn++) {
    const resp = await client.responses.create({
      model,
      instructions: system,
      input,
      ...(toolDefs.length ? { tools: toolDefs } : {}),
    });
    if (resp.usage) {
      usage.input_tokens += resp.usage.input_tokens || 0;
      usage.output_tokens += resp.usage.output_tokens || 0;
    }
    text = resp.output_text || text;

    const calls = resp.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
    if (!calls.length) return { text, turns: turn, toolCalls: record, usage };

    // Echo the model's output items back, then append one output per call.
    input = input.concat(resp.output as OpenAI.Responses.ResponseInput);
    for (const call of calls) {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(call.arguments || "{}"); } catch { /* keep {} */ }
      const { payload } = await runTool(deps, record, call.name, parsed);
      input.push({ type: "function_call_output", call_id: call.call_id, output: payload });
    }
  }
  return { text, turns: maxTurns, toolCalls: record, usage };
}

// ── "google" — @google/genai with an app-supplied key ───────────────────────

async function runGemini(
  apiKey: string,
  model: string,
  prompt: string,
  system: string,
  tools: AgentToolSpec[],
  maxTurns: number,
  deps: AgentRunDeps
): Promise<AgentRunResult> {
  const ai = new GoogleGenAI({ apiKey });
  const record: ToolCallRecord[] = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  const config = {
    systemInstruction: system,
    ...(tools.length
      ? {
          tools: [{
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description || t.name,
              parametersJsonSchema: t.inputSchema || { type: "object", properties: {} },
            })),
          }],
        }
      : {}),
  };

  const contents: Array<Record<string, unknown>> = [{ role: "user", parts: [{ text: prompt }] }];
  let text = "";
  for (let turn = 1; turn <= maxTurns; turn++) {
    const resp = await ai.models.generateContent({ model, contents: contents as never, config });
    if (resp.usageMetadata) {
      usage.input_tokens += resp.usageMetadata.promptTokenCount || 0;
      usage.output_tokens += resp.usageMetadata.candidatesTokenCount || 0;
    }
    text = resp.text || text;

    const calls = resp.functionCalls || [];
    if (!calls.length) return { text, turns: turn, toolCalls: record, usage };

    const modelContent = resp.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent as Record<string, unknown>);
    const parts: Array<Record<string, unknown>> = [];
    for (const call of calls) {
      const { ok, payload } = await runTool(deps, record, call.name || "", (call.args || {}) as Record<string, unknown>);
      parts.push({ functionResponse: { name: call.name, response: ok ? { result: payload } : { error: payload } } });
    }
    contents.push({ role: "user", parts });
  }
  return { text, turns: maxTurns, toolCalls: record, usage };
}
