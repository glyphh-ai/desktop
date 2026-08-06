/**
 * Glyphh — the agent loop, now the Claude Agent SDK's loop over the slicer.
 *
 * One loop, sliced serving: `glyphh-run` drives a Claude Agent SDK session
 * whose every model call lands on the local model router (model-router.ts).
 * The router serves routine turns from the on-device model (llama-server,
 * OpenAI-compatible, default 127.0.0.1:8089) and escalates hard turns to the
 * real Claude endpoint per the effort dial — local is free, credits only
 * burn on frontier turns.
 *
 * The Glyphh tool surface rides into the loop as an in-process MCP server
 * (glyphh-tools.ts defs; every execution still passes gateGlyphhAction).
 * Renderer contract is unchanged: deltas on `glyphh:delta`, tool activity
 * on `glyphh:tool`, termination via `glyphh-agent:done` / `glyphh:error`.
 * One run at a time; `glyphh-stop` aborts the active one.
 */

import { ipcMain, app, type WebContents } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getPreference } from "./stores/preferences-db";
import { glyphhPath } from "./app-paths";
import { runModel, runMaxOutputTokens } from "./loop-selections";
import { glyphhMode, registerGlyphhPermissionIpc } from "./glyphh-agent-permissions";
import { captureRun } from "./glyphh-agent-training";
import { executeGlyphhTool, glyphhToolDefs, connectorWireTools, setRunAttachments, clearRunAttachments, activeAgentRuns, type ConnectorWireDef } from "./glyphh-agent-tools";
import { selectConnectorTools } from "./tool-vectors";
import {
  pickAttachments, classifyPaths, saveClipboardImage, validAttachments,
  attachmentVisionBlocks, type AttachRef,
} from "./glyphh-agent-attachments";
import { indexChatTurns, pruneTurnVectors } from "./glyphh-agent-recall";
import { refreshWorkspaceIndex } from "./workspace-index";
import { stopEmbedServer } from "./glyphh-agent-embeddings";
import { assemblePrompt, compactIfNeeded, compactNow, loadSessions, registerGlyphhContextIpc } from "./glyphh-agent-context";
import { registerThreadsIpc } from "./threads-ipc";
import { getExplicitWorkingDirectory } from "./working-directory";
import { getClient } from "./glyphh-client";
import { startInterceptor, type Interceptor } from "@glyphh/sdk/runtime";
import { brandError, composeTurn, skillSeedFor, type ChatMessage } from "./glyphh-agent-prompt";
import { harnessRun } from "./glyphh-harness-run";
import { closeBridge } from "./harness-mcp-bridge";

export type { ChatMessage };

/**
 * THE CONVERGENCE FLAG. `GLYPHH_LOCAL_ROTOR=1` routes tool-bearing turns to the
 * machine's LOCAL HARNESS POD (glyphh-harness-run.ts) instead of the in-process
 * Agent SDK loop below — one harness everywhere, the desktop reduced to the
 * machine and the tool surface.
 *
 * It is OFF by default because the pod path is not yet at parity. What blocks
 * the flip, exactly:
 *
 *  1. WORKDIR. rrotor's `resolveRunConfig` computes the run's cwd itself
 *     (`HARNESS_HOME/sessions/<session>/workspace`) — `POST /run` has no field
 *     for a caller-chosen folder. The desktop's LENT tools do work in the
 *     user's real folder (the bridge passes the session workdir into
 *     executeGlyphhTool), but the pod's OWN preset tools — Bash, Read, Edit,
 *     Glob, Grep — anchor in its sandbox. For a Code session that is a silent
 *     wrong answer, not a missing feature. Needs a `workdir` on the run body,
 *     pod-side.
 *  2. CREDITS. `glyphh-agent:credits` comes from the local interceptor's usage
 *     stream; the pod calls the gateway directly and rrotor's v1 emits no
 *     `credits` frame (the vocabulary exists, the emit site does not), so the
 *     composer's per-run price goes blank.
 *  3. IMAGE ATTACHMENTS. The run body's `prompt` is a string — there is no
 *     vision-block channel — so pasted/attached images ride as PATHS only.
 *     Text attachments are fine (the manifest + the lent read_file).
 *
 * Everything else is wired and verified: streaming deltas, tool activity with
 * the desktop's own gate titles, ask/approval round-trips through the existing
 * IPC, stop, and token progress.
 */
