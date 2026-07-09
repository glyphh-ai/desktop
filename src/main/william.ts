/**
 * William — the agent loop, now the Claude Agent SDK's loop over the slicer.
 *
 * One loop, sliced serving: `william-run` drives a Claude Agent SDK session
 * whose every model call lands on the local model router (model-router.ts).
 * The router serves routine turns from the on-device model (llama-server,
 * OpenAI-compatible, default 127.0.0.1:8089) and escalates hard turns to the
 * real Claude endpoint per the effort dial — local is free, credits only
 * burn on frontier turns.
 *
 * The Glyphh tool surface rides into the loop as an in-process MCP server
 * (william-tools.ts defs; every execution still passes gateWilliamAction).
 * Renderer contract is unchanged: deltas on `william:delta`, tool activity
 * on `william:tool`, termination via `william:done` / `william:error`.
 * One run at a time; `william-stop` aborts the active one.
 */

import { ipcMain, app, type WebContents } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getPreference } from "./stores/preferences-db";
import { effortMaxTokens, effortMaxTurns, williamEffort, williamMode, registerWilliamPermissionIpc } from "./william-permissions";
import { captureRun } from "./william-training";
import { executeWilliamTool, williamToolDefs } from "./william-tools";
import { GLYPHH_APP_SPEC } from "./glyphh-app-spec";
import { cachedServerGet } from "./server-cache";
import { assemblePrompt, compactIfNeeded, compactNow, registerWilliamContextIpc } from "./william-context";
import { downloadWilliamModel, resolveDesiredModel, localModelPath, refreshManifestIfStale, selectedModelId } from "./william-models";
import { getExplicitWorkingDirectory } from "./working-directory";
import { startModelRouter, stopModelRouter, registerModelRouterIpc, effectiveFrontierModel } from "./model-router";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

let active: { id: string; ctrl: AbortController } | null = null;

function baseUrl(): string {
  return String(getPreference("williamBaseUrl", "http://127.0.0.1:8089")).replace(/\/+$/, "");
}

/** The local runtime's OpenAI-compatible endpoint — the slicer serves local
 *  turns through this. */
export function williamBaseUrl(): string {
  return baseUrl();
}

export function isWilliamRunActive(): boolean {
  return !!active;
}

// ── Runtime management — the model server is invisible to the user ────────
//
// ensureWilliamServing() makes 127.0.0.1:<port> answer before any run:
// adopt a server that's already up (a dev terminal instance keeps working),
// else spawn llama-server as a managed child and wait through the model
// load. The child dies with the app (will-quit → shutdownWilliam). If the
// configured base URL points at another machine, we never spawn — reach it
// or fail with a clear error.

const MODEL_FILE = "qwen2.5-coder-14b-instruct-q4_k_m.gguf";

let managed: ChildProcess | null = null;
let ensuring: Promise<void> | null = null; // single-flight

/** Port to manage, or null when the base URL isn't this machine. */
function localPort(): number | null {
  try {
    const u = new URL(baseUrl());
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
      return Number(u.port) || 8089;
    }
  } catch { /* malformed pref */ }
  return null;
}

