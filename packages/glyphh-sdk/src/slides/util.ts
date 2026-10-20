/**
 * slides/util.ts — shared, DOM-free helpers for the slide layout engine.
 * Everything here is a pure string transform: the engine produces HTML that
 * is later re-normalized by the desktop STRUCTURE LOCK (lockDeckSections), so
 * these helpers must never emit <script>/<link>/<iframe> or rely on runtime JS.
 */

/** Escape text for safe interpolation into HTML element bodies / attributes. */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Coerce to a trimmed string (empty when nullish). */
export function s(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/** Coerce to a string array — accepts arrays, or a newline/•-delimited string. */
export function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => s(x)).filter(Boolean);
  const str = s(v);
  if (!str) return [];
  return str.split(/\r?\n|(?:^|\s)[•·-]\s/).map((x) => x.trim()).filter(Boolean);
}

/** Coerce to an array of records (for items/series fields). */
export function rows(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
}

/** A media placeholder token the renderer resolves to a data URI (or a themed
 *  fallback). Only [a-zA-Z0-9._-] ids are honoured; anything else yields "". */
const MEDIA_ID = /^[a-zA-Z0-9._:-]+$/;
export function mediaToken(ref: unknown): string {
  const id = s(ref);
  return id && MEDIA_ID.test(id) ? `{{MEDIA:${id}}}` : "";
}

/** True when a value carries a usable media reference. */
export function hasMedia(ref: unknown): boolean {
  return mediaToken(ref) !== "";
}
