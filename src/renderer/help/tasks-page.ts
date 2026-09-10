/**
 * Tasks section — the loops page RENAMED (his collapse, 2026-09-10).
 *
 * A task is a PROGRAM the agent builds — a spec, not a fixed thing; the only
 * fixed part is the slots→agents. Steps inside the spec can carry a prompt or
 * reference a skill. One-off or scheduled. Storage/lanes stay the loop
 * engine's (~/.glyphh/loops, loops-* IPC) — only the surface word changed.
 * "+ New" hands authoring to the DEFAULT AGENT, which writes through the
 * local MCP task tools.
 */

import { $a, escapeHtml, paginate, renderPaginationBar, confirmAction } from "./shared.js";
import type { Loop, LoopSummary } from "./library-types.js";
import { loopGraph, renderFlow } from "./lib-flow.js";
import { wireSplitDivider, kebabCell, ROW_MENU_ICONS, wireIdentityEdit } from "./lib-editor.js";

let all: LoopSummary[] = [];
let page = 0;
let current: Loop | null = null;

const listEl = $a("loops-list");
const toolbar = $a("loops-toolbar");
const editor = $a("loop-editor");
const searchInput = $a<HTMLInputElement>("loop-search");
const formError = $a("loop-form-error");
const detailEl = $a("loop-detail");
const flowHost = $a("loop-flow-host");
const builtinBadge = $a("loop-builtin-badge");

function fail(msg: string): void {
  formError.textContent = msg;
  formError.classList.remove("hidden");
}

export async function loadTasksPage(): Promise<void> {
  listEl.innerHTML = `<div class="crud-empty">Loading…</div>`;
  const r = await window.glyphh.loopsList?.();
  all = ((r?.loops ?? []) as unknown as LoopSummary[]);
  renderList();
}

function renderList(): void {
  // Built-ins live in the composer's Loop chip, not here.
  const mine = all.filter((l) => !l.builtIn);
  const query = searchInput.value.trim().toLowerCase();
  const filtered = query
    ? mine.filter((l) => `${l.name} ${l.slug} ${l.description}`.toLowerCase().includes(query))
    : mine;

  listEl.className = "app-list-wrap";
  editor.classList.add("hidden");
  toolbar.classList.remove("hidden");
  listEl.innerHTML = "";
  current = null;

  if (mine.length === 0) {
    listEl.innerHTML = `<div class="crud-empty">No tasks yet — <b>+ New</b> hands your default agent the pen; slot an agent and it writes the program.</div>`;
    return;
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="crud-empty">No tasks matching "${escapeHtml(query)}"</div>`;
    return;
  }

  const { items, state } = paginate(filtered, page);
  page = state.page;
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Name</th><th>Description</th><th>Scope</th><th>Updated</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const loop of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-desc"></td>
      <td>${loop.scope === "org" ? `<span class="lib-badge">Org</span>` : "Personal"}</td>
      <td class="lib-table-dim">${loop.updatedAt ? escapeHtml(new Date(loop.updatedAt).toLocaleDateString()) : ""}</td>`;
    tr.querySelector(".lib-table-name")!.textContent = loop.name;
    tr.querySelector(".lib-table-desc")!.textContent = loop.description || loop.slug;
    tr.addEventListener("click", () => void openDetail(loop.slug ?? loop.id));
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.edit, label: "Edit", onClick: () => void openDetail(loop.slug ?? loop.id) },
      { icon: ROW_MENU_ICONS.delete, label: "Delete", danger: true, onClick: () => {
        void (async () => {
          const sure = await confirmAction({ title: `Delete "${loop.name}"?`, body: "Its schedules go with it.", confirmLabel: "Delete", danger: true });
          if (!sure) return;
          const env = await window.glyphh.libraryLoopDelete(loop.slug ?? loop.id);
          if (env.ok) await loadTasksPage();
        })();
      } },
    ]));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  listEl.appendChild(table);
  if (state.totalPages > 1) listEl.appendChild(renderPaginationBar(state, (p) => { page = p; renderList(); }));
}

function readRow(label: string, value: string): string {
  return `<div class="lib-read-row"><span class="lib-read-label">${escapeHtml(label)}</span><span class="lib-read-value">${escapeHtml(value)}</span></div>`;
}

