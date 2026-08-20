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
import { noteSessionsSnapshot } from "./cloud-fs-router";

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
  /** Per-chat LWW stamp — RENDERER-owned (thread-store.ts stamps it on every
   *  content change); rides the cache verbatim so the server push can't be
   *  clobbered by an old machine. */
  updatedAt?: number;
  /** Where the session RUNS — the renderer's workspace Source, verbatim. An
   *  absent or `local` source runs on this machine's pod; a cloud one runs on
   *  a provisioned remote pod. */
  source?: { kind: string; path?: string; machineId?: string; repo?: string; space?: string };
  /** A cloud session's provisioned pod: bound on its first turn and reused by
   *  every later one, since re-provisioning would abandon its workspace. */
  runtime?: { sessionId: string; url: string; token: string };
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
//
// sessions.json is the desktop's OFFLINE CACHE of the server threads surface
// (renderer help/thread-store.ts owns the sync: LWW stamps, push queue, and
// tombstones live there; the transport is threads-ipc.ts → the main SDK
// client). The old main-process `messageSessions` library sync is gone with
// the cutover — this file just reads/writes the renderer's contract verbatim
// (chats carry the renderer-stamped `updatedAt` LWW clocks).

interface SessionsFile {
  chats: StoredChat[];
  currentId: string;
}

function readSessionsFile(): SessionsFile {
  try {
    const raw = JSON.parse(readFileSync(sessionsPath(), "utf8")) as SessionsFile;
    return {
      chats: Array.isArray(raw.chats) ? raw.chats : [],
      currentId: String(raw.currentId || ""),
    };
  } catch {
    return { chats: [], currentId: "" };
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
  writeSessionsFile({ chats, currentId });
  // Summaries of deleted chats go with them.
  const ids = new Set(chats.map((c) => c.id));
  const summaries = loadSummaries();
  let dirty = false;
  for (const id of Object.keys(summaries)) {
    if (!ids.has(id)) { delete summaries[id]; dirty = true; }
  }
  if (dirty) saveSummaries(summaries);
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
export async function assemblePrompt(chatId: string, replyBudget: number, steer?: string): Promise<ChatMessage[]> {
  const { chats } = loadSessions();
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) throw new Error(`unknown chat: ${chatId}`);
  const entry = loadSummaries()[chatId];

  const prefix: ChatMessage[] = [];
  const mode = chat.mode ?? (chat.chat ? "chat" : "code");
  let system = MODE_SYSTEM[mode] ?? GLYPHH_SYSTEM;
  if (glyphhMode() === "plan") system += PLAN_ADDENDUM;
  prefix.push({ role: "system", content: system });
  // Per-turn steer (e.g. Voice speech mode → keep replies short). A system line,
  // so it shapes the whole turn — spoken and rendered — without touching history.
  if (steer && steer.trim()) prefix.push({ role: "system", content: steer.trim() });
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
  // Seed the cloud-fs locus from the persisted store — a boot that restores
  // a cloud session must route panels to the pod before any save happens.
  setTimeout(() => {
    try { const f = loadSessions(); noteSessionsSnapshot(f.chats, f.currentId); } catch { /* fresh install */ }
  }, 0);
  ipcMain.handle("glyphh-agent-sessions-load", () => loadSessions());
  ipcMain.handle("glyphh-agent-sessions-save", (e, p: { chats: StoredChat[]; currentId: string }) => {
    saveSessions(Array.isArray(p?.chats) ? p.chats : [], String(p?.currentId || ""));
    // Cloud-fs locus: every session switch / birth / source bind flows
    // through this save — the same seam the web's wb-pod selector hooks.
    noteSessionsSnapshot(Array.isArray(p?.chats) ? p.chats : [], String(p?.currentId || ""));
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
