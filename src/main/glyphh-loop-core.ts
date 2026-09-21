/**
 * glyphh-loop-core.ts — the PURE parts of the Glyphh loop (glyphh-loop.ts):
 * the permission gate per tool kind, the compaction threshold, the seed from a
 * chat's stored turns, and the system prompt. No Electron, no network, so it
 * is unit-tested in a plain node env (test/main/glyphh-loop-core.test.ts).
 */

export type LoopPermission = "ask" | "plan" | "acceptEdits" | "auto";
export type ToolKind = "read" | "edit" | "exec" | "mcp";
export type Gate = "allow" | "ask" | "deny";

export const BUILTIN_READ = new Set(["read_file", "list_dir", "glob", "grep"]);
export const BUILTIN_EDIT = new Set(["write_file", "edit_file"]);
export const BUILTIN_EXEC = new Set(["bash"]);

/** What a tool does to the machine, which is what the permission words govern. */
export function toolKind(name: string): ToolKind {
  if (BUILTIN_READ.has(name)) return "read";
  if (BUILTIN_EDIT.has(name)) return "edit";
  if (BUILTIN_EXEC.has(name)) return "exec";
  return "mcp";
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
export const MAX_TOOL_ROUNDS = 40;
export const MAX_TOKENS_OUT = 8192;

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
  while (out.length && out[0].role !== "user") out.shift();
  if (out.length && out[out.length - 1].role === "user") out.pop();
  return out;
}

/** One line for the tool card: the argument that names the work. */
export function toolTitle(name: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const first = ["command", "path", "pattern", "query", "name", "url", "tool_name"].map((k) => o[k]).find((v) => typeof v === "string" && v) as string | undefined;
  return first ? `${name} ${first}`.slice(0, 120) : name;
}

export function preview(text: string, cap = 240): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > cap ? `${one.slice(0, cap - 1)}…` : one;
}

export function systemPrompt(workdir: string, extras: { hasLocalMcp: boolean; hasGateway: boolean }): string {
  return [
    "You are Glyphh, the user's agent loop running inside the Glyphh desktop app.",
    `Working folder: ${workdir}. Paths you read or write resolve against it.`,
    "Use the tools for anything that touches files, the shell or the user's connected apps; never pretend to have run something.",
    "Prefer small, verifiable steps: read before you edit, run the tests you touched, and say what you did in plain words.",
    extras.hasLocalMcp ? "The glyphh_* tools reach the Glyphh app itself: panels, memory, tasks and the user's workspace." : "",
    extras.hasGateway ? "mcp_tool_search finds a connected app's tools (Gmail, Drive, GitHub and 3,500 more); mcp_tool_call runs one by the name search returned." : "",
    "When a step needs the user's permission the app asks them; a denied step is not a failure of yours, report it and continue.",
  ].filter(Boolean).join("\n");
}
