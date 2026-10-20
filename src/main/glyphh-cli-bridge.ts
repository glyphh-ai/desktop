/**
 * glyphh-cli-bridge.ts — THE VENDOR CLIS AS CHAT ENGINES for the agent panel.
 *
 * A chat on a CLI loop runs on that CLI, not on a copy of it: the vendor's
 * own process, its own login (or the local router on the gateway route), its
 * own session store. This module translates each CLI's output into the
 * renderer contract the panel already speaks for our own loop —
 * glyphh-agent:setup / :delta / :tool / :approval / :progress / :error / :done
 * — so the panel draws a Claude or Codex turn exactly as it draws a Glyphh one.
 *
 *   claude                       ONE long-lived process per chat in
 *                                bidirectional stream-json: deltas, tool
 *                                cards, permission asks on the control
 *                                channel, interrupts, a model change respawns
 *                                it on --resume
 *   codex                        one `codex exec --json` per send; JSONL items
 *                                become deltas and tool cards, and the turns
 *                                chain through codex's own session
 *   gemini · copilot · cursor    one print-mode process per send, its text
 *                                streamed as it arrives
 *
 * The Glyphh loop never comes here (agent-ipc.ts sends it to glyphh-loop.ts).
 *
 * THE BINDING: the Glyphh chat is the session of record; each CLI holds AT
 * MOST ONE session per chat, keyed chatId::cli. Ids never translate between
 * CLIs — a claude session id must never feed a codex resume. The map is memory;
 * the renderer persists it on the chat row (`cliSessionIds[cli]`, from the
 * setup frame) and hands it back on the next run, so a restart resumes.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { validAttachments, type AttachRef } from "./glyphh-agent-attachments.js";
import { cliFix } from "./cli-auth.js";
import { isInterrupted, INTERRUPT_SAID } from "./cli-interrupt.js";
import {
  RESUMABLE_HEADLESS, composeClaudeChat, composeHeadless, launchModel, prepareCliLaunch, withPriorTurns,
  type CliAgentRow, type SessionPermission,
} from "./cli-agents.js";
import type { CliRoute, RouteHints } from "./cli-route.js";
import type { CliId } from "./cli-ids.js";
import { hostDialect, shellInvocation } from "./shell-dialect.js";
import { agentLive, noteRunDelta, registerRunRebinder } from "./agent-live.js";
import { commitBackgroundTurn } from "./agent-ipc.js";

// ── live processes ───────────────────────────────────────────────────────────

export interface LiveChat {
  /** The Glyphh chat this process serves — the live-run ledger's key. */
  chatId: string;
  proc: Pick<ChildProcessWithoutNullStreams, "stdin" | "kill" | "exitCode">;
  runId: string;
  sender: WebContents;
  cli: CliId;
  /** The CLI's own session id — resume and the terminal view key off it. */
  cliSessionId: string | null;
  permission: SessionPermission;
  /** What the process was spawned with; a different ask respawns it. */
  model: string;
  effort: string;
  route: CliRoute;
  buf: string;
  /** This turn's answer so far, for a done nobody is listening to. */
  answer: string;
  usage: { inTokens: number; outTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  nextControl: number;
  /** Approval id → the control_request id the CLI is waiting on. */
  pending: Map<string, string>;
  /** THE USER STOPPED THIS ONE: we kill the process a moment later, so its
   *  non-zero exit (and the CLI's is_error result) is our doing, not a failure. */
  stopping?: boolean;
}

const live = new Map<string, LiveChat>();
const resumeIds = new Map<string, string>();
const rkey = (chatId: string, cli: string): string => `${chatId}::${cli}`;

/** Has this chat ever run on a CLI in this process (for routing the panel's
 *  stop, usage and compaction asks)? */
export function cliChatKnown(chatId: string): boolean {
  if (live.has(chatId)) return true;
  for (const k of resumeIds.keys()) if (k.startsWith(`${chatId}::`)) return true;
  return false;
}

/** Point a chat's CLI lane at a session (the terminal → chat hop, an adopted
 *  recents row). A live process keeps its own session; true when bound. */
export function bindCliSession(chatId: string, cli: string, sid: string): boolean {
  if (!chatId || !sid) return false;
  const c = live.get(chatId);
  if (c && c.cli === cli && c.proc.exitCode === null) return c.cliSessionId === sid;
  resumeIds.set(rkey(chatId, cli), sid);
  return true;
}

