/**
 * Loops section — READ-first, like Skills and Agents.
 *
 * The Glyphh AGENT authors loops; this page shows what exists — each loop's
 * model slots, what it may reach, its program, and the flow view — and routes
 * every authoring action ("+ New with AI", "Edit with AI") to the composer,
 * seeded through the built-in /create-loop.
 *
 * Built-ins (Default, Plan & Build) power the composer's Loop chip and stay
 * out of this list; the only hand controls are search and delete.
 */

import { $a, escapeHtml, paginate, renderPaginationBar, confirmAction } from "./shared.js";
import type { Loop, LoopSummary } from "./library-types.js";
import { loopGraph, renderFlow } from "./lib-flow.js";
import { seedComposer } from "./code.js";
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

export async function loadLoops(): Promise<void> {
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
    listEl.innerHTML = `<div class="crud-empty">No loops yet — click "+ New with AI" and describe the flow you want.</div>`;
    return;
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="crud-empty">No loops matching "${escapeHtml(query)}"</div>`;
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
          const sure = await confirmAction({ title: `Delete "${loop.name}"?`, body: "Agents bound to it will fall back to the Default loop.", confirmLabel: "Delete", danger: true });
          if (!sure) return;
          const env = await window.glyphh.libraryLoopDelete(loop.slug ?? loop.id);
          if (env.ok) await loadLoops();
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
  if (!env.ok) { fail(env.error || "couldn't load the loop"); return; }
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
    ${current.code ? `<hr class="lib-divider" /><span class="lib-read-label">Program</span><pre class="lib-read-code">${escapeHtml(current.code)}</pre>` : ""}
    ${current.builtIn ? "" : `<div class="settings-actions lib-detail-actions">
      <button id="loop-delete-btn" class="action-btn danger">Delete</button>
      <div style="flex:1;"></div>
    </div>`}`;

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
    const opts = [`<option value="">Auto — platform default</option>`]
      .concat(r.choices.map((c) => `<option value="${c.id}"${c.id === def ? " selected" : ""}>${escapeHtml(c.name)}</option>`));
    return `<div class="loop-model-row">
      <span class="loop-model-label">${escapeHtml(r.label || r.name)}</span>
      <select class="settings-input loop-model-select" data-role="${escapeHtml(r.name)}">${opts.join("")}</select>
    </div>`;
  }).join("");
  return `<hr class="lib-divider" />
    <span class="lib-read-label">Default models</span>
    <p class="settings-hint" style="margin:4px 0 8px;">${builtIn
      ? "Built-in loops run on the platform default — this can't be changed."
      : "The model each slot defaults to. A member can still override it in the composer."}</p>
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
          msg.textContent = res.error?.includes("forbidden") || res.error?.includes("admin")
            ? "Only org admins can change a loop's default models."
            : (res.error || "Couldn't save.");
          msg.classList.remove("hidden"); msg.classList.add("danger");
        }
      })();
    });
  });
}

export function initLoopsEvents(): void {
  wireSplitDivider($a("loop-split-divider"), detailEl);
  searchInput.addEventListener("input", renderList);
  $a("loop-back-link").addEventListener("click", () => renderList());

  // Authoring is the AGENT'S job — both paths seed the composer.
  $a("loop-new-btn").addEventListener("click", () => seedComposer("/create-loop "));
  $a("loop-ai-btn").addEventListener("click", () => {
    if (!current) return;
    seedComposer(`/create-loop Update the existing loop "${current.slug}" (${current.name}): `);
  });

}

async function deleteCurrent(): Promise<void> {
  if (!current || current.builtIn) return;
  const sure = await confirmAction({ title: `Delete "${current.name}"?`, body: "Agents bound to it will fall back to the Default loop.", confirmLabel: "Delete", danger: true });
  if (!sure) return;
  const env = await window.glyphh.libraryLoopDelete(current.slug);
  if (!env.ok) { fail(env.error || "delete failed"); return; }
  await loadLoops();
}
