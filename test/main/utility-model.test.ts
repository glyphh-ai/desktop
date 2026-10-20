/**
 * utility-model.test.ts — the rule for which model runs the small side jobs
 * (his order, 2026-10-05): the console's flagged Utility model, else the
 * cheapest chat row by input + 3 × output, else null — never the session's.
 */
import { describe, expect, it } from "vitest";
import { pickUtilityModel, utilityCost } from "../../src/renderer/help/utility-model";

const row = (id: string, i: number, o: number, extra: Record<string, unknown> = {}) =>
  ({ id, modality: "chat", inputUsdPerMTok: i, outputUsdPerMTok: o, ...extra });

describe("utilityCost", () => {
  it("is input + 3 × output per MTok", () => {
    expect(utilityCost(row("a", 3, 15))).toBe(48);
    expect(utilityCost(row("b", 0.8, 4))).toBe(12.8);
  });
  it("is null when a price is missing, non-finite or negative", () => {
    expect(utilityCost({ id: "a" })).toBeNull();
    expect(utilityCost({ id: "a", inputUsdPerMTok: 1 })).toBeNull();
    expect(utilityCost({ id: "a", inputUsdPerMTok: Number.NaN, outputUsdPerMTok: 1 })).toBeNull();
    expect(utilityCost({ id: "a", inputUsdPerMTok: -1, outputUsdPerMTok: 1 })).toBeNull();
  });
});

describe("pickUtilityModel", () => {
  it("takes the flagged Utility row first, whatever it costs", () => {
    const rows = [row("cheap", 0.1, 0.4), row("flagged", 15, 75, { utility: true }), row("other", 1, 5)];
    expect(pickUtilityModel(rows)).toBe("flagged");
  });
  it("else the cheapest chat row by input + 3 × output", () => {
    // sonnet 3/15 = 48 · haiku 0.8/4 = 12.8 · a cheap-input/dear-output row 0.5/5 = 15.5
    const rows = [row("sonnet", 3, 15), row("haiku", 0.8, 4), row("odd", 0.5, 5)];
    expect(pickUtilityModel(rows)).toBe("haiku");
  });
  it("ignores rows that are not chat/text or carry no prices", () => {
    const rows = [
      { id: "img", modality: "image", inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
      { id: "unpriced", modality: "chat" },
      row("text-row", 2, 2, { modality: "text" }),
      row("chat-row", 1, 1),
    ];
    expect(pickUtilityModel(rows)).toBe("chat-row");
  });
  it("keeps list order on a tie", () => {
    expect(pickUtilityModel([row("first", 1, 1), row("second", 1, 1)])).toBe("first");
  });
  it("is null with nothing usable — the caller skips the job", () => {
    expect(pickUtilityModel([])).toBeNull();
    expect(pickUtilityModel(null)).toBeNull();
    expect(pickUtilityModel([{ id: "unpriced", modality: "chat" }])).toBeNull();
    expect(pickUtilityModel([{ id: "img", modality: "image", inputUsdPerMTok: 0, outputUsdPerMTok: 0 }])).toBeNull();
  });
  it("an unpriced 0/0 row (an auto-router) never wins the cheapest pick", () => {
    expect(pickUtilityModel([
      { id: "claude-auto", modality: "chat", inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
      { id: "gpt-oss-20b", modality: "chat", inputUsdPerMTok: 0.05, outputUsdPerMTok: 0.2 },
    ])).toBe("gpt-oss-20b");
    expect(pickUtilityModel([{ id: "claude-auto", modality: "chat", inputUsdPerMTok: 0, outputUsdPerMTok: 0 }])).toBeNull();
  });
});
