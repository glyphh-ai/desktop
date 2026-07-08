/**
 * William — the local agent loop's serving bridge.
 *
 * Streams chat completions from the William model served by llama-server
 * (OpenAI-compatible /v1/chat/completions, default 127.0.0.1:8089) into the
 * renderer: `william-run` starts a streamed run and deltas arrive on
 * `william:delta`, terminated by `william:done` (or `william:error`).
 * One run at a time; `william-stop` aborts the active one.
 *
 * v1 = prompt → thinking → streamed response. The generate→validate→repair
 * bundle loop (emission format + oracle) layers on top of this later.
 */

import { ipcMain, app, type WebContents } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getPreference } from "./stores/preferences-db";
import { effortMaxTokens, effortMaxTurns, williamEffort, williamMode, registerWilliamPermissionIpc } from "./william-permissions";
import { captureRun } from "./william-training";
import { williamToolsPrompt, TURN_SCHEMA, executeWilliamTool } from "./william-tools";
import { cachedServerGet } from "./server-cache";
import { assemblePrompt, compactIfNeeded, compactNow, registerWilliamContextIpc } from "./william-context";
import { downloadWilliamModel, resolveDesiredModel, localModelPath, refreshManifestIfStale, selectedModelId } from "./william-models";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

let active: { id: string; ctrl: AbortController } | null = null;

function baseUrl(): string {
  return String(getPreference("williamBaseUrl", "http://127.0.0.1:8089")).replace(/\/+$/, "");
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

const MODEL_FILE = "william-14b-q4km.gguf";

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
    "--jinja", "-c", "16384", "-ngl", "99",
  ];
  const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderrTail = "";
  child.stderr?.on("data", (d) => { stderrTail = (stderrTail + String(d)).slice(-2000); });
  managed = child;
  child.on("exit", () => { if (managed === child) managed = null; });

  // Wait through the model load (8.4GB) — /health turns 200 when ready.
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

/** Kill the managed server (no-op for an adopted external one). Wired to
 *  app will-quit — the runtime never outlives the client. */
