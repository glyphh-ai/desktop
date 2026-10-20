/**
 * landing-greeting.ts — THE WORK LANDING'S GREETING (his order, 2026-10-05:
 * replicate Claude's new-chat screen on web and app, "with a cute glyphh
 * message on load, Ada Lovelace themed of course").
 *
 * One pure table: five time-of-day buckets (the mascots' buckets), three or
 * four lines each, every line short and charming and drawn on Ada — the
 * Analytical Engine, poetical science, Note G, the loom, Babbage. No
 * exclamation marks, no emoji, under forty characters. The pick is
 * deterministic per seed (the session id) so a repaint never flickers to
 * another line. Nothing here touches the DOM; the test pins the rules.
 */

export type GreetingBucket = "morning" | "lunch" | "afternoon" | "evening" | "latenight";

/** The longest a line may be (the display face at 34px over the composer). */
export const GREETING_MAX_CHARS = 40;

export const GREETINGS: Readonly<Record<GreetingBucket, readonly string[]>> = {
  // EVERY line carries the reader's first name (his report, 2026-10-05: "why
  // didn't the name come through?" — only four lines named the reader, so
  // most sessions never showed it). `{name}` renders to the first name; with
  // none known the vocative drops (renderGreeting).
  morning: [
    "Morning, {name} — the Engine is warm",
    "Early bird, {name} — Babbage approves",
    "Morning, {name} — cards are punched",
    "The loom is threaded for the day, {name}",
  ],
  lunch: [
    "Midday, {name}, and the Engine hums",
    "Poetical science with lunch, {name}",
    "Note G is open, {name} — let's compute",
    "The loom weaves on through lunch, {name}",
  ],
  afternoon: [
    "Afternoon, {name} — patterns weaving",
    "The Engine weaves on, {name}",
    "Tea, then algebra, {name}",
    "The loom never tires, {name}",
  ],
  evening: [
    "Evening, {name} — the Engine keeps time",
    "Lamps lit in the Engine room, {name}",
    "Evening, {name} — one more pattern",
    "Poetical science by lamplight, {name}",
  ],
  latenight: [
    "Burning the midnight oil, {name}?",
    "Late, {name} — the Engine never sleeps",
    "The night shift at the Engine, {name}",
    "Babbage is asleep, {name}; we are not",
  ],
};

/** Local hour → bucket: 5–10 morning, 10–14 lunch, 14–17 afternoon, 17–22
 *  evening, else late night (the same edges mascots.ts draws its cousins on). */
export function greetingBucket(hour: number): GreetingBucket {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 10) return "morning";
  if (h >= 10 && h < 14) return "lunch";
  if (h >= 14 && h < 17) return "afternoon";
  if (h >= 17 && h < 22) return "evening";
  return "latenight";
}

/** A small stable hash (FNV-1a, 32-bit) — the seed is a session id, so the
 *  same thread always greets with the same line. */
export function greetingHash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The line for this seed at this hour. Deterministic: same seed + same
 *  bucket → same line, whatever the repaint count. */
export function pickGreeting(seed: string, hour: number = new Date().getHours(), name = ""): string {
  const lines = GREETINGS[greetingBucket(hour)];
  return renderGreeting(lines[greetingHash(seed) % lines.length], name);
}

/** THE READER'S FIRST NAME (his order, 2026-10-05: "just use their first
 *  name in these" — no title, no assumed gender). "Chris Timmerman" → "Chris". */
export function firstNameOf(full: string | null | undefined): string {
  const first = String(full || "").trim().split(/\s+/)[0] || "";
  return first.replace(/[,.;:]+$/, "");
}

/** A line's `{name}` becomes the first name; with no name the vocative
 *  drops cleanly ("Morning, {name} — cards are punched" → "Morning — cards
 *  are punched"; "Tea, then algebra, {name}" → "Tea, then algebra"). */
export function renderGreeting(line: string, name = ""): string {
  const n = firstNameOf(name);
  if (!line.includes("{name}")) return line;
  if (n) return line.replace("{name}", n);
  return line.replace(/,\s*\{name\}/, "").replace(/\s*\{name\}/, "").replace(/\s+([—?])/g, " $1").replace(/\s+\?/, "?").trim();
}
