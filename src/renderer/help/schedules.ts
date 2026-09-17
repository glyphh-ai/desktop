/**
 * schedules.ts — Settings → Customize → Schedules.
 *
 * Anything on a clock (his ruling, 2026-09-17): a TASK bundle, whose program
 * the desktop runs itself, or a SKILL, whose text goes through an agent. One
 * table on main (loop_schedules), one runner, one run feed. The page is the
 * old Scheduled Tasks work panel's view (runs chart, what fires next, recent
 * runs) in the settings layout, and an edit page in the Tabs/Drips grammar.
 * A schedule is written in words ("weekdays at 9am") or as a five-field cron.
 */

import { escapeHtml } from "./shared.js";
import { confirmAction } from "./shared.js";
import { toastError, toastOk } from "./toast.js";

interface Env<T> { ok: boolean; data?: T; error?: string }
interface ScheduleRow {
  id: string; name: string; kind: "task" | "skill"; target: string; cron: string; enabled: boolean;
  agentId: string | null; agentName: string | null; ownerAgentId: string | null; args: string; createdAt: string;
  lastRunAt: string | null; lastStatus: string | null; lastError: string | null;
}
interface RecentRun { id: string; scheduleId: string | null; scheduleName: string | null; taskSlug: string | null; trigger: string | null; startedAt: string; durationMs: number | null; status: string; error: string | null }
interface RunRow { id: string; startedAt: string; durationMs: number | null; status: string; error: string | null; output: string | null; taskSlug: string | null }
interface TaskSpecLite { slug: string; name: string; schedule: string | null; enabled: boolean }
interface SkillLite { id: string; name: string; enabled: boolean; source: string }
interface AgentLite { id: string; name: string }

type Api = {
  schedulesList: () => Promise<Env<ScheduleRow[]>>;
  scheduleSave: (input: unknown) => Promise<Env<{ id: string }>>;
  scheduleSetEnabled: (id: string, enabled: boolean) => Promise<Env<unknown>>;
  scheduleDelete: (id: string) => Promise<Env<unknown>>;
  scheduleRunNow: (id: string) => Promise<{ ok: boolean; error?: string }>;
  scheduleRuns: (id: string) => Promise<Env<RunRow[]>>;
  scheduleRecentRuns: () => Promise<Env<RecentRun[]>>;
  tasksSpecs: () => Promise<Env<TaskSpecLite[]>>;
  skillsList: (kind?: string) => Promise<Env<SkillLite[]>>;
  libraryAgentsList: () => Promise<Env<AgentLite[]>>;
  onTaskRunsChanged?: (fn: () => void) => () => void;
};
const api = (): Api => window.glyphh as unknown as Api;
const el = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

let rows: ScheduleRow[] = [];
let recents: RecentRun[] = [];
let tasks: TaskSpecLite[] = [];
let skills: SkillLite[] = [];
let agents: AgentLite[] = [];
let editing: ScheduleRow | null = null;
let query = "";
let wired = false;
let chart: { destroy(): void } | null = null;

// ── cron in words (carried over from the Tasks page, 2026-09-10) ─────────────

const DAY_PATS: Array<[RegExp, number, string]> = [
  [/\bsun(day)?s?\b/, 0, "Sunday"], [/\bmon(day)?s?\b(?!th)/, 1, "Monday"],
  [/\btue(s|sday)?s?\b/, 2, "Tuesday"], [/\bwed(nesday)?s?\b/, 3, "Wednesday"],
  [/\bthu(r|rs|rsday)?s?\b/, 4, "Thursday"], [/\bfri(day)?s?\b/, 5, "Friday"],
  [/\bsat(urday)?s?\b/, 6, "Saturday"],
];

