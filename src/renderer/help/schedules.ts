/**
 * Schedules section — scheduled-task CRUD.
 *
 * A scheduled task is a skill that runs on a cadence (or on demand). Tasks
 * are tracked in the `scheduledTasks` preference (array of skill names) so a
 * Manual task lists here even with no cron. Each task's manifest holds the
 * description, cron `schedule`, model, frequency label, and ask-mode; the
 * prompt holds the instructions. Enable/disable maps to scheduler pause/resume.
 */

import { $a, escapeHtml, confirmAction } from "./shared.js";

interface TaskRow {
  /** Store schedule id (source "schedule") or task name (skill/orphan). */
  id: string;
  /** Where this task lives: standalone prompt schedule, a skill, or run-only. */
  source: "schedule" | "skill" | "orphan";
  name: string;
  description: string;
  cron: string;
  scheduleLabel: string;
  model: string;
  ask: string;
  prompt: string;
  paused: boolean;
}

interface PartialSeed {
  name?: string;
  description?: string;
  cron?: string;
  model?: string;
  ask?: string;
  prompt?: string;
}

const EDIT_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
const DELETE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
const PLAY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;

const FREQUENCIES: Array<{ value: string; label: string; hasTime: boolean }> = [
  { value: "manual",   label: "Manual",   hasTime: false },
  { value: "hourly",   label: "Hourly",   hasTime: false },
  { value: "daily",    label: "Daily",    hasTime: true },
  { value: "weekdays", label: "Weekdays", hasTime: true },
  { value: "weekly",   label: "Weekly",   hasTime: true },
  { value: "monthly",  label: "Monthly",  hasTime: true },
];

const pad = (n: number | string) => String(n).padStart(2, "0");

function buildCron(freq: string, time: string): string {
  const [h, m] = (time || "09:00").split(":").map((x) => parseInt(x, 10) || 0);
  switch (freq) {
    case "hourly":   return "0 * * * *";
    case "daily":    return `${m} ${h} * * *`;
    case "weekdays": return `${m} ${h} * * 1-5`;
    case "weekly":   return `${m} ${h} * * 1`;
    case "monthly":  return `${m} ${h} 1 * *`;
    default:         return "";
  }
}

function parseCron(cron: string | undefined): { freq: string; time: string } {
  if (!cron) return { freq: "manual", time: "09:00" };
  const p = cron.trim().split(/\s+/);
  if (p.length < 5) return { freq: "manual", time: "09:00" };
  const [min, hour, dom, , dow] = p;
  if (hour === "*") return { freq: "hourly", time: "09:00" };
  const time = `${pad(hour)}:${pad(min)}`;
  if (dom === "1") return { freq: "monthly", time };
  if (dow === "1-5") return { freq: "weekdays", time };
  if (dow === "1") return { freq: "weekly", time };
  return { freq: "daily", time };
}

