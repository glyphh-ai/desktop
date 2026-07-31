/**
 * Dashboard (Home) — the landing section. Shows a welcome, org credit balance,
 * spend this month, apps deployed, and a per-day usage chart (credits + calls;
 * LLM tokens are not a client concept). All numbers come from the server via
 * window.yo.dashboardData() (see home-ipc.ts), which mirrors the same
 * billing/usage endpoints the platform dashboard uses.
 */

import { $a, cssVar, escapeHtml, paginate, renderPaginationBar } from "./shared.js";
import { openUrlInWorkbench, seedNewSession, openRunSession, adoptComposer } from "./code.js";

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

// ── The glyphh.ai desktop page's HERO MOVEMENT, ported whole: corner
// halftone RAY SPRAYS (pulsing bokeh glow, slow outward flow, twinkle,
// pointer parallax — web HeroRays.js) layered over the faint drifting dot
// field (HeroParticles.js), tinted from the app's accent. Skips motion
// under prefers-reduced-motion; self-stops when the landing leaves the
// screen and restarts on the next load. ──
let particlesRaf = 0;
function startDashParticles(): void {
  const canvas = document.getElementById("dash-particles") as HTMLCanvasElement | null;
  if (!canvas || particlesRaf) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // accent → rgb, plus a lighter tint for the spray variety
  const hex = (getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#f59e0b").replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const r0 = parseInt(full.slice(0, 2), 16), g0 = parseInt(full.slice(2, 4), 16), b0 = parseInt(full.slice(4, 6), 16);
  const mix = (v: number, t: number): number => Math.round(v + (255 - v) * t);
  const ACCENT = `${r0}, ${g0}, ${b0}`;
  const LIGHT = `${mix(r0, 0.45)}, ${mix(g0, 0.45)}, ${mix(b0, 0.45)}`;
  const WHITE = "255, 255, 255";
  const CORNERS = [
    { x: 0, y: 0, a0: 0.12, a1: 1.45, tint: LIGHT },
    { x: 1, y: 0, a0: 1.69, a1: 3.02, tint: ACCENT },
  ];
  const RAYS = 18, DOTS = 34, CURL = 0.22;

  let w = 0, h = 0, reach = 0;
  interface Dot { x: number; y: number; r: number; vy: number; vx: number; a: number; tw: number; ph: number; accent: boolean }
  let parts: Dot[] = [];
  const seed = (): void => {
    const count = Math.round(Math.min(70, Math.max(36, w / 22)));
    parts = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: 0.6 + Math.random() * 1.1,
      vy: 0.06 + Math.random() * 0.16,
      vx: (Math.random() - 0.5) * 0.05,
      a: 0.05 + Math.random() * 0.16,
      tw: 0.4 + Math.random() * 1.2,
      ph: Math.random() * Math.PI * 2,
      accent: Math.random() < 0.35,
    }));
  };
  const resize = (): void => {
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = rect.width; h = rect.height;
    reach = Math.hypot(w, h) * 0.6;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!parts.length) seed();
  };
  const ro = new ResizeObserver(resize);
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  resize();

  let px = 0, py = 0, cx = 0, cy = 0;
  const onPointer = (e: PointerEvent): void => {
    px = e.clientX / window.innerWidth - 0.5;
    py = e.clientY / window.innerHeight - 0.5;
  };
  window.addEventListener("pointermove", onPointer);

  let t = 0;
  const tick = (now: number): void => {
    if (!canvas.isConnected || canvas.offsetParent === null) {
      particlesRaf = 0;
      ro.disconnect();
      window.removeEventListener("pointermove", onPointer);
      return;
    }
    t += 0.016;
    cx += (px - cx) * 0.05;
    cy += (py - cy) * 0.05;
    ctx.clearRect(0, 0, w, h);

    // — the drift field (HeroParticles) —
    if (!reduced) {
      for (const pt of parts) {
        pt.y -= pt.vy;
        pt.x += pt.vx;
        if (pt.y < -4) { pt.y = h + 4; pt.x = Math.random() * w; }
        if (pt.x < -4) pt.x = w + 4;
        if (pt.x > w + 4) pt.x = -4;
        const alpha = pt.a * (0.6 + 0.4 * Math.sin(t * pt.tw + pt.ph));
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.r, 0, Math.PI * 2);
        ctx.fillStyle = pt.accent ? `rgba(${ACCENT}, ${alpha})` : `rgba(${WHITE}, ${alpha})`;
        ctx.fill();
      }
    }

    // — the corner ray sprays (HeroRays) —
    ctx.globalCompositeOperation = "lighter";
    const flow = reduced ? 0 : now * 0.000018;
    for (let ci = 0; ci < CORNERS.length; ci++) {
      const C = CORNERS[ci]!;
      const ox = C.x * w, oy = C.y * h;
      const par = 26;
      const pulse = 0.75 + 0.25 * Math.sin(now * 0.0009 + ci * 1.7);
      const gx = ox + (C.x === 0 ? 60 : -60);
      const gy = oy + 60;
      const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, 220);
      grad.addColorStop(0, `rgba(${C.tint}, ${0.28 * pulse})`);
      grad.addColorStop(0.5, `rgba(${C.tint}, ${0.09 * pulse})`);
      grad.addColorStop(1, `rgba(${C.tint}, 0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(ox - 300, oy - 300, 600, 600);
      for (let k = 0; k < RAYS; k++) {
        const a = C.a0 + (C.a1 - C.a0) * (k / (RAYS - 1));
        const jitter = Math.sin(k * 12.9 + ci * 4.1) * 0.03;
        for (let j = 0; j < DOTS; j++) {
          const baseT = j / DOTS;
          const tt = flow ? (baseT + flow) % 1 : baseT;
          const ang = a + CURL * tt + jitter;
          const rr = reach * tt;
          const x = ox + Math.cos(ang) * rr + cx * par * tt;
          const y = oy + Math.sin(ang) * rr + cy * par * tt;
          const env = Math.min(1, tt / 0.05) * Math.min(1, (1 - tt) / 0.4);
          const tw = reduced ? 0.85 : 0.55 + 0.45 * Math.sin(now * 0.002 + j * 0.5 + k * 1.3 + ci);
          const spark = (j + k) % 8 === 0;
          const col = spark ? WHITE : C.tint;
          const alpha = env * tw * (spark ? 1 : 0.8);
          if (alpha <= 0.01) continue;
          const size = (2.7 * (1 - tt) + 0.7 * tt) * (spark ? 1.5 : 1);
          ctx.fillStyle = `rgba(${col}, ${alpha})`;
          ctx.beginPath();
          ctx.arc(x, y, size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalCompositeOperation = "source-over";
    particlesRaf = requestAnimationFrame(tick);
  };
  particlesRaf = requestAnimationFrame(tick);
}

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
