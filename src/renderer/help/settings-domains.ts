/**
 * settings-domains.ts — Settings › Domains, built on the SAME list-page grammar
 * as Roles/Workspaces (settings-workspaces.ts): a lib-table list-view with a
 * crud-toolbar, row kebab menu, crud-empty states + pagination, and an inline
 * crud-inline-form editor a row opens. One surface for org custom domains: add,
 * publish the DNS records, Verify (retry loop), pick the bare-apex app, remove.
 *
 * All writes ride accountApi()'s dual transport — the web SDK handle or the
 * desktop main-process SDK; NOTHING talks to the API directly. org_admin gated
 * in navigation.ts (gateAdminSubs → #dom-admin-only).
 */

import { accountApi, type OrgDomain } from "./settings-api.js";
import { confirmAction, paginate, renderPaginationBar } from "./shared.js";
import { kebabCell, ROW_MENU_ICONS } from "./lib-editor.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const esc = (v: unknown): string =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let domains: OrgDomain[] = [];
let apps: Array<{ id: string; name: string; slug: string }> = [];
let page = 0;

const CHIP: Record<string, string> = { pending: "Waiting for DNS", verifying: "Verifying", active: "Active", error: "Error" };
const hostSummary = (d: OrgDomain): string => {
  const n = Object.keys(d.hostnames ?? {}).length;
  return n ? `${n} app hostname${n === 1 ? "" : "s"}` : (d.apexAppId ? "apex assigned" : "—");
};

function setError(msg: string): void { const el = $("dom-error"); if (!el) return; el.textContent = msg; el.classList.toggle("hidden", !msg); }
function editError(msg: string): void { const el = $("dom-edit-error"); if (!el) return; el.textContent = msg; el.classList.toggle("hidden", !msg); }
function setStatus(msg: string, kind: "success" | "error" | "" = ""): void {
  const el = $("dom-status"); if (!el) return; el.textContent = msg; el.className = `set-save-state${kind ? ` ${kind}` : ""}`;
}

// ── LIST (lib-table, exactly like Roles) ─────────────────────────────────────
function paintList(): void {
  const list = $("dom-list");
  if (!list) return;
  const q = ($<HTMLInputElement>("dom-search")?.value || "").trim().toLowerCase();
  const rows = domains.filter((d) => !q || d.domain.toLowerCase().includes(q));
  list.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "crud-empty";
    empty.textContent = q ? "No domains match your search." : "No domains yet — add one above.";
    list.appendChild(empty);
    return;
  }
  const { items, state } = paginate(rows, page);
  page = state.page;
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Domain</th><th>Status</th><th>Apps</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const d of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="lib-table-name"></td><td class="lib-table-desc"></td><td class="lib-table-dim"></td>`;
    tr.querySelector(".lib-table-name")!.textContent = d.domain;
    const st = tr.querySelector(".lib-table-desc");
    if (st) {
      const badge = document.createElement("span");
      badge.className = `lib-badge${d.status === "active" ? " on" : ""}`;
      badge.textContent = CHIP[d.status] ?? d.status;
      st.appendChild(badge);
    }
    tr.querySelector(".lib-table-dim")!.textContent = hostSummary(d);
    tr.addEventListener("click", () => openEditor(d));
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.edit, label: "Open", onClick: () => openEditor(d) },
      { icon: ROW_MENU_ICONS.delete, label: "Remove", danger: true, onClick: () => { void removeDomain(d); } },
    ]));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  list.appendChild(table);
  if (state.totalPages > 1) list.appendChild(renderPaginationBar(state, (p) => { page = p; paintList(); }));
}

// ── EDITOR (crud-inline-form, exactly like Roles) ────────────────────────────
const COPY_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const SPIN_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="vertical-align:-1px"><path d="M21 12a9 9 0 1 1-6.2-8.56"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></path></svg>`;
const CHECK_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const copyBtn = (v: string): string => `<button class="action-btn od-copy" type="button" data-copy="${esc(v)}" title="Copy" style="height:22px;width:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;">${COPY_SVG}</button>`;

function showEditor(on: boolean): void {
  $("dom-list-view")?.classList.toggle("hidden", on);
  $("dom-edit-view")?.classList.toggle("hidden", !on);
}

function apexOptions(selected: string | null | undefined): string {
  return `<option value=""${!selected ? " selected" : ""}>Subdomains only (nothing at the bare domain)</option>`
    + apps.map((a) => `<option value="${esc(a.id)}"${a.id === selected ? " selected" : ""}>${esc(a.name)} (${esc(a.slug)})</option>`).join("");
}