export function localRotorEnabled(): boolean {
  return process.env.GLYPHH_LOCAL_ROTOR === "1";
}

// One live run PER SESSION (chatId) — sessions are independent: an agent
// working in one session never blocks a send in another. `stop` targets a
// chat; shutdown aborts everything.
const activeRuns = new Map<string, { id: string; ctrl: AbortController }>();

function baseUrl(): string {
  return String(getPreference("glyphhBaseUrl", "http://127.0.0.1:8089")).replace(/\/+$/, "");
}

/** The local runtime's OpenAI-compatible endpoint — the slicer serves local
 *  turns through this. */
export function glyphhBaseUrl(): string {
  return baseUrl();
}

// ── The agent's model endpoint ─────────────────────────────────────────────
//
// The Claude Agent SDK runs its loop in a subprocess that speaks Anthropic
// Messages over HTTP, so it needs a URL, not a function. The SDK's interceptor
// is that URL: it forwards each turn to the control plane with the caller's
// bearer and streams the reply back. It decides nothing — models, keys, cost,
// and refusals are all resolved server-side.
//
// One per process, started on first run and reused; the subprocess never holds
// a provider key, only the interceptor's per-process handle.
let interceptor: Interceptor | null = null;

// The interceptor is one-per-process; each run installs a sink keyed by its
// runId, and the usage frame routes by the x-glyphh-run tag the subprocess
// sends. An untagged frame (older subprocess) falls back to the only sink
// when exactly one run is live — ambiguous otherwise, so it drops.
const usageSinks = new Map<string, (u: { creditsMicro: number; inputTokens: number; outputTokens: number }) => void>();

/** The agent subprocess's OWN config home — never the user's ~/.claude. */
function agentConfigDir(): string {
  const dir = glyphhPath("agent-config");
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return dir;
}

/**
 * Absolute path to the SDK's NATIVE `claude` CLI binary, corrected for asar.
 *
 * The Agent SDK ships the CLI as a per-platform native binary in a sibling
 * package (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`) and, given
 * a path with no `.js` extension, spawns it DIRECTLY (the `executable: "node"`
 * option only applies to the JS-script path, never this one).
 *
 * In a PACKAGED build the SDK resolves that path INSIDE `app.asar` — but `app.asar`
 * is a file, so spawning a binary *through* it dies instantly with `spawn ENOTDIR`
 * (the error users saw on the very first agent turn). electron-builder already
 * `asarUnpack`s the binary, so we resolve the SDK's path and repoint it at the
 * unpacked tree. Returns undefined if resolution fails — the SDK then falls back
 * to its own default (correct in dev, where there is no asar).
 */
