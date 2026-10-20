/**
 * loop/core.ts — the PURE parts of the Glyphh loop: the permission gate per
 * tool kind, the compaction threshold, the seed from a chat's stored turns, and
 * the system prompt. No network, no process, so it is unit-tested in a plain
 * node env (test/unit/loop-core.test.ts). The engine is loop.ts.
 */

export type LoopPermission = "ask" | "plan" | "acceptEdits" | "auto";
export type ToolKind = "read" | "edit" | "exec" | "mcp";
export type Gate = "allow" | "ask" | "deny";

export const BUILTIN_READ = new Set(["read_file", "list_dir", "glob", "grep", "artifact_read"]);
export const BUILTIN_EDIT = new Set(["write_file", "edit_file", "artifact_publish"]);
export const BUILTIN_EXEC = new Set(["bash"]);

/** What a tool does to the machine, which is what the permission words govern.
 *  A lent tool the server marks read-only (or that reads by its name) is a
 *  READ: it never asks, in any mode — the other CLIs' users never confirm a
 *  listing, and neither do ours (his report, 2026-09-21). */
export function toolKind(name: string, readOnly = false): ToolKind {
  if (BUILTIN_READ.has(name)) return "read";
  if (BUILTIN_EDIT.has(name)) return "edit";
  if (BUILTIN_EXEC.has(name)) return "exec";
  return readOnly ? "read" : "mcp";
}

/** A lent tool whose NAME says it only reads: list/get/search/status and kin.
 *  Used when the server sent no annotations. Anything that could write —
 *  call, run, open, create, send, delete — stays a governed tool. */
const READ_VERBS = /(^|_)(list|lists|get|search|read|find|show|describe|status|available|health|info|count|query|fetch|lookup|check|connections|stats|history|preview|inspect)(_|$)/i;
export function readsByName(name: string): boolean {
  if (/(^|_)(call|run|exec|open|create|send|delete|remove|write|update|set|put|post|install|start|stop|kill|move|rename|copy|upload|publish|deploy)(_|$)/i.test(name)) return false;
  return READ_VERBS.test(name);
}

/** Glyphh's ONE permission vocabulary, projected onto the loop's own tools:
 *  plan reads and nothing else; ask reads freely and asks for the rest;
 *  acceptEdits also edits freely; auto runs everything. */
export function gate(permission: LoopPermission, kind: ToolKind): Gate {
  if (kind === "read") return "allow";
  if (permission === "auto") return "allow";
  if (permission === "plan") return "deny";
  if (permission === "acceptEdits" && kind === "edit") return "allow";
  return "ask";
}

export const COMPACT_AT_TOKENS = 120_000;
/** THE STEPS ONE TURN MAY TAKE (his report, 2026-10-08: "this chat and others
 *  time out or stop showing working — I have to prod with a prompt to keep you
 *  going"). At 40 a real piece of work (find the bug, fix it, typecheck, test,
 *  commit, push, watch the deploy) ran out mid-task and the turn ended with no
 *  word: the spinner just stopped. It is a runaway guard, not a pacing rule. */
export const MAX_TOOL_ROUNDS = 200;

/** What the person reads when a turn does reach the limit: never a silent stop. */
export const roundsPausedMessage = (n: number): string =>
  `\n\n⏸ I've paused after ${n} steps, the most one turn takes without checking in. Say "continue" and I'll pick up exactly where I left off.`;
export const MAX_TOKENS_OUT = 32000;

export const shouldCompact = (inputTokens: number): boolean => inputTokens >= COMPACT_AT_TOKENS;

/** A tool name the Messages API accepts: [a-zA-Z0-9_-], at most 64 chars. */
export function safeToolName(raw: string): string {
  const s = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return s || "tool";
}

export interface SeedTurn { role?: string; text?: string }
export interface LoopMessage { role: "user" | "assistant"; content: string }

/** The chat's stored turns as the loop's opening messages: user/assistant
 *  text only, consecutive same-role turns merged, and the current prompt (the
 *  composer saved it before the run arrived) left off so it is sent once. */
