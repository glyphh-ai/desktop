/**
 * @license Proprietary — © Glyphh. All rights reserved.
 *
 * The Slides layout engine (@glyphh/sdk/slides) + its interaction with the
 * desktop structure lock (gpoints.lockDeckSections). Pure — no Electron, no
 * network: the engine renders typed specs to HTML, the lock re-normalizes it.
 */

import { describe, it, expect } from "vitest";
import {
  renderDeck, renderSection, validateDeck, validateSlideSpec,
  layoutCatalog, themeCatalog, SLIDE_LAYOUTS, SLIDE_THEMES, resolveTheme, themeFromDesign,
} from "@glyphh/sdk/slides";
import { lockDeckSections, buildDeckDocument, slideSpans, normalizeDeckHtml } from "../../src/main/gpoints";

const deck = async (specs: unknown[], opts = {}) =>
  renderDeck(specs as never, { resolveMedia: async () => null, ...opts });

describe("slide layout engine", () => {
  it("catalogs every layout and theme", () => {
    expect(layoutCatalog().length).toBe(Object.keys(SLIDE_LAYOUTS).length);
    expect(layoutCatalog().length).toBeGreaterThanOrEqual(17);
    expect(themeCatalog().map((t) => t.theme)).toContain("midnight");
    expect(themeCatalog().map((t) => t.theme)).toContain("editorial");
  });

  it("renders one <section> per spec", async () => {
    const html = await deck([
      { layout: "title", title: "Hi", subtitle: "s" },
      { layout: "bullets", title: "B", points: ["a", "b"] },
      { layout: "closing", title: "Bye" },
    ]);
    expect((html.match(/<section/g) ?? []).length).toBe(3);
  });

  it("emits a :root theme block that reflects the chosen theme", async () => {
    const html = await deck([{ layout: "title", title: "x" }], { theme: "editorial" });
    expect(html).toContain(":root{");
    expect(html).toContain(SLIDE_THEMES.editorial!.vars.accent); // #d98a3d
  });

  it("carries speaker notes onto the section", async () => {
    const html = await deck([{ layout: "title", title: "x", notes: 'say "hello"' }]);
    expect(html).toMatch(/data-notes="say &quot;hello&quot;"/);
  });

  it("marks hidden slides", async () => {
    const html = await deck([{ layout: "title", title: "x", hidden: true }]);
    expect(html).toContain('data-gp-hidden="1"');
  });

  it("resolves media tokens to data URIs and drops misses", async () => {
    const specs = [{ layout: "image-right", title: "t", body: "b", media: "asset_ok" }];
    const html = await renderDeck(specs as never, {
      resolveMedia: async (id) => (id === "asset_ok" ? "data:image/png;base64,AAA" : null),
    });
    expect(html).toContain("data:image/png;base64,AAA");
    expect(html).not.toContain("{{MEDIA");
  });

  it("renders a self-contained SVG chart (no script)", async () => {
    const html = await deck([{ layout: "chart", title: "c", chartType: "bar", series: [{ label: "Q1", value: 10 }, { label: "Q2", value: 20 }] }]);
    expect(html).toContain("<svg");
    expect(html).not.toContain("<script");
  });

  it("escapes content — no HTML injection through fields", async () => {
    const html = await deck([{ layout: "title", title: "<img src=x onerror=alert(1)>" }]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});

describe("spec validation", () => {
  it("rejects an empty deck", () => {
    expect(validateDeck([]).ok).toBe(false);
  });
  it("flags an unknown layout with the catalog", () => {
    const v = validateSlideSpec({ layout: "nope" });
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain("unknown layout");
  });
  it("flags missing required fields with actionable text", () => {
    const v = validateSlideSpec({ layout: "bullets", title: "x" }, 2);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain("points");
    expect(v.errors[0]).toContain("slide 3");
  });
  it("accepts a valid spec", () => {
    expect(validateSlideSpec({ layout: "bullets", title: "x", points: ["a"] }).ok).toBe(true);
  });
});

describe("theme + design binding", () => {
  it("falls back to midnight for an unknown theme", () => {
    expect(resolveTheme("does-not-exist").name).toBe("midnight");
  });
  it("overlays design-system tokens onto a base theme", () => {
    const t = themeFromDesign("--design-primary: #ff0066; --design-background: #101015;");
    expect(t.vars.accent).toBe("#ff0066");
    expect(t.vars.bg).toBe("#101015");
  });
  it("keeps the base theme when the design CSS has no known tokens", () => {
    const t = themeFromDesign("/* nothing */", SLIDE_THEMES.ocean!);
    expect(t).toBe(SLIDE_THEMES.ocean);
  });
});

describe("the #stage scale transform is VALID (scale needs a unitless number)", () => {
  it("the shell divides length-by-length so calc yields a number", () => {
    const doc = buildDeckDocument("t", '<section class="slide on">x</section>');
    // valid: calc(100vw / 1920px) → number; invalid legacy: calc(100vw / 1920)
    expect(doc).toContain("calc(100vw / 1920px)");
    expect(doc).toContain("calc(100vh / 1080px)");
    expect(doc).not.toMatch(/calc\(100vw \/ 1920\)/);
  });
  it("normalizeDeckHtml heals a legacy deck and is idempotent", () => {
    const legacy = "transform: translate(-50%, -50%) scale(min(calc(100vw / 1920), calc(100vh / 1080)));";
    const fixed = normalizeDeckHtml(legacy);
    expect(fixed).toContain("calc(100vw / 1920px)");
    expect(fixed).toContain("calc(100vh / 1080px)");
    expect(normalizeDeckHtml(fixed)).toBe(fixed); // idempotent
  });
});

describe("engine output survives the structure lock", () => {
  it("locks sections (ids, single .on) while preserving notes + hidden + theme", async () => {
    const sections = await deck([
      { layout: "title", title: "Cover", notes: "opener" },
      { layout: "bullets", title: "Body", points: ["one"], hidden: true },
      { layout: "blank", html: "<div class='gp-frame'><script>evil()</script>safe</div>" },
    ], { theme: "corporate" });
    const doc = buildDeckDocument("Deck", sections);
    const locked = lockDeckSections(doc);

    const spans = slideSpans(locked);
    expect(spans.length).toBe(3);
    // sequential ids s1..s3
    expect(locked).toContain('id="s1"');
    expect(locked).toContain('id="s3"');
    // exactly one visible slide gets "on" (slide 2 is hidden, so slide 1)
    expect((locked.match(/class="slide on"/g) ?? []).length).toBe(1);
    // notes + hidden survive
    expect(locked).toMatch(/data-notes="opener"/);
    expect(spans[1]!.hidden).toBe(true);
    // scripts inside sections are stripped by the lock
    expect(locked).not.toContain("evil()");
    // the theme :root block (outside sections) is untouched
    expect(locked).toContain(":root{");
  });
});
