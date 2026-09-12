/**
 * Agents section — the workforce roster, with BOTH authoring doors open.
 *
 * Restored 2026-09-11 from the pre-purge page (4cae30db^) and ported to
 * LOCAL storage (main/local-agents.ts). What changed and why:
 *
 *   - `scope: personal | org` is gone. Org sharing was enforced by a server
 *     that no longer sits behind this; a selector that silently did nothing
 *     would be a lie.
 *   - The Loop dropdown lists CLI LOOPS (the Loops page's pre-configs) —
 *     that is what "loop" means now. The old per-role model SLOTS collapse
 *     to one optional model override, since a loop carries its own model.
 *   - Agents gained a PROMPT: the standing instruction each run opens with
 *     (his ask: "agents which have prompts, tasks, etc").
 *   - A task's kind is task | skill. The pre-purge "loop" kind IS the "task"
 *     kind — that store was renamed, not removed.
 *
 * Everything else is the original: the roster table, the READ + OPERATIONAL
 * detail (live/pause, task enable/disable, reschedule, run-now, run feeds,
 * delete), and the manual form behind "+ New" / Edit.
 */

import { $a, escapeHtml, paginate, renderPaginationBar, confirmAction, slugify } from "./shared.js";
import { seedComposer } from "./code.js";
import { kebabCell, ROW_MENU_ICONS, wireSplitDivider } from "./lib-editor.js";
import { formatMarkdown } from "../format-markdown.js";
import {
  unwrap,
  type Agent, type AgentSummary, type AgentTask, type AgentTaskRun,
  type GuardrailsPolicy,
} from "./library-types.js";

/** A CLI loop, as the Loops page stores it. */
interface LoopOption { id: string; name: string; cli?: string; model?: string }
/** A pickable target for a task: a task spec or a skill. */
interface TargetOption { slug: string; name: string }
/** A governed model, as the catalog hands it over. */
interface CatalogModel { id: string; name: string; providerSlug?: string; pickerVisible?: boolean }

let all: AgentSummary[] = [];
let loops: LoopOption[] = [];
let taskSpecs: TargetOption[] = [];
let skills: TargetOption[] = [];
let models: CatalogModel[] = [];
let page = 0;
let current: Agent | null = null;

const listEl = $a("agents-list");
const toolbar = $a("agents-toolbar");
const editor = $a("agent-editor");
const searchInput = $a<HTMLInputElement>("agent-search");
const formError = $a("agent-form-error");
const detailEl = $a("agent-detail");
const sideEl = $a("agent-side");
const liveToggle = $a<HTMLInputElement>("agent-live");

// ── The manual form's elements ──────────────────────────────────────────────
const form = $a("agent-form");
const formErr = $a("agent-form-err");
const fName = $a<HTMLInputElement>("agent-f-name");
const fSlug = $a<HTMLInputElement>("agent-f-slug");
const fDesc = $a<HTMLTextAreaElement>("agent-f-desc");
const fPrompt = $a<HTMLTextAreaElement>("agent-f-prompt");
const fSource = $a<HTMLSelectElement>("agent-f-source");
const fLoop = $a<HTMLSelectElement>("agent-f-loop");
const fProvider = $a<HTMLSelectElement>("agent-f-provider");
const fModel = $a<HTMLSelectElement>("agent-f-model");
const fSkills = $a("agent-f-skills");
const fApps = $a<HTMLInputElement>("agent-f-apps");
const fTasks = $a("agent-f-tasks");

function fail(msg: string): void {
  formError.textContent = msg;
  formError.classList.remove("hidden");
}

function failForm(msg: string): void {
  formErr.textContent = msg;
  formErr.classList.remove("hidden");
}

