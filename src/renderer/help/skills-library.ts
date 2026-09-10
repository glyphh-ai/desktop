/**
 * Skills section — READ-first.
 *
 * The Glyphh AGENT authors skills; a human filling in manifests was the wrong
 * job for a human. This page shows what exists — what each skill is, when it
 * triggers, its instructions rendered as prose, and the flow view — and routes
 * every authoring action ("+ New with AI", "Edit with AI") to the composer,
 * seeded through the built-in /create-skill.
 *
 * The only hand controls are operational: search, and delete.
 */

import { $a, escapeHtml, paginate, renderPaginationBar, confirmAction, promptAction } from "./shared.js";
import { unwrap, type Skill, type SkillSummary } from "./library-types.js";
import { skillGraph, renderFlow } from "./lib-flow.js";
import { formatMarkdown } from "../format-markdown.js";
import { wireSplitDivider, kebabCell, ROW_MENU_ICONS, wireIdentityEdit } from "./lib-editor.js";

let all: SkillSummary[] = [];
let page = 0;
let current: Skill | null = null;

const listEl = $a("skills-list");
const toolbar = $a("skills-toolbar");
const editor = $a("skill-editor");
const searchInput = $a<HTMLInputElement>("skill-search");
const formError = $a("skill-form-error");
const detailEl = $a("skill-detail");
const flowHost = $a("skill-flow-host");

function fail(msg: string): void {
  formError.textContent = msg;
  formError.classList.remove("hidden");
}

