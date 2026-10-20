import { describe, expect, it, vi } from "vitest";
import { normalizeDoc } from "../../src/renderer/wb-design";

describe("design documents load whole", () => {
  it("a file with colors but no fonts (the Windows crash) paints with the starter's fonts", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = normalizeDoc({ version: 1, name: "Acme", colors: { primary: "#112233", background: "#000000", text: "#ffffff" } }, "acme.json");
    expect(d.fonts.body.family).toBeTruthy();
    expect(d.fonts.display.family).toBeTruthy();
    expect(d.colors.primary).toBe("#112233");
    expect(warn).toHaveBeenCalledWith("[design] filled a document's missing parts from the starter", JSON.stringify({ file: "acme.json", filled: ["fonts.display", "fonts.body"] }));
    warn.mockRestore();
  });

  it("keeps a complete document exactly as written, optional parts included", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = {
      version: 1, name: "Done", colors: { primary: "#1", background: "#2", text: "#3", muted: "#4" },
      fonts: { display: { family: "Sora" }, body: { family: "Inter" } },
      styles: { radius: 2 }, canvas: { rail: 300 },
    };
    const d = normalizeDoc(doc, "done.json");
    expect(d).toEqual({ ...doc });
    expect(d.fonts.mono).toBeUndefined();
    expect(d.styles).toEqual({ radius: 2 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("fills a malformed required part and names the file without a name", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = normalizeDoc({ colors: { primary: 7 }, fonts: { display: "Sora", body: { family: "Inter" }, mono: {} } }, "sketch.json");
    expect(d.name).toBe("sketch");
    expect(typeof d.colors.primary).toBe("string");
    expect(d.colors.background).toBeTruthy();
    expect(d.fonts.display.family).toBeTruthy();
    expect(d.fonts.body.family).toBe("Inter");
    expect(d.fonts.mono?.family).toBeTruthy();
    vi.restoreAllMocks();
  });

  it("a document that is not an object at all becomes the starter", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = normalizeDoc("garbage", "x.json");
    expect(d.name).toBe("x");
    expect(d.fonts.body.family).toBeTruthy();
    vi.restoreAllMocks();
  });
});
