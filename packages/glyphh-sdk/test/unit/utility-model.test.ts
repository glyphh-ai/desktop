/**
 * utility-model.test.ts — pickUtilityModel: the flagged row, else the cheapest
 * chat row by input + 3 × output, else null.
 */

import { describe, it, expect } from "vitest";
import { pickUtilityModel, utilityCost } from "../../src/resources/models.js";
import type { AvailableModel } from "../../src/contract/models.js";

const row = (name: string, cin: number, cout: number, extra: Partial<AvailableModel> = {}): AvailableModel => ({
  id: `p::${name}`, name, providerSlug: "p", kind: "proxied", modality: "chat",
  inputUsdPerMTok: cin, outputUsdPerMTok: cout, contextWindow: null, maxOutputTokens: null, source: "proxy",
  ...extra,
});

describe("pickUtilityModel", () => {
  it("weighs output three to one", () => {
    expect(utilityCost(row("x", 1, 2))).toBe(7);
  });

  it("answers the flagged row's id over a cheaper one", () => {
    expect(pickUtilityModel([row("cheap", 0.1, 0.4), row("flagged", 3, 15, { utility: true })])).toBe("p::flagged");
  });

  it("falls back to the cheapest chat row by input + 3 × output", () => {
    // "low-in" is cheapest on input alone; weighted, "balanced" is.
    expect(pickUtilityModel([row("low-in", 0.1, 1), row("balanced", 0.2, 0.5), row("dear", 3, 15)])).toBe("p::balanced");
  });

  it("skips what cannot answer a text request and what has no price", () => {
    const rows = [
      row("embed", 0.01, 0, { modality: "embedding" }),
      row("image", 0.01, 0.01, { modality: "image" }),
      row("unpriced", 0, 0),
      row("chat", 0.5, 1.5),
    ];
    expect(pickUtilityModel(rows)).toBe("p::chat");
    expect(pickUtilityModel([row("embed", 0.01, 0, { modality: "embedding" })])).toBeNull();
    expect(pickUtilityModel([])).toBeNull();
  });

  it("ignores a flag on a non-chat row", () => {
    expect(pickUtilityModel([row("embed", 0.01, 0, { modality: "embedding", utility: true }), row("chat", 1, 2)])).toBe("p::chat");
  });

  it("breaks a tie by id so the answer is stable", () => {
    expect(pickUtilityModel([row("b", 1, 1), row("a", 1, 1)])).toBe("p::a");
  });
});