function nativeClaudeBinary(): string | undefined {
  const bin = process.platform === "win32" ? "claude.exe" : "claude";
  const name = `claude-agent-sdk-${process.platform}-${process.arch}`;
  // Anchor off the SDK's OWN main file — its per-platform package is NOT
  // resolvable from here directly (its package.json isn't in the exports map,
  // and in a packaged build npm nests it under the SDK's own node_modules).
  let sdkDir: string;
  try { sdkDir = dirname(require.resolve("@anthropic-ai/claude-agent-sdk")); } catch { return undefined; }
  const candidates = [
    join(sdkDir, "node_modules", "@anthropic-ai", name, bin), // nested (packaged build)
    join(dirname(sdkDir), name, bin),                         // hoisted sibling (dev)
  ];
  for (const raw of candidates) {
    // app.asar is a file; the real binary lives in app.asar.unpacked (asarUnpack).
    const p = app.isPackaged ? raw.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`) : raw;
    if (existsSync(p)) return p;
  }
  return undefined;
}

async function ensureInterceptor(): Promise<Interceptor> {
  if (interceptor) return interceptor;
  interceptor = await startInterceptor({
    client: getClient(),
    onError: (err: Error) => console.warn("[glyphh-agent] model turn failed:", err.message),
    onUsage: (u, runId) => {
      const sink = runId ? usageSinks.get(runId) : (usageSinks.size === 1 ? [...usageSinks.values()][0] : undefined);
      sink?.(u);
    },
  });
  return interceptor;
}

// ── Model access ──────────────────────────────────────────────────────────
//
// There is no local inference. Every turn runs on a HOSTED model resolved by
// the control plane (catalog ∩ org-supported ∩ workspace-allowed), so every
// turn is metered, attributable, and inside the allow-list. On-device
// EMBEDDINGS are unaffected — they are a separate, tiny model that never
// touches the governed catalog (see glyphh-agent-embeddings.ts).

/** Abort any in-flight run and stop the on-device embedder. Wired to app
 *  will-quit — nothing outlives the client. */
export function shutdownGlyphh(): void {
  for (const run of activeRuns.values()) run.ctrl.abort();
  stopEmbedServer();
  void interceptor?.close().catch(() => { /* already down */ });
  interceptor = null;
  // The lent tool surface dies with the app — its tools ARE this process.
  // The POD does not: it is a machine service (shared with the CLI, started
  // detached by the supervisor) and stays up for the next client.
  closeBridge();
}

// ── External access gate ──────────────────────────────────────────────────
//
// Glyphh tools surfaced OUTSIDE the client (cloud relay, local MCP server)
// must call this before running. It enforces the same master switches the
// MCP settings expose — defense in depth: the tool checks even though a
// disabled transport shouldn't be connected at all.
export function assertGlyphhExternalAllowed(via: "relay" | "local-mcp"): void {
  const enabled = via === "relay"
    ? getPreference<boolean>("relayEnabled", true) !== false
    : getPreference<boolean>("localMcpEnabled", false) === true;
  if (!enabled) {
    throw new Error(
      `Glyphh tools are disabled here: the ${via === "relay" ? "cloud relay" : "local MCP server"} ` +
      "is turned off in Settings → MCP Server",
    );
  }
}

export function registerGlyphhIpc(): void {
  registerGlyphhPermissionIpc();
  registerGlyphhContextIpc();
  // The renderer's transport to the server threads surface (thread-store.ts).
  registerThreadsIpc();
  ipcMain.handle("glyphh-agent-run", async (e, payload: { chatId: string; attachments?: AttachRef[]; workdir?: string; chat?: boolean; mode?: "chat" | "cowork" | "code" }) => {
    const chatId = String(payload?.chatId || "");
    if (!chatId) throw new Error("chatId is required");
    // Only the SAME session serializes — other sessions run concurrently.
    if (activeRuns.has(chatId)) throw new Error("this session is already running — stop it or wait");
    // Sessions run inside a folder the USER chose — never ~/, never the
    // launch cwd. The SESSION's own folder (stamped by its layout or the
    // pick made while it was current) wins over the global pick, so
    // concurrent sessions can work different projects at once.
    // The SESSION RECORD is the source of truth for the run's mode — a
    // renderer bug or version skew must never run a chat session with code
    // tools (or vice versa). The payload's mode is only the fallback for a
    // record the store hasn't caught up on.
    const stored = loadSessions().chats.find((c) => c.id === chatId);
    const mode = stored?.mode ?? (stored?.chat ? "chat" : undefined) ?? payload?.mode ?? (payload?.chat ? "chat" : "code");
    const runWorkdir = (typeof payload?.workdir === "string" && payload.workdir) || getExplicitWorkingDirectory();
    // A CHAT run executes no tools — it has no use for a folder, so it never
    // demands one. Tool-bearing modes still require the user's explicit pick.
    if (!runWorkdir && mode !== "chat") throw new Error("NO_WORKDIR: pick a working folder to start");
    // Composer attachments: validate paths, then whitelist them for reads
    // (attach = consent) for the duration of this run.
    const attachments = validAttachments(payload?.attachments);
    // Assembly is token-true (needs the server for /tokenize) — bring the
    // runtime up first so counting and completion share one warm process.
    const replyBudget = await runMaxOutputTokens();
    const messages = await assemblePrompt(chatId, replyBudget);
    const id = `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    setRunAttachments(id, attachments.map((a) => a.path));
    const ctrl = new AbortController();
    activeRuns.set(chatId, { id, ctrl });
    activeAgentRuns.set(chatId, { runId: id, workdir: runWorkdir || "", startedAt: Date.now() });
    // CHAT mode: a plain completion — the same lifecycle events the renderer
    // already speaks, but NO tools, no agent harness, no packet — a fraction
    // of the tokens of a Work turn.
    // CHAT mode is a plain completion either way — it never touches a harness.
    // Tool-bearing modes go to the LOCAL POD when the convergence flag is on,
    // otherwise to this process's own Agent SDK loop.
    const toolRun = localRotorEnabled() ? harnessRun : sdkRun;
    const runner = mode === "chat"
      ? chatRun(e.sender, id, messages, ctrl, replyBudget)
      : toolRun(e.sender, id, messages, ctrl, attachments, chatId, runWorkdir || undefined, mode);
    void runner.finally(() => {
      if (activeRuns.get(chatId)?.id === id) activeRuns.delete(chatId);
      if (activeAgentRuns.get(chatId)?.runId === id) activeAgentRuns.delete(chatId);
      clearRunAttachments(id);
      // Fold history AFTER the reply lands — a send never waits on it.
      // (The renderer saves the assistant turn right away; a short delay
      // lets that write land before compaction reads the store.)
      setTimeout(() => {
        void compactIfNeeded(chatId, replyBudget, (msgs, opts) => glyphhComplete(msgs, opts));
        // Memory housekeeping rides the same idle window: embed the new
        // turns (short-term recall) and freshen the workspace index.
        void indexChatTurns(chatId);
        pruneTurnVectors();
        const wd = getExplicitWorkingDirectory();
        if (wd) void refreshWorkspaceIndex(wd);
      }, 1500);
    });
    return { runId: id };
  });

  ipcMain.handle("glyphh-agent-compact", async (_e, p: { chatId?: string; focus?: string }) => {
    const chatId = String(p?.chatId || "");
    if (!chatId) return { ok: false, reason: "chatId is required" };
    if (activeRuns.has(chatId)) return { ok: false, reason: "wait for this session's run to finish" };
    return compactNow(chatId, await runMaxOutputTokens(), (msgs, opts) => glyphhComplete(msgs, opts), String(p?.focus || ""));
  });

  ipcMain.handle("glyphh-agent-stop", (_e, p?: { chatId?: string }) => {
    const chatId = String(p?.chatId || "");
    if (chatId) activeRuns.get(chatId)?.ctrl.abort();
    else for (const run of activeRuns.values()) run.ctrl.abort();   // legacy callers: stop everything
    return true;
  });

  // ── Composer attachments ──────────────────────────────────────────────
  ipcMain.handle("glyphh-agent-pick-attachments", (_e, p?: { mode?: "files" | "folder" }) => pickAttachments(p?.mode));
  ipcMain.handle("glyphh-agent-classify-paths", (_e, p: { paths?: unknown[] }) =>
    classifyPaths(((p?.paths ?? []) as unknown[]).map(String)));
  ipcMain.handle("glyphh-agent-save-clipboard-image", (_e, p: { bytes?: ArrayBuffer }) => {
    if (!p?.bytes) throw new Error("no image bytes");
    return saveClipboardImage(p.bytes);
  });

}

