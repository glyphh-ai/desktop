/**
 * Dashboard (Home) — the landing section. Shows a welcome, org credit balance,
 * spend this month, apps deployed, and a token-volume chart. All numbers come
 * from the server via window.yo.dashboardData() (see home-ipc.ts), which mirrors
 * the same billing/usage endpoints the platform dashboard uses.
 */

import { $a, formatTokens, cssVar } from "./shared.js";

// Chart.js is loaded globally (app-libs/chart.js → window.Chart) by home.html.
declare const Chart: any;

interface DashboardData {
  name: string;
  credits: number;       // whole credits available
  allowance: number;     // whole credits/month included in the plan
  spendCredits: number;  // whole credits used this calendar month
  requests: number;      // billable calls this month
  appsCount: number;     // apps hosted for this org
  totalTokens: number;   // tokens over the chart window
  days: Array<{ day: string; tokens: number }>;
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

/** "Jul 5" from a "YYYY-MM-DD" bucket (parsed as local, not UTC). */
function shortDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderChart(days: Array<{ day: string; tokens: number }>): void {
  const canvas = $a<HTMLCanvasElement>("dash-usage-chart");
  const empty = document.getElementById("dash-usage-empty");
  if (!canvas || typeof Chart === "undefined") return;

  if (chart) { chart.destroy(); chart = null; }

  const hasData = days.some((d) => d.tokens > 0);
  empty?.classList.toggle("hidden", hasData);
  canvas.style.visibility = hasData ? "visible" : "hidden";
  if (!hasData) return;

  const accent = cssVar("--accent") || "#8c3bf2";
  const ctx = canvas.getContext("2d")!;
  chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: days.map((d) => shortDay(d.day)),
      datasets: [{
        data: days.map((d) => d.tokens),
        backgroundColor: accent,
        hoverBackgroundColor: accent,
        borderRadius: 4,
        maxBarThickness: 34,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (c: { parsed: { y: number } }) => `${formatTokens(c.parsed.y)} tokens` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: cssVar("--text-3") || "#868686", maxRotation: 0, autoSkip: true } },
        y: {
          beginAtZero: true,
          grid: { color: cssVar("--border") || "rgba(255,255,255,0.08)" },
          ticks: { color: cssVar("--text-3") || "#868686", callback: (v: number) => formatTokens(v) },
        },
      },
    },
  });
}

export async function loadDashboard(): Promise<void> {
  // Paint the greeting immediately from cached account info if available; the
  // server call fills in the numbers.
  try {
    const data = (await window.yo.dashboardData?.()) as DashboardData | undefined;
    if (!data) return;

    $a("dash-greeting").textContent = greeting(data.name);

    $a("dash-credits-value").textContent = fmtInt(data.credits);
    $a("dash-credits-sub").textContent = data.allowance > 0
      ? `available · ${fmtInt(data.allowance)}/mo plan`
      : "available";

    $a("dash-spend-value").textContent = fmtInt(data.spendCredits);
    $a("dash-spend-sub").textContent = `credits used${data.requests ? ` · ${fmtInt(data.requests)} calls` : ""}`;

    $a("dash-apps-value").textContent = fmtInt(data.appsCount);

    $a("dash-usage-total").textContent = `${formatTokens(data.totalTokens)} tokens`;
    $a("dash-usage-range").textContent = `last ${data.days.length} days`;
    renderChart(data.days);
  } catch (err) {
    console.error("[dashboard] load failed", err);
  }
}

let wired = false;
export function initDashboardEvents(): void {
  if (wired) return;
  wired = true;

  document.getElementById("dash-add-funds")?.addEventListener("click", () => {
    window.yo.openExternal?.(`${window.yo.platformUrl}/dashboard/manage/billing`);
  });
  // "Connect MCP" → open the Settings tab (its MCP panel has the connection
  // URL + token). Open it as its own shell tab rather than switching sections
  // in place: this Home panel is scope-locked to `dashboard` with its nav rail
  // hidden, so an in-panel gotoSection would trap the user with no way back.
  document.getElementById("dash-get-key")?.addEventListener("click", () => {
    window.yo.tabNewApp("dashboard-settings");
  });
  document.getElementById("dash-refresh")?.addEventListener("click", () => {
    void loadDashboard();
  });
}
