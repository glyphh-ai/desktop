/**
 * slides/types.ts — the shared contract for the slide layout engine.
 */

/** The typed content an agent supplies for one slide. `layout` selects the
 *  renderer; the remaining fields are layout-specific (see SLIDE_LAYOUTS). */
export interface SlideSpec {
  layout: string;
  /** Speaker notes → `data-notes` on the section, surfaced in the speaker view. */
  notes?: string;
  /** Hidden from the presenter (kept in the reader, dimmed) → `data-gp-hidden`. */
  hidden?: boolean;
  /** Rare per-slide theme override (a SLIDE_THEMES key). */
  theme?: string;
  /** Universal slide-entrance animation (a MOTION_FX name) — replays on show. */
  enter?: string;
  /** Universal build-step reveal effect (a MOTION_FX name) for this slide's frags. */
  fx?: string;
  /** Universal footer: left text + auto page number. Omit = chrome-free slide. */
  footer?: string;
  /** Layout-specific content fields. */
  [field: string]: unknown;
}

/** What a layout function can reach while rendering. */
export interface RenderCtx {
  /** Turn a media reference into an `<img>`/background token the renderer
   *  later resolves to a data URI (or a themed fallback). Returns "" when the
   *  ref is absent/invalid. */
  media(ref: unknown): string;
}

/** A layout renders typed content to the INNER html of a `<section>`. */
export type LayoutFn = (content: SlideSpec, ctx: RenderCtx) => string;

/** The kind of a content field — drives validation + the model-facing schema. */
export type FieldType =
  | "text" | "richtext" | "list" | "media" | "number" | "boolean" | "items" | "series";

export interface FieldSchema {
  key: string;
  type: FieldType;
  required?: boolean;
  /** One line telling the model what to put here (and the shape for items/series). */
  doc: string;
}

export interface LayoutSpec {
  name: string;
  /** One-line description shown by list_slide_layouts. */
  summary: string;
  schema: FieldSchema[];
  render: LayoutFn;
  /** A minimal valid example the model can copy. */
  sample: SlideSpec;
}
