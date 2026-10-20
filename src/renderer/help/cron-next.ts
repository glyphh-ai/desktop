/**
 * cron-next.ts — when a five-field cron fires next, read on the member's
 * zone (Settings › Account): the one clock the cloud clock, a pod's cron and
 * this desktop's node-cron read it on, so the Schedules page's "next" names
 * the minute that actually fires. Daylight saving on that clock: a wall
 * minute it skips never fires; an hour it repeats fires a schedule once
 * unless the hour field is `*`. Pure; zones through Intl.
 */

const MINUTE_MS = 60_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SEARCH_LIMIT_DAYS = 366;

/** True when `name` is a zone Intl knows (an IANA name, or "UTC"). */
export function isZone(name: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return true; } catch { return false; }
}

/** The zone this device runs on — the page's clock until the profile answers. */
export function deviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Parse a five-field cron into per-field membership sets. Null = invalid. */
export function cronSets(cron: string): Array<Set<number>> | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const out: Array<Set<number>> = [];
  for (let i = 0; i < 5; i++) {
    const [lo, hi] = ranges[i]!;
    const set = new Set<number>();
    for (const piece of parts[i]!.split(",")) {
      const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(piece);
      if (!m) return null;
      const step = m[3] ? parseInt(m[3], 10) : 1;
      const a = m[1] === "*" ? lo : parseInt(m[1]!, 10);
      const b = m[1] === "*" ? hi : m[2] ? parseInt(m[2], 10) : a;
      if (step < 1 || a < lo || b > hi || a > b) return null;
      for (let v = a; v <= b; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    out.push(set);
  }
  return out;
}

/** One instant as a zone's wall clock reads it. */
interface Wall { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

function wallOf(ms: number, tz: string): Wall {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: WEEKDAYS.indexOf(parts.weekday ?? ""),
  };
}

/** The instant a wall time names in `tz` (day and hour may overflow, as in
 *  Date.UTC). Inside a gap the clock skips the answer is an instant near it;
 *  the walk re-reads the wall clock on every step and moves on. */
function instantOf(tz: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (ms: number): number => {
    const w = wallOf(ms, tz);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - ms;
  };
  return asUtc - offsetAt(asUtc - offsetAt(asUtc));
}

/** The second pass of an hour the clock repeats: an hour earlier it read the same. */
function repeatedHour(ms: number, w: Wall, tz: string): boolean {
  const earlier = wallOf(ms - 60 * MINUTE_MS, tz);
  return earlier.day === w.day && earlier.hour === w.hour && earlier.minute === w.minute;
}

/** The next minute strictly after `from` that `cron` names on the `tz` wall
 *  clock, or null when it never does within a year (or does not parse).
 *  Every jump is clamped forward, so a clock change at midnight cannot stall it. */
export function cronNext(cron: string, from: Date, tz: string): Date | null {
  const sets = cronSets(cron);
  if (!sets) return null;
  const [mins, hours, doms, mons, dows] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  let t = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = from.getTime() + SEARCH_LIMIT_DAYS * 24 * 60 * MINUTE_MS;
  while (t <= limit) {
    const w = wallOf(t, tz);
    if (!mons.has(w.month) || !doms.has(w.day) || !dows.has(w.weekday)) {
      t = Math.max(instantOf(tz, w.year, w.month, w.day + 1, 0, 0), t + MINUTE_MS);
      continue;
    }
    if (!hours.has(w.hour)) {
      t = Math.max(instantOf(tz, w.year, w.month, w.day, w.hour + 1, 0), t + MINUTE_MS);
      continue;
    }
    if (!mins.has(w.minute) || (hours.size < 24 && repeatedHour(t, w, tz))) { t += MINUTE_MS; continue; }
    return new Date(t);
  }
  return null;
}