async function openDetail(ref: string): Promise<void> {
  formError.classList.add("hidden");
  const env = await window.glyphh.libraryLoopGet(ref);
  if (!env.ok) { fail(env.error || "couldn't load the task"); return; }
  current = env.data as Loop;
  const m = current.manifest ?? {};

  const slots = m.roles?.length
    ? m.roles.map((r) => r.label || r.name).join(", ")
    : "One (implicit)";
  const slotDescs = (m.roles ?? [])
    .filter((r) => r.description)
    .map((r) => `<div class="lib-read-row"><span class="lib-read-label">${escapeHtml(r.label || r.name)}</span><span class="lib-read-value">${escapeHtml(r.description!)}</span></div>`)
    .join("");
  const memory = m.memory?.read || m.memory?.write
    ? [m.memory.read ? "read" : "", m.memory.write ? "write" : ""].filter(Boolean).join(" + ")
    : "";

  // Resolve the loop's slots + their choices up front — the editable default-model
  // pickers and the flow-node model subs both read from this one call.
  let resolvedRoles: Awaited<ReturnType<typeof window.glyphh.loopRoles>>["roles"] = [];
  try { resolvedRoles = (await window.glyphh.loopRoles(current.slug)).roles; }
  catch { /* offline — pickers fall back to read-only, flow renders without subs */ }

  detailEl.innerHTML = `
    <h3 class="lib-read-title">${escapeHtml(current.name)}</h3>
    <p class="lib-read-desc">${escapeHtml(current.description || "")}</p>
    <div class="lib-read-meta">
      ${readRow("Model slots", slots)}
      ${m.skills?.length ? readRow("Skills", m.skills.join(", ")) : ""}
      ${m.connections?.length ? readRow("Connections", m.connections.join(", ")) : ""}
      ${memory ? readRow("Memory", memory) : ""}
      ${readRow("Scope", current.builtIn ? "Built-in" : current.scope === "org" ? "Shared with the org" : "Personal")}
    </div>
    ${renderDefaultModels(resolvedRoles, m, current.builtIn)}
    ${slotDescs ? `<span class="lib-read-label">What each slot is for</span><div class="lib-read-meta" style="margin-top:6px;">${slotDescs}</div>` : ""}
    <hr class="lib-divider" /><span class="lib-read-label">Program</span>
    <p class="settings-hint" style="margin:4px 0 6px;">What the slotted agent runs — the prompt a scheduled or recursive execution plays.</p>
    <textarea id="loop-program" class="settings-input" rows="8" spellcheck="false" style="font-family:ui-monospace,monospace;width:100%;"></textarea>
    <hr class="lib-divider" /><span class="lib-read-label">Schedule</span>
    <p class="settings-hint" style="margin:4px 0 6px;">Run this task on a cron (five fields — e.g. <code>0 9 * * 1-5</code> is weekdays at 9). No schedules = a one-off task.</p>
    <div id="loop-schedule-host"></div>
    ${current.builtIn ? "" : `<div class="settings-actions lib-detail-actions">
      <button id="loop-delete-btn" class="action-btn danger">Delete</button>
      <div style="flex:1;"></div>
    </div>`}`;
  const prog = detailEl.querySelector<HTMLTextAreaElement>("#loop-program");
  if (prog) {
    prog.value = current.code || "";
    prog.addEventListener("change", () => {
      void window.glyphh.libraryLoopUpdate(current!.slug, { code: prog.value }).then((r) => {
        if (r.ok && current) current.code = prog.value;
      });
    });
  }
  void renderScheduleBlock(resolvedRoles);

  detailEl.querySelector("#loop-delete-btn")?.addEventListener("click", () => void deleteCurrent());
  if (!current.builtIn) {
    wireIdentityEdit(detailEl, { name: current.name, description: current.description || "" }, async (patch) => {
      const res = await window.glyphh.libraryLoopUpdate(current!.slug, patch);
      if (!res.ok) return res.error || "Couldn't save.";
      const row = all.find((l) => l.id === current!.id);
      if (row) { row.name = patch.name; row.description = patch.description; }
      await openDetail(current!.slug);
      return null;
    });
  }
  wireDefaultModelPickers();
  builtinBadge.classList.toggle("hidden", !current.builtIn);

  toolbar.classList.add("hidden");
  listEl.classList.add("hidden");
  editor.classList.remove("hidden");
  // The slot nodes carry the RESOLVED model names — what would actually run.
  const models: Record<string, string> = {};
  for (const role of resolvedRoles) {
    const name = role.choices.find((c) => c.id === role.modelId)?.name;
    if (name) models[role.name] = name;
  }
  void renderFlow(flowHost, loopGraph(current.name, m, models));
}

