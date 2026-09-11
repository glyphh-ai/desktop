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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ipcMain, type WebContents } from "electron";
import { pickAttachments, classifyPaths, saveClipboardImage, validAttachments, type AttachRef } from "./glyphh-agent-attachments";

// ── chat ↔ CLI session store (~/.glyphh — the desktop's local law) ──────────

const STORE_DIR = path.join(homedir(), ".glyphh");
const SESSIONS_FILE = path.join(STORE_DIR, "agent-sessions.json");

interface SessionsSnapshot { chats: unknown[]; currentId: string | null }

function loadSessionsFile(): SessionsSnapshot {
  try {
    const j = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8")) as SessionsSnapshot;
    return { chats: Array.isArray(j.chats) ? j.chats : [], currentId: typeof j.currentId === "string" ? j.currentId : null };
  } catch { return { chats: [], currentId: null }; }
}

function saveSessionsFile(snap: SessionsSnapshot): void {
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify(snap), "utf-8");
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
  buf: string;
  usage: { inTokens: number; outTokens: number };
  nextControl: number;
  /** control_request ids we asked the renderer about, by approval id. */
  pending: Map<string, string>;
}

const live = new Map<string, LiveChat>();
/** chatId → the CLI session to resume when the chat's process is cold. */
const resumeIds = new Map<string, string>();

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
    if (sid) { c.cliSessionId = sid; resumeIds.set(chatId, sid); }
    emit(c, "glyphh-agent:setup", { phase: "ready", model: typeof ev.model === "string" ? ev.model : undefined });
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
    const u = (ev.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    if (typeof u.input_tokens === "number") c.usage.inTokens = u.input_tokens;
    if (typeof u.output_tokens === "number") c.usage.outTokens = u.output_tokens;
    emit(c, "glyphh-agent:progress", { runId: c.runId, inTokens: c.usage.inTokens, outTokens: c.usage.outTokens });
    if (ev.is_error) emit(c, "glyphh-agent:error", { runId: c.runId, error: String(ev.result ?? "the run failed") });
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
}

function spawnChat(p: RunPayload, sender: WebContents): LiveChat {
  const permission = p.permission ?? "ask";
  const resume = resumeIds.get(p.chatId);
  const parts = [
    "claude", "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode", PERM_FLAG[permission],
  ];
  if (p.model?.trim()) parts.push("--model", p.model.trim());
  if (resume) parts.push("--resume", resume);
  // The login shell resolves the user's real PATH — Electron's GUI env
  // doesn't carry it, and `claude` lives wherever the user installed it.
  const line = parts.map((a) => (/^[\w./=-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
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
    buf: "",
    usage: { inTokens: 0, outTokens: 0 },
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
      emit(chat, "glyphh-agent:error", { runId: chat.runId, error: errTail.trim() || `claude exited ${code}` });
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
  ipcMain.handle("glyphh-agent-run", (e, p: RunPayload & { steer?: string; prompt?: string }) => {
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
      response: { subtype: "success", request_id: requestId, response: p.allow ? { behavior: "allow", updatedInput: null } : { behavior: "deny", message: "The user declined." } },
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

  ipcMain.handle("glyphh-agent-sessions-load", () => loadSessionsFile());
  ipcMain.handle("glyphh-agent-sessions-save", (_e, p: { chats: unknown[]; currentId: string | null }) => {
    saveSessionsFile({ chats: p?.chats ?? [], currentId: p?.currentId ?? null });
    return true;
  });
}

/** Everything down on quit — the CLI processes are the app's children. */
export function shutdownGlyphhCliBridge(): void {
  for (const [, c] of live) { try { c.proc.kill("SIGTERM"); } catch { /* already gone */ } }
  live.clear();
}