const api = () => window.glyphh as unknown as {
  libraryAgentsList: () => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  libraryAgentGet: (ref: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  libraryAgentCreate: (input: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  libraryAgentUpdate: (ref: string, patch: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  libraryAgentDelete: (ref: string) => Promise<{ ok: boolean; error?: string }>;
  libraryAgentTasks: (ref: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  libraryAgentTaskAdd: (ref: string, input: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  libraryAgentTaskUpdate: (ref: string, taskId: string, patch: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  libraryAgentTaskDelete: (ref: string, taskId: string) => Promise<{ ok: boolean; error?: string }>;
  libraryAgentTaskRuns: (ref: string, taskId: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  libraryAgentTaskRunning: (ref: string, taskId: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  libraryAgentTaskRunNow: (ref: string, taskId: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  cliAgentsList?: () => Promise<{ ok: boolean; agents: LoopOption[] }>;
  loopsList?: () => Promise<{ ok: boolean; loops?: Array<{ slug: string; name: string }> }>;
  librarySkillsList?: () => Promise<{ ok: boolean; data?: unknown }>;
  workspacesModelCatalog?: () => Promise<{ ok: boolean; models?: CatalogModel[] }>;
};

// ── Cards ───────────────────────────────────────────────────────────────────

/** Stable hue from an id — the same trick the old agent identicons used. */
function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/** The agent's cast as a small round badge: the loop's initial on a stable
 *  per-loop color, plus the model override when it carries one. */
function castBadges(agent: AgentSummary): string {
  const ids = [agent.provider || agent.loopId, agent.model].filter((x): x is string => !!x);
  if (!ids.length) return "";
  const dots = ids.map((id) => {
    const bare = id.includes("::") ? id.slice(id.indexOf("::") + 2) : id;
    const letter = (bare[0] || "?").toUpperCase();
    return `<span class="agent-model-dot" style="--dot:hsl(${hueFor(id)} 60% 45%)" title="${escapeHtml(id)}">${escapeHtml(letter)}</span>`;
  }).join("");
  return `<span class="agent-model-cast">${dots}</span>`;
}

/** Everything the form and detail pick FROM — loops, task specs, skills and
 *  the governed model catalog. Loaded once per page visit. */
async function loadOptions(): Promise<void> {
  const a = api();
  const [loopsRes, specsRes, skillsRes, modelsRes] = await Promise.all([
    a.cliAgentsList?.().catch(() => null) ?? Promise.resolve(null),
    a.loopsList?.().catch(() => null) ?? Promise.resolve(null),
    a.librarySkillsList?.().catch(() => null) ?? Promise.resolve(null),
    a.workspacesModelCatalog?.().catch(() => null) ?? Promise.resolve(null),
  ]);
  loops = loopsRes?.ok ? loopsRes.agents : [];
  // loopsList is the TASK SPEC store (renamed; see local-library.ts).
  // Independent of the loops call — gating them together meant one failure
  // silently emptied the other list.
  taskSpecs = (specsRes?.ok ? specsRes.loops ?? [] : []).map((t) => ({ slug: t.slug, name: t.name }));
  const sk = skillsRes?.ok ? (skillsRes.data as Array<{ slug: string; name: string }> | undefined) ?? [] : [];
  skills = sk.map((s) => ({ slug: s.slug, name: s.name }));
  models = (modelsRes?.ok ? modelsRes.models ?? [] : []).filter((m) => m.pickerVisible !== false);
}

export async function loadAgents(): Promise<void> {
  listEl.innerHTML = `<div class="crud-empty">Loading…</div>`;
  try {
    await loadOptions();
    all = unwrap<AgentSummary[]>(await api().libraryAgentsList());
  } catch (err) {
    listEl.innerHTML = `<div class="crud-empty">Couldn't load agents — ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
    return;
  }
  renderList();
}

function renderList(): void {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = query
    ? all.filter((a) => `${a.name} ${a.slug} ${a.description}`.toLowerCase().includes(query))
    : all;

  listEl.className = "app-list-wrap";
  editor.classList.add("hidden");
  form?.classList.add("hidden");
  toolbar.classList.remove("hidden");
  listEl.classList.remove("hidden");
  listEl.innerHTML = "";
  current = null;

  if (all.length === 0) {
    listEl.innerHTML = `<div class="crud-empty">No agents yet — <b>+ New</b> builds one.</div>`;
    return;
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="crud-empty">No agents matching "${escapeHtml(query)}"</div>`;
    return;
  }

  const { items, state } = paginate(filtered, page);
  page = state.page;
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Name</th><th>Description</th><th>Runs on</th><th>Status</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const agent of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-desc"></td>
      <td>${castBadges(agent)}</td>
      <td>${agent.live ? `<span class="lib-badge lib-badge-live">Live</span>` : "Paused"}</td>
      `;
    tr.querySelector(".lib-table-name")!.textContent = agent.name;
    tr.querySelector(".lib-table-desc")!.textContent = agent.description || agent.slug;
    tr.addEventListener("click", () => void openDetail(agent.id));
    tr.appendChild(kebabCell(() => [
      // Edit opens the MANUAL FORM pre-filled; the row click stays the
      // read/operational detail.
      { icon: ROW_MENU_ICONS.edit, label: "Edit", onClick: () => void openFormFor(agent.id) },
      { icon: ROW_MENU_ICONS.delete, label: "Delete", danger: true, onClick: () => {
        void (async () => {
          const sure = await confirmAction({ title: `Delete "${agent.name}"?`, body: "Its scheduled tasks stop firing with it.", confirmLabel: "Delete", danger: true });
          if (!sure) return;
          const env = await api().libraryAgentDelete(agent.id);
          if (env.ok) await loadAgents();
        })();
      } },
    ]));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  listEl.appendChild(table);
  if (state.totalPages > 1) listEl.appendChild(renderPaginationBar(state, (p) => { page = p; renderList(); }));
}

// ── Detail (read) ───────────────────────────────────────────────────────────

/** "0 8 * * *" → "every day at 8:00" — the schedule in words, raw as fallback. */
export function humanCron(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [min, hour, dom, month, dow] = f;
  const num = (s: string) => (/^\d+$/.test(s) ? parseInt(s, 10) : null);
  const time = num(min!) !== null && num(hour!) !== null
    ? `${num(hour!)}:${String(num(min!)).padStart(2, "0")}`
    : null;
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (time && dom === "*" && month === "*" && dow === "*") return `every day at ${time}`;
  if (time && dom === "*" && month === "*" && num(dow!) !== null) return `every ${DAYS[num(dow!)! % 7]} at ${time}`;
  if (min !== "*" && hour === "*" && dom === "*" && month === "*" && dow === "*" && num(min!) !== null) {
    return `hourly at :${String(num(min!)).padStart(2, "0")}`;
  }
  if (min!.startsWith("*/")) return `every ${min!.slice(2)} minutes`;
  return cron;
}

function readRow(label: string, value: string): string {
  return `<div class="lib-read-row"><span class="lib-read-label">${escapeHtml(label)}</span><span class="lib-read-value">${escapeHtml(value)}</span></div>`;
}

/** Compose a cron from the schedule editor's preset fields. */
function cronFromPreset(kind: string, hour: number, minute: number, day: number, everyN: number, custom: string): string {
  switch (kind) {
    case "daily": return `${minute} ${hour} * * *`;
    case "weekly": return `${minute} ${hour} * * ${day}`;
    case "hourly": return `${minute} * * * *`;
    case "minutes": return `*/${Math.max(1, everyN)} * * * *`;
    default: return custom.trim();
  }
}

/** The schedule control: presets people actually mean, cron only for the rare
 *  custom case. One grammar for BOTH the operational reschedule (autosave) and
 *  the manual form's task rows (read on Save). */
interface CronControl {
  el: HTMLElement;
  read(): string;
  onChange(cb: () => void): void;
}

function cronControl(initial: string): CronControl {
  const f = initial.trim().split(/\s+/);
  const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? parseInt(s, 10) : null);
  const curMin = num(f[0]) ?? 0;
  const curHour = num(f[1]) ?? 8;
  const curDow = num(f[4]) ?? 1;
  const kind0 = f.length === 5 && f[0]?.startsWith("*/") ? "minutes"
    : f[1] === "*" && num(f[0]) !== null ? "hourly"
    : num(f[4]) !== null ? "weekly"
    : num(f[0]) !== null && num(f[1]) !== null ? "daily" : "custom";

  const el = document.createElement("div");
  el.className = "lib-sched-editor";
  el.innerHTML = `
    <select class="settings-input se-kind">
      <option value="daily">Every day at</option>
      <option value="weekly">Every week on</option>
      <option value="hourly">Every hour at minute</option>
      <option value="minutes">Every N minutes</option>
      <option value="custom">Custom cron</option>
    </select>
    <select class="settings-input se-day hidden">
      ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => `<option value="${i}">${d}</option>`).join("")}
    </select>
    <input type="time" class="settings-input se-time" value="${String(curHour).padStart(2, "0")}:${String(curMin).padStart(2, "0")}" />
    <input type="number" class="settings-input se-minute hidden" min="0" max="59" value="${curMin}" />
    <input type="number" class="settings-input se-every hidden" min="1" max="59" value="15" />
    <input type="text" class="settings-input se-custom hidden" spellcheck="false" />
    <span class="se-preview"></span>`;

  const q = <T extends HTMLElement>(sel: string): T => el.querySelector(sel) as T;
  const kindSel = q<HTMLSelectElement>(".se-kind");
  kindSel.value = kind0;
  q<HTMLSelectElement>(".se-day").value = String(curDow);
  q<HTMLInputElement>(".se-custom").value = initial;

  const read = (): string => {
    const [hh, mm] = q<HTMLInputElement>(".se-time").value.split(":").map((n) => parseInt(n, 10));
    return cronFromPreset(
      kindSel.value, hh ?? 8,
      kindSel.value === "hourly" ? (parseInt(q<HTMLInputElement>(".se-minute").value, 10) || 0) : (mm ?? 0),
      parseInt(q<HTMLSelectElement>(".se-day").value, 10) || 0,
      parseInt(q<HTMLInputElement>(".se-every").value, 10) || 15,
      q<HTMLInputElement>(".se-custom").value,
    );
  };
  const sync = (): void => {
    const k = kindSel.value;
    q(".se-day").classList.toggle("hidden", k !== "weekly");
    q(".se-time").classList.toggle("hidden", k !== "daily" && k !== "weekly");
    q(".se-minute").classList.toggle("hidden", k !== "hourly");
    q(".se-every").classList.toggle("hidden", k !== "minutes");
    q(".se-custom").classList.toggle("hidden", k !== "custom");
    q(".se-preview").textContent = humanCron(read());
  };
  sync();

  const listeners: Array<() => void> = [];
  el.querySelectorAll("select, input").forEach((n) => {
    const h = (): void => { sync(); for (const cb of listeners) cb(); };
    n.addEventListener("input", h);
    n.addEventListener("change", h);
  });
  return { el, read, onChange: (cb) => listeners.push(cb) };
}

/** The OPERATIONAL reschedule on a task row. Replaces the row content until
 *  Done. AUTOSAVE: every change composes the cron and saves it (debounced) —
 *  no Save button between a schedule and its taking effect. */
function scheduleEditor(task: AgentTask, row: HTMLElement, repaint: () => void): void {
  row.innerHTML = "";
  const ctl = cronControl(task.cron);
  const status = document.createElement("span");
  status.className = "se-status";
  const done = document.createElement("button");
  done.type = "button";
  done.className = "action-btn se-done";
  done.textContent = "Done";
  ctl.el.append(status, done);
  row.appendChild(ctl.el);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  ctl.onChange(() => {
    if (saveTimer) clearTimeout(saveTimer);
    status.textContent = "…";
    saveTimer = setTimeout(() => {
      void (async () => {
        const cron = ctl.read();
        if (!cron || cron.trim().split(/\s+/).length !== 5) { status.textContent = ""; return; }
        const r = await api().libraryAgentTaskUpdate(current!.id, task.id, { cron });
        status.textContent = r.ok ? "saved ✓" : (r.error || "save failed");
        if (r.ok) task.cron = cron;
      })();
    }, 500);
  });
  done.addEventListener("click", repaint);
}

const RUN_CARET = `<svg class="lib-run-caret" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

/** One run as a collapsible row: date/time on the left, Success/Failed on the
 *  far right; the header click reveals what the run produced. */
function runRow(run: AgentTaskRun): HTMLElement {
  const bad = run.status !== "ok";
  const row = document.createElement("div");
  row.className = "lib-run-row" + (bad ? " error" : "");
  const when = new Date(run.startedAt).toLocaleString();
  const dur = run.durationMs != null ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : "";
  row.innerHTML = `
    <button type="button" class="lib-run-rowhead">
      ${RUN_CARET}
      <span class="lib-run-when">${escapeHtml(when)}${dur}</span>
      <span class="lib-run-badge ${bad ? "err" : "ok"}">${bad ? "Failed" : "Success"}</span>
    </button>
    <div class="lib-run-detail hidden"><div class="lib-run-body"></div></div>`;
  const body = row.querySelector<HTMLElement>(".lib-run-body")!;
  if (bad && run.error) {
    body.textContent = run.error;
  } else {
    // A run's output IS a chat turn — render it like one.
    body.classList.add("md");
    body.innerHTML = formatMarkdown(run.output || "*(no output)*");
  }
  row.querySelector(".lib-run-rowhead")!.addEventListener("click", () => {
    row.classList.toggle("open");
    row.querySelector(".lib-run-detail")!.classList.toggle("hidden");
  });
  return row;
}

/** An in-flight run: same row shape, no detail — just the live spinner. */
function runningRow(): HTMLElement {
  const row = document.createElement("div");
  row.className = "lib-run-row running";
  row.innerHTML = `
    <div class="lib-run-rowhead">
      <span class="lib-run-spin"></span>
      <span class="lib-run-when">now</span>
      <span class="lib-run-badge running">Running…</span>
    </div>`;
  return row;
}

type FeedHost = HTMLElement & { __feedTimer?: ReturnType<typeof setTimeout> };

/** The run LIST: newest first, each a collapsible row. While a run is in
 *  flight it tops the list live; the feed re-polls until it lands. */
async function runFeed(task: AgentTask, host: FeedHost, opts: { quiet?: boolean } = {}): Promise<void> {
  if (host.__feedTimer) { clearTimeout(host.__feedTimer); host.__feedTimer = undefined; }
  if (!opts.quiet) host.innerHTML = `<div class="crud-empty">Loading runs…</div>`;
  const [env, runningEnv] = await Promise.all([
    api().libraryAgentTaskRuns(current!.id, task.id),
    api().libraryAgentTaskRunning(current!.id, task.id),
  ]);
  if (!host.isConnected) return;
  if (!env.ok) { host.innerHTML = `<div class="crud-empty">Couldn't load runs.</div>`; return; }
  const runs = (env.data as AgentTaskRun[]) ?? [];
  const running = runningEnv.ok ? runningEnv.data === true : false;
  host.innerHTML = "";
  if (running) host.appendChild(runningRow());
  if (!runs.length && !running) {
    host.innerHTML = `<div class="crud-empty">No runs yet — the next firing lands here.</div>`;
  } else {
    for (const run of runs) host.appendChild(runRow(run));
  }
  // Live while running (2s), a slow keep-fresh tick otherwise (15s) — so
  // scheduled firings appear without leaving and coming back.
  host.__feedTimer = setTimeout(() => { void runFeed(task, host, { quiet: true }); }, running ? 2000 : 15_000);
}

function taskRow(task: AgentTask): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "lib-task-wrap";
  const row = document.createElement("div");
  row.className = "lib-task-row";
  const feed = document.createElement("div");
  feed.className = "lib-run-feed";
  wrap.append(row, feed);
  void runFeed(task, feed);

  const paintRow = (): void => {
    const status = task.lastError
      ? `failed — ${task.lastError.slice(0, 60)}`
      : task.lastRunAt
        ? `${task.lastStatus ?? "ran"} · ${new Date(task.lastRunAt).toLocaleString()}`
        : "never run yet";
    row.innerHTML = `
      <label class="lib-task-enabled" title="Enabled"><input type="checkbox" ${task.enabled ? "checked" : ""} /></label>
      <span class="lib-task-name"></span>
      <span class="lib-task-binding"></span>
      <button type="button" class="lib-task-sched" title="Change the schedule"></button>
      <span class="lib-task-status"${task.lastError ? ' style="color:var(--danger)"' : ""}></span>
      <button type="button" class="lib-task-run" title="Run this task now">▶ run</button>`;
    row.querySelector(".lib-task-name")!.textContent = task.name;
    row.querySelector(".lib-task-binding")!.textContent = `runs ${task.kind} ${task.target}`;
    row.querySelector(".lib-task-sched")!.textContent = humanCron(task.cron);
    row.querySelector(".lib-task-status")!.textContent = status;

    row.querySelector<HTMLInputElement>(".lib-task-enabled input")!.addEventListener("change", async (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      const r = await api().libraryAgentTaskUpdate(current!.id, task.id, { enabled });
      if (!r.ok) { fail(r.error || "couldn't toggle the task"); (e.target as HTMLInputElement).checked = !enabled; }
      else task.enabled = enabled;
    });
    // The schedule itself is the edit affordance — click it to change it.
    row.querySelector(".lib-task-sched")!.addEventListener("click", () => {
      scheduleEditor(task, row, () => {
        void (async () => {
          const env = await api().libraryAgentTasks(current!.id);
          const fresh = env.ok ? (env.data as AgentTask[]).find((x) => x.id === task.id) : null;
          if (fresh) Object.assign(task, fresh);
          paintRow();
        })();
      });
    });
    // Run NOW: fire through the scheduler's own door — the output arrives as
    // the feed's newest entry.
    const runBtn = row.querySelector<HTMLButtonElement>(".lib-task-run")!;
    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      runBtn.textContent = "running…";
      const pending = api().libraryAgentTaskRunNow(current!.id, task.id);
      // Repaint right away so the feed's "Running…" row shows while it goes.
      void runFeed(task, feed, { quiet: true });
      const r = await pending;
      runBtn.disabled = false;
      runBtn.textContent = "▶ run";
      if (!r.ok) fail(r.error || "run failed");
      // Refresh both the feed and the row's last-run glance.
      await runFeed(task, feed);
      const env = await api().libraryAgentTasks(current!.id);
      const fresh = env.ok ? (env.data as AgentTask[]).find((x) => x.id === task.id) : null;
      if (fresh) { Object.assign(task, fresh); paintRow(); }
    });
  };
  paintRow();
  return wrap;
}

/** Open one agent's detail from OUTSIDE the section — caller flips to the
 *  Agents section first. */
export function openAgentDetail(id: string): void {
  void openDetail(id);
}

const loopName = (id: string | null): string =>
  (id ? loops.find((l) => l.id === id)?.name ?? id : "—");

const modelName = (id: string): string =>
  (id ? models.find((m) => m.id === id)?.name ?? id : "");

async function openDetail(id: string): Promise<void> {
  formError.classList.add("hidden");
  if (!loops.length) await loadOptions();
  const env = await api().libraryAgentGet(id);
  if (!env.ok) { fail(env.error || "couldn't load the agent"); return; }
  current = env.data as Agent;

  liveToggle.checked = current.live;

  const gr = current.guardrails;
  const grRows = gr
    ? Object.entries(gr).filter(([, v]) => v != null)
        .map(([k, v]) => readRow(GR_LABELS[k as keyof GuardrailsPolicy] ?? k, String(v))).join("")
    : "";

  detailEl.innerHTML = `
    <h3 class="lib-read-title">${escapeHtml(current.name)}</h3>
    <p class="lib-read-desc">${escapeHtml(current.description || "")}</p>
    <div class="lib-read-meta">
      ${current.provider
        ? readRow("Provider", current.provider)
        : readRow("Loop", loopName(current.loopId))}
      ${readRow("Model", current.model ? modelName(current.model) : "the loop's own")}
      ${current.skills?.length ? readRow("Skills", current.skills.join(", ")) : ""}
      ${current.apps?.length ? readRow("Apps", current.apps.join(", ")) : ""}
    </div>
    ${current.prompt ? `<span class="lib-read-label" style="display:block;margin-top:16px;">Prompt</span><pre class="lib-read-pre"></pre>` : ""}
    ${grRows ? `<span class="lib-read-label" style="display:block;margin-top:16px;">Guardrails</span><div class="lib-read-meta" style="margin-top:6px;">${grRows}</div>` : ""}
    <div class="settings-actions" style="margin-top:24px;">
      <button id="agent-delete-btn" class="action-btn danger">Delete</button>
      <div style="flex:1;"></div>
    </div>`;
  const pre = detailEl.querySelector<HTMLElement>(".lib-read-pre");
  if (pre) pre.textContent = current.prompt;

  detailEl.querySelector("#agent-delete-btn")?.addEventListener("click", () => void deleteCurrent());

  // The RIGHT pane: the schedule and its run feeds — what this agent DOES.
  sideEl.innerHTML = `<span class="lib-read-label">Schedule</span><div id="agent-task-rows"></div>`;
  const rowsEl = sideEl.querySelector<HTMLElement>("#agent-task-rows")!;
  const tasksEnv = await api().libraryAgentTasks(current.id);
  const tasks = tasksEnv.ok ? (tasksEnv.data as AgentTask[]) : [];
  if (!tasks.length) {
    rowsEl.innerHTML = `<div class="crud-empty">No scheduled tasks — Edit this agent to add one, or ask the agent.</div>`;
  } else {
    for (const task of tasks) rowsEl.appendChild(taskRow(task));
  }

  toolbar.classList.add("hidden");
  listEl.classList.add("hidden");
  form?.classList.add("hidden");
  editor.classList.remove("hidden");
}

// ── The manual create/edit form ─────────────────────────────────────────────

/** null = create mode. Set to the created agent as soon as the write lands, so
 *  a retry after a failed task write PATCHes instead of duplicating. */
let formAgent: Agent | null = null;

interface TaskDraft {
  /** The existing task's id, or null for a not-yet-created row. */
  id: string | null;
  el: HTMLElement;
  cron: CronControl;
  read(): { name: string; kind: AgentTask["kind"]; target: string; enabled: boolean };
}

let formTasks: TaskDraft[] = [];
let removedTaskIds: string[] = [];

/** One editable task binding: name + kind + target + enabled on the first
 *  row, and the schedule grammar underneath. The TARGET is a dropdown of
 *  what actually exists — the pre-purge free-text slug field let you point a
 *  task at nothing and only find out when it fired. */
function addTaskDraft(task: AgentTask | null): void {
  if (!fTasks) return;
  const el = document.createElement("div");
  el.className = "agent-f-task";
  el.innerHTML = `
    <div class="lib-task-form">
      <input type="text" class="settings-input tf-name" placeholder="Task name" spellcheck="false" autocomplete="off" />
      <select class="settings-input tf-kind" title="What the task fires">
        <option value="task">Task</option>
        <option value="skill">Skill</option>
      </select>
      <select class="settings-input tf-target" title="Which one"></select>
      <label class="lib-skill-row tf-enabled-wrap" title="Armed while the agent is live"><input type="checkbox" class="tf-enabled" checked /> Enabled</label>
      <button type="button" class="action-btn danger tf-remove">Remove</button>
    </div>`;

  const q = <T extends HTMLElement>(sel: string): T => el.querySelector(sel) as T;
  const kindSel = q<HTMLSelectElement>(".tf-kind");
  const targetSel = q<HTMLSelectElement>(".tf-target");
  const paintTargets = (want?: string): void => {
    const pool = kindSel.value === "skill" ? skills : taskSpecs;
    targetSel.innerHTML = "";
    if (!pool.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = kindSel.value === "skill" ? "(no skills yet)" : "(no tasks yet)";
      targetSel.appendChild(opt);
      return;
    }
    for (const t of pool) {
      const opt = document.createElement("option");
      opt.value = t.slug;
      opt.textContent = t.name || t.slug;
      targetSel.appendChild(opt);
    }
    // A target that no longer exists still shows, so an edit doesn't
    // silently repoint the task at whatever happens to be first.
    if (want && !pool.some((t) => t.slug === want)) {
      const opt = document.createElement("option");
      opt.value = want;
      opt.textContent = `${want} (missing)`;
      targetSel.appendChild(opt);
    }
    if (want) targetSel.value = want;
  };

  if (task) {
    q<HTMLInputElement>(".tf-name").value = task.name;
    kindSel.value = task.kind;
    q<HTMLInputElement>(".tf-enabled").checked = task.enabled;
  }
  paintTargets(task?.target);
  kindSel.addEventListener("change", () => paintTargets());

  const cron = cronControl(task?.cron ?? "0 8 * * *");
  el.appendChild(cron.el);

  const draft: TaskDraft = {
    id: task?.id ?? null,
    el,
    cron,
    read: () => ({
      name: q<HTMLInputElement>(".tf-name").value.trim(),
      kind: kindSel.value as AgentTask["kind"],
      target: targetSel.value.trim(),
      enabled: q<HTMLInputElement>(".tf-enabled").checked,
    }),
  };
  q(".tf-remove").addEventListener("click", () => {
    if (draft.id) removedTaskIds.push(draft.id);
    formTasks = formTasks.filter((d) => d !== draft);
    el.remove();
  });
  formTasks.push(draft);
  fTasks.appendChild(el);
}

const GR_FIELDS: Array<[keyof GuardrailsPolicy, string]> = [
  ["maxInputTokens", "agent-f-gr-maxin"],
  ["maxOutputTokens", "agent-f-gr-maxout"],
  ["windowSeconds", "agent-f-gr-window"],
  ["windowTokens", "agent-f-gr-wtokens"],
  ["windowCalls", "agent-f-gr-wcalls"],
  ["maxConcurrent", "agent-f-gr-conc"],
];

const GR_LABELS: Record<string, string> = {
  maxInputTokens: "Max input tokens",
  maxOutputTokens: "Max output tokens",
  windowSeconds: "Window (seconds)",
  windowTokens: "Tokens per window",
  windowCalls: "Calls per window",
  maxConcurrent: "Max concurrent",
};

function setGuardrailInputs(gr: GuardrailsPolicy | null): void {
  for (const [key, id] of GR_FIELDS) {
    const el = $a<HTMLInputElement>(id);
    if (el) el.value = gr?.[key] != null ? String(gr[key]) : "";
  }
}

/** The agent's OWN policy — every value an upper bound; blank = no cap. */
function readGuardrails(): GuardrailsPolicy | null {
  const out: GuardrailsPolicy = {};
  for (const [key, id] of GR_FIELDS) {
    const v = $a<HTMLInputElement>(id)?.value.trim();
    if (!v) continue;
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return Object.keys(out).length ? out : null;
}

/** Skills as checkboxes over the LOCAL skills library — a free-text slug
 *  list let you name a skill that doesn't exist. */
function renderSkillsControl(selected: string[]): void {
  if (!fSkills) return;
  fSkills.innerHTML = "";
  const label = document.createElement("label");
  label.className = "settings-label";
  label.innerHTML = `Skills <span class="field-hint-inline">&mdash; which skills this agent may load</span>`;
  fSkills.appendChild(label);
  if (!skills.length) {
    const none = document.createElement("p");
    none.className = "field-hint";
    none.textContent = "No skills yet — the Skills page makes them.";
    fSkills.appendChild(none);
    return;
  }
  for (const s of skills) {
    const row = document.createElement("label");
    row.className = "lib-skill-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "af-skill";
    cb.value = s.slug;
    cb.checked = selected.includes(s.slug);
    row.appendChild(cb);
    row.appendChild(document.createTextNode(` ${s.name || s.slug}`));
    fSkills.appendChild(row);
  }
}

function readSkills(): string[] {
  const out: string[] = [];
  fSkills?.querySelectorAll<HTMLInputElement>("input.af-skill").forEach((cb) => {
    if (cb.checked) out.push(cb.value);
  });
  return out;
}

/** Vendor → the catalog's provider slug, so a loop's models narrow to what
 *  its CLI can actually address. An unrecognized CLI (custom, or one proxied
 *  through the router) gets the full list rather than an empty one. */
const LOOP_PROVIDER: Record<string, string> = { claude: "anthropic", codex: "openai", gemini: "google" };

/** The org's PROVIDERS, derived from the effective set rather than fetched.
 *  Every slug present in `models.available()` is by definition one the org
 *  enabled and supports — and, on a governance plan, one this member's role
 *  allows. Reading them off the catalog keeps the two in step by
 *  construction; a separate provider list could disagree with the models. */
function providerSlugs(): string[] {
  return [...new Set(models.map((m) => m.providerSlug).filter((s): s is string => !!s))].sort();
}

function paintFormProvider(selected: string): void {
  if (!fProvider) return;
  const slugs = providerSlugs();
  fProvider.innerHTML = "";
  if (!slugs.length) {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "(no providers enabled for this org)";
    fProvider.appendChild(none);
    return;
  }
  for (const s of slugs) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    fProvider.appendChild(opt);
  }
  fProvider.value = selected && slugs.includes(selected) ? selected : slugs[0]!;
}

/** Show the Loop row or the Provider row — an agent is one or the other. */
function syncSourceRow(): void {
  const provider = fSource?.value === "provider";
  $a("agent-f-loop-row")?.classList.toggle("hidden", provider);
  $a("agent-f-provider-row")?.classList.toggle("hidden", !provider);
}

/** Repaint the Model dropdown for whichever SOURCE is selected: a loop
 *  narrows by its CLI's vendor, a provider by itself. */
function paintFormModel(selected: string): void {
  if (!fModel) return;
  const byProvider = fSource?.value === "provider";
  const want = byProvider
    ? (fProvider?.value || undefined)
    : (() => { const l = loops.find((x) => x.id === fLoop.value); return l?.cli ? LOOP_PROVIDER[l.cli] : undefined; })();
  const pool = want ? models.filter((m) => m.providerSlug === want) : models;
  // A loop whose vendor isn't in the catalog still offers everything; a
  // PROVIDER that offers nothing stays empty — that is a real answer.
  const list = pool.length ? pool : (byProvider ? [] : models);
  fModel.innerHTML = "";
  if (!byProvider) {
    const loop = loops.find((l) => l.id === fLoop.value);
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = loop?.model ? `The loop's own — ${loop.model}` : "The loop's own";
    fModel.appendChild(auto);
  } else if (!list.length) {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "(no models for this provider)";
    fModel.appendChild(none);
  }
  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    fModel.appendChild(opt);
  }
  if (selected && !list.some((m) => m.id === selected)) {
    const opt = document.createElement("option");
    opt.value = selected;
    opt.textContent = `${selected} (not available)`;
    fModel.appendChild(opt);
  }
  fModel.value = selected || "";
}

/** Open the manual form — blank for create, pre-filled for edit. */
async function openForm(agent: Agent | null): Promise<void> {
  if (!form) return;
  formAgent = agent;
  formTasks = [];
  removedTaskIds = [];
  formErr.classList.add("hidden");
  if (fTasks) fTasks.innerHTML = "";
  if (!loops.length) await loadOptions();

  fLoop.innerHTML = "";
  if (!loops.length) {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "(no loops configured)";
    fLoop.appendChild(none);
  }
  for (const l of loops) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name;
    fLoop.appendChild(opt);
  }
  // An agent bound to a loop that has since been deleted still shows its
  // binding rather than silently snapping to the first one.
  if (agent?.loopId && !loops.some((l) => l.id === agent.loopId)) {
    const opt = document.createElement("option");
    opt.value = agent.loopId;
    opt.textContent = `${agent.loopId} (missing)`;
    fLoop.appendChild(opt);
  }

  fName.value = agent?.name ?? "";
  fSlug.value = agent?.slug ?? "";
  fDesc.value = agent?.description ?? "";
  fPrompt.value = agent?.prompt ?? "";
  fLoop.value = agent?.loopId ?? loops[0]?.id ?? "";
  // An agent is a LOOP or a PROVIDER — whichever it carries decides the shape.
  if (fSource) fSource.value = agent?.provider ? "provider" : "loop";
  paintFormProvider(agent?.provider ?? "");
  syncSourceRow();
  fApps.value = (agent?.apps ?? []).join(", ");
  paintFormModel(agent?.model ?? "");
  renderSkillsControl(agent?.skills ?? []);
  setGuardrailInputs(agent?.guardrails ?? null);

  if (agent) {
    const env = await api().libraryAgentTasks(agent.id);
    for (const t of (env.ok ? (env.data as AgentTask[]) : [])) addTaskDraft(t);
  }
  $a("agent-f-delete")?.classList.toggle("hidden", !agent);

  toolbar.classList.add("hidden");
  listEl.classList.add("hidden");
  editor.classList.add("hidden");
  form.classList.remove("hidden");
  fName.focus();
}

/** Row-menu Edit: fetch the full agent (the list holds summaries), then open. */
async function openFormFor(id: string): Promise<void> {
  const env = await api().libraryAgentGet(id);
  if (!env.ok) { fail(env.error || "couldn't load the agent"); return; }
  await openForm(env.data as Agent);
}

async function saveForm(): Promise<void> {
  formErr.classList.add("hidden");

  const name = fName.value.trim();
  if (!name) { failForm("A name is required."); return; }
  let slug = fSlug.value.trim();
  if (!slug && !formAgent) slug = slugify(name);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) { failForm("The slug needs lowercase letters, digits and dashes."); return; }

  // Validate every task BEFORE any write — a bad cron in row 3 must not
  // leave rows 1–2 half-saved.
  const parsedTasks: Array<{ draft: TaskDraft; input: { name: string; kind: AgentTask["kind"]; target: string; cron: string; enabled: boolean } }> = [];
  for (const draft of formTasks) {
    const t = draft.read();
    const cron = draft.cron.read();
    if (!t.name) { failForm("Every task needs a name."); return; }
    if (!t.target) { failForm(`Task "${t.name}" needs something to run.`); return; }
    if (cron.trim().split(/\s+/).length !== 5) { failForm(`Task "${t.name}" needs a five-field cron (e.g. "0 8 * * *").`); return; }
    parsedTasks.push({ draft, input: { name: t.name, kind: t.kind, target: t.target, cron, enabled: t.enabled } });
  }

  const payload = {
    slug,
    name,
    description: fDesc.value.trim(),
    prompt: fPrompt.value,
    // Exactly one source is carried; the other is cleared, so a switched
    // agent never keeps a stale binding the form no longer shows.
    loopId: fSource?.value === "provider" ? null : (fLoop.value || null),
    provider: fSource?.value === "provider" ? (fProvider?.value || "") : "",
    model: fModel.value || "",
    skills: readSkills(),
    apps: fApps.value.split(",").map((s) => s.trim()).filter(Boolean),
    guardrails: readGuardrails(),
  };

  const saveBtn = $a<HTMLButtonElement>("agent-f-save");
  if (saveBtn) saveBtn.disabled = true;
  try {
    let agentId: string;
    if (formAgent) {
      const env = await api().libraryAgentUpdate(formAgent.id, payload);
      if (!env.ok) { failForm(env.error || "save failed"); return; }
      agentId = (env.data as Agent).id;
    } else {
      const env = await api().libraryAgentCreate(payload);
      if (!env.ok) { failForm(env.error || "create failed"); return; }
      formAgent = env.data as Agent; // a retry after a task failure PATCHes
      agentId = formAgent.id;
    }

    // Task diffs: removals, then updates, then adds — each through its own
    // lane (tasks are not part of the agent record).
    for (const id of removedTaskIds) {
      const env = await api().libraryAgentTaskDelete(agentId, id);
      if (!env.ok) { failForm(env.error || "couldn't remove a task"); return; }
    }
    removedTaskIds = [];
    for (const { draft, input } of parsedTasks) {
      const env = draft.id
        ? await api().libraryAgentTaskUpdate(agentId, draft.id, input)
        : await api().libraryAgentTaskAdd(agentId, input);
      if (!env.ok) { failForm(env.error || `couldn't save task "${input.name}"`); return; }
      if (!draft.id) draft.id = (env.data as AgentTask).id; // idempotent retry
    }

    await loadAgents();
    await openDetail(agentId);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/** The form's danger zone — same confirm modal as everywhere else. */
async function deleteFromForm(): Promise<void> {
  if (!formAgent) return;
  const sure = await confirmAction({ title: `Delete "${formAgent.name}"?`, body: "Its scheduled tasks stop firing with it.", confirmLabel: "Delete", danger: true });
  if (!sure) return;
  const env = await api().libraryAgentDelete(formAgent.id);
  if (!env.ok) { failForm(env.error || "delete failed"); return; }
  await loadAgents();
}

export function initAgentsEvents(): void {
  wireSplitDivider($a("agent-split-divider"), detailEl);
  searchInput.addEventListener("input", renderList);
  $a("agent-back-link").addEventListener("click", () => renderList());

  // Two doors into authoring: the AGENT (composer) or the hand form.
  $a("agent-new-btn").addEventListener("click", () => seedComposer("/create-agent "));
  $a("agent-manual-new-btn")?.addEventListener("click", () => void openForm(null));
  $a("agent-ai-btn").addEventListener("click", () => {
    if (!current) return;
    seedComposer(`/create-agent Update the existing agent "${current.slug}" (${current.name}): `);
  });
  // The detail's Edit opens the same form, pre-filled.
  $a("agent-edit-btn")?.addEventListener("click", () => { if (current) void openForm(current); });

  // Live/pause is operational, not authoring — it stays a hand switch.
  liveToggle.addEventListener("change", async () => {
    if (!current) return;
    const env = await api().libraryAgentUpdate(current.id, { ...current, live: liveToggle.checked });
    if (!env.ok) { fail(env.error || "couldn't change live state"); liveToggle.checked = !liveToggle.checked; return; }
    current = env.data as Agent;
  });

  // The manual form.
  $a("agent-form-back")?.addEventListener("click", () => renderList());
  $a("agent-f-cancel")?.addEventListener("click", () => renderList());
  $a("agent-f-save")?.addEventListener("click", () => void saveForm());
  $a("agent-f-delete")?.addEventListener("click", () => void deleteFromForm());
  $a("agent-f-task-add")?.addEventListener("click", () => addTaskDraft(null));
  // The loop decides which models are addressable.
  fLoop?.addEventListener("change", () => paintFormModel(fModel?.value ?? ""));
  fProvider?.addEventListener("change", () => paintFormModel(""));
  fSource?.addEventListener("change", () => { syncSourceRow(); paintFormModel(""); });
  // Create mode: a blank slug fills itself from the name.
  fName?.addEventListener("blur", () => {
    if (!formAgent && !fSlug.value.trim() && fName.value.trim()) fSlug.value = slugify(fName.value);
  });
}

async function deleteCurrent(): Promise<void> {
  if (!current) return;
  const sure = await confirmAction({ title: `Delete "${current.name}"?`, body: "Its scheduled tasks stop firing with it.", confirmLabel: "Delete", danger: true });
  if (!sure) return;
  const env = await api().libraryAgentDelete(current.id);
  if (!env.ok) { fail(env.error || "delete failed"); return; }
  await loadAgents();
}
