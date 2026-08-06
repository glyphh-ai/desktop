/**
 * Glyphh — the run surface. ONE HARNESS EVERYWHERE.
 *
 * This module no longer owns an agent loop. `glyphh-agent-run` splits two ways
 * and only two:
 *
 *   chat            a plain streamed completion on the gateway's Messages edge
 *                   (chatRun, below) — no tools, no harness, no packet.
 *   cowork / code   the machine's LOCAL HARNESS POD (glyphh-harness-run.ts) —
 *                   the same rrotor harness that serves cloud sessions, run on
 *                   127.0.0.1 with the desktop's tool surface lent to it over
 *                   loopback MCP and the session's real folder as its cwd.
 *
 * The in-process Claude Agent SDK loop (`sdkRun`) that used to live here is
 * GONE, along with the local model interceptor it needed: the pod calls the
 * Glyphh gateway itself with the user's access token, so there is no second
 * loop, no second model egress, and no second place for behaviour to drift.
 *
 * Renderer contract is unchanged and was never versioned on the engine: deltas
 * on `glyphh-agent:delta`, tool activity on `:tool`, approvals/questions on
 * `:approval`/`:ask`, termination on `:done`/`:error`. One run PER SESSION;
 * `glyphh-agent-stop` aborts a session's run.
 */

import { ipcMain, type WebContents } from "electron";
import { runMaxOutputTokens } from "./loop-selections";
import { registerGlyphhPermissionIpc } from "./glyphh-agent-permissions";
import { setRunAttachments, clearRunAttachments, activeAgentRuns } from "./glyphh-agent-tools";
import { pickAttachments, classifyPaths, saveClipboardImage, validAttachments, type AttachRef } from "./glyphh-agent-attachments";
import { indexChatTurns, pruneTurnVectors } from "./glyphh-agent-recall";
import { refreshWorkspaceIndex } from "./workspace-index";
import { stopEmbedServer } from "./glyphh-agent-embeddings";
import { assemblePrompt, compactIfNeeded, compactNow, loadSessions, registerGlyphhContextIpc } from "./glyphh-agent-context";
import { registerThreadsIpc } from "./threads-ipc";
import { getExplicitWorkingDirectory } from "./working-directory";
import { getClient } from "./glyphh-client";
import { getPreference } from "./stores/preferences-db";
import { runModel } from "./loop-selections";
import { brandError, skillSeedFor, type ChatMessage } from "./glyphh-agent-prompt";
import { harnessRun, isCloudSource, type RunSource } from "./glyphh-harness-run";
import { closeBridge } from "./harness-mcp-bridge";

export type { ChatMessage };

// One live run PER SESSION (chatId) — sessions are independent: an agent
// working in one session never blocks a send in another. `stop` targets a
// chat; shutdown aborts everything.
const activeRuns = new Map<string, { id: string; ctrl: AbortController }>();

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
  ipcMain.handle("glyphh-agent-run", async (e, payload: { chatId: string; attachments?: AttachRef[]; workdir?: string; chat?: boolean; mode?: "chat" | "cowork" | "code"; source?: RunSource }) => {
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
    // Where the session RUNS. The record wins over the payload for the same
    // reason `mode` does; a cloud session runs on its provisioned pod, from
    // the desktop just as it does from the web.
    const source = stored?.source ?? payload?.source;
    const onCloud = isCloudSource(source);
    // A CHAT run executes no tools — it has no use for a folder, so it never
    // demands one. Neither does a cloud run: its folder is the pod's own
    // project workspace, not a path on this machine.
    if (!runWorkdir && mode !== "chat" && !onCloud) throw new Error("NO_WORKDIR: pick a working folder to start");
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
    // CHAT is a plain completion; every tool-bearing mode runs on the local
    // harness pod. There is no third branch and no in-process loop left.
    const runner = mode === "chat"
      ? chatRun(e.sender, id, messages, ctrl, replyBudget)
      : harnessRun(e.sender, id, messages, ctrl, attachments, chatId, runWorkdir || undefined, mode, source);
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
