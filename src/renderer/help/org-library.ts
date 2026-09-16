/**
 * org-library.ts — Org › Library (platform, org_admin): the ONE curated list.
 *
 * His spec, 2026-09-12: a SINGLE TABLE — Name, Description (truncated), Type
 * (pill), Author, Version, Installs — search on top like every list page,
 * paginated, with the enable/disable toggle far right and a kebab holding:
 *   Access  → modal restricting the item to MANY roles
 *   Metrics → the item's usage (light for now: installs + version history —
 *             token/invocation lanes arrive with per-item run attribution)
 *   Delete  → standard confirm; DESTRUCTIVE — leaves the library AND every
 *             member's installs
 * The review queue (pending promotions) sits above the table. Apps are not
 * here — they originate locally and keep their own release lane.
 *
 * Transport: the raw SDK handle on web (platform), IPC envelope fallback on
 * desktop — the same seam as gateway-keys.
 */

import { escapeHtml, paginate, renderPaginationBar, confirmAction } from "./shared.js";
import { kebabCell, ROW_MENU_ICONS } from "./lib-editor.js";
import { gateSurface } from "./plan-gate.js";
import { openProviderDropdown } from "./models-admin.js";
import { hidePanelsForModal, restorePanelsForModal } from "../yo-modal.js";

type Kind = "task" | "agent" | "skill";
const KIND_LABEL: Record<Kind, string> = { task: "Task", agent: "Agent", skill: "Skill" };

interface Item {
  id: string; kind: Kind; slug: string; name: string; description: string;
  restricted: boolean; enabled: boolean; installs: number;
  grantedWorkspaceIds: string[];
  headVersion: number | null; pendingVersion: number | null;
  installed: boolean; createdBy: string | null; updatedAt: string;
}
interface Pending {
  id: string; kind: Kind; entity_id: string; version: number;
  notes: string; slug: string; name: string; created_at: string;
}
interface RoleRow { id: string; name: string }
interface MemberRow { userId: string; email: string; name: string | null }
interface Metrics {
  installs: number;
  versions: Array<{ version: number; status: string; created_at: string; decided_at: string | null }>;
}

interface SdkOrgLibrary {
  orgLibrary?: {
    list(kind: Kind): Promise<Item[]>;
    queue(): Promise<Pending[]>;
    decide(id: string, approve: boolean): Promise<unknown>;
    setAccess(kind: Kind, id: string, restricted: boolean, workspaceIds: string[]): Promise<void>;
    setEnabled(kind: Kind, id: string, enabled: boolean): Promise<void>;
    remove(kind: Kind, id: string): Promise<void>;
    metrics(kind: Kind, id: string): Promise<Metrics>;
  };
  workspaces?: { list(): Promise<RoleRow[]> };
  members?: { list(): Promise<MemberRow[]> };
}
const sdk = (): SdkOrgLibrary | null =>
  (window as unknown as { glyphhSdk?: SdkOrgLibrary }).glyphhSdk ?? null;

type IpcEnvelope = { ok: boolean; data?: unknown; error?: string };
const ipc = (): Record<string, ((...a: unknown[]) => Promise<IpcEnvelope>) | undefined> =>
  (window as unknown as { glyphh?: Record<string, ((...a: unknown[]) => Promise<IpcEnvelope>) | undefined> }).glyphh ?? {};

