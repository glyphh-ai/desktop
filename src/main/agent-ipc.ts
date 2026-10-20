/**
 * agent-ipc.ts — THE AGENT PANEL'S SEAM: the chat store on disk, and the
 * `glyphh-agent-*` channels the renderer speaks.
 *
 *   THE CHAT STORE — chats and their turns in the user's own folder, merged
 *                    by id so several panels (and the terminal) can write it,
 *                    watched so another writer repaints the rail.
 *   THE CHANNELS   — run / stop / permission / approvals / attachments /
 *                    context / compaction / load / save, and the CLI session
 *                    bindings (bind / session-of / transcript).
 *
 * A turn runs on the chat's LOOP: Glyphh's own (glyphh-loop.ts, the default)
 * or a vendor CLI (glyphh-cli-bridge.ts). A chat is a thread of ours either
 * way: on the Glyphh loop its id IS the session id (the >_ hop opens
 * `glyphh --resume <chatId>`); on a CLI it binds that CLI's own session.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import * as fsWatch from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ipcMain, webContents, type WebContents } from "electron";
import { pickAttachments, classifyPaths, saveClipboardImage, type AttachRef } from "./glyphh-agent-attachments";
import { startLocalMcpServer } from "./local-mcp-server.js";
import { GLYPHH_DIR, getActiveUserId, userScopedDir } from "./app-paths.js";
import { DEFAULT_LOOP, isCliId } from "./cli-ids.js";
import { agentRowFor } from "./cli-agents.js";
import type { RouteHints } from "./cli-route.js";
import { cliTranscript } from "./cli-sessions.js";
import { startCliSessionWatch } from "./cli-session-watch.js";
import {
  bindCliSession, cliChatKnown, cliChatUsage, cliSessionOf, isCliApproval, respondCliApproval, runCliTurn, setCliPermission, stopCliChat,
} from "./glyphh-cli-bridge.js";
import { repairChatStore, mergeChats, withoutRetiredThreads } from "./chat-store-repair.js";
import {
  compactGlyphhLoop, glyphhLoopHas, glyphhLoopUsage, isGlyphhApproval, respondGlyphhApproval,
  runGlyphhLoopTurn, setGlyphhLoopPermission, stopGlyphhLoop, type LoopPermission,
} from "./glyphh-loop.js";

// ── the chat store (~/.glyphh/users/<id> — the desktop's local law) ─────────

const STORE_DIR = (): string => userScopedDir();
// RESOLVED PER CALL, never at import (his report, 2026-09-21: the terminal's
// chats were in no rail). At import time no user is known yet, so a constant
// here pointed at ~/.glyphh/agent-sessions.json for the whole run while every
// other per-user path — and the terminal we launch — used users/<id>/.
const sessionsFile = (): string => path.join(STORE_DIR(), "agent-sessions.json");
const LEGACY_SESSIONS_FILE = path.join(GLYPHH_DIR, "agent-sessions.json");

interface StoredMessage { role?: string; text?: string; at?: number }
interface StoredChat { id?: string; updatedAt?: number; messages?: StoredMessage[] }
interface SessionsSnapshot { chats: unknown[]; currentId: string | null; /** Ids the saver deleted — dropped from the merge. */ deleted?: string[] }

/** A chat's folder as an absolute path: a display "~" that leaked into the
 *  store (2026-09-21) becomes the home folder, so nothing downstream resolves
 *  it against the app's own directory. */
function healFolder<T extends { workdir?: unknown; source?: unknown }>(c: T): T {
  const fix = (p: unknown): unknown => (p === "~" ? homedir() : typeof p === "string" && p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p);
  const src = c.source as { kind?: string; path?: unknown } | undefined;
  return {
    ...c,
    ...(c.workdir !== undefined ? { workdir: fix(c.workdir) } : {}),
    ...(src && src.kind === "local" && src.path !== undefined ? { source: { ...src, path: fix(src.path) } } : {}),
  };
}

function readSnapshot(file: string): SessionsSnapshot {
  try {
    const j = JSON.parse(readFileSync(file, "utf-8")) as SessionsSnapshot;
    return { chats: Array.isArray(j.chats) ? (j.chats as Array<{ workdir?: unknown; source?: unknown }>).map(healFolder) : [], currentId: typeof j.currentId === "string" ? j.currentId : null };
  } catch { return { chats: [], currentId: null }; }
}

