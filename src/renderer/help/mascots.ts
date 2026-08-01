/**
 * mascots — the Glyphh cat's little siblings.
 *
 * The brand mark is an angular cat: sharp ears, a body tapering to a point,
 * a flick of tail. Every character keeps that DNA and breaks it somewhere
 * different — the shape of the head, the ears, the eyes, the tail. No props,
 * no badges: they are told apart by build and expression alone, the way
 * characters are. What makes them a cast is the shared finish — a top-lit
 * gradient body, glossy eyes with a glint, and a soft floor shadow.
 *
 * Each has a name, and the name is shown beside them.
 */

export type MascotKey = "scout" | "byte" | "post" | "patch" | "sage" | "tally";

export interface Mascot {
  /** The character's name — rendered beside them. */
  name: string;
  /** Which drawing to use. */
  key: MascotKey;
  /** Their colour: the light end of the body gradient. */
  color: string;
}

const W = "#fff";
const K = "#0b0a0f";

/** The shared finish: a top-lit body gradient + a soft floor shadow. Ids are
 *  suffixed per character so six of them can share one document. */
function shell(key: MascotKey, color: string, inner: string): string {
  return (
    `<defs>` +
    `<linearGradient id="mg-${key}" x1="0" y1="0" x2="0.35" y2="1">` +
    `<stop offset="0" stop-color="${W}" stop-opacity="0.34"/>` +
    `<stop offset="0.42" stop-color="${W}" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="${K}" stop-opacity="0.34"/>` +
    `</linearGradient>` +
    `<radialGradient id="ms-${key}" cx="0.5" cy="0.5" r="0.5">` +
    `<stop offset="0" stop-color="${K}" stop-opacity="0.5"/>` +
    `<stop offset="1" stop-color="${K}" stop-opacity="0"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<ellipse cx="24" cy="45" rx="12" ry="2.6" fill="url(#ms-${key})"/>` +
    inner
  );
}

/** One glossy eye — white, dark pupil, a glint. */
function eye(cx: number, cy: number, rx: number, ry: number, color: string): string {
  return (
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${W}"/>` +
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${color}" stroke-opacity="0.35" stroke-width="0.9"/>` +
    `<circle cx="${cx + rx * 0.3}" cy="${cy + ry * 0.12}" r="${rx * 0.46}" fill="${K}"/>` +
    `<circle cx="${cx + rx * 0.06}" cy="${cy - ry * 0.4}" r="${rx * 0.18}" fill="${W}"/>`
  );
}

/** The normal pair of eyes (the brand cat is a cyclops; the siblings are
 *  not) — two glossy eyes looking the same way. */
function eyes(cy: number, color: string, r = 4.4): string {
  return eye(17.6, cy, r, r * 1.06, color) + eye(29.2, cy, r, r * 1.06, color);
}

/** Body path + the shared gradient wash over it. */
const lit = (key: MascotKey, d: string, color: string): string =>
  `<path d="${d}" fill="${color}"/><path d="${d}" fill="url(#mg-${key})"/>`;

