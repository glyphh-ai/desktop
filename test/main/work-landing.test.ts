/**
 * work-landing.test.ts — the Work landing's pure rules (his order,
 * 2026-10-05: Claude's new-chat screen on web and app — an Ada-themed
 * greeting on load). The Output chip is gone (his order, 2026-10-09).
 */
import { describe, expect, it } from "vitest";
import { GREETINGS, GREETING_MAX_CHARS, greetingBucket, greetingHash, pickGreeting, firstNameOf, renderGreeting } from "../../src/renderer/help/landing-greeting";

describe("greeting buckets", () => {
  it("cuts the day at 5, 10, 14, 17 and 22", () => {
    expect(greetingBucket(5)).toBe("morning");
    expect(greetingBucket(9)).toBe("morning");
    expect(greetingBucket(10)).toBe("lunch");
    expect(greetingBucket(13)).toBe("lunch");
    expect(greetingBucket(14)).toBe("afternoon");
    expect(greetingBucket(16)).toBe("afternoon");
    expect(greetingBucket(17)).toBe("evening");
    expect(greetingBucket(21)).toBe("evening");
    expect(greetingBucket(22)).toBe("latenight");
    expect(greetingBucket(0)).toBe("latenight");
    expect(greetingBucket(4)).toBe("latenight");
  });

  it("folds an out-of-range hour onto the clock", () => {
    expect(greetingBucket(24)).toBe("latenight");
    expect(greetingBucket(29)).toBe("morning");
    expect(greetingBucket(-1)).toBe("latenight");
  });
});

describe("the greeting table", () => {
  const all = Object.entries(GREETINGS);

  it("has every bucket with three or four lines", () => {
    expect(all.map(([k]) => k).sort()).toEqual(["afternoon", "evening", "latenight", "lunch", "morning"]);
    for (const [, lines] of all) expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const [, lines] of all) expect(lines.length).toBeLessThanOrEqual(4);
  });

  it("keeps every line short, with no exclamation mark and no emoji", () => {
    for (const [, lines] of all) {
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(GREETING_MAX_CHARS);
        expect(line).not.toMatch(/!/);
        expect(line).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(line.trim()).toBe(line);
      }
    }
  });

  it("never repeats a line", () => {
    const flat = all.flatMap(([, lines]) => lines);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it("draws on Ada in every bucket", () => {
    const ada = /engine|loom|babbage|countess|note g|poetical|algebra|pattern|weav|cards/i;
    for (const [, lines] of all) expect(lines.some((l) => ada.test(l))).toBe(true);
  });
});

describe("the pick", () => {
  it("is deterministic per seed within a bucket", () => {
    for (const hour of [6, 12, 15, 19, 23]) {
      expect(pickGreeting("cabc123", hour)).toBe(pickGreeting("cabc123", hour));
    }
    expect(greetingHash("cabc123")).toBe(greetingHash("cabc123"));
  });

  it("lands on a line of the hour's bucket", () => {
    const rendered = (hour: number) => GREETINGS[greetingBucket(hour)].map((l) => renderGreeting(l, ""));
    expect(rendered(7)).toContain(pickGreeting("s1", 7));
    expect(rendered(12)).toContain(pickGreeting("s1", 12));
    expect(rendered(15)).toContain(pickGreeting("s1", 15));
    expect(rendered(20)).toContain(pickGreeting("s1", 20));
    expect(rendered(2)).toContain(pickGreeting("s1", 2));
  });
  it("names the reader by first name, never a title (his order, 2026-10-05)", () => {
    expect(firstNameOf("Chris Timmerman")).toBe("Chris");
    expect(firstNameOf("  Ada   Lovelace ")).toBe("Ada");
    expect(firstNameOf("")).toBe("");
    expect(renderGreeting("Morning, {name} — cards are punched", "Chris Timmerman")).toBe("Morning, Chris — cards are punched");
    expect(renderGreeting("Tea, then algebra, {name}", "Chris")).toBe("Tea, then algebra, Chris");
    expect(renderGreeting("Burning the midnight oil, {name}?", "Chris")).toBe("Burning the midnight oil, Chris?");
    expect(renderGreeting("Morning, {name} — cards are punched", "")).toBe("Morning — cards are punched");
    expect(renderGreeting("Tea, then algebra, {name}", "")).toBe("Tea, then algebra");
    expect(renderGreeting("Evening, {name} — one more pattern", "")).toBe("Evening — one more pattern");
    expect(renderGreeting("Burning the midnight oil, {name}?", "")).toBe("Burning the midnight oil?");
    expect(renderGreeting("The loom is threaded for the day", "Chris")).toBe("The loom is threaded for the day");
    const flat = Object.values(GREETINGS).flat();
    // EVERY line names the reader (his report, 2026-10-05: the name did not come through).
    for (const l of flat) expect(l).toContain("{name}");
    for (const l of flat) {
      const bare = renderGreeting(l, "");
      expect(bare).not.toContain("{name}");
      expect(bare).not.toMatch(/\s[?;,]|,\s*$|\s{2,}/);
      expect(renderGreeting(l, "Chris Timmerman")).toContain("Chris");
    }
    expect(renderGreeting("Midday, {name}, and the Engine hums", "")).toBe("Midday, and the Engine hums");
    expect(renderGreeting("Babbage is asleep, {name}; we are not", "")).toBe("Babbage is asleep; we are not");
    expect(flat.some((l) => /countess|analyst|scientist|sir|lady|madam/i.test(l))).toBe(false);
  });

  it("spreads different seeds across the bucket's lines", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) seen.add(pickGreeting(`c${i.toString(36)}`, 7));
    expect(seen.size).toBe(GREETINGS.morning.length);
  });
});
