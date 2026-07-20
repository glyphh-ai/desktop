/**
 * Agents section — READ-first: the workforce roster.
 *
 * The Glyphh AGENT authors agents (loop choice, selections, guardrails, task
 * bindings); asking a human to fill those in was the wrong job for a human.
 * This page shows the truth: what each agent is, the loop and models it runs,
 * and its schedule with real last-run status from the task scheduler.
 *
 * The hand controls are strictly OPERATIONAL: live/pause, per-task
 * enable/disable, delete. Everything else routes to the composer through the
 * built-in /create-agent.
 */

import { $a, escapeHtml, paginate, renderPaginationBar, confirmAction } from "./shared.js";
import { seedComposer } from "./code.js";
import { kebabCell, ROW_MENU_ICONS } from "./lib-editor.js";
import {
  unwrap,
  type Agent, type AgentSummary, type AgentTask, type LoopSummary,
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
const liveToggle = $a<HTMLInputElement>("agent-live");

function fail(msg: string): void {
  formError.textContent = msg;
  formError.classList.remove("hidden");
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
  try {
    all = unwrap<AgentSummary[]>(await window.yo.libraryAgentsList());
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
  toolbar.classList.remove("hidden");
  listEl.innerHTML = "";
  current = null;

  if (all.length === 0) {
    listEl.innerHTML = `<div class="crud-empty">No agents yet — click "+ New with AI" and describe the standing work.</div>`;
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
      { icon: ROW_MENU_ICONS.edit, label: "Edit", onClick: () => void openDetail(agent.id) },
      { icon: ROW_MENU_ICONS.delete, label: "Delete", danger: true, onClick: () => {
        void (async () => {
          const sure = await confirmAction({ title: `Delete "${agent.name}"?`, body: "Its scheduled tasks stop firing with it.", confirmLabel: "Delete", danger: true });
          if (!sure) return;
          const env = await window.yo.libraryAgentDelete(agent.id);
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
function humanCron(cron: string): string {
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

function taskRow(task: AgentTask): HTMLElement {
  const row = document.createElement("div");
  row.className = "lib-task-row";
  const status = task.lastError
    ? `failed ${task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : ""} — ${task.lastError.slice(0, 80)}`
    : task.lastRunAt
      ? `${task.lastStatus ?? "ran"} · ${new Date(task.lastRunAt).toLocaleString()}`
      : "never run yet";
  row.innerHTML = `
    <label class="lib-task-enabled" title="Enabled"><input type="checkbox" ${task.enabled ? "checked" : ""} /></label>
    <span class="lib-task-name"></span>
    <span class="lib-task-binding"></span>
    <span class="lib-task-status"${task.lastError ? ' style="color:var(--danger)"' : ""}></span>`;
  row.querySelector(".lib-task-name")!.textContent = task.name;
  row.querySelector(".lib-task-binding")!.textContent = `runs ${task.target} ${humanCron(task.cron)}`;
  row.querySelector(".lib-task-status")!.textContent = status;
  row.querySelector<HTMLInputElement>(".lib-task-enabled input")!.addEventListener("change", async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    const r = await window.yo.libraryAgentTaskUpdate(current!.id, task.id, { enabled });
    if (!r.ok) { fail(r.error || "couldn't toggle the task"); (e.target as HTMLInputElement).checked = !enabled; }
  });
  return row;
}

async function openDetail(id: string): Promise<void> {
  formError.classList.add("hidden");
  const env = await window.yo.libraryAgentGet(id);
  if (!env.ok) { fail(env.error || "couldn't load the agent"); return; }
  current = env.data as Agent;

  const r = await window.yo.loopsList?.();
  loops = ((r?.loops ?? []) as unknown as LoopSummary[]);

  liveToggle.checked = current.live;

  detailEl.innerHTML = `
    <h3 class="lib-read-title">${escapeHtml(current.name)}</h3>
    <p class="lib-read-desc">${escapeHtml(current.description || "")}</p>
    <div class="lib-read-meta">
      ${current.selections?.skills?.length ? readRow("Skills", current.selections.skills.join(", ")) : ""}
      ${readRow("Scope", current.scope === "org" ? "Shared with the org" : "Personal")}
    </div>
    <div class="agent-config-form">
      <label class="settings-label">Loop</label>
      <select id="agent-loop-select" class="settings-input"></select>
      <p class="field-hint">What this agent runs — its manifest decides which model slots exist below.</p>
      <div id="agent-model-rows"></div>
      <div class="settings-actions" id="agent-loop-actions">
        <div style="flex:1;"></div>
        <button id="agent-loop-cancel" class="action-btn">Cancel</button>
        <button id="agent-loop-save" class="action-btn primary">Save</button>
      </div>
    </div>
    <hr class="lib-divider" />
    <span class="lib-read-label">Schedule</span>
    <div id="agent-task-rows"></div>`;

  // ── Loop + model overrides: the ONE hand-form on this page. The loop picks
  // the contract; each DECLARED slot shows what it resolves to and lets the
  // user pin a different model for this agent. "Auto" = inherit resolution.
  const loopSelect = detailEl.querySelector<HTMLSelectElement>("#agent-loop-select")!;
  for (const loop of loops) {
    const opt = document.createElement("option");
    opt.value = loop.slug ?? loop.id;
    opt.textContent = loop.name;
    loopSelect.appendChild(opt);
  }
  const boundSlug = current.loopId
    ? (loops.find((l) => l.id === current!.loopId)?.slug ?? "default")
    : "default";
  loopSelect.value = boundSlug;
  await paintModelRows(boundSlug, current.selections?.roles ?? {});
  loopSelect.addEventListener("change", () => void paintModelRows(loopSelect.value, {}));

  // Cancel follows the app's convention: discard and RETURN TO THE LIST.
  // (It previously repainted the same agent — visually a dead button.)
  detailEl.querySelector("#agent-loop-cancel")!.addEventListener("click", () => renderList());
  detailEl.querySelector("#agent-loop-save")!.addEventListener("click", () => void saveLoopAndModels());

  const rowsEl = detailEl.querySelector<HTMLElement>("#agent-task-rows")!;
  const tasksEnv = await window.yo.libraryAgentTasks(current.id);
  const tasks = tasksEnv.ok ? (tasksEnv.data as AgentTask[]) : [];
  if (!tasks.length) {
    rowsEl.innerHTML = `<div class="crud-empty">No scheduled tasks — ask the agent to add one.</div>`;
  } else {
    for (const task of tasks) rowsEl.appendChild(taskRow(task));
  }

  toolbar.classList.add("hidden");
  listEl.classList.add("hidden");
  editor.classList.remove("hidden");
}

/** One dropdown per role the loop DECLARES, showing the resolved model and the
 *  caller's choices. The Default loop declares none — its implicit slot shows
 *  read-only, because the server only accepts overrides on declared roles. */
async function paintModelRows(loopSlug: string, selections: Record<string, string>): Promise<void> {
  const host = detailEl.querySelector<HTMLElement>("#agent-model-rows");
  if (!host) return;
  host.innerHTML = "";
  const res = await window.yo.loopRoles(loopSlug);
  if (!res.ok || !res.roles.length) return;

  const loop = loops.find((l) => (l.slug ?? l.id) === loopSlug);
  const declared = new Set<string>();
  // Declared role names come from the summary's manifest only via detail —
  // the roles endpoint returns the implicit slot too, so ask the loop itself.
  const loopEnv = await window.yo.libraryLoopGet(loopSlug);
  if (loopEnv.ok) {
    for (const role of ((loopEnv.data as { manifest?: { roles?: Array<{ name: string }> } }).manifest?.roles ?? [])) {
      declared.add(role.name);
    }
  }

  // Display NAMES, never raw catalog ids — "Auto — Fable 5", not
  // "Auto — anthropic::claude-fable-5".
  const nameOf = (roleChoices: typeof res.roles[number]["choices"], id: string | null): string => {
    if (!id) return "resolved at run time";
    return roleChoices.find((c) => c.id === id)?.name || id;
  };

  for (const role of res.roles) {
    const row = document.createElement("div");
    if (!declared.has(role.name)) {
      // Implicit slot: show the resolution, no override to offer.
      row.innerHTML = `
        <label class="settings-label">Model</label>
        <div class="lib-read-value">${escapeHtml(nameOf(role.choices, role.modelId))}</div>
        <p class="field-hint">Resolved by ${escapeHtml(loop?.name ?? "the loop")}.</p>`;
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
    const pinned = selections[role.name];
    if (pinned) select.value = pinned;
    row.append(label, select);
    if (role.description) {
      // The slot's purpose, as a quiet normal-case hint — inside the LABEL it
      // inherited the uppercase treatment and shouted across two lines.
      const hint = document.createElement("p");
      hint.className = "field-hint";
      hint.textContent = role.description;
      row.appendChild(hint);
    }
    host.appendChild(row);
  }
}

/** Save the loop + per-role overrides — selections the loop doesn't declare
 *  are dropped, matching what the server would refuse anyway. */
async function saveLoopAndModels(): Promise<void> {
  if (!current) return;
  formError.classList.add("hidden");
  const loopSlug = detailEl.querySelector<HTMLSelectElement>("#agent-loop-select")!.value;
  const loopId = loopSlug === "default" ? null : (loops.find((l) => (l.slug ?? l.id) === loopSlug)?.id ?? null);
  const roles: Record<string, string> = {};
  detailEl.querySelectorAll<HTMLSelectElement>("#agent-model-rows select[data-role]").forEach((s) => {
    if (s.value) roles[s.dataset.role!] = s.value;
  });
  const selections = { ...(current.selections ?? {}) };
  if (Object.keys(roles).length) selections.roles = roles;
  else delete selections.roles;

  const env = await window.yo.libraryAgentUpdate(current.id, { loopId, selections });
  if (!env.ok) { fail(env.error || "save failed"); return; }
  await loadAgents();
  await openDetail(current.id);
}

export function initAgentsEvents(): void {
  searchInput.addEventListener("input", renderList);
  $a("agent-back-link").addEventListener("click", () => renderList());

  // Authoring is the AGENT'S job — both paths seed the composer.
  $a("agent-new-btn").addEventListener("click", () => seedComposer("/create-agent "));
  $a("agent-ai-btn").addEventListener("click", () => {
    if (!current) return;
    seedComposer(`/create-agent Update the existing agent "${current.slug}" (${current.name}): `);
  });

  // Live/pause is operational, not authoring — it stays a hand switch.
  liveToggle.addEventListener("change", async () => {
    if (!current) return;
    const env = await window.yo.libraryAgentUpdate(current.id, { live: liveToggle.checked });
    if (!env.ok) { fail(env.error || "couldn't change live state"); liveToggle.checked = !liveToggle.checked; return; }
    current = env.data as Agent;
  });

  $a("agent-delete-btn").addEventListener("click", async () => {
    if (!current) return;
    const sure = await confirmAction({ title: "Delete this agent?", body: "Its scheduled tasks stop firing with it.", confirmLabel: "Delete" });
    if (!sure) return;
    const env = await window.yo.libraryAgentDelete(current.id);
    if (!env.ok) { fail(env.error || "delete failed"); return; }
    await loadAgents();
  });
}