/** The loop's OWN default model per slot — what it suggests when a caller hasn't
 *  picked one. Editable (writes manifest.roles[].default) unless the loop is
 *  built-in (immutable). "Auto" hands the slot to the platform default. */
function renderDefaultModels(
  roles: Awaited<ReturnType<typeof window.glyphh.loopRoles>>["roles"],
  manifest: NonNullable<Loop["manifest"]>,
  builtIn: boolean,
): string {
  if (!roles.length) return "";
  const manifestDefault = (name: string): string =>
    (manifest.roles ?? []).find((r) => r.name === name)?.default ?? "";
  const rows = roles.map((r) => {
    const def = manifestDefault(r.name);
    if (builtIn) {
      const label = r.choices.find((c) => c.id === def)?.name || "Platform default";
      return `<div class="loop-model-row"><span class="loop-model-label">${escapeHtml(r.label || r.name)}</span><span class="lib-read-value">${escapeHtml(label)}</span></div>`;
    }
    const opts = [`<option value="">Auto — first agent</option>`]
      .concat(r.choices.map((c) => `<option value="${c.id}"${c.id === def ? " selected" : ""}>${escapeHtml(c.name)}</option>`));
    return `<div class="loop-model-row">
      <span class="loop-model-label">${escapeHtml(r.label || r.name)}</span>
      <select class="settings-input loop-model-select" data-role="${escapeHtml(r.name)}">${opts.join("")}</select>
    </div>`;
  }).join("");
  return `<hr class="lib-divider" />
    <span class="lib-read-label">Agents</span>
    <p class="settings-hint" style="margin:4px 0 8px;">${builtIn
      ? "Built-in tasks run on the default agent — this can't be changed."
      : "The AGENT each slot runs on (it brings its model; a workspace can override)."}</p>
    <div class="loop-model-list">${rows}</div>
    <div id="loop-model-msg" class="settings-hint hidden" style="margin-top:6px;"></div>`;
}

/** Persist a default-model change to the loop's manifest (org_admin-gated
 *  server-side — a member's write surfaces as an inline permission message). */
function wireDefaultModelPickers(): void {
  const msg = detailEl.querySelector<HTMLElement>("#loop-model-msg");
  detailEl.querySelectorAll<HTMLSelectElement>(".loop-model-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      void (async () => {
        if (!current) return;
        const role = sel.dataset.role!;
        sel.disabled = true;
        const res = await window.glyphh.loopSetRoleDefault(current.id, role, sel.value || null);
        sel.disabled = false;
        if (!msg) return;
        if (res?.ok) { msg.textContent = "Saved."; msg.classList.remove("hidden", "danger"); }
        else {
          msg.textContent = res.error || "Couldn't save.";
          msg.classList.remove("hidden"); msg.classList.add("danger");
        }
      })();
    });
  });
}

export function initTasksPage(): void {
  wireSplitDivider($a("loop-split-divider"), detailEl);
  searchInput.addEventListener("input", renderList);
  $a("loop-back-link").addEventListener("click", () => renderList());

  // "+ New" opens the DEFAULT AGENT with the authoring task (his order,
  // 2026-09-10) — no default set, the modal points at Settings → General.
  $a("loop-new-btn").addEventListener("click", () => {
    void openDefaultAgent("Create a new Glyphh task for me using the Glyphh MCP tools: call task_save with a name, a description, and a program — the program is the SPEC the slotted agent runs; steps inside it can carry a prompt or reference a Glyphh skill (see skills_list / skill_get). Ask me what the task should do, then save it.");
  });
  $a("loop-ai-btn")?.classList.add("hidden");

}

interface LoopScheduleLite { id: string; agentId: string; name: string; cron: string; enabled: boolean }
type ScheduleApi = {
  loopSchedulesList?: (slug: string) => Promise<{ ok: boolean; data?: LoopScheduleLite[]; error?: string }>;
  loopScheduleSave?: (i: { loopSlug: string; agentId: string; cron: string; id?: string }) => Promise<{ ok: boolean; error?: string }>;
  loopScheduleDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
};