// ── Completion core — direct local completion (compaction, relay tools) ───
//
// The agent loop no longer calls this (the SDK loop talks to the slicer);
// it remains the ONE path for utility completions that must stay local and
// cheap: history folding, summarize-on-demand, relay/MCP one-shots.

export interface GlyphhCompleteOpts {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  /** Grammar-constrain the reply to this JSON schema (structured turns). */
  schema?: object;
}

export async function glyphhComplete(messages: ChatMessage[], opts: GlyphhCompleteOpts = {}): Promise<string> {
  // One metered turn through the SDK — the single egress for model traffic.
  // Non-streaming: every caller here (history folding, summaries, one-shot
  // relay/MCP turns) wants the finished text, and `onDelta` only ever drove a
  // progress spinner. It fires once with the whole reply so callers still work.
  const client = getClient();
  const model = await effectiveModel();
  if (!model) throw new Error("no model available — your workspace allows none, or you're signed out");
  const text = await client.gateway.text({
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: opts.temperature ?? 0.3,
    maxTokens: opts.maxTokens ?? 4096,
  });
  if (text) opts.onDelta?.(text);
  return text;
}

/**
 * The model a turn runs on: the current loop's "default" slot, resolved by the
 * server against what this caller may actually use.
 *
 * This goes through the same resolution the picker renders from, so the model
 * named in the dropdown is the model that runs. Null when nothing is allowed.
 */
