/**
 * sheets-charts.ts — render a workbook ChartSpec to a self-contained SVG
 * string. Pure (no DOM, no deps): the panel injects it read-only, and the XLSX/
 * PDF export embeds the SAME string, so a chart looks identical everywhere.
 *
 * Data is pulled from the sheet by A1 range (categoriesRef + series valuesRef)
 * through the shared engine's cell reader, so charts always reflect the latest
 * recalculated values.
 */

import { cellValue, parseA1, type ChartSpec, type Workbook, type Worksheet } from "./sheets-engine";

const PALETTE = ["#af5fff", "#38bdf8", "#f0a63d", "#2dd4bf", "#f472b6", "#a3e635", "#fb7185", "#c9a2ff"];

const esc = (s: unknown): string => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function sheetByName(wb: Workbook, name: string | undefined, fallback: Worksheet): Worksheet {
  if (!name) return fallback;
  return wb.sheets.find((s) => s.name.toLowerCase() === name.toLowerCase()) ?? fallback;
}

/** Read an A1 range into a flat value list (row-major). */
function readRange(sheet: Worksheet, ref: string): Array<string | number | null> {
  const [a, b] = ref.split(":");
  const ra = parseA1(a ?? "");
  const rb = parseA1(b ?? a ?? "");
  if (!ra || !rb) return [];
  const out: Array<string | number | null> = [];
  for (let r = Math.min(ra.row, rb.row); r <= Math.max(ra.row, rb.row); r++)
    for (let c = Math.min(ra.col, rb.col); c <= Math.max(ra.col, rb.col); c++)
      out.push(cellValue(sheet.rows[r]?.[c] ?? null));
  return out;
}

const numOf = (v: string | number | null): number => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,%]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** Render a chart to an `<svg>` string. `dark` picks label colours. */
export function renderChartSVG(wb: Workbook, sheet: Worksheet, spec: ChartSpec, dark = true): string {
  const src = sheetByName(wb, spec.sheet, sheet);
  const cats = spec.categoriesRef ? readRange(src, spec.categoriesRef).map((v) => String(v ?? "")) : [];
  const series = (spec.series ?? []).map((s, i) => ({
    name: s.name ?? `Series ${i + 1}`,
    color: s.color ?? spec.colors?.[i] ?? PALETTE[i % PALETTE.length]!,
    type: s.type ?? spec.type,
    values: readRange(src, s.valuesRef).map(numOf),
  })).filter((s) => s.values.length);
  if (!series.length) return "";

  const W = spec.size?.w ?? 640, H = spec.size?.h ?? 360;
  const axis = dark ? "#8e8e9c" : "#6b6b76", grid = dark ? "#2a2a31" : "#e4e4ea";

  if (spec.type === "pie") return pie(W, H, series[0]!, cats, axis);

  const padL = 54, padB = 40, padT = 16, padR = 14;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const allVals = series.flatMap((s) => s.values);
  const max = Math.max(1, ...allVals), min = Math.min(0, ...allVals);
  const span = max - min || 1;
  const y = (v: number): number => padT + plotH - ((v - min) / span) * plotH;
  const len = Math.max(...series.map((s) => s.values.length));

  let g = "";
  for (let t = 0; t <= 4; t++) {
    const v = min + (span * t) / 4, gy = y(v);
    g += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="${grid}" stroke-width="1"/>`;
    g += `<text x="${padL - 8}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${axis}">${fmt(v)}</text>`;
  }

  let body = "";
  const isBar = (t?: string): boolean => t === "bar" || (t === undefined && spec.type === "bar");
  const barSeries = series.filter((s) => isBar(s.type));
  const lineSeries = series.filter((s) => !isBar(s.type));
  if (barSeries.length) {
    const slot = plotW / len, groupW = slot * 0.7, bw = groupW / barSeries.length;
    barSeries.forEach((s, si) => {
      s.values.forEach((val, k) => {
        const x = padL + slot * k + (slot - groupW) / 2 + bw * si;
        const top = y(val), base = y(0);
        body += `<rect x="${x.toFixed(1)}" y="${Math.min(top, base).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${Math.max(1, Math.abs(base - top)).toFixed(1)}" rx="2" fill="${s.color}"/>`;
      });
    });
  }
  lineSeries.forEach((s) => {
    const slot = plotW / Math.max(1, len - 1 || 1);
    const pts = s.values.map((v, k) => `${(padL + slot * k).toFixed(1)},${y(v).toFixed(1)}`);
    if (s.type === "area") body += `<polygon points="${padL},${y(min).toFixed(1)} ${pts.join(" ")} ${(padL + slot * (s.values.length - 1)).toFixed(1)},${y(min).toFixed(1)}" fill="${s.color}" opacity="0.15"/>`;
    body += `<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round"/>`;
  });

  const labels = cats.slice(0, len).map((c, k) => {
    const slot = barSeries.length ? plotW / len : plotW / Math.max(1, len - 1 || 1);
    const x = barSeries.length ? padL + slot * k + slot / 2 : padL + slot * k;
    return `<text x="${x.toFixed(1)}" y="${H - padB + 18}" text-anchor="middle" font-size="11" fill="${axis}">${esc(c)}</text>`;
  }).join("");

  const title = spec.title ? `<text x="${padL}" y="12" font-size="13" font-weight="600" fill="${dark ? "#f1f1f1" : "#16161a"}">${esc(spec.title)}</text>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" font-family="Inter,system-ui,sans-serif">${title}${g}${body}${labels}</svg>`;
}

function pie(W: number, H: number, s: { color: string; values: number[] }, cats: string[], axis: string): string {
  const total = s.values.reduce((a, v) => a + Math.max(0, v), 0) || 1;
  const cx = H / 2, cy = H / 2, r = H / 2 - 20;
  let a0 = -Math.PI / 2, arcs = "";
  s.values.forEach((v, i) => {
    const frac = Math.max(0, v) / total, a1 = a0 + frac * Math.PI * 2, large = frac > 0.5 ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    a0 = a1;
    arcs += `<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${PALETTE[i % PALETTE.length]}"/>`;
  });
  const legend = cats.map((c, i) => `<rect x="${H + 6}" y="${18 + i * 22}" width="12" height="12" rx="2" fill="${PALETTE[i % PALETTE.length]}"/><text x="${H + 24}" y="${28 + i * 22}" font-size="12" fill="${axis}">${esc(c)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" font-family="Inter,system-ui,sans-serif">${arcs}${legend}</svg>`;
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(v * 100) / 100);
}
