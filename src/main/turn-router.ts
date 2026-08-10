/**
 * turn-router.ts — the per-turn TOOL PRE-ROUTER.
 *
 * The Chat/Work/Code spaces were collapsed into ONE session type, so `mode` is
 * now always `code` and EVERY turn dumps the full builtin tool surface — even a
 * one-line "thanks, that worked". Those tool schemas are the un-squeezable
 * prefix of every turn's prompt; loading them for a conversational reply is
 * pure token waste.
 *
 * The fix: the SYSTEM (not the user, not a session mode) decides tool cost per
 * turn. `turnNeedsTools` is the seam. When it says NO, harnessRun assembles a
 * MINIMAL surface (no builtins, no connector subset) but keeps find_tools /
 * call_tool lent as an escape hatch, so a mis-classified chat can still
 * discover and call a tool mid-turn (progressive loading). When it says YES,
 * the full path is unchanged.
 *
 * This is a STUB classifier on purpose — the deliverable is the seam + the
 * gating, not a perfect classifier. It is a fast, honest, local heuristic that
 * defaults CONSERVATIVELY: when unsure, it returns true (load tools) so a real
 * work turn is never starved. It only returns false for an obviously
 * conversational, short prompt with no file/path/code/action signals.
 *
 * TODO(pre-router): replace the heuristic with a real classifier —
 *   - a Haiku-class one-shot ("does this turn need tools? yes/no") behind the
 *     gateway, cached per-thread, or
 *   - the memory-rotor attention pass (rrotor/src/harness/memory-rotor.ts),
 *     which already reads the turn to build the per-turn system prompt and can
 *     emit a tool-need signal as a by-product.
 * Keep the conservative default (unsure → true) whatever the backend.
 *
 * TODO(cloud): the SAME pre-router belongs in the pod's own tool assembly
 * (rrotor) as a follow-up — a cloud session pays the identical waste. This pass
 * deliberately touches only the desktop path; see glyphh-harness-run.ts.
 */

/** A prior chat message, as much as the router needs to read it. */
export interface RouterHistoryMsg { role: string; content?: unknown }

// Signals that a turn wants to DO something on the machine, not just talk.
// Any hit flips the decision to "load tools". Kept deliberately broad — a false
// positive costs tokens; a false negative starves a real work turn.

/** A path/file-ish token: a slash path, a dotted filename, a ~/ or ./ ref. */
const PATH_RE = /(^|\s)(~\/|\.\/|\.\.\/|\/)[\w./-]+|[\w-]+\.[a-z]{1,6}(\s|$|[:,)])/i;

/** Fenced code, inline code, or shell-prompt-looking lines. */
const CODE_RE = /```|`[^`]+`|\$\s+\w|(^|\s)(npm|npx|yarn|pnpm|git|cd|ls|cat|grep|rm|mkdir|node|python|pip|make|docker|curl)\s/i;

/** Action verbs that ask the agent to act on files/apps/accounts/the web. */
const ACTION_RE = new RegExp(
  "\\b(" + [
    // filesystem / code
    "run", "build", "compile", "install", "deploy", "commit", "push", "clone",
    "create", "make", "write", "edit", "change", "modify", "update", "fix",
    "add", "remove", "delete", "rename", "move", "refactor", "implement",
    "read", "open", "list", "search", "find", "grep", "scan", "check",
    "test", "debug", "lint", "format",
    // apps / connectors / web
    "email", "send", "message", "slack", "notion", "calendar", "schedule",
    "download", "upload", "fetch", "scrape", "browse", "navigate", "click",
    "connect", "publish", "layout", "app", "tool",
  ].join("|") + ")\\b",
  "i",
);

/** A question ABOUT doing work still needs tools ("how do I run the tests?"
 *  often precedes a run) — but a bare social/thanks reply does not. */
const CONVERSATIONAL_RE = /^\s*(thanks?|thank you|thx|ty|ok(ay)?|cool|nice|great|got it|perfect|awesome|sounds good|yes|no|yep|nope|sure|hi|hello|hey|good (morning|evening|night)|lol|haha|👍|🙏|❤️?)\b[\s.!?]*$/i;

/** How long a prompt may be before we stop trusting "it's just chat". A long
 *  prompt with no signal is more likely a described task than small talk. */
const SHORT_PROMPT_CHARS = 160;

/**
 * Does this turn need the full tool surface?
 *
 * STUB heuristic (see module doc). Returns FALSE only for an obviously
 * conversational, short prompt with no file/path/code/action signal; otherwise
 * TRUE. Async by contract so a real classifier (Haiku / memory-rotor) can drop
 * in without touching the call site.
 */
export async function turnNeedsTools(
  prompt: string,
  _history?: RouterHistoryMsg[],
): Promise<boolean> {
  const text = (prompt ?? "").trim();

  // Empty or whitespace-only — nothing to act on. Cheapest possible turn.
  if (!text) return false;

  // Any hard signal → load tools, regardless of length.
  if (PATH_RE.test(text) || CODE_RE.test(text) || ACTION_RE.test(text)) return true;

  // A long prompt with no signal is probably a described task, not small talk —
  // stay conservative and load tools.
  if (text.length > SHORT_PROMPT_CHARS) return true;

  // Short, no signal. Only skip tools when it reads as a pure social reply;
  // anything else (a real question, an unfamiliar phrasing) keeps tools.
  if (CONVERSATIONAL_RE.test(text)) return false;

  // Unsure → load tools. Never starve a real work turn.
  return true;
}