export async function effectiveModel(): Promise<string | null> {
  return await runModel("default");
}


// ── The loop — Claude Agent SDK over the slicer ────────────────────────────
//
// query() runs the SDK's own agent loop; ANTHROPIC_BASE_URL points its every
// model call at the router, which serves locally or escalates per the dial.
// Tools ride as an in-process MCP server; the gate (mode model + approval
// cards) fires inside each execution exactly as before.

/** A CHAT turn: one tool-less STREAMING turn on the gateway's Messages
 *  edge — the same wire the agent loop rides, minus the tools. Deltas land
 *  in the thread token by token, exactly like Work/Code. */
async function chatRun(
  wc: WebContents,
  runId: string,
  messages: ChatMessage[],
  ctrl: AbortController,
  maxTokens: number,
): Promise<void> {
  const emit = (channel: string, data: Record<string, unknown>) => {
    try { if (!wc.isDestroyed()) wc.send(channel, { runId, ...data }); } catch { /* panel gone */ }
  };
  try {
    // SKILLS work in chat — a skill is INSTRUCTIONS, not a tool. A leading
    // /slug resolves to the skill's prompt body and rides the system prompt;
    // unknown slugs pass through (the text may just be a path).
    const skillSeed = await skillSeedFor(String(messages[messages.length - 1]?.content ?? ""));
    const model = await effectiveModel();
    if (!model) throw new Error("no model available — your workspace allows none, or you're signed out");
    // Anthropic shape: system is a TOP-LEVEL param, the messages array is
    // user/assistant only.
    const system = [skillSeed, ...messages.filter((m) => m.role === "system").map((m) => m.content)].filter(Boolean).join("\n\n");
    const convo = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
    // Chat's BASIC toolkit: Anthropic's SERVER-executed web search — real
    // lookups with zero client tool loop (the API runs the searches inline
    // and streams the researched answer). Claude models only; other
    // providers stay pure completion.
    const isClaude = /anthropic|claude/i.test(model);
    const res = await getClient().gateway.messages(
      {
        model,
        ...(system ? { system } : {}),
        messages: convo,
        max_tokens: maxTokens,
        stream: true,
        ...(isClaude ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] } : {}),
      },
      { signal: ctrl.signal },
    );
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`model turn failed (${res.status}): ${body.slice(0, 300)}`);
    }
    // Relay the SSE: text deltas stream straight into the thread.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sawText = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const ev = JSON.parse(payload) as { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string }; error?: { message?: string } };
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            sawText = true;
            emit("glyphh-agent:delta", { delta: ev.delta.text });
          } else if (ev.type === "content_block_start" && ev.content_block?.type === "server_tool_use") {
            // the API is running a web search — say so in the stream
            emit("glyphh-agent:tool", { phase: "start", name: "web_search" });
          } else if (ev.type === "error") {
            throw new Error(ev.error?.message || "stream error");
          }
        } catch (err) {
          if (err instanceof SyntaxError) continue;   // partial frame — next read completes it
          throw err;
        }
      }
    }
    if (ctrl.signal.aborted) { emit("glyphh-agent:done", { stopped: true }); return; }
    if (!sawText) emit("glyphh-agent:delta", { delta: "" });
    emit("glyphh-agent:done", { stopped: false });
  } catch (err) {
    if (ctrl.signal.aborted) { emit("glyphh-agent:done", { stopped: true }); return; }
    emit("glyphh-agent:error", { error: brandError(err instanceof Error ? err.message : String(err)) });
  }
}

