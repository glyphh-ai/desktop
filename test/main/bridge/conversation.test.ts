import { describe, it, expect } from "vitest";
import { askText, matchTranscript, openingKey, parseAnswer, seedPrompt, summarizeInput, systemTextOf, turnsOf } from "../../../src/main/bridge/conversation.js";

const U = (text: string) => ({ role: "user" as const, text });
const A = (text: string) => ({ role: "assistant" as const, text });

describe("transcript shape", () => {
  it("reads text out of string and block content and ignores the rest", () => {
    const turns = turnsOf([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "tool_use", name: "x" }] },
      { role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "look " }] },
      { role: "system", content: "nope" },
    ]);
    expect(turns).toEqual([U("hi"), A("hello"), U("look")]);
    expect(systemTextOf([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(systemTextOf("s")).toBe("s");
  });

  it("buckets a conversation by its opening message", () => {
    expect(openingKey([U("hi"), A("x")])).toBe(openingKey([U("hi"), A("y"), U("z")]));
    expect(openingKey([U("hi")])).not.toBe(openingKey([U("hello")]));
  });
});

describe("matching a transcript to a session", () => {
  it("continues when everything before the new user turn is what the session saw", () => {
    const s = { turns: [U("hi"), A("hello")], parkedAsk: null };
    expect(matchTranscript(s, [U("hi"), A("hello"), U("next")])).toEqual({ kind: "continue" });
  });
  it("forks on an edited or regenerated history, and when the last turn is not the user's", () => {
    const s = { turns: [U("hi"), A("hello")], parkedAsk: null };
    expect(matchTranscript(s, [U("hi"), A("hello!"), U("next")])).toEqual({ kind: "fork" });
    expect(matchTranscript(s, [U("hi"), A("hello")])).toEqual({ kind: "fork" });
    expect(matchTranscript(s, [U("hi"), U("next")])).toEqual({ kind: "fork" });
  });
  it("reads the reply to a parked ask as the answer", () => {
    const ask = askText("Bash", "rm -rf build");
    const s = { turns: [U("clean the build")], parkedAsk: ask };
    expect(matchTranscript(s, [U("clean the build"), A(ask), U("allow")])).toEqual({ kind: "answer", answer: "allow" });
    expect(matchTranscript(s, [U("clean the build"), A(ask), U("Always.")])).toEqual({ kind: "answer", answer: "always" });
    expect(matchTranscript(s, [U("clean the build"), A(ask), U("no")])).toEqual({ kind: "answer", answer: "deny" });
    expect(matchTranscript(s, [U("clean the build"), A(ask), U("actually just list it")])).toEqual({ kind: "answer", answer: null });
    expect(matchTranscript(s, [U("clean the build"), A("something else"), U("allow")])).toEqual({ kind: "fork" });
  });
});

describe("asks", () => {
  it("parses plain replies, nothing else", () => {
    expect(parseAnswer(" Allow ")).toBe("allow");
    expect(parseAnswer("yes!")).toBe("allow");
    expect(parseAnswer("go ahead")).toBe("allow");
    expect(parseAnswer("deny")).toBe("deny");
    expect(parseAnswer("don't")).toBe("deny");
    expect(parseAnswer("always")).toBe("always");
    expect(parseAnswer("allow, but only this once and then stop")).toBeNull();
    expect(parseAnswer("")).toBeNull();
  });
  it("words every ask the same way and names the tool and what it wants", () => {
    const t = askText("Bash", "rm -rf   build\n");
    expect(t).toBe("Claude Code wants to run `Bash`: rm -rf build.\nReply **allow**, **deny**, or **always** (allow for the rest of this conversation).");
    expect(summarizeInput({ command: "ls -la" })).toBe("ls -la");
    expect(summarizeInput({ file_path: "/tmp/x" })).toBe("/tmp/x");
    expect(summarizeInput({ weird: 1 })).toBe('{"weird":1}');
    expect(summarizeInput(null)).toBe("");
  });
  it("seeds a fresh session with the history the CLI never saw", () => {
    expect(seedPrompt([U("only")])).toBe("only");
    expect(seedPrompt([U("a"), A("b"), U("c")])).toBe("The conversation so far (continue it, do not repeat it):\n\nUser: a\n\nAssistant: b\n\nUser: c");
  });
});
