/**
 * settings-agents.ts — Settings → Build → Agents (his order, 2026-09-29:
 * "Agents need to live in Settings -> Build… the same look and feel as every
 * other page in there following Connections most closely").
 *
 * An agent is what the Glyphh loop can hand part of a job to: a name, a line
 * saying when to use it (the main agent reads it to decide), a standing brief,
 * and a MODEL SLOT — the point of a swarm, a cheap model to fan out and a
 * strong one for the hard part. The slot's choices are the member's team list,
 * the same answer the composer's picker gets, so a slot can never name a model
 * the member's key would refuse.
 *
 * The list is the Connections grammar (head with search and + New, a table);
 * new and edit are the DRIPS form (his order, 2026-09-29: "look at the drips
 * new / edit form") — an inline form that takes the page, the edit head,
 * stacked labels, Delete · Cancel · Save. The records are local-agents.ts's
 * (the library-agent-* channels).
 */

import { clearInvalid, confirmAction } from "./shared.js";

interface AgentRow { slug: string; name: string; description: string; prompt: string; model: string }
interface Envelope { ok: boolean; data?: unknown; error?: string }
interface LoopModel { id: string; name: string; providerSlug: string }

interface Api {
  libraryAgentsList?: () => Promise<Envelope>;
  libraryAgentCreate?: (input: unknown) => Promise<Envelope>;
  libraryAgentUpdate?: (ref: string, patch: unknown) => Promise<Envelope>;
  libraryAgentDelete?: (ref: string) => Promise<Envelope>;
  loopModels?: (loopId: string, force?: boolean) => Promise<{ ok: boolean; models: LoopModel[] }>;
  agentBriefGenerate?: (input: { name?: string; description?: string; model?: string; draft?: string }) =>
    Promise<{ ok: true; brief: string; model: string } | { ok: false; error: string }>;
  onModelsChanged?: (cb: (c: { models: { ok: boolean; models: LoopModel[] } }) => void) => () => void;
}
const api = (): Api => ((window as unknown as { glyphh?: Api }).glyphh ?? {});
const el = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

const SAME_AS_MAIN = "";
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

let rows: AgentRow[] = [];
let models: LoopModel[] = [];
let query = "";
let loadError = "";
let wired = false;

const asRows = (raw: unknown): AgentRow[] =>
  (Array.isArray(raw) ? raw : [])
    .filter((r): r is AgentRow => !!r && typeof r === "object" && typeof (r as AgentRow).slug === "string")
    .map((r) => ({
      slug: r.slug, name: r.name || r.slug, description: r.description || "", prompt: r.prompt || "", model: r.model || "",
    }));

const modelName = (id: string): string => (!id ? "Same as the main agent" : models.find((m) => m.id === id)?.name ?? id);
/** The list's Model column: the slot. */
const runsAs = (r: AgentRow): string => modelName(r.model);

function initialIcon(name: string, size: "" | "lg" = ""): HTMLElement {
  const i = document.createElement("span");
  i.className = `conn2-icon${size ? ` ${size}` : ""}`;
  const t = document.createElement("span");
  t.className = "conn2-icon-initial";
  t.textContent = (name.trim()[0] || "A").toUpperCase();
  i.appendChild(t);
  return i;
}

let editing: AgentRow | null = null;

function showList(): void {
  el("agents2-editor")?.classList.add("hidden");
  el("agents2-list-view")?.classList.remove("hidden");
  editing = null;
  renderList();
}

function renderList(): void {
  const host = el("agents2-body");
  if (!host) return;
  host.textContent = "";
  const count = el("agents2-count");
  if (count) count.textContent = `${rows.length} agent${rows.length === 1 ? "" : "s"}`;
  if (loadError) {
    const e = document.createElement("div");
    e.className = "crud-empty";
    e.textContent = `Your agents could not be read: ${loadError}`;
    host.appendChild(e);
    return;
  }
  const q = query.trim().toLowerCase();
  const shown = rows.filter((r) => !q || `${r.name} ${r.description}`.toLowerCase().includes(q));
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "crud-empty";
    empty.textContent = q
      ? `No agents matching "${query.trim()}"`
      : "No agents yet. Make one — a researcher on a fast model, a reviewer on a careful one — and Glyphh can split a job between them.";
    host.appendChild(empty);
    return;
  }
  const table = document.createElement("div");
  table.className = "conn2-table agents2-table";
  table.innerHTML = `<div class="conn2-tr head"><span class="conn2-head-connector">Agent</span><span>Model</span><span class="conn2-head-status">Status</span></div>`;
  for (const r of shown) {
    const tr = document.createElement("div");
    tr.className = "conn2-tr openable";
    tr.appendChild(initialIcon(r.name));
    const main = document.createElement("span");
    main.className = "agents2-main";
    const name = document.createElement("span");
    name.className = "conn2-name";
    name.textContent = r.name;
    const desc = document.createElement("span");
    desc.className = "conn2-muted agents2-desc";
    desc.textContent = r.description || "No description — the main agent won't know when to use it.";
    main.append(name, desc);
    const model = document.createElement("span");
    model.className = `conn2-type${r.model ? "" : " agents2-inherit"}`;
    model.textContent = runsAs(r);
    const status = document.createElement("span");
    status.className = "conn2-status";
    if (r.prompt.trim()) status.innerHTML = `<span class="conn2-check" title="Ready to be handed work">${CHECK}</span>`;
    else status.innerHTML = `<span class="conn2-muted">Needs a brief</span>`;
    tr.append(main, model, status);
    tr.addEventListener("click", () => openEditor(r));
    table.appendChild(tr);
  }
  host.appendChild(table);
}