/** ONE-TIME: the chats the import-time constant kept machine-global move under
 *  the signed-in user (merged by id, the newer updatedAt winning); the legacy
 *  file is renamed so this runs once. */
function adoptLegacySessions(): void {
  if (!getActiveUserId() || !existsSync(LEGACY_SESSIONS_FILE)) return;
  try {
    const legacy = readSnapshot(LEGACY_SESSIONS_FILE);
    const mine = readSnapshot(sessionsFile());
    const byId = new Map<string, StoredChat>();
    for (const c of legacy.chats as StoredChat[]) if (c && typeof c.id === "string") byId.set(c.id, c);
    for (const c of mine.chats as StoredChat[]) {
      if (!c || typeof c.id !== "string") continue;
      const cur = byId.get(c.id);
      if (!cur || (c.updatedAt ?? 0) >= (cur.updatedAt ?? 0)) byId.set(c.id, c);
    }
    mkdirSync(STORE_DIR(), { recursive: true });
    writeFileSync(sessionsFile(), JSON.stringify({ chats: [...byId.values()], currentId: mine.currentId ?? legacy.currentId }), "utf-8");
    renameSync(LEGACY_SESSIONS_FILE, `${LEGACY_SESSIONS_FILE.slice(0, -5)}.legacy.json`);
  } catch { /* best-effort: the legacy chats simply stay where they were */ }
}

/** A store the sync loop bloated (2026-10-04) is repaired once on load, before
 *  any of it crosses IPC. */
let repairedFile = "";
function loadSessionsFile(): SessionsSnapshot {
  adoptLegacySessions();
  const snap = readSnapshot(sessionsFile());
  const live = (chats: StoredChat[]): SessionsSnapshot => ({ ...snap, chats: withoutRetiredThreads(chats) });
  if (repairedFile === sessionsFile()) return live(snap.chats as StoredChat[]);
  repairedFile = sessionsFile();
  const r = repairChatStore(snap.chats as StoredChat[]);
  if (!Object.keys(r.repaired).length) return live(snap.chats as StoredChat[]);
  try {
    writeFileSync(sessionsFile(), JSON.stringify({ chats: r.chats, currentId: snap.currentId }), "utf-8");
    try { ourWriteAt = statSync(sessionsFile()).mtimeMs; } catch { /* announced by the watcher then */ }
  } catch { /* the in-memory copy is repaired either way */ }
  return live(r.chats);
}

/** ANOTHER WRITER (the glyphh terminal, 2026-09-21): watch the store and tell
 *  every renderer when a write that was not ours lands, so the rail and the
 *  panel show a terminal's turns without a restart. Never a persistent
 *  handle (it would keep main alive after the last window closed). */
let watchedFile = "";
let ourWriteAt = 0;
function watchSessionsFile(): void {
  const file = sessionsFile();
  if (watchedFile === file) return;
  if (watchedFile) fsWatch.unwatchFile(watchedFile);
  watchedFile = file;
  fsWatch.watchFile(file, { interval: 1500, persistent: false }, (cur) => {
    if (Math.abs(cur.mtimeMs - ourWriteAt) < 50) return; // our own save
    for (const wc of webContents.getAllWebContents()) { if (!wc.isDestroyed()) wc.send("glyphh-sessions-updated"); }
  });
}

function saveSessionsFile(snap: SessionsSnapshot, from?: WebContents): void {
  try {
    mkdirSync(STORE_DIR(), { recursive: true });
    // Several agent panels write this file (2026-09-16): merge by chat id, the
    // newer updatedAt wins, and a chat only one panel knows about survives.
    const have = readSnapshot(sessionsFile()).chats as StoredChat[];
    const incoming = snap.chats as StoredChat[];
    const gone = new Set(snap.deleted ?? []);
    const chats = mergeChats(have, incoming, gone);
    writeFileSync(sessionsFile(), JSON.stringify({ chats, currentId: snap.currentId }), "utf-8");
    try { ourWriteAt = statSync(sessionsFile()).mtimeMs; } catch { /* the watcher will just announce it */ }
    watchSessionsFile();
    // OUR OWN WRITES MUST BE ANNOUNCED TOO (his report, 2026-09-29: the left
    // rail read "No recent sessions yet" beside a panel listing eight). The
    // watcher above deliberately ignores this write — it is ours — so without
    // this the OTHER documents (the shell that hosts the rail, a second panel)
    // never learned the store had moved. The writer itself already repainted.
    // The deleted ids ride along: the file alone cannot tell a panel "the
    // session you are showing is gone" (his report, 2026-09-29).
    const deleted = [...gone];
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed() || (from && wc.id === from.id)) continue;
      wc.send("glyphh-sessions-updated", { deleted });
    }
  } catch { /* a failed save loses nothing but the recents ordering */ }
}

