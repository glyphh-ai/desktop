/**
 * glyphh-loop.ts — THE GLYPHH LOOP (his order, 2026-09-21): our own agent loop,
 * a supported loop beside claude/codex/gemini, on ANY model the gateway serves.
 *
 * It exists only on the gateway lane: the Messages API calls ride the memory
 * bridge to the gateway on the member's own key, so the org's allow-list,
 * budgets and per-org prompt caching apply and every turn lands in Usage. No
 * vendor login, no terminal. It speaks the SAME renderer contract as the CLI
 * bridge (glyphh-agent:setup/delta/tool/approval/progress/permission/done/error),
 * so the Agent panel is unchanged; only the engine differs.
 *
 * Tools: the built-ins (files + shell, glyphh-loop-tools.ts), the app's own
 * local MCP server (glyphh_* tools), and the gateway's connection tools
 * (mcp_tool_search / mcp_tool_call). Permission is Glyphh's one vocabulary
 * projected onto tool kinds (glyphh-loop-core.ts); an ask parks the run on an
 * approval card the renderer already draws. Prompt caching marks the system
 * prompt; a long conversation is compacted by the model itself.
 *
 * State is process memory: a chat's messages live here for the app's life and
 * re-seed from the renderer's stored turns after a restart (the law: nothing
 * of ours on disk).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { WebContents } from "electron";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { gatewayCreds, mcpCreds } from "./gateway-token.js";
import { bridgeWrap } from "./memory-bridge.js";
import { startLocalMcpServer, localMcpStatus, localMcpGenToken } from "./local-mcp-server.js";
import { bareModel, orgRequiredModel } from "./cli-agents.js";
import { BUILTIN_TOOLS, runBuiltin, type ToolDef } from "./glyphh-loop-tools.js";
import {
  gate, toolKind, seedFromChat, shouldCompact, safeToolName, toolTitle, preview, systemPrompt,
  MAX_TOKENS_OUT, MAX_TOOL_ROUNDS, type LoopPermission, type SeedTurn,
} from "./glyphh-loop-core.js";

type MessageParam = Anthropic.MessageParam;
type ContentBlock = Anthropic.ContentBlock;

interface McpTool { client: Client; realName: string }

interface LoopChat {
  chatId: string;
  messages: MessageParam[];
  model: string;
  permission: LoopPermission;
  workdir: string;
  runId: string;
  sender: WebContents;
  abort: AbortController | null;
  running: boolean;
  nextApproval: number;
  approvals: Map<string, (allow: boolean) => void>;
  usage: { inTokens: number; outTokens: number; cacheRead: number };
  mcp: Map<string, McpTool>;
  tools: Anthropic.Tool[] | null;
  hasLocalMcp: boolean;
  hasGateway: boolean;
}

const chats = new Map<string, LoopChat>();

export interface LoopRunPayload {
  chatId: string;
  permission?: LoopPermission;
  model?: string;
  workdir?: string;
  workspace?: string;
  /** The chat's stored turns, to seed a conversation this process has not seen. */
  history?: SeedTurn[];
}

function emit(c: LoopChat, channel: string, payload: Record<string, unknown>): void {
  try { if (!c.sender.isDestroyed()) c.sender.send(channel, { runId: c.runId, ...payload }); } catch { /* window closed */ }
}

export function glyphhLoopHas(chatId: string): boolean { return chats.has(chatId); }
export const isGlyphhApproval = (id: string): boolean => /:g\d+$/.test(id);

// ── tools ─────────────────────────────────────────────────────────────────────

async function mcpTools(c: LoopChat): Promise<Anthropic.Tool[]> {
  const defs: Anthropic.Tool[] = [];
  const add = async (client: Client, tag: string) => {
    const listed = await client.listTools();
    for (const t of listed.tools ?? []) {
      const name = safeToolName(t.name);
      if (defs.some((d) => d.name === name) || BUILTIN_TOOLS.some((b) => b.name === name)) continue;
      c.mcp.set(name, { client, realName: t.name });
      defs.push({ name, description: (t.description ?? `${tag} tool ${t.name}`).slice(0, 1000), input_schema: (t.inputSchema as Anthropic.Tool.InputSchema) ?? { type: "object", properties: {} } });
    }
  };
  try {
    await startLocalMcpServer().catch(() => undefined);
    const { port } = localMcpStatus();
    if (port) {
      const token = localMcpGenToken("glyphh-loop", 365).token;
      const local = new Client({ name: "glyphh-loop", version: "1.0.0" });
      await local.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      await add(local, "Glyphh");
      c.hasLocalMcp = true;
    }
  } catch (err) {
    console.warn("[glyphh-loop] local MCP unavailable:", err instanceof Error ? err.message : err);
  }
  try {
    const creds = await mcpCreds();
    if (creds) {
      const gw = new Client({ name: "glyphh-loop", version: "1.0.0" });
      await gw.connect(new StreamableHTTPClientTransport(new URL(`${creds.baseUrl.replace(/\/$/, "")}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${creds.token}` } } }));
      await add(gw, "connection");
      c.hasGateway = c.mcp.has("mcp_tool_search");
    }
  } catch (err) {
    console.warn("[glyphh-loop] gateway MCP unavailable:", err instanceof Error ? err.message : err);
  }
  return defs;
}