export function humanToCron(input: string): { cron: string; words: string } | null {
  const t = input.trim().toLowerCase();
  if (!t) return null;
  if (/^[\d*,/-]+\s+[\d*,/-]+\s+[\d*,/-]+\s+[\d*,/-]+\s+[\d*,/-]+$/.test(t)) return { cron: t, words: cronToWords(t) };
  const everyMin = /every\s+(\d+)\s*min/.exec(t);
  if (everyMin) return { cron: `*/${everyMin[1]} * * * *`, words: `every ${everyMin[1]} minutes` };
  if (/every\s+hour|hourly/.test(t)) return { cron: "0 * * * *", words: "every hour, on the hour" };
  const tm = /(?:\bat\s+)?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(t) ?? /\bat\s+(\d{1,2})(?::(\d{2}))?\b/.exec(t);
  let h = 9, m = 0;
  if (tm) {
    h = parseInt(tm[1]!, 10); m = tm[2] ? parseInt(tm[2], 10) : 0;
    const mer = tm[3];
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    if (h > 23 || m > 59) return null;
  }
  const timeWords = `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
  if (/month/.test(t)) {
    const dm = /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(t);
    const d = Math.min(31, Math.max(1, dm ? parseInt(dm[1]!, 10) : 1));
    return { cron: `${m} ${h} ${d} * *`, words: `monthly on the ${d}, at ${timeWords}` };
  }
  if (/weekday/.test(t)) return { cron: `${m} ${h} * * 1-5`, words: `weekdays at ${timeWords}` };
  if (/weekend/.test(t)) return { cron: `${m} ${h} * * 0,6`, words: `weekends at ${timeWords}` };
  const days = DAY_PATS.filter(([re]) => re.test(t));
  if (days.length) return { cron: `${m} ${h} * * ${days.map(([, n]) => n).join(",")}`, words: `every ${days.map(([, , label]) => label).join(", ")} at ${timeWords}` };
  if (/every\s*day|daily|each\s*day/.test(t) || tm) return { cron: `${m} ${h} * * *`, words: `every day at ${timeWords}` };
  return null;
}

export function cronToWords(cron: string): string {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return cron;
  const [m, h, dom, , dow] = p as [string, string, string, string, string];
  const em = /^\*\/(\d+)$/.exec(m);
  if (em && h === "*") return `every ${em[1]} minutes`;
  if (m === "0" && h === "*") return "every hour";
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h)) return cron;
  const hh = parseInt(h, 10);
  const time = `${hh % 12 || 12}:${m.padStart(2, "0")}${hh < 12 ? "am" : "pm"}`;
  if (/^\d+$/.test(dom)) return `monthly on the ${dom}, at ${time}`;
  if (dow === "1-5") return `weekdays at ${time}`;
  if (dow === "0,6") return `weekends at ${time}`;
  if (dow === "*") return `every day at ${time}`;
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const listed = dow.split(",").map((d) => names[parseInt(d, 10)]).filter(Boolean);
  return listed.length ? `every ${listed.join(", ")} at ${time}` : cron;
}

function cronSets(cron: string): Array<Set<number>> | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const out: Array<Set<number>> = [];
  for (let i = 0; i < 5; i++) {
    const [lo, hi] = ranges[i]!;
    const set = new Set<number>();
    for (const piece of parts[i]!.split(",")) {
      const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(piece);
      if (!m) return null;
      const step = m[3] ? parseInt(m[3], 10) : 1;
      const a = m[1] === "*" ? lo : parseInt(m[1]!, 10);
      const b = m[1] === "*" ? hi : m[2] ? parseInt(m[2], 10) : a;
      for (let v = a; v <= b; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    out.push(set);
  }
  return out;
}

export function cronNext(cron: string, from: Date): Date | null {
  const sets = cronSets(cron);
  if (!sets) return null;
  const [mins, hours, doms, mons, dows] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  const d = new Date(from.getTime());
  d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (mons.has(d.getMonth() + 1) && doms.has(d.getDate()) && dows.has(d.getDay()) && hours.has(d.getHours()) && mins.has(d.getMinutes())) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

const relSpan = (ms: number): string => {
  const abs = Math.abs(ms);
  const unit = abs < 60_000 ? "s" : abs < 3_600_000 ? "m" : abs < 86_400_000 ? "h" : "d";
  const n = Math.round(abs / (unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000));
  return ms >= 0 ? `in ${n}${unit}` : `${n}${unit} ago`;
};

// ── load + paint ─────────────────────────────────────────────────────────────

function fail(msg: string): void {
  toastError(msg);
}

/** Fire a schedule now, from its card. The button IS the progress. */
async function runNow(r: ScheduleRow, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.innerHTML = `<span class="btn-spinner"></span>Running`;
  const res = await api().scheduleRunNow(r.id).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  if (!res.ok) {
    btn.disabled = false; btn.textContent = "Run";
    toastError(`Couldn't run ${r.name}`, res.error ? { detail: res.error } : undefined);
    return;
  }
  toastOk(`${r.name} started`, { detail: "Its run appears under Recent runs." });
  // The runs lane tells us when it lands (onTaskRunsChanged repaints the page);
  // until then the button stays honest about what it is doing.
  window.setTimeout(() => { if (btn.isConnected) { btn.disabled = false; btn.textContent = "Run"; } }, 4000);
  void loadSchedulesPage();
}

