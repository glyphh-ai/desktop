/**
 * space-meta — the ONE description of a space (Chat | Work | Code) for every
 * surface that labels one: the layout cards' badges, the Chat landing's
 * starter cards, anything that comes next.
 *
 * The glyphs are the rail tabs' own icons, as SVG inner-HTML. (Echo's wall
 * draws its badges into a canvas, so it keeps the same shapes as raw path
 * data — different medium, same silhouette.)
 */

export type Space = "chat" | "cowork" | "code";

export const SPACE_LABEL: Record<Space, string> = { chat: "Chat", cowork: "Work", code: "Code" };

export const SPACE_GLYPH_SVG: Record<Space, string> = {
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  cowork: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
};

/** No explicit space picked (layouts) → a sparkle, never the derived space's
 *  glyph: "I chose Code" and "it looks like Code" must read differently. */
export const AUTO_GLYPH_SVG =
  '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"/>';

/** The pill every surface renders: the space's glyph + its name. */
export function spacePillHtml(space: Space, extraClass = ""): string {
  return (
    `<span class="space-pill space-pill-${space} ${extraClass}">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${SPACE_GLYPH_SVG[space]}</svg>` +
    `<span>${SPACE_LABEL[space]}</span>` +
    `</span>`
  );
}
