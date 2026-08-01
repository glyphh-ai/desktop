/**
 * Glyphh context — sessions, memory, and compaction.
 *
 * Owns everything that becomes the prompt:
 *   - the session store (userData/glyphh/sessions.json — moved off
 *     localStorage so real coding sessions don't hit its 5MB cap);
 *   - rolling summaries (summaries.json, keyed by chat id — never touched
 *     by the renderer, so a stale renderer save can't clobber them);
 *   - user memory (memory.md, fed by `.remember`) and per-project memory
 *     (GLYPHH.md in the working folder).
 *
 * assemblePrompt() builds token-true prompts ordered for llama.cpp's
 * prefix cache: system + memory + summary stay byte-stable between turns,
 * the recent tail appends — so each send only prefills the delta.
 * compactIfNeeded() runs AFTER a reply lands (never in front of a send):
 * when the tail nears its budget, the older half folds into the rolling
 * summary via one Glyphh call. The full transcript always stays in the
 * store/UI — summaries only shape the prompt.
 */

import { ipcMain, webContents } from "electron";
import { currentLoop, resolveRoles, runContextWindow } from "./loop-selections";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { userScopedPath } from "./app-paths";
import { getPreference } from "./stores/preferences-db";
import { glyphhMode } from "./glyphh-agent-permissions";
import { getExplicitWorkingDirectory } from "./working-directory";

export interface StoredMsg { role: "user" | "assistant"; text: string; at: number; kind?: "tool" }
export interface StoredChat {
  id: string;
  title: string;
  createdAt: number;
  /** The session's SPACE — stamped at birth by the renderer and treated as
   *  the SINGLE SOURCE OF TRUTH for which tool pack a run gets. */
  mode?: "chat" | "cowork" | "code";
  /** Legacy pre-mode flag (chat sessions only) — read, never written. */
  chat?: boolean;
  /** Per-chat LWW stamp, main-owned: set on every content change and used
   *  by the server upsert so an old machine can't clobber a newer one. */
  updatedAt?: number;
  messages: StoredMsg[];
}
interface SummaryEntry { summary: string; upTo: number }
interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/** Local runtime window — must match llama-server's `-c 32768` (glyphh.ts). */
/** Fallback window, used only when the catalog never recorded one for a model.
 *  Deliberately small: guessing high on an unknown model overruns it, and an
 *  over-eager fold merely costs a summary. */
const DEFAULT_CTX_TOKENS = 32768;
const ASSEMBLE_MARGIN = 256;
/** The context window of the model this turn will run on. */
async function activeWindow(): Promise<number> {
  return (await runContextWindow()) ?? DEFAULT_CTX_TOKENS;
}

/** Compact when the tail crosses this share of its budget. */
const COMPACT_AT = 0.6;
/** Turns that never get summarized away (recency floor). */
const TAIL_KEEP = 6;

const GLYPHH_SYSTEM =
  "You are Glyphh, a local coding agent — warm, precise, and direct. " +
  "Answer concretely; when writing code, write complete runnable code.";
// Each space runs a different tool pack (glyphh-agent-tools.ts); the agent
// must know its own envelope or it fakes work it cannot do (e.g. a Work agent
// "queueing" a build in a Terminal panel it cannot type into).
const MODE_SYSTEM: Record<"chat" | "cowork" | "code", string> = {
  chat:
    "You are Glyphh in Chat — a conversational assistant with web search but NO other tools: " +
    "no files, no shell, no connectors, no panels. Answer directly from knowledge and search. " +
    "If the user needs file, app, or code work done, tell them to open a Work or Code session.",
  cowork:
    "You are Glyphh in Work — warm, precise, and direct. You have connector tools (email, " +
    "calendars, SaaS apps), file read/write in the working folder, web browsing, and app/layout " +
    "panels. You DO NOT have a shell: you cannot run commands, install packages, build projects, " +
    "or use git — and opening a Terminal panel does not let you type into it, so never present " +
    "one as work in progress. When a task needs the dev toolchain (npm, builds, git, deploys), " +
    "say so plainly in your first reply and tell the user to open this folder in a Code session.",
  code:
    "You are Glyphh in Code, a local coding agent — warm, precise, and direct. You have the " +
    "full dev toolchain: shell, git, files, builds, deploys. Answer concretely; when writing " +
    "code, write complete runnable code.",
};
const PLAN_ADDENDUM =
  " PLAN MODE: reply with a concise numbered plan of what you would build or change — " +
  "no full implementations. End with open questions if anything is unclear.";

