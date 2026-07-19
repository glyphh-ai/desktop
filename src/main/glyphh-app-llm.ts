/**
 * glyphh-app-llm — the runtime behind an LLM app's MCP tools.
 *
 * An LLM app (appArchetype = 'llm') lends the user's OWN model over MCP at
 * `<slug>.glyphh.app/mcp`. The server-side scoped MCP server forwards each tool
 * call here over the relay (method `apps.llmTool`); this module makes the
 * actual provider call with the app's HOST-ONLY key — the key is decrypted only
 * in this main process and never leaves the machine.
 *
 * Tools (from the app's approved list):
 *   - send_prompt   → one-shot completion
 *   - use_tool      → function-calling passthrough (model PICKS a tool; we don't run it)
 *   - run_agent     → agentic loop (Claude Agent SDK apps only)
 *   - count_tokens  → cheap estimate, no inference
 *   - list_model    → report provider + model
 *
 * The provider dropdown values (claude / claude-agent-sdk / gemini / openai) map
 * to the agent runtime's provider ids (anthropic / openai / google) and to the
 * config-var key names the owner sets on the Config Vars tab.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { agentRun } from "./glyphh-app-agent.js";
import { secretValueFromRow } from "./app-secrets.js";
import { fetchOrgApps } from "./org-apps.js";

interface LlmAppRow {
  slug: string;
  name: string;
  appArchetype?: string | null;
  launchConfig?: Record<string, unknown> | null;
}

type RunProvider = "anthropic" | "openai" | "google";

// UI provider → agent runtime provider + candidate key names (first match wins).
const PROVIDER_MAP: Record<string, { run: RunProvider; keys: string[] }> = {
  "claude": { run: "anthropic", keys: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"] },
  "claude-agent-sdk": { run: "anthropic", keys: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"] },
  "gemini": { run: "google", keys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"] },
  "openai": { run: "openai", keys: ["OPENAI_API_KEY"] },
};

const DEFAULT_MODELS: Record<RunProvider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5",
  google: "gemini-2.5-flash",
};

async function findLlmApp(slug: string): Promise<LlmAppRow | undefined> {
  const key = String(slug || "").trim().toLowerCase();
  const apps = await fetchOrgApps().catch(() => [] as LlmAppRow[]);
  return apps.find((a) => a.appArchetype === "llm" && a.slug.toLowerCase() === key);
}

function resolveKey(app: LlmAppRow, keys: string[]): string | null {
  const lc = app.launchConfig as Record<string, unknown> | undefined;
  for (const k of keys) {
    const v = secretValueFromRow(lc, k);
    if (v) return v;
  }
  return null;
}

function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

/** Clamp the caller's requested output cap by the app's guardrail ceiling. */
function outputCap(args: Record<string, unknown>): number | undefined {
  const guard = Number(args.maxOutputTokens) > 0 ? Math.floor(Number(args.maxOutputTokens)) : undefined;
  const asked = Number(args.maxTokens) > 0 ? Math.floor(Number(args.maxTokens)) : undefined;
  if (guard && asked) return Math.min(guard, asked);
  return guard ?? asked;
}

/**
 * Execute one LLM-app tool. `args` is the caller's tool args, augmented by the
 * server with `provider`, `model`, and `maxOutputTokens` (the guardrail cap).
 */