/** The chat's current session on one CLI, for the >_ hop to resume. */
export function cliSessionOf(chatId: string, cli: string): string | null {
  return resumeIds.get(rkey(chatId, cli)) ?? null;
}

function setResume(c: LiveChat, sid: string): void {
  c.cliSessionId = sid;
  resumeIds.set(rkey(c.chatId, c.cli), sid);
  agentLive.update(c.chatId, { cliSessionId: sid });
}

function emit(c: LiveChat, channel: string, payload: Record<string, unknown>): void {
  // THE LEDGER RIDES THE STREAM: working on a delta, waiting on an approval,
  // red on an error (kept after done), clear on done.
  if (channel === "glyphh-agent:delta") {
    const d = String(payload.delta ?? "");
    c.answer += d;
    noteRunDelta(c.chatId, d);
    agentLive.update(c.chatId, { status: "working" });
  } else if (channel === "glyphh-agent:approval") agentLive.update(c.chatId, { status: "waiting" });
  else if (channel === "glyphh-agent:error") agentLive.update(c.chatId, { status: "error" });
  if (channel === "glyphh-agent:done") {
    agentLive.done(c.chatId, c.runId);
    // NOBODY IS LISTENING: the panel that would commit the answer is gone, so
    // main writes it into the shared store and the next surface reads it.
    if (c.sender.isDestroyed()) commitBackgroundTurn(c.chatId, c.answer);
  }
  try { if (!c.sender.isDestroyed()) c.sender.send(channel, payload); } catch { /* window closed mid-run */ }
}

function writeControl(c: LiveChat, request: Record<string, unknown>): void {
  c.proc.stdin.write(JSON.stringify({ type: "control_request", request_id: `ctl_${c.nextControl++}`, request }) + "\n");
}

function allowTool(c: LiveChat, requestId: string, allow: boolean): void {
  c.proc.stdin.write(JSON.stringify({
    type: "control_response",
    // updatedInput must be an OBJECT or ABSENT — a null fails the CLI's own
    // permission-result validation and every allowed step dies.
    response: { subtype: "success", request_id: requestId, response: allow ? { behavior: "allow" } : { behavior: "deny", message: "The user declined." } },
  }) + "\n");
}

// ── claude: the stream-json translation ──────────────────────────────────────

