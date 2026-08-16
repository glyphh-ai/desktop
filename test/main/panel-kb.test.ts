/**
 * Pure-unit coverage for the shared streamed-panel keyboard capture
 * (src/renderer/panel-kb.ts): the keydown/beforeinput decisions both surfaces
 * (web canvas + mobile tray) route through, and the paste chunking. No DOM —
 * the mounting shell is thin; the decisions are where the behavior lives.
 */
import { describe, it, expect } from "vitest";
import { decideKeydown, decideBeforeinput, chunkText, modBits } from "../../src/renderer/panel-kb.js";

const key = (k: string, o: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...o });

describe("decideKeydown", () => {
  it("forwards printable keys with their character", () => {
    expect(decideKeydown(key("a"))).toEqual({ kind: "forward", text: "a" });
    expect(decideKeydown(key(" "))).toEqual({ kind: "forward", text: " " });
  });
  it("forwards special keys by NAME with no text (Backspace/Enter/arrows)", () => {
    expect(decideKeydown(key("Backspace"))).toEqual({ kind: "forward", text: "" });
    expect(decideKeydown(key("Enter"))).toEqual({ kind: "forward", text: "" });
    expect(decideKeydown(key("ArrowDown"))).toEqual({ kind: "forward", text: "" });
  });
  it("routes Cmd/Ctrl+C/X to the clipboard round-trip, not keystrokes", () => {
    expect(decideKeydown(key("c", { metaKey: true }))).toEqual({ kind: "clipboard", action: "copy" });
    expect(decideKeydown(key("x", { ctrlKey: true }))).toEqual({ kind: "clipboard", action: "cut" });
  });
  it("lets Cmd/Ctrl+V fall through to the native paste event", () => {
    expect(decideKeydown(key("v", { metaKey: true }))).toEqual({ kind: "paste" });
    expect(decideKeydown(key("v", { ctrlKey: true }))).toEqual({ kind: "paste" });
  });
  it("a chord letter forwards WITHOUT its character (Cmd+A must not type 'a')", () => {
    expect(decideKeydown(key("a", { metaKey: true }))).toEqual({ kind: "forward", text: "" });
  });
  it("Alt chords still type (Option-composed characters)", () => {
    expect(decideKeydown(key("ç", { altKey: true }))).toEqual({ kind: "forward", text: "ç" });
    expect(decideKeydown(key("v", { metaKey: true, altKey: true }))).toEqual({ kind: "forward", text: "" });
  });
  it("soft-keyboard/IME noise is left to beforeinput", () => {
    expect(decideKeydown(key("Unidentified"))).toEqual({ kind: "ime" });
    expect(decideKeydown(key("Process"))).toEqual({ kind: "ime" });
    expect(decideKeydown(key("Dead"))).toEqual({ kind: "ime" });
    expect(decideKeydown(key("a", { isComposing: true }))).toEqual({ kind: "ime" });
  });
});

describe("decideBeforeinput", () => {
  it("commits typed/autocorrected/pasted text", () => {
    expect(decideBeforeinput("insertText", "h", false)).toEqual({ kind: "text", text: "h" });
    expect(decideBeforeinput("insertReplacementText", "hello", false)).toEqual({ kind: "text", text: "hello" });
    expect(decideBeforeinput("insertFromPaste", "pasted", false)).toEqual({ kind: "text", text: "pasted" });
  });
  it("maps delete/newline intents onto their named keys (iOS fires no keydown)", () => {
    expect(decideBeforeinput("deleteContentBackward", "", false)).toEqual({ kind: "key", key: "Backspace", code: "Backspace" });
    expect(decideBeforeinput("deleteContentForward", "", false)).toEqual({ kind: "key", key: "Delete", code: "Delete" });
    expect(decideBeforeinput("insertLineBreak", "", false)).toEqual({ kind: "key", key: "Enter", code: "Enter" });
    expect(decideBeforeinput("insertParagraph", "", false)).toEqual({ kind: "key", key: "Enter", code: "Enter" });
  });
  it("stays silent mid-composition (compositionend commits) and on unknowns", () => {
    expect(decideBeforeinput("insertCompositionText", "か", false)).toEqual({ kind: "none" });
    expect(decideBeforeinput("insertText", "か", true)).toEqual({ kind: "none" });
    expect(decideBeforeinput("historyUndo", "", false)).toEqual({ kind: "none" });
    expect(decideBeforeinput("insertText", "", false)).toEqual({ kind: "none" });
  });
});

describe("chunkText (paste batching)", () => {
  it("keeps a small paste as one piece and splits a big one in order", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
    expect(chunkText("abcdef", 4)).toEqual(["abcd", "ef"]);
    expect(chunkText("a".repeat(8192 + 1))).toEqual(["a".repeat(8192), "a"]);
  });
  it("produces nothing for empty text", () => {
    expect(chunkText("")).toEqual([]);
  });
});

describe("modBits", () => {
  it("assembles the CDP bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8)", () => {
    expect(modBits({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(0);
    expect(modBits({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(modBits({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: true })).toBe(10);
  });
});
