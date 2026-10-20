/**
 * menu-place.test.ts — where a pop-up menu goes (his report, 2026-10-04: the
 * recents dropdown and its filter menu ran off the viewport with the agent on
 * the right). Pure: anchor rect + menu size + box → placement.
 */
import { describe, expect, it } from "vitest";
import { placeMenu, menuFrame } from "../../src/renderer/help/menu-place";

const box = { left: 0, top: 0, width: 1000, height: 800 };
const menu = { width: 300, height: 200 };

describe("placeMenu — horizontal", () => {
  it("hangs from the anchor's left edge when there is room", () => {
    const p = placeMenu({ left: 100, top: 100, width: 40, height: 20 }, menu, box);
    expect(p.left).toBe(100);
    expect(p.align).toBe("left");
  });

  it("flips to the anchor's right edge when opening rightwards would run off the box", () => {
    const p = placeMenu({ left: 900, top: 100, width: 40, height: 20 }, menu, box);
    expect(p.align).toBe("right");
    expect(p.left).toBe(940 - 300);
    expect(p.left + 300).toBeLessThanOrEqual(1000 - 8);
  });

  it("prefers the right edge when asked, and flips left when that runs off", () => {
    const right = placeMenu({ left: 600, top: 100, width: 40, height: 20 }, menu, box, { align: "right" });
    expect(right.align).toBe("right");
    expect(right.left).toBe(640 - 300);
    const flipped = placeMenu({ left: 10, top: 100, width: 40, height: 20 }, menu, box, { align: "right" });
    expect(flipped.align).toBe("left");
    expect(flipped.left).toBe(10);
  });

  it("clamps inside the box and caps the width when the menu is wider than the room", () => {
    const narrow = { left: 0, top: 0, width: 200, height: 800 };
    const p = placeMenu({ left: 150, top: 100, width: 40, height: 20 }, menu, narrow);
    expect(p.maxWidth).toBe(200 - 16);
    expect(p.left).toBe(8);
  });

  it("honours a box that does not start at the origin (a clipping ancestor)", () => {
    const card = { left: 500, top: 300, width: 400, height: 300 };
    const p = placeMenu({ left: 850, top: 500, width: 40, height: 20 }, menu, card);
    expect(p.left + 300).toBeLessThanOrEqual(900 - 8);
    expect(p.left).toBeGreaterThanOrEqual(508);
  });
});

describe("placeMenu — vertical", () => {
  it("opens below with a gap when there is room", () => {
    const p = placeMenu({ left: 100, top: 100, width: 40, height: 20 }, menu, box);
    expect(p.side).toBe("below");
    expect(p.top).toBe(124);
    expect(p.maxHeight).toBe(800 - 8 - 124);
  });

  it("flips above when the room below is short and above is roomier", () => {
    const p = placeMenu({ left: 100, top: 700, width: 40, height: 20 }, menu, box);
    expect(p.side).toBe("above");
    expect(p.top).toBe(700 - 4 - 200);
  });

  it("never flips a fixed side — it caps the height to the room there instead", () => {
    const p = placeMenu({ left: 100, top: 60, width: 40, height: 20 }, { width: 300, height: 320 }, box, { side: "above", gap: 8 });
    expect(p.side).toBe("above");
    expect(p.maxHeight).toBe(60 - 8 - 8);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });

  it("keeps the menu inside the box when neither side holds it whole", () => {
    const short = { left: 0, top: 0, width: 1000, height: 150 };
    const p = placeMenu({ left: 100, top: 70, width: 40, height: 20 }, menu, short);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + Math.min(200, p.maxHeight)).toBeLessThanOrEqual(150 - 8);
  });
});

describe("menuFrame — the recents dropdown's frame (his report, 2026-10-05: it did not scroll and its width followed its rows)", () => {
  const roomy = placeMenu({ left: 100, top: 100, width: 40, height: 20 }, { width: 500, height: 2000 }, box, { width: 360 });
  it("ONE fixed width whatever the content measures — the same on every open", () => {
    expect(menuFrame(roomy, { width: 360 }).width).toBe(360);
    const narrowContent = placeMenu({ left: 100, top: 100, width: 40, height: 20 }, { width: 120, height: 200 }, box, { width: 360 });
    expect(menuFrame(narrowContent, { width: 360 }).width).toBe(360);
    // placeMenu placed it by that width, not by the content's.
    expect(roomy.left + 360).toBeLessThanOrEqual(box.width - 8);
  });
  it("the fixed width is still capped to the room", () => {
    const narrow = { left: 0, top: 0, width: 300, height: 800 };
    const p = placeMenu({ left: 10, top: 100, width: 40, height: 20 }, { width: 360, height: 200 }, narrow, { width: 360 });
    expect(menuFrame(p, { width: 360 }).width).toBe(300 - 16);
  });
  it("without a fixed width the menu keeps what it measures", () => {
    expect(menuFrame(roomy, {}).width).toBeNull();
  });
  it("the height is capped to the room on the side it opened — a list taller than that scrolls", () => {
    const f = menuFrame(roomy, { width: 360, scrollRegion: true });
    expect(f.maxHeight).toBe(roomy.maxHeight);
    expect(f.maxHeight).toBeLessThan(2000);
    expect(f.maxHeight).toBeGreaterThan(0);
  });
  it("the LIST region scrolls (search + type switch stay pinned); without one the whole menu does", () => {
    expect(menuFrame(roomy, { width: 360, scrollRegion: true }).scroll).toBe("region");
    expect(menuFrame(roomy, { width: 360 }).scroll).toBe("menu");
  });
});
