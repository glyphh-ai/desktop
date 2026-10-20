/**
 * slides/chart-svg.ts — a tiny, dependency-free SVG chart renderer for the
 * `chart` slide layout. Pure string output (no runtime JS), so it survives the
 * structure lock and prints/exports identically. Colours come from the theme
 * via `currentColor` + the `--slide-*` vars the caller passes as inline fills.
 */

import { esc, s } from "./util.js";

export interface ChartPoint { label: string; value: number }
export type SlideChartType = "bar" | "line" | "area" | "pie";

const PALETTE = [
  "var(--slide-accent)", "var(--slide-accent2)", "#f0a63d", "#38bdf8",
  "#f472b6", "#a3e635", "#c4c4c4", "#fb7185",
];

function coerce(points: unknown): ChartPoint[] {
  if (!Array.isArray(points)) return [];
  return points
    .map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      const value = Number(o.value ?? o.y ?? o.n ?? 0);
      return { label: s(o.label ?? o.name ?? o.x ?? ""), value: Number.isFinite(value) ? value : 0 };
    })
    .filter((p) => p.label !== "" || p.value !== 0);
}

/** Render a chart to an `<svg>` string sized to a 1600×620 viewBox (the layout
 *  scales it to fit). `type` defaults to bar. */
export function renderSlideChart(type: SlideChartType, points: unknown): string {
  const data = coerce(points);
  if (!data.length) return "";
  if (type === "pie") return pie(data);
  const W = 1600, H = 620, padL = 90, padB = 70, padT = 30, padR = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(1, ...data.map((d) => d.value));
  const min = Math.min(0, ...data.map((d) => d.value));
  const span = max - min || 1;
  const y = (v: number): number => padT + plotH - ((v - min) / span) * plotH;
  const n = data.length;

  // gridlines + y labels (4 steps)
  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const v = min + (span * g) / 4;
    const gy = y(v);
    grid += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="var(--slide-border)" stroke-width="1"/>`;
    grid += `<text x="${padL - 18}" y="${(gy + 8).toFixed(1)}" text-anchor="end" font-family="var(--slide-font-mono)" font-size="24" fill="var(--slide-muted)">${fmt(v)}</text>`;
  }

  let body = "";
  if (type === "bar") {
    const slot = plotW / n, bw = Math.min(slot * 0.56, 160);
    body = data.map((d, i) => {
      const cx = padL + slot * i + slot / 2;
      const top = y(d.value), base = y(0);
      const yy = Math.min(top, base), hh = Math.abs(base - top);
      return `<rect x="${(cx - bw / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(2, hh).toFixed(1)}" rx="8" fill="var(--slide-accent)"/>`;
    }).join("");
  } else {
    const slot = plotW / Math.max(1, n - 1 || 1);
    const pts = data.map((d, i) => `${(padL + slot * i).toFixed(1)},${y(d.value).toFixed(1)}`);
    if (type === "area") {
      body += `<polygon points="${padL},${y(min).toFixed(1)} ${pts.join(" ")} ${(padL + slot * (n - 1)).toFixed(1)},${y(min).toFixed(1)}" fill="var(--slide-accent)" opacity="0.16"/>`;
    }
    body += `<polyline points="${pts.join(" ")}" fill="none" stroke="var(--slide-accent)" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>`;
    body += data.map((d, i) => `<circle cx="${(padL + slot * i).toFixed(1)}" cy="${y(d.value).toFixed(1)}" r="9" fill="var(--slide-accent)"/>`).join("");
  }

  const labels = data.map((d, i) => {
    const slot = type === "bar" ? plotW / n : plotW / Math.max(1, n - 1 || 1);
    const cx = type === "bar" ? padL + slot * i + slot / 2 : padL + slot * i;
    return `<text x="${cx.toFixed(1)}" y="${H - padB + 44}" text-anchor="middle" font-family="var(--slide-font-body)" font-size="26" fill="var(--slide-muted)">${esc(d.label)}</text>`;
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">${grid}${body}${labels}</svg>`;
}

function pie(data: ChartPoint[]): string {
  const total = data.reduce((a, d) => a + Math.max(0, d.value), 0) || 1;
  const cx = 310, cy = 310, r = 280;
  let a0 = -Math.PI / 2;
  const arcs = data.map((d, i) => {
    const frac = Math.max(0, d.value) / total;
    const a1 = a0 + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    a0 = a1;
    const fill = PALETTE[i % PALETTE.length];
    return `<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${fill}"/>`;
  }).join("");
  const legend = data.map((d, i) => {
    const fill = PALETTE[i % PALETTE.length];
    const pct = Math.round((Math.max(0, d.value) / total) * 100);
    const yy = 90 + i * 70;
    return `<rect x="700" y="${yy - 26}" width="34" height="34" rx="8" fill="${fill}"/><text x="752" y="${yy}" font-family="var(--slide-font-body)" font-size="34" fill="var(--slide-fg)">${esc(d.label)}<tspan fill="var(--slide-muted)">  ${pct}%</tspan></text>`;
  }).join("");
  return `<svg viewBox="0 0 1400 620" preserveAspectRatio="xMidYMid meet" role="img">${arcs}${legend}</svg>`;
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(v * 100) / 100);
}
