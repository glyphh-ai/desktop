/**
 * tasks-page.ts — the TASKS section (the collapse, 2026-09-10).
 *
 * One work primitive: a task's ordered STEPS each slot a CLI agent (Claude
 * for x, Gemini for y), optionally repeated; schedules make it recurring,
 * Run now makes it one-off. Loops' power, one noun.
 */

import { escapeHtml, paginate, renderPaginationBar, confirmAction } from "./shared.js";

interface TaskStep { name?: string; agent: string; model?: string; program: string }
interface TaskRow { slug: string; name: string; description: string; steps: TaskStep[]; repeat: number; updatedAt: string }
interface RunRow { id: string; startedAt: string; durationMs: number | null; status: string; error: string | null; output: string | null }
interface SchedRow { id: string; name: string; cron: string; enabled: boolean }
interface AgentLite { id: string; name: string; model?: string }

const api = () => (window.glyphh as unknown as {
  tasksList?: () => Promise<{ ok: boolean; data?: TaskRow[]; error?: string }>;
  tasksGet?: (slug: string) => Promise<{ ok: boolean; data?: TaskRow; error?: string }>;
  tasksSave?: (input: unknown) => Promise<{ ok: boolean; data?: TaskRow; error?: string }>;
  tasksDelete?: (slug: string) => Promise<{ ok: boolean; error?: string }>;
  tasksRunNow?: (slug: string) => Promise<{ ok: boolean; status?: string; output?: string; error?: string }>;
  tasksRuns?: (slug: string) => Promise<{ ok: boolean; data?: RunRow[]; error?: string }>;
  taskSchedulesList?: (slug: string) => Promise<{ ok: boolean; data?: SchedRow[]; error?: string }>;
  taskScheduleSave?: (input: { taskSlug: string; cron: string; id?: string; enabled?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  taskScheduleDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  cliAgentsList?: () => Promise<{ ok: boolean; agents: AgentLite[] }>;
});

let all: TaskRow[] = [];
let agents: AgentLite[] = [];
let page = 0;
let editing: TaskRow | null = null;
let draftSteps: TaskStep[] = [];

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function fail(msg: string): void {
  const e = el("gtask-form-error");
  if (e) { e.textContent = msg; e.classList.remove("hidden"); }
}

function showList(): void {
  el("gtask-editor")?.classList.add("hidden");
  el("gtasks-list")?.classList.remove("hidden");
  el("gtasks-toolbar")?.classList.remove("hidden");
  editing = null;
  renderList();
}

function renderList(): void {
  const list = el("gtasks-list");
  if (!list) return;
  const q = (el<HTMLInputElement>("gtask-search")?.value ?? "").trim().toLowerCase();
  const filtered = q ? all.filter((t) => `${t.name} ${t.description}`.toLowerCase().includes(q)) : all;
  list.innerHTML = "";
  if (!filtered.length) {
    list.innerHTML = q
      ? `<div class="crud-empty">No tasks matching "${escapeHtml(q)}"</div>`
      : `<div class="crud-empty">No tasks yet — <b>+ New</b> slots agents into steps; add a cron to make it recurring.</div>`;
    return;
  }
  const { items, state } = paginate(filtered, page);
  page = state.page;
  const grid = document.createElement("div");
  grid.className = "app-grid";
  for (const t of items) {
    const stepLine = t.steps.map((st) => agents.find((a) => a.id === st.agent)?.name || st.agent || "?").join(" → ");
    const card = document.createElement("div");
    card.className = "app-card gtask-card";
    card.dataset.slug = t.slug;
    card.innerHTML = `
      <div class="app-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:26px;height:26px"><rect x="3" y="4.5" width="18" height="16.5" rx="2.5" style="fill:#f43f5e;stroke:none"/><rect x="5.4" y="8.4" width="13.2" height="10.2" rx="1.2" style="fill:#ffffff;stroke:none"/><path d="m9.4 13.4 2 2 3.6-3.6" style="fill:none;stroke:#f43f5e;stroke-width:2"/></svg></div>
      <div class="app-card-name"></div>
      <div class="app-card-id"></div>`;
    (card.querySelector(".app-card-name") as HTMLElement).textContent = t.name;
    (card.querySelector(".app-card-id") as HTMLElement).textContent = stepLine || "no steps yet";
    card.addEventListener("click", () => void openDetail(t.slug));
    grid.appendChild(card);
  }
  list.appendChild(grid);
  if (state.totalPages > 1) list.appendChild(renderPaginationBar(state, (p) => { page = p; renderList(); }));
}

function agentOptions(selected: string): string {
  const opts = agents.map((a) =>
    `<option value="${escapeHtml(a.id)}"${a.id === selected ? " selected" : ""}>${escapeHtml(a.model ? `${a.name} — ${a.model}` : a.name)}</option>`);
  return `<option value=""${selected ? "" : " selected"}>First agent</option>${opts.join("")}`;
}

function renderSteps(): void {
  const host = el("gtask-steps");
  if (!host) return;
  host.innerHTML = "";
  if (!draftSteps.length) {
    host.innerHTML = `<div class="settings-hint">No steps — add one.</div>`;
  }
  draftSteps.forEach((st, i) => {
    const row = document.createElement("div");
    row.className = "gtask-step";
    row.innerHTML = `
      <div class="gtask-step-head">
        <span class="gtask-step-n">Step ${i + 1}</span>
        <select class="settings-input gtask-step-agent">${agentOptions(st.agent)}</select>
        <input type="text" class="settings-input gtask-step-model" placeholder="model override" spellcheck="false" value="${escapeHtml(st.model ?? "")}" />
        <button type="button" class="ws-icon-btn gtask-step-del" title="Remove step"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" style="width:14px;height:14px"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>
      </div>
      <textarea class="settings-input gtask-step-program" rows="4" spellcheck="false" placeholder="what this step's agent does — it also sees the previous step's output"></textarea>`;
    (row.querySelector(".gtask-step-program") as HTMLTextAreaElement).value = st.program;
    row.querySelector(".gtask-step-agent")!.addEventListener("change", (ev) => { st.agent = (ev.target as HTMLSelectElement).value; });
    row.querySelector(".gtask-step-model")!.addEventListener("input", (ev) => { st.model = (ev.target as HTMLInputElement).value.trim() || undefined; });
    row.querySelector(".gtask-step-program")!.addEventListener("input", (ev) => { st.program = (ev.target as HTMLTextAreaElement).value; });
    row.querySelector(".gtask-step-del")!.addEventListener("click", () => { draftSteps.splice(i, 1); renderSteps(); });
    host.appendChild(row);
  });
}

async function renderSchedules(): Promise<void> {
  const host = el("gtask-schedules");
  if (!host) return;
  if (!editing) { host.innerHTML = `<div class="settings-hint">Save the task first.</div>`; return; }
  const slug = editing.slug;
  const rows = (await api().taskSchedulesList?.(slug).catch(() => null))?.data ?? [];
  host.innerHTML = `
    ${rows.map((r) => `<div class="loop-model-row" data-id="${escapeHtml(r.id)}">
      <span class="loop-model-label" style="font-family:ui-monospace,monospace;">${escapeHtml(r.cron)}</span>
      <span class="lib-table-dim">${r.enabled ? "on" : "paused"}</span>
      <button type="button" class="action-btn gtask-sched-del" data-id="${escapeHtml(r.id)}">Remove</button>
    </div>`).join("")}
    <div class="loop-model-row">
      <input class="settings-input gtask-sched-cron" placeholder="0 9 * * 1-5" spellcheck="false" style="max-width:170px;font-family:ui-monospace,monospace;" />
      <button type="button" class="action-btn primary gtask-sched-add">Add schedule</button>
    </div>
    <div class="settings-hint hidden gtask-sched-msg"></div>`;
  host.querySelector(".gtask-sched-add")?.addEventListener("click", () => {
    const cronV = (host.querySelector<HTMLInputElement>(".gtask-sched-cron")?.value ?? "").trim();
    if (!cronV) return;
    void api().taskScheduleSave?.({ taskSlug: slug, cron: cronV }).then((r) => {
      const msg = host.querySelector<HTMLElement>(".gtask-sched-msg");
      if (!r?.ok) { if (msg) { msg.textContent = r?.error || "couldn't save"; msg.classList.remove("hidden"); } return; }
      void renderSchedules();
    });
  });
  host.querySelectorAll<HTMLElement>(".gtask-sched-del").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.id) void api().taskScheduleDelete?.(b.dataset.id).then(() => void renderSchedules());
  }));
}

