/**
 * The local translator carries the effort dial: `reasoning_effort` crosses by
 * name, an Anthropic `thinking` budget becomes the nearest effort, and a
 * reasoning model's `reasoning_content` comes back as an Anthropic thinking
 * block, buffered or streamed.
 */
import { describe, it, expect } from "vitest";
import { toOpenAIRequest, toAnthropicResponse, createStreamTranslator, effortFromBudget } from "../../src/runtime/anthropic-openai.js";

const base = { model: "x", messages: [{ role: "user", content: "hi" }] };

describe("toOpenAIRequest: the effort dial", () => {
  it("forwards reasoning_effort by name", () => {
    expect(toOpenAIRequest({ ...base, reasoning_effort: "high" }, "local")).toMatchObject({ reasoning_effort: "high" });
  });

  it("sends none when neither reasoning_effort nor thinking is set", () => {
    expect(toOpenAIRequest(base, "local")).not.toHaveProperty("reasoning_effort");
  });

  it("maps an Anthropic thinking budget to the nearest effort when no reasoning_effort is set", () => {
    const at = (budget_tokens: number) => toOpenAIRequest({ ...base, thinking: { type: "enabled", budget_tokens } }, "local").reasoning_effort;
    expect(at(4096)).toBe("high");
    expect(at(3000)).toBe("medium");
    expect(at(1024)).toBe("low");
    expect(at(512)).toBe("minimal");
    expect(effortFromBudget(undefined)).toBe("minimal");
  });

  it("reasoning_effort wins over a thinking budget; a disabled thinking block sends nothing", () => {
    expect(toOpenAIRequest({ ...base, reasoning_effort: "low", thinking: { type: "enabled", budget_tokens: 8000 } }, "local").reasoning_effort).toBe("low");
    expect(toOpenAIRequest({ ...base, thinking: { type: "disabled" } }, "local")).not.toHaveProperty("reasoning_effort");
  });

  it("a thinking block in the history is not sent to an OpenAI-compatible model", () => {
    const out = toOpenAIRequest({
      ...base,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "" }, { type: "text", text: "hello" }] },
      ],
    }, "local");
    expect(out.messages).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
  });
});

describe("reasoning_content → thinking", () => {
  it("a buffered completion's reasoning_content becomes a thinking block ahead of the text", () => {
    const m = toAnthropicResponse({ choices: [{ message: { reasoning_content: "let me think", content: "answer" }, finish_reason: "stop" }] }, "local");
    expect(m.content).toEqual([
      { type: "thinking", thinking: "let me think", signature: "" },
      { type: "text", text: "answer" },
    ]);
  });

  it("streamed reasoning_content deltas become a thinking block with thinking_delta frames, closed before the text starts", () => {
    const tr = createStreamTranslator("local");
    const chunk = (delta: Record<string, unknown>): string => `data: ${JSON.stringify({ choices: [{ delta }] })}\n`;
    const raw = tr.feed(chunk({ reasoning_content: "let me " }) + chunk({ reasoning_content: "think" }) + chunk({ content: "answer" }) + "data: [DONE]\n") + tr.end();
    const frames = raw.split("\n\n").filter(Boolean).map((f) => JSON.parse(f.split("\n")[1]!.slice(6)) as Record<string, unknown>);
    const kinds = frames.map((f) => `${f.type}${f.index !== undefined ? `#${f.index}` : ""}`);
    expect(kinds).toEqual([
      "message_start",
      "content_block_start#0", "content_block_delta#0", "content_block_delta#0", "content_block_stop#0",
      "content_block_start#1", "content_block_delta#1", "content_block_stop#1",
      "message_delta", "message_stop",
    ]);
    expect(frames[1]!.content_block).toEqual({ type: "thinking", thinking: "", signature: "" });
    expect(frames[2]!.delta).toEqual({ type: "thinking_delta", thinking: "let me " });
    expect(frames[6]!.delta).toEqual({ type: "text_delta", text: "answer" });
  });
});
