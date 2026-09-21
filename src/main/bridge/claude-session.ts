/**
 * claude-session.ts — the ACCOUNT LANE (BRIDGE-MODE.md §6): one Claude Desktop
 * conversation is one headless `claude` session on the member's own login,
 * driven over the stream-json control channel the Agent panel already uses.
 *
 * The process is spawned through a factory the caller injects (the login
 * shell, the loop's env prefix, the working folder), so this module knows
 * nothing about Electron and nothing about where `claude` lives. It owns:
 * the process, its stream, which MessagesStream a turn writes into, and the
 * parked ask when the CLI wants a human (§7).
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { MessagesStream, type StreamJsonEvent } from "./sse-adapter.js";
import { type Answer, type Turn, PARK_TIMEOUT_MS } from "./conversation.js";
import type { Permission } from "./routing.js";

export interface SpawnOptions {
  permission: Permission;
  model: string;
  appendSystem: string;
  resume: string | null;
  chatOnly: boolean;
}

export type SpawnClaude = (opts: SpawnOptions) => ChildProcessWithoutNullStreams;

export interface Ask { requestId: string; tool: string; input: unknown; text: string; since: number }

export type TurnEnd = { kind: "done" } | { kind: "ask"; tool: string; input: unknown; requestId: string } | { kind: "exit"; error: string };

/** The CLI's own permission-mode names for the routing table's words. */
export const PERMISSION_FLAG: Record<Permission, string> = {
  "read-only": "plan",
  plan: "plan",
  edits: "acceptEdits",
  auto: "bypassPermissions",
};

export class ClaudeSession {
  proc: ChildProcessWithoutNullStreams | null = null;
  sessionId: string | null = null;
  /** The transcript turns this session has produced or consumed, for matching. */
  turns: Turn[] = [];
  parked: Ask | null = null;
  lastUsedAt: number;
  private buf = "";
  private current: { stream: MessagesStream; end: (e: TurnEnd) => void } | null = null;
  private alwaysAllowed = new Set<string>();
  private errTail = "";
  private exited: string | null = null;
  readonly onActivity: (line: string) => void;

  constructor(
    readonly key: string,
    private readonly spawn: SpawnClaude,
    private readonly opts: SpawnOptions,
    onActivity?: (line: string) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.lastUsedAt = now();
    this.onActivity = onActivity ?? (() => undefined);
  }

  get alive(): boolean { return !!this.proc && this.exited === null; }
  get parkedAsk(): string | null { return this.parked?.text ?? null; }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc && this.exited === null) return this.proc;
    const proc = this.spawn({ ...this.opts, resume: this.sessionId });
    this.proc = proc;
    this.exited = null;
    this.buf = "";
    proc.stdout.on("data", (b: Buffer) => this.onStdout(b));
    proc.stderr.on("data", (b: Buffer) => { this.errTail = (this.errTail + b.toString("utf-8")).slice(-2000); });
    proc.on("exit", (code) => {
      this.exited = code === 0 || code === null ? "the session ended" : (this.errTail.trim() || `claude exited ${code}`);
      const cur = this.current;
      this.current = null;
      if (cur) {
        if (!cur.stream.finished) cur.stream.finishWithText(this.exited);
        cur.end({ kind: "exit", error: this.exited });
      }
      this.parked = null;
    });
    return proc;
  }

  private onStdout(b: Buffer): void {
    this.buf += b.toString("utf-8");
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      this.onEvent(ev);
    }
  }

  private onEvent(ev: Record<string, unknown>): void {
    const type = String(ev.type ?? "");
    if (type === "system" && ev.subtype === "init") {
      if (typeof ev.session_id === "string") this.sessionId = ev.session_id;
      return;
    }
    if (type === "control_request") {
      const req = (ev.request ?? {}) as Record<string, unknown>;
      const requestId = String(ev.request_id ?? "");
      if (req.subtype !== "can_use_tool") { this.respond(requestId, true); return; }
      const tool = String(req.tool_name ?? "tool");
      if (this.alwaysAllowed.has(tool) || this.opts.permission === "auto") { this.respond(requestId, true); this.onActivity(`allowed ${tool}`); return; }
      const cur = this.current;
      if (!cur) { this.respond(requestId, false); return; }
      this.current = null;
      cur.end({ kind: "ask", tool, input: req.input, requestId });
      return;
    }
    if (type === "stream_event") {
      const e = (ev.event ?? {}) as Record<string, unknown>;
      if (e.type === "content_block_start") {
        const cb = (e.content_block ?? {}) as { type?: string; name?: string };
        if (cb.type === "tool_use" && cb.name) this.onActivity(`tool ${cb.name}`);
      }
    }
    const cur = this.current;
    if (!cur) return;
    const closed = cur.stream.feed(ev as StreamJsonEvent);
    if (closed) {
      this.current = null;
      cur.end({ kind: "done" });
    }
  }

  private respond(requestId: string, allow: boolean): void {
    if (!this.proc) return;
    const response = allow ? { behavior: "allow" } : { behavior: "deny", message: "The user declined." };
    this.proc.stdin.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } }) + "\n");
  }

  /** One user turn: the text goes to the CLI, the reply streams into `stream`. */
  send(text: string, stream: MessagesStream): Promise<TurnEnd> {
    this.lastUsedAt = this.now();
    const proc = this.ensure();
    return new Promise<TurnEnd>((end) => {
      this.current = { stream, end };
      proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
    });
  }

  /** The member answered a parked ask: tell the CLI and stream the rest of the turn into `stream`. */
  answer(answer: Answer, stream: MessagesStream): Promise<TurnEnd> {
    const ask = this.parked;
    this.parked = null;
    this.lastUsedAt = this.now();
    if (!ask || !this.proc || this.exited !== null) {
      return Promise.resolve({ kind: "exit", error: "that request is no longer waiting" });
    }
    if (answer === "always") this.alwaysAllowed.add(ask.tool);
    return new Promise<TurnEnd>((end) => {
      this.current = { stream, end };
      this.respond(ask.requestId, answer !== "deny");
    });
  }

  /** The member said something else: the ask is a deny, and the new text runs as the next turn once the CLI settles. */
  async denyThen(text: string, stream: MessagesStream): Promise<TurnEnd> {
    const ask = this.parked;
    this.parked = null;
    if (ask && this.proc && this.exited === null) {
      const settled = new Promise<TurnEnd>((end) => { this.current = { stream: new MessagesStream(this.opts.model, () => undefined), end }; });
      this.respond(ask.requestId, false);
      await settled;
    }
    return this.send(text, stream);
  }

  park(ask: Ask): void { this.parked = ask; }

  parkExpired(): boolean { return !!this.parked && this.now() - this.parked.since > PARK_TIMEOUT_MS; }

  kill(): void {
    try { this.proc?.kill(); } catch { /* gone */ }
    this.proc = null;
    this.current = null;
    this.parked = null;
  }
}