function fmtTime(time: string): string {
  const [h, m] = (time || "09:00").split(":").map((x) => parseInt(x, 10) || 0);
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${ampm}`;
}

function scheduleLabel(cron: string | undefined): string {
  const { freq, time } = parseCron(cron);
  const f = FREQUENCIES.find((x) => x.value === freq);
  if (!f) return "Manual";
  return f.hasTime ? `${f.label} at ${fmtTime(time)}` : f.label;
}

function relTime(ts: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function prettyModel(model: string): string {
  return model
    .replace(/^.*\//, "")
    .replace(/-(\d{8})$/, "")
    .replace(/claude-/, "Claude ")
    .replace(/-/g, " ");
}

// ── State ───────────────────────────────────────────────────

let tasks: TaskRow[] = [];
let currentEdit: { name: string; isNew: boolean; source: "schedule" | "skill" | "orphan" | "new"; id: string } | null = null;
let currentDetail: TaskRow | null = null;

// ── List ────────────────────────────────────────────────────

async function loadSchedules(): Promise<void> {
  $a("schedules-toolbar").classList.remove("hidden");
  $a("schedules-list").classList.remove("hidden");
  $a("schedule-editor").classList.add("hidden");
  $a("schedule-detail").classList.add("hidden");
  const banner = document.getElementById("schedules-banner");
  if (banner) banner.classList.remove("hidden");

  tasks = [];
  const covered = new Set<string>();
  try {
    // 1) Standalone prompt schedules (the new, skill-free store).
    try {
      const stored = await window.yo.schedulesList();
      for (const raw of stored) {
        const s = raw as { id: string; name: string; description?: string; prompt: string; cron: string; model?: string; ask?: string; paused?: boolean };
        covered.add(s.name);
        tasks.push({
          id: s.id, source: "schedule", name: s.name,
          description: s.description || "", cron: s.cron || "", scheduleLabel: scheduleLabel(s.cron || ""),
          model: s.model || "", ask: s.ask || "auto", prompt: s.prompt || "", paused: !!s.paused,
        });
      }
    } catch { /* none */ }

    // 2) Legacy skill-backed schedules (skills tracked in the pref).
    const prefNames: string[] = ((await window.yo.getPreference("scheduledTasks", [])) as string[]) || [];
    let status: Array<{ name: string; schedule: string; paused: boolean }> = [];
    try { status = await window.yo.skillsScheduleStatus(); } catch { status = []; }
    const pausedByName = new Map(status.map((s) => [s.name, s.paused]));
    for (const name of prefNames) {
      if (covered.has(name)) continue;
      try {
        const s = await window.yo.skillsGet(name);
        if (!s) continue;
        covered.add(name);
        const m = s.manifest as Record<string, unknown>;
        const cron = (m.schedule as string) || "";
        tasks.push({
          id: name, source: "skill", name,
          description: (m.description as string) || "",
          cron, scheduleLabel: scheduleLabel(cron),
          model: (m.model as string) || "", ask: (m.ask as string) || "auto",
          prompt: s.prompt || "", paused: pausedByName.get(name) ?? false,
        });
      } catch { /* skip */ }
    }

    // 3) Orphaned tasks that only exist as run history (skill since removed).
    let runNames: string[] = [];
    try { runNames = [...new Set((await window.yo.runsList()).map((r) => r.skillName).filter(Boolean))]; } catch { runNames = []; }
    for (const name of runNames) {
      if (covered.has(name)) continue;
      covered.add(name);
      tasks.push({
        id: name, source: "orphan", name,
        description: "Run history only — no schedule definition.",
        cron: "", scheduleLabel: "Manual", model: "", ask: "auto", prompt: "", paused: false,
      });
    }
  } catch { /* nothing yet */ }
  renderSchedulesList();
}

function renderSchedulesList(): void {
  const list = $a("schedules-list");
  const search = ($a<HTMLInputElement>("schedule-search").value || "").toLowerCase().trim();
  list.innerHTML = "";

  if (tasks.length === 0) {
    list.innerHTML = `<div class="crud-empty">No scheduled tasks yet. Click "+ New" to create one.</div>`;
    return;
  }
  const filtered = tasks.filter((t) =>
    !search || t.name.toLowerCase().includes(search) || t.description.toLowerCase().includes(search),
  );
  if (filtered.length === 0) {
    list.innerHTML = `<div class="crud-empty">No tasks matching "${escapeHtml(search)}"</div>`;
    return;
  }

  for (const t of filtered) {
    const badges: string[] = [`<span class="sched-badge freq">${escapeHtml(t.scheduleLabel)}</span>`];
    if (t.model) badges.push(`<span class="sched-badge">${escapeHtml(prettyModel(t.model))}</span>`);
    badges.push(`<span class="sched-badge ask">${t.ask === "ask" ? "Asks first" : "Automatic"}</span>`);

    const card = document.createElement("div");
    card.className = "crud-card";
    card.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name">${escapeHtml(t.name)}</span>
        <span class="crud-card-meta">${t.description ? escapeHtml(t.description) + "<br>" : ""}${badges.join(" ")}</span>
      </div>
      <div class="crud-card-actions">
        <label class="sched-toggle" title="${t.cron ? "Enable / disable" : "No schedule (manual only)"}">
          <input type="checkbox" data-toggle="${escapeHtml(t.name)}" ${!t.paused ? "checked" : ""} ${t.cron ? "" : "disabled"}/>
          <span class="sched-toggle-track"><span class="sched-toggle-thumb"></span></span>
        </label>
        <button class="crud-card-btn" data-run="${escapeHtml(t.name)}" title="Run now">${PLAY_ICON}</button>
        <button class="crud-card-btn" data-edit="${escapeHtml(t.name)}" title="Edit">${EDIT_ICON}</button>
        <button class="crud-card-btn danger" data-del="${escapeHtml(t.name)}" title="Delete">${DELETE_ICON}</button>
      </div>`;
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, label, input")) return;
      openDetail(t);
    });
    card.querySelector(`[data-toggle="${cssEscape(t.name)}"]`)!.addEventListener("change", async (e) => {
      e.stopPropagation();
      const cb = e.currentTarget as HTMLInputElement;
      try {
        if (t.source === "schedule") {
          if (cb.checked) await window.yo.schedulesResume(t.id); else await window.yo.schedulesPause(t.id);
        } else {
          if (cb.checked) await window.yo.skillsResumeSchedule(t.name); else await window.yo.skillsPauseSchedule(t.name);
        }
        t.paused = !cb.checked;
      } catch { cb.checked = !cb.checked; }
    });
    card.querySelector(`[data-run="${cssEscape(t.name)}"]`)!.addEventListener("click", (e) => {
      e.stopPropagation();
      void runNow(t);
    });
    card.querySelector(`[data-edit="${cssEscape(t.name)}"]`)!.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditor(t);
    });
    card.querySelector(`[data-del="${cssEscape(t.name)}"]`)!.addEventListener("click", async (e) => {
      e.stopPropagation();
      await removeTask(t);
    });
    list.appendChild(card);
  }
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

