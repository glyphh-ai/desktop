import { describe, it, expect } from "vitest";
import { repairChatStore } from "../../src/main/chat-store-repair.js";

const m = (role: string, text: string, at?: number) => (at === undefined ? { role, text } : { role, text, at });

describe("repairChatStore — a transcript appended to itself collapses to its real messages", () => {
  it("drops copies of a message (same role, text, timestamp) and reports the old length per thread", () => {
    const turn = [m("user", "this is a test", 1), m("assistant", "Hello!", 2)];
    const looped = { id: "a", messages: [...turn, ...turn, ...turn, ...turn] };
    const fine = { id: "b", messages: [m("user", "hi", 5), m("assistant", "hey", 6)] };
    const r = repairChatStore([looped, fine]);
    expect(r.chats[0].messages).toEqual(turn);
    expect(r.chats[1]).toBe(fine);
    expect(r.repaired).toEqual({ a: 8 });
  });
  it("two real messages with the same words but different timestamps both stay", () => {
    const r = repairChatStore([{ id: "a", messages: [m("user", "again", 1), m("assistant", "ok", 2), m("user", "again", 3), m("assistant", "ok", 4)] }]);
    expect(r.chats[0].messages).toHaveLength(4);
    expect(r.repaired).toEqual({});
  });
  it("tool rows with the same text but different tool payloads are distinct; empty and one-message threads are untouched", () => {
    const r = repairChatStore([
      { id: "t", messages: [{ role: "assistant", text: "✓ grep", at: 1, tool: { n: 1 } }, { role: "assistant", text: "✓ grep", at: 1, tool: { n: 2 } }] },
      { id: "e", messages: [] }, { id: "o", messages: [m("user", "x", 1)] }, { id: "n" },
    ]);
    expect(r.chats[0].messages).toHaveLength(2);
    expect(r.repaired).toEqual({});
  });
});

import { mergeChats, boundMessages, MAX_THREAD_MESSAGES, withoutRetiredThreads } from "../../src/main/chat-store-repair.js";

describe("mergeChats — a saver's stub never erases a stored transcript, and every transcript is bounded", () => {
  const have = [{ id: "a", updatedAt: 10, messages: [m("user", "hi", 1), m("assistant", "hey", 2)] }, { id: "b", updatedAt: 5, messages: [m("user", "b", 1)] }];
  it("a newer row with no messages keeps the stored messages; a newer row with messages replaces them", () => {
    const out = mergeChats(have, [{ id: "a", updatedAt: 99, messages: [] }, { id: "b", updatedAt: 9, messages: [m("user", "b2", 3)] }]);
    expect(out.find((c) => c.id === "a")!.messages).toHaveLength(2);
    expect(out.find((c) => c.id === "a")!.updatedAt).toBe(99);
    expect(out.find((c) => c.id === "b")!.messages).toEqual([m("user", "b2", 3)]);
  });
  it("an older row loses; a deleted id is dropped; a chat only the store knows survives; the saver's order leads", () => {
    const out = mergeChats(have, [{ id: "b", updatedAt: 1, messages: [] }, { id: "c", updatedAt: 7, messages: [] }], new Set(["a"]));
    expect(out.map((c) => c.id)).toEqual(["b", "c"]);
    expect(out[0].messages).toHaveLength(1);
  });
  it("a looped transcript collapses and a long one keeps its tail within the cap", () => {
    const turn = [m("user", "x", 1), m("assistant", "y", 2)];
    const looped = Array.from({ length: 50 }, () => turn).flat();
    expect(boundMessages(looped)).toEqual(turn);
    const long = Array.from({ length: MAX_THREAD_MESSAGES + 10 }, (_, i) => m("user", `n${i}`, i));
    const b = boundMessages(long);
    expect(b).toHaveLength(MAX_THREAD_MESSAGES);
    expect(b[0]).toEqual(m("user", "n10", 10));
    expect(mergeChats([], [{ id: "z", updatedAt: 1, messages: looped }])[0].messages).toEqual(turn);
  });
});

describe("withoutRetiredThreads — the gone Bots panel's threads stay on disk, hidden", () => {
  it("drops every bots/<slug> thread from what the store hands out and keeps the rest in order", () => {
    const chats = [{ id: "a" }, { id: "bots/orchestrator" }, { id: "b" }, { id: "bots/scout" }, { id: "robots/x" }];
    expect(withoutRetiredThreads(chats).map((c) => c.id)).toEqual(["a", "b", "robots/x"]);
  });
  it("a save never erases one: the stored copy survives a merge that does not list it", () => {
    const have = [{ id: "bots/scout", updatedAt: 1, messages: [m("user", "hi", 1)] }, { id: "a", updatedAt: 1, messages: [] }];
    const out = mergeChats(have, withoutRetiredThreads(have));
    expect(out.map((c) => c.id)).toEqual(["a", "bots/scout"]);
    expect(out[1].messages).toHaveLength(1);
  });
});