async function via<T>(web: (s: SdkOrgLibrary) => Promise<T> | undefined, method: string, ...args: unknown[]): Promise<T | null> {
  const handle = sdk();
  if (handle) {
    try {
      const p = web(handle);
      if (p) return (await p) ?? null;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  const fn = ipc()[method];
  if (!fn) throw new Error(`${method} is unavailable on this surface.`);
  const res = await fn(...args);
  if (!res || typeof res.ok !== "boolean") throw new Error(`${method} is unavailable on this surface.`);
  if (!res.ok) throw new Error(res.error || `${method} failed`);
  return (res.data as T) ?? null;
}

const $ = (id: string): HTMLElement | null => document.getElementById(id);

function setError(msg: string): void {
  const el = $("orglib-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

let all: Item[] = [];
let roles: RoleRow[] = [];
let authors = new Map<string, string>();
let page = 0;
/** "" = every type — the funnel beside the search, same as Roles → Models. */
let kindFilter = "";
let wired = false;

/** The license gate. Called after EVERY paint, not just on load — the table
 *  and queue inject their controls asynchronously, and a control born after
 *  the gate ran would be born enabled (his report, 2026-09-12: "still
 *  editable"). gateSurface is idempotent and the plan read is memoised, so
 *  re-gating per paint costs nothing. Server E_ENTITLEMENT holds regardless. */
function applyGate(): void {
  void gateSurface(document.querySelector<HTMLElement>('.settings-panel[data-sub="org-library"]'),
    "governance", "The org library");
}

export function loadOrgLibrary(): void {
  applyGate();
  // The same admin door every org page opens with.
  void (async () => {
    const account = await (window as unknown as { glyphh: { getAccountInfo(): Promise<{ role?: string } | null> } })
      .glyphh.getAccountInfo().catch(() => null);
    const admin = !!account?.role && ["org_admin", "admin", "super_admin"].includes(account.role);
    $("orglib-admin-only")?.classList.toggle("hidden", admin);
    $("orglib-body")?.classList.toggle("hidden", !admin);
  })();
  if (!wired) {
    wired = true;
    $("orglib-search")?.addEventListener("input", () => { page = 0; renderTable(); applyGate(); });
    $("orglib-filter")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openProviderDropdown(e.currentTarget as HTMLElement,
        (["task", "agent", "skill"] as Kind[]).map((k) => ({ slug: k, name: KIND_LABEL[k] })),
        kindFilter,
        (slug, name) => {
          kindFilter = slug;
          const label = $("orglib-filter-label");
          if (label) { label.textContent = slug ? name : ""; label.classList.toggle("hidden", !slug); }
          page = 0;
          renderTable();
          applyGate();
        });
    });
  }
  setError("");
  void (async () => {
    try {
      const [rolesR, membersR] = await Promise.all([
        via<RoleRow[]>((s) => s.workspaces?.list(), "workspacesList").catch(() => []),
        via<MemberRow[]>((s) => s.members?.list(), "membersList").catch(() => []),
      ]);
      roles = rolesR ?? [];
      authors = new Map((membersR ?? []).map((m) => [m.userId, m.name || m.email]));
      await Promise.all([paintQueue(), reload()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  })();
}

/** One read across the three kinds — the table is ONE list with type pills. */
async function reload(): Promise<void> {
  const kinds: Kind[] = ["task", "agent", "skill"];
  const lists = await Promise.all(kinds.map((k) =>
    via<Item[]>((s) => s.orgLibrary?.list(k), "orgLibraryList", k).catch(() => []),
  ));
  all = lists.flatMap((l) => l ?? []).sort((a, b) => a.name.localeCompare(b.name));
  renderTable();
  applyGate();
}

// ── The review desk ─────────────────────────────────────────────────────────
async function paintQueue(): Promise<void> {
  const host = $("orglib-queue");
  if (!host) return;
  const pending = (await via<Pending[]>((s) => s.orgLibrary?.queue(), "orgLibraryQueue")) ?? [];
  if (!pending.length) { host.innerHTML = ""; host.classList.add("hidden"); return; }
  host.classList.remove("hidden");
  host.innerHTML = `<h3 class="settings-subheading">Awaiting review</h3>` + pending.map((p) => `
    <div class="crud-row" data-vid="${p.id}">
      <div class="crud-cell" style="flex:1;">
        <b>${escapeHtml(p.name)}</b> <span class="orglib-pill">${escapeHtml(KIND_LABEL[p.kind] ?? p.kind)}</span> <span class="mdl-hint">v${p.version}</span>
        ${p.notes ? `<div class="mdl-hint">${escapeHtml(p.notes)}</div>` : ""}
      </div>
      <button class="action-btn primary" data-approve type="button">Approve</button>
      <button class="action-btn" data-reject type="button">Reject</button>
    </div>`).join("");
  host.querySelectorAll<HTMLElement>(".crud-row").forEach((row) => {
    const vid = row.dataset.vid!;
    row.querySelector("[data-approve]")?.addEventListener("click", () => void decide(vid, true));
    row.querySelector("[data-reject]")?.addEventListener("click", () => void decide(vid, false));
  });
  applyGate();
}

async function decide(versionId: string, approve: boolean): Promise<void> {
  try {
    if (!approve && !(await confirmAction({
      title: "Reject this version?",
      body: "The member keeps their local copy — nothing is deleted.",
      confirmLabel: "Reject",
    }))) return;
    await via((s) => s.orgLibrary?.decide(versionId, approve), "orgLibraryDecide", versionId, approve);
    await Promise.all([paintQueue(), reload()]);
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
}

// ── The table ───────────────────────────────────────────────────────────────
function renderTable(): void {
  const host = $("orglib-list");
  if (!host) return;
  const q = (($("orglib-search") as HTMLInputElement | null)?.value || "").trim().toLowerCase();
  const typed = kindFilter ? all.filter((i) => i.kind === kindFilter) : all;
  const filtered = q
    ? typed.filter((i) => i.name.toLowerCase().includes(q) || i.slug.toLowerCase().includes(q)
        || i.description.toLowerCase().includes(q))
    : typed;

  host.textContent = "";
  if (!filtered.length) {
    host.innerHTML = q
      ? `<div class="crud-empty">Nothing matching "${escapeHtml(q)}"</div>`
      : `<div class="crud-empty">The library is empty — members promote their builds from the app.</div>`;
    return;
  }

  const { items, state } = paginate(filtered, page);
  page = state.page;

  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Name</th><th>Description</th><th>Type</th><th>Author</th><th>Version</th><th>Installs</th><th class="ws-model-toggle-cell">Enabled</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");

  for (const it of items) {
    const tr = document.createElement("tr");
    const author = it.createdBy ? (authors.get(it.createdBy) ?? "—") : "—";
    tr.innerHTML = `
      <td class="lib-table-name">${escapeHtml(it.name)}</td>
      <td class="lib-table-desc orglib-desc" title="${escapeHtml(it.description)}">${escapeHtml(it.description) || "—"}</td>
      <td class="lib-table-dim"><span class="orglib-pill orglib-pill-${it.kind}">${KIND_LABEL[it.kind]}</span></td>
      <td class="lib-table-dim">${escapeHtml(author)}</td>
      <td class="lib-table-dim">${it.headVersion ? `v${it.headVersion}` : "—"}${it.pendingVersion ? ` (v${it.pendingVersion} pending)` : ""}</td>
      <td class="lib-table-dim">${it.installs}</td>`;

    // Enabled — the far-right toggle, committing live.
    const toggleTd = document.createElement("td");
    toggleTd.className = "ws-model-toggle-cell";
    const toggle = document.createElement("label");
    toggle.className = "settings-toggle ws-model-allow";
    toggle.innerHTML = `<input type="checkbox" ${it.enabled ? "checked" : ""} /><span class="toggle-switch"></span>`;
    toggle.querySelector("input")!.addEventListener("change", (ev) => {
      const on = (ev.target as HTMLInputElement).checked;
      void via((s) => s.orgLibrary?.setEnabled(it.kind, it.id, on), "orgLibrarySetEnabled", it.kind, it.id, on)
        .then(() => { it.enabled = on; })
        .catch((e) => { (ev.target as HTMLInputElement).checked = !on; setError(e instanceof Error ? e.message : String(e)); });
    });
    toggleTd.appendChild(toggle);
    tr.appendChild(toggleTd);

    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.edit, label: "Access", onClick: () => void openAccessModal(it) },
      { icon: ROW_MENU_ICONS.edit, label: "Metrics", onClick: () => void openMetricsModal(it) },
      { icon: ROW_MENU_ICONS.delete, label: "Delete", danger: true, onClick: () => void deleteItem(it) },
    ]));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
  if (state.totalPages > 1) host.appendChild(renderPaginationBar(state, (p) => { page = p; renderTable(); applyGate(); }));
}

// ── Access — restrict to MANY roles. The STANDARD modal chrome (confirm-head/
// body/actions + the webview-hiding dance), roles as a lib-table with Allowed
// toggles — the exact grammar of Roles → Models. ────────────────────────────
async function openAccessModal(it: Item): Promise<void> {
  const body = document.createElement("div");

  const limit = document.createElement("label");
  limit.className = "settings-toggle";
  limit.innerHTML = `<input type="checkbox" data-restricted ${it.restricted ? "checked" : ""} />
    <span class="toggle-switch"></span>
    <div class="toggle-info"><span class="toggle-title">Limit to selected roles</span>
    <span class="toggle-desc">Off = every member sees it. Binds on governance plans.</span></div>`;
  body.appendChild(limit);

  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Role</th><th class="ws-model-toggle-cell">Allowed</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const r of roles) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="lib-table-name"></td>
      <td class="ws-model-toggle-cell"><label class="settings-toggle ws-model-allow"><input type="checkbox" data-ws="${r.id}" ${it.grantedWorkspaceIds.includes(r.id) ? "checked" : ""} /><span class="toggle-switch"></span></label></td>`;
    (tr.querySelector(".lib-table-name") as HTMLElement).textContent = r.name;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  if (roles.length) body.appendChild(table);
  else body.insertAdjacentHTML("beforeend", `<div class="crud-empty">No roles defined yet.</div>`);

  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.innerHTML = `<div class="confirm-box" role="dialog" aria-modal="true">
      <div class="confirm-head"><h3></h3></div>
      <div class="confirm-body"></div>
      <div class="confirm-actions">
        <button type="button" class="action-btn" data-cancel>Cancel</button>
        <button type="button" class="action-btn primary" data-save>Save</button>
      </div>
    </div>`;
  (overlay.querySelector("h3") as HTMLElement).textContent = `Access — ${it.name}`;
  overlay.querySelector(".confirm-body")!.appendChild(body);
  const hidden = await hidePanelsForModal();
  const close = (): void => { overlay.remove(); restorePanelsForModal(hidden); };
  overlay.querySelector("[data-cancel]")!.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", function esc(e) {
    if (e.key !== "Escape") return;
    document.removeEventListener("keydown", esc);
    close();
  });
  overlay.querySelector("[data-save]")!.addEventListener("click", () => {
    const restricted = (overlay.querySelector("[data-restricted]") as HTMLInputElement).checked;
    const ws = Array.from(overlay.querySelectorAll<HTMLInputElement>("[data-ws]"))
      .filter((c) => c.checked).map((c) => c.dataset.ws!);
    void (async () => {
      try {
        await via((s) => s.orgLibrary?.setAccess(it.kind, it.id, restricted, ws), "orgLibrarySetAccess", it.kind, it.id, restricted, ws);
        close();
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  });
  document.body.appendChild(overlay);
}

// ── Metrics — light for now, honest about what is real ──────────────────────
async function openMetricsModal(it: Item): Promise<void> {
  let m: Metrics | null = null;
  try {
    m = await via<Metrics>((s) => s.orgLibrary?.metrics(it.kind, it.id), "orgLibraryMetrics", it.kind, it.id);
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    return;
  }
  const versions = (m?.versions ?? []).map((v) =>
    `<tr><td class="lib-table-name">v${v.version}</td><td class="lib-table-dim">${escapeHtml(v.status)}</td><td class="lib-table-dim">${new Date(v.created_at).toLocaleDateString()}</td></tr>`).join("");
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.innerHTML = `<div class="confirm-box" role="dialog" aria-modal="true">
      <div class="confirm-head"><h3></h3></div>
      <div class="confirm-body">
        <p class="section-desc"><b>${m?.installs ?? 0}</b> installs</p>
        <table class="lib-table"><thead><tr><th>Version</th><th>Status</th><th>Submitted</th></tr></thead><tbody>${versions}</tbody></table>
        <p class="mdl-hint">Token usage, invocations and models-per-request land here once runs carry the item's identity.</p>
      </div>
      <div class="confirm-actions"><button type="button" class="action-btn" data-close>Close</button></div>
    </div>`;
  (overlay.querySelector("h3") as HTMLElement).textContent = `Metrics — ${it.name}`;
  const hidden = await hidePanelsForModal();
  const close = (): void => { overlay.remove(); restorePanelsForModal(hidden); };
  overlay.querySelector("[data-close]")!.addEventListener("click", close);
  overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) close(); });
  document.addEventListener("keydown", function esc(e) {
    if (e.key !== "Escape") return;
    document.removeEventListener("keydown", esc);
    close();
  });
  document.body.appendChild(overlay);
}

// ── Delete — destructive, the standard confirm ──────────────────────────────
async function deleteItem(it: Item): Promise<void> {
  const yes = await confirmAction({
    title: `Delete ${it.name}?`,
    body: `It leaves the library and is removed from every member's installs (${it.installs} today). Members keep nothing.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!yes) return;
  try {
    await via((s) => s.orgLibrary?.remove(it.kind, it.id), "orgLibraryRemove", it.kind, it.id);
    await reload();
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
}
