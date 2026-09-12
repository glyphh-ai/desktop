/**
 * gateway-metrics.ts — Gateway › Metrics (platform, org_admin).
 *
 * The org's slice of the LiteLLM router telemetry: per-day tokens/spend bars,
 * a performance (response-time) line chart, and a by-model breakdown — all
 * keyed on the SAME two filters (role + window) in the top card, mirroring
 * the Platform › Usage grammar (settings-admin.ts). The gateway records
 * request METADATA only; prompts and completions are never stored, so no
 * content surface exists here.
 *
 * Transport: web SDK handle first (platform), IPC envelope fallback (desktop
 * stubs the channel — this page is platform-only).
 */

import { gateSurface } from "./plan-gate.js";

// Chart.js is loaded globally (app-libs/chart.js → window.Chart) by home.html.
declare const Chart: { new (ctx: CanvasRenderingContext2D, cfg: unknown): { destroy: () => void } };

interface GatewayDay {
  day: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  spendUsd: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

interface GatewayBreakdownRow {
  key: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  spendUsd: number;
  avgLatencyMs: number;
}

interface GatewayMetrics {
  configured: boolean;
  days: GatewayDay[];
  byModel: GatewayBreakdownRow[];
  byProvider: GatewayBreakdownRow[];
}

interface WorkspaceLite { id: string; name: string }

interface SdkGateway {
  gateway?: { metrics?: (opts: { days?: number; workspaceId?: string }) => Promise<GatewayMetrics> };
  workspaces?: { list?: () => Promise<WorkspaceLite[]> };
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

const sdk = (): SdkGateway | null => (window as unknown as { glyphhSdk?: SdkGateway }).glyphhSdk ?? null;

type IpcEnvelope = { ok: boolean; data?: unknown; error?: string };
const ipc = (): Record<string, ((...a: unknown[]) => Promise<IpcEnvelope>) | undefined> =>
  (window as unknown as { glyphh?: Record<string, ((...a: unknown[]) => Promise<IpcEnvelope>) | undefined> }).glyphh ?? {};

function setError(msg: string): void {
  const el = $("gw-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

/** Web SDK first, IPC envelope fallback — the settings-workspaces `via` grammar. */
async function via<T>(web: (s: SdkGateway) => Promise<T> | undefined, method: string, ...args: unknown[]): Promise<T | null> {
  const handle = sdk();
  if (handle) {
    try {
      const p = web(handle);
      if (p) return (await p) ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }
  const fn = ipc()[method];
  if (!fn) { setError(`${method} is unavailable on this surface.`); return null; }
  try {
    const res = await fn(...args);
    if (!res || typeof res.ok !== "boolean") { setError(`${method} is unavailable on this surface.`); return null; }
    if (!res.ok) { setError(res.error || `${method} failed`); return null; }
    return (res.data as T) ?? null;
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
    return null;
  }
}

const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const fmtInt = (n: number): string => Math.round(n).toLocaleString();

/** "1.2M" style for the token cards — the day charts keep full numbers in tooltips. */
function fmtCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return fmtInt(n);
}

const fmtUsd = (n: number): string => `$${n >= 100 ? fmtInt(n) : n.toFixed(2)}`;

const fmtMs = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${fmtInt(n)}ms`);

/** "Jul 5" from a "YYYY-MM-DD" bucket (settings-admin.ts's exact treatment). */
function shortDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

let volumeChart: { destroy: () => void } | null = null;
let perfChart: { destroy: () => void } | null = null;
let wired = false;
let loadSeq = 0;

function renderVolumeChart(days: GatewayDay[]): void {
  const canvas = $<HTMLCanvasElement>("gw-chart");
  const empty = $("gw-empty");
  if (!canvas || typeof Chart === "undefined") return;
  if (volumeChart) { volumeChart.destroy(); volumeChart = null; }
  const hasData = days.some((d) => d.requests > 0);
  empty?.classList.toggle("hidden", hasData);
  canvas.style.visibility = hasData ? "visible" : "hidden";
  if (!hasData) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const accent = cssVar("--accent") || "#af5fff";
  volumeChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: days.map((d) => shortDay(d.day)),
      datasets: [
        {
          type: "bar", label: "Tokens", yAxisID: "yTok",
          data: days.map((d) => d.promptTokens + d.completionTokens),
          backgroundColor: accent, borderRadius: 3, maxBarThickness: 34,
        },
        {
          type: "line", label: "Spend $", yAxisID: "yUsd",
          data: days.map((d) => d.spendUsd),
          borderColor: "#e5a50a", backgroundColor: "transparent",
          borderWidth: 2, pointRadius: 0, tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { color: cssVar("--text-3") || "#868686", boxWidth: 14 } },
        tooltip: {
          callbacks: {
            label: (c: { dataset: { label?: string }; parsed: { y: number }; dataIndex: number }) => {
              if (c.dataset.label === "Spend $") return `$${c.parsed.y.toFixed(4)}`;
              const cell = days[c.dataIndex];
              return `${fmtInt(c.parsed.y)} tokens${cell ? ` · ${fmtInt(cell.requests)} requests` : ""}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: cssVar("--text-3") || "#868686", maxRotation: 0, autoSkip: true } },
        yTok: {
          beginAtZero: true, position: "left",
          grid: { color: cssVar("--border") || "rgba(255,255,255,0.08)" },
          ticks: { color: cssVar("--text-3") || "#868686", callback: (v: number) => fmtCompact(v) },
        },
        yUsd: {
          beginAtZero: true, position: "right",
          grid: { display: false },
          ticks: { color: cssVar("--text-3") || "#868686", callback: (v: number) => `$${v}` },
        },
      },
    },
  });
}