/** A schedule to open as soon as the page has loaded — a deep link from a
 *  bundle's Overview, where clicking the schedule means "show me this one". */
let pendingOpen: string | null = null;
export function openScheduleOnLoad(id: string): void { pendingOpen = String(id || "") || null; }

export async function loadSchedulesPage(): Promise<void> {
  wire();
  const [r, rr, t, s, a] = await Promise.all([
    api().schedulesList(), api().scheduleRecentRuns(),
    api().tasksSpecs().catch(() => ({ ok: false } as Env<TaskSpecLite[]>)),
    api().skillsList("skill").catch(() => ({ ok: false } as Env<SkillLite[]>)),
    api().libraryAgentsList().catch(() => ({ ok: false } as Env<AgentLite[]>)),
  ]);
  if (!r.ok) { fail(r.error || "Couldn't load schedules."); return; }
  rows = r.data ?? [];
  recents = rr.ok ? rr.data ?? [] : [];
  tasks = t.ok ? t.data ?? [] : [];
  skills = s.ok ? (s.data ?? []).filter((x) => x.source === "glyphh") : [];
  agents = a.ok ? a.data ?? [] : [];
  paintOverview();
  // A deep link lands on the schedule itself, not the list.
  if (pendingOpen) {
    const want = rows.find((x) => x.id === pendingOpen);
    pendingOpen = null;
    if (want) void openEditor(want);
  }
}

function targetName(row: ScheduleRow): string {
  if (row.kind === "task") return tasks.find((x) => x.slug === row.target)?.name || row.target;
  return skills.find((x) => x.id === `glyphh:${row.target}` || x.name === row.target)?.name || row.target;
}

function paintOverview(): void {
  const list = el("schedules-list"); const count = el("schedules-count");
  if (!list) return;
  const now = Date.now();
  const shown = rows
    .filter((r) => !query || `${r.name} ${targetName(r)} ${r.agentName || ""}`.toLowerCase().includes(query))
    .map((r) => ({ r, next: r.enabled ? cronNext(r.cron, new Date()) : null }))
    .sort((a, b) => (a.next?.getTime() ?? Infinity) - (b.next?.getTime() ?? Infinity));
  if (count) count.textContent = rows.length ? String(rows.length) : "";
  list.textContent = "";
  if (!shown.length) {
    list.innerHTML = `<div class="crud-empty">${query ? "No schedules match." : "Nothing on the clock yet. Add one here, or give a task a schedule and it shows up on this page."}</div>`;
  }
  for (const { r, next } of shown) {
    const card = document.createElement("div");
    card.className = "ws-task-card" + (r.enabled ? "" : " off");
    // WHAT FIRES NEXT, NOT WHAT WENT WRONG (his order, 2026-09-17): a run's
    // outcome and its error are Recent runs' business, and the schedule's own
    // detail carries the whole history. The card says running when one is in
    // flight, because that is the schedule's state right now.
    const status = r.lastStatus === "running" ? `<span class="ws-task-chip">running</span>` : "";
    const when = r.enabled
      ? (next ? `<span class="ws-task-next" title="${escapeHtml(next.toLocaleString())}">${escapeHtml(relSpan(next.getTime() - now))}</span>` : `<span class="ws-task-next">—</span>`)
      : `<span class="ws-task-next">paused</span>`;
    card.innerHTML = `
      <div class="ws-task-head"><span class="ws-task-name"></span>${status}${when}</div>
      <div class="ws-task-sub">
        <span class="ws-task-kind">${r.kind === "task" ? "task" : "skill"}</span>
        <span class="ws-task-target"></span>
        ${r.kind === "skill" ? `<span class="ws-task-agent"></span>` : ""}
        <span class="ws-task-cron" title="${escapeHtml(r.cron)}">${escapeHtml(cronToWords(r.cron))}</span>
      </div>`;
    (card.querySelector(".ws-task-name") as HTMLElement).textContent = r.name;
    (card.querySelector(".ws-task-target") as HTMLElement).textContent = targetName(r);
    const ag = card.querySelector(".ws-task-agent") as HTMLElement | null; if (ag) ag.textContent = r.agentName || "";
    // RUN IT FROM HERE (his order, 2026-09-17): the card is where the user is
    // looking, and waiting 18 hours to find out whether it works is no test.
    const run = document.createElement("button");
    run.type = "button";
    run.className = "action-btn ws-task-run";
    run.textContent = "Run";
    run.title = "Run it now";
    run.addEventListener("click", (ev) => { ev.stopPropagation(); void runNow(r, run); });
    (card.querySelector(".ws-task-head") as HTMLElement).appendChild(run);
    card.addEventListener("click", () => openEditor(r));
    list.appendChild(card);
  }
  paintRecents();
  paintChart();
}

