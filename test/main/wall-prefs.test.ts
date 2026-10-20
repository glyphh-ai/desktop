import { describe, it, expect } from "vitest";
import { RAIL_SHOW_DEFAULT, railTrayShown, clampRailLayoutsH, RAIL_LAYOUTS_MIN_H } from "../../src/renderer/help/wall-prefs.js";

describe("the Workspaces tray (his order, 2026-10-08: default the workspaces on)", () => {
  it("is on by default, and only an explicit false hides it", () => {
    expect(RAIL_SHOW_DEFAULT).toBe(true);
    expect(railTrayShown(undefined)).toBe(true);
    expect(railTrayShown(null)).toBe(true);
    expect(railTrayShown(true)).toBe(true);
    expect(railTrayShown(false)).toBe(false);
  });

  it("keeps a dragged height inside the rail", () => {
    expect(clampRailLayoutsH(0, 800)).toBe(0);           // unset → the CSS default
    expect(clampRailLayoutsH("x", 800)).toBe(0);
    expect(clampRailLayoutsH(20, 800)).toBe(RAIL_LAYOUTS_MIN_H);
    expect(clampRailLayoutsH(300, 800)).toBe(300);
    expect(clampRailLayoutsH(5000, 800)).toBe(600);       // 75% of the rail
    expect(clampRailLayoutsH(250.6, 800)).toBe(251);
  });
});
