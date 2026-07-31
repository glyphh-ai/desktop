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
import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getPreference } from "./stores/preferences-db";
import { glyphhPath } from "./app-paths";
import { runModel, runMaxOutputTokens, currentLoop, resolveRoles } from "./loop-selections";
import { glyphhMode, registerGlyphhPermissionIpc } from "./glyphh-agent-permissions";
import { captureRun } from "./glyphh-agent-training";
import { executeGlyphhTool, glyphhToolDefs, connectorWireTools, setRunAttachments, clearRunAttachments, activeAgentRuns, type ConnectorWireDef } from "./glyphh-agent-tools";
import { selectConnectorTools } from "./tool-vectors";
import {
  pickAttachments, classifyPaths, saveClipboardImage, validAttachments,
  attachmentPromptBlock, attachmentVisionBlocks, type AttachRef,
} from "./glyphh-agent-attachments";
import { indexChatTurns, shortTermRecallBlock, pruneTurnVectors } from "./glyphh-agent-recall";
import { refreshWorkspaceIndex, relevantFilesHint } from "./workspace-index";
import { stopEmbedServer } from "./glyphh-agent-embeddings";
import { GLYPHH_APP_SPEC } from "@glyphh/client";
import { fetchOrgApps } from "./org-apps";
import { assemblePrompt, compactIfNeeded, compactNow, registerGlyphhContextIpc } from "./glyphh-agent-context";
import { getExplicitWorkingDirectory } from "./working-directory";
import { getClient } from "./glyphh-client";
import { startInterceptor, type Interceptor } from "@glyphh/client/runtime";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

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

/** The hosted harness speaks as "Claude Code" and hints at ITS OWN CLI flags —
 *  neither exists for Glyphh users. Re-voice harness errors as Glyphh's own
 *  before they reach the chat. Model ids like "claude-sonnet-5" are data, not
 *  branding, and pass through untouched. */