/** One stream-json frame from claude, onto the panel's channels. */
export function handleClaudeEvent(c: LiveChat, ev: Record<string, unknown>): void {
  const type = String(ev.type ?? "");

  if (type === "system" && ev.subtype === "init") {
    const sid = typeof ev.session_id === "string" ? ev.session_id : null;
    if (sid) setResume(c, sid);
    // The renderer PERSISTS the binding on its chat row: the resume map is
    // memory-only, and without it a restart would forget the session.
    emit(c, "glyphh-agent:setup", { phase: "ready", chatId: c.chatId, cli: c.cli, route: c.route, model: typeof ev.model === "string" ? ev.model : undefined, cliSessionId: sid ?? undefined });
    return;
  }

  // Partial assistant frames (--include-partial-messages): text deltas stream;
  // a tool_use start opens a tool card.
  if (type === "stream_event") {
    const e = (ev.event ?? {}) as Record<string, unknown>;
    const et = String(e.type ?? "");
    if (et === "content_block_delta") {
      const d = (e.delta ?? {}) as { type?: string; text?: string };
      if (d.type === "text_delta" && d.text) emit(c, "glyphh-agent:delta", { runId: c.runId, delta: d.text });
    } else if (et === "content_block_start") {
      const cb = (e.content_block ?? {}) as { type?: string; name?: string };
      if (cb.type === "tool_use" && cb.name) emit(c, "glyphh-agent:tool", { runId: c.runId, phase: "start", name: cb.name, title: cb.name });
    } else if (et === "message_delta") {
      const u = (e.usage ?? {}) as { output_tokens?: number };
      if (typeof u.output_tokens === "number") {
        c.usage.outTokens = u.output_tokens;
        emit(c, "glyphh-agent:progress", { runId: c.runId, inTokens: c.usage.inTokens, outTokens: c.usage.outTokens });
      }
    }
    return;
  }

  // Whole-message frames: a tool result closes the open tool card.
  if (type === "user") {
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    for (const block of Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []) {
      if (block.type === "tool_result") emit(c, "glyphh-agent:tool", { runId: c.runId, phase: "done", failed: block.is_error === true });
    }
    return;
  }

  // Permission asks ride the CLI's control channel; the renderer answers them
  // through the same approval cards our own loop uses.
  if (type === "control_request") {
    const req = (ev.request ?? {}) as Record<string, unknown>;
    if (req.subtype !== "can_use_tool") return;
    const requestId = String(ev.request_id ?? "");
    // AUTO TRUMPS THE ASK: bypass covers the CLI's own tools, but an MCP server
    // can still send a request up this channel, and a card for it would make
    // Auto stop and wait for a person who was promised they would not be asked.
    if (c.permission === "auto") { allowTool(c, requestId, true); return; }
    // Never ends in ":g<n>" — that shape is our own loop's approval id.
    const approvalId = `${c.chatId}:cli-${requestId}`;
    c.pending.set(approvalId, requestId);
    emit(c, "glyphh-agent:approval", { id: approvalId, kind: "tool", title: String(req.tool_name ?? "tool"), detail: JSON.stringify(req.input ?? {}, null, 2).slice(0, 2000) });
    return;
  }

  if (type === "result") {
    const u = (ev.usage ?? {}) as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    if (typeof u.input_tokens === "number") c.usage.inTokens = u.input_tokens;
    if (typeof u.output_tokens === "number") c.usage.outTokens = u.output_tokens;
    // Cached prompt tokens sit in the window and are billed too; input_tokens excludes them.
    if (typeof u.cache_read_input_tokens === "number") c.usage.cacheReadTokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") c.usage.cacheWriteTokens = u.cache_creation_input_tokens;
    emit(c, "glyphh-agent:progress", { runId: c.runId, inTokens: c.usage.inTokens, outTokens: c.usage.outTokens });
    // A STOP IS NOT A FAILURE: the CLI answers an interrupt with an is_error
    // result before it ever exits. One we asked for was already settled as
    // stopped (stopCliChat); the process lives on for the next send.
    if (c.stopping) { c.stopping = false; return; }
    if (isInterrupted(ev)) { emit(c, "glyphh-agent:done", { runId: c.runId, stopped: true }); return; }
    if (ev.is_error) {
      const said = String(ev.result ?? "the run failed");
      const fix = cliFix(said, c.cli);
      emit(c, "glyphh-agent:error", { runId: c.runId, error: fix ? fix.message : said, ...(fix?.kind === "signin" ? { fix } : {}) });
    }
    emit(c, "glyphh-agent:done", { runId: c.runId, stopped: !(ev.subtype === "success" || ev.subtype === "error_during_execution") });
  }
}

/** One user turn onto claude's stdin: the text with file/folder attachments
 *  as `@path` lines it reads itself, images as real vision blocks. */
function writeUserTurn(c: LiveChat, text: string, attachments: AttachRef[]): boolean {
  const content: Array<Record<string, unknown>> = [];
  const pathLines = attachments.filter((a) => a.kind !== "image").map((a) => `@${a.path}`).join("\n");
  const body = [text, pathLines].filter(Boolean).join("\n\n");
  if (body) content.push({ type: "text", text: body });
  for (const a of attachments.filter((x) => x.kind === "image")) {
    try {
      const ext = path.extname(a.path).toLowerCase();
      const media = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/png";
      content.push({ type: "image", source: { type: "base64", media_type: media, data: readFileSync(a.path).toString("base64") } });
    } catch { /* unreadable attachment — the text still sends */ }
  }
  if (!content.length) return false;
  c.proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  return true;
}

// ── codex: the JSONL translation ─────────────────────────────────────────────

/** What one line of `codex exec --json` means for the panel. */
export interface CodexLine {
  /** The session the line names (thread.started), for resume and the >_ hop. */
  sessionId?: string;
  frames: Array<{ channel: string; payload: Record<string, unknown> }>;
}

/**
 * One JSONL event from codex. Agent messages arrive whole as they complete;
 * every other item (a command, an MCP call, a file change) is a tool card from
 * item.started to item.completed — so a long turn shows its work as it goes.
 * Older codex builds wrapped the same events in `msg`.
 */