async function renderRuns(): Promise<void> {
  const host = el("gtask-runs");
  if (!host) return;
  if (!editing) { host.textContent = "Save the task to see its runs."; return; }
  const runs = (await api().tasksRuns?.(editing.slug).catch(() => null))?.data ?? [];
  if (!runs.length) { host.textContent = "No runs yet."; return; }
  host.innerHTML = runs.slice(0, 12).map((r) => `
    <div class="gtask-run" data-id="${escapeHtml(r.id)}">
      <div class="gtask-run-head">
        <span class="gtask-run-status ${r.status === "ok" ? "ok" : r.status === "running" ? "" : "bad"}">${escapeHtml(r.status)}</span>
        <span class="lib-table-dim">${escapeHtml(new Date(r.startedAt).toLocaleString())}${r.durationMs != null ? ` · ${Math.round(r.durationMs / 1000)}s` : ""}</span>
      </div>
      ${r.error ? `<div class="gtask-run-err">${escapeHtml(r.error)}</div>` : ""}
      ${r.output ? `<pre class="gtask-run-out hidden">${escapeHtml(r.output)}</pre>` : ""}
    </div>`).join("");
  host.querySelectorAll<HTMLElement>(".gtask-run").forEach((row) => {
    row.addEventListener("click", () => row.querySelector(".gtask-run-out")?.classList.toggle("hidden"));
  });
}