function brandError(message: string): string {
  return message
    .replaceAll("Claude Code", "Glyphh")
    .replace(/Run --model to pick a different model\.?/g, "Pick a different model from the composer's model chip.")
    .replace(/Run \/login[^.]*\./g, "Sign in again from Settings.");
}

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
  ipcMain.handle("glyphh-agent-run", async (e, payload: { chatId: string; attachments?: AttachRef[]; workdir?: string; chat?: boolean; mode?: "chat" | "cowork" | "code" }) => {
    const chatId = String(payload?.chatId || "");
    if (!chatId) throw new Error("chatId is required");
    // Only the SAME session serializes — other sessions run concurrently.
    if (activeRuns.has(chatId)) throw new Error("this session is already running — stop it or wait");
    // Sessions run inside a folder the USER chose — never ~/, never the
    // launch cwd. The SESSION's own folder (stamped by its layout or the
    // pick made while it was current) wins over the global pick, so
    // concurrent sessions can work different projects at once.
    const runWorkdir = (typeof payload?.workdir === "string" && payload.workdir) || getExplicitWorkingDirectory();
    if (!runWorkdir) throw new Error("NO_WORKDIR: pick a working folder to start");
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
    activeAgentRuns.set(chatId, { runId: id, workdir: runWorkdir, startedAt: Date.now() });
    // CHAT mode: a plain completion — the same lifecycle events the renderer
    // already speaks, but NO tools, no agent harness, no packet — a fraction
    // of the tokens of a Work turn.
    const mode = payload?.mode ?? (payload?.chat ? "chat" : "code");
    const runner = mode === "chat"
      ? chatRun(e.sender, id, messages, ctrl, replyBudget)
      : sdkRun(e.sender, id, messages, ctrl, attachments, chatId, runWorkdir, mode);
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

/** Extra workspace context appended to the system prompt (app library +
 *  connected accounts) so open_app and connector tools target real names. */
async function workspaceExtras(): Promise<string> {
  let appList = "";
  try {
    const apps = await fetchOrgApps();
    appList = apps.slice(0, 48).map((a) => a.slug || a.name).join(", ");
  } catch { /* offline — open_app still resolves by name */ }
  let connList = "";
  try {
    const { getClient } = await import("./glyphh-client");
    const connections = await getClient().connections.list();
    connList = [...new Set(connections.map((c) => String(c.slug || "")).filter(Boolean))].join(", ");
  } catch { /* signed out */ }
  // The ACTIVE loop's role→model bindings are the user's standing instruction
  // for who does what — without this block the agent runs everything itself
  // and has to be TOLD "use mistral for the build" every session.
  let loopBlock = "";
  try {
    const loop = currentLoop();
    const roles = await resolveRoles(loop);
    if (roles.length > 1) {
      const lead = roles[0]!;
      const others = roles.slice(1).map((r) => `"${r.name}" → ${r.modelId ?? "(no model bound)"}`).join(", ");
      loopBlock =
        `ACTIVE LOOP: "${loop}". Your own turns run as its "${lead.name}" role (${lead.modelId ?? "default model"}). ` +
        `The user bound the other roles to specific models on purpose: ${others}. ` +
        `Work that belongs to another role — e.g. implementation/build packets when there is a "builder" or "worker" role — ` +
        `MUST be delegated with run_role(role, task) instead of done by you, automatically, without the user asking. ` +
        `Say which role executed what in your reply.`;
    }
  } catch { /* offline — the loop block is advisory */ }
  return [
    appList ? `The user's app library (use these names with open_app — prefer the specific app over 'browser'): ${appList}` : "",
    connList ? `Connected accounts: ${connList} — each one's API tools are FIRST-CLASS tools in your toolset (real schemas; call them directly, never invent names).` : "",
    loopBlock,
    "RULE: the working folder ROOT holds the current app's project — build it there, then call update_app() to ship it (it packages the built dist/, never your source). After any change, rebuild + update_app or tool calls run the stale installed version.",
    "RULE: to SHOW the user an app you built or deployed, open it in the Browser panel — open_browser(<deployed URL>) — never the raw app panel. Only fall back to open_app(<slug>) when there is no reachable URL (local-only install, or the deployed app requires a login the embedded browser lacks).",
    "RULE: update_app() is the ONLY way to ship — never a CLI, never npx, and NEVER any login/device-auth flow. Your session is already authenticated; initiating authentication is forbidden.",
    GLYPHH_APP_SPEC,
    "Ada is your catalog: ada_recall(\"find email\") finds tools/apps/layouts by meaning; ada_ask({op:\"who\", conditions:{\"entity.kind\":\"tool\",\"relational.object\":\"gmail\"}}) lists a connector's tools exactly.",
    "MEMORY: you have layers — Ada (long-term facts), the rolling summary (mid-term), and <relevant_earlier_context> blocks (short-term recall of this session's own turns). On unfamiliar code, semantic_search(query) FIRST — it finds the right spans by meaning; read_file the spans it names instead of whole files.",
  ].filter(Boolean).join("\n\n");
}

/** A CHAT turn: one tool-less completion through the gateway, spoken in the
 *  run lifecycle the renderer already understands. */
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
    const text = await glyphhComplete(messages, { maxTokens, signal: ctrl.signal });
    if (ctrl.signal.aborted) { emit("glyphh-agent:done", { stopped: true }); return; }
    emit("glyphh-agent:delta", { delta: text });
    emit("glyphh-agent:done", { stopped: false });
  } catch (err) {
    if (ctrl.signal.aborted) { emit("glyphh-agent:done", { stopped: true }); return; }
    emit("glyphh-agent:error", { error: err instanceof Error ? err.message : String(err) });
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
  const ask = String(base[base.length - 1]?.content ?? "");

  // A leading /slug is a SKILL reference (the composer's "/" menu, or a
  // "Create with AI" seed): resolve it to the skill's instruction body so the
  // model runs the skill instead of guessing what the token means. Unknown
  // slugs pass through untouched — the text may just be a path.
  let skillSeed = "";
  const slashRef = /^\/([a-z0-9_-]+)\b/.exec(ask.trim());
  if (slashRef) {
    try {
      const skill = await getClient().skills.get(slashRef[1]!);
      skillSeed = `## Skill: ${skill.name}\n${skill.prompt}`;
    } catch { /* not a skill — send as typed */ }
  }
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

  // System prompt = assembled base system (persona + memory + summary) +
  // workspace extras — and NOTHING that changes per turn. Anthropic's
  // prompt cache is prefix-based (tools → system → messages): keeping this
  // block byte-stable between runs means every send within the cache TTL
  // re-reads the big prefix at 10% price instead of re-writing it. Prior
  // turns ride the USER message instead (messages churn anyway).
  const history = base.slice(1, -1)
    .map((m) => `${m.role === "user" ? "User" : "Glyphh"}: ${m.content}`)
    .join("\n");
  const system = [
    base[0]?.content ?? "",
    await workspaceExtras(),
  ].filter(Boolean).join("\n\n");
  // Attachments append a path manifest to the user turn; attached images
  // ALSO ride as real vision blocks (the router sees them and escalates —
  // local models are text-only).
  const attBlock = attachmentPromptBlock(attachments);
  // Layered memory, injected on the USER turn (messages churn anyway — the
  // cached system prefix stays untouched): short-term recall brings back
  // verbatim earlier turns that match this ask; the workspace hint points
  // at the semantically closest files before the first tool call.
  const [recallBlock, filesHint] = await Promise.all([
    chatId ? shortTermRecallBlock(chatId, ask).catch(() => "") : Promise.resolve(""),
    (async () => {
      const wd = getExplicitWorkingDirectory();
      return wd ? relevantFilesHint(wd, ask).catch(() => "") : "";
    })(),
  ]);
  const lastUser = [
    history ? `<conversation_so_far>\n${history}\n</conversation_so_far>` : "",
    recallBlock,
    skillSeed,
    ask,
    attBlock,
    filesHint,
  ].filter(Boolean).join("\n\n");
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
