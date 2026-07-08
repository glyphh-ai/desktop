/**
 * William context — sessions, memory, and compaction.
 *
 * Owns everything that becomes the prompt:
 *   - the session store (userData/william/sessions.json — moved off
 *     localStorage so real coding sessions don't hit its 5MB cap);
 *   - rolling summaries (summaries.json, keyed by chat id — never touched
 *     by the renderer, so a stale renderer save can't clobber them);
 *   - user memory (memory.md, fed by `.remember`) and per-project memory
 *     (WILLIAM.md in the working folder).
 *
 * assemblePrompt() builds token-true prompts ordered for llama.cpp's
 * prefix cache: system + memory + summary stay byte-stable between turns,
 * the recent tail appends — so each send only prefills the delta.
 * compactIfNeeded() runs AFTER a reply lands (never in front of a send):
 * when the tail nears its budget, the older half folds into the rolling
 * summary via one William call. The full transcript always stays in the
 * store/UI — summaries only shape the prompt.
 */

import { ipcMain, app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getPreference } from "./stores/preferences-db";
import { williamMode } from "./william-permissions";
import { getWorkingDirectory } from "./working-directory";

export interface StoredMsg { role: "user" | "assistant"; text: string; at: number }
export interface StoredChat { id: string; title: string; createdAt: number; messages: StoredMsg[] }
interface SummaryEntry { summary: string; upTo: number }
interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

const CTX_TOKENS = 16384;
const ASSEMBLE_MARGIN = 256;
/** Compact when the tail crosses this share of its budget. */
const COMPACT_AT = 0.6;
/** Turns that never get summarized away (recency floor). */
const TAIL_KEEP = 6;

const WILLIAM_SYSTEM =
  "You are William, Glyphh's local coding agent — warm, precise, and direct. " +
  "Answer concretely; when writing code, write complete runnable code.";
const PLAN_ADDENDUM =
  " PLAN MODE: reply with a concise numbered plan of what you would build or change — " +
  "no full implementations. End with open questions if anything is unclear.";

function dir(): string {
  const d = join(app.getPath("userData"), "william");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
const sessionsPath = () => join(dir(), "sessions.json");
const summariesPath = () => join(dir(), "summaries.json");
const memoryPath = () => join(dir(), "memory.md");

function baseUrl(): string {
  return String(getPreference("williamBaseUrl", "http://127.0.0.1:8089")).replace(/\/+$/, "");
}

// ── Session store ──────────────────────────────────────────────────────────

export function loadSessions(): { chats: StoredChat[]; currentId: string } {
  try {
    const raw = JSON.parse(readFileSync(sessionsPath(), "utf8")) as { chats?: StoredChat[]; currentId?: string };
    return { chats: Array.isArray(raw.chats) ? raw.chats : [], currentId: String(raw.currentId || "") };
  } catch {
    return { chats: [], currentId: "" };
  }
}

export function saveSessions(chats: StoredChat[], currentId: string): void {
  writeFileSync(sessionsPath(), JSON.stringify({ chats, currentId }));
  // Summaries of deleted chats go with them.
  const summaries = loadSummaries();
  const ids = new Set(chats.map((c) => c.id));
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

/** User facts (memory.md) + project WILLIAM.md, as one stable prefix block. */
function memoryBlock(): string {
  const parts: string[] = [];
  const user = readCapped(memoryPath(), 2000);
  if (user) parts.push(`Things the user asked you to remember:\n${user}`);
  try {
    const wd = getWorkingDirectory();
    if (wd) {
      const proj = readCapped(join(wd, "WILLIAM.md"), 4500);
      if (proj) parts.push(`Project notes (WILLIAM.md in the working folder):\n${proj}`);
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
  let system = WILLIAM_SYSTEM;
  if (williamMode() === "plan") system += PLAN_ADDENDUM;
  prefix.push({ role: "system", content: system });
  const mem = memoryBlock();
  if (mem) prefix.push({ role: "system", content: mem });
  if (entry?.summary) {
    prefix.push({ role: "system", content: `Conversation so far (compacted):\n${entry.summary}` });
  }

  const upTo = entry?.upTo ?? 0;
  let tail = chat.messages.slice(upTo).map((m) => ({ role: m.role, content: m.text } as ChatMessage));

  const budget = CTX_TOKENS - replyBudget - ASSEMBLE_MARGIN;
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
 * one-shot steer for this fold; the standing williamCompactionPrompt
 * preference (Settings → William) rides along on every fold.
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
    const standing = String(getPreference("williamCompactionPrompt", "")).trim();
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
 * is injected (william.ts) to avoid a module cycle.
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
    const budget = CTX_TOKENS - replyBudget - ASSEMBLE_MARGIN;
    const tailText = tail.map((m) => `${m.role}: ${m.text}`).join("\n");
    if ((await countTokens(tailText)) < budget * COMPACT_AT) return;
    await compactNow(chatId, replyBudget, complete);
  } catch { /* best-effort — next turn just carries more tail */ }
}

/**
 * How full the compaction window is — the SAME measure compactIfNeeded
 * triggers on (tail tokens vs the history budget), so the meter and the
 * fold behave identically. Estimate-only when the server is down (never
 * wakes the runtime just to paint a meter).
 */
export async function contextUsage(chatId: string, replyBudget: number): Promise<{ tokens: number; budget: number; ratio: number; foldAt: number }> {
  const budget = CTX_TOKENS - replyBudget - ASSEMBLE_MARGIN;
  const { chats } = loadSessions();
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) return { tokens: 0, budget, ratio: 0, foldAt: COMPACT_AT };
  const upTo = loadSummaries()[chatId]?.upTo ?? 0;
  const tailText = chat.messages.slice(upTo).map((m) => `${m.role}: ${m.text}`).join("\n");
  const tokens = tailText ? await countTokens(tailText) : 0;
  return { tokens, budget, ratio: Math.min(1, tokens / Math.max(1, budget)), foldAt: COMPACT_AT };
}

// ── IPC ────────────────────────────────────────────────────────────────────

export function registerWilliamContextIpc(): void {
  ipcMain.handle("william-sessions-load", () => loadSessions());
  ipcMain.handle("william-sessions-save", (_e, p: { chats: StoredChat[]; currentId: string }) => {
    saveSessions(Array.isArray(p?.chats) ? p.chats : [], String(p?.currentId || ""));
    return true;
  });
  ipcMain.handle("william-context-usage", async (_e, p: { chatId?: string; replyBudget?: number }) => {
    const { effortMaxTokens } = await import("./william-permissions");
    return contextUsage(String(p?.chatId || ""), Number(p?.replyBudget) || effortMaxTokens());
  });
  ipcMain.handle("william-remember", (_e, fact: string) => {
    const f = String(fact || "").trim();
    if (!f) throw new Error("nothing to remember");
    appendUserMemory(f);
    return true;
  });
}