function renderPerfChart(days: GatewayDay[]): void {
  const canvas = $<HTMLCanvasElement>("gw-perf-chart");
  const empty = $("gw-perf-empty");
  if (!canvas || typeof Chart === "undefined") return;
  if (perfChart) { perfChart.destroy(); perfChart = null; }
  const hasData = days.some((d) => d.avgLatencyMs > 0);
  empty?.classList.toggle("hidden", hasData);
  canvas.style.visibility = hasData ? "visible" : "hidden";
  if (!hasData) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const accent = cssVar("--accent") || "#af5fff";
  perfChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: days.map((d) => shortDay(d.day)),
      datasets: [
        {
          label: "Avg response",
          data: days.map((d) => d.avgLatencyMs),
          borderColor: accent, backgroundColor: "transparent",
          borderWidth: 2, pointRadius: 0, tension: 0.25,
        },
        {
          label: "p95",
          data: days.map((d) => d.p95LatencyMs),
          borderColor: cssVar("--text-3") || "#868686", backgroundColor: "transparent",
          borderWidth: 1.5, pointRadius: 0, tension: 0.25, borderDash: [4, 3],
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { color: cssVar("--text-3") || "#868686", boxWidth: 14 } },
        tooltip: {
          callbacks: {
            label: (c: { dataset: { label?: string }; parsed: { y: number } }) => `${c.dataset.label ?? ""} ${fmtMs(c.parsed.y)}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: cssVar("--text-3") || "#868686", maxRotation: 0, autoSkip: true } },
        y: {
          beginAtZero: true,
          grid: { color: cssVar("--border") || "rgba(255,255,255,0.08)" },
          ticks: { color: cssVar("--text-3") || "#868686", callback: (v: number) => fmtMs(v) },
        },
      },
    },
  });
}

function renderModelTable(rows: GatewayBreakdownRow[], byProvider: GatewayBreakdownRow[]): void {
  const host = $("gw-models");
  if (!host) return;
  host.innerHTML = "";
  if (!rows.length) {
    host.innerHTML = `<div class="crud-empty">No gateway traffic in this window.</div>`;
    return;
  }
  // Provider for a model row: LiteLLM's `vendor/` prefix when present.
  const providerOf = (model: string): string => {
    const slash = model.indexOf("/");
    return slash > 0 ? model.slice(0, slash) : (byProvider[0]?.key ?? "—");
  };
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Model</th><th>Provider</th><th>Requests</th><th>Tokens in</th><th>Tokens out</th><th>Spend</th><th>Avg speed</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const r of rows.slice(0, 15)) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${r.key.replace(/</g, "&lt;")}</td><td>${providerOf(r.key).replace(/</g, "&lt;")}</td>` +
      `<td>${fmtInt(r.requests)}</td><td>${fmtCompact(r.promptTokens)}</td><td>${fmtCompact(r.completionTokens)}</td>` +
      `<td>${fmtUsd(r.spendUsd)}</td><td>${r.avgLatencyMs ? fmtMs(r.avgLatencyMs) : "—"}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

function paintCards(m: GatewayMetrics, days: number): void {
  const totals = m.days.reduce(
    (a, d) => ({
      requests: a.requests + d.requests,
      tokens: a.tokens + d.promptTokens + d.completionTokens,
      spend: a.spend + d.spendUsd,
    }),
    { requests: 0, tokens: 0, spend: 0 },
  );
  const latencies = m.days.filter((d) => d.requests > 0 && d.avgLatencyMs > 0);
  const avgMs = latencies.length
    ? latencies.reduce((a, d) => a + d.avgLatencyMs * d.requests, 0) / Math.max(1, latencies.reduce((a, d) => a + d.requests, 0))
    : 0;
  const p95 = latencies.length ? Math.max(...latencies.map((d) => d.p95LatencyMs)) : 0;
  const put = (id: string, v: string) => { const el = $(id); if (el) el.textContent = v; };
  put("gw-requests", fmtInt(totals.requests));
  put("gw-requests-sub", `last ${days} days`);
  put("gw-tokens", fmtCompact(totals.tokens));
  put("gw-spend", fmtUsd(totals.spend));
  put("gw-latency", avgMs ? fmtMs(avgMs) : "—");
  put("gw-latency-sub", p95 ? `per request · p95 ${fmtMs(p95)}` : "per request");
  put("gw-total", fmtCompact(totals.tokens));
  put("gw-range", `last ${days} days`);
}

async function loadRoles(): Promise<void> {
  const sel = $<HTMLSelectElement>("gw-role");
  if (!sel || sel.options.length > 1) return; // already populated
  const rows = await via<WorkspaceLite[]>((c) => c.workspaces?.list?.(), "workspacesList");
  for (const w of rows ?? []) {
    const opt = document.createElement("option");
    opt.value = w.id;
    opt.textContent = w.name;
    sel.appendChild(opt);
  }
}

async function refresh(): Promise<void> {
  const seq = ++loadSeq;
  setError("");
  const days = Number($<HTMLSelectElement>("gw-days")?.value || "30");
  const workspaceId = $<HTMLSelectElement>("gw-role")?.value || "";
  const m = await via<GatewayMetrics>(
    (c) => c.gateway?.metrics?.({ days, ...(workspaceId ? { workspaceId } : {}) }),
    "gatewayMetrics", { days, ...(workspaceId ? { workspaceId } : {}) },
  );
  if (!m || seq !== loadSeq) return;
  $("gw-unconfigured")?.classList.toggle("hidden", m.configured);
  paintCards(m, days);
  renderVolumeChart(m.days);
  renderPerfChart(m.days);
  renderModelTable(m.byModel, m.byProvider);
}

export async function loadGatewayMetrics(): Promise<void> {
  // LICENSE first — same banner + Billing door as every gated page.
  void gateSurface(document.querySelector<HTMLElement>('.settings-panel[data-sub="gateway"]'),
    "gateway", "The gateway");
  // Same admin gate as the org pages — the server 403s regardless.
  const account = await window.glyphh.getAccountInfo().catch(() => null);
  const admin = !!account?.role && ["org_admin", "admin", "super_admin"].includes(account.role);
  $("gw-admin-only")?.classList.toggle("hidden", admin);
  $("gw-body")?.classList.toggle("hidden", !admin);
  if (!admin) return;
  if (!wired) {
    wired = true;
    $("gw-days")?.addEventListener("change", () => void refresh());
    $("gw-role")?.addEventListener("change", () => void refresh());
    $("gw-refresh")?.addEventListener("click", () => void refresh());
  }
  await Promise.all([loadRoles(), refresh()]);
}
