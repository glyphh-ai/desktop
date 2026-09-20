/**
 * Settings → Memory (his order, 2026-09-19): the policy a user accepts before
 * Glyphh remembers anything, the preferences that shape it, the org's
 * overrides on top, and the door to clear it all.
 *
 * Effective = accepted AND (org says on → on; org says off → off; else the
 * user's own toggle). Main reads the same preferences and the same gates, so
 * what this page shows is what the bridge does.
 */
import { loadEmbeddingsSettings } from "./settings-loops.js";
import { planGates, invalidatePlanGates } from "./plan-gate.js";
import { confirmAction } from "./shared.js";
import { toastOk } from "./toast.js";
import { createGlyphhSpinner } from "../glyphh-spinner.js";

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const notice = (msg: string): void => { toastOk(msg); };

type Rule = "member" | "on" | "off";
interface MemoryPolicy { inject?: Rule; capture?: Rule; sensitive?: Rule }

const PREFS = { inject: "memoryInject", capture: "memoryCapture", sensitive: "memorySensitive" } as const;
const DEFAULTS: Record<keyof typeof PREFS, boolean> = { inject: true, capture: true, sensitive: false };

export async function loadMemorySettings(): Promise<void> {
  const g = window.glyphh as unknown as {
    getPreference?: (k: string, d: unknown) => Promise<unknown>;
    setPreference?: (k: string, v: unknown) => void;
    memoryStats?: () => Promise<{ ok: boolean; turns?: number; chunks?: number; facts?: number }>;
    memoryClear?: () => Promise<{ ok: boolean; deleted?: number; error?: string }>;
  };
  invalidatePlanGates();
  const gates = await planGates() as unknown as { memoryPolicy?: MemoryPolicy };
  const policy: MemoryPolicy = gates.memoryPolicy ?? {};
  const accepted = !!(await g.getPreference?.("memoryPolicyAcceptedAt", ""));

  const acceptBox = el<HTMLInputElement>("toggle-memory-policy");
  const acceptDesc = el("memory-policy-desc");
  if (acceptBox) {
    acceptBox.checked = accepted;
    if (acceptDesc) acceptDesc.textContent = accepted ? "Accepted. Memory follows the preferences below." : "Memory stays off until you accept.";
    acceptBox.onchange = () => {
      g.setPreference?.("memoryPolicyAcceptedAt", acceptBox.checked ? new Date().toISOString() : "");
      void loadMemorySettings();
    };
  }

  el("memory-accept-note")?.classList.toggle("hidden", accepted);
  const note = el("memory-org-note");
  const forced = (Object.entries(policy) as Array<[keyof typeof PREFS, Rule]>).filter(([, r]) => r === "on" || r === "off");
  if (note) {
    note.classList.toggle("hidden", forced.length === 0);
    if (forced.length) note.textContent = "Your organization sets: " + forced.map(([k, r]) => `${LABEL[k]} ${r}`).join(", ") + ". Those rows follow the org.";
  }

  for (const key of Object.keys(PREFS) as Array<keyof typeof PREFS>) {
    const box = el<HTMLInputElement>(`toggle-memory-${key}`);
    if (!box) continue;
    const rule = policy[key] ?? "member";
    const own = await g.getPreference?.(PREFS[key], DEFAULTS[key]);
    const value = rule === "on" ? true : rule === "off" ? false : own !== false && (own === true || DEFAULTS[key]);
    box.checked = value;
    box.disabled = !accepted || rule !== "member";
    box.onchange = () => { g.setPreference?.(PREFS[key], box.checked); };
  }

  await loadEmbeddingsSettings();

  await renderMemoryBrowser();
  const curate = el<HTMLButtonElement>("memory-curate-btn");
  if (curate) {
    curate.onclick = async () => {
      const status = el("memory-curate-status");
      if (!status) return;
      curate.disabled = true;
      status.classList.remove("hidden"); status.textContent = "";
      const spin = createGlyphhSpinner({ size: 18, phrases: true });
      spin.setMeta("Compiling your memory pages…");
      status.appendChild(spin.el);
      const r = await (window.glyphh as unknown as { memoryCurateNow?: () => Promise<{ ok: boolean; error?: string }> }).memoryCurateNow?.().catch(() => null);
      spin.destroy();
      curate.disabled = false;
      status.innerHTML = r?.ok ? `<span class="mem-check">✓</span> Pages compiled` : "";
      if (!r?.ok) status.textContent = r?.error || "Couldn't compile pages.";
      await renderMemoryBrowser();
    };
  }
  const stats = el("memory-stats");
  if (stats) {
    const r = await g.memoryStats?.().catch(() => null);
    stats.textContent = r?.ok
      ? `${r.turns ?? 0} turns in ${r.chunks ?? 0} pieces on this machine${r.facts ? `, ${r.facts} saved facts` : ""}.`
      : "Nothing yet.";
  }
  const clearBtn = el<HTMLButtonElement>("memory-clear-btn");
  if (clearBtn) {
    clearBtn.onclick = async () => {
      const sure = await confirmAction({ title: "Clear memory?", body: "Every remembered turn on this machine is deleted. Saved facts stay.", confirmLabel: "Clear", danger: true });
      if (!sure) return;
      const r = await g.memoryClear?.();
      if (r?.ok) { notice("Memory cleared"); void loadMemorySettings(); }
      else notice(r?.error || "Couldn't clear memory.");
    };
  }
}

