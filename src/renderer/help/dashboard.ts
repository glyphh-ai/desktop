/**
 * Dashboard (Home) — the landing section. Shows a welcome, org credit balance,
 * spend this month, apps deployed, and a per-day usage chart (credits + calls;
 * LLM tokens are not a client concept). All numbers come from the server via
 * window.glyphh.dashboardData() (see home-ipc.ts), which mirrors the same
 * billing/usage endpoints the platform dashboard uses.
 */

import { $a, cssVar, escapeHtml, paginate, renderPaginationBar } from "./shared.js";
import { seedNewSession, openRunSession, adoptComposer } from "./code.js";
import { gotoSection } from "./navigation.js";
import { accountApi } from "./settings-api.js";
import { SPACE_LABEL, spacePillHtml, type Space } from "./space-meta.js";
import { mascotSvg, type Mascot } from "./mascots.js";
import { openStarterLayout, type STARTER_LAYOUTS } from "./starter-layouts.js";

// Chart.js is loaded globally (app-libs/chart.js → window.Chart) by home.html.
declare const Chart: any;

interface DashboardData {
  name: string;
  plan: string;           // org tier slug (free / basic / pro / advanced)
  orgCredits: boolean;    // false = org pool is admin-only for this account
  me: {                   // the member's own allocation (role cap + spend)
    roleName?: string | null;
    uncapped?: boolean;
    capCredits?: number | null;
    spentCredits?: number;
    remainingCredits?: number | null;
    windowEnd?: string | null;
  } | null;
  credits: number;        // whole credits available (admins only)
  allowance: number;      // whole credits/month included in the plan
  spendCredits: number;   // whole credits used this calendar month
  requests: number;       // billable calls this month
  appsCount: number;      // apps hosted for this org
}

let chart: { destroy: () => void } | null = null;

export function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : "Welcome back";
}

/** "1,204" for credits/counts. */
function fmtInt(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString();
}

/** Credits — whole numbers get thousands separators; a FRACTION shows one
 *  decimal (sub-credit spend is real: micro-credit metering means "0.2
 *  credits" is the honest number, never a floored 0 beside a floored 49). */