export function seedFromChat(turns: readonly SeedTurn[], currentPrompt: string): LoopMessage[] {
  const out: LoopMessage[] = [];
  for (const t of turns) {
    const role = t.role === "user" ? "user" : t.role === "assistant" ? "assistant" : null;
    const text = (t.text ?? "").trim();
    if (!role || !text) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${text}`;
    else out.push({ role, content: text });
  }
  const last = out[out.length - 1];
  if (last && last.role === "user" && last.content.trim() === currentPrompt.trim()) out.pop();
  while (out.length && out[0]?.role !== "user") out.shift();
  if (out.length && out[out.length - 1]?.role === "user") out.pop();
  return out;
}

/** One line for the tool card: the argument that names the work. */
export function toolTitle(name: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  // A delegation reads as one: who took it, and what for.
  if (name === "spawn_agent" && typeof o.agent === "string") {
    const task = typeof o.task === "string" ? o.task.replace(/\s+/g, " ").trim() : "";
    return `${o.agent} · ${task}`.slice(0, 120);
  }
  const first = ["command", "path", "pattern", "query", "name", "url", "tool_name"].map((k) => o[k]).find((v) => typeof v === "string" && v) as string | undefined;
  return first ? `${name} ${first}`.slice(0, 120) : name;
}

export function preview(text: string, cap = 240): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > cap ? `${one.slice(0, cap - 1)}…` : one;
}

/** Where the loop is rendered — the prompt names it so the model knows whether
 *  "the app" or "the terminal" is in front of the user. */
export type LoopHost = "desktop" | "terminal" | "worker";

export interface PromptExtras {
  hasLocalMcp: boolean; hasGateway: boolean; host?: LoopHost;
  /** find_tools / call_tool are on the belt (catalog.ts). */
  finder?: boolean;
  /** The skills index (catalog.skillsIndex), or "". */
  skills?: string;
}

export function systemPrompt(workdir: string, extras: PromptExtras): string {
  const host = extras.host ?? "desktop";
  return [
    host === "terminal"
      ? "You are Glyphh, the user's agent loop, running on the user's own machine and rendered in their terminal."
      : host === "worker"
        ? "You are Glyphh, the user's agent loop, running in a cloud workspace of theirs and rendered in their browser. The folder you work in is that workspace; nothing here is the user's own machine."
        : "You are Glyphh, the user's agent loop running inside the Glyphh desktop app.",
    `Working folder: ${workdir}. It is this session's whole world: paths resolve against it, file tools refuse anything outside it, and the shell can write only inside it. Never try to work around that — if the task needs another folder, say so and ask the user to change the session's folder.`,
    "Use the tools for anything that touches files, the shell or the user's connected apps; never pretend to have run something.",
    "Prefer small, verifiable steps: read before you edit, run the tests you touched, and say what you did in plain words.",
    extras.hasLocalMcp ? "The glyphh_* tools reach the Glyphh app itself: panels, memory, tasks and the user's workspace." : "",
    // His report, 2026-09-29: the agent asked the user whether Glyphh was running, and said "Done! It's open" before any result came back.
    extras.hasLocalMcp && host === "desktop" ? "You are inside the app the user is looking at, so never ask whether Glyphh is running. A panel is open only when panels_open says so; to show a page, open the browser with its url in one call (panels_open app 'browser' with url)." : "",
    "Something happened only when a tool result says it did. Never tell the user an outcome before its result, and when a result is an error, say so plainly.",
    extras.finder
      ? `Your listed tools are only the everyday ones. find_tools searches everything else${extras.hasLocalMcp ? " on this machine (Glyphh's tasks, schedules, memory, installed apps and more)" : ""}${extras.hasGateway ? " and in the user's connected accounts (Gmail, Drive, GitHub and thousands more)" : ""}; call_tool runs what it finds. Search before saying something cannot be done.`
      : "",
    host !== "desktop"
      ? "When a step needs the user's permission the host asks them; a denied step is not a failure of yours, report it and continue."
      : "When a step needs the user's permission the app asks them; a denied step is not a failure of yours, report it and continue.",
    extras.skills ?? "",
  ].filter(Boolean).join("\n");
}
