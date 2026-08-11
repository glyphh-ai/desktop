/**
 * Agents section — the workforce roster, with BOTH authoring doors open.
 *
 * The Glyphh AGENT authors agents (loop choice, selections, guardrails, task
 * bindings) through /create-agent — and a human can now do the same by hand:
 * "+ New" opens the manual form, and every agent (AI-made or not) is editable
 * through that same form. The form edits exactly what the API persists:
 * name/slug/description/scope, loopId, selections (roles/skills/apps),
 * guardrails, and the task bindings (name, kind, target, args, cron, enabled).
 *
 * The DETAIL view stays READ + OPERATIONAL: live/pause, task enable/disable,
 * reschedule, run-now, run feeds, delete. Its Edit button opens the form.
 */

import { $a, escapeHtml, paginate, renderPaginationBar, confirmAction, slugify } from "./shared.js";
import { seedComposer } from "./code.js";
import { kebabCell, ROW_MENU_ICONS, wireSplitDivider } from "./lib-editor.js";
import { formatMarkdown } from "../format-markdown.js";
import {
  unwrap,
  type Agent, type AgentSummary, type AgentSelections, type AgentTask, type AgentTaskRun,
  type GuardrailsPolicy, type Loop, type LoopManifest, type LoopSummary,
} from "./library-types.js";

let all: AgentSummary[] = [];
let loops: LoopSummary[] = [];
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
const fScope = $a<HTMLSelectElement>("agent-f-scope");
const fLoop = $a<HTMLSelectElement>("agent-f-loop");
const fModels = $a("agent-f-models");
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

// ── Cards ───────────────────────────────────────────────────────────────────

/** Stable hue from a model id — same trick the old agent identicons used. */
function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/** The agent's model cast as small round badges: the model's initial on a
 *  stable per-model color. */
function modelBadges(agent: AgentSummary): string {
  const models = Object.values(agent.selections?.roles ?? {});
  if (!models.length) return "";
  const dots = models.slice(0, 4).map((id) => {
    const bare = id.includes("::") ? id.slice(id.indexOf("::") + 2) : id;
    const letter = (bare[0] || "?").toUpperCase();
    return `<span class="agent-model-dot" style="--dot:hsl(${hueFor(id)} 60% 45%)" title="${escapeHtml(id)}">${escapeHtml(letter)}</span>`;
  }).join("");
  const extra = models.length > 4 ? `<span class="agent-model-more">+${models.length - 4}</span>` : "";
  return `<span class="agent-model-cast">${dots}${extra}</span>`;
}