const LABEL: Record<keyof typeof PREFS, string> = { inject: "search past sessions", capture: "generate memory", sensitive: "sensitive topics" };

// ── THE MEMORY BROWSER (his order, 2026-09-20): rendered like a knowledge
// base — You, Topics, Areas, then one section per project (workspace and
// folder), then sessions with no folder. A row is name · summary · updated,
// with Edit and Delete; Edit opens the memory's page, where a line typed at
// the bottom is added and the memory goes back through the embeddings model
// with the Glyphh spinner reporting, then "Updated memory".
interface MemoryRow { id: string; kind: string; section: string; title: string; summary: string; details: string[]; text: string; at: string; folder: string; workspace: string; parts: number }
interface MemoryApi {
  memoryTurnList?: () => Promise<{ ok: boolean; rows: MemoryRow[]; error?: string }>;
  memoryTurnForget?: (source: string) => Promise<{ ok: boolean; error?: string }>;
  memoryTurnUpdate?: (input: { source: string; title?: string; summary?: string; details: string[] }) => Promise<{ ok: boolean; error?: string }>;
}
const memApi = (): MemoryApi => window.glyphh as unknown as MemoryApi;
const PENCIL = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const TRASH = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
const BACK = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>`;
const SEND = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`;

function memWhen(iso: string, long = false): string {
  const t = Date.parse(iso);
  if (!t) return "";
  const d = new Date(t).toLocaleDateString(undefined, long ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
  return long ? d : `Updated ${d}`;
}
function memFolderName(p: string): string {
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return (i === -1 ? t : t.slice(i + 1)) || t;
}
async function memForget(row: MemoryRow): Promise<boolean> {
  const sure = await confirmAction({ title: `Delete "${row.title.slice(0, 50)}"?`, body: "It leaves memory on this machine for good.", confirmLabel: "Delete", danger: true });
  if (!sure) return false;
  const res = await memApi().memoryTurnForget?.(row.id);
  if (!res?.ok) { notice(res?.error || "Couldn't delete it."); return false; }
  return true;
}

export async function renderMemoryBrowser(): Promise<void> {
  const host = document.getElementById("memory-browser");
  if (!host) return;
  memPanelPageMode(false);
  const r = await memApi().memoryTurnList?.().catch(() => null);
  const rows = r?.ok ? r.rows : [];
  host.textContent = "";
  if (!rows.length) {
    const p = document.createElement("p"); p.className = "mem-empty";
    p.textContent = "Nothing remembered yet. Talk to a loop with memory on and turns land here.";
    host.appendChild(p);
    return;
  }
  const pages = rows.filter((x) => x.kind === "page");
  const turns = rows.filter((x) => x.kind !== "page");
  const sections: Array<{ label: string; rows: MemoryRow[] }> = [
    { label: "You", rows: pages.filter((x) => x.section === "you") },
    { label: "Topics", rows: pages.filter((x) => x.section === "topic") },
    { label: "Areas", rows: pages.filter((x) => x.section === "area") },
  ];
  const byProject = new Map<string, MemoryRow[]>();
  for (const t of turns) {
    const key = t.folder ? `${t.workspace ? `${t.workspace} · ` : ""}${memFolderName(t.folder)}` : "";
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)!.push(t);
  }
  for (const [key, list] of [...byProject.entries()].filter(([k]) => k).sort((a, b) => a[0].localeCompare(b[0]))) sections.push({ label: key, rows: list });
  if (byProject.get("")?.length) sections.push({ label: "Sessions", rows: byProject.get("")! });

  for (const sec of sections) {
    if (!sec.rows.length) continue;
    const h = document.createElement("div"); h.className = "mem-section"; h.textContent = sec.label;
    host.appendChild(h);
    for (const row of sec.rows) {
      const el = document.createElement("div"); el.className = "mem-row";
      el.innerHTML = `<div class="mem-name"></div><div class="mem-summary"></div><div class="mem-when"></div><div class="mem-actions"><button type="button" class="mem-icon" title="Edit">${PENCIL}</button><button type="button" class="mem-icon" title="Delete">${TRASH}</button></div>`;
      (el.querySelector(".mem-name") as HTMLElement).textContent = row.title || "Untitled";
      (el.querySelector(".mem-summary") as HTMLElement).textContent = row.summary;
      (el.querySelector(".mem-when") as HTMLElement).textContent = memWhen(row.at);
      const [edit, del] = Array.from(el.querySelectorAll<HTMLButtonElement>(".mem-icon"));
      edit.onclick = (ev) => { ev.stopPropagation(); renderMemoryPage(row); };
      del.onclick = async (ev) => { ev.stopPropagation(); if (await memForget(row)) void renderMemoryBrowser(); };
      el.addEventListener("click", () => renderMemoryPage(row));
      host.appendChild(el);
    }
  }
}

