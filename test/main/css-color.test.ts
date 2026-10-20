import { describe, expect, it } from "vitest";
import { cssColorToHex, rgbToHex } from "../../src/renderer/help/css-color";

describe("css-color — every colour xterm sees is #rrggbb (his report, 2026-10-05)", () => {
  it("packs bytes, clamped and rounded", () => {
    expect(rgbToHex(0, 0, 0)).toBe("#000000");
    expect(rgbToHex(255, 128, 1)).toBe("#ff8001");
    expect(rgbToHex(300, -4, 127.6)).toBe("#ff0080");
  });

  it("passes hex through, lower-cased, and expands short hex", () => {
    expect(cssColorToHex("#A855F7", "#000000")).toBe("#a855f7");
    expect(cssColorToHex("  #1e1e1e ", "#000000")).toBe("#1e1e1e");
    expect(cssColorToHex("#abc", "#000000")).toBe("#aabbcc");
  });

  it("falls back when there is nothing to paint with (no document here)", () => {
    expect(cssColorToHex("oklch(0.13 0.028 261.692)", "#1e1e1e")).toBe("#1e1e1e");
    expect(cssColorToHex("", "#d4d4d4")).toBe("#d4d4d4");
  });
});