function showEditor(task: TaskRow | null): void {
  editing = task;
  draftSteps = task ? task.steps.map((s) => ({ ...s })) : [{ agent: "", program: "" }];
  el("gtasks-list")?.classList.add("hidden");
  el("gtasks-toolbar")?.classList.add("hidden");
  el("gtask-editor")?.classList.remove("hidden");
  el("gtask-form-error")?.classList.add("hidden");
  (el<HTMLInputElement>("gtask-name")!).value = task?.name ?? "";
  (el<HTMLInputElement>("gtask-desc")!).value = task?.description ?? "";
  (el<HTMLInputElement>("gtask-repeat")!).value = String(task?.repeat ?? 1);
  el("gtask-delete-btn")?.classList.toggle("hidden", !task);
  el("gtask-run-btn")?.classList.toggle("hidden", !task);
  renderSteps();
  void renderSchedules();
  void renderRuns();
}

async function openDetail(slug: string): Promise<void> {
  const r = await api().tasksGet?.(slug);
  if (!r?.ok || !r.data) { fail(r?.error || "couldn't load the task"); return; }
  showEditor(r.data);
}

async function refresh(): Promise<void> {
  const [t, a] = await Promise.all([
    api().tasksList?.().catch(() => null),
    api().cliAgentsList?.().catch(() => null),
  ]);
  all = t?.ok ? (t.data ?? []) : [];
  agents = a?.ok ? a.agents : [];
}

export function loadTasksPage(): void {
  showList();
  void refresh().then(renderList);
}

export function initTasksPage(): void {
  el("gtask-new-btn")?.addEventListener("click", () => showEditor(null));
  el("gtask-back-link")?.addEventListener("click", showList);
  el<HTMLInputElement>("gtask-search")?.addEventListener("input", renderList);
  el("gtask-step-add")?.addEventListener("click", () => { draftSteps.push({ agent: "", program: "" }); renderSteps(); });

  el("gtask-save-btn")?.addEventListener("click", () => {
    const input = {
      ...(editing ? { slug: editing.slug } : {}),
      name: el<HTMLInputElement>("gtask-name")?.value ?? "",
      description: el<HTMLInputElement>("gtask-desc")?.value ?? "",
      steps: draftSteps,
      repeat: Number(el<HTMLInputElement>("gtask-repeat")?.value ?? 1) || 1,
    };
    void api().tasksSave?.(input).then(async (r) => {
      if (!r?.ok || !r.data) { fail(r?.error || "couldn't save the task"); return; }
      await refresh();
      showEditor(r.data);   // stay in the editor — schedules/runs need the slug
    });
  });

  el("gtask-cancel-btn")?.addEventListener("click", showList);

  el("gtask-delete-btn")?.addEventListener("click", () => {
    if (!editing) return;
    const doomed = editing;
    void confirmAction({
      title: `Delete task "${doomed.name}"?`,
      body: "Its schedules stop and its run history goes with it.",
      confirmLabel: "Delete",
      danger: true,
    }).then((yes) => {
      if (!yes) return;
      void api().tasksDelete?.(doomed.slug).then(async () => { await refresh(); showList(); });
    });
  });

  el("gtask-run-btn")?.addEventListener("click", () => {
    if (!editing) return;
    const btn = el<HTMLButtonElement>("gtask-run-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Running…"; }
    void api().tasksRunNow?.(editing.slug).then((r) => {
      if (btn) { btn.disabled = false; btn.innerHTML = "&#9654; Run now"; }
      if (r && !r.ok) fail(r.error || "run failed");
      void renderRuns();
    });
  });
}
