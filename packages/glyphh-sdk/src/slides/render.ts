/**
 * slides/render.ts — the render + media pipeline.
 *
 * `renderDeck` turns an array of typed SlideSpecs into the `slidesHtml` string
 * that the desktop shell (`buildDeckDocument`) wraps and the structure lock
 * re-normalizes. It:
 *   1. resolves a theme (a SLIDE_THEMES key, optionally overlaid with the org
 *      design system) and emits it as a `:root` var block + the shared base CSS,
 *   2. renders each spec's layout to a `<section>` (carrying data-notes /
 *      data-gp-hidden),
 *   3. resolves `{{MEDIA:id}}` tokens to inline data URIs via an injected
 *      resolver (so this module stays transport-agnostic and decks stay
 *      self-contained — no network at present time).
 */

import type { RenderCtx, SlideSpec } from "./types.js";
import { SLIDE_LAYOUTS } from "./layouts.js";
import { SLIDE_BASE_CSS } from "./base-css.js";
import { resolveTheme, themeFromDesign, themeVars } from "./theme.js";
import { esc, mediaToken, s } from "./util.js";

export const SLIDE_SPEC_VERSION = 1;

export interface RenderOptions {
  /** A SLIDE_THEMES key. Default "midnight". */
  theme?: string;
  /** Compiled org design-system CSS (from client.designs.css) to overlay. */
  designCss?: string;
  /** Resolve a media asset id to an inline data URI (or null to drop it). */
  resolveMedia?: (id: string) => Promise<string | null>;
}

const ctx: RenderCtx = { media: (ref) => mediaToken(ref) };

/** Render one spec to a locked-shape `<section>` (tokens not yet resolved). */
function renderOneSection(spec: SlideSpec): string {
  const layout = SLIDE_LAYOUTS[s(spec.layout)] ?? SLIDE_LAYOUTS.blank!;
  const inner = layout.render(spec, ctx);
  const notes = s(spec.notes) ? ` data-notes="${esc(spec.notes)}"` : "";
  const hidden = spec.hidden ? ` data-gp-hidden="1"` : "";
  // Universal `footer` field: left text + auto page number (a CSS counter, so
  // insert/remove/renumber stay correct with zero bookkeeping).
  const footer = s(spec.footer)
    ? `\n<div class="gp-footer"><span>${esc(spec.footer)}</span><span class="gp-pagenum"></span></div>`
    : "";
  return `<section class="slide"${hidden}${notes}>\n${inner}${footer}\n</section>`;
}

/** Replace every {{MEDIA:id}} token in `html` using the resolver (deduped). A
 *  ref that can't resolve is dropped (the layout falls back to a themed
 *  surface). Without a resolver, tokens are simply stripped. */
async function resolveMedia(html: string, resolver?: RenderOptions["resolveMedia"]): Promise<string> {
  const ids = new Set<string>();
  for (const m of html.matchAll(/\{\{MEDIA:([a-zA-Z0-9._:-]+)\}\}/g)) ids.add(m[1]!);
  if (ids.size === 0) return html;
  const map = new Map<string, string>();
  if (resolver) {
    await Promise.all([...ids].map(async (id) => {
      try {
        const uri = await resolver(id);
        if (uri) map.set(id, uri);
      } catch { /* drop on failure */ }
    }));
  }
  return html.replace(/\{\{MEDIA:([a-zA-Z0-9._:-]+)\}\}/g, (_m, id: string) => map.get(id) ?? "");
}

/** The theme's `<style>` head: `:root` vars + shared base CSS. Sits inside
 *  #stage ahead of the first section, so the structure lock leaves it intact. */
function styleHead(opts: RenderOptions): string {
  let theme = resolveTheme(opts.theme);
  if (opts.designCss) theme = themeFromDesign(opts.designCss, theme);
  return `<style id="gp-theme">:root{ ${themeVars(theme)} } ${SLIDE_BASE_CSS}</style>`;
}

/** Render a full deck body (style head + all sections, media resolved). */
export async function renderDeck(specs: SlideSpec[], opts: RenderOptions = {}): Promise<string> {
  const body = specs.map(renderOneSection).join("\n");
  return resolveMedia(`${styleHead(opts)}\n${body}`, opts.resolveMedia);
}

/** Render a single spec to a `<section>` (media resolved) — for update_slides
 *  replace/insert, where the deck already carries the theme head. */
export async function renderSection(spec: SlideSpec, opts: RenderOptions = {}): Promise<string> {
  return resolveMedia(renderOneSection(spec), opts.resolveMedia);
}
