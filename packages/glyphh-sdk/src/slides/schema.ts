/**
 * slides/schema.ts — validation + the model-facing catalogs for
 * list_slide_layouts / list_slide_themes.
 */

import type { SlideSpec } from "./types.js";
import { SLIDE_LAYOUTS, LAYOUT_NAMES, UNIVERSAL_FIELDS } from "./layouts.js";
import { SLIDE_THEMES } from "./theme.js";
import { s } from "./util.js";

export interface SpecValidation { ok: boolean; errors: string[] }

/** Validate one slide spec against its layout's schema. Errors are phrased for
 *  the model to fix and re-send (missing/empty required fields, unknown layout). */
export function validateSlideSpec(spec: unknown, index?: number): SpecValidation {
  const at = index === undefined ? "" : ` (slide ${index + 1})`;
  if (!spec || typeof spec !== "object") return { ok: false, errors: [`each slide must be an object with a "layout"${at}`] };
  const c = spec as SlideSpec;
  const layout = s(c.layout);
  if (!layout) return { ok: false, errors: [`slide is missing "layout"${at} — one of: ${LAYOUT_NAMES.join(", ")}`] };
  const spec2 = SLIDE_LAYOUTS[layout];
  if (!spec2) return { ok: false, errors: [`unknown layout "${layout}"${at} — one of: ${LAYOUT_NAMES.join(", ")}`] };

  const errors: string[] = [];
  for (const field of spec2.schema) {
    if (!field.required) continue;
    const v = (c as Record<string, unknown>)[field.key];
    const empty = v == null
      || (typeof v === "string" && v.trim() === "")
      || (Array.isArray(v) && v.length === 0);
    if (empty) errors.push(`layout "${layout}"${at} needs "${field.key}" — ${field.doc}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Validate a whole deck of specs. */
export function validateDeck(specs: unknown): SpecValidation {
  if (!Array.isArray(specs) || specs.length === 0) {
    return { ok: false, errors: ["slides must be a non-empty array of {layout, …} specs"] };
  }
  const errors = specs.flatMap((sp, i) => validateSlideSpec(sp, i).errors);
  return { ok: errors.length === 0, errors };
}

/** The catalog list_slide_layouts returns. */
export function layoutCatalog(): Array<{ layout: string; summary: string; required: string[]; fields: string[]; sample: SlideSpec }> {
  return Object.values(SLIDE_LAYOUTS).map((l) => ({
    layout: l.name,
    summary: l.summary,
    required: l.schema.filter((f) => f.required).map((f) => f.key),
    // Layout-specific fields first, then the universal ones every layout takes
    // (enter/fx/footer/notes) — documented once here so the model always sees
    // the motion vocabulary next to the layout it's filling.
    fields: [...l.schema, ...UNIVERSAL_FIELDS].map((f) => `${f.key}${f.required ? "*" : ""} — ${f.doc}`),
    sample: l.sample,
  }));
}

/** The catalog list_slide_themes returns. */
export function themeCatalog(): Array<{ theme: string; summary: string; mode: string; swatches: string[] }> {
  return Object.values(SLIDE_THEMES).map((t) => ({
    theme: t.name, summary: t.label, mode: t.mode, swatches: t.swatches,
  }));
}
