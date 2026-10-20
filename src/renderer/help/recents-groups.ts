/**
 * recents-groups — WORK'S LISTS GROUP BY DAY (his order, 2026-10-07): Today,
 * Yesterday, Older — in the left rail and in the agent window's recents, on
 * the app and the web. Local midnights bound the days. Pure.
 */

export type DateBucket = "Today" | "Yesterday" | "Older";
export const DATE_BUCKETS: readonly DateBucket[] = ["Today", "Yesterday", "Older"];

function midnight(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dateBucket(at: number, now = Date.now()): DateBucket {
  const today = midnight(now);
  if (at >= today) return "Today";
  if (at >= today - 86_400_000) return "Yesterday";
  return "Older";
}

/** The rows in bucket order, each bucket's rows in the order given; empty buckets are left out. */
export function groupByDate<T>(rows: readonly T[], at: (r: T) => number, now = Date.now()): Array<{ label: DateBucket; rows: T[] }> {
  const by = new Map<DateBucket, T[]>();
  for (const r of rows) {
    const b = dateBucket(at(r), now);
    const list = by.get(b) ?? [];
    list.push(r);
    by.set(b, list);
  }
  return DATE_BUCKETS.filter((b) => by.has(b)).map((b) => ({ label: b, rows: by.get(b)! }));
}
