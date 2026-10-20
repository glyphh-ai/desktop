/**
 * slides/index.ts — the Glyphh Slides layout + theme engine.
 *
 * Pure, dependency-free string functions: typed SlideSpecs → locked <section>
 * HTML the desktop shell wraps and presents. Agents slot STRUCTURED CONTENT
 * into controlled layouts; they never author the deck's format.
 */

export type { SlideSpec, RenderCtx, LayoutFn, LayoutSpec, FieldSchema, FieldType } from "./types.js";
export { SLIDE_LAYOUTS, LAYOUT_NAMES } from "./layouts.js";
export { SLIDE_THEMES, DEFAULT_THEME, resolveTheme, themeVars, themeFromDesign } from "./theme.js";
export type { SlideTheme } from "./theme.js";
export { SLIDE_BASE_CSS } from "./base-css.js";
export { renderDeck, renderSection, SLIDE_SPEC_VERSION } from "./render.js";
export type { RenderOptions } from "./render.js";
export { validateSlideSpec, validateDeck, layoutCatalog, themeCatalog } from "./schema.js";
export type { SpecValidation } from "./schema.js";
export { renderSlideChart } from "./chart-svg.js";
export type { SlideChartType, ChartPoint } from "./chart-svg.js";