export async function runLlmAppTool(slug: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const app = await findLlmApp(slug);
  if (!app) throw new Error(`unknown LLM app: ${slug}`);
  const lc = (app.launchConfig || {}) as { llm?: { provider?: string; model?: string } };
  const uiProvider = String((args.provider as string) || lc.llm?.provider || "claude");
  const mapped = PROVIDER_MAP[uiProvider] || PROVIDER_MAP["claude"];
  const model = String((args.model as string) || lc.llm?.model || DEFAULT_MODELS[mapped.run]);
  const maxTokens = outputCap(args);

  const needKey = (): string => {
    const k = resolveKey(app, mapped.keys);
    if (!k) throw new Error(`no API key configured — set ${mapped.keys[0]} on this app's Config Vars tab`);
    return k;
  };

  switch (tool) {
    case "list_model":
      return { provider: uiProvider, model };

    case "count_tokens":
      return { tokens: estimateTokens(String(args.text || "")), approximate: true };

    case "send_prompt": {
      const apiKey = needKey();
      const result = await agentRun(
        app.slug, app.name,
        {
          prompt: String(args.prompt || ""),
          system: args.system ? String(args.system) : undefined,
          provider: mapped.run, model, apiKey,
          tools: [], maxTurns: 1, ...(maxTokens ? { maxTokens } : {}),
        },
        { tools: [], dispatch: () => Promise.reject(new Error("send_prompt has no tools")) },
      );
      return { text: result.text, usage: result.usage };
    }

    case "run_agent": {
      if (uiProvider !== "claude-agent-sdk") {
        throw new Error("run_agent is only available on Claude Agent SDK apps");
      }
      const apiKey = needKey();
      const result = await agentRun(
        app.slug, app.name,
        {
          prompt: String(args.prompt || ""),
          system: args.system ? String(args.system) : undefined,
          provider: mapped.run, model, apiKey,
          tools: [], maxTurns: Number(args.maxTurns) || 6, ...(maxTokens ? { maxTokens } : {}),
        },
        { tools: [], dispatch: () => Promise.reject(new Error("this app declares no agent tools")) },
      );
      return { text: result.text, usage: result.usage, turns: result.turns };
    }

    case "use_tool":
      return useToolPassthrough(mapped.run, needKey(), model, maxTokens, args);

    default:
      throw new Error(`unknown LLM tool: ${tool}`);
  }
}

// ── use_tool: single-turn function-calling passthrough ───────────────────────
// The model chooses a tool + args; we return the choice WITHOUT executing it
// (the tools belong to the caller, not the app).

interface CallerTool { name: string; description?: string; inputSchema?: Record<string, unknown> }

interface ToolChoice { text: string; toolCalls: Array<{ name: string; args: Record<string, unknown> }>; usage?: { input_tokens: number; output_tokens: number } }

async function useToolPassthrough(
  provider: RunProvider,
  apiKey: string,
  model: string,
  maxTokens: number | undefined,
  args: Record<string, unknown>,
): Promise<ToolChoice> {
  const prompt = String(args.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");
  const system = args.system ? String(args.system) : undefined;
  const tools: CallerTool[] = Array.isArray(args.tools) ? (args.tools as CallerTool[]) : [];
  if (!tools.length) throw new Error("use_tool requires a non-empty `tools` array");

  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      max_tokens: maxTokens && maxTokens > 0 ? maxTokens : 1024,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description || t.name,
        input_schema: (t.inputSchema || { type: "object", properties: {} }) as Anthropic.Tool["input_schema"],
      })),
    });
    const text = resp.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("");
    const toolCalls = resp.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ name: b.name, args: (b.input || {}) as Record<string, unknown> }));
    return { text, toolCalls, usage: { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens } };
  }

  if (provider === "openai") {
    const client = new OpenAI({ apiKey });
    const resp = await client.responses.create({
      model,
      ...(system ? { instructions: system } : {}),
      input: [{ role: "user", content: prompt }],
      ...(maxTokens && maxTokens > 0 ? { max_output_tokens: maxTokens } : {}),
      tools: tools.map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description || t.name,
        parameters: (t.inputSchema || { type: "object", properties: {} }) as Record<string, unknown>,
        strict: false,
      })),
    });
    const toolCalls = resp.output
      .filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call")
      .map((c) => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(c.arguments || "{}"); } catch { /* keep {} */ }
        return { name: c.name, args: parsed };
      });
    return {
      text: resp.output_text || "",
      toolCalls,
      usage: resp.usage ? { input_tokens: resp.usage.input_tokens || 0, output_tokens: resp.usage.output_tokens || 0 } : undefined,
    };
  }

  // google
  const ai = new GoogleGenAI({ apiKey });
  const resp = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }] as never,
    config: {
      ...(system ? { systemInstruction: system } : {}),
      ...(maxTokens && maxTokens > 0 ? { maxOutputTokens: maxTokens } : {}),
      tools: [{
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description || t.name,
          parametersJsonSchema: t.inputSchema || { type: "object", properties: {} },
        })),
      }],
    },
  });
  const toolCalls = (resp.functionCalls || []).map((c) => ({ name: c.name || "", args: (c.args || {}) as Record<string, unknown> }));
  return {
    text: resp.text || "",
    toolCalls,
    usage: resp.usageMetadata
      ? { input_tokens: resp.usageMetadata.promptTokenCount || 0, output_tokens: resp.usageMetadata.candidatesTokenCount || 0 }
      : undefined,
  };
}
