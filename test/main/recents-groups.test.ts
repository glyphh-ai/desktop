import { describe, expect, it } from "vitest";
import { dateBucket, groupByDate } from "../../src/renderer/help/recents-groups.js";

const now = new Date(2026, 9, 7, 15, 30).getTime();   // 2026-10-07 15:30 local
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();

describe("Work's lists group by day (his order, 2026-10-07)", () => {
  it("today, yesterday, older — by local midnights", () => {
    expect(dateBucket(at(2026, 9, 7, 0), now)).toBe("Today");
    expect(dateBucket(at(2026, 9, 7, 15), now)).toBe("Today");
    expect(dateBucket(at(2026, 9, 6, 23), now)).toBe("Yesterday");
    expect(dateBucket(at(2026, 9, 6, 0), now)).toBe("Yesterday");
    expect(dateBucket(at(2026, 9, 5, 23), now)).toBe("Older");
    expect(dateBucket(0, now)).toBe("Older");
  });
  it("groups in Today / Yesterday / Older order, keeps each bucket's order, drops empty buckets", () => {
    const rows = [{ id: "a", t: at(2026, 9, 5) }, { id: "b", t: at(2026, 9, 7) }, { id: "c", t: at(2026, 9, 6) }, { id: "d", t: at(2026, 9, 7, 9) }];
    expect(groupByDate(rows, (r) => r.t, now).map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ["Today", ["b", "d"]], ["Yesterday", ["c"]], ["Older", ["a"]],
    ]);
    expect(groupByDate([{ id: "x", t: at(2026, 9, 7) }], (r) => r.t, now).map((g) => g.label)).toEqual(["Today"]);
    expect(groupByDate([], () => 0, now)).toEqual([]);
  });
});