const CHARACTERS: Record<MascotKey, (c: string) => string> = {
  // SCOUT — lean and alert: the tallest spike ears, a narrow face.
  scout: (c) => shell("scout", c,
    `<path d="M31.6 40 Q41.4 39.2 41.8 30.6" fill="none" stroke="${c}" stroke-width="3.2" stroke-linecap="round"/>` +
    lit("scout", "M14 1.6 L19.4 18.4 Q24 17 28.6 18.4 L34 1.6 L35.4 26.6 Q35.4 37 24 44.8 Q12.6 37 12.6 26.6 Z", c) +
    eyes(26, c, 4.1)),

  // BYTE — built square: clipped ears, blocky head, pixel eyes, zigzag tail.
  byte: (c) => shell("byte", c,
    `<path d="M31.4 40.4 L36.4 37.6 L32.8 34.6 L38.4 31.4" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` +
    lit("byte", "M10.5 3.6 L17.4 13.4 L30.6 13.4 L37.5 3.6 L39.4 15.6 Q40 20 40 26 Q40 36.8 24 44.8 Q8 36.8 8 26 Q8 20 8.6 15.6 Z", c) +
    `<rect x="13.6" y="21" width="8.4" height="8.4" rx="2" fill="${W}"/>` +
    `<rect x="26" y="21" width="8.4" height="8.4" rx="2" fill="${W}"/>` +
    `<rect x="17" y="24.2" width="3.4" height="3.4" rx="0.8" fill="${K}"/>` +
    `<rect x="29.4" y="24.2" width="3.4" height="3.4" rx="0.8" fill="${K}"/>`),

  // POST — the round friendly one: tufted ears, the widest eyes, a curl
  // of tail.
  post: (c) => shell("post", c,
    `<path d="M33.6 39.4 Q42.6 39 41.4 32.2 Q40.6 28.4 36.4 30.2" fill="none" stroke="${c}" stroke-width="3.1" stroke-linecap="round"/>` +
    lit("post", "M14 8.6 Q10.4 2.6 16 4.8 L20.4 9.2 Q24 8.3 27.6 9.2 L32 4.8 Q37.6 2.6 34 8.6 Q40.6 14.6 40.6 26 Q40.6 37 24 44.8 Q7.4 37 7.4 26 Q7.4 14.6 14 8.6 Z", c) +
    eyes(25, c, 4.8)),

  // PATCH — scrappy: one ear folded over, a permanent wink, a stub of
  // tail.
  patch: (c) => shell("patch", c,
    `<path d="M32 42.2 Q37.8 42 37.6 37.2" fill="none" stroke="${c}" stroke-width="3.2" stroke-linecap="round"/>` +
    lit("patch", "M10 4 L18 17.8 Q24 16.2 30 17.8 L38 3.6 L39 26 Q39 36.8 24 44.8 Q9 36.8 9 26 Z", c) +
    `<path d="M10 4 L17.4 12.4 L9.2 13.6 Z" fill="${K}" fill-opacity="0.3"/>` +
    eye(17.6, 24.8, 4.4, 4.7, c) +
    `<path d="M25.8 24.8 Q29.2 22.2 32.6 24.8" fill="none" stroke="${W}" stroke-width="2.2" stroke-linecap="round"/>`),

  // SAGE — leaning back, both eyes half-closed, a long S of tail.
  sage: (c) => shell("sage", c,
    `<path d="M30.6 40.6 Q41.6 41.4 40.4 33.4 Q39.4 27.6 34 29.8" fill="none" stroke="${c}" stroke-width="3.1" stroke-linecap="round"/>` +
    `<g transform="rotate(-7 24 26)">` +
    lit("sage", "M12 4 L19 18 Q24 16.4 29 18 L36 4 L37 26 Q37 36.8 24 44.8 Q11 36.8 11 26 Z", c) +
    `<path d="M13.2 25.2 Q17.6 20.4 22 25.2 Q17.6 28.8 13.2 25.2 Z" fill="${W}"/>` +
    `<path d="M26 25.2 Q30.4 20.4 34.8 25.2 Q30.4 28.8 26 25.2 Z" fill="${W}"/>` +
    `<circle cx="18.4" cy="24.4" r="1.9" fill="${K}"/>` +
    `<circle cx="31.2" cy="24.4" r="1.9" fill="${K}"/>` +
    `</g>`),

  // TALLY — the symmetrical one: even ears, a perfectly level gaze.
  tally: (c) => shell("tally", c,
    `<path d="M31.4 41 Q39.8 41 39.6 33.6" fill="none" stroke="${c}" stroke-width="3.2" stroke-linecap="round"/>` +
    lit("tally", "M8.4 7.6 L18.6 17.4 Q24 16 29.4 17.4 L39.6 7.6 L40.4 26 Q40.4 36.8 24 44.8 Q7.6 36.8 7.6 26 Z", c) +
    eyes(25.4, c, 4.6)),
};

/** One mascot as inline SVG, sized by CSS (the box is square). */
export function mascotSvg(m: Mascot): string {
  return `<svg viewBox="0 0 48 48" role="img" aria-label="${m.name}">${CHARACTERS[m.key](m.color)}</svg>`;
}