// ── Actions ─────────────────────────────────────────────────

async function runNow(t: TaskRow): Promise<void> {
  if (t.source === "orphan") return; // run-history only — nothing to execute
  const before = new Set<string>();
  try { (await window.yo.runsList(t.name)).forEach((r) => before.add(r.id)); } catch { /* none */ }

  const runPromise = (t.source === "schedule"
    ? window.yo.schedulesRun(t.id)
    : window.yo.skillsRun(t.name, undefined)
  ).catch(() => { /* failure shows in history */ });

  // Toast immediately; run history refreshes below once it completes (the
  // in-app agent panel that used to open a run's chat transcript was removed).
  showToast(`Task "${t.name}" is running…`);

  await runPromise;
  if (currentDetail && currentDetail.name === t.name) void loadDetailHistory(t);
}

/** Transient bottom-center notification (ported from v4). */
function showToast(message: string, actionLabel?: string, onAction?: () => void): void {
  const toast = document.createElement("div");
  toast.className = "sched-toast";
  const msg = document.createElement("span");
  msg.className = "sched-toast-msg";
  msg.textContent = message;
  toast.appendChild(msg);
  let timer = 0;
  const dismiss = () => { window.clearTimeout(timer); toast.classList.remove("show"); setTimeout(() => toast.remove(), 200); };
  if (actionLabel && onAction) {
    const a = document.createElement("button");
    a.className = "sched-toast-action";
    a.textContent = actionLabel;
    a.addEventListener("click", () => { dismiss(); onAction(); });
    toast.appendChild(a);
  }
  const close = document.createElement("button");
  close.className = "sched-toast-close";
  close.textContent = "×";
  close.addEventListener("click", dismiss);
  toast.appendChild(close);
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  timer = window.setTimeout(dismiss, 6000);
}

async function removeTask(t: TaskRow): Promise<void> {
  const msg = t.source === "skill"
    ? `Delete the scheduled task "${t.name}"? This removes the skill too.`
    : `Delete the scheduled task "${t.name}"? This also clears its run history.`;
  if (!(await confirmAction(msg))) return;
  try {
    if (t.source === "schedule") {
      await window.yo.schedulesDelete(t.id);            // removes the schedule + its runs
    } else if (t.source === "skill") {
      try { await window.yo.skillsRemove(t.name); } catch { /* ignore */ }
      const names = ((await window.yo.getPreference("scheduledTasks", [])) as string[]).filter((n) => n !== t.name);
      window.yo.setPreference("scheduledTasks", names);
      await window.yo.schedulesDeleteRuns(t.name);       // clear its run history too
    } else {
      await window.yo.schedulesDeleteRuns(t.name);       // orphan: just delete the runs
    }
  } catch { /* ignore */ }
  window.dispatchEvent(new Event("scheduled-tasks-changed"));
  await loadSchedules();
}

// ── Detail ──────────────────────────────────────────────────

/** Deep-link: open the Schedules page and show one task's detail by name. */
export async function openScheduleByName(name: string): Promise<void> {
  await loadSchedules();
  const t = tasks.find((x) => x.name === name);
  if (t) openDetail(t);
}