export async function loadSkillsLibrary(): Promise<void> {
  listEl.innerHTML = `<div class="crud-empty">Loading…</div>`;
  try {
    all = unwrap<SkillSummary[]>(await window.glyphh.librarySkillsList());
  } catch (err) {
    listEl.innerHTML = `<div class="crud-empty">Couldn't load skills — ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
    return;
  }
  renderList();
}

function renderList(): void {
  // Built-ins power the "/" menu and the AI seeds — this page shows the org's own.
  const mine = all.filter((s) => !s.builtIn);
  const query = searchInput.value.trim().toLowerCase();
  const filtered = query
    ? mine.filter((s) => `${s.name} ${s.slug} ${s.description}`.toLowerCase().includes(query))
    : mine;

  listEl.className = "app-list-wrap";
  editor.classList.add("hidden");
  toolbar.classList.remove("hidden");
  listEl.innerHTML = "";
  current = null;

  if (mine.length === 0) {
    listEl.innerHTML = `<div class="crud-empty">No skills yet — <b>+ New</b> starts one; write its instructions.</div>`;
    return;
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="crud-empty">No skills matching "${escapeHtml(query)}"</div>`;
    return;
  }

  const { items, state } = paginate(filtered, page);
  page = state.page;
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Name</th><th>Description</th><th>Trigger</th><th>Updated</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const skill of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="lib-table-name"></td>
      <td class="lib-table-desc"></td>
      <td>${skill.schedule ? `<span class="lib-badge">${escapeHtml(skill.schedule)}</span>` : "On demand"}${skill.hasCode ? ` <span class="lib-badge">Code</span>` : ""}</td>
      <td class="lib-table-dim">${skill.updatedAt ? escapeHtml(new Date(skill.updatedAt).toLocaleDateString()) : ""}</td>`;
    tr.querySelector(".lib-table-name")!.textContent = skill.name;
    tr.querySelector(".lib-table-desc")!.textContent = skill.description || skill.slug;
    tr.addEventListener("click", () => void openDetail(skill.slug));
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.edit, label: "Edit", onClick: () => void openDetail(skill.slug) },
      { icon: ROW_MENU_ICONS.delete, label: "Delete", danger: true, onClick: () => {
        void (async () => {
          const sure = await confirmAction({ title: `Delete "${skill.name}"?`, body: "Loops and agent tasks that name it will fail until rebound.", confirmLabel: "Delete", danger: true });
          if (!sure) return;
          const env = await window.glyphh.librarySkillDelete(skill.slug);
          if (env.ok) await loadSkillsLibrary();
        })();
      } },
    ]));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  listEl.appendChild(table);
  if (state.totalPages > 1) listEl.appendChild(renderPaginationBar(state, (p) => { page = p; renderList(); }));
}

/**
 * Join hard-wrapped continuation lines before rendering. Agent-authored
 * markdown wraps at ~80 cols; the app's renderer treats every newline as a
 * paragraph break, which SPLINTERS lists — each numbered item restarts at
 * "1." and its continuation text falls out of the list to the margin. A line
 * that doesn't start new block syntax belongs to the line above it.
 */
function unwrapSoftBreaks(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  const startsBlock = (s: string) => /^(\s*$|#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\||\s{4,})/.test(s);
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.trim() && line.trim() && !startsBlock(line) && !prev.trimEnd().endsWith("  ") && !/^```/.test(prev.trim())) {
      out[out.length - 1] = `${prev.trimEnd()} ${line.trim()}`;
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** A read row: small uppercase label + value. */
function readRow(label: string, value: string): string {
  return `<div class="lib-read-row"><span class="lib-read-label">${escapeHtml(label)}</span><span class="lib-read-value">${escapeHtml(value)}</span></div>`;
}

async function openDetail(ref: string): Promise<void> {
  formError.classList.add("hidden");
  const env = await window.glyphh.librarySkillGet(ref);
  if (!env.ok) { fail(env.error || "couldn't load the skill"); return; }
  current = env.data as Skill;
  const m = current.manifest ?? {};

  detailEl.innerHTML = `
    <h3 class="lib-read-title">${escapeHtml(current.name)}</h3>
    <p class="lib-read-desc">${escapeHtml(current.description || "")}</p>
    <div class="lib-read-meta">
      ${readRow("Trigger", m.schedule ? `Scheduled · ${m.schedule}` : "On demand")}
      ${m.model ? readRow("Model", m.model) : ""}
      ${m.requires?.length ? readRow("Connections", m.requires.join(", ")) : ""}
      ${m.allowedTools?.length ? readRow("Tools", m.allowedTools.join(", ")) : ""}
      ${readRow("Updated", current.updatedAt ? new Date(current.updatedAt).toLocaleString() : "—")}
    </div>
    ${m.whenToUse ? `<div class="lib-read-when"><span class="lib-read-label">When Glyphh reaches for it</span><p>${escapeHtml(m.whenToUse)}</p></div>` : ""}
    <hr class="lib-divider" /><span class="lib-read-label">Instructions</span>
    <p class="settings-hint" style="margin:4px 0 6px;">What the skill teaches an agent — markdown; agents read it through the glyphh MCP tools.</p>
    <textarea id="skill-prompt" class="settings-input" rows="10" spellcheck="false" style="font-family:ui-monospace,monospace;width:100%;"></textarea>
    ${current.code ? `<hr class="lib-divider" /><span class="lib-read-label">Program</span><pre class="lib-read-code">${escapeHtml(current.code)}</pre>` : ""}
    <div class="settings-actions lib-detail-actions">
      <button id="skill-delete-btn" class="action-btn danger">Delete</button>
      <div style="flex:1;"></div>
    </div>`;
  const sp = detailEl.querySelector<HTMLTextAreaElement>("#skill-prompt");
  if (sp) {
    sp.value = current.prompt || "";
    sp.addEventListener("change", () => {
      void window.glyphh.librarySkillUpdate(current!.slug, { prompt: sp.value }).then((r) => {
        if (r.ok && current) current.prompt = sp.value;
      });
    });
  }

  detailEl.querySelector("#skill-delete-btn")!.addEventListener("click", () => void deleteCurrent());
  wireIdentityEdit(detailEl, { name: current.name, description: current.description || "" }, async (patch) => {
    const res = await window.glyphh.librarySkillUpdate(current!.slug, patch);
    if (!res.ok) return res.error || "Couldn't save.";
    const row = all.find((s) => s.id === current!.id);
    if (row) { row.name = patch.name; row.description = patch.description; }
    await openDetail(current!.slug);
    return null;
  });

  toolbar.classList.add("hidden");
  listEl.classList.add("hidden");
  editor.classList.remove("hidden");
  void renderFlow(flowHost, skillGraph(current.name, m));
}

export function initSkillsLibraryEvents(): void {
  wireSplitDivider($a("skill-split-divider"), detailEl);
  searchInput.addEventListener("input", renderList);
  $a("skill-back-link").addEventListener("click", () => renderList());

  // HAND authoring (the AI author died with the glyphh agent).
  $a("skill-new-btn").addEventListener("click", () => {
    void promptAction("New skill — name it", "", "release-notes", "Create").then((name) => {
      if (!name) return;
      void (window.glyphh as unknown as { skillsCreate?: (i: { name: string }) => Promise<{ ok: boolean; data?: { slug: string }; error?: string }> })
        .skillsCreate?.({ name }).then(async (r) => {
          if (!r?.ok) { fail(r?.error || "couldn't create the skill"); return; }
          await loadSkillsLibrary();
          if (r.data?.slug) void openDetail(r.data.slug);
        });
    });
  });
  $a("skill-ai-btn")?.classList.add("hidden");

}

async function deleteCurrent(): Promise<void> {
  if (!current) return;
  const sure = await confirmAction({ title: `Delete "${current.name}"?`, body: "Loops and agent tasks that name it will fail until rebound.", confirmLabel: "Delete", danger: true });
  if (!sure) return;
  const env = await window.glyphh.librarySkillDelete(current.slug);
  if (!env.ok) { fail(env.error || "delete failed"); return; }
  await loadSkillsLibrary();
}