/** A stored chat by id, for the turn text and the loop's seed history. */
function storedChat(chatId: string): StoredChat | undefined {
  return (loadSessionsFile().chats as StoredChat[]).find((x) => x?.id === chatId);
}

// ── the store as the PHONE sees it (attach-handlers.ts sessions.*) ───────────
// The chats live on this machine only; mobile.glyphh.ai reads and writes them
// over the attach socket. Rich desktop fields (steps, parts, pins) are never
// replaced by the phone's plain {role, text} copies: the phone writes metadata,
// and a relayed turn's two messages are appended here (attach-run.ts).

export interface RelayChat extends StoredChat { title?: string; createdAt?: number; mode?: string; workdir?: string; source?: unknown; pinned?: boolean }

export function listStoredChats(): RelayChat[] {
  return (loadSessionsFile().chats as RelayChat[]).filter((c) => c && typeof c.id === "string");
}

export function getStoredChat(chatId: string): RelayChat | undefined {
  return storedChat(chatId) as RelayChat | undefined;
}

/** Create the chat if it is new, else patch its metadata. Messages are only
 *  ever seeded on creation. */
export function upsertStoredChat(chatId: string, patch: { title?: string; mode?: string; workdir?: string; messages?: StoredMessage[] }): RelayChat {
  const snap = loadSessionsFile();
  const chats = snap.chats as RelayChat[];
  const now = Date.now();
  let chat = chats.find((c) => c?.id === chatId);
  if (!chat) {
    chat = {
      id: chatId, title: patch.title?.trim() || "New session", createdAt: now, updatedAt: now,
      mode: "code", messages: patch.messages ?? [],
      ...(patch.workdir ? { workdir: patch.workdir, source: { kind: "local", path: patch.workdir } } : {}),
    };
    chats.unshift(chat);
  } else {
    if (patch.title?.trim()) chat.title = patch.title.trim();
    if (patch.workdir && !chat.workdir) { chat.workdir = patch.workdir; chat.source = { kind: "local", path: patch.workdir }; }
    chat.updatedAt = now;
  }
  saveSessionsFile({ chats, currentId: snap.currentId });
  return chat;
}

/** Append one message to a chat (creating it when a relayed turn is its first).
 *  A repeat of the last message is not written twice. */
export function appendStoredMessage(chatId: string, msg: { role: "user" | "assistant"; text: string }, seed?: { title?: string; mode?: string; workdir?: string }): void {
  const text = msg.text.trim();
  if (!chatId || !text) return;
  const snap = loadSessionsFile();
  const chats = snap.chats as RelayChat[];
  if (!chats.some((c) => c?.id === chatId)) { upsertStoredChat(chatId, { ...seed, title: seed?.title || text.slice(0, 60) }); return appendStoredMessage(chatId, msg); }
  const chat = chats.find((c) => c?.id === chatId)!;
  // A chat the phone named before its first turn has no folder yet: the turn's is its folder.
  if (seed?.workdir && !chat.workdir) { chat.workdir = seed.workdir; chat.source = { kind: "local", path: seed.workdir }; }
  const msgs = Array.isArray(chat.messages) ? chat.messages : (chat.messages = []);
  const last = msgs[msgs.length - 1];
  if (last && last.role === msg.role && String(last.text ?? "").trim() === text) return;
  msgs.push({ role: msg.role, text, at: Date.now() });
  chat.updatedAt = Date.now();
  saveSessionsFile({ chats, currentId: snap.currentId });
}