export async function loadAgents(): Promise<void> {
  listEl.innerHTML = `<div class="crud-empty">Loading…</div>`;
  manifestCache.clear();
  try {
    all = unwrap<AgentSummary[]>(await window.glyphh.libraryAgentsList());
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
  listEl.innerHTML = "";
  current = null;

  if (all.length === 0) {
    listEl.innerHTML = `<div class="crud-empty">No agents yet — "+ New with AI" describes the standing work to the agent, "+ New" builds one by hand.</div>`;
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
  table.innerHTML = `<thead><tr><th>Name</th><th>Description</th><th>Models</th><th>Status</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const agent of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-desc"></td>
      <td>${modelBadges(agent)}</td>
      <td>${agent.live ? `<span class="lib-badge lib-badge-live">Live</span>` : "Paused"}${agent.scope === "org" ? ` <span class="lib-badge">Org</span>` : ""}</td>
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
          const env = await window.glyphh.libraryAgentDelete(agent.id);
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

// ── Loop manifests (cache) ──────────────────────────────────────────────────

/** Per-page-load cache of loop manifests, keyed by the ref used to fetch. The
 *  manifest is the loop's CONTRACT: its type (memory loops power the rotor,
 *  not agents), its declared model slots, and its declared skills. */
const manifestCache = new Map<string, LoopManifest>();

async function loopManifest(ref: string): Promise<LoopManifest> {
  const hit = manifestCache.get(ref);
  if (hit) return hit;
  try {
    const env = await window.glyphh.libraryLoopGet(ref);
    const m = env.ok ? ((env.data as Loop).manifest ?? {}) : {};
    manifestCache.set(ref, m);
    return m;
  } catch {
    return {};
  }
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
        const r = await window.glyphh.libraryAgentTaskUpdate(current!.id, task.id, { cron });
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
  const row = document.createElement("div");
  row.className = "lib-run-row" + (run.status === "error" ? " error" : "");
  const when = new Date(run.startedAt).toLocaleString();
  const dur = run.durationMs != null ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : "";
  row.innerHTML = `
    <button type="button" class="lib-run-rowhead">
      ${RUN_CARET}
      <span class="lib-run-when">${escapeHtml(when)}${dur}</span>
      <span class="lib-run-badge ${run.status === "error" ? "err" : "ok"}">${run.status === "error" ? "Failed" : "Success"}</span>
    </button>
    <div class="lib-run-detail hidden"><div class="lib-run-body"></div></div>`;
  const body = row.querySelector<HTMLElement>(".lib-run-body")!;
  if (run.status === "error") {
    body.textContent = run.error || "failed";
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
function runningRow(since: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "lib-run-row running";
  row.innerHTML = `
    <div class="lib-run-rowhead">
      <span class="lib-run-spin"></span>
      <span class="lib-run-when">${escapeHtml(new Date(since).toLocaleString())}</span>
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
    window.glyphh.libraryAgentTaskRuns(current!.id, task.id),
    window.glyphh.libraryAgentTaskRunning(current!.id, task.id),
  ]);
  if (!host.isConnected) return;
  if (!env.ok) { host.innerHTML = `<div class="crud-empty">Couldn't load runs.</div>`; return; }
  const runs = env.data as AgentTaskRun[];
  const since = runningEnv.ok ? (runningEnv.data as { since: number | null }).since : null;
  host.innerHTML = "";
  if (since != null) host.appendChild(runningRow(since));
  if (!runs.length && since == null) {
    host.innerHTML = `<div class="crud-empty">No runs yet — the next firing lands here.</div>`;
  } else {
    for (const run of runs) host.appendChild(runRow(run));
  }
  // Live while running (2s), a slow keep-fresh tick otherwise (15s) — so
  // scheduled firings appear without leaving and coming back.
  host.__feedTimer = setTimeout(() => { void runFeed(task, host, { quiet: true }); }, since != null ? 2000 : 15_000);
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
    row.querySelector(".lib-task-binding")!.textContent = `runs ${task.target}`;
    row.querySelector(".lib-task-sched")!.textContent = humanCron(task.cron);
    row.querySelector(".lib-task-status")!.textContent = status;

    row.querySelector<HTMLInputElement>(".lib-task-enabled input")!.addEventListener("change", async (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      const r = await window.glyphh.libraryAgentTaskUpdate(current!.id, task.id, { enabled });
      if (!r.ok) { fail(r.error || "couldn't toggle the task"); (e.target as HTMLInputElement).checked = !enabled; }
      else task.enabled = enabled;
    });
    // The schedule itself is the edit affordance — click it to change it.
    row.querySelector(".lib-task-sched")!.addEventListener("click", () => {
      scheduleEditor(task, row, () => {
        void (async () => {
          const env = await window.glyphh.libraryAgentTasks(current!.id);
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
      const pending = window.glyphh.libraryAgentTaskRunNow(current!.id, task.id);
      // Repaint right away so the feed's "Running…" row shows while it goes.
      void runFeed(task, feed, { quiet: true });
      const r = await pending;
      runBtn.disabled = false;
      runBtn.textContent = "▶ run";
      // Two layers: the IPC envelope, then the run's own outcome.
      const outcome = r.ok ? (r.data as { ok: boolean; error?: string }) : { ok: false, error: r.error };
      if (!outcome.ok) fail(outcome.error || "run failed");
      // Refresh both the feed and the row's last-run glance.
      await runFeed(task, feed);
      const env = await window.glyphh.libraryAgentTasks(current!.id);
      const fresh = env.ok ? (env.data as AgentTask[]).find((x) => x.id === task.id) : null;
      if (fresh) { Object.assign(task, fresh); paintRow(); }
    });
  };
  paintRow();
  return wrap;
}

/** Open one agent's detail from OUTSIDE the section (the dashboard's
 *  scheduled-tasks rows) — caller flips to the Agents section first. */
export function openAgentDetail(id: string): void {
  void openDetail(id);
}

async function openDetail(id: string): Promise<void> {
  formError.classList.add("hidden");
  const env = await window.glyphh.libraryAgentGet(id);
  if (!env.ok) { fail(env.error || "couldn't load the agent"); return; }
  current = env.data as Agent;

  const r = await window.glyphh.loopsList?.();
  loops = ((r?.loops ?? []) as unknown as LoopSummary[]);

  liveToggle.checked = current.live;

  const bound = current.loopId ? loops.find((l) => l.id === current!.loopId) : null;
  const loopName = current.loopId ? (bound?.name ?? "Custom loop") : "Default";
  const loopRef = current.loopId ? (bound?.slug ?? current.loopId) : "default";

  detailEl.innerHTML = `
    <h3 class="lib-read-title">${escapeHtml(current.name)}</h3>
    <p class="lib-read-desc">${escapeHtml(current.description || "")}</p>
    <div class="lib-read-meta">
      ${readRow("Loop", loopName)}
      ${current.selections?.skills?.length ? readRow("Skills", current.selections.skills.join(", ")) : ""}
      ${current.selections?.apps?.length ? readRow("Apps", current.selections.apps.join(", ")) : ""}
      ${readRow("Scope", current.scope === "org" ? "Shared with the org" : "Personal")}
    </div>
    <div id="agent-model-rows" style="margin-top:16px;"></div>
    <div class="settings-actions" style="margin-top:24px;">
      <button id="agent-delete-btn" class="action-btn danger">Delete</button>
      <div style="flex:1;"></div>
    </div>`;

  detailEl.querySelector("#agent-delete-btn")?.addEventListener("click", () => void deleteCurrent());

  const modelHost = detailEl.querySelector<HTMLElement>("#agent-model-rows");
  if (modelHost) await renderModelRows(modelHost, loopRef, current.selections?.roles ?? {}, false);

  // The RIGHT pane: the schedule and its run feeds — what this agent DOES.
  sideEl.innerHTML = `<span class="lib-read-label">Schedule</span><div id="agent-task-rows"></div>`;
  const rowsEl = sideEl.querySelector<HTMLElement>("#agent-task-rows")!;
  const tasksEnv = await window.glyphh.libraryAgentTasks(current.id);
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

/**
 * The model slots for a loop, painted into `host`.
 *
 * Editable: one dropdown per role the loop DECLARES — "Auto" inherits the
 * loop's resolution, a pick pins a model for this agent. The Default loop
 * declares none, so its implicit slot shows read-only (the server only
 * accepts overrides on declared roles). Read-only: the same rows as
 * lib-read rows, for the detail view.
 */
async function renderModelRows(
  host: HTMLElement, loopRef: string, pinned: Record<string, string>, editable: boolean,
): Promise<void> {
  host.innerHTML = "";
  const res = await window.glyphh.loopRoles(loopRef);
  if (!res.ok || !res.roles.length) return;

  const manifest = await loopManifest(loopRef);
  const declared = new Set((manifest.roles ?? []).map((role) => role.name));
  const loopName = loops.find((l) => (l.slug ?? l.id) === loopRef || l.id === loopRef)?.name ?? "the loop";

  // Display NAMES, never raw catalog ids — "Auto — Fable 5", not
  // "Auto — anthropic::claude-fable-5".
  const nameOf = (roleChoices: typeof res.roles[number]["choices"], id: string | null): string => {
    if (!id) return "resolved at run time";
    return roleChoices.find((c) => c.id === id)?.name || id;
  };

  if (!editable) {
    const rows = res.roles.map((role) => {
      const label = declared.has(role.name) ? (role.label || role.name) : "Model";
      const value = pinned[role.name]
        ? nameOf(role.choices, pinned[role.name]!)
        : `Auto — ${nameOf(role.choices, role.modelId)}`;
      return readRow(label, value);
    }).join("");
    host.innerHTML = `<span class="lib-read-label">Models</span><div class="lib-read-meta" style="margin-top:6px;">${rows}</div>`;
    return;
  }

  for (const role of res.roles) {
    const row = document.createElement("div");
    if (!declared.has(role.name)) {
      // Implicit slot: show the resolution, no override to offer.
      row.innerHTML = `
        <label class="settings-label">Model</label>
        <div class="lib-read-value">${escapeHtml(nameOf(role.choices, role.modelId))}</div>
        <p class="field-hint">Resolved by ${escapeHtml(loopName)}.</p>`;
      host.appendChild(row);
      continue;
    }
    const label = document.createElement("label");
    label.className = "settings-label";
    label.textContent = role.label;
    const select = document.createElement("select");
    select.className = "settings-input";
    select.dataset.role = role.name;
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = `Auto — ${nameOf(role.choices, role.modelId)}`;
    select.appendChild(auto);
    for (const choice of role.choices) {
      const opt = document.createElement("option");
      opt.value = choice.id;
      opt.textContent = choice.name || choice.id;
      select.appendChild(opt);
    }
    const pin = pinned[role.name];
    if (pin) select.value = pin;
    row.append(label, select);
    if (role.description) {
      const hint = document.createElement("p");
      hint.className = "field-hint";
      hint.textContent = role.description;
      row.appendChild(hint);
    }
    host.appendChild(row);
  }
}

// ── The manual create/edit form ─────────────────────────────────────────────

/** null = create mode. Set to the created agent as soon as the POST lands, so
 *  a retry after a failed task write PATCHes instead of duplicating. */
let formAgent: Agent | null = null;

interface TaskDraft {
  /** The existing task's id, or null for a not-yet-created row. */
  id: string | null;
  el: HTMLElement;
  cron: CronControl;
  read(): { name: string; kind: AgentTask["kind"]; target: string; argsText: string; enabled: boolean };
}

let formTasks: TaskDraft[] = [];
let removedTaskIds: string[] = [];

/** One editable task binding: name + kind + target + enabled on the first
 *  row, optional JSON args, and the schedule grammar underneath. */
function addTaskDraft(task: AgentTask | null): void {
  if (!fTasks) return;
  const el = document.createElement("div");
  el.className = "agent-f-task";
  el.innerHTML = `
    <div class="lib-task-form">
      <input type="text" class="settings-input tf-name" placeholder="Task name" spellcheck="false" autocomplete="off" />
      <select class="settings-input tf-kind" title="What the task fires">
        <option value="skill">Skill</option>
        <option value="loop">Loop</option>
        <option value="app_command">App command</option>
      </select>
      <input type="text" class="settings-input tf-target" placeholder="target slug" spellcheck="false" autocomplete="off" />
      <label class="lib-skill-row tf-enabled-wrap" title="Armed while the agent is live"><input type="checkbox" class="tf-enabled" checked /> Enabled</label>
      <button type="button" class="action-btn danger tf-remove">Remove</button>
    </div>
    <textarea class="settings-input tf-args" rows="2" spellcheck="false" placeholder='{ "key": "value" } — optional JSON arguments (app commands: { "tool": "…", "args": { … } })'></textarea>`;

  const q = <T extends HTMLElement>(sel: string): T => el.querySelector(sel) as T;
  if (task) {
    q<HTMLInputElement>(".tf-name").value = task.name;
    q<HTMLSelectElement>(".tf-kind").value = task.kind;
    q<HTMLInputElement>(".tf-target").value = task.target;
    q<HTMLInputElement>(".tf-enabled").checked = task.enabled;
    if (task.args && Object.keys(task.args).length) {
      q<HTMLTextAreaElement>(".tf-args").value = JSON.stringify(task.args, null, 2);
    }
  }
  const cron = cronControl(task?.cron ?? "0 8 * * *");
  el.appendChild(cron.el);

  const draft: TaskDraft = {
    id: task?.id ?? null,
    el,
    cron,
    read: () => ({
      name: q<HTMLInputElement>(".tf-name").value.trim(),
      kind: q<HTMLSelectElement>(".tf-kind").value as AgentTask["kind"],
      target: q<HTMLInputElement>(".tf-target").value.trim(),
      argsText: q<HTMLTextAreaElement>(".tf-args").value,
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

function setGuardrailInputs(gr: GuardrailsPolicy | null): void {
  for (const [key, id] of GR_FIELDS) {
    const el = $a<HTMLInputElement>(id);
    if (el) el.value = gr?.[key] != null ? String(gr[key]) : "";
  }
}

/** The agent's OWN policy — every value an upper bound; null = inherit. */
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

/** The skills control, shaped by the loop's contract: a custom loop's
 *  DECLARED skills as checkboxes (the server rejects anything else), the
 *  Default loop (no contract) as a free slug list. */
function renderSkillsControl(manifest: LoopManifest | null, selected: string[]): void {
  if (!fSkills) return;
  fSkills.innerHTML = "";
  if (manifest) {
    const offered = manifest.skills ?? [];
    if (!offered.length) return; // the loop declares none — nothing to select
    const label = document.createElement("label");
    label.className = "settings-label";
    label.innerHTML = `Skills <span class="field-hint-inline">— which of the loop's skills this agent may call</span>`;
    fSkills.appendChild(label);
    for (const slug of offered) {
      const row = document.createElement("label");
      row.className = "lib-skill-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "af-skill";
      cb.value = slug;
      cb.checked = selected.includes(slug);
      row.appendChild(cb);
      row.appendChild(document.createTextNode(` ${slug}`));
      fSkills.appendChild(row);
    }
    return;
  }
  const label = document.createElement("label");
  label.className = "settings-label";
  label.innerHTML = `Skills <span class="field-hint-inline">— skill slugs, comma-separated (optional)</span>`;
  const input = document.createElement("input");
  input.type = "text";
  input.id = "agent-f-skills-input";
  input.className = "settings-input";
  input.spellcheck = false;
  input.placeholder = "daily-report, send-email";
  input.value = selected.join(", ");
  fSkills.append(label, input);
}

function readSkills(): string[] {
  const free = document.getElementById("agent-f-skills-input") as HTMLInputElement | null;
  if (free) return free.value.split(",").map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  fSkills?.querySelectorAll<HTMLInputElement>("input.af-skill").forEach((cb) => {
    if (cb.checked) out.push(cb.value);
  });
  return out;
}

/** Repaint the loop-dependent parts of the form (model slots + skills). */
async function paintFormLoop(selections: AgentSelections): Promise<void> {
  if (!fLoop || !fModels) return;
  const loopId = fLoop.value; // "" = the built-in Default
  const ref = loopId ? (loops.find((l) => l.id === loopId)?.slug ?? loopId) : "default";
  await renderModelRows(fModels, ref, selections.roles ?? {}, true);
  renderSkillsControl(loopId ? await loopManifest(ref) : null, selections.skills ?? []);
}

/** Open the manual form — blank for create, pre-filled for edit. AI-created
 *  agents are editable like any other. */
async function openForm(agent: Agent | null): Promise<void> {
  if (!form) return;
  formAgent = agent;
  formTasks = [];
  removedTaskIds = [];
  formErr.classList.add("hidden");
  if (fTasks) fTasks.innerHTML = "";

  // Loops: the Default plus every custom loop the caller can see. Memory
  // loops power the memory rotor, not agents — filtered out. Built-ins other
  // than Default are absent because the API only binds custom loops (uuid).
  const r = await window.glyphh.loopsList?.();
  loops = ((r?.loops ?? []) as unknown as LoopSummary[]);
  const custom = loops.filter((l) => !l.builtIn);
  await Promise.all(custom.map((l) => loopManifest(l.slug ?? l.id)));

  fLoop.innerHTML = "";
  const defOpt = document.createElement("option");
  defOpt.value = "";
  defOpt.textContent = "Default";
  fLoop.appendChild(defOpt);
  for (const l of custom) {
    if (manifestCache.get(l.slug ?? l.id)?.type === "memory") continue;
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name;
    fLoop.appendChild(opt);
  }
  // An agent bound to a loop the filter dropped still needs its binding shown.
  if (agent?.loopId && !Array.from(fLoop.options).some((o) => o.value === agent.loopId)) {
    const opt = document.createElement("option");
    opt.value = agent.loopId;
    opt.textContent = loops.find((l) => l.id === agent.loopId)?.name ?? "(current loop)";
    fLoop.appendChild(opt);
  }

  fName.value = agent?.name ?? "";
  fSlug.value = agent?.slug ?? "";
  fDesc.value = agent?.description ?? "";
  fScope.value = agent?.scope ?? "personal";
  fLoop.value = agent?.loopId ?? "";
  fApps.value = (agent?.selections?.apps ?? []).join(", ");
  setGuardrailInputs(agent?.guardrails ?? null);
  await paintFormLoop(agent?.selections ?? {});

  if (agent) {
    const env = await window.glyphh.libraryAgentTasks(agent.id);
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
  const env = await window.glyphh.libraryAgentGet(id);
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

  // Validate every task BEFORE any write — a bad cron or bad JSON in row 3
  // must not leave rows 1–2 half-saved.
  const parsedTasks: Array<{ draft: TaskDraft; input: { name: string; kind: AgentTask["kind"]; target: string; args: Record<string, unknown>; cron: string; enabled: boolean } }> = [];
  for (const draft of formTasks) {
    const t = draft.read();
    const cron = draft.cron.read();
    if (!t.name) { failForm("Every task needs a name."); return; }
    if (!t.target) { failForm(`Task "${t.name}" needs a target slug.`); return; }
    if (cron.trim().split(/\s+/).length !== 5) { failForm(`Task "${t.name}" needs a five-field cron (e.g. "0 8 * * *").`); return; }
    let args: Record<string, unknown> = {};
    if (t.argsText.trim()) {
      try {
        const p = JSON.parse(t.argsText) as unknown;
        if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("not an object");
        args = p as Record<string, unknown>;
      } catch {
        failForm(`Task "${t.name}" has invalid JSON arguments — an object like { "key": "value" }.`);
        return;
      }
    }
    parsedTasks.push({ draft, input: { name: t.name, kind: t.kind, target: t.target, args, cron, enabled: t.enabled } });
  }

  const selections: AgentSelections = {};
  const roles: Record<string, string> = {};
  fModels?.querySelectorAll<HTMLSelectElement>("select[data-role]").forEach((s) => {
    if (s.value) roles[s.dataset.role!] = s.value;
  });
  if (Object.keys(roles).length) selections.roles = roles;
  const skills = readSkills();
  if (skills.length) selections.skills = skills;
  const apps = fApps.value.split(",").map((s) => s.trim()).filter(Boolean);
  if (apps.length) selections.apps = apps;

  const payload = {
    slug,
    scope: fScope.value as Agent["scope"],
    name,
    description: fDesc.value.trim(),
    loopId: fLoop.value || null,
    selections,
    guardrails: readGuardrails(),
  };

  const saveBtn = $a<HTMLButtonElement>("agent-f-save");
  if (saveBtn) saveBtn.disabled = true;
  try {
    let agentId: string;
    if (formAgent) {
      const env = await window.glyphh.libraryAgentUpdate(formAgent.id, payload);
      if (!env.ok) { failForm(env.error || "save failed"); return; }
      agentId = (env.data as Agent).id;
    } else {
      const env = await window.glyphh.libraryAgentCreate(payload);
      if (!env.ok) { failForm(env.error || "create failed"); return; }
      formAgent = env.data as Agent; // a retry after a task failure PATCHes
      agentId = formAgent.id;
    }

    // Task diffs: removals, then updates, then adds — each through its own
    // endpoint (tasks are not part of the agent PATCH body).
    for (const id of removedTaskIds) {
      const env = await window.glyphh.libraryAgentTaskDelete(agentId, id);
      if (!env.ok) { failForm(env.error || "couldn't remove a task"); return; }
    }
    removedTaskIds = [];
    for (const { draft, input } of parsedTasks) {
      const env = draft.id
        ? await window.glyphh.libraryAgentTaskUpdate(agentId, draft.id, input)
        : await window.glyphh.libraryAgentTaskAdd(agentId, input);
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
  const env = await window.glyphh.libraryAgentDelete(formAgent.id);
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
    const env = await window.glyphh.libraryAgentUpdate(current.id, { live: liveToggle.checked });
    if (!env.ok) { fail(env.error || "couldn't change live state"); liveToggle.checked = !liveToggle.checked; return; }
    current = env.data as Agent;
  });

  // The manual form.
  $a("agent-form-back")?.addEventListener("click", () => renderList());
  $a("agent-f-cancel")?.addEventListener("click", () => renderList());
  $a("agent-f-save")?.addEventListener("click", () => void saveForm());
  $a("agent-f-delete")?.addEventListener("click", () => void deleteFromForm());
  $a("agent-f-task-add")?.addEventListener("click", () => addTaskDraft(null));
  fLoop?.addEventListener("change", () => {
    // Flipping BACK to the agent's own loop restores its selections; any
    // other loop starts clean (its contract differs).
    const keep = formAgent && (formAgent.loopId ?? "") === fLoop.value ? (formAgent.selections ?? {}) : {};
    void paintFormLoop(keep);
  });
  // Create mode: a blank slug fills itself from the name.
  fName?.addEventListener("blur", () => {
    if (!formAgent && !fSlug.value.trim() && fName.value.trim()) fSlug.value = slugify(fName.value);
  });
}

async function deleteCurrent(): Promise<void> {
  if (!current) return;
  const sure = await confirmAction({ title: `Delete "${current.name}"?`, body: "Its scheduled tasks stop firing with it.", confirmLabel: "Delete", danger: true });
  if (!sure) return;
  const env = await window.glyphh.libraryAgentDelete(current.id);
  if (!env.ok) { fail(env.error || "delete failed"); return; }
  await loadAgents();
}
