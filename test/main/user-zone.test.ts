import { describe, expect, it } from "vitest";
import { isZone, onUserZoneChange, setUserZone, userZone } from "../../src/main/user-zone";

describe("user-zone — one zone everywhere (his word, 2026-10-05)", () => {
  it("is UTC until a profile says otherwise, and for a zone it does not know", () => {
    expect(userZone()).toBe("UTC");
    expect(setUserZone("Nowhere/Town")).toBe(false);
    expect(setUserZone("")).toBe(false);
    expect(setUserZone(undefined)).toBe(false);
    expect(userZone()).toBe("UTC");
  });

  it("moves to the profile's zone and re-arms the listeners once per move", () => {
    const seen: string[] = [];
    const off = onUserZoneChange((z) => seen.push(z));
    expect(setUserZone("America/Chicago")).toBe(true);
    expect(setUserZone("America/Chicago")).toBe(false);
    expect(userZone()).toBe("America/Chicago");
    expect(setUserZone("Europe/Amsterdam")).toBe(true);
    expect(seen).toEqual(["America/Chicago", "Europe/Amsterdam"]);
    off();
    expect(setUserZone("UTC")).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("a listener that throws does not stop the others", () => {
    const seen: string[] = [];
    const offBad = onUserZoneChange(() => { throw new Error("boom"); });
    const offGood = onUserZoneChange((z) => seen.push(z));
    expect(setUserZone("Asia/Tokyo")).toBe(true);
    expect(seen).toEqual(["Asia/Tokyo"]);
    offBad(); offGood();
    setUserZone("UTC");
  });

  it("knows a zone Intl knows, and nothing else", () => {
    expect(isZone("UTC")).toBe(true);
    expect(isZone("America/Chicago")).toBe(true);
    expect(isZone("Nowhere/Town")).toBe(false);
  });
});