export function deleteStoredChat(chatId: string): boolean {
  const snap = loadSessionsFile();
  if (!(snap.chats as StoredChat[]).some((c) => c?.id === chatId)) return false;
  saveSessionsFile({ chats: (snap.chats as StoredChat[]).filter((c) => c?.id !== chatId), currentId: snap.currentId === chatId ? null : snap.currentId, deleted: [chatId] });
  return true;
}

// ── one turn ─────────────────────────────────────────────────────────────────

export interface RunPayload {
  chatId: string;
  attachments?: AttachRef[];
  workdir?: string;
  permission?: LoopPermission;
  /** A hidden prefix (the voice brief), never the message itself. */
  steer?: string;
  model?: string;
  prompt?: string;
  /** The workspace the chat runs under, for project memory. */
  workspace?: string;
  /** The thread's TYPE, as the composer knows it: chat or code. */
  mode?: string;
  /** The composer's effort dial; glyphh-loop.ts checks it against the SDK's names. */
  effort?: string;
  /** The chat's LOOP: "glyphh" (the default when absent) or a vendor CLI's id.
   *  A loop that is unknown or turned off is refused, never rerouted. */
  loop?: string;
  /** The chat's persisted session on that CLI (`cliSessionIds[loop]`), so the
   *  first turn after a restart resumes instead of starting fresh. */
  cliSessionId?: string;
  /** Where the CLI's route was chosen (session → workspace cell → workspace). */
  route?: RouteHints;
}

/** Tell the sender a turn was refused before it started: an error, then done. */
function refuse(sender: WebContents, chatId: string, error: string): { runId: string } {
  const runId = `${chatId}:${Date.now()}`;
  try {
    if (!sender.isDestroyed()) { sender.send("glyphh-agent:error", { runId, error }); sender.send("glyphh-agent:done", { runId, stopped: true }); }
  } catch { /* window gone */ }
  return { runId };
}

/** One user turn on a chat, from ANY sender: the renderer's IPC, or the attach
 *  executor's fake WebContents that forwards frames up the socket (attach-run.ts). */