function openEditor(d: OrgDomain): void {
  showEditor(true);
  editError("");
  const title = $("dom-edit-title"); if (title) title.textContent = d.domain;
  const chipEl = $("dom-edit-chip");
  if (chipEl) chipEl.innerHTML = `<span class="lib-badge${d.status === "active" ? " on" : ""}">${esc(CHIP[d.status] ?? d.status)}</span>`;
  const body = $("dom-edit-body");
  if (!body) return;
  const hostRows = Object.entries(d.hostnames ?? {});
  body.innerHTML = `
    ${d.error ? `<p class="settings-error" style="margin:0 0 10px;">${esc(d.error)}</p>` : ""}
    ${d.status !== "active" ? `
    <h4 class="acct-row-head">Publish these DNS records</h4>
    <p class="section-desc">Add them at your DNS host, then press Verify.</p>
    <table class="lib-table" style="font-size:12px;"><thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead>
      <tbody>${d.dns.map((r) => `<tr><td>${esc(r.type)}</td><td><code>${esc(r.name)}</code> ${copyBtn(r.name)}</td><td><code>${esc(r.value)}</code> ${copyBtn(r.value)}</td></tr>`).join("")}</tbody>
    </table>
    <div class="settings-actions" style="margin:12px 0;"><button id="dom-verify" class="action-btn primary" type="button">Verify</button></div>` : ""}

    <h4 class="acct-row-head">Bare domain serves</h4>
    <p class="section-desc">Subdomains map to <code>&lt;app&gt;.${esc(d.domain)}</code> automatically. Pick which app the bare <code>${esc(d.domain)}</code> serves.</p>
    <select id="dom-apex" class="settings-input settings-input-md">${apexOptions(d.apexAppId)}</select>

    ${hostRows.length ? `<h4 class="acct-row-head" style="margin-top:16px;">App hostnames</h4>
    <table class="lib-table" style="font-size:12px;"><tbody>${hostRows.map(([h, s]) => `<tr><td><code>${esc(h)}</code></td><td class="lib-table-dim">${esc(s)}</td></tr>`).join("")}</tbody></table>` : ""}

    <div class="settings-actions" style="margin-top:18px;"><button id="dom-remove" class="action-btn danger" type="button">Remove domain</button></div>`;

  for (const b of Array.from(body.querySelectorAll<HTMLButtonElement>(".od-copy"))) {
    b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy || ""); b.innerHTML = CHECK_SVG; setTimeout(() => { b.innerHTML = COPY_SVG; }, 1500); } catch { /* denied */ }
    });
  }

  const vb = $<HTMLButtonElement>("dom-verify");
  vb?.addEventListener("click", async () => {
    editError(""); vb.disabled = true; vb.style.color = "#fff";
    let last = "Couldn't verify the domain.";
    for (let a = 1; a <= 6; a++) {
      vb.innerHTML = `${SPIN_SVG} Verifying…${a > 1 ? ` (${a}/6)` : ""}`;
      const r = await accountApi().verifyOrgDomain(d.id);
      if (r.ok) { await loadDomainsPanel(); const fresh = domains.find((x) => x.id === d.id); if (fresh) openEditor(fresh); return; }
      last = r.error;
      if (a < 6) await new Promise((res) => setTimeout(res, 10_000));
    }
    vb.disabled = false; vb.style.color = ""; vb.textContent = "Verify"; editError(last);
  });

  $<HTMLSelectElement>("dom-apex")?.addEventListener("change", async (e) => {
    editError("");
    const r = await accountApi().setOrgDomainApexApp(d.id, (e.target as HTMLSelectElement).value || null);
    if (!r.ok) { editError(r.error); return; }
    await loadDomainsPanel();
    const fresh = domains.find((x) => x.id === d.id); if (fresh) openEditor(fresh);
  });

  $("dom-remove")?.addEventListener("click", () => { void removeDomain(d, true); });
}

async function removeDomain(d: OrgDomain, fromEditor = false): Promise<void> {
  const ok = await confirmAction({ title: `Remove ${d.domain}?`, body: "Its app hostnames stop resolving immediately.", confirmLabel: "Remove", danger: true });
  if (!ok) return;
  const r = await accountApi().removeOrgDomain(d.id);
  if (!r.ok) { (fromEditor ? editError : setError)(r.error); return; }
  if (fromEditor) showEditor(false);
  await loadDomainsPanel();
}

// ── wiring ───────────────────────────────────────────────────────────────────
let wired = false;
export function initDomainsPanel(): void {
  if (wired) return;
  wired = true;
  $("dom-search")?.addEventListener("input", () => { page = 0; paintList(); });
  $("dom-back")?.addEventListener("click", (e) => { e.preventDefault(); showEditor(false); });
  const add = async (): Promise<void> => {
    const input = $<HTMLInputElement>("dom-input");
    const domain = (input?.value || "").trim().toLowerCase();
    if (!domain) { setError("Enter a domain like acme.com."); return; }
    setError(""); setStatus("Adding…");
    const r = await accountApi().addOrgDomain(domain);
    setStatus(r.ok ? "Added" : "Not added", r.ok ? "success" : "error");
    if (!r.ok) { setError(r.error); return; }
    if (input) input.value = "";
    await loadDomainsPanel();
    if (r.data) openEditor(r.data);
  };
  $("dom-add")?.addEventListener("click", () => { void add(); });
  $<HTMLInputElement>("dom-input")?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void add(); });
}

/** Admin gate — mirrors Roles' showPanel. */
function showPanel(on: boolean): void {
  $("dom-admin-only")?.classList.toggle("hidden", on);
  $("dom-body")?.classList.toggle("hidden", !on);
  document.querySelector<HTMLElement>('.settings-nav .settings-nav-item[data-sub="domains"]')
    ?.classList.toggle("hidden", !on);
}

export async function loadDomainsPanel(): Promise<void> {
  initDomainsPanel();
  setError("");
  const account = await window.glyphh.getAccountInfo().catch(() => null);
  const role = account?.role || "";
  if (!role || !["org_admin", "super_admin"].includes(role)) { showPanel(false); return; }
  showPanel(true);
  try { apps = await accountApi().orgApps(); } catch { apps = []; }
  try { domains = await accountApi().orgDomains(); paintList(); }
  catch (e) { setError(`Couldn't load domains — ${(e as Error).message}`); }
}
