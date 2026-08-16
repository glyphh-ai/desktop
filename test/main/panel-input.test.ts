/**
 * Pure-unit coverage for the client-input → CDP mapping (panel-input.ts) — the
 * seam the "can type but can't backspace" bug lived in: a dispatched key event
 * without a windowsVirtualKeyCode is a dead letter to Chromium's editor, so
 * every special key must map to its VK code, and committed text must ride
 * Input.insertText.
 */
import { describe, it, expect } from "vitest";
import { toCdp, vkFor, clampDim, type InputEvent } from "../../src/main/panel-input.js";

describe("vkFor", () => {
  it("maps the editing/navigation keys to their Windows virtual-key codes", () => {
    expect(vkFor("Backspace")).toBe(8);
    expect(vkFor("Tab")).toBe(9);
    expect(vkFor("Enter")).toBe(13);
    expect(vkFor("Escape")).toBe(27);
    expect(vkFor(" ")).toBe(32);
    expect(vkFor("PageUp")).toBe(33);
    expect(vkFor("PageDown")).toBe(34);
    expect(vkFor("End")).toBe(35);
    expect(vkFor("Home")).toBe(36);
    expect(vkFor("ArrowLeft")).toBe(37);
    expect(vkFor("ArrowUp")).toBe(38);
    expect(vkFor("ArrowRight")).toBe(39);
    expect(vkFor("ArrowDown")).toBe(40);
    expect(vkFor("Delete")).toBe(46);
  });
  it("maps modifiers, letters, digits and F-keys", () => {
    expect(vkFor("Shift")).toBe(16);
    expect(vkFor("Control")).toBe(17);
    expect(vkFor("Alt")).toBe(18);
    expect(vkFor("Meta")).toBe(91);
    expect(vkFor("a")).toBe(65);
    expect(vkFor("Z")).toBe(90);
    expect(vkFor("0")).toBe(48);
    expect(vkFor("9")).toBe(57);
    expect(vkFor("F1")).toBe(112);
    expect(vkFor("F12")).toBe(123);
  });
  it("returns 0 for punctuation (text carries it) and junk", () => {
    expect(vkFor(".")).toBe(0);
    expect(vkFor("F13")).toBe(0);
    expect(vkFor("")).toBe(0);
    expect(vkFor(undefined)).toBe(0);
  });
});

describe("toCdp: key events", () => {
  it("Backspace down is a rawKeyDown carrying VK 8 (the web backspace bug)", () => {
    const cmd = toCdp({ type: "key", action: "down", key: "Backspace", code: "Backspace", text: "", mods: 0 });
    expect(cmd).toEqual({
      method: "Input.dispatchKeyEvent",
      params: { type: "rawKeyDown", modifiers: 0, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
    });
  });
  it("Enter down carries \\r text (or an editable gets the keystroke, no newline)", () => {
    const cmd = toCdp({ type: "key", action: "down", key: "Enter", code: "Enter", mods: 0 });
    expect(cmd?.params).toMatchObject({ type: "keyDown", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13 });
  });
  it("a printable down keeps its text and gains the letter's VK code", () => {
    const cmd = toCdp({ type: "key", action: "down", key: "a", code: "KeyA", text: "a", mods: 0 });
    expect(cmd?.params).toMatchObject({ type: "keyDown", text: "a", unmodifiedText: "a", windowsVirtualKeyCode: 65 });
  });
  it("keyUp carries the VK code too", () => {
    const cmd = toCdp({ type: "key", action: "up", key: "ArrowLeft", code: "ArrowLeft", mods: 0 });
    expect(cmd?.params).toMatchObject({ type: "keyUp", windowsVirtualKeyCode: 37 });
  });
  it("a Ctrl/Meta chord never types its letter and Cmd/Ctrl+A selects all", () => {
    const meta = toCdp({ type: "key", action: "down", key: "a", code: "KeyA", text: "a", mods: 4 });
    expect(meta?.params).toMatchObject({ type: "rawKeyDown", modifiers: 4, commands: ["selectAll"] });
    expect(meta?.params.text).toBeUndefined();
    const ctrl = toCdp({ type: "key", action: "down", key: "z", code: "KeyZ", text: "z", mods: 2 });
    expect(ctrl?.params).toMatchObject({ type: "rawKeyDown" });
    expect(ctrl?.params.text).toBeUndefined();
    expect(ctrl?.params.commands).toBeUndefined();
  });
  it("drops a malformed action", () => {
    expect(toCdp({ type: "key", action: "boop" } as unknown as InputEvent)).toBeNull();
  });
});

describe("toCdp: insertText", () => {
  it("maps committed text onto Input.insertText", () => {
    expect(toCdp({ type: "insertText", text: "héllo 👋" })).toEqual({ method: "Input.insertText", params: { text: "héllo 👋" } });
  });
  it("drops empty/malformed text", () => {
    expect(toCdp({ type: "insertText", text: "" })).toBeNull();
    expect(toCdp({ type: "insertText" } as unknown as InputEvent)).toBeNull();
  });
});

describe("toCdp: unchanged paths still hold", () => {
  it("mouse and wheel map as before", () => {
    expect(toCdp({ type: "mouse", action: "down", x: 10, y: 20, button: "left", buttons: 1, mods: 0, clickCount: 1 })?.method).toBe("Input.dispatchMouseEvent");
    expect(toCdp({ type: "wheel", x: 1, y: 2, dx: 0, dy: -30 })?.params).toMatchObject({ type: "mouseWheel", deltaY: -30 });
  });
  it("resize stays a non-command and clampDim still bounds", () => {
    expect(toCdp({ type: "resize", width: 100, height: 100 })).toBeNull();
    expect(clampDim(99999, 800)).toBe(4096);
  });
});
