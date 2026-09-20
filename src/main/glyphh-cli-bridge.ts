/**
 * glyphh-cli-bridge.ts — the Glyphh Agent panel's ENGINE: a bridge over the
 * claude CLI (his ruling, 2026-09-11: "the CLI is the loop... the UI is just
 * a bridge to the cli running under it").
 *
 * Glyphh owns NO loop. Each panel chat is a claude subprocess in
 * bidirectional stream-json mode; this module translates its stream into the
 * renderer contract the parked panel already speaks (glyphh-agent:delta /
 * :tool / :approval / :done / …) — that contract was never versioned on the
 * engine, so the renderer is untouched. Sessions are the CLI's OWN transcripts
 * (~/.claude/projects); the chat store here maps panel chats to CLI session
 * ids so Terminal ⇄ Chat are two views of the same session.
 *
 * One live process PER CHAT. `stop` interrupts via the CLI's control channel;
 * a mid-run send queues as the CLI's own steering does.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ipcMain, type WebContents } from "electron";
import { pickAttachments, classifyPaths, saveClipboardImage, validAttachments, type AttachRef } from "./glyphh-agent-attachments";
import { startLocalMcpServer, localMcpStatus, localMcpGenToken, localMcpTokenValid } from "./local-mcp-server.js";
import { authFix } from "./cli-auth.js";
import { requestUsesGateway, LOOP_VENDOR } from "./gateway-token.js";
import { getClient } from "./glyphh-client.js";
import { listCliAgents, composeHeadless, ensureLoopEnv, loopEnvPrefix, agentRowFor, bareModel, geminiSessionFiles, cursorSessionFiles, readCursorSessionHead, NOISE_TITLE, type CliAgentListed } from "./cli-agents.js";
import { userScopedDir } from "./app-paths.js";

// ── chat ↔ CLI session store (~/.glyphh — the desktop's local law) ──────────

const STORE_DIR = (): string => userScopedDir();
const SESSIONS_FILE = path.join(STORE_DIR(), "agent-sessions.json");

interface SessionsSnapshot { chats: unknown[]; currentId: string | null }

function loadSessionsFile(): SessionsSnapshot {
  try {
    const j = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8")) as SessionsSnapshot;
    return { chats: Array.isArray(j.chats) ? j.chats : [], currentId: typeof j.currentId === "string" ? j.currentId : null };
  } catch { return { chats: [], currentId: null }; }
}

function saveSessionsFile(snap: SessionsSnapshot): void {
  try {
    mkdirSync(STORE_DIR(), { recursive: true });
    // Several agent panels write this file (2026-09-16): merge by chat id, the
    // newer updatedAt wins, and a chat only one panel knows about survives.
    type Rec = { id?: string; updatedAt?: number };
    const have = loadSessionsFile().chats as Rec[];
    const incoming = snap.chats as Rec[];
    const byId = new Map<string, Rec>();
    for (const c of have) if (c && typeof c.id === "string") byId.set(c.id, c);
    for (const c of incoming) {
      if (!c || typeof c.id !== "string") continue;
      const cur = byId.get(c.id);
      if (!cur || (c.updatedAt ?? 0) >= (cur.updatedAt ?? 0)) byId.set(c.id, c);
    }
    const order = [...incoming.map((c) => c?.id).filter((x): x is string => typeof x === "string"), ...have.map((c) => c?.id).filter((x): x is string => typeof x === "string")];
    const seen = new Set<string>();
    const chats = order.filter((id) => (seen.has(id) ? false : (seen.add(id), true))).map((id) => byId.get(id)!);
    writeFileSync(SESSIONS_FILE, JSON.stringify({ chats, currentId: snap.currentId }), "utf-8");
  } catch { /* a failed save loses nothing but the recents ordering */ }
}

// ── live processes ───────────────────────────────────────────────────────────