/** llama-server binary: preference → brew paths → PATH (dev terminals). */
function findServerBin(): string {
  const pref = String(getPreference("williamServerBin", "")).trim();
  const candidates = [
    ...(pref ? [pref] : []),
    "/opt/homebrew/bin/llama-server",
    "/usr/local/bin/llama-server",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return "llama-server";
}

/** Model weights for the SELECTED tier: explicit path pref → the selected
 *  manifest entry's local file → dev-checkout fallback (14B). */
function findModel(): string | null {
  const pref = String(getPreference("williamModelPath", "")).trim();
  if (pref && existsSync(pref)) return pref;
  const desired = resolveDesiredModel();
  if (desired) {
    const local = localModelPath(desired);
    if (local) return local;
    // Selected tier not downloaded yet — the ensure path downloads it.
    return null;
  }
  const candidates = [
    join(app.getPath("userData"), "models", MODEL_FILE),
    join(homedir(), "development", "yo", "glyphh-william", "models", MODEL_FILE),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** The managed child's model path — a selection change restarts lazily. */
let managedModelPath: string | null = null;

async function healthy(timeoutMs = 1200): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function ensureWilliamServing(): Promise<void> {
  if (ensuring) return ensuring;
  ensuring = ensureInner().finally(() => { ensuring = null; });
  return ensuring;
}

async function ensureInner(): Promise<void> {
  // A selection change invalidates the managed child — kill it so the new
  // tier spawns below (adopted external servers are the user's business).
  const want = findModel();
  if (managed && want && managedModelPath && want !== managedModelPath) {
    try { managed.kill(); } catch { /* gone */ }
    managed = null;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (await healthy()) return; // adopted (external terminal) or our child
  const port = localPort();
  if (port == null) {
    throw new Error(`William server at ${baseUrl()} is unreachable (remote URL — Glyphh only manages a local one)`);
  }
  if (managed) { try { managed.kill(); } catch { /* already gone */ } managed = null; }

  let model = findModel();
  if (!model) {
    // Transparent setup: pull the right tier from the manifest (progress
    // rides william:setup → the composer spinner). Signed-out or offline
    // surfaces the manifest error with the manual path as fallback.
    try {
      model = await downloadWilliamModel();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${msg}. Manual fallback: put ${MODEL_FILE} in ${join(app.getPath("userData"), "models")} ` +
        "(or point the williamModelPath preference at it).",
      );
    }
  }
  const bin = findServerBin();
  managedModelPath = model;
  const args = [
    "-m", model,
    "--host", "127.0.0.1", "--port", String(port),
    // 32k window: the SDK loop's system prompt + tool declarations are
    // bigger than the old prose loop's — 16k left no room to work.
    "--jinja", "-c", "32768", "-ngl", "99",
  ];
  const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderrTail = "";
  child.stderr?.on("data", (d) => { stderrTail = (stderrTail + String(d)).slice(-2000); });
  managed = child;
  child.on("exit", () => { if (managed === child) managed = null; });

  // Wait through the model load (several GB) — /health turns 200 when ready.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const deadline = Date.now() + 180_000;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      child.off("error", onError);
      child.off("exit", onExit);
      if (err) reject(err); else resolve();
    };
    const onError = (e: Error) => finish(new Error(`couldn't start llama-server (${bin}): ${e.message}`));
    const onExit = (code: number | null) => {
      const tail = stderrTail.split("\n").filter(Boolean).slice(-3).join(" · ");
      finish(new Error(`llama-server exited (${code ?? "?"}) before serving${tail ? ` — ${tail}` : ""}`));
    };
    child.on("error", onError);
    child.on("exit", onExit);
    const poll = setInterval(() => {
      void healthy(1500).then((up) => {
        if (up) finish();
        else if (Date.now() > deadline) finish(new Error("llama-server didn't become healthy within 3 minutes"));
      });
    }, 800);
  });
}

/** Kill the managed server + the slicer (no-op for an adopted external
 *  runtime). Wired to app will-quit — nothing outlives the client. */
export function shutdownWilliam(): void {
  active?.ctrl.abort();
  stopModelRouter();
  if (managed) { try { managed.kill(); } catch { /* already gone */ } managed = null; }
}

// ── External access gate ──────────────────────────────────────────────────
//
// William tools surfaced OUTSIDE the client (cloud relay, local MCP server)
// must call this before running. It enforces the same master switches the
// MCP settings expose — defense in depth: the tool checks even though a
// disabled transport shouldn't be connected at all.
export function assertWilliamExternalAllowed(via: "relay" | "local-mcp"): void {
  const enabled = via === "relay"
    ? getPreference<boolean>("relayEnabled", true) !== false
    : getPreference<boolean>("localMcpEnabled", false) === true;
  if (!enabled) {
    throw new Error(
      `William tools are disabled here: the ${via === "relay" ? "cloud relay" : "local MCP server"} ` +
      "is turned off in Settings → MCP Server",
    );
  }
}

export function registerWilliamIpc(): void {
  registerWilliamPermissionIpc();
  registerWilliamContextIpc();
  registerModelRouterIpc();
  ipcMain.handle("william-run", async (e, payload: { chatId: string }) => {
    if (active) throw new Error("a run is already in progress");
    const chatId = String(payload?.chatId || "");
    if (!chatId) throw new Error("chatId is required");
    // Sessions run inside a folder the USER chose — never ~/, never the
    // launch cwd. The renderer turns this into the folder picker.
    if (!getExplicitWorkingDirectory()) throw new Error("NO_WORKDIR: pick a working folder to start");
    // Assembly is token-true (needs the server for /tokenize) — bring the
    // runtime up first so counting and completion share one warm process.
    await ensureWilliamServing();
    const replyBudget = effortMaxTokens();
    const messages = await assemblePrompt(chatId, replyBudget);
    const id = `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const ctrl = new AbortController();
    active = { id, ctrl };
    void sdkRun(e.sender, id, messages, ctrl).finally(() => {
      if (active?.id === id) active = null;
      // Fold history AFTER the reply lands — a send never waits on it.
      // (The renderer saves the assistant turn right away; a short delay
      // lets that write land before compaction reads the store.)
      setTimeout(() => {
        void compactIfNeeded(chatId, replyBudget, (msgs, opts) => williamComplete(msgs, opts));
      }, 1500);
    });
    return { runId: id };
  });

  ipcMain.handle("william-compact", async (_e, p: { chatId?: string; focus?: string }) => {
    if (active) return { ok: false, reason: "wait for the current run to finish" };
    const chatId = String(p?.chatId || "");
    if (!chatId) return { ok: false, reason: "chatId is required" };
    await ensureWilliamServing();
    return compactNow(chatId, effortMaxTokens(), (msgs, opts) => williamComplete(msgs, opts), String(p?.focus || ""));
  });

  ipcMain.handle("william-stop", () => {
    active?.ctrl.abort();
    return true;
  });

  ipcMain.handle("william-models-list", async () => {
    const models = await refreshManifestIfStale();
    const desired = resolveDesiredModel();
    return {
      selected: selectedModelId(),
      resolved: desired?.id ?? null,
      models: models.map((m) => ({
        id: m.id, name: m.name, minRamGB: m.minRamGB, size: m.size,
        status: m.status ?? "available",
        usage: m.usage ?? "",
        downloaded: (m.status ?? "available") === "available" && !!localModelPath(m),
      })),
    };
  });
  ipcMain.handle("william-status", async () => {
    const up = await healthy(1500);
    return { up, mode: up ? (managed ? "managed" : "external") : "down" };
  });
}

// ── Completion core — direct local completion (compaction, relay tools) ───
//
// The agent loop no longer calls this (the SDK loop talks to the slicer);
// it remains the ONE path for utility completions that must stay local and
// cheap: history folding, summarize-on-demand, relay/MCP one-shots.

export interface WilliamCompleteOpts {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  /** Grammar-constrain the reply to this JSON schema (structured turns). */
  schema?: object;
}

export async function williamComplete(messages: ChatMessage[], opts: WilliamCompleteOpts = {}): Promise<string> {
  await ensureWilliamServing();
  const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.schema ? { response_format: { type: "json_schema", json_schema: { name: "turn", schema: opts.schema } } } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(`William server answered HTTP ${res.status}`);

  // OpenAI-style SSE: "data: {json}" lines, closed by "data: [DONE]".
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const j = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) { text += delta; opts.onDelta?.(delta); }
      } catch { /* keep-alive / partial line */ }
    }
  }
  return text;
}

// ── The loop — Claude Agent SDK over the slicer ────────────────────────────
//
// query() runs the SDK's own agent loop; ANTHROPIC_BASE_URL points its every
// model call at the router, which serves locally or escalates per the dial.
// Tools ride as an in-process MCP server; the gate (mode model + approval
// cards) fires inside each execution exactly as before.

/** Extra workspace context appended to the system prompt (app library +
 *  connected accounts) so open_app / connection_call target real names. */
async function workspaceExtras(): Promise<string> {
  let appList = "";
  try {
    const apps = await cachedServerGet<Array<{ slug?: string | null; name: string }>>("/api/panel-apps");
    appList = apps.slice(0, 48).map((a) => a.slug || a.name).join(", ");
  } catch { /* offline — open_app still resolves by name */ }
  let connList = "";
  try {
    const { serverGetAuthed } = await import("./auth");
    const r = await serverGetAuthed<{ connections?: Array<{ appSlug?: string }> }>("/api/connections");
    connList = [...new Set((r.connections || []).map((c) => String(c.appSlug || "")).filter(Boolean))].join(", ");
  } catch { /* signed out */ }
  return [
    appList ? `The user's app library (use these names with open_app — prefer the specific app over 'browser'): ${appList}` : "",
    connList ? `Connected accounts (connection_tools/connection_call): ${connList}` : "",
    "RULE: the working folder ROOT holds the current app's project — build it there, then call update_app() to ship it (it packages the built dist/, never your source). After any change, rebuild + update_app or tool calls run the stale installed version.",
    GLYPHH_APP_SPEC,
    "RULE: before your FIRST connection_call to any connector in a session, call connection_tools(connector) — connector tool names are exact strings you cannot guess. " +
    "Ada is your catalog: ada_recall(\"find email\") finds tools/apps/layouts by meaning; ada_ask({op:\"who\", conditions:{\"entity.kind\":\"tool\",\"relational.object\":\"gmail\"}}) lists a connector's tools exactly.",
  ].filter(Boolean).join("\n\n");
}

async function sdkRun(
  wc: WebContents,
  runId: string,
  base: ChatMessage[],
  ctrl: AbortController,
): Promise<void> {
  const emit = (channel: string, data: Record<string, unknown>) => {
    try { if (!wc.isDestroyed()) wc.send(channel, { runId, ...data }); } catch { /* panel gone */ }
  };

  const defs = williamToolDefs();

  // The Glyphh surface as an in-process MCP server. Raw JSON schemas (open
  // objects described by each tool's doc line) — the executor validates, and
  // both the local model and Claude work from the same prose contract.
  const mcp = new McpServer({ name: "glyphh", version: "1.0.0" }, { capabilities: { tools: {} } });
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: defs.map((d) => ({
      name: d.name,
      description: d.doc,
      inputSchema: { type: "object" as const, additionalProperties: true },
    })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (rq) => {
    const name = String(rq.params.name || "");
    const args = (rq.params.arguments ?? {}) as Record<string, unknown>;
    emit("william:tool", { phase: "start", name });
    const outcome = await executeWilliamTool(wc, { name, arguments: args }, ctrl.signal);
    emit("william:tool", {
      phase: "done",
      name,
      title: outcome.title,
      denied: outcome.denied,
      failed: outcome.result.startsWith("ERROR"),
      preview: outcome.result.slice(0, 160),
    });
    return { content: [{ type: "text" as const, text: outcome.result }], isError: outcome.result.startsWith("ERROR") };
  });

  // System prompt = assembled base system (persona + memory + summary) +
  // workspace extras + prior turns. The SDK owns the live loop; our
  // compactor still owns long-term history budget upstream of this.
  const history = base.slice(1, -1)
    .map((m) => `${m.role === "user" ? "User" : "William"}: ${m.content}`)
    .join("\n");
  const system = [
    base[0]?.content ?? "",
    await workspaceExtras(),
    history ? `<conversation_so_far>\n${history}\n</conversation_so_far>` : "",
  ].filter(Boolean).join("\n\n");
  const lastUser = String(base[base.length - 1]?.content ?? "");

  const routerPort = await startModelRouter();

  let finalText = "";
  let runError = "";
  let turnsUsed = 0;
  let tokens = 0;
  try {
    const q = query({
      prompt: lastUser,
      options: {
        cwd: getExplicitWorkingDirectory() ?? undefined,
        // The model the frontier slice runs on — the user's pick constrained
        // to the org's allow-list (gateway lane). Local turns ignore it.
        model: await effectiveFrontierModel(),
        systemPrompt: system,
        settingSources: [],
        tools: [], // no built-ins — the Glyphh surface is the whole toolset
        mcpServers: { glyphh: { type: "sdk", name: "glyphh", instance: mcp as never } },
        allowedTools: defs.map((d) => `mcp__glyphh__${d.name}`),
        // Gating lives inside executeWilliamTool (mode model + approval
        // cards) — the SDK's own prompt layer always defers to it.
        canUseTool: async (_tool, input) => ({ behavior: "allow" as const, updatedInput: input }),
        permissionMode: "default",
        maxTurns: effortMaxTurns(),
        persistSession: false,
        executable: "node",
        // Token-level partials — the thread streams live instead of getting
        // each turn's text dumped whole at message end.
        includePartialMessages: true,
        abortController: ctrl,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${routerPort}`,
          // The router injects the real key upstream on escalated turns —
          // the loop subprocess never holds it.
          ANTHROPIC_API_KEY: "glyphh-router",
          ANTHROPIC_AUTH_TOKEN: undefined,
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
        const ev = (msg as unknown as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          sawPartials = true;
          if (pendingSep && finalText) { finalText += "\n\n"; emit("william:delta", { delta: "\n\n" }); }
          pendingSep = false;
          finalText += ev.delta.text;
          emit("william:delta", { delta: ev.delta.text });
          tokens = Math.ceil(finalText.length / 4);
          const now = Date.now();
          if (now - lastProgressAt > 400) { lastProgressAt = now; emit("william:progress", { tokens }); }
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
            emit("william:delta", { delta: finalText === text ? text : `\n\n${text}` });
          }
          tokens = Math.ceil(finalText.length / 4);
          emit("william:progress", { tokens });
        }
      } else if (msg.type === "result") {
        const r = msg as { subtype: string; result?: string; num_turns?: number };
        if (r.subtype === "success") {
          if (!finalText && r.result) { finalText = r.result; emit("william:delta", { delta: finalText }); }
        } else {
          runError = `run ended: ${r.subtype.replaceAll("_", " ")}`;
        }
        if (typeof r.num_turns === "number") turnsUsed = r.num_turns;
      }
    }
    if (ctrl.signal.aborted) throw new Error("aborted");
    emit("william:progress", { tokens });
    if (runError) emit("william:error", { error: runError });
    else emit("william:done", { stopped: false });
  } catch (err) {
    if (ctrl.signal.aborted) {
      emit("william:done", { stopped: true });
      captureRun({ kind: "agent", effort: williamEffort(), mode: williamMode(), turnsUsed, stopped: true, messages: base });
      return;
    }
    runError = err instanceof Error ? err.message : String(err);
    emit("william:error", { error: runError });
  }
  // The flywheel: transcript + outcome are next-era training data (the
  // tripwire corpus — frontier turns teach the local model by example).
  captureRun({
    kind: "agent",
    effort: williamEffort(),
    mode: williamMode(),
    turnsUsed,
    final: finalText,
    ...(runError ? { error: runError } : {}),
    messages: [...base, { role: "assistant", content: finalText }],
  });
}