function openDetail(t: TaskRow): void {
  currentDetail = t;
  $a("schedules-toolbar").classList.add("hidden");
  $a("schedules-list").classList.add("hidden");
  $a("schedule-editor").classList.add("hidden");
  $a("schedule-detail").classList.remove("hidden");
  const banner = document.getElementById("schedules-banner");
  if (banner) banner.classList.add("hidden");

  $a("schedule-detail-title").textContent = t.name;
  $a("schedule-detail-desc").textContent = t.description || "";
  const active = !!t.cron && !t.paused;
  $a("schedule-detail-status").textContent = t.cron ? (active ? "Active" : "Paused") : "Manual only";
  $a("schedule-detail-prompt").textContent = t.prompt || "No instructions yet.";
  $a("schedule-detail-repeats").textContent = scheduleLabel(t.cron);
  $a("schedule-detail-model").textContent = t.model ? prettyModel(t.model) : "Default";
  $a("schedule-detail-ask").textContent = t.ask === "ask" ? "Ask before running" : "Run automatically";
  void loadDetailHistory(t);
}

async function loadDetailHistory(t: TaskRow): Promise<void> {
  const host = $a("schedule-detail-history");
  host.innerHTML = "";
  let runs: Array<{ id: string; created: string; trigger: string; ok: boolean }> = [];
  try { runs = await window.yo.runsList(t.name); } catch { runs = []; }
  if (!runs.length) {
    host.innerHTML = `<div class="sched-history-empty">No runs yet. Run it now to see output here.</div>`;
    return;
  }
  for (const r of runs) {
    const when = r.created ? relTime(new Date(r.created).getTime()) : "";
    const row = document.createElement("button");
    row.className = "sched-history-row";
    row.innerHTML = `<span class="sched-history-dot ${r.ok ? "ok" : "err"}"></span><span>${escapeHtml(when)}</span>`;
    // Row click used to open the run's transcript in the (now-removed) in-app
    // agent chat panel. No replacement viewer exists yet, so rows are
    // currently display-only.
    host.appendChild(row);
  }
}

// ── Editor ──────────────────────────────────────────────────

function openEditor(t: TaskRow | null): void {
  const isNew = t === null;
  currentEdit = { name: t?.name || "", isNew, source: t?.source || "new", id: t?.id || "" };

  $a("schedules-toolbar").classList.add("hidden");
  $a("schedules-list").classList.add("hidden");
  $a("schedule-detail").classList.add("hidden");
  $a("schedule-editor").classList.remove("hidden");
  $a("schedule-form-error").classList.add("hidden");
  const banner = document.getElementById("schedules-banner");
  if (banner) banner.classList.add("hidden");

  const seed: PartialSeed = t || {};
  $a<HTMLInputElement>("schedule-name").value = seed.name || "";
  $a<HTMLInputElement>("schedule-name").disabled = !isNew;
  $a<HTMLInputElement>("schedule-desc").value = seed.description || "";
  $a<HTMLTextAreaElement>("schedule-prompt").value = seed.prompt || "";

  const { freq, time } = parseCron(seed.cron);
  $a<HTMLSelectElement>("schedule-freq").value = seed.cron !== undefined ? freq : "daily";
  $a<HTMLInputElement>("schedule-time").value = time;
  $a<HTMLSelectElement>("schedule-ask").value = seed.ask || "auto";

  syncTimeEnabled();
  void populateModels(seed.model);

  ($a("schedule-delete-btn") as HTMLElement).style.display = isNew ? "none" : "";
}

function syncTimeEnabled(): void {
  const freq = $a<HTMLSelectElement>("schedule-freq").value;
  const f = FREQUENCIES.find((x) => x.value === freq);
  $a<HTMLInputElement>("schedule-time").disabled = !f?.hasTime;
}