interface LiveChat {
  proc: ChildProcessWithoutNullStreams;
  runId: string;
  sender: WebContents;
  /** The CLI's own session id — resume + the Terminal view key off it. */
  cliSessionId: string | null;
  permission: "ask" | "plan" | "acceptEdits" | "auto";
  /** Which vendor CLI is running, so a failure can name its own sign-in. */
  cli: string;
  buf: string;
  usage: { inTokens: number; outTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  nextControl: number;
  /** control_request ids we asked the renderer about, by approval id. */
  pending: Map<string, string>;
}

const live = new Map<string, LiveChat>();

/**
 * A TURN WE CANNOT METER ANY OTHER WAY (his order, 2026-09-18).
 *
 * While a vendor's own credits last, the CLI talks straight to the vendor and
 * nothing reaches our gateway, so the only record of what was spent is the
 * CLI's own token count. Report it so the burn-down can end and the gateway
 * take over. A gateway turn is metered server-side and must NOT be counted
 * twice, so this reports only the direct lane.
 */
async function reportDirectUsage(chat: LiveChat, model?: string): Promise<void> {
  const provider = LOOP_VENDOR[chat.cli];
  const { inTokens, outTokens, cacheReadTokens, cacheWriteTokens } = chat.usage;
  if (!provider || (!inTokens && !outTokens && !cacheReadTokens && !cacheWriteTokens)) return;
  try {
    // The lane is per REQUEST now: a heavy model under "reserved" went direct
    // even though the loop's env carries the credential.
    if (requestUsesGateway(chat.cli, model ?? "", false)) return;
    await getClient().http.post("/api/gateway/vendor-usage", {
      provider, model: bareModel(model ?? "") || "", inTokens, outTokens, cacheReadTokens, cacheWriteTokens,
    });
  } catch { /* the burn-down reads low rather than failing a finished turn */ }
}

/** chatId → the CLI session to resume when the chat's process is cold. */
// PER-CLI bindings (his ruling, 2026-09-14: "some way to map sessions
// across loops" WITHOUT the spider web) — the glyphh thread is the session
// of record; each CLI holds AT MOST ONE session binding per thread, keyed
// chatId::cli. Ids never translate between CLIs; a loop switch means the
// new CLI starts (compaction-seeded) and earns its own binding.
const resumeIds = new Map<string, string>();
const rkey = (chatId: string, cli: string): string => `${chatId}::${cli || "claude"}`;

const PERM_FLAG: Record<LiveChat["permission"], string> = {
  ask: "default",
  plan: "plan",
  acceptEdits: "acceptEdits",
  auto: "bypassPermissions",
};

function emit(c: LiveChat, channel: string, payload: unknown): void {
  try { if (!c.sender.isDestroyed()) c.sender.send(channel, payload); } catch { /* window closed mid-run */ }
}

// ── the stream-json translation ──────────────────────────────────────────────

function handleEvent(chatId: string, c: LiveChat, ev: Record<string, unknown>): void {
  const type = String(ev.type ?? "");

  if (type === "system" && ev.subtype === "init") {
    const sid = typeof ev.session_id === "string" ? ev.session_id : null;
    if (sid) { c.cliSessionId = sid; resumeIds.set(rkey(chatId, "claude"), sid); }
    // The renderer PERSISTS the binding on its chat row — the resume map is
    // memory-only, and without this a restart forgot which CLI session an
    // organic chat rides (first hop/run started fresh).
    emit(c, "glyphh-agent:setup", { phase: "ready", model: typeof ev.model === "string" ? ev.model : undefined, cliSessionId: sid ?? undefined });
    return;
  }

  // Partial assistant frames (--include-partial-messages): text deltas stream;
  // tool_use starts surface as tool activity.
  if (type === "stream_event") {
    const e = (ev.event ?? {}) as Record<string, unknown>;
    const et = String(e.type ?? "");
    if (et === "content_block_delta") {
      const d = (e.delta ?? {}) as { type?: string; text?: string };
      if (d.type === "text_delta" && d.text) emit(c, "glyphh-agent:delta", { runId: c.runId, delta: d.text });
    } else if (et === "content_block_start") {
      const cb = (e.content_block ?? {}) as { type?: string; name?: string };
      if (cb.type === "tool_use" && cb.name) {
        emit(c, "glyphh-agent:tool", { runId: c.runId, phase: "start", name: cb.name, title: cb.name });
      }
    } else if (et === "message_delta") {
      const u = (e.usage ?? {}) as { output_tokens?: number };
      if (typeof u.output_tokens === "number") {
        c.usage.outTokens = u.output_tokens;
        emit(c, "glyphh-agent:progress", { runId: c.runId, inTokens: c.usage.inTokens, outTokens: c.usage.outTokens });
      }
    }
    return;
  }

  // Whole-message frames: tool results close the open tool card.
  if (type === "user") {
    const content = ((ev.message as { content?: unknown } | undefined)?.content ?? []) as Array<Record<string, unknown>>;
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type === "tool_result") {
        emit(c, "glyphh-agent:tool", { runId: c.runId, phase: "done", failed: block.is_error === true });
      }
    }
    return;
  }

  // Permission asks ride the CLI's control channel; the renderer answers them
  // through the SAME approval cards it always had.
  if (type === "control_request") {
    const req = (ev.request ?? {}) as Record<string, unknown>;
    if (req.subtype === "can_use_tool") {
      const requestId = String(ev.request_id ?? "");
      const name = String(req.tool_name ?? "tool");
      // AUTO TRUMPS THE ASK (his report, 2026-09-17). Bypass covers the CLI's
      // own tools, but an MCP server can still send a request up this channel,
      // and queueing a card for it makes Auto mode stop and wait for a person
      // who was promised they would not be asked. Answer it here.
      if (c.permission === "auto") {
        c.proc.stdin.write(JSON.stringify({
          type: "control_response",
          response: { subtype: "success", request_id: requestId, response: { behavior: "allow" } },
        }) + "\n");
        return;
      }
      const approvalId = `${chatId}:${requestId}`;
      c.pending.set(approvalId, requestId);
      emit(c, "glyphh-agent:approval", {
        id: approvalId,
        kind: "tool",
        title: name,
        detail: JSON.stringify(req.input ?? {}, null, 2).slice(0, 2000),
      });
    }
    return;
  }

  if (type === "result") {
    const u = (ev.usage ?? {}) as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    if (typeof u.input_tokens === "number") c.usage.inTokens = u.input_tokens;
    if (typeof u.output_tokens === "number") c.usage.outTokens = u.output_tokens;
    // Cached prompt tokens are billed too, at cache rates; the CLI reports
    // them beside input_tokens, which EXCLUDES them (his question, 2026-09-19).
    if (typeof u.cache_read_input_tokens === "number") c.usage.cacheReadTokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") c.usage.cacheWriteTokens = u.cache_creation_input_tokens;
    emit(c, "glyphh-agent:progress", { runId: c.runId, inTokens: c.usage.inTokens, outTokens: c.usage.outTokens });
    if (ev.is_error) {
      const said = String(ev.result ?? "the run failed");
      const fix = authFix(said, c.cli || "claude");
      emit(c, "glyphh-agent:error", { runId: c.runId, error: fix ? fix.message : said, fix: fix ?? undefined });
    }
    emit(c, "glyphh-agent:done", { runId: c.runId, stopped: ev.subtype === "error_during_execution" ? false : ev.subtype === "success" ? false : true });
    return;
  }
}

