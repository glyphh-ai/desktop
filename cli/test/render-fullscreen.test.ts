/**
 * The line-diff renderer: Ink's erase-prefixed frames become rows; only the
 * rows that changed are rewritten, each at its absolute position; vanished
 * rows are cleared; the first frame and a resize repaint everything; and
 * cursor show/hide passes through while an erase-only write is swallowed.
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { createFullscreenStdout, diffWrites, frameRows } from "../src/render/fullscreen.js";

const E = "\u001b";
const eraseLines = (n: number): string => `${E}[2K${E}[1A`.repeat(Math.max(0, n - 1)) + (n ? `${E}[2K${E}[G` : "");

describe("frameRows", () => {
  it("strips Ink's erase prefix and the trailing newline", () => {
    expect(frameRows(`${eraseLines(3)}a\nb\nc\n`)).toEqual(["a", "b", "c"]);
    expect(frameRows(`${E}[2J${E}[3J${E}[H` + "x\ny\n")).toEqual(["x", "y"]);
    expect(frameRows("only\n")).toEqual(["only"]);
  });
});

describe("diffWrites", () => {
  it("rewrites only changed rows, at their positions, inside one synchronized update", () => {
    const w = diffWrites(["a", "b", "c"], ["a", "B", "c"], 10, false);
    expect(w.startsWith(`${E}[?2026h`)).toBe(true);
    expect(w.endsWith(`${E}[?2026l`)).toBe(true);
    expect(w).toContain(`${E}[2;1HB${E}[0m${E}[K`);
    expect(w).not.toContain(`${E}[1;1Ha`);
    expect(w).not.toContain(`${E}[3;1Hc`);
    expect(w).not.toContain(`${E}[2J`);
  });
  it("clears rows the new frame no longer has, and never writes past the terminal height", () => {
    const w = diffWrites(["a", "b", "c", "d"], ["a"], 3, false);
    expect(w).toContain(`${E}[2;1H${E}[2K`);
    expect(w).toContain(`${E}[3;1H${E}[2K`);
    expect(w).not.toContain(`${E}[4;1H`);
  });
  it("a full paint clears the screen and writes every row", () => {
    const w = diffWrites(["a"], ["a", "b"], 5, true);
    expect(w).toContain(`${E}[2J`);
    expect(w).toContain(`${E}[1;1Ha`);
    expect(w).toContain(`${E}[2;1Hb`);
  });
});

describe("createFullscreenStdout", () => {
  function fake(rows = 6): { stream: NodeJS.WriteStream; writes: string[] } {
    const em = new EventEmitter() as unknown as NodeJS.WriteStream;
    const writes: string[] = [];
    Object.assign(em, { rows, columns: 80, isTTY: true, write: (s: string) => { writes.push(s); return true; } });
    return { stream: em, writes };
  }
  it("paints the first frame whole, then diffs; passes cursor sequences; swallows a bare erase", () => {
    const { stream, writes } = fake();
    const out = createFullscreenStdout(stream);
    out.write(`${E}[?25l`);
    expect(writes.pop()).toBe(`${E}[?25l`);
    out.write("one\ntwo\n");
    expect(writes.pop()).toContain(`${E}[2J`);
    out.write(`${eraseLines(3)}one\nTWO\n`);
    const second = writes.pop()!;
    expect(second).not.toContain(`${E}[2J`);
    expect(second).toContain(`${E}[2;1HTWO`);
    expect(second).not.toContain(`${E}[1;1Hone`);
    out.write(eraseLines(3));
    expect(writes.length).toBe(0);
    // A resize repaints everything on the next frame.
    (stream as unknown as EventEmitter).emit("resize");
    out.write(`${eraseLines(3)}one\nTWO\n`);
    expect(writes.pop()).toContain(`${E}[2J`);
  });
});