function paintRecents(): void {
  const host = el("schedules-recent"); if (!host) return;
  host.textContent = "";
  if (!recents.length) { host.innerHTML = `<div class="crud-empty">No runs yet.</div>`; return; }
  for (const run of recents.slice(0, 15)) {
    const e = document.createElement("div");
    e.className = "ws-task-recent" + (run.status === "ok" ? "" : " failed");
    const when = new Date(run.startedAt);
    e.innerHTML = `<span class="ws-task-chip ${run.status === "ok" ? "ok" : run.status === "running" ? "" : "err"}">${escapeHtml(run.status)}</span><span class="ws-task-recent-name"></span><span class="ws-task-run-when" title="${escapeHtml(when.toLocaleString())}">${escapeHtml(relSpan(when.getTime() - Date.now()))}</span>`;
    (e.querySelector(".ws-task-recent-name") as HTMLElement).textContent = run.scheduleName || (run.taskSlug ? `${tasks.find((t) => t.slug === run.taskSlug)?.name || run.taskSlug} (${run.trigger || "manual"})` : "run");
    const owner = run.scheduleId ? rows.find((r) => r.id === run.scheduleId) : null;
    if (owner) e.addEventListener("click", () => openEditor(owner));
    host.appendChild(e);
  }
}

function paintChart(): void {
  const canvas = el<HTMLCanvasElement>("schedules-chart"); if (!canvas) return;
  const Chart = (window as unknown as { Chart?: new (el: HTMLCanvasElement, cfg: unknown) => { destroy(): void } }).Chart;
  if (!Chart) return;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim() || "#8c3bf2";
  const danger = css.getPropertyValue("--danger").trim() || "#e5534b";
  const text3 = css.getPropertyValue("--text-3").trim() || "#888";
  const days: string[] = []; const keys: string[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    keys.push(d.toDateString()); days.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  }
  const ok = new Array(14).fill(0) as number[]; const bad = new Array(14).fill(0) as number[];
  for (const run of recents) {
    const idx = keys.indexOf(new Date(run.startedAt).toDateString());
    if (idx === -1 || run.status === "running") continue;
    if (run.status === "ok") ok[idx]!++; else bad[idx]!++;
  }
  chart?.destroy();
  chart = new Chart(canvas, {
    type: "bar",
    data: { labels: days, datasets: [
      { label: "ok", data: ok, backgroundColor: accent, borderRadius: 3, maxBarThickness: 34 },
      { label: "failed", data: bad, backgroundColor: danger, borderRadius: 3, maxBarThickness: 34 },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: "bottom", labels: { color: text3, usePointStyle: true, pointStyle: "circle", boxWidth: 6, boxHeight: 6, font: { size: 11 } } }, tooltip: { mode: "index", intersect: false } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: text3, maxRotation: 0, autoSkip: true } },
        y: { stacked: true, beginAtZero: true, grid: { color: css.getPropertyValue("--border").trim() || "rgba(255,255,255,0.08)" }, ticks: { color: text3, precision: 0 } },
      },
    },
  });
}

// ── the edit page ────────────────────────────────────────────────────────────

let parsed: { cron: string; words: string } | null = null;