function dir(): string {
  // Per-user: chats/summaries/memory belong to the signed-in account. The
  // legacy userData/glyphh dir is adopted by the first login (user-scope.ts).
  const d = userScopedPath("glyphh");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
const sessionsPath = () => join(dir(), "sessions.json");
const summariesPath = () => join(dir(), "summaries.json");
const memoryPath = () => join(dir(), "memory.md");

function baseUrl(): string {
  return String(getPreference("glyphhBaseUrl", "http://127.0.0.1:8089")).replace(/\/+$/, "");
}

// ── Session store ──────────────────────────────────────────────────────────

// The on-disk shape: renderer contract (chats + currentId) plus sync
// bookkeeping the renderer never sees — tombstones for offline deletes and
// the queue of chats with unconfirmed local edits.
interface SessionsFile {
  chats: StoredChat[];
  currentId: string;
  deleted?: Record<string, number>;
  pendingPush?: string[];
}

function readSessionsFile(): SessionsFile {
  try {
    const raw = JSON.parse(readFileSync(sessionsPath(), "utf8")) as SessionsFile;
    return {
      chats: Array.isArray(raw.chats) ? raw.chats : [],
      currentId: String(raw.currentId || ""),
      deleted: raw.deleted && typeof raw.deleted === "object" ? raw.deleted : {},
      pendingPush: Array.isArray(raw.pendingPush) ? raw.pendingPush : [],
    };
  } catch {
    return { chats: [], currentId: "", deleted: {}, pendingPush: [] };
  }
}

function writeSessionsFile(f: SessionsFile): void {
  writeFileSync(sessionsPath(), JSON.stringify(f));
}

export function loadSessions(): { chats: StoredChat[]; currentId: string } {
  const f = readSessionsFile();
  return { chats: f.chats, currentId: f.currentId };
}

export function saveSessions(chats: StoredChat[], currentId: string): void {
  // Diff against the previous file: changed/new chats get a fresh LWW stamp
  // and queue for the server; vanished ids tombstone so a delete made
  // offline still lands. The renderer keeps its simple whole-array contract.
  const prev = readSessionsFile();
  const prevById = new Map(prev.chats.map((c) => [c.id, c]));
  const now = Date.now();
  const pending = new Set(prev.pendingPush);
  const deleted = { ...prev.deleted };
  for (const c of chats) {
    const old = prevById.get(c.id);
    const changed = !old
      || old.title !== c.title
      || old.messages.length !== c.messages.length
      || JSON.stringify(old.messages) !== JSON.stringify(c.messages);
    if (changed) { c.updatedAt = now; pending.add(c.id); }
    else if (!c.updatedAt && old?.updatedAt) c.updatedAt = old.updatedAt;
    delete deleted[c.id]; // a re-created id un-tombstones
  }
  const ids = new Set(chats.map((c) => c.id));
  for (const old of prev.chats) {
    if (!ids.has(old.id)) { deleted[old.id] = now; pending.delete(old.id); }
  }
  writeSessionsFile({ chats, currentId, deleted, pendingPush: [...pending] });
  scheduleChatFlush();
  // Summaries of deleted chats go with them.
  const summaries = loadSummaries();
  let dirty = false;
  for (const id of Object.keys(summaries)) {
    if (!ids.has(id)) { delete summaries[id]; dirty = true; }
  }
  if (dirty) saveSummaries(summaries);
}

// ── Session sync — local-first ↔ /api/me/chats ─────────────────────────────
//
// sessions.json stays the working copy. A debounced flush pushes queued
// chats (LWW upsert server-side) and tombstoned deletes; syncChatsWithServer
// (auth + user switch) pushes FIRST so offline edits beat stale server rows,
// then pulls whatever another machine wrote newer, then re-flushes anything
// the pull proved the server is missing. Offline, everything just stays
// queued in the file — nothing is ever lost locally.

const CHAT_FLUSH_DEBOUNCE_MS = 2000;
let chatFlushTimer: NodeJS.Timeout | null = null;

function scheduleChatFlush(): void {
  if (chatFlushTimer) clearTimeout(chatFlushTimer);
  chatFlushTimer = setTimeout(() => { chatFlushTimer = null; void flushChatSync(); }, CHAT_FLUSH_DEBOUNCE_MS);
}

// Chats live in the server library (kind `message_session`); library items
// carry SERVER ids, while chats keep their local ids inside `data.chatId` —
// this index maps one to the other so pushes update instead of duplicating.
const chatItemIds = new Map<string, string>();

interface ChatItemData {
  chatId: string;
  createdAtMs: number;
  updatedAtMs: number;
  messages: StoredMsg[];
}

async function refreshChatItemIndex(): Promise<Array<{ id: string; name: string; data: ChatItemData }>> {
  const { getClient } = await import("./glyphh-client");
  const items = await getClient().messageSessions.list();
  chatItemIds.clear();
  const chats: Array<{ id: string; name: string; data: ChatItemData }> = [];
  for (const item of items) {
    const data = item.data as Partial<ChatItemData> | null;
    if (!data || typeof data.chatId !== "string") continue;
    chatItemIds.set(data.chatId, item.id);
    chats.push({
      id: item.id,
      name: item.name,
      data: {
        chatId: data.chatId,
        createdAtMs: data.createdAtMs || 0,
        updatedAtMs: data.updatedAtMs || 0,
        messages: Array.isArray(data.messages) ? data.messages : [],
      },
    });
  }
  return chats;
}

async function flushChatSync(): Promise<void> {
  const f = readSessionsFile();
  const pendingIds = [...new Set(f.pendingPush)];
  const deletedIds = Object.keys(f.deleted ?? {});
  if (!pendingIds.length && !deletedIds.length) return;
  let client: import("@glyphh/client").Client;
  try { client = (await import("./glyphh-client")).getClient(); } catch { return; }
  // Refresh the id index when a queued chat isn't mapped yet — pushing an
  // unmapped chat without it would CREATE a duplicate library item.
  if ([...pendingIds, ...deletedIds].some((id) => !chatItemIds.has(id))) {
    try { await refreshChatItemIndex(); } catch { return; } // offline — retry next flush
  }
  const byId = new Map(f.chats.map((c) => [c.id, c]));
  const sentStamps = new Map<string, number>();
  for (const id of pendingIds) {
    const c = byId.get(id);
    if (!c) { sentStamps.set(id, Number.MAX_SAFE_INTEGER); continue; } // gone — nothing to push
    const stamp = c.updatedAt ?? c.createdAt;
    try {
      const itemId = chatItemIds.get(id);
      const saved = await client.messageSessions.save({
        name: c.title,
        data: { chatId: id, createdAtMs: c.createdAt, updatedAtMs: stamp, messages: c.messages } satisfies ChatItemData,
        ...(itemId ? { id: itemId } : {}),
      });
      chatItemIds.set(id, saved.id);
      sentStamps.set(id, stamp);
    } catch { /* offline / oversized — stays pending */ }
  }
  const deletedOk: string[] = [];
  for (const id of deletedIds) {
    try {
      const itemId = chatItemIds.get(id);
      if (itemId) await client.messageSessions.delete(itemId);
      chatItemIds.delete(id);
      deletedOk.push(id);
    } catch { /* offline — tombstone stays */ }
  }
  // Re-read before persisting queue state: the renderer may have saved new
  // edits mid-flight, and those must stay pending.
  const cur = readSessionsFile();
  const curById = new Map(cur.chats.map((c) => [c.id, c]));
  const nextPending = new Set(cur.pendingPush);
  for (const [id, stamp] of sentStamps) {
    const c = curById.get(id);
    if (!c || (c.updatedAt ?? c.createdAt) <= stamp) nextPending.delete(id);
  }
  const nextDeleted = { ...cur.deleted };
  for (const id of deletedOk) delete nextDeleted[id];
  writeSessionsFile({ ...cur, pendingPush: [...nextPending], deleted: nextDeleted });
}

/** Full reconcile — call after auth lands and on user switch (before the
 *  renderer reload re-reads the store, so merged chats just appear). */
export async function syncChatsWithServer(): Promise<void> {
  await flushChatSync();
  let items: Array<{ id: string; name: string; data: ChatItemData }>;
  try {
    items = await refreshChatItemIndex();
  } catch { return; } // offline / signed out — local store stands
  const f = readSessionsFile();
  const byId = new Map(f.chats.map((c) => [c.id, c]));
  const pending = new Set(f.pendingPush);
  let dirty = false;
  // Pull: server-newer chats replace local (LWW), unknown ones are adopted.
  // The library list carries full payloads — no per-chat follow-up fetch.
  for (const item of items) {
    const chatId = item.data.chatId;
    if (f.deleted?.[chatId] !== undefined) continue; // deleted here — flush retries the server delete
    const local = byId.get(chatId);
    const localStamp = local ? (local.updatedAt ?? local.createdAt) : 0;
    if (item.data.updatedAtMs <= localStamp) continue;
    const merged: StoredChat = {
      id: chatId,
      title: item.name,
      createdAt: item.data.createdAtMs || Date.now(),
      updatedAt: item.data.updatedAtMs,
      messages: item.data.messages,
    };
    if (local) f.chats[f.chats.indexOf(local)] = merged;
    else f.chats.push(merged);
    byId.set(chatId, merged);
    pending.delete(chatId); // server copy won — nothing local left to push
    dirty = true;
  }
  // Push: local chats the server lacks or has older.
  const serverStamp = new Map(items.map((item) => [item.data.chatId, item.data.updatedAtMs]));
  for (const c of f.chats) {
    if ((c.updatedAt ?? c.createdAt) > (serverStamp.get(c.id) ?? -1) && !pending.has(c.id)) {
      pending.add(c.id);
      dirty = true;
    }
  }
  if (dirty) {
    writeSessionsFile({ ...f, pendingPush: [...pending] });
    await flushChatSync();
  }
}

function loadSummaries(): Record<string, SummaryEntry> {
  try { return JSON.parse(readFileSync(summariesPath(), "utf8")) as Record<string, SummaryEntry>; } catch { return {}; }
}
function saveSummaries(s: Record<string, SummaryEntry>): void {
  writeFileSync(summariesPath(), JSON.stringify(s));
}

// ── Memory files ───────────────────────────────────────────────────────────

export function appendUserMemory(fact: string): void {
  const line = `- ${fact.trim().replace(/\s+/g, " ")}\n`;
  appendFileSync(memoryPath(), line);
}

function readCapped(path: string, capChars: number): string {
  try {
    const t = readFileSync(path, "utf8").trim();
    return t.length > capChars ? `${t.slice(t.length - capChars)}\n(…older lines trimmed)` : t;
  } catch {
    return "";
  }
}

/** User facts (memory.md) + project GLYPHH.md, as one stable prefix block. */
function memoryBlock(): string {
  const parts: string[] = [];
  const user = readCapped(memoryPath(), 2000);
  if (user) parts.push(`Things the user asked you to remember:\n${user}`);
  try {
    const wd = getExplicitWorkingDirectory();
    if (wd) {
      const proj = readCapped(join(wd, "GLYPHH.md"), 4500);
      if (proj) parts.push(`Project notes (GLYPHH.md in the working folder):\n${proj}`);
    }
  } catch { /* no workdir */ }
  return parts.join("\n\n");
}

// ── Token counting (llama-server /tokenize; estimate as fallback) ─────────

const estimate = (text: string) => Math.ceil(text.length / 3.2);

async function countTokens(text: string): Promise<number> {
  try {
    const r = await fetch(`${baseUrl()}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as { tokens?: unknown[] };
    if (Array.isArray(j.tokens)) return j.tokens.length;
    throw new Error("no tokens");
  } catch {
    return estimate(text);
  }
}

const flatten = (msgs: ChatMessage[]) => msgs.map((m) => `<${m.role}>\n${m.content}`).join("\n");

// ── Prompt assembly ────────────────────────────────────────────────────────

/**
 * Build the run's messages for a chat, fitting CTX minus the reply budget.
 * Prefix (system + memory + summary) stays byte-stable between turns; the
 * tail drops oldest-first when over budget (recency floor applies, smaller
 * when a superfly-sized reply squeezes the window).
 */
export async function assemblePrompt(chatId: string, replyBudget: number): Promise<ChatMessage[]> {
  const { chats } = loadSessions();
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) throw new Error(`unknown chat: ${chatId}`);
  const entry = loadSummaries()[chatId];

  const prefix: ChatMessage[] = [];
  const mode = chat.mode ?? (chat.chat ? "chat" : "code");
  let system = MODE_SYSTEM[mode] ?? GLYPHH_SYSTEM;
  if (glyphhMode() === "plan") system += PLAN_ADDENDUM;
  prefix.push({ role: "system", content: system });
  const mem = memoryBlock();
  if (mem) prefix.push({ role: "system", content: mem });
  if (entry?.summary) {
    prefix.push({ role: "system", content: `Conversation so far (compacted):\n${entry.summary}` });
  }

  const upTo = entry?.upTo ?? 0;
  let tail = chat.messages.slice(upTo).map((m) => ({ role: m.role, content: m.text } as ChatMessage));

  const budget = (await activeWindow()) - replyBudget - ASSEMBLE_MARGIN;
  const floor = replyBudget > 8192 ? 2 : 4;
  // Estimate-trim first, then verify against the real tokenizer.
  const fits = (msgs: ChatMessage[], count: (t: string) => number | Promise<number>) => count(flatten([...prefix, ...msgs]));
  while (tail.length > floor && estimate(flatten([...prefix, ...tail])) > budget) tail = tail.slice(1);
  for (let i = 0; i < 6 && tail.length > floor; i++) {
    if ((await fits(tail, countTokens)) <= budget) break;
    tail = tail.slice(1);
  }
  return [...prefix, ...tail];
}

// ── Compaction ─────────────────────────────────────────────────────────────

type CompleteFn = (messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number }) => Promise<string>;

let compacting = false;

/**
 * Fold the older tail into the rolling summary NOW — the manual path
 * (meter click / .compact) and the auto path both land here. `focus` is a
 * one-shot steer for this fold; the standing glyphhCompactionPrompt
 * preference (Settings → Glyphh) rides along on every fold.
 */
export async function compactNow(
  chatId: string,
  replyBudget: number,
  complete: CompleteFn,
  focus?: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (compacting) return { ok: false, reason: "a compaction is already running" };
  compacting = true;
  try {
    const { chats } = loadSessions();
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) return { ok: false, reason: "unknown session" };
    const summaries = loadSummaries();
    const entry = summaries[chatId];
    const upTo = entry?.upTo ?? 0;
    const tail = chat.messages.slice(upTo);
    if (tail.length <= TAIL_KEEP + 2) return { ok: false, reason: "nothing to fold yet — the recent turns already fit" };

    // Fold everything except the recency floor.
    const fold = tail.slice(0, -TAIL_KEEP);
    const foldText = fold.map((m) => `${m.role}: ${m.text}`).join("\n\n");
    const prior = entry?.summary ? `Existing summary of even earlier conversation:\n${entry.summary}\n\n` : "";
    const standing = String(getPreference("glyphhCompactionPrompt", "")).trim();
    const guidance = [standing, String(focus || "").trim()].filter(Boolean).join("\n");
    const summary = (await complete([
      {
        role: "system",
        content:
          "You compress coding conversations. Merge the existing summary (if any) with the new turns into ONE " +
          "digest under these exact headings: Goal, Decisions, Constraints, Files & artifacts, Open threads. " +
          "Be terse and concrete; keep names, paths, and numbers. No preamble.",
      },
      {
        role: "user",
        content: `${prior}New turns to fold in:\n${foldText}` +
          (guidance ? `\n\nUser guidance — emphasize and preserve:\n${guidance}` : ""),
      },
    ], { maxTokens: 700, temperature: 0.2 })).trim();
    if (!summary) return { ok: false, reason: "the summarizer returned nothing" };

    summaries[chatId] = { summary, upTo: upTo + fold.length };
    saveSummaries(summaries);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    compacting = false;
  }
}

/**
 * Auto path: fold only when the tail nears its budget. Runs in the
 * background after a reply lands — a send never waits on it. `complete`
 * is injected (glyphh.ts) to avoid a module cycle.
 */
export async function compactIfNeeded(chatId: string, replyBudget: number, complete: CompleteFn): Promise<void> {
  if (compacting) return;
  try {
    const { chats } = loadSessions();
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) return;
    const upTo = loadSummaries()[chatId]?.upTo ?? 0;
    const tail = chat.messages.slice(upTo);
    if (tail.length <= TAIL_KEEP + 2) return;
    const budget = (await activeWindow()) - replyBudget - ASSEMBLE_MARGIN;
    const tailText = tail.map((m) => `${m.role}: ${m.text}`).join("\n");
    if ((await countTokens(tailText)) < budget * COMPACT_AT) return;
    await compactNow(chatId, replyBudget, complete);
  } catch { /* best-effort — next turn just carries more tail */ }
}

/** One lane per model that might serve this session's history. */
export interface ContextLane {
  id: string;
  kind: "local" | "frontier";
  tokens: number;
  budget: number;
  ratio: number;
  /** Fold-trigger share for this lane — null when compaction never keys off it. */
  foldAt: number | null;
}

/**
 * How full the compaction window is — the SAME measure compactIfNeeded
 * triggers on (tail tokens vs the history budget), so the meter and the
 * fold behave identically. Estimate-only when the server is down (never
 * wakes the runtime just to paint a meter).
 *
 * One shared history, measured against every lane that might serve it. The
 * LOCAL lane is the binding constraint — gateway declines degrade to local,
 * so the history must always stay local-servable; compaction keys off it.
 * The frontier lane is informational (top-level fields mirror the local lane
 * for existing callers).
 */
export async function contextUsage(chatId: string, replyBudget: number): Promise<{
  tokens: number; budget: number; ratio: number; foldAt: number; lanes: ContextLane[];
}> {
  const { chats } = loadSessions();
  const chat = chats.find((c) => c.id === chatId);
  const upTo = chat ? (loadSummaries()[chatId]?.upTo ?? 0) : 0;
  const tailText = chat ? chat.messages.slice(upTo).map((m) => `${m.role}: ${m.text}`).join("\n") : "";
  const tokens = tailText ? await countTokens(tailText) : 0;

  // One lane per model SLOT the loop declares: the same history sits at a
  // different fraction of a 200k window than an 8k one, and a planner-and-coder
  // loop has two answers to show, not one.
  let lanes: ContextLane[] = [];
  try {
    const roles = await resolveRoles(currentLoop());
    lanes = roles.map((role) => {
      const window = role.choices.find((c) => c.id === role.modelId)?.contextWindow ?? DEFAULT_CTX_TOKENS;
      const budget = Math.max(1, window - replyBudget - ASSEMBLE_MARGIN);
      return {
        id: role.choices.find((c) => c.id === role.modelId)?.name ?? role.label,
        kind: "frontier" as const,
        tokens,
        budget,
        ratio: Math.min(1, tokens / budget),
        foldAt: COMPACT_AT,
      };
    });
  } catch { /* meter degrades to the default lane below */ }

  if (!lanes.length) {
    const budget = Math.max(1, DEFAULT_CTX_TOKENS - replyBudget - ASSEMBLE_MARGIN);
    lanes = [{ id: "model", kind: "frontier", tokens, budget, ratio: Math.min(1, tokens / budget), foldAt: COMPACT_AT }];
  }

  // Top-level fields mirror the FIRST lane — that is the slot a plain turn runs in.
  const lead = lanes[0]!;
  return { tokens, budget: lead.budget, ratio: lead.ratio, foldAt: COMPACT_AT, lanes };
}

// ── IPC ────────────────────────────────────────────────────────────────────

export function registerGlyphhContextIpc(): void {
  ipcMain.handle("glyphh-agent-sessions-load", () => loadSessions());
  ipcMain.handle("glyphh-agent-sessions-save", (e, p: { chats: StoredChat[]; currentId: string }) => {
    saveSessions(Array.isArray(p?.chats) ? p.chats : [], String(p?.currentId || ""));
    // Other windows (main app vs ghost overlay) hold their own in-memory copy
    // of this store — tell them it moved so a ghost-created session shows up
    // in the main rail immediately, not on next launch.
    for (const wc of webContents.getAllWebContents()) {
      if (wc.id !== e.sender.id && !wc.isDestroyed()) wc.send("glyphh-sessions-updated");
    }
    return true;
  });
  ipcMain.handle("glyphh-agent-context-usage", async (_e, p: { chatId?: string; replyBudget?: number }) => {
    const { runMaxOutputTokens } = await import("./loop-selections");
    return contextUsage(String(p?.chatId || ""), Number(p?.replyBudget) || (await runMaxOutputTokens()));
  });
  ipcMain.handle("glyphh-agent-remember", (_e, fact: string) => {
    const f = String(fact || "").trim();
    if (!f) throw new Error("nothing to remember");
    appendUserMemory(f);
    return true;
  });
}
