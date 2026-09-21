/**
 * sse-adapter.ts — stream-json → Messages API (BRIDGE-MODE.md §6.3).
 *
 * One instance per Claude Desktop turn. Fed the CLI's stream-json events, it
 * emits the Anthropic SSE frames Claude Desktop expects: text blocks stream,
 * tool activity is dropped (the TUI shows it), the CLI's result closes the
 * message with real usage. It can also close a turn on text of our own, for
 * an ask or an error, and render the whole thing as one JSON message for a
 * client that did not ask to stream.
 */

export interface SseFrame { event: string; data: Record<string, unknown> }

interface Usage { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

export interface StreamJsonEvent {
  type?: string;
  subtype?: string;
  event?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  is_error?: boolean;
  result?: unknown;
  session_id?: string;
}

export class MessagesStream {
  readonly id: string;
  private nextIndex = 0;
  /** CLI block index → our block index, for the API call in flight; -1 = dropped (tool_use). */
  private blocks = new Map<number, number>();
  private open: number | null = null;
  private text: string[] = [];
  private usage: Usage = { input_tokens: 0, output_tokens: 0 };
  private started = false;
  private closed = false;

  constructor(private readonly model: string, private readonly emit: (frame: SseFrame) => void, id?: string) {
    this.id = id ?? `msg_bridge_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  get finished(): boolean { return this.closed; }
  get assistantText(): string { return this.text.join(""); }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.emit({ event: "message_start", data: { type: "message_start", message: {
      id: this.id, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } } });
  }

  private openText(): number {
    this.start();
    if (this.open !== null) return this.open;
    const idx = this.nextIndex++;
    this.open = idx;
    this.text.push("");
    this.emit({ event: "content_block_start", data: { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } } });
    return idx;
  }

  private closeText(): void {
    if (this.open === null) return;
    this.emit({ event: "content_block_stop", data: { type: "content_block_stop", index: this.open } });
    this.open = null;
  }

  private delta(text: string): void {
    if (!text) return;
    const idx = this.openText();
    this.text[this.text.length - 1] += text;
    this.emit({ event: "content_block_delta", data: { type: "content_block_delta", index: idx, delta: { type: "text_delta", text } } });
  }

  /** One stream-json line from the CLI. Returns true once the turn is closed. */
  feed(ev: StreamJsonEvent): boolean {
    if (this.closed) return true;
    if (ev.type === "stream_event") {
      const e = ev.event ?? {};
      const et = String(e.type ?? "");
      if (et === "message_start") { this.blocks.clear(); this.start(); return false; }
      if (et === "content_block_start") {
        const cli = Number(e.index ?? 0);
        const cb = (e.content_block ?? {}) as { type?: string; text?: string };
        if (cb.type === "text") { this.closeText(); this.blocks.set(cli, this.openText()); if (cb.text) this.delta(cb.text); }
        else this.blocks.set(cli, -1);
        return false;
      }
      if (et === "content_block_delta") {
        const cli = Number(e.index ?? 0);
        if (this.blocks.get(cli) === -1) return false;
        const d = (e.delta ?? {}) as { type?: string; text?: string };
        if (d.type === "text_delta" && d.text) this.delta(d.text);
        return false;
      }
      if (et === "content_block_stop") {
        const cli = Number(e.index ?? 0);
        if (this.blocks.get(cli) !== -1 && this.blocks.get(cli) === this.open) this.closeText();
        return false;
      }
      if (et === "message_delta") {
        const u = (e.usage ?? {}) as { output_tokens?: number };
        if (typeof u.output_tokens === "number") this.usage.output_tokens += u.output_tokens;
        return false;
      }
      return false;
    }
    if (ev.type === "result") {
      const u = (ev.usage ?? {}) as Partial<Usage>;
      if (typeof u.input_tokens === "number") this.usage.input_tokens = u.input_tokens;
      if (typeof u.output_tokens === "number") this.usage.output_tokens = u.output_tokens;
      if (typeof u.cache_read_input_tokens === "number") this.usage.cache_read_input_tokens = u.cache_read_input_tokens;
      if (typeof u.cache_creation_input_tokens === "number") this.usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
      if (ev.is_error) {
        const said = typeof ev.result === "string" && ev.result ? ev.result : "the run failed";
        this.finishWithText(said);
        return true;
      }
      if (!this.started) this.start();
      this.finish("end_turn");
      return true;
    }
    return false;
  }

  /** One line of our own inside a turn that goes on: a notice before the reply. */
  note(text: string): void {
    if (this.closed || !text) return;
    this.closeText();
    this.delta(text);
    this.closeText();
  }

  /** Close the turn on our own text: an ask, an error, a notice. */
  finishWithText(text: string): void {
    if (this.closed) return;
    this.closeText();
    this.delta(text);
    this.finish("end_turn");
  }

  private finish(stop: "end_turn"): void {
    if (this.closed) return;
    this.start();
    this.closeText();
    this.closed = true;
    const usage: Record<string, unknown> = { output_tokens: this.usage.output_tokens, input_tokens: this.usage.input_tokens };
    if (this.usage.cache_read_input_tokens !== undefined) usage.cache_read_input_tokens = this.usage.cache_read_input_tokens;
    if (this.usage.cache_creation_input_tokens !== undefined) usage.cache_creation_input_tokens = this.usage.cache_creation_input_tokens;
    this.emit({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage } });
    this.emit({ event: "message_stop", data: { type: "message_stop" } });
  }

  /** The turn as one Messages API object, for a non-streaming request. */
  toMessage(): Record<string, unknown> {
    return {
      id: this.id, type: "message", role: "assistant", model: this.model,
      content: this.text.filter((t) => t).map((t) => ({ type: "text", text: t })),
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: this.usage.input_tokens, output_tokens: this.usage.output_tokens,
        ...(this.usage.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: this.usage.cache_read_input_tokens } : {}),
        ...(this.usage.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: this.usage.cache_creation_input_tokens } : {}) },
    };
  }

  tokens(): Usage { return { ...this.usage }; }
}

/** One SSE frame on the wire. */
export function sseText(frame: SseFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}
