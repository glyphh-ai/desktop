/**
 * account-lane.ts — the ACCOUNT LANE as an engine (BRIDGE-MODE.md §6, §7),
 * shared by the local /v1/messages listener and by `bridge.turn` over the
 * attach relay: a Messages API body in, Messages SSE frames out, on a
 * headless claude session on the member's own login. Conversations map to
 * sessions by transcript prefix; every ask ends the turn as a question and
 * the next message answers it.
 */

import { ClaudeSession, type SpawnClaude, type SpawnOptions } from "./claude-session.js";
import { MessagesStream, type SseFrame } from "./sse-adapter.js";
import type { Decision } from "./routing.js";
import {
  askText, matchTranscript, openingKey, seedPrompt, summarizeInput, systemTextOf, turnsOf,
  PARK_EXPIRED_TEXT, SESSION_IDLE_MS, type Turn,
} from "./conversation.js";

export interface BridgeUsage {
  conversation: string; model: string; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; durationMs: number;
}

export interface AccountLaneDeps {
  spawnClaude: SpawnClaude;
  reportUsage: (usage: BridgeUsage) => Promise<void>;
  onActivity?: (line: string) => void;
  now?: () => number;
}

export class AccountLane {
  private sessions = new Map<string, ClaudeSession[]>();
  private sweeper: NodeJS.Timeout | null;
  private readonly now: () => number;
  private readonly activity: (line: string) => void;

  constructor(private readonly deps: AccountLaneDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.activity = deps.onActivity ?? (() => undefined);
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  sessionCount(): number {
    let n = 0;
    for (const list of this.sessions.values()) n += list.length;
    return n;
  }

  conversation(key: string): Turn[] | null {
    const s = this.sessions.get(key)?.[0];
    return s ? [...s.turns] : null;
  }

  killAll(): void {
    for (const list of this.sessions.values()) for (const s of list) s.kill();
    this.sessions.clear();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.killAll();
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, list] of this.sessions) {
      const keep = list.filter((s) => {
        if (now - s.lastUsedAt > SESSION_IDLE_MS) { s.kill(); return false; }
        return true;
      });
      if (keep.length) this.sessions.set(key, keep); else this.sessions.delete(key);
    }
  }

  /** One turn. Frames go to `emit` as they happen; the stream returned is also
   *  the whole turn (`toMessage()`) for a client that did not ask to stream. */
  async run(body: Record<string, unknown>, model: string, decision: Decision, emit: (frame: SseFrame) => void): Promise<MessagesStream> {
    const turns = turnsOf(body.messages);
    if (!turns.length || turns[turns.length - 1].role !== "user") throw new Error("the last message must be the user's");
    const key = openingKey(turns);
    const bucket = this.sessions.get(key) ?? [];
    let notice = "";
    let session: ClaudeSession | null = null;
    let mode: "continue" | "answer" | "fork" = "fork";
    let answer: ReturnType<typeof matchTranscript> | null = null;
    for (const s of bucket) {
      if (s.parkExpired()) { s.kill(); notice = PARK_EXPIRED_TEXT; continue; }
      const m = matchTranscript({ turns: s.turns, parkedAsk: s.parkedAsk }, turns);
      if (m.kind === "fork") continue;
      session = s; mode = m.kind; answer = m;
      break;
    }
    this.sessions.set(key, bucket.filter((s) => s.alive || s === session));
    const last = turns[turns.length - 1].text;
    if (!session) {
      const opts: SpawnOptions = { permission: decision.permission, model, appendSystem: systemTextOf(body.system), resume: null, chatOnly: decision.chatOnly };
      session = new ClaudeSession(key, this.deps.spawnClaude, opts, this.activity, this.now);
      const list = this.sessions.get(key) ?? [];
      list.push(session);
      this.sessions.set(key, list);
      session.turns = turns.slice(0, -1);
      this.activity(`account lane → ${model} (${decision.permission}${decision.chatOnly ? ", chat only" : ""})`);
    }
    const ms = new MessagesStream(model, emit);
    if (notice) ms.note(notice);
    const started = this.now();
    let end;
    if (mode === "answer" && answer && answer.kind === "answer") {
      const asked = session.parkedAsk ?? "";
      session.turns.push({ role: "assistant", text: asked }, { role: "user", text: last });
      end = answer.answer ? await session.answer(answer.answer, ms) : await session.denyThen(last, ms);
    } else {
      const prompt = mode === "continue" || turns.length === 1 ? last : seedPrompt(turns);
      end = await session.send(prompt, ms);
      if (mode === "fork") session.turns = turns.slice(0, -1);
      session.turns.push({ role: "user", text: last });
    }
    if (end.kind === "ask") {
      const text = askText(end.tool, summarizeInput(end.input));
      session.park({ requestId: end.requestId, tool: end.tool, input: end.input, text, since: this.now() });
      ms.finishWithText(text);
      this.activity(`ask: ${end.tool}`);
    } else {
      if (!ms.finished) ms.finishWithText(end.kind === "exit" ? end.error : "");
      session.turns.push({ role: "assistant", text: ms.assistantText });
      const t = ms.tokens();
      void this.deps.reportUsage({ conversation: key, model, inputTokens: t.input_tokens, outputTokens: t.output_tokens, cacheReadTokens: t.cache_read_input_tokens ?? 0, cacheWriteTokens: t.cache_creation_input_tokens ?? 0, durationMs: this.now() - started }).catch(() => undefined);
    }
    return ms;
  }
}
