/**
 * identicon — deterministic SVG avatar from a string id.
 *
 * 5x5 grid mirrored across the vertical axis. Foreground color and cell fills
 * are derived from a hash of the id, so the same id always renders the same
 * avatar. Used as a fallback when an agent has no `avatar_url`.
 */

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hslColor(seed: number): string {
  const hue = seed % 360;
  const sat = 55 + ((seed >>> 9) % 25);
  const light = 45 + ((seed >>> 17) % 15);
  return `hsl(${hue} ${sat}% ${light}%)`;
}

export function identiconSvg(id: string, size = 32): string {
  const h = fnv1a(id || "anon");
  const fg = hslColor(h);
  const bg = `hsl(${(h >>> 4) % 360} 18% 92%)`;

  const cell = size / 5;
  let cells = "";
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const bit = (h >>> (y * 3 + x)) & 1;
      if (!bit) continue;
      const x1 = x * cell;
      const y1 = y * cell;
      cells += `<rect x="${x1}" y="${y1}" width="${cell}" height="${cell}" fill="${fg}"/>`;
      if (x < 2) {
        const mx = (4 - x) * cell;
        cells += `<rect x="${mx}" y="${y1}" width="${cell}" height="${cell}" fill="${fg}"/>`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet">
    <rect width="${size}" height="${size}" fill="${bg}" rx="${size * 0.15}"/>
    ${cells}
  </svg>`;
}