async function toolset(c: LoopChat): Promise<Anthropic.Tool[]> {
  if (c.tools) return c.tools;
  const builtins: Anthropic.Tool[] = BUILTIN_TOOLS.map((t: ToolDef) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema }));
  c.tools = [...builtins, ...(await mcpTools(c))];
  return c.tools;
}

async function runTool(c: LoopChat, name: string, input: unknown, signal: AbortSignal): Promise<{ text: string; failed: boolean }> {
  if (BUILTIN_TOOLS.some((b) => b.name === name)) return runBuiltin(name, input, c.workdir, signal);
  const m = c.mcp.get(name);
  if (!m) return { text: `unknown tool ${name}`, failed: true };
  try {
    const r = await m.client.callTool({ name: m.realName, arguments: (input && typeof input === "object" ? input : {}) as Record<string, unknown> });
    const content = Array.isArray(r.content) ? r.content : [];
    const text = content.map((b: { type?: string; text?: string }) => (b.type === "text" ? b.text ?? "" : `[${b.type}]`)).join("\n");
    return { text: text || "(no output)", failed: r.isError === true };
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), failed: true };
  }
}

/** Park the run on an approval card; the renderer's answer resolves it. */
function askPermission(c: LoopChat, kind: string, title: string, detail: string): Promise<boolean> {
  const id = `${c.chatId}:g${c.nextApproval++}`;
  return new Promise((resolve) => {
    c.approvals.set(id, resolve);
    emit(c, "glyphh-agent:approval", { id, kind, title, detail: detail.slice(0, 2000) });
  });
}

// ── the loop ──────────────────────────────────────────────────────────────────

function chatFor(sender: WebContents, p: LoopRunPayload, text: string): LoopChat {
  let c = chats.get(p.chatId);
  if (!c) {
    const seeded = seedFromChat(p.history ?? [], text).map((m) => ({ role: m.role, content: m.content } as MessageParam));
    c = {
      chatId: p.chatId, messages: seeded, model: "", permission: p.permission ?? "ask", workdir: p.workdir || homedir(), runId: "", sender,
      abort: null, running: false, nextApproval: 1, approvals: new Map(), usage: { inTokens: 0, outTokens: 0, cacheRead: 0 }, mcp: new Map(), tools: null,
      hasLocalMcp: false, hasGateway: false,
    };
    chats.set(p.chatId, c);
  }
  c.sender = sender;
  if (p.permission) c.permission = p.permission;
  if (p.workdir) c.workdir = p.workdir;
  return c;
}

