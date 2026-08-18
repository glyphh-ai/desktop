/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * Glyphh Docs structured blocks (formatMarkdown container fences) + the
 * design-system doc-style directive. Pure — no Electron, no network.
 */

import { describe, it, expect } from "vitest";
import { formatMarkdown } from "../../src/renderer/format-markdown";
import { docThemeCss, docStyleFromDesign, parseDocStyle, writeDocStyle, DOC_THEMES } from "../../src/shared/doc-styles";

describe("Docs structured blocks", () => {
  it("renders a callout with a title", () => {
    const html = formatMarkdown(":::warning Heads up\nBe careful here.\n:::");
    expect(html).toContain("yo-md-callout-warning");
    expect(html).toContain("Heads up");
    expect(html).toContain("Be careful here");
  });
  it("maps callout aliases", () => {
    expect(formatMarkdown(":::tip\nnice\n:::")).toContain("yo-md-callout-tip");
    expect(formatMarkdown(":::callout\nx\n:::")).toContain("yo-md-callout-note");
  });
  it("renders two columns split by +++", () => {
    const html = formatMarkdown(":::columns\nLeft **a**\n+++\nRight\n:::");
    expect((html.match(/yo-md-col\b/g) ?? []).length).toBe(2);
    expect(html).toContain("<strong>a</strong>");
  });
  it("treats :::glyphh as inert metadata", () => {
    const html = formatMarkdown(":::glyphh --doc-accent:#ff0066\n\n# Title\nbody");
    expect(html).not.toContain("glyphh");
    expect(html).not.toContain("doc-accent");
    expect(html).toContain("Title");
  });
  it("leaves ordinary markdown unchanged", () => {
    const html = formatMarkdown("# H\n\n- one\n- two");
    expect(html).toContain("yo-md-h1");
    expect(html).toContain("<ul");
  });
});

describe("doc styles + design-system binding", () => {
  it("emits --doc-* vars for a theme", () => {
    const css = docThemeCss("editorial");
    expect(css).toContain("--doc-font-body");
    expect(css).toContain("--doc-accent");
  });
  it("falls back to the default theme", () => {
    expect(docThemeCss("nope")).toBe(docThemeCss(DOC_THEMES.classic!.name));
  });
  it("derives --doc-* from a design system's CSS", () => {
    const css = docStyleFromDesign("--design-primary: #ff0066; --design-font-display: 'Space Grotesk';");
    expect(css).toContain("--doc-accent:#ff0066");
    expect(css).toContain("--doc-font-head");
  });
  it("round-trips the style directive", () => {
    const md = writeDocStyle("# Doc\nbody", "--doc-accent:#123456");
    expect(parseDocStyle(md)).toBe("--doc-accent:#123456");
    expect(md).toContain("# Doc");
    // overwrite, not duplicate
    const md2 = writeDocStyle(md, "--doc-accent:#000");
    expect(parseDocStyle(md2)).toBe("--doc-accent:#000");
    expect((md2.match(/:::glyphh/g) ?? []).length).toBe(1);
    // empty removes it
    expect(parseDocStyle(writeDocStyle(md2, ""))).toBe("");
  });
});
