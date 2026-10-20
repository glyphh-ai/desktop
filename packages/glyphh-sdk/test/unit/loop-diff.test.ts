/**
 * WHAT A FILE CHANGE CHANGED (his order, 2026-09-29: "+ adds green, - removes
 * red, foldable… way more robust viewing").
 */
import { describe, it, expect } from "vitest";
import { lineDiff } from "../../src/loop/diff.js";

const lines = (n: number, tag = "l") => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join("\n") + "\n";

describe("lineDiff", () => {
  it("a new file is every line added, numbered from 1", () => {
    const d = lineDiff("", "a\nb\nc\n");
    expect(d).toMatchObject({ added: 3, removed: 0, truncated: false });
    expect(d.hunks).toEqual([{ oldStart: 1, newStart: 1, lines: [{ t: "+", s: "a" }, { t: "+", s: "b" }, { t: "+", s: "c" }] }]);
  });

  it("a one-line change in a long file is ONE hunk with its context and real line numbers", () => {
    const before = lines(40);
    const after = before.replace("l20\n", "changed\n");
    const d = lineDiff(before, after, 3);
    expect(d).toMatchObject({ added: 1, removed: 1 });
    expect(d.hunks).toHaveLength(1);
    const h = d.hunks[0]!;
    expect(h.oldStart).toBe(17);
    expect(h.newStart).toBe(17);
    expect(h.lines.map((l) => `${l.t}${l.s}`)).toEqual([" l17", " l18", " l19", "-l20", "+changed", " l21", " l22", " l23"]);
  });

  it("inside a replaced block, unchanged lines stay unchanged (not ten reds and ten greens)", () => {
    const d = lineDiff("a\nb\nc\nd\ne\n", "a\nb\nX\nd\ne\n", 0);
    expect(d.hunks.flatMap((h) => h.lines).map((l) => `${l.t}${l.s}`)).toEqual(["-c", "+X"]);
  });

  it("far-apart changes are separate hunks; near ones merge", () => {
    const before = lines(60);
    const far = before.replace("l5\n", "A\n").replace("l50\n", "B\n");
    expect(lineDiff(before, far, 3).hunks).toHaveLength(2);
    const near = before.replace("l5\n", "A\n").replace("l9\n", "B\n");
    expect(lineDiff(before, near, 3).hunks).toHaveLength(1);
  });

  it("keeps exact counts but caps the lines it carries", () => {
    const d = lineDiff("", lines(1000), 3, 400);
    expect(d.added).toBe(1000);
    expect(d.truncated).toBe(true);
    expect(d.hunks.flatMap((h) => h.lines)).toHaveLength(400);
  });

  it("no change is no hunks", () => {
    expect(lineDiff("same\n", "same\n")).toEqual({ hunks: [], added: 0, removed: 0, truncated: false });
  });
});
