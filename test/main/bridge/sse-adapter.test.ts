import { describe, it, expect } from "vitest";
import { MessagesStream, sseText, type SseFrame } from "../../../src/main/bridge/sse-adapter.js";

const collect = (model = "claude-sonnet-5") => {
  const frames: SseFrame[] = [];
  const s = new MessagesStream(model, (f) => frames.push(f), "msg_1");
  return { s, frames };
};
const se = (event: Record<string, unknown>) => ({ type: "stream_event", event });

describe("MessagesStream", () => {
  it("streams text blocks, drops tool blocks, and closes on the CLI's result with its usage", () => {
    const { s, frames } = collect();
    expect(s.feed(se({ type: "message_start" }))).toBe(false);
    s.feed(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    s.feed(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } }));
    s.feed(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "look." } }));
    s.feed(se({ type: "content_block_stop", index: 0 }));
    s.feed(se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Read" } }));
    s.feed(se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"p" } }));
    s.feed(se({ type: "content_block_stop", index: 1 }));
    s.feed({ type: "user", message: { content: [{ type: "tool_result" }] } } as never);
    // the next API call inside the same CLI turn restarts indices at 0
    s.feed(se({ type: "message_start" }));
    s.feed(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    s.feed(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }));
    s.feed(se({ type: "content_block_stop", index: 0 }));
    const closed = s.feed({ type: "result", subtype: "success", usage: { input_tokens: 120, output_tokens: 9, cache_read_input_tokens: 40 } });
    expect(closed).toBe(true);
    expect(s.finished).toBe(true);

    expect(frames.map((f) => f.event)).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop",
    ]);
    expect(frames[0].data).toMatchObject({ type: "message_start", message: { id: "msg_1", role: "assistant", model: "claude-sonnet-5" } });
    expect(frames[5].data).toMatchObject({ index: 1, content_block: { type: "text" } });
    expect(frames[8].data).toEqual({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9, input_tokens: 120, cache_read_input_tokens: 40 } });
    expect(s.assistantText).toBe("Let me look.Done.");
    expect(s.toMessage()).toMatchObject({ content: [{ type: "text", text: "Let me look." }, { type: "text", text: "Done." }], usage: { input_tokens: 120, output_tokens: 9 } });
  });

  it("closes a turn on our own text, for an ask, even before the CLI said anything", () => {
    const { s, frames } = collect();
    s.finishWithText("Claude Code wants to run `Bash`.");
    expect(frames.map((f) => f.event)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(frames[2].data).toMatchObject({ delta: { type: "text_delta", text: "Claude Code wants to run `Bash`." } });
    expect(s.feed({ type: "result", subtype: "success" }), "nothing after the close").toBe(true);
    expect(frames).toHaveLength(6);
  });

  it("turns a failed result into the last text block, never a hung stream", () => {
    const { s, frames } = collect();
    s.feed(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "Half" } }));
    s.feed({ type: "result", subtype: "error_during_execution", is_error: true, result: "Login expired · Please run /login" });
    expect(s.finished).toBe(true);
    expect(s.assistantText).toBe("HalfLogin expired · Please run /login");
    expect(frames[frames.length - 1].event).toBe("message_stop");
  });

  it("writes a frame the way Anthropic does", () => {
    expect(sseText({ event: "ping", data: { type: "ping" } })).toBe('event: ping\ndata: {"type":"ping"}\n\n');
  });
});