export async function runAgentTurn(sender: WebContents, p: RunPayload): Promise<{ runId: string }> {
  // A TURN RUNS IN ITS THREAD'S FOLDER OR NOT AT ALL (his rule, 2026-09-29:
  // "The agent should work from the selected folder period!!! that is a hard
  // hard constraint, it is sandboxed to that folder"). There is no fallback:
  // NO_WORKDIR is the composer's cue to ask. One type since 2026-10-08: every
  // turn is this kind of turn.
  const folder = String(p.workdir ?? "").trim();
  if (!folder) throw new Error("NO_WORKDIR: this session has no folder yet");
  if (folder) {
    let ok = false;
    try { ok = statSync(folder).isDirectory(); } catch { ok = false; }
    if (!ok) throw new Error(`NO_WORKDIR: this session's folder no longer exists (${folder})`);
  }
  await startLocalMcpServer().catch(() => { /* the turn still runs, with fewer tools and honestly so */ });
  // The composer's contract (unchanged since the bridge): the user turn is
  // already IN the chat store when run arrives — same-renderer IPC ordering
  // guarantees the save landed first.
  const chat = storedChat(p.chatId);
  const lastUser = [...(chat?.messages ?? [])].reverse().find((m) => m?.role === "user");
  const steer = String(p.steer ?? "").trim();
  const text = [steer, String(p.prompt ?? lastUser?.text ?? "").trim()].filter(Boolean).join("\n\n");
  const loop = String(p.loop ?? "").trim() || DEFAULT_LOOP;
  const row = isCliId(loop) ? agentRowFor(loop) : null;
  // NEVER A SILENT REROUTE: a turn on a loop that does not exist, or that the
  // member turned off, is refused in words — never run on some other loop.
  if (!row) {
    console.warn("[agent] unknown loop refused", JSON.stringify({ chatId: p.chatId, loop }));
    return refuse(sender, p.chatId, `There is no "${loop}" loop. Pick another loop for this session.`);
  }
  if (!row.enabled) return refuse(sender, p.chatId, `The ${row.name} loop is turned off in Settings. Turn it on there, or pick another loop for this session.`);
  if (row.cli !== "glyphh") {
    // A launch that cannot come up (the router's listener, a spawn) is said in
    // the panel like any other failed turn.
    return runCliTurn(sender, {
      chatId: p.chatId, row, text, history: chat?.messages ?? [], workdir: folder,
      permission: p.permission ?? "ask",
      ...(p.model ? { model: p.model } : {}),
      ...(p.effort ? { effort: p.effort } : {}),
      ...(p.attachments?.length ? { attachments: p.attachments } : {}),
      ...(p.route ? { route: p.route } : {}),
      ...(p.cliSessionId ? { cliSessionId: p.cliSessionId } : {}),
    }).catch((err: unknown) => refuse(sender, p.chatId, `${row.name} could not start: ${err instanceof Error ? err.message : String(err)}`));
  }
  return runGlyphhLoopTurn(sender, {
    chatId: p.chatId,
    ...(p.permission ? { permission: p.permission } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(p.effort ? { effort: p.effort } : {}),
    ...(p.workdir ? { workdir: p.workdir } : {}),
    ...(p.workspace ? { workspace: p.workspace } : {}),
    ...(p.attachments?.length ? { attachments: p.attachments } : {}),
    history: chat?.messages ?? [],
  }, text);
}

/**
 * A TURN THAT OUTLIVED ITS PANEL (his order, 2026-09-29: "the agents do not
 * continue to run in the background. Each agent should be its own thread that
 * continues working even if the work panel app is closed").
 *
 * The loop itself always kept running — it lives in this process, not in the
 * panel — but the ANSWER was lost: a renderer commits the assistant turn when
 * it hears `done`, and with its webContents gone nobody heard it. So the
 * thread looked like it had been abandoned mid-sentence. When the owning panel
 * is gone, main writes the turn into the shared store itself and announces it;
 * the next surface to open that thread reads a finished conversation.
 */
export function commitBackgroundTurn(chatId: string, text: string): void {
  const answer = text.trim();
  if (!chatId || !answer) return;
  try {
    const snap = loadSessionsFile();
    const chats = snap.chats as Array<StoredChat & { updatedAt?: number }>;
    const chat = chats.find((c) => c?.id === chatId);
    if (!chat) return;
    const msgs = Array.isArray(chat.messages) ? chat.messages : (chat.messages = []);
    // Never twice: a panel that DID hear the done already wrote it.
    const last = msgs[msgs.length - 1];
    if (last && last.role === "assistant" && String(last.text ?? "").trim() === answer) return;
    msgs.push({ role: "assistant", text: answer } as StoredMessage);
    chat.updatedAt = Date.now();
    saveSessionsFile({ chats, currentId: snap.currentId });
    console.warn("[agent] background turn committed", JSON.stringify({ chatId, chars: answer.length }));
  } catch (err) {
    console.warn("[agent] background turn not committed:", err instanceof Error ? err.message : err);
  }
}

// The panel's controls go to whichever engine holds the chat: our own loop
// when it knows the chat, else the CLI bridge.

export function stopAgentChat(chatId: string): boolean {
  if (!chatId) return false;
  if (glyphhLoopHas(chatId) && stopGlyphhLoop(chatId)) return true;
  return stopCliChat(chatId);
}

export function setAgentPermission(chatId: string, permission: LoopPermission): boolean {
  if (setCliPermission(chatId, permission)) return true;
  return glyphhLoopHas(chatId) && setGlyphhLoopPermission(chatId, permission);
}

export function respondAgentApproval(id: string, allow: boolean): boolean {
  if (isCliApproval(id)) return respondCliApproval(id, allow);
  if (!isGlyphhApproval(id)) return false;
  return respondGlyphhApproval(id, allow);
}

// ── IPC surface — the exact channels the renderer calls ──────────────────────

export function registerAgentIpc(): void {
  ipcMain.handle("glyphh-agent-run", (e, p: RunPayload) => runAgentTurn(e.sender, p));
  ipcMain.handle("glyphh-agent-stop", (_e, p: { chatId?: string }) => stopAgentChat(p?.chatId ?? ""));

  // (A message typed mid-run needs no channel of its own: the composer queues
  //  it as a visible note and sends it through the normal path when the turn
  //  ends, and the engine queues a programmatic one the same way.)

  ipcMain.handle("glyphh-agent-set-permission", (_e, p: { chatId: string; permission: LoopPermission }) => ({ updated: setAgentPermission(p.chatId, p.permission) }));
  ipcMain.handle("glyphh-agent-approval-respond", (_e, p: { id: string; allow: boolean }) => respondAgentApproval(p.id, p.allow));

  // Questions arrive as tool permission asks and are answered there; these stay
  // callable so no renderer path throws.
  ipcMain.handle("glyphh-agent-ask-respond", () => false);
  ipcMain.handle("glyphh-agent-connect-respond", () => false);

  ipcMain.handle("glyphh-agent-context-usage", (_e, p: { chatId: string }) => {
    const chatId = p?.chatId ?? "";
    const u = cliChatUsage(chatId) ?? glyphhLoopUsage(chatId);
    // Cached prompt tokens are billed too, at cache rates, and they sit in the
    // window like any other (his question, 2026-09-19).
    const tokens = u.inTokens + u.outTokens + u.cacheRead;
    const budget = 200_000;
    return { tokens, budget, ratio: Math.min(1, tokens / budget), foldAt: 0.8, lanes: [] };
  });

  // COMPACTION: our loop summarizes its own conversation; a CLI owns its
  // session, so it compacts there, with its own /compact.
  ipcMain.handle("glyphh-agent-compact", async (_e, p: { chatId?: string; loop?: string }) => {
    const chatId = String(p?.chatId ?? "");
    const onCli = (p?.loop && p.loop !== DEFAULT_LOOP) || (!glyphhLoopHas(chatId) && cliChatKnown(chatId));
    if (onCli) return { ok: false, reason: "This session runs on its CLI, which compacts its own conversation: open the terminal (>_) and type /compact." };
    const r = await compactGlyphhLoop(chatId);
    return r.ok ? { ok: true } : { ok: false, reason: r.error };
  });
  ipcMain.handle("glyphh-agent-remember", () => false);

  ipcMain.handle("glyphh-agent-pick-attachments", async (_e, p: { mode?: "files" | "folder" }) => pickAttachments(p?.mode));
  ipcMain.handle("glyphh-agent-classify-paths", (_e, p: { paths: string[] }) => classifyPaths(p?.paths ?? []));
  ipcMain.handle("glyphh-agent-save-clipboard-image", (_e, p: { bytes: ArrayBuffer }) => saveClipboardImage(p.bytes));

  // THE CHAT ⇄ TERMINAL HOP. The chat adopts a CLI session id so its next
  // turn resumes the SAME conversation the terminal had; the terminal asks
  // which session the chat is on. On the Glyphh loop the chat IS the session.
  ipcMain.handle("glyphh-agent-bind-session", (_e, p: { chatId?: string; cliSessionId?: string; cli?: string }) => {
    const cli = String(p?.cli ?? "claude");
    if (!isCliId(cli) || cli === "glyphh") return false;
    return bindCliSession(String(p?.chatId ?? ""), cli, String(p?.cliSessionId ?? ""));
  });
  ipcMain.handle("glyphh-agent-session-of", (_e, p: { chatId?: string; cli?: string }) => {
    const chatId = String(p?.chatId ?? "");
    const cli = String(p?.cli ?? "claude");
    if (!chatId) return null;
    return cli === "glyphh" ? chatId : cliSessionOf(chatId, cli);
  });
  // A CLI session as chat turns: the CLI's transcript IS the history, so
  // switching views carries the conversation.
  ipcMain.handle("glyphh-agent-transcript", (_e, p: { sessionId?: string }) => cliTranscript(String(p?.sessionId ?? "")));

  ipcMain.handle("glyphh-agent-sessions-load", () => {
    watchSessionsFile();
    // Our store is half the truth; the CLIs' own stores are the other half.
    startCliSessionWatch();
    return loadSessionsFile();
  });
  ipcMain.handle("glyphh-agent-sessions-save", (e, p: { chats: unknown[]; currentId: string | null; deleted?: string[] }) => {
    saveSessionsFile({ chats: p?.chats ?? [], currentId: p?.currentId ?? null, ...(Array.isArray(p?.deleted) ? { deleted: p.deleted.map(String) } : {}) }, e.sender);
    return true;
  });
}