async function populateModels(current?: string): Promise<void> {
  const sel = $a<HTMLSelectElement>("schedule-model");
  sel.innerHTML = "";
  let presets: Record<string, { name: string; models: string[]; defaultModel: string }> = {};
  let cfg: { provider: string; model: string } | null = null;
  try { presets = await window.yo.getLLMPresets(); } catch { presets = {}; }
  try { cfg = await window.yo.getLLMConfig(); } catch { cfg = null; }
  const def = document.createElement("option");
  def.value = "";
  def.textContent = cfg?.model ? `Default (${prettyModel(cfg.model)})` : "Default";
  sel.appendChild(def);
  for (const key of Object.keys(presets)) {
    const group = presets[key];
    const og = document.createElement("optgroup");
    og.label = group.name;
    for (const m of group.models) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = prettyModel(m);
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  if (current) sel.value = current;
}

async function saveSchedule(): Promise<void> {
  if (!currentEdit) return;
  const err = $a("schedule-form-error");
  const name = $a<HTMLInputElement>("schedule-name").value.trim();
  const instructions = $a<HTMLTextAreaElement>("schedule-prompt").value.trim();
  if (!name) { err.textContent = "Name is required."; err.classList.remove("hidden"); return; }
  if (!instructions) { err.textContent = "Instructions are required."; err.classList.remove("hidden"); return; }

  const cron = buildCron(
    $a<HTMLSelectElement>("schedule-freq").value,
    $a<HTMLInputElement>("schedule-time").value,
  );
  const model = $a<HTMLSelectElement>("schedule-model").value;
  const ask = $a<HTMLSelectElement>("schedule-ask").value;
  const saveBtn = $a("schedule-save-btn");
  saveBtn.setAttribute("disabled", "1");

  if (currentEdit.source === "skill") {
    // Editing a legacy skill-backed schedule — keep it a skill for back-compat.
    const manifest: Record<string, unknown> = {
      name, description: $a<HTMLInputElement>("schedule-desc").value.trim(),
      schedule: cron, scheduleLabel: scheduleLabel(cron), model, ask,
    };
    const res = await window.yo.skillsWriteFull(name, manifest, instructions);
    saveBtn.removeAttribute("disabled");
    if (res && typeof res === "object" && "error" in res) {
      err.textContent = (res as { error: string }).error || "Could not save the task.";
      err.classList.remove("hidden");
      return;
    }
    const names = (await window.yo.getPreference("scheduledTasks", [])) as string[];
    if (!names.includes(name)) { names.push(name); window.yo.setPreference("scheduledTasks", names); }
  } else {
    // New or store-backed schedule — a standalone prompt schedule (no skill).
    await window.yo.schedulesSave({
      id: currentEdit.source === "schedule" ? currentEdit.id : "",
      name, description: $a<HTMLInputElement>("schedule-desc").value.trim(),
      prompt: instructions, cron, model, ask,
    });
    saveBtn.removeAttribute("disabled");
  }
  window.dispatchEvent(new Event("scheduled-tasks-changed"));
  await loadSchedules();
}

// ── Init ────────────────────────────────────────────────────

function initSchedules(): void {
  const search = $a<HTMLInputElement>("schedule-search");
  if (!search) return;
  search.addEventListener("input", renderSchedulesList);
  $a("schedule-new-btn").addEventListener("click", () => openEditor(null));
  $a("schedule-back-link").addEventListener("click", () => { void loadSchedules(); });
  $a("schedule-cancel-btn").addEventListener("click", () => { void loadSchedules(); });
  $a("schedule-save-btn").addEventListener("click", () => { void saveSchedule(); });
  $a("schedule-delete-btn").addEventListener("click", async () => {
    if (!currentEdit || currentEdit.isNew) return;
    const t = tasks.find((x) => x.name === currentEdit!.name);
    if (t) await removeTask(t);
  });

  $a("schedule-detail-back").addEventListener("click", () => { currentDetail = null; void loadSchedules(); });
  $a("schedule-detail-edit").addEventListener("click", () => {
    if (currentDetail) openEditor(currentDetail);
  });
  $a("schedule-detail-run").addEventListener("click", () => {
    if (currentDetail) void runNow(currentDetail);
  });
  $a("schedule-detail-delete").addEventListener("click", async () => {
    if (currentDetail) await removeTask(currentDetail);
  });

  $a<HTMLSelectElement>("schedule-freq").addEventListener("change", syncTimeEnabled);

  // Keep-awake preference toggle (banner)
  const keepAwake = $a<HTMLInputElement>("sched-keep-awake");
  if (keepAwake) {
    void window.yo.getPreference("schedulesKeepAwake", false).then((v) => { keepAwake.checked = !!v; });
    keepAwake.addEventListener("change", () => window.yo.setKeepAwake(keepAwake.checked));
  }
}

export { loadSchedules, initSchedules };