async function compact(c: LoopChat, client: Anthropic, signal: AbortSignal): Promise<void> {
  const transcript = c.messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content).slice(0, 4000)}`).join("\n\n");
  const res = await client.messages.create({
    model: c.model, max_tokens: 2000, system: "Summarize this conversation for the assistant that will continue it: goals, decisions, files touched, open threads, and anything the user asked to remember. Terse, factual, no preamble.",
    messages: [{ role: "user", content: transcript.slice(-400_000) }],
  }, { signal });
  const summary = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
  c.messages = [{ role: "user", content: `Summary of the conversation so far:\n\n${summary}` }, { role: "assistant", content: "Understood. I have the context and will continue from here." }];
  emit(c, "glyphh-agent:delta", { delta: "\n\n(compacted the earlier conversation)\n\n" });
}

export async function runGlyphhLoopTurn(sender: WebContents, p: LoopRunPayload, text: string): Promise<{ runId: string }> {
  const c = chatFor(sender, p, text);
  c.runId = `${p.chatId}:${Date.now()}`;
  if (c.running) {
    emit(c, "glyphh-agent:error", { error: "The Glyphh loop is still working on the last message. Stop it or wait for it to finish." });
    emit(c, "glyphh-agent:done", { stopped: true });
    return { runId: c.runId };
  }
  const creds = await gatewayCreds();
  if (!creds) {
    emit(c, "glyphh-agent:error", { error: "The Glyphh loop runs on the gateway. Your organization's gateway lane is off; an org admin turns it on under Settings → Organization." });
    emit(c, "glyphh-agent:done", { stopped: true });
    return { runId: c.runId };
  }
  const model = bareModel(p.model ?? "") || orgRequiredModel();
  if (!model) {
    emit(c, "glyphh-agent:error", { error: "Pick a model for the Glyphh loop: any model your organization runs on the gateway." });
    emit(c, "glyphh-agent:done", { stopped: true });
    return { runId: c.runId };
  }
  c.model = model;
  c.running = true;
  c.abort = new AbortController();
  const signal = c.abort.signal;
  const baseURL = (await bridgeWrap(creds.baseUrl, { folder: c.workdir, ...(p.workspace ? { workspace: p.workspace } : {}) })) ?? creds.baseUrl;
  const client = new Anthropic({ apiKey: creds.token, baseURL, maxRetries: 1, timeout: 600_000 });
  emit(c, "glyphh-agent:setup", { phase: "ready", model, loop: "glyphh" });
  if (text) c.messages.push({ role: "user", content: text });
  try {
    const tools = await toolset(c);
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: systemPrompt(c.workdir, { hasLocalMcp: c.hasLocalMcp, hasGateway: c.hasGateway }), cache_control: { type: "ephemeral" } }];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) break;
      const stream = client.messages.stream({ model, max_tokens: MAX_TOKENS_OUT, system, messages: c.messages, tools }, { signal });
      stream.on("text", (delta) => emit(c, "glyphh-agent:delta", { delta }));
      const final = await stream.finalMessage();
      c.usage.inTokens += final.usage.input_tokens;
      c.usage.outTokens += final.usage.output_tokens;
      c.usage.cacheRead += final.usage.cache_read_input_tokens ?? 0;
      emit(c, "glyphh-agent:progress", { inTokens: c.usage.inTokens, outTokens: c.usage.outTokens, cacheReadTokens: c.usage.cacheRead });
      c.messages.push({ role: "assistant", content: final.content as ContentBlock[] });
      const uses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (final.stop_reason !== "tool_use" || !uses.length) break;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        if (signal.aborted) break;
        const kind = toolKind(use.name);
        const title = toolTitle(use.name, use.input);
        let verdict = gate(c.permission, kind);
        if (verdict === "ask") verdict = (await askPermission(c, kind === "exec" ? "command" : kind === "edit" ? "edit" : "tool", title, JSON.stringify(use.input ?? {}, null, 2))) ? "allow" : "deny";
        if (verdict === "deny") {
          emit(c, "glyphh-agent:tool", { phase: "done", name: use.name, title, failed: true, preview: "not permitted in this mode" });
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: c.permission === "plan" ? "Not run: plan mode reads only. Describe the change instead." : "The user declined this step." });
          continue;
        }
        emit(c, "glyphh-agent:tool", { phase: "start", name: use.name, title });
        const r = await runTool(c, use.name, use.input, signal);
        emit(c, "glyphh-agent:tool", { phase: "done", name: use.name, title, failed: r.failed, preview: preview(r.text) });
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: r.failed, content: r.text.slice(0, 200_000) });
      }
      c.messages.push({ role: "user", content: results });
      if (shouldCompact(final.usage.input_tokens)) await compact(c, client, signal);
    }
    emit(c, "glyphh-agent:done", { stopped: signal.aborted });
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    if (!signal.aborted) emit(c, "glyphh-agent:error", { error: said });
    emit(c, "glyphh-agent:done", { stopped: true });
  } finally {
    c.running = false;
    c.abort = null;
    for (const resolve of c.approvals.values()) resolve(false);
    c.approvals.clear();
  }
  return { runId: c.runId };
}

export function stopGlyphhLoop(chatId: string): boolean {
  const c = chats.get(chatId);
  if (!c || !c.running) return false;
  c.abort?.abort();
  return true;
}

export function setGlyphhLoopPermission(chatId: string, permission: LoopPermission): boolean {
  const c = chats.get(chatId);
  if (!c) return false;
  c.permission = permission;
  emit(c, "glyphh-agent:permission", { permission });
  return true;
}

export function respondGlyphhApproval(id: string, allow: boolean): boolean {
  const chatId = id.split(":")[0] ?? "";
  const c = chats.get(chatId);
  const resolve = c?.approvals.get(id);
  if (!c || !resolve) return false;
  c.approvals.delete(id);
  resolve(allow);
  return true;
}

/** Sign-out: nothing of the last member's conversations stays in memory. */
export function forgetGlyphhLoops(): void {
  for (const c of chats.values()) { c.abort?.abort(); for (const m of c.mcp.values()) void m.client.close().catch(() => undefined); }
  chats.clear();
}