function fillTargets(selected: { kind: "task" | "skill"; target: string } | null): void {
  const sel = el<HTMLSelectElement>("schedule-target"); if (!sel) return;
  const opt = (kind: string, value: string, label: string, on: boolean): string => `<option value="${kind}:${escapeHtml(value)}"${on ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const t = tasks.map((x) => opt("task", x.slug, x.name, selected?.kind === "task" && selected.target === x.slug)).join("");
  const s = skills.map((x) => opt("skill", x.id.replace(/^glyphh:/, ""), x.name, selected?.kind === "skill" && selected.target === x.id.replace(/^glyphh:/, ""))).join("");
  sel.innerHTML = (t ? `<optgroup label="Tasks">${t}</optgroup>` : "") + (s ? `<optgroup label="Skills">${s}</optgroup>` : "") || `<option value="">Nothing to schedule yet: add a task under Build</option>`;
  onTargetChange();
}

function onTargetChange(): void {
  const sel = el<HTMLSelectElement>("schedule-target");
  const kind = (sel?.value || "").split(":")[0];
  el("schedule-agent-row")?.classList.toggle("hidden", kind !== "skill");
  const hint = el("schedule-target-hint");
  if (hint) hint.textContent = kind === "task" ? "The task's program runs on its own; its slots decide which agents it calls." : kind === "skill" ? "The skill's instructions go to the agent below as one headless turn." : "";
}

function fillAgents(selected: string | null): void {
  const sel = el<HTMLSelectElement>("schedule-agent"); if (!sel) return;
  sel.innerHTML = agents.map((a) => `<option value="${escapeHtml(a.id)}"${a.id === selected ? " selected" : ""}>${escapeHtml(a.name)}</option>`).join("") || `<option value="">No agents yet</option>`;
}

function previewSay(): void {
  const say = el<HTMLInputElement>("schedule-say"); const prev = el("schedule-say-preview");
  if (!say || !prev) return;
  parsed = humanToCron(say.value);
  if (parsed) prev.innerHTML = `✓ ${escapeHtml(parsed.words)} &nbsp;<span style="font-family:ui-monospace,monospace;opacity:.6;">${escapeHtml(parsed.cron)}</span>`;
  else prev.innerHTML = say.value.trim() ? `Didn't get that. Try <i>weekdays at 9am</i>, <i>every 15 minutes</i>, or a five-field cron.` : `Say it like a human: <i>weekdays at 9am</i>, <i>every 15 minutes</i>, <i>mondays at 8:30</i>, <i>monthly on the 1st</i>. A five-field cron works too.`;
}

async function openEditor(row: ScheduleRow | null): Promise<void> {
  editing = row;
  el("schedules-overview")?.classList.add("hidden");
  el("schedules-head")?.classList.add("hidden");
  el("schedules-toolbar")?.classList.add("hidden");
  el("schedule-editor")?.classList.remove("hidden");
  el("schedule-form-error")?.classList.add("hidden");
  const head = el("schedule-detail-head"); if (head) head.textContent = row ? row.name : "New schedule";
  (el<HTMLInputElement>("schedule-name")!).value = row?.name ?? "";
  fillTargets(row ? { kind: row.kind, target: row.target } : null);
  fillAgents(row?.agentId ?? null);
  const say = el<HTMLInputElement>("schedule-say")!; say.value = row?.cron ?? ""; previewSay();
  (el<HTMLInputElement>("schedule-enabled")!).checked = row ? row.enabled : true;
  el("schedule-delete-btn")?.classList.toggle("hidden", !row);
  el("schedule-run-btn")?.classList.toggle("hidden", !row);
  el("schedule-runs-block")?.classList.toggle("hidden", !row);
  if (row) void paintRuns(row.id);
}

function closeEditor(): void {
  editing = null;
  el("schedule-editor")?.classList.add("hidden");
  el("schedules-overview")?.classList.remove("hidden");
  el("schedules-head")?.classList.remove("hidden");
  el("schedules-toolbar")?.classList.remove("hidden");
}

