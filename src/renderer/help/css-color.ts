/**
 * css-color.ts — a CSS colour as #rrggbb (his report, 2026-10-05: the web
 * terminal died with `Unexpected fillStyle color format "oklch(…)"`).
 *
 * The theme tokens are oklch() since the type-system refactor; xterm's canvas
 * renderer reads its theme colours back off a 2D context and only knows `#`
 * and `rgba(` — an oklch token throws inside its glyph cache, which the page
 * surfaces as an uncaught error. So every colour handed to xterm goes through
 * here first: hex stays hex; anything else is painted onto a 1×1 canvas and
 * read back as bytes, which works for every format the browser can paint.
 */

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;

/** rgb bytes → #rrggbb. Pure; tested. */
export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** A colour the canvas can paint, as #rrggbb; `fallback` when it cannot be
 *  resolved (no canvas, an unpaintable string). Alpha is dropped — xterm's
 *  theme colours are opaque; selection alpha is appended by the caller. */
export function cssColorToHex(color: string, fallback: string): string {
  const c = (color || "").trim();
  if (HEX6.test(c)) return c.toLowerCase();
  const m3 = HEX3.exec(c);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toLowerCase();
  if (!c || typeof document === "undefined") return fallback;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return fallback;
    ctx.fillStyle = "#000000";
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return rgbToHex(r, g, b);
  } catch {
    return fallback;
  }
}
