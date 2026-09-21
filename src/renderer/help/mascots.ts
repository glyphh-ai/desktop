/**
 * mascots — the Glyphh mark's alien cousins.
 *
 * The brand mark is not a cute cat: it is an angular, one-eyed ALIEN — two
 * uneven ear spikes, a body tapering to a point, a flick of tail, and a wide
 * ring eye set off-centre. Every character here is built on that structure
 * and mutates it the way a species varies: the number and shape of the eyes,
 * the ear spikes, the antennae, the tail. No props, no badges — the
 * silhouette does the work.
 *
 * What makes them a cast is the shared finish: a top-lit gradient body, ring
 * eyes with a glint, thin dark feelers, and a soft floor shadow.
 */

export type MascotKey =
  | "scout" | "byte" | "post" | "patch" | "sage" | "tally"
  // Time-of-day cousins — same creature, one readable prop or expression each.
  | "morning" | "lunch" | "afternoon" | "evening" | "latenight";

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

/** Stable per-character jitter — the feelers differ but never move. */
function rng(key: string): () => number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 4294967296;
  };
}

/** The shared finish: a top-lit body gradient + a soft floor shadow. */
function shell(key: MascotKey, inner: string): string {
  return (
    `<defs>` +
    `<linearGradient id="mg-${key}" x1="0" y1="0" x2="0.3" y2="1">` +
    `<stop offset="0" stop-color="${W}" stop-opacity="0.36"/>` +
    `<stop offset="0.44" stop-color="${W}" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="${K}" stop-opacity="0.36"/>` +
    `</linearGradient>` +
    `<radialGradient id="ms-${key}" cx="0.5" cy="0.5" r="0.5">` +
    `<stop offset="0" stop-color="${K}" stop-opacity="0.5"/>` +
    `<stop offset="1" stop-color="${K}" stop-opacity="0"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<ellipse cx="24" cy="45.4" rx="11" ry="2.4" fill="url(#ms-${key})"/>` +
    inner
  );
}

/** Body path + the gradient wash over it. */
const lit = (key: MascotKey, d: string, c: string): string =>
  `<path d="${d}" fill="${c}"/><path d="${d}" fill="url(#mg-${key})"/>`;

/** The mark's eye: a white ring with the pupil set off-centre. */
function ringEye(cx: number, cy: number, r: number, ox = 0.34): string {
  return (
    `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r * 1.12}" fill="${W}"/>` +
    `<circle cx="${cx + r * ox}" cy="${cy + r * 0.14}" r="${r * 0.47}" fill="${K}"/>` +
    `<circle cx="${cx - r * 0.22}" cy="${cy - r * 0.46}" r="${r * 0.16}" fill="${W}"/>`
  );
}

/** A slit-pupil eye — same white, a horizontal bar instead of a dot. */
function slitEye(cx: number, cy: number, r: number): string {
  return (
    `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r * 1.1}" fill="${W}"/>` +
    `<rect x="${cx - r * 0.62}" y="${cy - r * 0.24}" width="${r * 1.24}" height="${r * 0.48}" rx="${r * 0.24}" fill="${K}"/>`
  );
}

/** A squared "pixel" eye. */
const boxEye = (x: number, y: number, w: number, h: number): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w * 0.24}" fill="${W}"/>` +
  `<rect x="${x + w * 0.28}" y="${y + h * 0.3}" width="${w * 0.42}" height="${h * 0.4}" rx="${w * 0.12}" fill="${K}"/>`;

/** A half-lidded eye. */
const lidEye = (cx: number, cy: number, r: number): string =>
  `<path d="M${cx - r} ${cy} Q${cx} ${cy - r * 1.25} ${cx + r} ${cy} Q${cx} ${cy + r * 0.72} ${cx - r} ${cy} Z" fill="${W}"/>` +
  `<circle cx="${cx + r * 0.16}" cy="${cy - r * 0.14}" r="${r * 0.3}" fill="${K}"/>`;

/**
 * Thin dark feelers, jittered per character — the alien answer to whiskers.
 * Short, black, and never symmetrical.
 */