export function codexFrames(j: Record<string, unknown>, runId: string): CodexLine {
  const out: CodexLine = { frames: [] };
  const msg = (j.msg ?? {}) as { type?: string; message?: string; session_id?: string };
  const sid = (typeof j.thread_id === "string" && j.thread_id) || (typeof j.session_id === "string" && j.session_id) || (typeof msg.session_id === "string" && msg.session_id) || "";
  if (sid) out.sessionId = sid;
  const item = j.item as { type?: string; text?: string; command?: string; server?: string; tool?: string; status?: string } | undefined;
  const said = item?.type === "agent_message" ? item.text : msg.type === "agent_message" ? msg.message : undefined;
  if (said && j.type !== "item.started") out.frames.push({ channel: "glyphh-agent:delta", payload: { runId, delta: `${said}\n\n` } });
  else if (item?.type && item.type !== "agent_message" && item.type !== "reasoning") {
    const title = item.command || (item.server && item.tool ? `${item.server}: ${item.tool}` : item.tool || item.type);
    if (j.type === "item.started") out.frames.push({ channel: "glyphh-agent:tool", payload: { runId, phase: "start", name: item.type, title } });
    else if (j.type === "item.completed") out.frames.push({ channel: "glyphh-agent:tool", payload: { runId, phase: "done", failed: item.status === "failed" } });
  }
  if (j.type === "turn.completed") {
    const u = (j.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    if (typeof u.input_tokens === "number" || typeof u.output_tokens === "number") {
      out.frames.push({ channel: "glyphh-agent:progress", payload: { runId, inTokens: Number(u.input_tokens) || 0, outTokens: Number(u.output_tokens) || 0 } });
    }
  }
  return out;
}

/**
 * WHAT A FAILED TURN SAYS TO THE USER: the CLI's own sentences are worth
 * showing; its internal traces and any JSON body it printed are not. Nothing
 * is hidden from the log — the raw tail is still written there.
 */
const CLI_NOISE = [
  /rmcp::transport|codex_core::util|OutputTextDelta without active item/,
  /^\s*[{[]/,                                   // a JSON body, not a message
  /^\s*at\s|^\s*\w+::\w+/,                      // stack / module traces
  /WARNING: proceeding, even though we could not create PATH aliases/,
];
export function cliStderrSummary(raw: string): string {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !CLI_NOISE.some((re) => re.test(l)));
  // The LAST lines are the ones about this failure; a few is a sentence, a hundred is a dump.
  const kept = lines.slice(-6).join("\n").trim();
  return kept.length > 600 ? `${kept.slice(0, 599)}…` : kept;
}

// ── turns ────────────────────────────────────────────────────────────────────

export interface CliTurn {
  chatId: string;
  row: CliAgentRow;
  text: string;
  history: ReadonlyArray<{ role?: string; text?: string }>;
  workdir: string;
  permission: SessionPermission;
  model?: string;
  effort?: string;
  attachments?: AttachRef[];
  route?: RouteHints;
  /** The chat's persisted session on this CLI, re-priming the memory map after a restart. */
  cliSessionId?: string;
}

/** A run id unique even for two sends in the same millisecond: the ledger
 *  tells a stale done from the current turn's by it. */
let runSeq = 0;
const newRun = (chatId: string): string => `${chatId}:${Date.now()}-${++runSeq}`;

function freshChat(t: CliTurn, sender: WebContents, proc: LiveChat["proc"], route: CliRoute, model: string): LiveChat {
  return {
    chatId: t.chatId, proc, runId: newRun(t.chatId), sender, cli: t.row.cli,
    cliSessionId: resumeIds.get(rkey(t.chatId, t.row.cli)) ?? null,
    permission: t.permission, model, effort: t.effort ?? "", route,
    buf: "", answer: "",
    usage: { inTokens: 0, outTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    nextControl: 1, pending: new Map(),
  };
}

/** The login shell runs the line, so the member's PATH (brew, nvm) applies —
 *  Electron's GUI environment does not carry it. */
function spawnLine(line: string, cwd: string): ChildProcessWithoutNullStreams {
  const [sh, args] = shellInvocation(hostDialect());
  return spawn(sh, [...args, line], { cwd: existsSync(cwd) ? cwd : homedir(), env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
}

/** The line in main's log: secrets blanked, the prompt elided. */
const loggable = (line: string): string => line
  .replace(/((?:TOKEN|KEY|SECRET)=)("[^"]*"|'[^']*'|\S+)/g, "$1…")
  .replace(/--append-system-prompt '(?:[^']|'\\'')*'/, "--append-system-prompt '…'")
  .slice(0, 600);

function spawnClaude(t: CliTurn, sender: WebContents, route: CliRoute, mcp: boolean, model: string): LiveChat {
  const line = composeClaudeChat({ ...t.row, mcp }, {
    permission: t.permission, model, route, mcp,
    ...(t.effort ? { effort: t.effort } : {}),
    ...(resumeIds.get(rkey(t.chatId, "claude")) ? { resumeId: resumeIds.get(rkey(t.chatId, "claude"))! } : {}),
  });
  console.warn("[cli-bridge] claude chat", JSON.stringify({ chatId: t.chatId, route, model, line: loggable(line) }));
  const proc = spawnLine(line, t.workdir);
  const c = freshChat(t, sender, proc, route, model);
  proc.stdout.on("data", (b: Buffer) => {
    c.buf += b.toString("utf-8");
    let i: number;
    while ((i = c.buf.indexOf("\n")) >= 0) {
      const frame = c.buf.slice(0, i).trim();
      c.buf = c.buf.slice(i + 1);
      if (!frame) continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(frame) as Record<string, unknown>; } catch { continue; /* a keep-alive, not a frame */ }
      handleClaudeEvent(c, ev);
    }
  });
  let errTail = "";
  proc.stderr.on("data", (b: Buffer) => { errTail = (errTail + b.toString("utf-8")).slice(-2000); });
  proc.on("exit", (code) => {
    if (live.get(t.chatId) === c) live.delete(t.chatId);
    // Our own SIGTERM (a stop, a respawn) exits non-zero; that is not a
    // failure, and the stop already settled the run.
    if (c.stopping) return;
    if (code !== 0 && code !== null) {
      console.warn("[cli-bridge] claude exited", JSON.stringify({ chatId: t.chatId, code, stderr: errTail.trim().slice(-300) }));
      const said = cliStderrSummary(errTail) || `claude exited ${code}`;
      const fix = cliFix(`${said}\n${c.buf}`, "claude");
      emit(c, "glyphh-agent:error", { runId: c.runId, error: fix ? fix.message : said, ...(fix?.kind === "signin" ? { fix } : {}) });
      emit(c, "glyphh-agent:done", { runId: c.runId, stopped: false });
    } else {
      agentLive.done(t.chatId, c.runId);
    }
  });
  live.set(t.chatId, c);
  return c;
}

async function runClaudeTurn(sender: WebContents, t: CliTurn): Promise<{ runId: string }> {
  const { route, mcp } = await prepareCliLaunch(t.row, t.route);
  const model = launchModel(t.row, route, t.model);
  let c = live.get(t.chatId);
  if (c && (c.proc.exitCode !== null || c.cli !== "claude")) { live.delete(t.chatId); c = undefined; }
  // THE CHIP IS THE MODEL: the process keeps the model, effort and route it was
  // spawned with for life, so a changed one respawns it; the conversation
  // continues through --resume on the CLI's own session.
  if (c && (c.model !== model || c.effort !== (t.effort ?? "") || c.route !== route)) {
    console.warn("[cli-bridge] respawning claude", JSON.stringify({ chatId: t.chatId, model: [c.model, model], effort: [c.effort, t.effort ?? ""], route: [c.route, route] }));
    c.stopping = true;
    live.delete(t.chatId);
    try { c.proc.kill("SIGTERM"); } catch { /* racing exit */ }
    c = undefined;
  }
  if (!c) c = spawnClaude(t, sender, route, mcp, model);
  else {
    c.sender = sender;
    c.runId = newRun(t.chatId);
    c.answer = "";
    if (c.permission !== t.permission) setCliPermission(t.chatId, t.permission);
  }
  const atts = validAttachments(t.attachments);
  if (writeUserTurn(c, t.text, atts)) {
    agentLive.start({ chatId: t.chatId, cliSessionId: c.cliSessionId, cli: "claude", runId: c.runId, senderId: sender.id });
  }
  return { runId: c.runId };
}

/** Codex, Gemini, Copilot and Cursor: one print-mode process per send. */
async function runHeadlessTurn(sender: WebContents, t: CliTurn): Promise<{ runId: string }> {
  const prior = live.get(t.chatId);
  if (prior && prior.proc.exitCode === null) { prior.stopping = true; try { prior.proc.kill("SIGTERM"); } catch { /* racing exit */ } }
  const { route, mcp } = await prepareCliLaunch(t.row, t.route);
  const model = launchModel(t.row, route, t.model);
  const cli = t.row.cli;
  const resumable = RESUMABLE_HEADLESS.has(cli);
  const resumeId = resumable ? resumeIds.get(rkey(t.chatId, cli)) : undefined;
  // A turn with nothing to resume is told the conversation so far.
  const prompt = resumeId ? t.text : withPriorTurns(t.history, t.text);
  const opts = { permission: t.permission, model, mcp, ...(t.effort ? { effort: t.effort } : {}), ...(resumeId ? { resumeId } : {}) };
  const line = composeHeadless({ ...t.row, mcp }, prompt, opts);
  // ONE LINE PER TURN in main's log, the prompt left out, so a silent turn can be read.
  console.warn("[cli-bridge] headless turn", JSON.stringify({ chatId: t.chatId, cli, route, model, resume: resumeId ?? null, line: loggable(composeHeadless({ ...t.row, mcp }, "…", opts)) }));
  // Attachments have no seam on a print-mode line: images and files are named
  // in the text instead, so the CLI can open what it is able to.
  const proc = spawnLine(line, t.workdir);
  // A print-mode CLI reads nothing from us: close stdin at once, or codex
  // waits on it for a prompt it already has.
  try { proc.stdin.end(); } catch { /* already closed */ }
  const c = freshChat(t, sender, proc, route, model);
  live.set(t.chatId, c);
  agentLive.start({ chatId: t.chatId, cliSessionId: c.cliSessionId, cli, runId: c.runId, senderId: sender.id });
  emit(c, "glyphh-agent:setup", { phase: "ready", chatId: c.chatId, cli, route, model: model || undefined, cliSessionId: c.cliSessionId ?? undefined });
  let sawJson = false;
  proc.stdout.on("data", (b: Buffer) => {
    c.buf += b.toString("utf-8");
    let plain = "";
    let i: number;
    while ((i = c.buf.indexOf("\n")) >= 0) {
      const raw = c.buf.slice(0, i);
      c.buf = c.buf.slice(i + 1);
      const s = raw.trim();
      if (cli === "codex" && s.startsWith("{")) {
        let j: Record<string, unknown> | null = null;
        try { j = JSON.parse(s) as Record<string, unknown>; } catch { j = null; }
        if (j) {
          sawJson = true;
          const r = codexFrames(j, c.runId);
          if (r.sessionId && r.sessionId !== c.cliSessionId) {
            setResume(c, r.sessionId);
            emit(c, "glyphh-agent:setup", { phase: "ready", chatId: c.chatId, cli, route, cliSessionId: r.sessionId });
          }
          for (const f of r.frames) emit(c, f.channel, f.payload);
          continue;
        }
      }
      if (!sawJson) plain += `${raw}\n`;
    }
    if (plain) emit(c, "glyphh-agent:delta", { runId: c.runId, delta: plain });
  });
  let errTail = "";
  proc.stderr.on("data", (b: Buffer) => { errTail = (errTail + b.toString("utf-8")).slice(-2000); });
  proc.on("exit", (code) => {
    if (live.get(t.chatId) === c) live.delete(t.chatId);
    console.warn("[cli-bridge] headless turn ended", JSON.stringify({ chatId: t.chatId, cli, code, sawJson, stderr: errTail.trim().slice(-300) }));
    if (c.buf.trim() && !sawJson) emit(c, "glyphh-agent:delta", { runId: c.runId, delta: c.buf });
    // A STOP IS NOT A FAILURE: stopCliChat already settled this run as stopped
    // and the renderer has moved on, often onto the message it just queued.
    if (c.stopping) return;
    if (code !== 0 && code !== null) {
      const said = cliStderrSummary(errTail) || c.buf.trim().slice(-800) || `${cli} exited ${code}`;
      if (INTERRUPT_SAID.test(said)) { emit(c, "glyphh-agent:done", { runId: c.runId, stopped: true }); return; }
      const fix = cliFix(`${said}\n${c.buf}`, cli);
      emit(c, "glyphh-agent:error", { runId: c.runId, error: fix ? fix.message : said, ...(fix?.kind === "signin" ? { fix } : {}) });
    }
    emit(c, "glyphh-agent:done", { runId: c.runId, stopped: false });
  });
  return { runId: c.runId };
}

/** One send on a CLI loop. The user turn is already in the chat store. */
export async function runCliTurn(sender: WebContents, t: CliTurn): Promise<{ runId: string }> {
  // Re-prime the per-CLI binding from the chat's persisted map: after a
  // restart the memory map is empty and a run would start a fresh session.
  if (t.cliSessionId && !resumeIds.has(rkey(t.chatId, t.row.cli))) resumeIds.set(rkey(t.chatId, t.row.cli), t.cliSessionId);
  if (!t.text.trim() && !t.attachments?.length) return { runId: newRun(t.chatId) };
  return t.row.cli === "claude" ? runClaudeTurn(sender, t) : runHeadlessTurn(sender, { ...t, text: withAttachmentNames(t.text, t.attachments) });
}

/** A print-mode turn names its attachments in the text — the CLI opens what it can. */
function withAttachmentNames(text: string, attachments: AttachRef[] | undefined): string {
  const atts = validAttachments(attachments);
  return atts.length ? `${text}\n\n${atts.map((a) => `@${a.path}`).join("\n")}` : text;
}

/** Stop the chat's CLI turn: claude is interrupted on its control channel
 *  (and killed if it does not answer), a print-mode turn is killed. */
export function stopCliChat(chatId: string): boolean {
  const c = live.get(chatId);
  if (!c || c.proc.exitCode !== null) return false;
  c.stopping = true;
  if (c.cli === "claude") {
    try { writeControl(c, { subtype: "interrupt" }); } catch { /* the kill below covers it */ }
    // An interrupt the CLI acknowledged clears `stopping` (its result frame);
    // one it never answered ends with the process.
    setTimeout(() => { if (c.stopping && c.proc.exitCode === null) { try { c.proc.kill("SIGTERM"); } catch { /* racing exit */ } } }, 3000);
  } else {
    try { c.proc.kill("SIGTERM"); } catch { /* racing exit */ }
  }
  emit(c, "glyphh-agent:done", { runId: c.runId, stopped: true });
  return true;
}

/** The session's mode changed mid-chat: claude switches on its control
 *  channel; a print-mode CLI takes it on its next send. */
export function setCliPermission(chatId: string, permission: SessionPermission): boolean {
  const c = live.get(chatId);
  if (!c) return false;
  c.permission = permission;
  if (c.cli !== "claude" || c.proc.exitCode !== null) return false;
  const mode = permission === "ask" ? "default" : permission === "auto" ? "bypassPermissions" : permission;
  try { writeControl(c, { subtype: "set_permission_mode", mode }); } catch { return false; }
  emit(c, "glyphh-agent:permission", { runId: c.runId, permission });
  return true;
}

/** Is this approval one of a CLI's? */
export function isCliApproval(id: string): boolean {
  for (const c of live.values()) if (c.pending.has(id)) return true;
  return false;
}

export function respondCliApproval(id: string, allow: boolean): boolean {
  for (const c of live.values()) {
    const requestId = c.pending.get(id);
    if (!requestId) continue;
    c.pending.delete(id);
    allowTool(c, requestId, allow);
    agentLive.update(c.chatId, { status: "working" });
    return true;
  }
  return false;
}

/** The chat's context use on its live CLI process. */
export function cliChatUsage(chatId: string): { inTokens: number; outTokens: number; cacheRead: number } | null {
  const c = live.get(chatId);
  return c ? { inTokens: c.usage.inTokens, outTokens: c.usage.outTokens, cacheRead: c.usage.cacheReadTokens } : null;
}

export function registerGlyphhCliBridge(): void {
  // Another panel adopting a chat's run: its frames go there from now on.
  registerRunRebinder((chatId, sender, opts) => {
    const c = live.get(chatId);
    if (!c || c.proc.exitCode !== null) return { rebound: false, previous: null };
    const previous = c.sender;
    if (opts.orphanOnly && previous !== sender && !previous.isDestroyed()) return { rebound: false, previous };
    c.sender = sender;
    return { rebound: true, previous };
  });
}

/** Everything down on quit — the CLI processes are the app's children. */
export function shutdownGlyphhCliBridge(): void {
  for (const c of live.values()) { c.stopping = true; try { c.proc.kill("SIGTERM"); } catch { /* already gone */ } }
  live.clear();
}