function formError(msg: string): void {
  const e = el("agents2-form-error");
  if (!e) return;
  e.textContent = msg;
  e.classList.toggle("hidden", !msg);
}

/** The WAND's own message, right where the person pressed it — a validation
 *  error in the form's top slot would be off-screen from the brief. */
function briefError(msg: string): void {
  const e = el("agents2-brief-error");
  if (!e) return;
  e.textContent = msg;
  e.classList.toggle("hidden", !msg);
}

/** The edit head: the agent's initial and its name, live as the name is typed. */
function paintHead(name: string): void {
  const head = el("agents2-detail-head");
  if (!head) return;
  head.textContent = "";
  const icons = document.createElement("div");
  icons.className = "edit-head-icons";
  icons.appendChild(initialIcon(name || "New agent", "lg"));
  const n = document.createElement("div");
  n.className = "edit-head-name";
  n.textContent = name.trim() || "New agent";
  head.append(icons, n);
}

/** New (null) or edit: fill the form, swap it in for the list. */
/** The model slot's options: the team's list as it is NOW. A slot naming a
 *  model the team no longer carries reads as the main agent's: the loop
 *  cannot run it, so saying so beats a dead option. */
function fillModels(model: HTMLSelectElement, keep: string): void {
  model.textContent = "";
  const opt = (value: string, label: string): HTMLOptionElement => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  };
  model.appendChild(opt(SAME_AS_MAIN, "Same as the main agent"));
  for (const m of models) model.appendChild(opt(m.id, m.name));
  model.value = models.some((m) => m.id === keep) ? keep : SAME_AS_MAIN;
}

function openEditor(row: AgentRow | null): void {
  editing = row;
  const name = el<HTMLInputElement>("agents2-name");
  const desc = el<HTMLInputElement>("agents2-desc");
  const model = el<HTMLSelectElement>("agents2-model");
  const brief = el<HTMLTextAreaElement>("agents2-brief");
  if (!name || !desc || !model || !brief) return;
  name.value = row?.name ?? "";
  desc.value = row?.description ?? "";
  brief.value = row?.prompt ?? "";
  fillModels(model, row?.model ?? SAME_AS_MAIN);
  model.title = models.length ? "" : "Your team's models couldn't be read; this agent runs on the main agent's model.";
  const del = el("agents2-delete-btn");
  if (del) del.style.display = row ? "" : "none";
  formError("");
  briefError("");
  paintHead(name.value);
  el("agents2-list-view")?.classList.add("hidden");
  el("agents2-editor")?.classList.remove("hidden");
  name.focus();
}

async function saveAgent(): Promise<void> {
  const name = el<HTMLInputElement>("agents2-name");
  const desc = el<HTMLInputElement>("agents2-desc");
  const model = el<HTMLSelectElement>("agents2-model");
  const brief = el<HTMLTextAreaElement>("agents2-brief");
  const save = el<HTMLButtonElement>("agents2-save-btn");
  if (!name || !desc || !model || !brief) return;
  const input = {
    name: name.value.trim(), description: desc.value.trim(), prompt: brief.value.trim(), model: model.value,
  };
  if (!input.name) {
    name.classList.add("invalid");
    clearInvalid(name);
    formError("An agent needs a name.");
    return;
  }
  if (!input.prompt) {
    brief.classList.add("invalid");
    clearInvalid(brief);
    formError("An agent needs a brief — without one it can't be handed work.");
    return;
  }
  if (save) save.disabled = true;
  const r = await (editing ? api().libraryAgentUpdate?.(editing.slug, input) : api().libraryAgentCreate?.(input));
  if (save) save.disabled = false;
  if (!r?.ok) { formError(r?.error || "The agent could not be saved."); return; }
  await refresh();
  showList();
}