async function paintRuns(id: string): Promise<void> {
  const host = el("schedule-runs"); if (!host) return;
  host.innerHTML = `<div class="crud-empty">Loading history…</div>`;
  const r = await api().scheduleRuns(id);
  if (!host.isConnected || editing?.id !== id) return;
  if (!r.ok) { host.innerHTML = `<div class="crud-empty">${escapeHtml(r.error || "Couldn't load runs")}</div>`; return; }
  const runs = r.data ?? [];
  if (!runs.length) { host.innerHTML = `<div class="crud-empty">No runs yet.</div>`; return; }
  host.textContent = "";
  for (const run of runs) {
    const e = document.createElement("div");
    e.className = "ws-task-run" + (run.status === "ok" ? "" : " failed");
    const when = new Date(run.startedAt);
    e.innerHTML = `<div class="ws-task-run-head"><span class="ws-task-chip ${run.status === "ok" ? "ok" : run.status === "running" ? "" : "err"}">${escapeHtml(run.status)}</span><span class="ws-task-run-when" title="${escapeHtml(when.toLocaleString())}">${escapeHtml(relSpan(when.getTime() - Date.now()))}</span>${run.durationMs != null ? `<span class="ws-task-run-dur">${(run.durationMs / 1000).toFixed(1)}s</span>` : ""}${run.taskSlug ? `<button class="action-btn ws-task-story-btn" type="button">Story</button>` : ""}</div>${run.error ? `<pre class="ws-task-run-err"></pre>` : ""}${run.output && !run.taskSlug ? `<pre class="ws-task-run-out"></pre>` : ""}`;
    const err = e.querySelector(".ws-task-run-err") as HTMLElement | null; if (err) err.textContent = run.error || "";
    const out = e.querySelector(".ws-task-run-out") as HTMLElement | null; if (out) out.textContent = run.output || "";
    e.querySelector(".ws-task-story-btn")?.addEventListener("click", () => {
      (window as unknown as { __glyphhOpenTaskRun?: (slug: string, runId: string) => void }).__glyphhOpenTaskRun?.(run.taskSlug!, run.id);
    });
    host.appendChild(e);
  }
}

async function save(): Promise<void> {
  const errEl = el("schedule-form-error");
  const show = (m: string): void => { if (errEl) { errEl.textContent = m; errEl.classList.remove("hidden"); } };
  const sel = el<HTMLSelectElement>("schedule-target");
  const [kind, ...rest] = (sel?.value || "").split(":");
  const target = rest.join(":");
  if (!target) { show("Pick what to run."); return; }
  if (!parsed) { show("Say when it runs."); return; }
  const r = await api().scheduleSave({
    id: editing?.id, name: (el<HTMLInputElement>("schedule-name")?.value || "").trim() || undefined, kind, target,
    agentId: kind === "skill" ? el<HTMLSelectElement>("schedule-agent")?.value || null : null,
    cron: parsed.cron, enabled: !!el<HTMLInputElement>("schedule-enabled")?.checked,
  });
  if (!r.ok) { show(r.error || "Couldn't save."); return; }
  closeEditor();
  await loadSchedulesPage();
}

function wire(): void {
  if (wired) return;
  wired = true;
  el("schedule-new-btn")?.addEventListener("click", () => void openEditor(null));
  el("schedules-refresh")?.addEventListener("click", () => void loadSchedulesPage());
  el<HTMLInputElement>("schedules-search")?.addEventListener("input", (e) => { query = (e.target as HTMLInputElement).value.trim().toLowerCase(); paintOverview(); });
  el("schedule-back-link")?.addEventListener("click", closeEditor);
  el("schedule-cancel-btn")?.addEventListener("click", closeEditor);
  el("schedule-save-btn")?.addEventListener("click", () => void save());
  el("schedule-target")?.addEventListener("change", onTargetChange);
  el<HTMLInputElement>("schedule-say")?.addEventListener("input", previewSay);
  el("schedule-delete-btn")?.addEventListener("click", async () => {
    if (!editing) return;
    const sure = await confirmAction({ title: `Delete "${editing.name}"?`, body: "Its run history stays; nothing fires again.", confirmLabel: "Delete", danger: true });
    if (!sure) return;
    const r = await api().scheduleDelete(editing.id);
    if (!r.ok) { fail(r.error || "Couldn't delete."); return; }
    closeEditor();
    await loadSchedulesPage();
  });
  el("schedule-run-btn")?.addEventListener("click", async (ev) => {
    if (!editing) return;
    const btn = ev.currentTarget as HTMLButtonElement;
    btn.disabled = true; btn.textContent = "Running…";
    const r = await api().scheduleRunNow(editing.id);
    btn.disabled = false; btn.textContent = "▶ Run now";
    if (!r.ok) { const e = el("schedule-form-error"); if (e) { e.textContent = r.error || "Couldn't run."; e.classList.remove("hidden"); } }
    const id = editing.id;
    setTimeout(() => { if (editing?.id === id) void paintRuns(id); }, 1500);
  });
  api().onTaskRunsChanged?.(() => {
    if (!el("schedules-list")?.isConnected) return;
    void api().scheduleRecentRuns().then((rr) => { if (rr.ok) { recents = rr.data ?? []; if (!editing) { paintRecents(); paintChart(); } else void paintRuns(editing.id); } });
  });
}

export function initSchedulesEvents(): void { wire(); }
