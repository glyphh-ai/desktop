/**
 * session-title.ts — ONE TITLE GRAMMAR for a session row.
 *
 * His report, 2026-09-25: "the left rail session names are way too long and
 * they don't match what claude or codex show." The native CLI readers cut at
 * 80, our own sessions at 42 — in one merged list that read as two different
 * products.
 *
 * This file also held the chat ⇄ CLI-session binding (a session id per vendor
 * CLI, and the rules for reading it). That went with the bridge, 2026-09-28:
 * the chat IS the session now, so there is nothing to bind.
 *
 * Kept inside src/renderer (not src/shared): the renderer build pins tsc's
 * rootDir to this directory, and an import that escapes it silently moves the
 * whole emit to dist/renderer/renderer — which nothing loads. See
 * scripts/check-renderer-emit.mjs.
 */

export const SESS_TITLE_MAX = 42;

/** A row's visible name: one line, collapsed whitespace, elided past the cap.
 *  Callers keep the full text on the row's tooltip. */
export function sessionDisplayTitle(t: string | undefined): string {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "Session";
  return s.length > SESS_TITLE_MAX ? `${s.slice(0, SESS_TITLE_MAX - 1).trimEnd()}…` : s;
}

// ── THE GENERATED TITLE (his order, 2026-10-05: do the same as Claude's titles) ──
//
// Our rows read as the first 42 characters of the first prompt plus an
// ellipsis; Claude's read as a short generated name ("Ada test rerun"). The
// truncated prompt stays the INSTANT placeholder; once the first assistant
// reply lands, ONE small side request through the router asks the utility
// model for a title and it replaces the placeholder — on every surface, since
// the title rides the thread record. Every rule below is pure; code.ts owns
// the fetch and the store write.

/** The thread's birth title. */
export const NEW_SESSION_TITLE = "New session";
/** Longest generated title kept; anything past it is cut. */
export const GENERATED_TITLE_MAX = 48;
/** A first prompt shorter than this is not worth a request ("hi", "test"). */
export const TITLE_MIN_PROMPT = 12;
/** What the request carries: the first prompt and the first reply, cut. */
export const TITLE_PROMPT_CHARS = 600;
export const TITLE_REPLY_CHARS = 400;
export const TITLE_MAX_TOKENS = 16;
/** The instruction, verbatim (his spec, 2026-10-05). */
export const TITLE_SYSTEM_PROMPT =
  "Write a title for this conversation: 3 to 6 words, plain words, no quotes, no trailing period, Title Case not required, in the user's language.";

/** The instant placeholder: the first 42 characters of the first prompt plus
 *  an ellipsis — the rule code.ts applied inline since the rail was born. */
export function placeholderTitle(text: string): string {
  return text.length > SESS_TITLE_MAX ? `${text.slice(0, SESS_TITLE_MAX)}…` : text;
}

/** The slice of a thread the decision reads — code.ts's CodeChat satisfies it. */
export interface TitleableThread {
  title: string;
  messages: ReadonlyArray<{ role: "user" | "assistant"; text: string; kind?: string }>;
  /** The member renamed it by hand — never overwritten (set on both rename paths). */
  titleLocked?: boolean;
  /** One request per thread, in flight or done. */
  titleGenerated?: boolean;
}

export type TitleDecision =
  | { ok: true; prompt: string; reply: string }
  | { ok: false; reason: "locked" | "generated" | "renamed" | "not-first-exchange" | "no-reply" | "short" };

/** A thread's first exchange: its one user turn and the text the assistant
 *  answered with (several text bubbles when tool rows split them; tool/decline/
 *  connect/artifact rows are not prose and are skipped). */
function firstExchange(messages: TitleableThread["messages"]): { prompt: string; reply: string; userTurns: number } {
  let prompt = "";
  let userTurns = 0;
  const reply: string[] = [];
  for (const m of messages) {
    if (m.role === "user") { userTurns++; if (userTurns === 1) prompt = String(m.text ?? ""); continue; }
    if (userTurns !== 1 || m.kind) continue;
    const t = String(m.text ?? "").trim();
    // A failed or stopped turn is not a reply ("⚠ …" / "☮ …" — finishRun's own marks).
    if (!t || t.startsWith("⚠") || t.startsWith("☮")) continue;
    reply.push(t);
  }
  return { prompt, reply: reply.join("\n\n"), userTurns };
}

/** May this thread ask for a title now? Only ever once, only on its first
 *  exchange, only while its title is still the placeholder (or "New
 *  session"), never after a hand rename, never for a trivial prompt. */
export function mayGenerateTitle(c: TitleableThread): TitleDecision {
  if (c.titleLocked) return { ok: false, reason: "locked" };
  if (c.titleGenerated) return { ok: false, reason: "generated" };
  const { prompt, reply, userTurns } = firstExchange(c.messages);
  // A thread with more than its first exchange when this first runs is left
  // alone (no backfill storm) — and so is a thread with none yet.
  if (userTurns !== 1) return { ok: false, reason: "not-first-exchange" };
  if (c.title !== NEW_SESSION_TITLE && c.title !== placeholderTitle(prompt)) return { ok: false, reason: "renamed" };
  if (!reply) return { ok: false, reason: "no-reply" };
  if (prompt.trim().length < TITLE_MIN_PROMPT) return { ok: false, reason: "short" };
  return { ok: true, prompt: prompt.trim().slice(0, TITLE_PROMPT_CHARS), reply: reply.slice(0, TITLE_REPLY_CHARS) };
}

/** The Messages body the router takes (main/session-title.ts carries it). */
export function titleRequestBody(model: string, prompt: string, reply: string): {
  model: string; system: string; messages: Array<{ role: "user"; content: string }>; max_tokens: number; temperature: number;
} {
  return {
    model,
    system: TITLE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `User:\n${prompt}\n\nAssistant:\n${reply}` }],
    max_tokens: TITLE_MAX_TOKENS,
    temperature: 0,
  };
}

/** The model's answer as a title, or null to keep the placeholder: one line,
 *  no quotes, no markdown, no trailing period, whitespace collapsed, capped. */
export function sanitizeTitle(raw: string | null | undefined): string | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  // A second line means the model wrote prose, not a title — keep the placeholder.
  if (/[\r\n]/.test(s)) return null;
  s = s.replace(/^\s*title\s*:\s*/i, "");
  s = s.replace(/^[#>\s]+/, "");
  s = s.replace(/[*_`~]/g, "");
  s = s.replace(/^["'“”‘’«»`]+|["'“”‘’«»`]+$/g, "");
  s = s.replace(/[.。…]+$/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (s.length > GENERATED_TITLE_MAX) s = s.slice(0, GENERATED_TITLE_MAX).trimEnd();
  return s || null;
}

/** The side request itself, through `ask` (the desktop's session-title-generate
 *  door: the router on the user's own keys). Resolves the sanitized title or
 *  null; NEVER throws — a title is not worth an error in the UI. */
export async function fetchSessionTitle(opts: {
  body: ReturnType<typeof titleRequestBody>;
  ask: (body: ReturnType<typeof titleRequestBody>) => Promise<string | null>;
}): Promise<string | null> {
  try { return sanitizeTitle(await opts.ask(opts.body)); }
  catch { return null; }
}
