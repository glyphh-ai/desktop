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
import { getPreference } from "./preferences";
import { effortMaxTokens, registerWilliamPermissionIpc } from "./william-permissions";

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

/** Model weights: preference → app-support models dir → dev checkout. */
function findModel(): string | null {
  const pref = String(getPreference("williamModelPath", "")).trim();
  const candidates = [
    ...(pref ? [pref] : []),
    join(app.getPath("userData"), "models", MODEL_FILE),
    join(homedir(), "development", "yo", "glyphh-william", "models", MODEL_FILE),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

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
  if (await healthy()) return; // adopted (external terminal) or our child
  const port = localPort();
  if (port == null) {
    throw new Error(`William server at ${baseUrl()} is unreachable (remote URL — Glyphh only manages a local one)`);
  }
  if (managed) { try { managed.kill(); } catch { /* already gone */ } managed = null; }

  const model = findModel();
  if (!model) {
    throw new Error(
      `William model not found. Put ${MODEL_FILE} in ${join(app.getPath("userData"), "models")} ` +
      "(or point the williamModelPath preference at it).",
    );
  }
  const bin = findServerBin();
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
  ipcMain.handle("william-run", (e, payload: { messages: ChatMessage[] }) => {
    if (active) throw new Error("a run is already in progress");
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    if (!messages.length) throw new Error("no messages");
    const id = `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const ctrl = new AbortController();
    active = { id, ctrl };
    void stream(e.sender, id, messages, ctrl).finally(() => {
      if (active?.id === id) active = null;
    });
    return { runId: id };
  });

  ipcMain.handle("william-stop", () => {
    active?.ctrl.abort();
    return true;
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

async function stream(wc: WebContents, runId: string, messages: ChatMessage[], ctrl: AbortController): Promise<void> {
  const emit = (channel: string, data: Record<string, unknown>) => {
    try { if (!wc.isDestroyed()) wc.send(channel, { runId, ...data }); } catch { /* panel gone */ }
  };
  try {
    await williamComplete(messages, {
      signal: ctrl.signal,
      maxTokens: effortMaxTokens(), // the effort lever — budget per reply
      onDelta: (delta) => emit("william:delta", { delta }),
    });
    emit("william:done", { stopped: false });
  } catch (err) {
    if (ctrl.signal.aborted) {
      emit("william:done", { stopped: true });
      return;
    }
    emit("william:error", { error: err instanceof Error ? err.message : String(err) });
  }
}