// ── process lifecycle ────────────────────────────────────────────────────────

interface RunPayload {
  chatId: string;
  attachments?: AttachRef[];
  workdir?: string;
  permission?: LiveChat["permission"];
  steer?: string;
  model?: string;
  prompt?: string;
  /** The picked LOOP (a CLI agent id) — decides WHICH CLI runs this chat. */
  loop?: string;
  /** The workspace the chat runs under, for project memory. */
  workspace?: string;
  /** The chat's persisted CLI session — re-primes the in-memory resume map
   *  after a restart, so the first run/hop resumes instead of starting
   *  fresh (his report, 2026-09-14: the first terminal hop was empty). */
  cliSessionId?: string;
}

/** The bridge's own --mcp-config: the SAME local MCP wiring the terminal
 *  lane rides (his report, 2026-09-11: the chat view spawned a bare claude
 *  and every Glyphh tool/connector "disconnected"). One file, one long-lived
 *  token, refreshed with the live port on every spawn. */
function bridgeMcpFile(): string | null {
  try {
    const { port } = localMcpStatus();
    if (!port) return null;
    const file = path.join(STORE_DIR(), "bridge-mcp.json");
    let token: string | undefined;
    try {
      const existing = JSON.parse(readFileSync(file, "utf-8")) as { mcpServers?: { glyphh?: { headers?: { Authorization?: string } } } };
      token = /^Bearer (.+)$/.exec(existing.mcpServers?.glyphh?.headers?.Authorization ?? "")?.[1];
    } catch { /* first write */ }
    // Reuse only a token the server still honors; otherwise mint a fresh one.
    if (!token || !localMcpTokenValid(token)) token = localMcpGenToken("glyphh-panel", 365).token;
    const cfg = { mcpServers: { glyphh: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } };
    mkdirSync(STORE_DIR(), { recursive: true });
    writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
    return file;
  } catch { return null; }
}

/** The chat's LOOP: the picked CLI agent, else the first configured one,
 *  else a bare claude default (his ruling, 2026-09-11: every vendor loop
 *  works — codex must never open claude's session). */
function loopOf(p: RunPayload): CliAgentListed | null {
  const rows = listCliAgents();
  const hit = rows.find((r) => r.id === p.loop);
  if (hit) return hit;
  // NEVER a silent reroute (his report, 2026-09-14: a codex session ran on
  // claude): a named loop that misses the roster is a bug worth one loud
  // line before the fallback stands in.
  if (p.loop) console.warn("[cli-bridge] loop not in roster — falling back", { loop: p.loop, roster: rows.map((r) => r.id) });
  return rows.find((r) => r.cli === "claude") ?? rows[0] ?? null;
}

/** Non-claude loops run PER-TURN headless (codex exec --json / gemini -p):
 *  no persistent control channel, so the turn streams as one growing delta
 *  and closes. composeHeadless rides the agent's OWN env/mcp/model wiring. */
