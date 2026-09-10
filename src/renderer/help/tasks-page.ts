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

let pendingOpen: string | null = null;

/** Deep link: land IN a task's editor (the Scheduled Tasks view rides this). */
export function openTaskForEdit(slug: string): void {
  pendingOpen = slug;
  (window as unknown as { __wbOpenSection?: (s: string) => void }).__wbOpenSection?.("tasks");
}

export async function loadTasksPage(): Promise<void> {
  listEl.innerHTML = `<div class="crud-empty">Loading…</div>`;
  const r = await window.glyphh.loopsList?.();
  all = ((r?.loops ?? []) as unknown as LoopSummary[]);
  if (pendingOpen) {
    const target = pendingOpen;
    pendingOpen = null;
    void openDetail(target);
    return;
  }
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
    ${slotDescs ? `<div style="margin-top:18px;"><span class="lib-read-label">What each slot is for</span><div class="lib-read-meta" style="margin-top:6px;">${slotDescs}</div></div>` : ""}
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
      <input class="settings-input loop-model-override" data-role="${escapeHtml(r.name)}" value="${escapeHtml(r.model ?? "")}" placeholder="model override" spellcheck="false" autocomplete="off" style="max-width:170px;font-family:ui-monospace,monospace;" />
    </div>`;
  }).join("");
  return `<hr class="lib-divider" />
    <span class="lib-read-label">Agents</span>
    <p class="settings-hint" style="margin:4px 0 8px;">${builtIn
      ? "Built-in tasks run on the default agent — this can't be changed."
      : "The AGENT each slot runs on (it brings its model; a workspace can override)."}</p>
    <div class="loop-model-list">${rows}</div>
    <div id="loop-model-msg" class="settings-hint hidden" style="margin:8px 0 0;"></div>`;
}

/** Persist a default-model change to the loop's manifest (org_admin-gated
 *  server-side — a member's write surfaces as an inline permission message). */
function wireDefaultModelPickers(): void {
  const msg = detailEl.querySelector<HTMLElement>("#loop-model-msg");
  const report = (res: { ok: boolean; error?: string } | undefined): void => {
    if (!msg) return;
    if (res?.ok) { msg.textContent = "Saved."; msg.classList.remove("hidden", "danger"); }
    else {
      msg.textContent = res?.error || "Couldn't save.";
      msg.classList.remove("hidden"); msg.classList.add("danger");
    }
  };
  detailEl.querySelectorAll<HTMLSelectElement>(".loop-model-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      void (async () => {
        if (!current) return;
        const role = sel.dataset.role!;
        sel.disabled = true;
        const res = await window.glyphh.loopSetRoleDefault(current.id, role, sel.value || null);
        sel.disabled = false;
        report(res);
      })();
    });
  });
  // The slot's model OVERRIDE — written with the CURRENT agent so the same
  // lane never clobbers the binding; empty clears back to the agent's model.
  detailEl.querySelectorAll<HTMLInputElement>(".loop-model-override").forEach((inp) => {
    inp.addEventListener("change", () => {
      void (async () => {
        if (!current) return;
        const role = inp.dataset.role!;
        const agentSel = detailEl.querySelector<HTMLSelectElement>(`.loop-model-select[data-role="${role}"]`);
        inp.disabled = true;
        const res = await window.glyphh.loopSetRoleDefault(current.id, role, agentSel?.value || null, inp.value.trim() || null);
        inp.disabled = false;
        report(res);
      })();
    });
  });
}

export function initTasksPage(): void {
  wireSplitDivider($a("loop-split-divider"), detailEl);
  searchInput.addEventListener("input", renderList);
  $a("loop-back-link").addEventListener("click", () => renderList());
  $a("loops-refresh-btn").addEventListener("click", () => void loadTasksPage());
  (window as unknown as { __glyphhOpenTask?: (slug: string) => void }).__glyphhOpenTask = openTaskForEdit;
  // The scheduled-runs monitor is the WORKBENCH tool panel (chart, next
  // fires, run history) — the old Scheduled Tasks surface, one click away.
  $a("loops-scheduled-btn").addEventListener("click", () => {
    (window as unknown as { __wbOpenTool?: (v: string) => void }).__wbOpenTool?.("tasks");
  });

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
      <span class="loop-model-label">${escapeHtml(cronToWords(r.cron))}</span>\n      <span class="lib-table-dim" style="font-family:ui-monospace,monospace;">${escapeHtml(r.cron)}</span>
      <span class="lib-table-dim">${escapeHtml(agents.find((a) => a.id === r.agentId)?.name || r.agentId)}${r.enabled ? "" : " · paused"}</span>
      <button type="button" class="action-btn loop-sched-del" data-id="${escapeHtml(r.id)}">Remove</button>
    </div>`).join("")}
    <div class="loop-model-row">
      <button type="button" id="loop-sched-add" class="action-btn primary">+ Add schedule</button>
    </div>
    <div id="loop-sched-msg" class="settings-hint hidden"></div>`;
  host.querySelector("#loop-sched-add")?.addEventListener("click", () => {
    void scheduleModal(agents, defAgent).then((picked) => {
      if (!picked || !current) return;
      void api.loopScheduleSave?.({ loopSlug: current.slug, agentId: picked.agentId, cron: picked.cron }).then((r) => {
        const msg = host.querySelector<HTMLElement>("#loop-sched-msg");
        if (!r?.ok) { if (msg) { msg.textContent = r?.error || "couldn't save"; msg.classList.remove("hidden"); } return; }
        void renderScheduleBlock(roles);
      });
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

// ── Human-speak scheduling ───────────────────────────────────────────────────
// "weekdays at 9am" in, cron out. The modal is the ONLY way schedules are
// written (his order, 2026-09-10: the raw five-field input was "horribly
// unforgiving"). Parse lives here, validation stays main-side (node-cron).

const DAY_PATS: Array<[RegExp, number, string]> = [
  [/\bsun(day)?s?\b/, 0, "Sunday"], [/\bmon(day)?s?\b(?!th)/, 1, "Monday"],
  [/\btue(s|sday)?s?\b/, 2, "Tuesday"], [/\bwed(nesday)?s?\b/, 3, "Wednesday"],
  [/\bthu(r|rs|rsday)?s?\b/, 4, "Thursday"], [/\bfri(day)?s?\b/, 5, "Friday"],
  [/\bsat(urday)?s?\b/, 6, "Saturday"],
];

function humanToCron(input: string): { cron: string; words: string } | null {
  const t = input.trim().toLowerCase();
  if (!t) return null;
  // Already a five-field cron? Pass it through untouched.
  if (/^[\d*,/-]+\s+[\d*,/-]+\s+[\d*,/-]+\s+[\d*,/-]+\s+[\d*,/-]+$/.test(t)) return { cron: t, words: "custom cron" };
  const everyMin = /every\s+(\d+)\s*min/.exec(t);
  if (everyMin) return { cron: `*/${everyMin[1]} * * * *`, words: `every ${everyMin[1]} minutes` };
  if (/every\s+hour|hourly/.test(t)) return { cron: "0 * * * *", words: "every hour, on the hour" };
  // The time: "at 9", "9:30am", "at 17:00". No time mentioned → 9:00.
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
  if (days.length) {
    return {
      cron: `${m} ${h} * * ${days.map(([, n]) => n).join(",")}`,
      words: `every ${days.map(([, , label]) => label).join(", ")} at ${timeWords}`,
    };
  }
  if (/every\s*day|daily|each\s*day/.test(t) || tm) return { cron: `${m} ${h} * * *`, words: `every day at ${timeWords}` };
  return null;
}

/** Best-effort friendly rendering of a stored cron for the schedule list. */
function cronToWords(cron: string): string {
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

function scheduleModal(
  agents: Array<{ id: string; name: string }>,
  defAgent: string,
): Promise<{ cron: string; agentId: string } | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const opts = agents.map((a) => `<option value="${escapeHtml(a.id)}"${a.id === defAgent ? " selected" : ""}>${escapeHtml(a.name)}</option>`).join("");
    overlay.innerHTML = `
      <div class="confirm-box" role="dialog" aria-modal="true">
        <div class="confirm-head"><h3>Schedule this task</h3></div>
        <div class="confirm-body">
          <input id="gsched-say" class="settings-input" placeholder="weekdays at 9am" spellcheck="false" autocomplete="off" style="width:100%;" />
          <div id="gsched-preview" class="settings-hint" style="margin:8px 0 0;min-height:17px;">Say it like a human — <i>weekdays at 9am</i>, <i>every 15 minutes</i>, <i>mondays at 8:30</i>, <i>monthly on the 1st</i>.</div>
          <label class="settings-label" style="margin-top:14px;">Run on</label>
          <select id="gsched-agent" class="settings-input" style="width:100%;">${opts}</select>
        </div>
        <div class="confirm-foot">
          <button id="gsched-cancel" class="action-btn secondary" type="button">Cancel</button>
          <button id="gsched-add" class="action-btn primary" type="button" disabled>Add schedule</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.body.classList.add("wb-modal-open");   // panels sit behind the veil
    const say = overlay.querySelector<HTMLInputElement>("#gsched-say")!;
    const preview = overlay.querySelector<HTMLElement>("#gsched-preview")!;
    const addBtn = overlay.querySelector<HTMLButtonElement>("#gsched-add")!;
    let parsed: { cron: string; words: string } | null = null;
    say.addEventListener("input", () => {
      parsed = humanToCron(say.value);
      addBtn.disabled = !parsed;
      if (parsed) preview.innerHTML = `✓ ${escapeHtml(parsed.words)} &nbsp;<span style="font-family:ui-monospace,monospace;opacity:.6;">${escapeHtml(parsed.cron)}</span>`;
      else preview.innerHTML = say.value.trim()
        ? `Didn't get that — try <i>weekdays at 9am</i> or <i>every 15 minutes</i>.`
        : `Say it like a human — <i>weekdays at 9am</i>, <i>every 15 minutes</i>, <i>mondays at 8:30</i>, <i>monthly on the 1st</i>.`;
    });
    const done = (val: { cron: string; agentId: string } | null): void => {
      overlay.remove();
      document.body.classList.remove("wb-modal-open");
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const submit = (): void => {
      if (!parsed) return;
      done({ cron: parsed.cron, agentId: overlay.querySelector<HTMLSelectElement>("#gsched-agent")!.value });
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.preventDefault(); done(null); }
      else if (e.key === "Enter") { e.preventDefault(); submit(); }
    };
    overlay.querySelector("#gsched-cancel")!.addEventListener("click", () => done(null));
    addBtn.addEventListener("click", submit);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(null); });
    document.addEventListener("keydown", onKey);
    say.focus();
  });
}
