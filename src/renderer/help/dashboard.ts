/**
 * Dashboard (Home) — the landing section. Shows a welcome, org credit balance,
 * spend this month, apps deployed, and a per-day usage chart (credits + calls;
 * LLM tokens are not a client concept). All numbers come from the server via
 * window.yo.dashboardData() (see home-ipc.ts), which mirrors the same
 * billing/usage endpoints the platform dashboard uses.
 */

import { $a, cssVar, escapeHtml, paginate, renderPaginationBar } from "./shared.js";
import { openUrlInWorkbench, seedNewSession, openRunSession, adoptComposer } from "./code.js";
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

function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : "Welcome back";
}

/** "1,204" for credits/counts. */
function fmtInt(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString();
}

/** Credits on the chart axis/tooltip — whole numbers, thousands separated. */
function fmtCredits(n: number): string {
  return fmtInt(n);
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
  const win = parseInt(daysSel?.value || "30", 10);
  const groupBy = groupSel?.value === "source" ? "source" : "model";
  const env = await window.yo.usageSeries?.(win, groupBy);
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
  $a("dash-usage-total").textContent = `${fmtCredits(credits)} credits · ${fmtInt(calls)} calls`;
  $a("dash-usage-range").textContent = `last ${win} days`;
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
// component verbatim): the splash runs "fan" (home), Work runs "converge"
// (desktop page), Chat runs "fall" — the CLI page's cascade, streams
// falling like terminal output in its teal/emerald set.
const FLOW_VARIANTS = {
  cowork: { mode: "converge", colors: ["179, 107, 251", "245, 158, 11", "236, 72, 153"], pulse: "255, 236, 180", seed: 2025 },
  chat: { mode: "fall", colors: ["94, 234, 212", "52, 211, 153", "179, 107, 251"], pulse: "190, 242, 255", seed: 4242 },
} as const;
function startDashParticles(): void {
  const canvas = document.getElementById("dash-particles") as HTMLCanvasElement | null;
  if (!canvas || particlesRaf) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const variantKey = document.body.dataset.railSpace === "chat" ? "chat" : "cowork";
  particlesVariant = variantKey;
  const V = FLOW_VARIANTS[variantKey];
  const mode: "converge" | "fall" = V.mode;
  const COLORS: readonly string[] = V.colors;
  const PULSE = V.pulse;
  const WHITE = "255, 255, 255";
  const N = 28;
  const SEED = V.seed;

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
  particlesCleanup = () => ro.disconnect();
  resize();

  type Pt = [number, number];
  // fall swaps the axes: streams cascade top-down like terminal output
  const mapPt = (S: Stream, run: number, fan: number): Pt =>
    mode === "fall" ? [fan * w, run * h] : [S.mirror ? (1 - run) * w : run * w, fan * h];
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
    if (!canvas.isConnected || canvas.offsetParent === null) {
      particlesRaf = 0;
      ro.disconnect();
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
        // scatter spreads toward the entering edge for converge, downward for fall
        const sx = mode === "fall" ? d.dy : (S.mirror ? -d.dx : d.dx);
        const sy = mode === "fall" ? d.dx : d.dy;
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

    // center vignette so the copy stays legible
    const vg = ctx.createRadialGradient(w / 2, h * 0.46, 0, w / 2, h * 0.46, h * 0.62);
    vg.addColorStop(0, "rgba(8, 6, 12, 0.6)");
    vg.addColorStop(0.55, "rgba(8, 6, 12, 0.12)");
    vg.addColorStop(1, "rgba(8, 6, 12, 0)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    if (reduced) { particlesRaf = 0; return; }
    particlesRaf = requestAnimationFrame(frame);
  };
  particlesRaf = requestAnimationFrame(frame);
}

// Switching Chat ↔ Work while the landing is up swaps the flow's orientation
// (fall ↔ converge) — restart the engine with the new variant.
window.addEventListener("rail-space-changed", () => {
  const canvas = document.getElementById("dash-particles") as HTMLCanvasElement | null;
  if (!canvas || canvas.offsetParent === null) return;
  const want = document.body.dataset.railSpace === "chat" ? "chat" : "cowork";
  if (want === particlesVariant) return;
  if (particlesRaf) { cancelAnimationFrame(particlesRaf); particlesRaf = 0; }
  particlesCleanup?.();
  particlesCleanup = null;
  startDashParticles();
});

export async function loadDashboard(): Promise<void> {
  startDashParticles();
  // Paint the greeting immediately from cached account info if available; the
  // server call fills in the numbers.
  try {
    const data = (await window.yo.dashboardData?.()) as DashboardData | undefined;
    if (!data) return;

    $a("dash-greeting").textContent = greeting(data.name);

    // the FULL agent footer moves into the Home slot while Home is up
    adoptComposer(document.getElementById("dash-composer-slot"));

    renderStarters();
    renderRecommendations();
    void loadRuns();
  } catch (err) {
    console.error("[dashboard] load failed", err);
  }
}

/** The three metric cards — they live in Settings › Usage now, alongside the
 *  chart; Settings' loader calls this. */
export async function loadUsageMetrics(): Promise<void> {
  try {
    const data = (await window.yo.dashboardData?.()) as DashboardData | undefined;
    if (!data) return;
    const planName = data.plan ? data.plan.charAt(0).toUpperCase() + data.plan.slice(1) : "";
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
      $a("dash-credits-value").textContent = fmtInt(data.credits);
      $a("dash-credits-sub").textContent = data.allowance > 0
        ? `${planName ? `${planName} plan · ` : ""}${fmtInt(data.allowance)} credits/mo`
        : (planName ? `${planName} plan` : "available");
    }

    $a("dash-spend-value").textContent = fmtInt(data.spendCredits);
    $a("dash-spend-sub").textContent = `credits used${data.requests ? ` · ${fmtInt(data.requests)} calls` : ""}`;

    $a("dash-apps-value").textContent = fmtInt(data.appsCount);
  } catch (err) {
    console.error("[dashboard] usage metrics load failed", err);
  }
}

// ── Recommended for you: three starters; a click = a fresh session with the
// prompt injected, ready to send. ──
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
      `<span class="dash-starter-mascot">${mascotSvg(s.mascot)}</span>` +
      `<span class="dash-starter-name"></span>` +
      spacePillHtml(s.space) +
      `</span>` +
      `<span class="dash-starter-title"></span>` +
      `<span class="dash-starter-blurb"></span>`;
    card.querySelector(".dash-starter-name")!.textContent = s.mascot.name;
    card.querySelector(".dash-starter-title")!.textContent = s.title;
    card.querySelector(".dash-starter-blurb")!.textContent = s.blurb;
    card.title = `${s.mascot.name} · opens in ${SPACE_LABEL[s.space]}`;
    card.addEventListener("click", () => { void runStarter(s); });
    host.appendChild(card);
  }
}

function renderRecommendations(): void {
  const host = document.getElementById("dash-recs");
  if (!host || host.childElementCount) return;
  for (const rec of RECOMMENDATIONS) {
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
const RUNS_PAGE_SIZE = 5;

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
  const env = await window.yo.dashboardRuns?.();
  if (!env?.ok) return;
  allRuns = env.data as DashRun[];
  runsPage = 0;
  renderRuns();
}

let wired = false;
export function initDashboardEvents(): void {
  if (wired) return;
  wired = true;

  // Billing opens INSIDE the app as a workbench panel — the same mechanics
  // Settings → Manage Account uses — never the external browser.
  document.getElementById("dash-add-funds")?.addEventListener("click", () => {
    openUrlInWorkbench("Billing", `${window.yo.platformUrl}/billing`);
  });
  // the refresh button rides the chart card in Settings › Usage
  document.getElementById("dash-refresh")?.addEventListener("click", () => {
    void loadUsageChart();
  });
  for (const id of ["dash-usage-days", "dash-usage-group", "dash-usage-filter"]) {
    document.getElementById(id)?.addEventListener("change", () => { void loadUsageChart(); });
  }
  document.getElementById("dash-tasks-search")?.addEventListener("input", () => { runsPage = 0; renderRuns(); });
}