export function shutdownWilliam(): void {
  active?.ctrl.abort();
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
  ipcMain.handle("william-run", async (e, payload: { chatId: string }) => {
    if (active) throw new Error("a run is already in progress");
    const chatId = String(payload?.chatId || "");
    if (!chatId) throw new Error("chatId is required");
    // Assembly is token-true (needs the server for /tokenize) — bring the
    // runtime up first so counting and completion share one warm process.
    await ensureWilliamServing();
    const replyBudget = effortMaxTokens();
    const messages = await assemblePrompt(chatId, replyBudget);
    const id = `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const ctrl = new AbortController();
    active = { id, ctrl };
    void agentRun(e.sender, id, messages, replyBudget, ctrl).finally(() => {
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
        downloaded: !!localModelPath(m),
      })),
    };
  });
  ipcMain.handle("william-status", async () => {
    const up = await healthy(1500);
    return { up, mode: up ? (managed ? "managed" : "external") : "down" };
  });
}

// ── Completion core — the ONE William call path ───────────────────────────
//
// Everything that runs William goes through this: the composer's IPC runs
// today, the generate→validate→repair loop and any relay/MCP tools next.
// Ensures the runtime, streams, returns the full text. No re-wiring later.

export interface WilliamCompleteOpts {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  /** Grammar-constrain the reply to this JSON schema (agent turns). */
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

/**
 * The agent loop: schema-constrained turns ({thought, action|final}) — the
 * grammar guarantees every turn parses, the gate clears every action, and
 * tool observations feed back until a final lands or the effort turn
 * budget runs out. Thought/tool activity streams to the panel as
 * william:tool events; the final answer arrives as one delta.
 */
async function agentRun(
  wc: WebContents,
  runId: string,
  base: ChatMessage[],
  replyBudget: number,
  ctrl: AbortController,
): Promise<void> {
  const emit = (channel: string, data: Record<string, unknown>) => {
    try { if (!wc.isDestroyed()) wc.send(channel, { runId, ...data }); } catch { /* panel gone */ }
  };
  // Tool instructions ride as a second system message so the cached prefix
  // (system + memory + summary) stays byte-stable across runs. The app
  // library is inlined so open_app targets real slugs (not guesses).
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
  const toolsMsg: ChatMessage = {
    role: "system",
    content:
      "You are an agent loop with tools. Available tools:\n" + williamToolsPrompt() +
      (appList ? `\n\nThe user's app library (use these names with open_app — prefer the specific app over 'browser'): ${appList}` : "") +
      (connList ? `\n\nConnected accounts (connection_tools/connection_call): ${connList}` : "") +
      "\n\nRULE: before your FIRST connection_call to any connector in a session, call connection_tools(connector) — connector tool names are exact strings you cannot guess. " +
      "Ada is your catalog: ada_recall(\"find email\") finds tools/apps/layouts by meaning; ada_ask({op:\"who\", conditions:{\"entity.kind\":\"tool\",\"relational.object\":\"gmail\"}}) lists a connector's tools exactly." +
      "\n\nEach turn reply as JSON: {\"thought\": \"one short sentence\", \"action\": {\"name\": \"tool\", \"arguments\": {…}}} to use a tool, " +
      "or {\"thought\": \"…\", \"final\": \"your complete answer\"} when done. " +
      "Tool results arrive as <tool_response> messages. If a tool is DENIED, adapt or finish. Never invent tool output.",
  };
  const messages: ChatMessage[] = [base[0], toolsMsg, ...base.slice(1)];
  const maxTurns = effortMaxTurns();
  let turnsUsed = 0;
  let finalText = "";
  let runError = "";
  // Generated-token counter (one SSE delta ≈ one token) — throttled to the
  // panel so the spinner can read "1m 34s · 260 tokens".
  let tokens = 0;
  let lastProgress = 0;
  const countDelta = () => {
    tokens++;
    const now = Date.now();
    if (now - lastProgress > 250) {
      lastProgress = now;
      emit("william:progress", { tokens });
    }
  };
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      turnsUsed = turn + 1;
      const raw = await williamComplete(messages, {
        signal: ctrl.signal,
        maxTokens: replyBudget,
        temperature: 0.15,
        schema: TURN_SCHEMA,
        onDelta: countDelta,
      });
      let parsed: { thought?: string; action?: { name: string; arguments?: Record<string, unknown> }; final?: string };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        // Grammar should make this impossible — treat raw text as the final.
        emit("william:delta", { delta: raw });
        break;
      }
      if (parsed.action?.name) {
        emit("william:tool", { phase: "start", name: parsed.action.name, thought: parsed.thought || "" });
        const outcome = await executeWilliamTool(wc, parsed.action);
        emit("william:tool", {
          phase: "done",
          name: parsed.action.name,
          title: outcome.title,
          denied: outcome.denied,
          failed: outcome.result.startsWith("ERROR"),
          preview: outcome.result.slice(0, 160),
        });
        messages.push({ role: "assistant", content: raw });
        messages.push({ role: "user", content: `<tool_response>\n${outcome.result}\n</tool_response>` });
        continue;
      }
      finalText = parsed.final || parsed.thought || "";
      messages.push({ role: "assistant", content: raw });
      emit("william:delta", { delta: finalText });
      break;
    }
    emit("william:progress", { tokens });
    emit("william:done", { stopped: false });
  } catch (err) {
    if (ctrl.signal.aborted) {
      emit("william:done", { stopped: true });
      captureRun({ kind: "agent", effort: williamEffort(), mode: williamMode(), turnsUsed, stopped: true, messages });
      return;
    }
    runError = err instanceof Error ? err.message : String(err);
    emit("william:error", { error: runError });
  }
  // The flywheel: the full transcript (memory + history + constrained
  // turns + tool observations + final) is next-run training data.
  captureRun({
    kind: "agent",
    effort: williamEffort(),
    mode: williamMode(),
    turnsUsed,
    final: finalText,
    ...(runError ? { error: runError } : {}),
    messages,
  });
}
