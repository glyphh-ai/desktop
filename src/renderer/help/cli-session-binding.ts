/**
 * cli-session-binding.ts — the CHAT ⇄ CLI-SESSION binding, as pure rules.
 *
 * A chat on a CLI loop rides that CLI's own session; the >_ hop opens the
 * same session in a terminal, and a session adopted from the recents becomes
 * a chat. Every one of those steps reads or writes the binding, and a wrong
 * binding is a conversation that silently forks or resumes the wrong thread —
 * so the rules live here, with no DOM, no IPC and no state, importable from a
 * test. The panel's code holds the wiring.
 *
 * Kept inside src/renderer (not src/shared): the renderer build pins tsc's
 * rootDir to this directory, and an import that escapes it silently moves the
 * whole emit to dist/renderer/renderer — which nothing loads. See
 * scripts/check-renderer-emit.mjs.
 *
 * THE LAW: a binding is PER CLI. A claude session id must never feed a codex
 * resume. `cliSessionIds[cli]` is the truth; `cliSessionId` is a legacy
 * single slot that only ever meant the claude lane. The Glyphh loop binds
 * nothing: on it the chat id IS the session (`glyphh --resume <chatId>`).
 */

/** Whatever a chat row carries about its CLI sessions. */
export interface CliBound {
  /** Per-CLI bindings — the truth. */
  cliSessionIds?: Record<string, string>;
  /** Legacy single slot, claude lane only. */
  cliSessionId?: string;
}

/** A loop as the renderer holds it (`cli-agents-list` rows carry both). */
export interface LoopRow { id: string; cli?: string }

/** The loop a chat runs on when it names none: Glyphh's own. */
export const DEFAULT_LOOP = "glyphh";
/** The lane the legacy single slot belongs to, and an unnamed binding's lane. */
export const LEGACY_CLI = "claude";

const KNOWN_CLIS: ReadonlySet<string> = new Set(["glyphh", "claude", "codex", "gemini", "copilot", "cursor"]);

/**
 * The CLI a chat runs on: its loop's own `cli` field, else the loop id when it
 * names a CLI (a roster not yet loaded), else the default loop. Never a
 * display field — a prose description read as a key misses every map and
 * resumes on the wrong lane.
 */
export function sessionCliOf(loopId: string | undefined, loops: readonly LoopRow[]): string {
  const id = loopId || "";
  const hit = loops.find((x) => x.id === id)?.cli;
  if (hit) return hit;
  return KNOWN_CLIS.has(id) ? id : DEFAULT_LOOP;
}

/**
 * The session id to resume for one CLI lane — the per-CLI map first, then the
 * legacy slot, and the legacy slot ONLY for claude.
 */
export function cliSidFor(row: CliBound | undefined, cli: string): string | null {
  if (!row) return null;
  const lane = cli || LEGACY_CLI;
  const hit = row.cliSessionIds?.[lane];
  if (hit) return hit;
  return lane === LEGACY_CLI ? (row.cliSessionId ?? null) : null;
}

/**
 * Write a binding. Returns true when something changed, so the caller knows
 * whether a save is owed.
 *
 * Mirroring into the legacy slot is claude-only: a codex sid parked there is
 * what a stale claude resume would later pick up.
 */
export function applyCliBinding(row: CliBound, cli: string, sid: string): boolean {
  if (!sid) return false;
  const lane = cli || LEGACY_CLI;
  const map = (row.cliSessionIds ??= {});
  const changed = map[lane] !== sid || (lane === LEGACY_CLI && row.cliSessionId !== sid);
  map[lane] = sid;
  if (lane === LEGACY_CLI) row.cliSessionId = sid;
  return changed;
}

/**
 * Find the chat already holding a session id, ACROSS EVERY LANE — a lookup
 * that only read the legacy slot would never find a codex/gemini/copilot/
 * cursor session's chat, and every hop back would fork a new one.
 */
export function chatForCliSession<T extends CliBound>(chats: readonly T[], sid: string): T | undefined {
  if (!sid) return undefined;
  return chats.find((c) => Object.values(c.cliSessionIds ?? {}).includes(sid))
    ?? chats.find((c) => c.cliSessionId === sid);
}

/** Drop every binding pointing at a dead session; true if the row changed. */
export function forgetCliSession(row: CliBound, sid: string): boolean {
  let touched = false;
  if (row.cliSessionId === sid) { row.cliSessionId = undefined; touched = true; }
  for (const [lane, v] of Object.entries(row.cliSessionIds ?? {})) {
    if (v === sid) { delete row.cliSessionIds![lane]; touched = true; }
  }
  return touched;
}

/**
 * ONE TITLE GRAMMAR for a session row, whatever store it came from: the
 * native CLI readers cut at 80, our own sessions at 42, and one merged list
 * must read as one product. Callers keep the full text on the row's tooltip.
 */
export const SESS_TITLE_MAX = 42;
export function sessionDisplayTitle(t: string | undefined): string {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "Session";
  return s.length > SESS_TITLE_MAX ? `${s.slice(0, SESS_TITLE_MAX - 1).trimEnd()}…` : s;
}