const WAND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M12.2 6.2 11 5"/><path d="m15 9-12 12"/></svg>`;

/**
 * THE WAND (his order, 2026-09-29: "when pressed the icon should turn into
 * generating… If no info is present show a form validation error asking for
 * info first"). It writes the brief on the member's default model from what the
 * form says — the name, when to use it, the model slot, and any draft, which
 * it improves rather than throws away. The result lands as an EDIT, so ⌘Z puts
 * the person's own words back.
 */
async function generateBrief(): Promise<void> {
  const name = el<HTMLInputElement>("agents2-name");
  const desc = el<HTMLInputElement>("agents2-desc");
  const model = el<HTMLSelectElement>("agents2-model");
  const brief = el<HTMLTextAreaElement>("agents2-brief");
  const wand = el<HTMLButtonElement>("agents2-generate");
  if (!name || !desc || !model || !brief || !wand || wand.disabled) return;
  const input = { name: name.value.trim(), description: desc.value.trim(), model: model.value, draft: brief.value.trim() };
  if (!input.name && !input.description && !input.draft) {
    for (const f of [name, desc]) { f.classList.add("invalid"); clearInvalid(f); }
    briefError("Give the agent a name and say when to use it first — the brief is written from those.");
    return;
  }
  briefError("");
  wand.disabled = true;
  wand.classList.add("generating");
  wand.innerHTML = `<span class="agents2-wand-spin" aria-hidden="true"></span><span>Generating…</span>`;
  wand.setAttribute("aria-label", "Generating the brief");
  brief.readOnly = true;
  brief.setAttribute("aria-busy", "true");
  const r = await api().agentBriefGenerate?.(input).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  wand.disabled = false;
  wand.classList.remove("generating");
  wand.innerHTML = WAND_SVG;
  wand.setAttribute("aria-label", "Write the brief with AI");
  brief.readOnly = false;
  brief.removeAttribute("aria-busy");
  if (!r) { briefError("Writing a brief isn't available here."); return; }
  if (!r.ok) { briefError(r.error); return; }
  // Undoable: replace the text as an edit, not by assignment.
  brief.focus();
  brief.select();
  if (!document.execCommand("insertText", false, r.brief)) brief.value = r.brief;
  brief.setSelectionRange(0, 0);
  brief.scrollTop = 0;
}

async function deleteAgent(): Promise<void> {
  if (!editing) return;
  const row = editing;
  const sure = await confirmAction({
    title: `Delete “${row.name}”?`,
    body: "Glyphh won't be able to hand work to it any more. Its scheduled tasks go with it.",
    confirmLabel: "Delete agent",
    danger: true,
  });
  if (!sure) return;
  const r = await api().libraryAgentDelete?.(row.slug);
  if (!r?.ok) { formError(r?.error || "The agent could not be deleted."); return; }
  await refresh();
  showList();
}

async function refresh(): Promise<void> {
  const [list, ms] = await Promise.all([
    api().libraryAgentsList?.().catch((e: unknown): Envelope => ({ ok: false, error: e instanceof Error ? e.message : String(e) })),
    api().loopModels?.("glyphh", true).catch(() => null),
  ]);
  rows = list?.ok ? asRows(list.data) : [];
  loadError = list?.ok ? "" : (list?.error || "no answer from the app");
  models = ms?.ok ? ms.models : [];
}

/** The loader navigation.ts calls when the page is shown. */
export async function loadAgentsSettings(): Promise<void> {
  if (!wired) {
    wired = true;
    el("agents2-add")?.addEventListener("click", () => openEditor(null));
    el("agents2-back")?.addEventListener("click", showList);
    el("agents2-cancel-btn")?.addEventListener("click", showList);
    el("agents2-save-btn")?.addEventListener("click", () => { void saveAgent(); });
    el("agents2-delete-btn")?.addEventListener("click", () => { void deleteAgent(); });
    el("agents2-generate")?.addEventListener("click", () => { void generateBrief(); });
    el<HTMLInputElement>("agents2-name")?.addEventListener("input", (e) => { paintHead((e.target as HTMLInputElement).value); briefError(""); });
    el<HTMLInputElement>("agents2-desc")?.addEventListener("input", () => briefError(""));
    el<HTMLInputElement>("agents2-search")?.addEventListener("input", (e) => { query = (e.target as HTMLInputElement).value; renderList(); });
    // THE SERVER MOVED THE LIST (main/model-watch.ts): an open editor's model
    // slot follows it, keeping the pick when the model is still there.
    api().onModelsChanged?.((c) => {
      if (!c.models?.ok) return;
      models = c.models.models;
      const model = el<HTMLSelectElement>("agents2-model");
      if (model) fillModels(model, model.value);
    });
  }
  await refresh();
  showList();
}
