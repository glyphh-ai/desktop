/**
 * sync/lww — the one sync rule, exhaustively: every (local state × remote state)
 * cell over {absent, live, tombstone} × {older, equal, newer}, plus duplicates,
 * partial pages and the four moves' purity.
 */

import { describe, it, expect } from "vitest";
import { reconcile, compareLww, type LwwRow } from "../../src/sync/lww.js";

interface Row extends LwwRow { data?: string }

const live = (id: string, updatedAt: number, data = `${id}@${updatedAt}`): Row => ({ id, updatedAt, deletedAt: null, data });
const dead = (id: string, updatedAt: number): Row => ({ id, updatedAt, deletedAt: new Date(updatedAt).toISOString() });
const none = { pushes: [], pulls: [], deletesLocal: [], deletesRemote: [] };

describe("compareLww", () => {
  it("strictly newer wins either way", () => {
    expect(compareLww(live("x", 2), live("x", 1))).toBe("a");
    expect(compareLww(live("x", 1), live("x", 2))).toBe("b");
    expect(compareLww(dead("x", 2), live("x", 1))).toBe("a");
    expect(compareLww(live("x", 1), dead("x", 2))).toBe("b");
  });
  it("equal clocks tie when liveness matches", () => {
    expect(compareLww(live("x", 1), live("x", 1))).toBe("tie");
    expect(compareLww(dead("x", 1), dead("x", 1))).toBe("tie");
  });
  it("equal clocks go to the tombstone", () => {
    expect(compareLww(dead("x", 1), live("x", 1))).toBe("a");
    expect(compareLww(live("x", 1), dead("x", 1))).toBe("b");
  });
});

describe("reconcile — one side only", () => {
  it("empty in, empty out", () => {
    expect(reconcile([], [])).toEqual(none);
  });
  it("a live local row the remote lacks is pushed", () => {
    const a = live("a", 5);
    expect(reconcile([a], [])).toEqual({ ...none, pushes: [a] });
  });
  it("a local tombstone the remote lacks is deleted remotely (so it is recorded there)", () => {
    expect(reconcile([dead("a", 5)], [])).toEqual({ ...none, deletesRemote: ["a"] });
  });
  it("a live remote row the local lacks is pulled", () => {
    const a = live("a", 5);
    expect(reconcile([], [a])).toEqual({ ...none, pulls: [a] });
  });
  it("a remote tombstone the local lacks is deleted locally (recorded, never resurrected)", () => {
    expect(reconcile([], [dead("a", 5)])).toEqual({ ...none, deletesLocal: ["a"] });
  });
});

describe("reconcile — both live", () => {
  it("local strictly newer → push", () => {
    const mine = live("a", 10);
    expect(reconcile([mine], [live("a", 9)])).toEqual({ ...none, pushes: [mine] });
  });
  it("remote strictly newer → pull", () => {
    const theirs = live("a", 10);
    expect(reconcile([live("a", 9)], [theirs])).toEqual({ ...none, pulls: [theirs] });
  });
  it("equal → no-op, even when the payloads differ", () => {
    expect(reconcile([live("a", 10, "mine")], [live("a", 10, "theirs")])).toEqual(none);
  });
});

describe("reconcile — tombstone vs live", () => {
  it("a local tombstone newer than the remote live row → delete remotely", () => {
    expect(reconcile([dead("a", 10)], [live("a", 9)])).toEqual({ ...none, deletesRemote: ["a"] });
  });
  it("a remote tombstone newer than the local live row → delete locally", () => {
    expect(reconcile([live("a", 9)], [dead("a", 10)])).toEqual({ ...none, deletesLocal: ["a"] });
  });
  it("a live local row strictly newer than the remote tombstone revives it (push)", () => {
    const mine = live("a", 11);
    expect(reconcile([mine], [dead("a", 10)])).toEqual({ ...none, pushes: [mine] });
  });
  it("a live remote row strictly newer than the local tombstone revives it (pull)", () => {
    const theirs = live("a", 11);
    expect(reconcile([dead("a", 10)], [theirs])).toEqual({ ...none, pulls: [theirs] });
  });
  it("equal clocks: the tombstone wins on either side", () => {
    expect(reconcile([dead("a", 10)], [live("a", 10)])).toEqual({ ...none, deletesRemote: ["a"] });
    expect(reconcile([live("a", 10)], [dead("a", 10)])).toEqual({ ...none, deletesLocal: ["a"] });
  });
  it("a stale live row never resurrects a tombstone (equal or older)", () => {
    expect(reconcile([live("a", 9)], [dead("a", 10)]).pushes).toEqual([]);
    expect(reconcile([live("a", 10)], [dead("a", 10)]).pushes).toEqual([]);
    expect(reconcile([dead("a", 10)], [live("a", 9)]).pulls).toEqual([]);
    expect(reconcile([dead("a", 10)], [live("a", 10)]).pulls).toEqual([]);
  });
});

describe("reconcile — both tombstones", () => {
  it("is a no-op whatever the clocks", () => {
    expect(reconcile([dead("a", 9)], [dead("a", 10)])).toEqual(none);
    expect(reconcile([dead("a", 10)], [dead("a", 9)])).toEqual(none);
    expect(reconcile([dead("a", 10)], [dead("a", 10)])).toEqual(none);
  });
});

describe("reconcile — sets", () => {
  it("handles every cell at once, keeping local order then remote-only order", () => {
    const local = [live("push", 5), live("pull", 1), live("dl", 1), dead("dr", 5), live("same", 3), live("mineOnly", 1), dead("deadOnly", 2)];
    const remote = [live("push", 4), live("pull", 2), dead("dl", 2), live("dr", 4), live("same", 3), live("theirsOnly", 1), dead("theirsDead", 2)];
    expect(reconcile(local, remote)).toEqual({
      pushes: [local[0], local[5]],
      pulls: [remote[1], remote[5]],
      deletesLocal: ["dl", "theirsDead"],
      deletesRemote: ["dr", "deadOnly"],
    });
  });

  it("a duplicated id on one side keeps its winning state", () => {
    const newest = live("a", 7);
    expect(reconcile([live("a", 3), newest, live("a", 5)], [live("a", 6)])).toEqual({ ...none, pushes: [newest] });
    expect(reconcile([live("a", 6)], [live("a", 7), dead("a", 7)])).toEqual({ ...none, deletesLocal: ["a"] });
  });

  it("treats a partial page as unknown, not deleted: a since-list never implies the rest is gone", () => {
    const cached = [live("a", 1), live("b", 1)];
    const changedSince = [live("b", 2)];
    expect(reconcile(cached, changedSince)).toEqual({ ...none, pushes: [cached[0]], pulls: [changedSince[0]] });
  });

  it("is pure: inputs are not mutated and outputs reference the given rows", () => {
    const mine = live("a", 10);
    const theirs = live("b", 10);
    const local = [mine];
    const remote = [theirs];
    const out = reconcile(local, remote);
    expect(local).toEqual([mine]);
    expect(remote).toEqual([theirs]);
    expect(out.pushes[0]).toBe(mine);
    expect(out.pulls[0]).toBe(theirs);
  });

  it("carries any row type through unchanged (generic over the LWW facts)", () => {
    const row = { id: "a", updatedAt: 1, deletedAt: null, kind: "skill", data: { name: "x" } };
    expect(reconcile([row], []).pushes[0]).toBe(row);
  });
});