function feelers(key: MascotKey, y: number, count = 2): string {
  const r = rng(key);
  const out: string[] = [];
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < count; i++) {
      const y0 = y + i * (2.6 + r() * 1.2) - 0.8;
      const len = 5.4 + r() * 3.2;
      const rise = (r() - 0.5) * 3.4;
      const x0 = side < 0 ? 13.8 : 34.2;
      out.push(`<line x1="${x0}" y1="${y0.toFixed(1)}" x2="${(x0 + side * len).toFixed(1)}" y2="${(y0 + rise).toFixed(1)}"/>`);
    }
  }
  return `<g stroke="${K}" stroke-opacity="0.7" stroke-width="1" stroke-linecap="round">${out.join("")}</g>`;
}

/** A small alien mouth — a slit, not a smile. */
const mouth = (y: number, w = 4.4, curve = 1.4): string =>
  `<path d="M${24 - w} ${y} Q24 ${y + curve} ${24 + w} ${y}" fill="none" stroke="${K}" stroke-opacity="0.75" stroke-width="1.3" stroke-linecap="round"/>`;

const CHARACTERS: Record<MascotKey, (c: string) => string> = {
  // SCOUT — the one true cyclops, closest to the mark itself: a single wide
  // ring eye, narrow build, two bulbed antennae.
  scout: (c) => shell("scout",
    `<path d="M31.4 39.6 Q41.2 38.8 41.6 30.2" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>` +
    `<g stroke="${c}" stroke-width="1.6" stroke-linecap="round">` +
    `<line x1="16.4" y1="6" x2="12.8" y2="1.4"/><line x1="30.6" y1="5.4" x2="35.2" y2="2.2"/></g>` +
    `<circle cx="12.8" cy="1.4" r="1.7" fill="${c}"/><circle cx="35.2" cy="2.2" r="1.4" fill="${c}"/>` +
    lit("scout", "M13.4 4.6 L19.2 18.6 Q24 17.2 28.4 18.4 L34.4 5.6 L36 26.4 Q35.6 37 24 44.8 Q12.8 37 12.4 26.6 Z", c) +
    ringEye(24, 24.6, 7.4) +
    feelers("scout", 33.6) + mouth(37, 3.2)),

  // BYTE — clipped flat top, THREE pixel eyes in a row, a zigzag tail.
  byte: (c) => shell("byte",
    `<path d="M31.2 40.2 L36.2 37.4 L32.6 34.4 L38.2 31.2" fill="none" stroke="${c}" stroke-width="2.9" stroke-linecap="round" stroke-linejoin="round"/>` +
    lit("byte", "M10.6 4.2 L16.8 13.6 L31.2 13.6 L37.4 4.2 L39.2 16 Q39.8 20 39.8 26 Q39.8 36.8 24 44.8 Q8.2 36.8 8.2 26 Q8.2 20 8.8 16 Z", c) +
    boxEye(12.4, 21.6, 7, 7.8) +
    boxEye(21.2, 20.4, 5.6, 6) +
    boxEye(28.6, 21.6, 7, 7.8) +
    mouth(34, 5, 0.5)),

  // POST — wide-set huge ring eyes, ear nubs, one curled antenna.
  post: (c) => shell("post",
    `<path d="M33.2 39 Q42.2 38.6 41 32 Q40.2 28.2 36 30" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>` +
    `<path d="M29 5.8 Q31.8 -0.2 36 3 Q38.4 4.8 36.2 6.6" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>` +
    lit("post", "M14.6 9 Q11.6 3.4 16.6 5.4 L20.6 9.6 Q24 8.8 27.4 9.6 L31.4 5.4 Q36.4 3.4 33.4 9 Q40 15 40 26 Q40 37 24 44.8 Q8 37 8 26 Q8 15 14.6 9 Z", c) +
    ringEye(17.6, 24.6, 5.9, 0.3) +
    ringEye(30.4, 24.6, 5.9, 0.3) +
    feelers("post", 33.4) + mouth(35.6, 3.6, 1.9)),

  // PATCH — a torn ear, two mismatched eyes, a scar, a stub of tail.
  patch: (c) => shell("patch",
    `<path d="M31.6 42 Q37.4 41.8 37.2 37" fill="none" stroke="${c}" stroke-width="3.1" stroke-linecap="round"/>` +
    lit("patch", "M10.4 4.6 L15.2 11.4 L12.6 12.6 L18.6 18.2 Q24 16.8 29.6 18.2 L38 3.8 L38.8 26 Q38.8 36.8 24 44.8 Q9.2 36.8 9.2 26 Z", c) +
    ringEye(18.8, 25.2, 5.7) +
    ringEye(30, 26, 3.5, 0.26) +
    `<line x1="31.6" y1="14.8" x2="35.2" y2="20.2" stroke="${K}" stroke-opacity="0.34" stroke-width="1.5" stroke-linecap="round"/>` +
    feelers("patch", 33.2) + mouth(36, 3.4, -1.1)),

  // SAGE — leaning back, two lidded eyes and a third small one above them.
  sage: (c) => shell("sage",
    `<path d="M30.4 40.4 Q41.4 41.2 40.2 33.2 Q39.2 27.4 33.8 29.6" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>` +
    `<g transform="rotate(-7 24 26)">` +
    lit("sage", "M12.6 4.4 L19.2 18.2 Q24 16.8 28.8 18.2 L35.4 4.4 L36.4 26 Q36.4 36.8 24 44.8 Q11.6 36.8 11.6 26 Z", c) +
    ringEye(24, 17, 2.3, 0) +
    lidEye(18.4, 26.6, 5.2) +
    lidEye(29.6, 26.6, 5.2) +
    `</g>` +
    feelers("sage", 34.2) + mouth(36.6, 3, 0.9)),

  // TALLY — perfectly even: two slit-pupil eyes, two straight antennae.
  tally: (c) => shell("tally",
    `<path d="M31.2 40.8 Q39.6 40.8 39.4 33.4" fill="none" stroke="${c}" stroke-width="3.1" stroke-linecap="round"/>` +
    `<g stroke="${c}" stroke-width="1.5" stroke-linecap="round">` +
    `<line x1="18" y1="6.6" x2="16.8" y2="1.4"/><line x1="30" y1="6.6" x2="31.2" y2="1.4"/></g>` +
    `<circle cx="16.8" cy="1.4" r="1.5" fill="${c}"/><circle cx="31.2" cy="1.4" r="1.5" fill="${c}"/>` +
    lit("tally", "M9.2 7.4 L18.6 17.6 Q24 16.2 29.4 17.6 L38.8 7.4 L39.6 26 Q39.6 36.8 24 44.8 Q8.4 36.8 8.4 26 Z", c) +
    slitEye(18.4, 25.4, 5.5) +
    slitEye(29.6, 25.4, 5.5) +
    feelers("tally", 33.6) + mouth(35.8, 4, 0.4)),

  // MORNING — the scout body, wide awake, cradling a coffee cup with a curl
  // of steam. The cup + handle are stroked in the same colour as the antennae.
  morning: (c) => shell("morning",
    `<path d="M31.4 39.6 Q41.2 38.8 41.6 30.2" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>` +
    `<g stroke="${c}" stroke-width="1.6" stroke-linecap="round">` +
    `<line x1="16.4" y1="6" x2="12.8" y2="1.4"/><line x1="30.6" y1="5.4" x2="35.2" y2="2.2"/></g>` +
    `<circle cx="12.8" cy="1.4" r="1.7" fill="${c}"/><circle cx="35.2" cy="2.2" r="1.4" fill="${c}"/>` +
    lit("morning", "M13.4 4.6 L19.2 18.6 Q24 17.2 28.4 18.4 L34.4 5.6 L36 26.4 Q35.6 37 24 44.8 Q12.8 37 12.4 26.6 Z", c) +
    ringEye(24, 24.6, 7.4) +
    feelers("morning", 33.6) + mouth(37, 3.2) +
    // steam curl
    `<path d="M35.4 27.8 Q37.4 26 36 24.2 Q34.6 22.4 36.6 20.6" fill="none" stroke="${K}" stroke-opacity="0.4" stroke-width="1.2" stroke-linecap="round"/>` +
    // coffee cup + handle, held to the side
    `<path d="M31.6 30 L40.6 30 L39.4 39 Q39 40.6 37 40.6 L34.2 40.6 Q32.2 40.6 31.8 39 Z" fill="${W}"/>` +
    `<path d="M31.6 30 L40.6 30 L39.4 39 Q39 40.6 37 40.6 L34.2 40.6 Q32.2 40.6 31.8 39 Z" fill="none" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<path d="M40.6 31.8 Q43.6 31.8 43.4 34.2 Q43.2 36.4 40.4 36.2" fill="none" stroke="${c}" stroke-width="1.4" stroke-linecap="round"/>`),

  // LUNCH — the scout body over a little food bowl with two rising wisps.
  lunch: (c) => shell("lunch",
    `<path d="M31.4 39.6 Q41.2 38.8 41.6 30.2" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>` +
    `<g stroke="${c}" stroke-width="1.6" stroke-linecap="round">` +
    `<line x1="16.4" y1="6" x2="12.8" y2="1.4"/><line x1="30.6" y1="5.4" x2="35.2" y2="2.2"/></g>` +
    `<circle cx="12.8" cy="1.4" r="1.7" fill="${c}"/><circle cx="35.2" cy="2.2" r="1.4" fill="${c}"/>` +
    lit("lunch", "M13.4 4.6 L19.2 18.6 Q24 17.2 28.4 18.4 L34.4 5.6 L36 26.4 Q35.6 37 24 44.8 Q12.8 37 12.4 26.6 Z", c) +
    ringEye(24, 22.8, 7.2) +
    feelers("lunch", 32.4) + mouth(35, 3.2, 1.8) +
    // rising wisps off the bowl
    `<g stroke="${K}" stroke-opacity="0.36" stroke-width="1.1" stroke-linecap="round">` +
    `<path d="M20.4 39.6 Q19.2 38.2 20.4 36.8" fill="none"/>` +
    `<path d="M27.6 39.6 Q28.8 38.2 27.6 36.8" fill="none"/></g>` +
    // bowl: a rounded half-ellipse with a lip
    `<path d="M15 41 A9 6 0 0 0 33 41 Z" fill="${W}"/>` +
    `<path d="M15 41 A9 6 0 0 0 33 41" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/>` +
    `<line x1="14" y1="41" x2="34" y2="41" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/>`),

  // AFTERNOON — bright + alert: wide-open ring eye under a little sun arc
  // with rays, riding high behind the ears.
  afternoon: (c) => shell("afternoon",
    // sun arc + rays, top-right
    `<path d="M37 9 A5.4 5.4 0 0 0 27.6 12.6" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round"/>` +
    `<g stroke="${c}" stroke-opacity="0.8" stroke-width="1.2" stroke-linecap="round">` +
    `<line x1="32.4" y1="1.6" x2="32.4" y2="3.6"/><line x1="40.8" y1="5" x2="39.4" y2="6.4"/>` +
    `<line x1="43.4" y1="12.4" x2="41.4" y2="12.4"/><line x1="24.6" y1="5.6" x2="26" y2="7"/></g>` +
    `<path d="M31.4 39.6 Q41.2 38.8 41.6 30.2" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>` +
    `<g stroke="${c}" stroke-width="1.6" stroke-linecap="round">` +
    `<line x1="16.4" y1="6" x2="12.8" y2="1.4"/></g>` +
    `<circle cx="12.8" cy="1.4" r="1.7" fill="${c}"/>` +
    lit("afternoon", "M13.4 4.6 L19.2 18.6 Q24 17.2 28.4 18.4 L34.4 5.6 L36 26.4 Q35.6 37 24 44.8 Q12.8 37 12.4 26.6 Z", c) +
    ringEye(24, 25, 7.8, 0.28) +
    feelers("afternoon", 34) + mouth(37.4, 3.6, 1.9)),

  // EVENING — the scout body wearing a little pointed nightcap with a pom,
  // eye half-open, winding down.
  evening: (c) => shell("evening",
    lit("evening", "M13.4 4.6 L19.2 18.6 Q24 17.2 28.4 18.4 L34.4 5.6 L36 26.4 Q35.6 37 24 44.8 Q12.8 37 12.4 26.6 Z", c) +
    // nightcap: a drooping pointed cone with a band, pom on the tip
    `<path d="M12.8 8.4 Q24 -1.2 34.6 6 Q40 9.6 43 4.6" fill="${W}"/>` +
    `<path d="M12.8 8.4 Q24 -1.2 34.6 6 Q40 9.6 43 4.6" fill="none" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<path d="M12.4 8.6 Q24 12 35 7.4" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>` +
    `<circle cx="43.4" cy="4.2" r="2.2" fill="${W}"/>` +
    `<circle cx="43.4" cy="4.2" r="2.2" fill="none" stroke="${c}" stroke-width="1.3"/>` +
    ringEye(24, 26, 6.6) +
    feelers("evening", 34.4) + mouth(37, 3, 1)),

  // LATENIGHT — asleep: a lidded eye and a small "z z z" trailing off.
  latenight: (c) => shell("latenight",
    `<path d="M31.4 39.6 Q41.2 38.8 41.6 30.2" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>` +
    `<g stroke="${c}" stroke-width="1.6" stroke-linecap="round">` +
    `<line x1="16.4" y1="6" x2="12.8" y2="1.4"/><line x1="30.6" y1="5.4" x2="35.2" y2="2.2"/></g>` +
    `<circle cx="12.8" cy="1.4" r="1.7" fill="${c}"/><circle cx="35.2" cy="2.2" r="1.4" fill="${c}"/>` +
    lit("latenight", "M13.4 4.6 L19.2 18.6 Q24 17.2 28.4 18.4 L34.4 5.6 L36 26.4 Q35.6 37 24 44.8 Q12.8 37 12.4 26.6 Z", c) +
    lidEye(24, 25.6, 7) +
    feelers("latenight", 33.6) + mouth(37.4, 3, -0.6) +
    // z z z, rising to the right
    `<g fill="none" stroke="${c}" stroke-opacity="0.85" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M33.6 20 L37 20 L33.6 24 L37 24"/>` +
    `<path d="M38.4 13.4 L41.2 13.4 L38.4 16.6 L41.2 16.6"/>` +
    `<path d="M42.4 8 L44.6 8 L42.4 10.6 L44.6 10.6"/></g>`),
};