async function renderScheduleBlock(roles: Awaited<ReturnType<typeof window.glyphh.loopRoles>>["roles"]): Promise<void> {
  const host = detailEl.querySelector<HTMLElement>("#loop-schedule-host");
  if (!host || !current) return;
  const api = window.glyphh as unknown as ScheduleApi;
  const rows = (await api.loopSchedulesList?.(current.slug).catch(() => null))?.data ?? [];
  const agents = roles[0]?.choices ?? [];
  const agentOpts = (sel?: string): string => agents.map((a) => `<option value="${escapeHtml(a.id)}"${a.id === sel ? " selected" : ""}>${escapeHtml(a.name)}</option>`).join("");
  const defAgent = roles[0]?.modelId ?? agents[0]?.id ?? "";
  host.innerHTML = `
    ${rows.map((r) => `<div class="loop-model-row" data-sched="${escapeHtml(r.id)}">
      <span class="loop-model-label" style="font-family:ui-monospace,monospace;">${escapeHtml(r.cron)}</span>
      <span class="lib-table-dim">${escapeHtml(agents.find((a) => a.id === r.agentId)?.name || r.agentId)}${r.enabled ? "" : " · paused"}</span>
      <button type="button" class="action-btn loop-sched-del" data-id="${escapeHtml(r.id)}">Remove</button>
    </div>`).join("")}
    <div class="loop-model-row">
      <input id="loop-sched-cron" class="settings-input" placeholder="0 9 * * 1-5" spellcheck="false" style="max-width:160px;font-family:ui-monospace,monospace;" />
      <select id="loop-sched-agent" class="settings-input" style="max-width:240px;">${agentOpts(defAgent)}</select>
      <button type="button" id="loop-sched-add" class="action-btn primary">Add schedule</button>
    </div>
    <div id="loop-sched-msg" class="settings-hint hidden"></div>`;
  host.querySelector("#loop-sched-add")?.addEventListener("click", () => {
    const cronV = (host.querySelector<HTMLInputElement>("#loop-sched-cron")?.value ?? "").trim();
    const agentV = host.querySelector<HTMLSelectElement>("#loop-sched-agent")?.value ?? "";
    if (!cronV || !agentV || !current) return;
    void api.loopScheduleSave?.({ loopSlug: current.slug, agentId: agentV, cron: cronV }).then((r) => {
      const msg = host.querySelector<HTMLElement>("#loop-sched-msg");
      if (!r?.ok) { if (msg) { msg.textContent = r?.error || "couldn't save"; msg.classList.remove("hidden"); } return; }
      void renderScheduleBlock(roles);
    });
  });
  host.querySelectorAll<HTMLElement>(".loop-sched-del").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.id;
    if (!id) return;
    void api.loopScheduleDelete?.(id).then(() => void renderScheduleBlock(roles));
  }));
}

async function deleteCurrent(): Promise<void> {
  if (!current || current.builtIn) return;
  const sure = await confirmAction({ title: `Delete "${current.name}"?`, body: "Its schedules go with it.", confirmLabel: "Delete", danger: true });
  if (!sure) return;
  const env = await window.glyphh.libraryLoopDelete(current.slug);
  if (!env.ok) { fail(env.error || "delete failed"); return; }
  await loadTasksPage();
}

/** "+ New" hands authoring to the DEFAULT AGENT (Settings → General). No
 *  default set → the standard modal points there. */
async function openDefaultAgent(task: string): Promise<void> {
  const yo = window.glyphh as unknown as {
    getPreference?: (k: string, d: unknown) => Promise<unknown>;
    cliAgentsList?: () => Promise<{ ok: boolean; agents: Array<{ id: string; name: string }> }>;
  };
  const def = String((await yo.getPreference?.("defaultAgent", "")) ?? "");
  const agents = (await yo.cliAgentsList?.().catch(() => null))?.agents ?? [];
  const agent = agents.find((a) => a.id === def);
  if (!agent) {
    const go = await confirmAction({
      title: "Set a default agent first",
      body: "\u201c+ New\u201d hands authoring to your default agent. Pick one in Settings \u2192 General.",
      confirmLabel: "Open Settings",
    });
    if (go) (window as unknown as { __glyphhOpenSettings?: (sub?: string) => void }).__glyphhOpenSettings?.("general");
    return;
  }
  (window as unknown as { __wbOpenAgentCli?: (id: string, prompt?: string) => void }).__wbOpenAgentCli?.(agent.id, task);
}
