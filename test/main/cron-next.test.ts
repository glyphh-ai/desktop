import { describe, expect, it } from "vitest";
import { cronNext, cronSets, deviceZone, isZone } from "../../src/renderer/help/cron-next";

const next = (expr: string, from: string, tz: string): string | null => cronNext(expr, new Date(from), tz)?.toISOString() ?? null;

describe("cron-next — the Schedules page's next, read on the member's zone", () => {
  it("parses the five fields and refuses what is not one", () => {
    expect(cronSets("0 9 * * 1-5")?.map((s) => s.size)).toEqual([1, 1, 31, 12, 5]);
    expect(cronSets("*/15 * * * 7")?.[4]).toEqual(new Set([0]));
    for (const bad of ["", "* * * *", "a * * * *", "60 * * * *", "* * * * 8", "5-3 * * * *", "*/0 * * * *"]) expect(cronSets(bad), bad).toBeNull();
    expect(cronNext("nonsense", new Date(), "UTC")).toBeNull();
  });

  it("reads '0 8 * * 1-5' as 08:00 in the zone, strictly after from", () => {
    // Monday 2026-10-05 14:00Z: Chicago's 08:00 CDT (13:00Z) is past, Tuesday's is next.
    expect(next("0 8 * * 1-5", "2026-10-05T14:00:00Z", "America/Chicago")).toBe("2026-10-06T13:00:00.000Z");
    expect(next("0 8 * * 1-5", "2026-10-05T14:00:00Z", "Asia/Tokyo")).toBe("2026-10-05T23:00:00.000Z");
    expect(next("0 8 * * 1-5", "2026-10-05T14:00:00Z", "UTC")).toBe("2026-10-06T08:00:00.000Z");
    expect(next("0 8 * * 1-5", "2026-10-09T23:30:00Z", "America/Chicago")).toBe("2026-10-12T13:00:00.000Z");
    expect(next("0 14 * * *", "2026-10-05T14:00:00Z", "UTC")).toBe("2026-10-06T14:00:00.000Z");
    expect(next("0 0 13 * *", "2026-10-05T14:00:00Z", "UTC")).toBe("2026-10-13T00:00:00.000Z");
  });

  it("never fires a wall minute the clock skips (spring forward)", () => {
    // 2026-03-08 02:00 CST -> 03:00 CDT: Chicago has no 02:30 that Sunday.
    expect(next("30 2 * * *", "2026-03-07T09:00:00Z", "America/Chicago")).toBe("2026-03-09T07:30:00.000Z");
    expect(next("30 3 * * *", "2026-03-07T10:00:00Z", "America/Chicago")).toBe("2026-03-08T08:30:00.000Z");
  });

  it("fires a repeated hour once unless the schedule runs every hour (fall back)", () => {
    // 2026-11-01 02:00 CDT -> 01:00 CST: 01:30 happens at 06:30Z and again at 07:30Z.
    expect(next("30 1 * * *", "2026-11-01T05:00:00Z", "America/Chicago")).toBe("2026-11-01T06:30:00.000Z");
    expect(next("30 1 * * *", "2026-11-01T06:30:00Z", "America/Chicago")).toBe("2026-11-02T07:30:00.000Z");
    expect(next("30 * * * *", "2026-11-01T06:30:00Z", "America/Chicago")).toBe("2026-11-01T07:30:00.000Z");
  });

  it("answers null when the date never comes, and knows a zone from a typo", () => {
    expect(next("0 0 30 2 *", "2026-01-01T00:00:00Z", "America/Chicago")).toBeNull();
    expect(isZone("America/Chicago")).toBe(true);
    expect(isZone("Nowhere/Town")).toBe(false);
    expect(isZone(deviceZone())).toBe(true);
  });
});