/** The accent colour these cousins wear — theme-aligned, follows --accent. */
const ACCENT = "var(--accent, #af5fff)";

/** Local-hour → time-of-day mascot. Buckets: 5–10 morning, 10–14 lunch,
 * 14–17 afternoon, 17–22 evening, else latenight. Returns the SVG string. */
export function timeMascotSvg(hour: number = new Date().getHours()): string {
  let key: MascotKey;
  if (hour >= 5 && hour < 10) key = "morning";
  else if (hour >= 10 && hour < 14) key = "lunch";
  else if (hour >= 14 && hour < 17) key = "afternoon";
  else if (hour >= 17 && hour < 22) key = "evening";
  else key = "latenight";
  // Guard: if the bucket logic ever falls through, land on the true cyclops.
  const draw = CHARACTERS[key] ?? CHARACTERS.scout;
  return `<svg viewBox="0 0 48 48" role="img" aria-label="${key}">${draw(ACCENT)}</svg>`;
}

/** One mascot as inline SVG, sized by CSS (the box is square). */
export function mascotSvg(m: Mascot): string {
  return `<svg viewBox="0 0 48 48" role="img" aria-label="${m.name}">${CHARACTERS[m.key](m.color)}</svg>`;
}

/** The Glyphh loop's own face: the brand mascot in the brand purple. Used
 *  wherever a loop wears a CLI mark (rail tiles, session rows, loop dropdown). */
export const GLYPHH_LOOP_MASCOT: Mascot = { name: "Glyphh", key: "scout", color: "#8c3bf2" };

/** The mascot as an <img>-safe data URL — the mark caches key CLIs to data
 *  URLs, so the Glyphh loop slots in beside the vendor favicons. An <img>
 *  needs the SVG namespace, which inline markup does not. */
export function glyphhLoopMarkUrl(): string {
  const svg = mascotSvg(GLYPHH_LOOP_MASCOT).replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