/** The page takes the whole Memory panel (his order, 2026-09-20); "← Memory" brings the panel back. */
function memPanelPageMode(on: boolean): void {
  document.querySelector<HTMLElement>('.settings-panel[data-sub="memory"]')?.classList.toggle("mem-page-open", on);
}

function renderMemoryPage(row: MemoryRow): void {
  const host = document.getElementById("memory-browser");
  if (!host) return;
  memPanelPageMode(true);
  host.textContent = "";
  const page = document.createElement("div"); page.className = "mem-page";
  page.innerHTML = `
    <button type="button" class="mem-back">${BACK}<span>Memory</span></button>
    <div class="mem-page-head"><h3 class="mem-page-title"></h3><button type="button" class="action-btn mem-page-delete">Delete</button></div>
    <div class="mem-label">Last updated</div><div class="mem-value mem-page-when"></div>
    <div class="mem-label">Summary</div><div class="mem-value mem-page-summary"></div>
    <div class="mem-label">Details</div><ul class="mem-details"></ul>
    <div class="mem-status hidden"></div>
    <div class="mem-compose"><input class="settings-input mem-input" type="text" placeholder="Add to this memory…" /><button type="button" class="mem-send" title="Update memory">${SEND}</button></div>`;
  host.appendChild(page);
  const paint = (): void => {
    (page.querySelector(".mem-page-title") as HTMLElement).textContent = row.title || "Untitled";
    (page.querySelector(".mem-page-when") as HTMLElement).textContent = memWhen(row.at, true);
    (page.querySelector(".mem-page-summary") as HTMLElement).textContent = row.summary || "—";
    const ul = page.querySelector(".mem-details") as HTMLElement; ul.textContent = "";
    for (const d of row.details) { const li = document.createElement("li"); li.textContent = d; ul.appendChild(li); }
  };
  paint();
  (page.querySelector(".mem-back") as HTMLButtonElement).onclick = () => { memPanelPageMode(false); void renderMemoryBrowser(); };
  (page.querySelector(".mem-page-delete") as HTMLButtonElement).onclick = async () => { if (await memForget(row)) { memPanelPageMode(false); void renderMemoryBrowser(); } };
  const input = page.querySelector(".mem-input") as HTMLInputElement;
  const status = page.querySelector(".mem-status") as HTMLElement;
  const send = async (): Promise<void> => {
    const line = input.value.trim();
    if (!line) return;
    input.value = ""; input.disabled = true;
    status.classList.remove("hidden"); status.textContent = "";
    const spin = createGlyphhSpinner({ size: 18, phrases: false });
    spin.setMeta("Updating memory…");
    status.appendChild(spin.el);
    const details = [...row.details, line];
    const res = await memApi().memoryTurnUpdate?.({ source: row.id, title: row.title, summary: row.summary, details });
    spin.destroy();
    input.disabled = false;
    if (!res?.ok) { status.textContent = res?.error || "Couldn't update memory."; return; }
    row.details = details; row.at = new Date().toISOString();
    paint();
    status.innerHTML = `<span class="mem-check">✓</span> Updated memory`;
    input.focus();
  };
  (page.querySelector(".mem-send") as HTMLButtonElement).onclick = () => { void send(); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void send(); } });
  input.focus();
}
