import { describe, it, expect } from "vitest";
import { toolResultContent, TOOL_RESULT_CHARS } from "../../src/loop/loop.js";
import { resultImages } from "../../src/loop/mcp.js";

const B64 = "iVBORw0KGgo".padEnd(200_000, "A");

describe("a tool result reaches the model as what it is (his audit, 2026-09-29: a screenshot sent as base64 text was a $1.23 call)", () => {
  it("a data:image URL in a result's text becomes an image, never text", () => {
    const out = toolResultContent({ text: JSON.stringify({ dataUrl: `data:image/png;base64,${B64}` }) });
    expect(Array.isArray(out)).toBe(true);
    const blocks = out as Array<{ type: string; text?: string; source?: { media_type: string; data: string } }>;
    expect(blocks[0]).toEqual({ type: "text", text: JSON.stringify({ dataUrl: "[image]" }) });
    expect(blocks[1]!.type).toBe("image");
    expect(blocks[1]!.source!.media_type).toBe("image/png");
    expect(JSON.stringify(blocks).length).toBeLessThan(B64.length + 500);
    expect(blocks[0]!.text).not.toContain("iVBOR");
  });

  it("an MCP image part is an image", () => {
    const images = resultImages({ isError: false, content: [{ type: "text", text: "shot" }, { type: "image", data: "AAAA", mimeType: "image/png" }] });
    expect(images).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]);
    expect(toolResultContent({ text: "shot", images })).toEqual([{ type: "text", text: "shot" }, images[0]]);
  });

  it("text past the cap is cut, with a note asking for a narrower read", () => {
    const out = toolResultContent({ text: "x".repeat(TOOL_RESULT_CHARS + 5_000) }) as string;
    expect(out.length).toBeLessThan(TOOL_RESULT_CHARS + 300);
    expect(out).toContain("[truncated: 5,000 more characters.");
  });

  it("ordinary text is left alone", () => {
    expect(toolResultContent({ text: "exit 0" })).toBe("exit 0");
  });
});
