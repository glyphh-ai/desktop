/**
 * conversation.ts — Claude Desktop conversations ↔ CLI sessions, and the ASK
 * protocol (BRIDGE-MODE.md §6.1, §7). Pure: no process, no clock of its own.
 *
 * Claude Desktop sends the whole transcript every turn. A session remembers
 * the turns it has seen; a transcript whose earlier turns equal them continues
 * it, one whose earlier turns differ forks a fresh session seeded with the
 * transcript. When a session is parked on an ask, the transcript's last
 * assistant text is the ask and the last user text is the answer.
 */

import { createHash } from "node:crypto";

export interface Turn { role: "user" | "assistant"; text: string }

export type Answer = "allow" | "deny" | "always";

/** Text out of a Messages API body: text blocks joined, everything else dropped. */
export function turnsOf(messages: unknown): Turn[] {
  if (!Array.isArray(messages)) return [];
  const out: Turn[] = [];
  for (const m of messages as Array<Record<string, unknown>>) {
    const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
    if (!role) continue;
    const c = m.content;
    const text = typeof c === "string"
      ? c
      : Array.isArray(c)
        ? (c as Array<{ type?: string; text?: string }>).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n")
        : "";
    out.push({ role, text: text.trim() });
  }
  return out;
}

export function systemTextOf(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return (system as Array<{ type?: string; text?: string }>).filter((b) => b?.type === "text" && b.text).map((b) => b.text).join("\n");
  return "";
}

/** Conversations are bucketed by their opening message; the prefix decides within the bucket. */
export function openingKey(turns: readonly Turn[]): string {
  const first = turns.find((t) => t.role === "user")?.text ?? "";
  return createHash("sha256").update(first).digest("hex").slice(0, 32);
}

const same = (a: Turn, b: Turn): boolean => a.role === b.role && a.text === b.text;

export interface SessionView { turns: readonly Turn[]; parkedAsk: string | null }

export type Match =
  | { kind: "continue" }
  | { kind: "answer"; answer: Answer | null }
  | { kind: "fork" };

/**
 * How an incoming transcript relates to a session. The last turn must be the
 * user's; everything before it is compared with what the session has seen.
 */
export function matchTranscript(session: SessionView, turns: readonly Turn[]): Match {
  if (!turns.length || turns[turns.length - 1].role !== "user") return { kind: "fork" };
  const before = turns.slice(0, -1);
  if (session.parkedAsk !== null) {
    // Parked: the session's turns plus the ask itself are what the client has.
    const expected = [...session.turns, { role: "assistant" as const, text: session.parkedAsk }];
    if (before.length === expected.length && before.every((t, i) => same(t, expected[i]))) {
      return { kind: "answer", answer: parseAnswer(turns[turns.length - 1].text) };
    }
    return { kind: "fork" };
  }
  if (before.length === session.turns.length && before.every((t, i) => same(t, session.turns[i]))) return { kind: "continue" };
  return { kind: "fork" };
}

/** A plain reply parsed as the ask's answer; null when it is something else (a deny plus a new prompt). */
export function parseAnswer(text: string): Answer | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(always|allow always|yes always|always allow)$/.test(t)) return "always";
  if (/^(allow|yes|y|ok|okay|approve|approved|go ahead|do it)$/.test(t)) return "allow";
  if (/^(deny|no|n|denied|stop|don'?t|do not)$/.test(t)) return "deny";
  return null;
}

/** The fixed wording every ask uses, so a plain reply parses (§7). */
export function askText(tool: string, summary: string): string {
  const line = summary.replace(/\s+/g, " ").trim().slice(0, 300);
  return `Claude Code wants to run \`${tool}\`${line ? `: ${line}` : ""}.\nReply **allow**, **deny**, or **always** (allow for the rest of this conversation).`;
}

/** One line of a tool's input, for the ask. */
export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "pattern", "url", "query", "description"]) {
    if (typeof o[k] === "string" && o[k]) return String(o[k]);
  }
  try { return JSON.stringify(o).slice(0, 300); } catch { return ""; }
}

/** A fresh session's opening prompt when the transcript has history the CLI never saw. */
export function seedPrompt(turns: readonly Turn[]): string {
  if (turns.length <= 1) return turns[0]?.text ?? "";
  const history = turns.slice(0, -1).map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n");
  return `The conversation so far (continue it, do not repeat it):\n\n${history}\n\nUser: ${turns[turns.length - 1].text}`;
}

export const PARK_TIMEOUT_MS = 15 * 60_000;
export const SESSION_IDLE_MS = 24 * 3_600_000;
export const PARK_EXPIRED_TEXT = "That request waited too long for an answer and was dropped. Continuing fresh.";