function runHeadlessTurn(p: RunPayload, agent: CliAgentListed, text: string, sender: WebContents): { runId: string } {
  const runId = `${p.chatId}:${Date.now()}`;
  // The SESSION's mode rides every turn — the composer chip transitions the
  // running conversation, not just the loop's config default. And the chat
  // CHAINS through the CLI's own persisted session (codex exec resume) so
  // turns share context and the >_ hop resumes a rollout that exists (his
  // report, 2026-09-14: "No saved session found" — nothing captured the id
  // and every turn ran fresh).
  // The org's credit strategy decides whether THIS session spends credits:
  // chat and co-work stay on the member's own login under "reserved".
  const line = composeHeadless(agent, text, p.model, p.permission ?? "ask", resumeIds.get(rkey(p.chatId, agent.cli)));
  const proc = spawn(process.env.SHELL || "/bin/zsh", ["-lc", line], {
    cwd: p.workdir && existsSync(p.workdir) ? p.workdir : agent.cwd && existsSync(agent.cwd) ? agent.cwd : homedir(),
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chat: LiveChat = {
    proc: proc as ChildProcessWithoutNullStreams,
    runId, sender,
    cliSessionId: null,
    permission: p.permission ?? "ask",
    cli: agent.cli || "claude",
    buf: "",
    usage: { inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    nextControl: 1,
    pending: new Map(),
  };
  live.set(p.chatId, chat);
  emit(chat, "glyphh-agent:setup", { phase: "ready", model: p.model ?? agent.model ?? undefined });
  let sawJson = false;
  proc.stdout.on("data", (b: Buffer) => {
    const chunk = b.toString("utf-8");
    chat.buf += chunk;
    let i: number;
    let plainCarry = "";
    while ((i = chat.buf.indexOf("\n")) >= 0) {
      const lineStr = chat.buf.slice(0, i);
      chat.buf = chat.buf.slice(i + 1);
      const t = lineStr.trim();
      if (!t) continue;
      // codex --json: JSONL events; item.completed agent_message carries text.
      if (t.startsWith("{")) {
        try {
          const j = JSON.parse(t) as { type?: string; thread_id?: string; session_id?: string; item?: { type?: string; text?: string }; msg?: { type?: string; message?: string; session_id?: string } };
          sawJson = true;
          // codex 0.154 exec --json: thread.started carries the persisted
          // session id — the resume key for chained turns AND the >_ hop.
          const sid = (typeof j.thread_id === "string" && j.thread_id)
            || (typeof j.session_id === "string" && j.session_id)
            || (typeof j.msg?.session_id === "string" && j.msg.session_id) || "";
          if (sid && !resumeIds.get(rkey(p.chatId, agent.cli))) { chat.cliSessionId = sid; resumeIds.set(rkey(p.chatId, agent.cli), sid); }
          const itemText = j.item?.type === "agent_message" ? j.item.text
            : j.msg?.type === "agent_message" ? j.msg.message : undefined;
          if (itemText) emit(chat, "glyphh-agent:delta", { runId, delta: itemText });
          else if (j.item?.type && j.item.type !== "agent_message") emit(chat, "glyphh-agent:tool", { runId, phase: "start", name: j.item.type, title: j.item.type });
          continue;
        } catch { /* not a frame — fall through as text */ }
      }
      if (!sawJson) plainCarry += lineStr + "\n";
    }
    if (plainCarry) emit(chat, "glyphh-agent:delta", { runId, delta: plainCarry });
  });
  let errTail = "";
  proc.stderr.on("data", (b: Buffer) => { errTail = (errTail + b.toString("utf-8")).slice(-2000); });
  proc.on("exit", (code) => {
    live.delete(p.chatId);
    void reportDirectUsage(chat, p.model);
    if (chat.buf.trim() && !sawJson) emit(chat, "glyphh-agent:delta", { runId, delta: chat.buf });
    if (code !== 0 && code !== null) {
      const said = errTail.trim() || `${agent.cli} exited ${code}`;
      const fix = authFix(`${said}\n${chat.buf}`, agent.cli || "claude");
      emit(chat, "glyphh-agent:error", { runId, error: fix ? fix.message : said, fix: fix ?? undefined });
    }
    emit(chat, "glyphh-agent:done", { runId, stopped: false });
  });
  return { runId };
}

function spawnChat(p: RunPayload, sender: WebContents): LiveChat {
  const permission = p.permission ?? "ask";
  const resume = resumeIds.get(rkey(p.chatId, "claude"));
  const parts = [
    "claude", "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode", PERM_FLAG[permission],
    // Permission prompts RIDE THE CONTROL CHANNEL (his report, 2026-09-11:
    // every MCP call answered "permission not granted" — headless default
    // denies when no prompt route exists). stdio = ask the client, i.e. us;
    // the can_use_tool handler above turns each ask into an approval card.
    "--permission-prompt-tool", "stdio",
  ];
  // The CLI takes the vendor's own name; the app stores catalog ids. This lane
  // used to pass the id whole, so the panel asked for "anthropic::claude-…".
  const wanted = bareModel(p.model ?? "");
  if (wanted) parts.push("--model", wanted);
  if (resume) parts.push("--resume", resume);
  const mcp = bridgeMcpFile();
  if (mcp) parts.push("--mcp-config", mcp);
  // The login shell resolves the user's real PATH — Electron's GUI env
  // doesn't carry it, and `claude` lives wherever the user installed it.
  const row = agentRowFor(p.loop || "claude");
  const line = (row ? loopEnvPrefix(row, wanted) : "")
    + parts.map((a) => (/^[\w./=-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
  const proc = spawn(process.env.SHELL || "/bin/zsh", ["-lc", line], {
    cwd: p.workdir && existsSync(p.workdir) ? p.workdir : homedir(),
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chat: LiveChat = {
    proc, sender,
    runId: `${p.chatId}:${Date.now()}`,
    cliSessionId: resume ?? null,
    permission,
    cli: "claude",
    buf: "",
    usage: { inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    nextControl: 1,
    pending: new Map(),
  };
  proc.stdout.on("data", (b: Buffer) => {
    chat.buf += b.toString("utf-8");
    let i: number;
    while ((i = chat.buf.indexOf("\n")) >= 0) {
      const lineStr = chat.buf.slice(0, i).trim();
      chat.buf = chat.buf.slice(i + 1);
      if (!lineStr) continue;
      try { handleEvent(p.chatId, chat, JSON.parse(lineStr) as Record<string, unknown>); }
      catch { /* keep-alives / partial frames */ }
    }
  });
  let errTail = "";
  proc.stderr.on("data", (b: Buffer) => { errTail = (errTail + b.toString("utf-8")).slice(-2000); });
  proc.on("exit", (code) => {
    live.delete(p.chatId);
    if (code !== 0 && code !== null) {
      const said = errTail.trim() || `claude exited ${code}`;
      const fix = authFix(`${said}\n${chat.buf}`, "claude");
      emit(chat, "glyphh-agent:error", { runId: chat.runId, error: fix ? fix.message : said, fix: fix ?? undefined });
      emit(chat, "glyphh-agent:done", { runId: chat.runId, stopped: true });
    }
  });
  live.set(p.chatId, chat);
  return chat;
}

/** One user turn onto the wire — text plus attachment references. Images ride
 *  as REAL vision blocks; files/folders ride as path lines the CLI reads. */
function writeUserTurn(c: LiveChat, text: string, attachments: AttachRef[] = []): void {
  const content: Array<Record<string, unknown>> = [];
  const pathLines = attachments.filter((a) => a.kind !== "image").map((a) => `@${a.path}`).join("\n");
  const body = [text, pathLines].filter(Boolean).join("\n\n");
  if (body) content.push({ type: "text", text: body });
  for (const a of attachments.filter((x) => x.kind === "image")) {
    try {
      const bytes = readFileSync(a.path);
      const ext = path.extname(a.path).toLowerCase();
      const media = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
      content.push({ type: "image", source: { type: "base64", media_type: media, data: bytes.toString("base64") } });
    } catch { /* unreadable attachment — the text still sends */ }
  }
  if (!content.length) return;
  c.proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
}

function writeControl(c: LiveChat, request: Record<string, unknown>): string {
  const id = `ctl_${c.nextControl++}`;
  c.proc.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request }) + "\n");
  return id;
}

// ── IPC surface — the exact channels the parked renderer calls ───────────────

export function registerGlyphhCliBridge(): void {
  ipcMain.handle("glyphh-agent-run", async (e, p: RunPayload & { steer?: string; prompt?: string }) => {
    await startLocalMcpServer().catch(() => { /* the spawn still runs, tool-less but honest */ });
    // Re-prime the in-memory resume map from the chat's persisted binding —
    // after a restart the map is empty and a run would start a FRESH CLI
    // session, silently dropping the conversation's context.
    // (re-primed per-CLI below, once the loop has resolved)
    // The composer's contract (unchanged from the old engine): the user turn
    // is already IN the chat store when run arrives — same-renderer IPC
    // ordering guarantees the save landed first. `steer` is a hidden prefix
    // (voice brief), never the message itself.
    const snap = loadSessionsFile();
    const chat = (snap.chats as Array<{ id?: string; messages?: Array<{ role?: string; text?: string }> }>)
      .find((x) => x?.id === p.chatId);
    const lastUser = [...(chat?.messages ?? [])].reverse().find((m) => m?.role === "user");
    const steer = String(p.steer ?? "").trim();
    const text = [steer, String(p.prompt ?? lastUser?.text ?? "").trim()].filter(Boolean).join("\n\n");
    const agent = loopOf(p);
    // Re-prime the per-CLI binding from the chat's persisted map — the
    // in-memory map is empty after a restart, and a run would start a fresh
    // CLI session, silently dropping the conversation's context.
    if (agent && p.cliSessionId && !resumeIds.get(rkey(p.chatId, agent.cli))) {
      resumeIds.set(rkey(p.chatId, agent.cli), p.cliSessionId);
    }
    // The loop's env (gateway lane, memory bridge) is written here, before
    // any spawn, so a chat turn gets the same wiring a terminal open does.
    if (agent) { const row = agentRowFor(agent.id); if (row) await ensureLoopEnv(row, { folder: p.workdir || "", workspace: p.workspace || "" }).catch(() => undefined); }
    // Non-claude loops: one headless turn per send, on the LOOP'S OWN CLI.
    if (agent && agent.cli !== "claude") {
      const prior = live.get(p.chatId);
      if (prior && prior.proc.exitCode === null) { try { prior.proc.kill("SIGTERM"); } catch { /* racing exit */ } }
      if (!text) return { runId: `${p.chatId}:${Date.now()}` };
      return runHeadlessTurn(p, agent, text, e.sender);
    }
    let c = live.get(p.chatId);
    if (c && c.proc.exitCode !== null) { live.delete(p.chatId); c = undefined; }
    if (!c) c = spawnChat(p, e.sender);
    else {
      c.sender = e.sender;
      c.runId = `${p.chatId}:${Date.now()}`;
    }
    const atts = validAttachments(p.attachments);
    if (text || atts.length) writeUserTurn(c, text, atts);
    return { runId: c.runId };
  });

  ipcMain.handle("glyphh-agent-stop", (_e, p: { chatId?: string }) => {
    const c = p.chatId ? live.get(p.chatId) : undefined;
    if (!c) return false;
    try { writeControl(c, { subtype: "interrupt" }); } catch { /* fall through to kill */ }
    setTimeout(() => { if (c.proc.exitCode === null) c.proc.kill("SIGTERM"); }, 3000);
    emit(c, "glyphh-agent:done", { runId: c.runId, stopped: true });
    return true;
  });

  ipcMain.handle("glyphh-agent-inject", (_e, p: { chatId: string; text: string }) => {
    const c = live.get(p.chatId);
    if (!c || c.proc.exitCode !== null) return { injected: false };
    writeUserTurn(c, String(p.text ?? ""));
    return { injected: true };
  });

  ipcMain.handle("glyphh-agent-set-permission", (_e, p: { chatId: string; permission: LiveChat["permission"] }) => {
    const c = live.get(p.chatId);
    if (!c) return { updated: false };
    c.permission = p.permission;
    try { writeControl(c, { subtype: "set_permission_mode", mode: PERM_FLAG[p.permission] }); } catch { return { updated: false }; }
    emit(c, "glyphh-agent:permission", { runId: c.runId, permission: p.permission });
    return { updated: true };
  });

  ipcMain.handle("glyphh-agent-approval-respond", (_e, p: { id: string; allow: boolean }) => {
    const chatId = String(p.id ?? "").split(":")[0] ?? "";
    const c = live.get(chatId);
    const requestId = c?.pending.get(p.id);
    if (!c || !requestId) return false;
    c.pending.delete(p.id);
    c.proc.stdin.write(JSON.stringify({
      type: "control_response",
      // updatedInput must be an OBJECT or ABSENT — null failed the CLI's
      // canUseTool validation, so every ALLOWED permission died with
      // "invalid permission result" (his Gmail open, 2026-09-11).
      response: { subtype: "success", request_id: requestId, response: p.allow ? { behavior: "allow" } : { behavior: "deny", message: "The user declined." } },
    }) + "\n");
    return true;
  });

  // The CLI has no separate ask/connect channels — questions arrive as tool
  // permission asks and are answered there. These stay callable so old
  // renderer paths never throw.
  ipcMain.handle("glyphh-agent-ask-respond", () => false);
  ipcMain.handle("glyphh-agent-connect-respond", () => false);

  ipcMain.handle("glyphh-agent-context-usage", (_e, p: { chatId: string }) => {
    const c = live.get(p.chatId);
    const tokens = c ? c.usage.inTokens + c.usage.outTokens : 0;
    const budget = 200_000;
    return { tokens, budget, ratio: Math.min(1, tokens / budget), foldAt: 0.8, lanes: [] };
  });

  // Compaction is the CLI's own affordance (/compact in the Terminal view);
  // the bridge doesn't fake it.
  ipcMain.handle("glyphh-agent-compact", () => ({ ok: false, reason: "Compaction rides the CLI — open the Terminal view and /compact." }));
  ipcMain.handle("glyphh-agent-remember", () => false);

  ipcMain.handle("glyphh-agent-pick-attachments", async (_e, p: { mode?: "files" | "folder" }) => pickAttachments(p?.mode));
  ipcMain.handle("glyphh-agent-classify-paths", (_e, p: { paths: string[] }) => classifyPaths(p?.paths ?? []));
  ipcMain.handle("glyphh-agent-save-clipboard-image", (_e, p: { bytes: ArrayBuffer }) => saveClipboardImage(p.bytes));

  // Terminal ⇄ Chat handoff: the chat view adopts a CLI session id so its
  // next spawn --resumes the SAME conversation the terminal view had.
  ipcMain.handle("glyphh-agent-bind-session", (_e, p: { chatId: string; cliSessionId: string }) => {
    if (!p?.chatId || !p?.cliSessionId) return false;
    const c = live.get(p.chatId);
    const bindCli = (p as { cli?: string }).cli || "claude";
    if (c && c.proc.exitCode === null) return resumeIds.get(rkey(p.chatId, bindCli)) === p.cliSessionId; // live process keeps its session
    resumeIds.set(rkey(p.chatId, bindCli), p.cliSessionId);
    return true;
  });
  // The chat's CURRENT CLI session id — the terminal view resumes it.
  ipcMain.handle("glyphh-agent-session-of", (_e, p: { chatId: string; cli?: string }) => resumeIds.get(rkey(p?.chatId ?? "", p?.cli || "claude")) ?? null);

  // The CLI transcript IS the history (his report, 2026-09-11: switching
  // views must carry the conversation). Plain text turns only — tool frames
  // and meta stay in the terminal view where they belong.
  ipcMain.handle("glyphh-agent-transcript", (_e, p: { sessionId: string }) => {
    const base = `${String(p?.sessionId ?? "")}.jsonl`;
    if (!/^[\w-]+\.jsonl$/.test(base)) return { ok: false, error: "bad session id" };
    const root = path.join(homedir(), ".claude", "projects");
    let file = "";
    try {
      for (const d of readdirSync(root)) {
        const f = path.join(root, d, base);
        if (existsSync(f)) { file = f; break; }
      }
    } catch { /* no store yet */ }
    // Not in claude's store — a CODEX rollout carries the id in its filename
    // (one combined history, his order 2026-09-14: adoption must work for
    // every CLI the recents list).
    if (!file) {
      const codexRoot = path.join(homedir(), ".codex", "sessions");
      const walk = (dir: string, depth: number): string => {
        let names: string[] = [];
        try { names = readdirSync(dir); } catch { return ""; }
        for (const n of names) {
          const f = path.join(dir, n);
          try {
            if (n.endsWith(`-${String(p.sessionId)}.jsonl`)) return f;
            if (depth < 3 && !n.includes(".")) { const hit = walk(f, depth + 1); if (hit) return hit; }
          } catch { /* raced */ }
        }
        return "";
      };
      const codexFile = walk(codexRoot, 0);
      if (codexFile) return codexTranscript(codexFile);
      const other = otherCliTranscript(String(p.sessionId));
      if (other) return other;
    }
    if (!file) return { ok: false, error: "session not found" };
    const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
    let title = "";
    let cwd = "";
    try {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        let j: Record<string, unknown>;
        try { j = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (!cwd && typeof j.cwd === "string") cwd = j.cwd;
        if (!title && j.type === "summary" && typeof j.summary === "string") title = j.summary;
        if (j.type !== "user" && j.type !== "assistant") continue;
        const content = (j.message as { content?: unknown } | undefined)?.content;
        let text = "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          text = (content as Array<{ type?: string; text?: string }>)
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text as string).join("\n");
        }
        // Tool results ride user frames — text-less frames are the tool lane.
        if (text.trim()) turns.push({ role: j.type as "user" | "assistant", text: text.trim() });
      }
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    if (!title) title = turns.find((t) => t.role === "user")?.text.slice(0, 80) ?? "Session";
    return { ok: true, title, cwd, turns: turns.slice(-200) };
  });

  ipcMain.handle("glyphh-agent-sessions-load", () => loadSessionsFile());
  ipcMain.handle("glyphh-agent-sessions-save", (_e, p: { chats: unknown[]; currentId: string | null }) => {
    saveSessionsFile({ chats: p?.chats ?? [], currentId: p?.currentId ?? null });
    return true;
  });
}

/** A codex rollout as chat turns — user input_text (instruction/environment
 *  preludes skipped) and assistant output text, plus session_meta's cwd. */
function codexTranscript(file: string): { ok: true; title: string; cwd: string; turns: Array<{ role: "user" | "assistant"; text: string }> } | { ok: false; error: string } {
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  let cwd = "";
  try {
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let j: { type?: string; payload?: Record<string, unknown> };
      try { j = JSON.parse(line) as typeof j; } catch { continue; }
      const p = j.payload ?? {};
      if (j.type === "session_meta" && typeof p.cwd === "string") cwd = p.cwd;
      if (j.type !== "response_item" || p.type !== "message") continue;
      const role = p.role === "user" ? "user" : p.role === "assistant" ? "assistant" : null;
      if (!role || !Array.isArray(p.content)) continue;
      const text = (p.content as Array<{ type?: string; text?: string }>)
        .filter((c) => (c.type === "input_text" || c.type === "output_text" || c.type === "text") && c.text)
        .map((c) => c.text as string).join("\n").trim();
      if (!text) continue;
      if (role === "user" && /^(#|<INSTRUCTIONS|<environment_context|<ENVIRONMENT)/.test(text)) continue;
      turns.push({ role, text });
    }
  } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  const title = turns.find((t) => t.role === "user")?.text.replace(/\s+/g, " ").slice(0, 80) ?? "Session";
  return { ok: true, title, cwd, turns: turns.slice(-200) };
}

type Transcript = { ok: true; title: string; cwd: string; turns: Array<{ role: "user" | "assistant"; text: string }> };

/** Gemini, Copilot and Cursor sessions as chat turns (his order, 2026-09-16:
 *  every recent the rail lists must open). Cursor keeps its turns in a
 *  database, so it opens with its title and folder and no history painted. */
function otherCliTranscript(sessionId: string): Transcript | null {
  const g = geminiSessionFiles().find((f) => { try { return readFileSync(f.file, "utf-8").slice(0, 400).includes(`"sessionId":"${sessionId}"`); } catch { return false; } });
  if (g) return geminiTranscript(g.file, g.cwd);
  const cp = path.join(homedir(), ".copilot", "session-state", sessionId, "events.jsonl");
  if (/^[0-9a-f-]{36}$/i.test(sessionId) && existsSync(cp)) return copilotTranscript(cp);
  const cu = cursorSessionFiles().find((f) => path.basename(path.dirname(f.file)) === sessionId);
  if (cu) { const head = readCursorSessionHead(cu.file, cu.mtime, cu.cwd); return { ok: true, title: head?.title || "Cursor session", cwd: cu.cwd, turns: [] }; }
  return null;
}

function geminiTranscript(file: string, cwd: string): Transcript {
  const turns: Transcript["turns"] = [];
  type Msg = { type?: string; content?: Array<{ text?: string }> | string };
  const consider = (m: Msg): void => {
    const role = m.type === "user" ? "user" : m.type === "gemini" ? "assistant" : null;
    if (!role) return;
    const text = (Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("") : String(m.content || "")).trim();
    if (!text || (role === "user" && (text.startsWith("<session_context>") || NOISE_TITLE.test(text)))) return;
    turns.push({ role, text });
  };
  try {
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let j: { $set?: { messages?: Msg[] }; $push?: { messages?: Msg | Msg[] }; messages?: Msg[] };
      try { j = JSON.parse(line) as typeof j; } catch { continue; }
      for (const m of j.$set?.messages ?? j.messages ?? []) consider(m);
      const pushed = j.$push?.messages;
      if (pushed) for (const m of Array.isArray(pushed) ? pushed : [pushed]) consider(m);
    }
  } catch { /* partial file */ }
  const title = turns.find((t) => t.role === "user")?.text.replace(/\s+/g, " ").slice(0, 80) ?? "Gemini session";
  return { ok: true, title, cwd, turns: turns.slice(-200) };
}

function copilotTranscript(file: string): Transcript {
  const turns: Transcript["turns"] = [];
  let cwd = "";
  try {
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let j: { type?: string; data?: { content?: string; context?: { cwd?: string }; response?: { content?: string; role?: string } } };
      try { j = JSON.parse(line) as typeof j; } catch { continue; }
      if (j.type === "session.start") cwd = j.data?.context?.cwd || cwd;
      if (j.type === "user.message" && typeof j.data?.content === "string") { const t = j.data.content.trim(); if (t && !NOISE_TITLE.test(t)) turns.push({ role: "user", text: t }); }
      if (j.type === "model.response" && typeof j.data?.response?.content === "string") { const t = j.data.response.content.trim(); if (t && !t.startsWith("<session-title>")) turns.push({ role: "assistant", text: t }); }
      if (j.type === "chat" && typeof j.data?.content === "string") { const t = j.data.content.trim(); if (t) turns.push({ role: "assistant", text: t }); }
    }
  } catch { /* partial file */ }
  const title = turns.find((t) => t.role === "user")?.text.replace(/\s+/g, " ").slice(0, 80) ?? "Copilot session";
  return { ok: true, title, cwd, turns: turns.slice(-200) };
}

/** Everything down on quit — the CLI processes are the app's children. */
export function shutdownGlyphhCliBridge(): void {
  for (const [, c] of live) { try { c.proc.kill("SIGTERM"); } catch { /* already gone */ } }
  live.clear();
}