function fmtCredits(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? fmtInt(n) : (Math.round(n * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** "Jul 5" from a "YYYY-MM-DD" bucket (parsed as local, not UTC). */
function shortDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type SeriesPoint = { day: string; key: string; credits: number; requests: number };
type SeriesData = { from: string; to: string; points: SeriesPoint[] };

/** Stable per-key hue — the same name always gets the same color (matches the
 *  agent model badges' scheme). */
function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/** "anthropic::claude-fable-5" → "claude-fable-5" for legend labels. */
function keyLabel(key: string): string {
  const i = key.lastIndexOf("::");
  return i >= 0 ? key.slice(i + 2) : key;
}

/** Every day in [from, to] as YYYY-MM-DD — the API omits empty days. */
function dayRange(from: string, to: string): string[] {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const out: string[] = [];
  const d = new Date(fy!, (fm ?? 1) - 1, fd ?? 1);
  const end = new Date(ty!, (tm ?? 1) - 1, td ?? 1);
  while (d <= end && out.length < 400) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** The stacked usage chart: one bar per day, one colored segment per model (or
 *  source), heaviest spenders stacked first. `only` narrows to a single key. */
function renderChart(series: SeriesData, only: string): void {
  const canvas = $a<HTMLCanvasElement>("dash-usage-chart");
  const empty = document.getElementById("dash-usage-empty");
  if (!canvas || typeof Chart === "undefined") return;

  if (chart) { chart.destroy(); chart = null; }

  const points = only ? series.points.filter((p) => p.key === only) : series.points;
  const hasData = points.some((p) => p.credits > 0 || p.requests > 0);
  empty?.classList.toggle("hidden", hasData);
  canvas.style.visibility = hasData ? "visible" : "hidden";
  if (!hasData) return;

  const days = dayRange(series.from, series.to);
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  // Keys ordered by total spend so the biggest segments sit at the stack's base.
  const totals = new Map<string, number>();
  for (const p of points) totals.set(p.key, (totals.get(p.key) ?? 0) + p.credits);
  const keys = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  const cells = new Map<string, SeriesPoint>();
  for (const p of points) cells.set(`${p.day}|${p.key}`, p);
  const datasets = keys.map((key) => ({
    label: keyLabel(key),
    data: days.map((d) => cells.get(`${d}|${key}`)?.credits ?? 0),
    backgroundColor: `hsl(${hueFor(key)} 62% 52%)`,
    hoverBackgroundColor: `hsl(${hueFor(key)} 62% 60%)`,
    borderRadius: 3,
    maxBarThickness: 34,
    __key: key,
  }));

  const ctx = canvas.getContext("2d")!;
  chart = new Chart(ctx, {
    type: "bar",
    data: { labels: days.map(shortDay), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: keys.length > 1,
          position: "bottom",
          labels: { color: cssVar("--text-3") || "#868686", boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: "circle" },
        },
        tooltip: {
          callbacks: {
            label: (c: { parsed: { y: number }; dataIndex: number; dataset: { label: string; __key: string } }) => {
              const cell = cells.get(`${days[c.dataIndex]}|${c.dataset.__key}`);
              return `${c.dataset.label}: ${fmtCredits(c.parsed.y)} credits${cell ? ` · ${fmtInt(cell.requests)} calls` : ""}`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: cssVar("--text-3") || "#868686", maxRotation: 0, autoSkip: true } },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: cssVar("--border") || "rgba(255,255,255,0.08)" },
          ticks: { color: cssVar("--text-3") || "#868686", callback: (v: number) => fmtCredits(v) },
        },
      },
    },
  });
}

/** Fetch the series per the three dropdowns and repaint the chart + totals. */
/** The chart lives in Settings › Usage now — Settings' loader calls this. */
export async function loadUsageChart(): Promise<void> {
  const daysSel = document.getElementById("dash-usage-days") as HTMLSelectElement | null;
  const groupSel = document.getElementById("dash-usage-group") as HTMLSelectElement | null;
  const filterSel = document.getElementById("dash-usage-filter") as HTMLSelectElement | null;
  const memberSel = document.getElementById("dash-usage-member") as HTMLSelectElement | null;
  // A Members-page "View usage" hand-off pre-narrows the chart to that member
  // (his spec, 2026-08-25). Consumed once; the select then owns the state.
  try {
    const stash = sessionStorage.getItem("glyphhDashMemberFilter");
    if (stash && memberSel) {
      sessionStorage.removeItem("glyphhDashMemberFilter");
      if (!Array.from(memberSel.options).some((o) => o.value === stash)) {
        const o = document.createElement("option");
        o.value = stash;
        o.textContent = "Selected member";
        memberSel.appendChild(o);
      }
      memberSel.value = stash;
    }
  } catch { /* private mode */ }
  const win = parseInt(daysSel?.value || "30", 10);
  const groupBy = groupSel?.value === "source" ? "source" : "model";
  // The member narrowing is org_admin-only; an empty value means "everyone",
  // which is also what a non-admin always sends.
  const env = await window.glyphh.usageSeries?.(win, groupBy, memberSel?.value || "");
  if (!env?.ok || !env.data) return;
  const series = env.data as SeriesData;

  // The narrowing dropdown lists what the window actually contains; a stale
  // selection (model gone from the window) falls back to "all".
  if (filterSel) {
    const prev = filterSel.value;
    const keys = [...new Set(series.points.map((p) => p.key))].sort();
    filterSel.innerHTML = `<option value="">${groupBy === "model" ? "All models" : "All sources"}</option>`;
    for (const k of keys) {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = keyLabel(k);
      filterSel.appendChild(o);
    }
    if (keys.includes(prev)) filterSel.value = prev;
  }
  const only = filterSel?.value || "";

  const shown = only ? series.points.filter((p) => p.key === only) : series.points;
  const credits = shown.reduce((s, p) => s + p.credits, 0);
  const calls = shown.reduce((s, p) => s + p.requests, 0);
  // GUARDED (his report, 2026-09-11): these loaders now run on surfaces
  // where the chart DOM may not exist (web platform) — absent DOM = no-op,
  // never a boot-killing rejection.
  const totalEl = document.getElementById("dash-usage-total");
  const rangeEl = document.getElementById("dash-usage-range");
  if (totalEl) totalEl.textContent = `${fmtCredits(credits)} credits · ${fmtInt(calls)} calls`;
  if (rangeEl) rangeEl.textContent = `last ${win} days`;
  if (!totalEl) return;
  renderChart(series, only);
}

// ── The glyphh.ai desktop page's hero backdrop, ported VERBATIM from the
// web repo's HeroFlow.js (home-refactor branch): flowing data streams —
// animated dashed bezier strokes converging on the center from both edges,
// bright pulses riding some of them, twinkling scatter clusters at the
// stream ends, and a center vignette. Desktop page config exactly:
// mode "converge", purple/amber/pink colors, seed 2025. The background is
// untouched — this draws over whatever is behind it. Self-stops when the
// landing leaves the screen; restarts on the next load. ──
let particlesRaf = 0;
let particlesVariant = "";
let particlesCleanup: (() => void) | null = null;
// Three surfaces, three orientations of the ONE HeroFlow engine (web's
// DashParticles component, verbatim): Work runs "converge" (streams entering
// from both edges, meeting mid-canvas — purple/amber/pink), Chat runs "fall"
// (the CLI page's cascade, streams falling like terminal output — teal/
// emerald), and Code runs "rise" (streams flowing UP). Code is now the ONE
// session type, so its backdrop must match the SPLASH screen's palette exactly
// (index.template.html COLORS/PULSE — light-purple / purple / pink) rather than
// the old per-space greens.
export type FlowVariant = "cowork" | "chat" | "code";
const FLOW_VARIANTS: Record<FlowVariant, { mode: "converge" | "fall" | "rise"; colors: readonly string[]; pulse: string; seed: number }> = {
  cowork: { mode: "converge", colors: ["179, 107, 251", "245, 158, 11", "236, 72, 153"], pulse: "255, 236, 180", seed: 2025 },
  chat: { mode: "fall", colors: ["94, 234, 212", "52, 211, 153", "179, 107, 251"], pulse: "190, 242, 255", seed: 4242 },
  code: { mode: "rise", colors: ["179, 107, 251", "140, 59, 242", "236, 72, 153"], pulse: "255, 236, 180", seed: 1337 },
};

/** Is the ACTIVE theme light? Read from the theme's own --bg rather than a
 *  theme name, so custom/alt themes classify correctly too. The dark vignette
 *  reads as a dirty grey smudge on a light ground — this guard skips it. */
function isLightTheme(): boolean {
  const bg = (getComputedStyle(document.documentElement).getPropertyValue("--bg") || "").trim();
  const m = /^#([0-9a-f]{3,8})$/i.exec(bg) || /rgba?\(([^)]+)\)/i.exec(bg);
  if (!m) return false;
  let r = 0, g = 0, b = 0;
  if (bg.startsWith("#")) {
    const hex = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!.slice(0, 6);
    r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
  } else {
    const parts = m[1]!.split(",").map((v) => parseFloat(v));
    [r, g, b] = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 128;
}

/**
 * Run the HeroFlow engine on ONE canvas for a given variant. Self-contained
 * (own ResizeObserver + RAF), returns a cleanup that stops it. Used by the
 * dashboard singleton (Chat/Work) and the Code landing (its own canvas).
 */
export function runHeroFlow(canvas: HTMLCanvasElement, variantKey: FlowVariant): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => { /* no context — nothing to stop */ };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const V = FLOW_VARIANTS[variantKey];
  const mode: "converge" | "fall" | "rise" = V.mode;
  const COLORS: readonly string[] = V.colors;
  const PULSE = V.pulse;
  const WHITE = "255, 255, 255";
  const N = 28;
  const SEED = V.seed;
  let raf = 0;

  const mulberry = (seed: number): (() => number) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rand = mulberry(SEED);
  interface Scatter { dx: number; dy: number; s: number; a: number; tw: number; tr: number; tint: number }
  interface Stream { y0: number; endX: number; y1: number; mirror: boolean; alpha: number; tint: number; dashSpeed: number; dashPhase: number; pulse: boolean; pSpeed: number; pPhase: number; scatter: Scatter[] }
  const streams: Stream[] = Array.from({ length: N }, (_, i) => {
    const y0 = 0.5 + (rand() - 0.5) * 0.14;
    const endRaw = rand();
    // converge stops mid-canvas so the two sides meet; fall runs most of the way
    const endX = mode === "converge" ? 0.34 + endRaw * 0.28 : 0.42 + endRaw * 0.56;
    const y1 = 0.5 + (rand() - 0.5) * 0.95;
    return {
      y0, endX, y1,
      mirror: mode === "converge" && i % 2 === 1,   // converge: odd streams enter from the far edge
      alpha: 0.12 + rand() * 0.24,
      tint: rand() < 0.72 ? 0 : rand() < 0.6 ? 1 : 2,
      dashSpeed: 0.02 + rand() * 0.05,
      dashPhase: rand() * 40,
      pulse: rand() < 0.5,
      pSpeed: 0.00010 + rand() * 0.00014,
      pPhase: rand(),
      scatter: Array.from({ length: 4 + Math.floor(rand() * 7) }, () => ({
        dx: rand() * 46, dy: (rand() - 0.5) * 26,
        s: 1 + rand() * 2, a: 0.3 + rand() * 0.6,
        tw: rand() * Math.PI * 2, tr: 0.5 + rand() * 1.5,
        tint: rand() < 0.5 ? 0 : rand() < 0.5 ? 2 : 3,
      })),
    };
  });

  let w = 0, h = 0;
  const resize = (): void => {
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = rect.width; h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const ro = new ResizeObserver(resize);
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  resize();

  type Pt = [number, number];
  // fall cascades top-down; rise flows bottom-up; converge runs edge-inward.
  const mapPt = (S: Stream, run: number, fan: number): Pt =>
    mode === "fall" ? [fan * w, run * h]
      : mode === "rise" ? [fan * w, (1 - run) * h]
      : [S.mirror ? (1 - run) * w : run * w, fan * h];
  const ctrl = (S: Stream): [Pt, Pt, Pt, Pt] => [
    mapPt(S, 0, S.y0),
    mapPt(S, S.endX * 0.42, S.y0),
    mapPt(S, S.endX * 0.72, S.y1),
    mapPt(S, S.endX, S.y1),
  ];
  const pointAt = (P: [Pt, Pt, Pt, Pt], t: number): Pt => {
    const u = 1 - t;
    return [
      u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0],
      u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1],
    ];
  };

  const frame = (now: number): void => {
    // Truly removed from the DOM → stop for good + clean up.
    if (!canvas.isConnected) {
      raf = 0;
      ro.disconnect();
      return;
    }
    // Temporarily hidden (an occluding panel, a collapsed/animating layout, a
    // backgrounded tab) or not yet sized → keep the loop ALIVE but skip drawing,
    // so it RESUMES cleanly on re-show instead of FREEZING on a stale, trail-
    // smeared frame (the "locked-up hero" bug). The ResizeObserver stays
    // connected so a resize that happens while hidden still lands.
    if (canvas.offsetParent === null || w === 0 || h === 0) {
      raf = requestAnimationFrame(frame);
      return;
    }
    ctx.clearRect(0, 0, w, h);

    // streams (animated dashes)
    ctx.lineWidth = 1;
    ctx.lineCap = "round";
    for (const S of streams) {
      const P = ctrl(S);
      ctx.setLineDash([2, 5]);
      ctx.lineDashOffset = reduced ? 0 : -(now * S.dashSpeed) - S.dashPhase;
      ctx.strokeStyle = `rgba(${COLORS[S.tint]}, ${S.alpha})`;
      ctx.beginPath();
      ctx.moveTo(P[0][0], P[0][1]);
      ctx.bezierCurveTo(P[1][0], P[1][1], P[2][0], P[2][1], P[3][0], P[3][1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // end scatter clusters + pulses (additive glow)
    ctx.globalCompositeOperation = "lighter";
    for (const S of streams) {
      const P = ctrl(S);
      const ex = P[3][0], ey = P[3][1];
      for (const d of S.scatter) {
        const tw = reduced ? 0.8 : 0.45 + 0.55 * Math.sin(now * 0.0018 * d.tr + d.tw);
        const col = d.tint === 3 ? WHITE : COLORS[d.tint];
        // scatter spreads toward the entering edge for converge, along the
        // flow axis for fall/rise.
        const axisSwap = mode === "fall" || mode === "rise";
        const sx = axisSwap ? d.dy : (S.mirror ? -d.dx : d.dx);
        const sy = axisSwap ? d.dx : d.dy;
        ctx.fillStyle = `rgba(${col}, ${d.a * tw})`;
        ctx.beginPath();
        ctx.arc(ex + sx, ey + sy, d.s / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (S.pulse && !reduced) {
        const t = (now * S.pSpeed + S.pPhase) % 1;
        const [x, y] = pointAt(P, t);
        const g = Math.sin(t * Math.PI);
        ctx.fillStyle = `rgba(${PULSE}, ${0.9 * g})`;
        ctx.shadowColor = `rgba(${COLORS[S.tint]}, 0.9)`;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(x, y, 1.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    ctx.globalCompositeOperation = "source-over";

    // Center vignette so the copy stays legible on a DARK ground. On a LIGHT
    // theme it reads as a dirty grey smudge — skip it entirely there.
    if (!isLightTheme()) {
      const vg = ctx.createRadialGradient(w / 2, h * 0.46, 0, w / 2, h * 0.46, h * 0.62);
      vg.addColorStop(0, "rgba(8, 6, 12, 0.6)");
      vg.addColorStop(0.55, "rgba(8, 6, 12, 0.12)");
      vg.addColorStop(1, "rgba(8, 6, 12, 0)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);
    }

    if (reduced) { raf = 0; return; } // one static frame honors reduced-motion
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => { if (raf) cancelAnimationFrame(raf); raf = 0; ro.disconnect(); };
}

/** The dashboard's Chat/Work singleton — one HeroFlow on #dash-particles,
 *  variant chosen by the active rail space. */
function startDashParticles(): void {
  const canvas = document.getElementById("dash-particles") as HTMLCanvasElement | null;
  if (!canvas || particlesRaf) return;
  const space = document.body.dataset.railSpace;
  const variantKey: FlowVariant = space === "chat" ? "chat" : space === "code" ? "code" : "cowork";
  particlesVariant = variantKey;
  particlesRaf = 1; // mark running (the engine owns its own RAF handle)
  const stop = runHeroFlow(canvas, variantKey);
  particlesCleanup = () => { stop(); particlesRaf = 0; };
}

/** Code's right column: the user's SESSIONS (pending + recent), newest first —
 *  a click resumes one. Reads the live store via the __agentSessions bridge. */
let sessionsPage = 0;
const SESSIONS_PER_PAGE = 15;

function renderSessionsList(): void {
  const host = document.getElementById("dash-sessions-list");
  if (!host) return;
  const api = (window as unknown as {
    __agentSessions?: { list(): Array<{ id: string; title: string; createdAt: number; mode: string; pinned?: boolean }>; switch(id: string): void };
  }).__agentSessions;
  // The column belongs to the ACTIVE space (Work or Code) — PINNED first, then
  // alphabetical by title, paginated. A click opens that agent.
  const space = document.body.dataset.railSpace === "code" ? "code" : "cowork";
  const all = (api?.list() || []).filter((s2) => s2.mode === space)
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
      || (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }));
  const pages = Math.max(1, Math.ceil(all.length / SESSIONS_PER_PAGE));
  if (sessionsPage >= pages) sessionsPage = pages - 1;
  const sessions = all.slice(sessionsPage * SESSIONS_PER_PAGE, (sessionsPage + 1) * SESSIONS_PER_PAGE);
  host.innerHTML = "";
  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "dash-tasks-empty";
    empty.textContent = "No sessions yet — start one below.";
    host.appendChild(empty);
    return;
  }
  for (const sess of sessions) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dash-rec dash-session-row";
    row.innerHTML = `<span class="dash-rec-ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg></span><span class="dash-rec-text"></span><span class="dash-session-when"></span>`;
    (row.querySelector(".dash-rec-text") as HTMLElement).textContent = sess.title || "Untitled session";
    (row.querySelector(".dash-session-when") as HTMLElement).textContent = agoLabel(sess.createdAt);
    row.addEventListener("click", () => api?.switch(sess.id));
    host.appendChild(row);
  }
  if (pages > 1) {
    const pager = document.createElement("div");
    pager.className = "dash-sessions-pager";
    const mk = (label: string, delta: number, disabled: boolean): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "code-icon-btn"; btn.textContent = label;
      btn.disabled = disabled;
      btn.addEventListener("click", () => { sessionsPage += delta; renderSessionsList(); });
      return btn;
    };
    pager.append(mk("‹", -1, sessionsPage === 0));
    const at = document.createElement("span");
    at.className = "dash-sessions-page-at";
    at.textContent = `${sessionsPage + 1} / ${pages}`;
    pager.append(at, mk("›", 1, sessionsPage >= pages - 1));
    host.appendChild(pager);
  }
}

function agoLabel(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Paint the landing's two columns. Home is the ONE landing now:
 *  LEFT = CONTINUE (the user's recent sessions), RIGHT = the cross-agent TASKS
 *  list (scheduled-task runs). */
function paintSpaceColumns(): void {
  // The landing's chrome is CSS-driven off body[data-session-space]; keep it
  // correct whenever the landing repaints (boot included).
  (window as unknown as { __syncSpaceAttrs?: () => void }).__syncSpaceAttrs?.();
  // Minimal Home (intro + input only) has no columns — nothing to paint here.
  if (!document.getElementById("dash-tasks-list")) return;
  // RIGHT — TASKS: the scheduled-task runs list, ungated from the old
  // chat-space check (spaces collapsed to one session type).
  document.getElementById("dash-right-label")!.textContent = "Tasks";
  document.getElementById("dash-tasks-list")?.classList.remove("hidden");
  document.getElementById("dash-tasks-search")?.classList.remove("hidden");
  document.getElementById("dash-tasks-pager")?.classList.remove("hidden");
  // LEFT — CONTINUE: the user's recent sessions (was hidden; now the left
  // column). The old "Recommended for you" recs stay hidden — the full-width
  // starter strip above covers that ground.
  document.getElementById("dash-sessions-list")?.classList.remove("hidden");
  sessionsPage = 0;
  renderSessionsList();
  renderRuns();
}

// Switching Chat ↔ Work while the landing is up swaps the flow's orientation
// (fall ↔ converge) — restart the engine with the new variant.
/**
 * Reconcile the landing's flow with the active space. Safe to call on every
 * landing paint — a no-op when the right variant is already running.
 *
 * A space switch made while the landing was COVERED (an open command centre,
 * a card, a populated workbench) used to be dropped on the floor: the handler
 * saw a canvas with no offsetParent and returned, leaving the previous
 * space's engine running against a zero-sized canvas. Coming back via Home
 * then showed a frozen backdrop belonging to the tab you left. Hidden now
 * means TEAR DOWN, so the next paint starts the current variant clean.
 */
export function syncDashParticles(): void {
  const canvas = document.getElementById("dash-particles") as HTMLCanvasElement | null;
  if (!canvas) return;
  const stop = (): void => { particlesCleanup?.(); particlesCleanup = null; particlesVariant = ""; };
  if (canvas.offsetParent === null) { stop(); return; }
  const sp = document.body.dataset.railSpace;
  const want: FlowVariant = sp === "chat" ? "chat" : sp === "code" ? "code" : "cowork";
  if (particlesRaf && want === particlesVariant) return;
  stop();
  startDashParticles();
}

// Switching spaces while the landing is up swaps the flow's orientation
// (fall ↔ converge ↔ rise) — restart the engine with the new variant.
window.addEventListener("rail-space-changed", () => {
  paintSpaceColumns();
  syncDashParticles();
});

// The "Continue" column mirrors the live session store — a new session, a
// rename, a delete, or the store simply arriving after the first paint all
// fire this, so the list populates and stays fresh while Home is up.
window.addEventListener("agent-sessions-changed", () => {
  if (!document.getElementById("dash-sessions-list")?.classList.contains("hidden")) {
    renderSessionsList();
  }
});

export async function loadDashboard(): Promise<void> {
  syncDashParticles();

  // The landing's STRUCTURE never waits on the server: composer adoption,
  // starters, and the space columns paint first — a failed/slow data call only
  // costs the greeting name, not the whole screen (which is exactly what
  // happened on web when the data path threw).
  // RETRY the adoption until the code section has actually built its composer —
  // a straight call silently no-ops when Home paints first.
  const adoptWhenReady = (tries = 0): void => {
    const slot = document.getElementById("dash-composer-slot");
    if (!slot) return;
    if (document.querySelector(".code-composer")) { adoptComposer(slot); return; }
    if (tries < 60) setTimeout(() => adoptWhenReady(tries + 1), 50);
  };
  adoptWhenReady();
  renderStarters();
  paintSpaceColumns();
  void loadRuns();

  try {
    const data = (await window.glyphh.dashboardData?.()) as DashboardData | undefined;
    if (data) $a("dash-greeting").textContent = greeting(data.name);
  } catch (err) {
    console.error("[dashboard] data failed (landing already painted)", err);
  }
}

/**
 * The usage chart's MEMBER filter — the one control the platform's dashboard
 * had and this app didn't. The roster is org_admin-only server-side, so a
 * member's rejected call simply leaves the dropdown hidden; there is nothing
 * to explain because there is nothing they could have chosen.
 */
export async function loadUsageMembers(): Promise<void> {
  const sel = document.getElementById("dash-usage-member") as HTMLSelectElement | null;
  if (!sel) return;
  try {
    const members = await accountApi().members();
    if (!members?.length) { sel.classList.add("hidden"); return; }
    const prev = sel.value;
    sel.innerHTML = `<option value="">All members</option>`;
    for (const m of members) {
      const opt = document.createElement("option");
      opt.value = m.userId;
      opt.textContent = m.name || m.email;
      sel.appendChild(opt);
    }
    if (Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
    sel.classList.remove("hidden");
  } catch {
    // Not an admin (or offline) — no roster, no filter. The chart still shows
    // exactly what the server scopes to this caller.
    sel.classList.add("hidden");
  }
}

/** The three metric cards — they live in Settings › Usage now, alongside the
 *  chart; Settings' loader calls this. */
export async function loadUsageMetrics(): Promise<void> {
  try {
    const data = (await window.glyphh.dashboardData?.()) as DashboardData | undefined;
    if (!data) return;
    // data.plan is the plan's DISPLAY NAME off the catalog now (a bare tier
    // slug only on old builds) — capitalize only single-word slugs.
    const planName = data.plan
      ? (data.plan.includes(" ") ? data.plan : data.plan.charAt(0).toUpperCase() + data.plan.slice(1))
      : "";
    if (data.orgCredits === false) {
      // Member view — the org pool is admin-only; show THEIR allocation
      // (role cap, spend across LLM + compute, reset date).
      $a("dash-credits-label").textContent = "Your credits";
      if (data.me?.uncapped ?? true) {
        $a("dash-credits-value").textContent = "Pooled";
        $a("dash-credits-sub").textContent = `no personal cap — you draw from the team pool${data.me?.roleName ? ` · ${data.me.roleName}` : ""}`;
      } else {
        $a("dash-credits-value").textContent = fmtInt(data.me?.remainingCredits ?? 0);
        const resets = data.me?.windowEnd
          ? new Date(data.me.windowEnd).toLocaleDateString(undefined, { month: "short", day: "numeric" })
          : "soon";
        $a("dash-credits-sub").textContent = `${fmtInt(data.me?.spentCredits ?? 0)} of ${fmtInt(data.me?.capCredits ?? 0)} used · resets ${resets}`;
      }
    } else {
      $a("dash-credits-label").textContent = "Organization credits";
      $a("dash-credits-value").textContent = fmtCredits(data.credits);
      $a("dash-credits-sub").textContent = data.allowance > 0
        ? `${planName ? `${planName} plan · ` : ""}${fmtInt(data.allowance)} credits/mo`
        : (planName ? `${planName} plan` : "available");
    }

    $a("dash-spend-value").textContent = fmtCredits(data.spendCredits);
    $a("dash-spend-sub").textContent = `credits used${data.requests ? ` · ${fmtInt(data.requests)} calls` : ""}`;

    $a("dash-apps-value").textContent = fmtInt(data.appsCount);
  } catch (err) {
    console.error("[dashboard] usage metrics load failed", err);
  }
}

// ── Recommended for you: three starters; a click = a fresh session with the
// prompt injected, ready to send. ──
// Per-SPACE prompt sets — the left column must speak the space's language:
// Chat/Work get task prompts, Code gets engineering prompts.
const RECOMMENDATIONS: Array<{ prompt: string; icon: string }> = [
  {
    prompt: "Read my inbox and give me a brief of what actually needs me today",
    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`,
  },
  {
    prompt: "Build a slide deck from my Q3 folder in Drive, on our corporate template",
    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  },
  {
    prompt: "Set up an agent that digests my email and Slack every morning at 8",
    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  },
];

// ── Chat landing starters — the front door to ALL THREE spaces ──────────
// Every card names the space it opens into and wears that space's pill, so
// "Research a topic" visibly takes you to Work (it drives NotebookLM over
// RPA, which only Work can do) and "Build an app" takes you to Code. A card
// switches the tab, lands on a fresh session, and seeds the composer — it
// never sends; the user finishes the thought and hits enter.
interface Starter {
  space: Space; title: string; blurb: string; mascot: Mascot;
  /** Plain-English seed — always safe, used when no skill backs the card. */
  seed: string;
  /** The workspace this starter opens into, if any (Chat starters need none). */
  layout?: keyof typeof STARTER_LAYOUTS;
  /** The skill that does this properly — seeded server-side at signup, so
   *  the reference simply resolves. */
  skill?: { slug: string; seed: string };
}
const STARTERS: Starter[] = [
  {
    space: "cowork", title: "Research a topic",
    blurb: "NotebookLM does the digging — sources imported, deck built, findings remembered.",
    seed: "Research this topic end to end and build me a deck on it: ",
    layout: "research",
    skill: { slug: "notebook-research", seed: "/notebook-research " },
    mascot: { name: "Scout", key: "scout", color: "#2dd4bf" },
  },
  {
    space: "code", title: "Build an app",
    blurb: "From one sentence to a running app in your workspace.",
    seed: "Build me an app that ",
    layout: "dev",
    skill: { slug: "build-glyphh-app", seed: "/build-glyphh-app " },
    mascot: { name: "Byte", key: "byte", color: "#a78bfa" },
  },
  {
    space: "cowork", title: "Triage my inbox",
    blurb: "What actually needs you today — and drafts for the easy ones.",
    seed: "Read my inbox and give me a brief of what actually needs me today, with drafts for anything routine.", layout: "email",
    mascot: { name: "Post", key: "post", color: "#fbbf24" },
  },
  {
    space: "code", title: "Fix a bug",
    blurb: "Point at the symptom; the agent reads the folder and lands the fix.",
    seed: "In my working folder, find and fix: ", layout: "dev",
    mascot: { name: "Patch", key: "patch", color: "#fb7185" },
  },
  {
    space: "chat", title: "Explain something",
    blurb: "A straight answer, no tools, no workspace — just the explanation.",
    seed: "Explain, simply and concretely: ",
    mascot: { name: "Sage", key: "sage", color: "#60a5fa" },
  },
  {
    space: "chat", title: "Weigh a decision",
    blurb: "Lay out the options, the trade-offs, and a recommendation.",
    seed: "Help me decide between: ",
    mascot: { name: "Tally", key: "tally", color: "#4ade80" },
  },
];

/** Open the starter's workspace, then seed its prompt. */
async function runStarter(s: Starter): Promise<void> {
  if (s.layout) await openStarterLayout(s.layout);
  seedNewSession(s.skill ? s.skill.seed : s.seed, s.space);
}

function renderStarters(): void {
  const host = document.getElementById("dash-starters");
  if (!host || host.childElementCount) return;
  for (const s of STARTERS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `dash-starter dash-starter-${s.space}`;
    card.innerHTML =
      `<span class="dash-starter-top">` +
      `<span class="dash-starter-title"></span>` +
      spacePillHtml(s.space) +
      `</span>` +
      `<span class="dash-starter-blurb"></span>`;
    card.querySelector(".dash-starter-title")!.textContent = s.title;
    card.querySelector(".dash-starter-blurb")!.textContent = s.blurb;
    card.title = `Opens in ${SPACE_LABEL[s.space]}`;
    card.addEventListener("click", () => { void runStarter(s); });
    host.appendChild(card);
  }
}

const CODE_RECOMMENDATIONS: Array<{ prompt: string; icon: string }> = [
  {
    prompt: "Review my working branch and flag anything risky before I open the PR",
    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>`,
  },
  {
    prompt: "Find and fix the failing tests in this repo",
    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>`,
  },
  {
    prompt: "Explain this codebase — architecture, key modules, where things live",
    icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  },
];

function renderRecommendations(): void {
  const host = document.getElementById("dash-recs");
  if (!host) return;
  host.innerHTML = "";
  const set = document.body.dataset.railSpace === "code" ? CODE_RECOMMENDATIONS : RECOMMENDATIONS;
  for (const rec of set) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dash-rec";
    row.innerHTML = `<span class="dash-rec-ico">${rec.icon}</span><span class="dash-rec-text">${escapeHtml(rec.prompt)}</span>`;
    row.addEventListener("click", () => seedNewSession(rec.prompt));
    host.appendChild(row);
  }
}

// ── Recent runs, across ALL agents: every task firing, newest first. A click
// opens the run as a chat session — the full output, rendered like a turn. ──
interface DashRun {
  runId: string; agentId: string; agentName: string; taskName: string; target: string;
  startedAt: string; durationMs: number | null; status: string; error: string | null; output: string | null;
}

let allRuns: DashRun[] = [];
let runsPage = 0;
const RUNS_PAGE_SIZE = 15;

function renderRuns(): void {
  const listEl = document.getElementById("dash-tasks-list");
  const pagerEl = document.getElementById("dash-tasks-pager");
  const search = (document.getElementById("dash-tasks-search") as HTMLInputElement | null)?.value.trim().toLowerCase() ?? "";
  if (!listEl || !pagerEl) return;

  const filtered = search
    ? allRuns.filter((run) => `${run.taskName} ${run.target} ${run.agentName}`.toLowerCase().includes(search))
    : allRuns;

  listEl.innerHTML = "";
  pagerEl.innerHTML = "";
  if (!allRuns.length) {
    listEl.innerHTML = `<div class="crud-empty">No runs yet — schedule a task and its firings land here.</div>`;
    return;
  }
  if (!filtered.length) {
    listEl.innerHTML = `<div class="crud-empty">No runs matching "${escapeHtml(search)}"</div>`;
    return;
  }

  const { items, state } = paginate(filtered, runsPage, RUNS_PAGE_SIZE);
  runsPage = state.page;
  for (const run of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dash-run-row";
    const when = new Date(run.startedAt).toLocaleString();
    const err = run.status === "error";
    row.innerHTML = `
      <span class="dash-run-task"></span>
      <span class="dash-task-agent"></span>
      <span class="dash-run-when">${escapeHtml(when)}</span>
      <span class="lib-run-badge ${err ? "err" : "ok"}">${err ? "Failed" : "Success"}</span>`;
    row.querySelector(".dash-run-task")!.textContent = run.taskName;
    row.querySelector(".dash-task-agent")!.textContent = run.agentName;
    row.addEventListener("click", () => openRunSession(run));
    listEl.appendChild(row);
  }
  if (state.totalPages > 1) pagerEl.appendChild(renderPaginationBar(state, (p) => { runsPage = p; renderRuns(); }));
}

async function loadRuns(): Promise<void> {
  const env = await window.glyphh.dashboardRuns?.();
  if (!env?.ok) return;
  allRuns = env.data as DashRun[];
  runsPage = 0;
  renderRuns();
}

/** "Good afternoon, Chris" — time of day + first name, on the platform head.
 *  Identity.name is often unset, so the PROFILE's firstName is the backstop. */
export function paintDashGreeting(): void {
  const el = document.getElementById("dash-greeting");
  if (!el) return;
  void (async () => {
    let first = "";
    let email = "";
    try {
      const info = await Promise.resolve(window.glyphh.getAccountInfo?.());
      first = (info?.firstName || "").trim();
      email = (info?.email || "").trim();
    } catch { /* fall through */ }
    if (!first) {
      try {
        const prof = await accountApi().profile();
        first = (prof?.firstName || "").trim();
        email = email || (prof?.email || "").trim();
      } catch { /* fall through */ }
    }
    if (!first && email) {
      // Last resort: the email local part ("chris.timmerman@…" → "Chris") —
      // the greeting always carries a first name.
      const raw = email.split("@")[0]?.split(/[._-]/)[0] || "";
      first = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
    }
    el.textContent = greeting(first);
  })();
}

let wired = false;
export function initDashboardEvents(): void {
  if (wired) return;
  wired = true;

  // Billing is a NATIVE panel now (Settings › Billing) — it used to open the
  // platform's /billing page in a workbench browser; there's nothing left over
  // there that this app can't do itself.
  // The header's primary action is the community (his order, 2026-08-25) —
  // credits are bought on Billing.
  document.getElementById("dash-discord")?.addEventListener("click", () => {
    // typeof guard: on web window.glyphh is a Proxy that fabricates a FUNCTION
    // for any name — a truthy || would "open" that function, not a URL.
    const raw = (window.glyphh as unknown as { discordInvite?: unknown }).discordInvite;
    window.open(typeof raw === "string" && raw ? raw : "https://discord.gg/P3yynv4v9", "_blank", "noopener");
  });
  document.getElementById("dash-get-key")?.addEventListener("click", () => {
    gotoSection("settings", "apikeys");
  });
  paintDashGreeting();
  // the refresh button rides the chart card in Settings › Usage
  document.getElementById("dash-refresh")?.addEventListener("click", () => {
    void loadUsageChart();
  });
  for (const id of ["dash-usage-days", "dash-usage-group", "dash-usage-filter", "dash-usage-member"]) {
    document.getElementById(id)?.addEventListener("change", () => { void loadUsageChart(); });
  }
  document.getElementById("dash-tasks-search")?.addEventListener("input", () => { runsPage = 0; renderRuns(); });
}