async function sdkRun(
  wc: WebContents,
  runId: string,
  base: ChatMessage[],
  ctrl: AbortController,
  attachments: AttachRef[] = [],
  chatId = "",
  runWorkdir?: string,
  mode: "cowork" | "code" = "code",
): Promise<void> {
  const emit = (channel: string, data: Record<string, unknown>) => {
    try { if (!wc.isDestroyed()) wc.send(channel, { runId, ...data }); } catch { /* panel gone */ }
  };

  // Per-turn credits arrive from the interceptor's usage frame; accumulate them
  // across the run's turns and emit the running total. Credits are the server's
  // computed PRICE — the number the user is billed — not the vendor's raw cost.
  let runCreditsMicro = 0;
  usageSinks.set(runId, (u) => {
    runCreditsMicro += u.creditsMicro || 0;
    emit("glyphh-agent:credits", { creditsMicro: runCreditsMicro });
  });

  const defs = glyphhToolDefs(mode);
  // Connected accounts ride as FIRST-CLASS tools with their real input
  // schemas (governed catalog; refreshes when stale) — no guessed slugs.
  // Offline/signed-out just means an empty set. The FULL catalog would blow
  // the local model's 32k window (tool defs are un-squeezable prompt
  // prefix), so the ask selects a subset from the pre-encoded catalog;
  // find_tools/call_tool built-ins reach everything else mid-run.
  const connCatalog = await connectorWireTools().catch(() => [] as ConnectorWireDef[]);
  // One assembly for both run paths (glyphh-agent-prompt.ts): persona +
  // workspace extras as the cache-stable system prefix, prior turns + layered
  // memory + skill body + attachments on the churning user turn.
  const { system, lastUser, ask } = await composeTurn(base, chatId, attachments);
  const connDefs = mode === "code"
    ? []   // code pays for TWO connector defs (find_tools/call_tool), not a catalog subset
    : await selectConnectorTools(ask, connCatalog).catch(() => connCatalog.slice(0, 24));

  // The Glyphh surface as an in-process MCP server. Builtins ride as open
  // objects described by each tool's doc line (the executor validates);
  // connector tools carry their true JSON schemas from the catalog.
  const mcp = new McpServer({ name: "glyphh", version: "1.0.0" }, { capabilities: { tools: {} } });
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...defs.map((d) => ({
        name: d.name,
        description: d.doc,
        inputSchema: { type: "object" as const, additionalProperties: true },
      })),
      ...connDefs.map((d) => ({
        name: d.name,
        description: d.description,
        inputSchema: d.inputSchema as { type: "object"; [k: string]: unknown },
      })),
    ],
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (rq) => {
    const name = String(rq.params.name || "");
    const args = (rq.params.arguments ?? {}) as Record<string, unknown>;
    emit("glyphh-agent:tool", { phase: "start", name });
    const outcome = await executeGlyphhTool(wc, { name, arguments: args }, ctrl.signal, runWorkdir ? { workdir: runWorkdir } : undefined);
    emit("glyphh-agent:tool", {
      phase: "done",
      name,
      title: outcome.title,
      denied: outcome.denied,
      failed: outcome.result.startsWith("ERROR"),
      // Errors keep enough of the message to actually diagnose — a 160-char
      // preview ate API error bodies right where the reason starts.
      preview: outcome.result.slice(0, outcome.result.startsWith("ERROR") ? 600 : 160),
    });
    return { content: [{ type: "text" as const, text: outcome.result }], isError: outcome.result.startsWith("ERROR") };
  });

  // Attached images ride as real vision blocks alongside the composed turn's
  // path manifest (the in-process path can carry them; see the harness flag's
  // note for why the pod path can't yet).
  const visionBlocks = attachmentVisionBlocks(attachments);
  const prompt: string | AsyncIterable<SDKUserMessage> = visionBlocks.length
    ? (async function* (): AsyncGenerator<SDKUserMessage> {
        yield {
          type: "user",
          session_id: "",
          parent_tool_use_id: null,
          message: { role: "user", content: [...visionBlocks, { type: "text", text: lastUser }] },
        } as SDKUserMessage;
      })()
    : lastUser;

  const endpoint = await ensureInterceptor();

  let finalText = "";
  let runError = "";
  let turnsUsed = 0;
  // Real token accounting, like Claude Code: input (incl. cache) accumulates per
  // turn from message_start; output ticks live from message_delta. The chars/4
  // estimate this replaced measured only the visible prose — a fraction of the
  // real cost, and the reason a 10-minute run reported "381 tokens".
  let inTok = 0;        // cumulative input across the run's turns (+ cache)
  let outDone = 0;      // output from completed turns
  let outCur = 0;       // the in-flight turn's output (cumulative for that message)
  const outTok = (): number => outDone + outCur;
  try {
    const q = query({
      prompt,
      options: {
        cwd: runWorkdir ?? getExplicitWorkingDirectory() ?? undefined,
        // The user's pick, constrained to what their workspace allows.
        model: (await effectiveModel()) ?? undefined,
        systemPrompt: system,
        settingSources: [],
        tools: [], // no built-ins — the Glyphh surface is the whole toolset
        mcpServers: { glyphh: { type: "sdk", name: "glyphh", instance: mcp as never } },
        allowedTools: [...defs, ...connDefs].map((d) => `mcp__glyphh__${d.name}`),
        // Gating lives inside executeGlyphhTool (mode model + approval
        // cards) — the SDK's own prompt layer always defers to it.
        canUseTool: async (_tool, input) => ({ behavior: "allow" as const, updatedInput: input }),
        permissionMode: "default",
        persistSession: false,
        // Point the SDK at the UNPACKED native CLI binary. Without this a packaged
        // build resolves it inside app.asar and dies with `spawn ENOTDIR` on the
        // first turn. Undefined in dev → the SDK's own (correct) default is used.
        pathToClaudeCodeExecutable: nativeClaudeBinary(),
        // Token-level partials — the thread streams live instead of getting
        // each turn's text dumped whole at message end.
        includePartialMessages: true,
        abortController: ctrl,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: endpoint.url,
          // Tag this subprocess's requests so the shared interceptor can
          // attribute usage to THIS run when several sessions run at once.
          ANTHROPIC_CUSTOM_HEADERS: `x-glyphh-run: ${runId}`,
          // The interceptor's per-process handle, not a provider key: the real
          // credential is decrypted server-side and never reaches this machine.
          ANTHROPIC_API_KEY: endpoint.apiKey,
          ANTHROPIC_AUTH_TOKEN: undefined,
          // An app-owned config home. Without it the subprocess reads the
          // USER'S OWN Claude Code login (~/.claude OAuth) and presents that
          // instead of our key — the interceptor 401s it, the CLI treats 401
          // as retryable, and the composer spins forever. Isolating the config
          // dir is also a governance line: a turn must never be able to ride a
          // personal Anthropic subscription instead of the org's metered path.
          CLAUDE_CONFIG_DIR: agentConfigDir(),
          CLAUDE_CODE_USE_BEDROCK: undefined,
          CLAUDE_CODE_USE_VERTEX: undefined,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_TELEMETRY: "1",
        },
      },
    });

    // Live token stream (includePartialMessages). `sawPartials` guards the
    // fallback: an SDK without partial support still paints whole messages.
    let sawPartials = false;
    let pendingSep = false; // separate consecutive assistant turns with \n\n
    let lastProgressAt = 0;
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (ctrl.signal.aborted) break;
      if (msg.type === "stream_event") {
        const ev = (msg as unknown as {
          event?: {
            type?: string;
            delta?: { type?: string; text?: string };
            message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
            usage?: { output_tokens?: number };
          };
        }).event;
        if (ev?.type === "message_start") {
          // A new turn: bank the last turn's output, count this turn's input.
          outDone += outCur; outCur = 0;
          const u = ev.message?.usage;
          if (u) inTok += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        } else if (ev?.type === "message_delta" && typeof ev.usage?.output_tokens === "number") {
          outCur = ev.usage.output_tokens;  // cumulative for the current message
          const now = Date.now();
          if (now - lastProgressAt > 200) { lastProgressAt = now; emit("glyphh-agent:progress", { inTokens: inTok, outTokens: outTok() }); }
        } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          sawPartials = true;
          if (pendingSep && finalText) { finalText += "\n\n"; emit("glyphh-agent:delta", { delta: "\n\n" }); }
          pendingSep = false;
          finalText += ev.delta.text;
          emit("glyphh-agent:delta", { delta: ev.delta.text });
        }
      } else if (msg.type === "assistant") {
        turnsUsed++;
        const text = (msg.message.content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === "text")
          .map((b) => b.text || "")
          .join("");
        if (text) {
          if (sawPartials) {
            // Already streamed token-by-token — just mark the turn boundary
            // so the NEXT turn's first token gets a paragraph break.
            pendingSep = true;
          } else {
            finalText = finalText ? `${finalText}\n\n${text}` : text;
            emit("glyphh-agent:delta", { delta: finalText === text ? text : `\n\n${text}` });
          }
          const u = (msg as unknown as { message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } } }).message?.usage;
          if (u) { inTok += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0); outDone += u.output_tokens ?? 0; }
          emit("glyphh-agent:progress", { inTokens: inTok, outTokens: outTok() });
        }
      } else if (msg.type === "result") {
        const r = msg as { subtype: string; result?: string; num_turns?: number };
        if (r.subtype === "success") {
          if (!finalText && r.result) { finalText = r.result; emit("glyphh-agent:delta", { delta: finalText }); }
        } else {
          runError = `run ended: ${r.subtype.replaceAll("_", " ")}`;
        }
        if (typeof r.num_turns === "number") turnsUsed = r.num_turns;
        // The result's usage is the run's authoritative total — replace the
        // streamed estimate with it so the final footer is exact.
        const ru = (msg as unknown as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
        if (ru) {
          inTok = (ru.input_tokens ?? 0) + (ru.cache_read_input_tokens ?? 0) + (ru.cache_creation_input_tokens ?? 0);
          outDone = ru.output_tokens ?? 0; outCur = 0;
          emit("glyphh-agent:progress", { inTokens: inTok, outTokens: outTok() });
        }
      }
    }
    if (ctrl.signal.aborted) throw new Error("aborted");
    emit("glyphh-agent:progress", { inTokens: inTok, outTokens: outTok() });
    if (runError) emit("glyphh-agent:error", { error: brandError(runError) });
    else emit("glyphh-agent:done", { stopped: false });
  } catch (err) {
    if (ctrl.signal.aborted) {
      usageSinks.delete(runId);
      emit("glyphh-agent:done", { stopped: true });
      captureRun({ kind: "agent", mode: glyphhMode(), turnsUsed, stopped: true, messages: base });
      return;
    }
    runError = brandError(err instanceof Error ? err.message : String(err));
    emit("glyphh-agent:error", { error: runError });
  }
  // Stop routing usage frames to a finished run's emit — the next run installs
  // its own sink, but a stray late frame must not paint a dead panel.
  usageSinks.delete(runId);

  // The flywheel: transcript + outcome are next-era training data (the
  // tripwire corpus — frontier turns teach the local model by example).
  captureRun({
    kind: "agent",
    mode: glyphhMode(),
    turnsUsed,
    final: finalText,
    ...(runError ? { error: runError } : {}),
    messages: [...base, { role: "assistant", content: finalText }],
  });
}
