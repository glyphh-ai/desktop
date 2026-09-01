/**
 * settings-list-page.ts — the ONE canonical CRUD list page for the Security
 * settings group (his spec, 2026-09-01: Members / Roles / Domains / Marketplace
 * all identical; Models is the sole exception). Every such page renders through
 * mountListPage, so they cannot drift:
 *
 *   Title
 *   Description
 *   [ full-width search .................... ]  [ + New <object> ]   ← toolbar
 *   ┌ table header ─────────────────────────────────────────── ⋮ ┐
 *   │ rows … right-aligned vertical kebab (Edit · Delete)         │
 *   crud-empty + pagination
 *
 *   + New  → a VALIDATED modal (formModal) with per-field input validation.
 *   Edit   → the list swaps to a crud-inline-form: “← <object>” breadcrumb,
 *            then the page's own standard form (renderEdit).
 *
 * Pages supply only their columns, form fields, and CRUD calls (all SDK-backed).
 */

import { paginate, renderPaginationBar, confirmAction, guardWebviewsForModal } from "./shared.js";
import { kebabCell, ROW_MENU_ICONS } from "./lib-editor.js";

const esc = (v: unknown): string =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── validated form modal (the + New dialog, and reusable elsewhere) ───────────
export interface FormField {
  key: string;
  label: string;
  type?: "text" | "email" | "select";
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  /** Return an error string to block submit, or null when valid. */
  validate?: (value: string, values: Record<string, string>) => string | null;
}

export interface FormModalConfig {
  title: string;
  fields: FormField[];
  submitLabel?: string;
  /** Persist. Return {ok:false,error} to show a form-level error and keep it open. */
  onSubmit: (values: Record<string, string>) => Promise<{ ok: true } | { ok: false; error: string }>;
}

/** A modal form with inline per-field validation. Resolves true if it saved. */
export function formModal(cfg: FormModalConfig): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-box" role="dialog" aria-modal="true">
        <div class="confirm-head"><h3>${esc(cfg.title)}</h3></div>
        <div class="confirm-body">
          <form class="fm-form">
            ${cfg.fields.map((f) => `
              <div class="acct-field acct-field-wide fm-field" data-k="${esc(f.key)}">
                <label class="settings-label" for="fm-${esc(f.key)}">${esc(f.label)}</label>
                ${f.type === "select"
                  ? `<select id="fm-${esc(f.key)}" class="settings-input">${(f.options || []).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}</select>`
                  : `<input id="fm-${esc(f.key)}" type="${f.type === "email" ? "email" : "text"}" class="settings-input" placeholder="${esc(f.placeholder || "")}" autocomplete="off" spellcheck="false" />`}
                <span class="settings-error hidden fm-err"></span>
              </div>`).join("")}
            <div class="settings-error hidden fm-form-err" style="margin-top:6px;"></div>
          </form>
        </div>
        <div class="confirm-foot">
          <button class="action-btn secondary fm-cancel" type="button">Cancel</button>
          <button class="action-btn primary fm-save" type="button">${esc(cfg.submitLabel || "Create")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    guardWebviewsForModal(true);

    const first = overlay.querySelector<HTMLInputElement | HTMLSelectElement>(".fm-form input, .fm-form select");
    first?.focus();
    const formErr = overlay.querySelector<HTMLElement>(".fm-form-err")!;
    const fieldEl = (k: string) => overlay.querySelector<HTMLInputElement | HTMLSelectElement>(`#fm-${CSS.escape(k)}`);
    const errEl = (k: string) => overlay.querySelector<HTMLElement>(`.fm-field[data-k="${CSS.escape(k)}"] .fm-err`);

    function values(): Record<string, string> {
      const v: Record<string, string> = {};
      for (const f of cfg.fields) v[f.key] = (fieldEl(f.key)?.value ?? "").trim();
      return v;
    }
    function showFieldErr(k: string, msg: string | null): void {
      const e = errEl(k); const el = fieldEl(k);
      if (e) { e.textContent = msg || ""; e.classList.toggle("hidden", !msg); }
      el?.classList.toggle("invalid", !!msg);
    }
    function validate(): boolean {
      const vals = values();
      let ok = true;
      for (const f of cfg.fields) {
        let msg: string | null = null;
        if (f.required && !vals[f.key]) msg = `${f.label} is required.`;
        else if (f.validate) msg = f.validate(vals[f.key]!, vals);
        showFieldErr(f.key, msg);
        if (msg) ok = false;
      }
      return ok;
    }
    // Clear a field's error as the user fixes it.
    for (const f of cfg.fields) fieldEl(f.key)?.addEventListener("input", () => showFieldErr(f.key, null));

    const saveBtn = overlay.querySelector<HTMLButtonElement>(".fm-save")!;
    function cleanup(result: boolean) {
      overlay.remove();
      guardWebviewsForModal(false);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    async function save() {
      formErr.classList.add("hidden");
      if (!validate()) return;
      saveBtn.disabled = true; const prev = saveBtn.textContent; saveBtn.textContent = "Saving…";
      const r = await cfg.onSubmit(values());
      if (r.ok) { cleanup(true); return; }
      saveBtn.disabled = false; saveBtn.textContent = prev;
      formErr.textContent = r.error; formErr.classList.remove("hidden");
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
      else if (e.key === "Enter" && (e.target as HTMLElement)?.tagName !== "TEXTAREA") { e.preventDefault(); void save(); }
    }
    overlay.querySelector<HTMLButtonElement>(".fm-cancel")!.addEventListener("click", () => cleanup(false));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) cleanup(false); });
    saveBtn.addEventListener("click", () => void save());
    document.addEventListener("keydown", onKey);
  });
}

// ── the list page scaffold ───────────────────────────────────────────────────
export interface ListColumn<R> { header: string; cell: (row: R) => string; dim?: boolean }

export interface ListPageConfig<R> {
  /** The settings-panel host element id (the page mounts its whole body here). */
  rootId: string;
  objectName: string;                 // "domain" → "+ New domain", "← Domains"
  objectPlural: string;               // "Domains"
  title: string;
  description: string;
  columns: ListColumn<R>[];
  rowId: (row: R) => string;
  searchText: (row: R) => string;
  load: () => Promise<R[]>;
  /** The + New modal's fields + create call. */
  newFields: FormField[];
  /** Create the object. Return the created row so the page can open its editor
   *  immediately (his spec: adding lands on the detail page with the records). */
  create: (values: Record<string, string>) => Promise<{ ok: true; row?: R } | { ok: false; error: string }>;
  /** Render the object's standard edit form into `body`; call ctx.reload/back. */
  editTitle: (row: R) => string;
  renderEdit: (row: R, body: HTMLElement, ctx: EditCtx) => void;
  remove: (row: R) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Extra confirm body for delete. */
  deleteBody?: (row: R) => string;
}

export interface EditCtx { reload: () => Promise<void>; back: () => void; error: (msg: string) => void }

export interface ListPageHandle { reload: () => Promise<void> }

export function mountListPage<R>(cfg: ListPageConfig<R>): ListPageHandle {
  const root = document.getElementById(cfg.rootId);
  if (!root) return { reload: async () => {} };
  const id = (s: string) => `${cfg.rootId}-${s}`;
  root.innerHTML = `
    <div id="${id("list")}">
      <h2>${esc(cfg.title)} <span id="${id("status")}" class="set-save-state"></span></h2>
      <p class="section-desc">${cfg.description}</p>
      <div class="crud-toolbar">
        <div class="search-clear-wrap"><input id="${id("search")}" type="text" class="crud-search" placeholder="Search ${esc(cfg.objectPlural.toLowerCase())}…" spellcheck="false" autocomplete="off" /></div>
        <button id="${id("new")}" class="action-btn primary" type="button">+ New ${esc(cfg.objectName)}</button>
      </div>
      <div id="${id("error")}" class="settings-error hidden"></div>
      <div id="${id("rows")}"></div>
    </div>
    <div id="${id("edit")}" class="crud-inline-form hidden">
      <div class="crud-inline-header"><a class="crud-breadcrumb-back" id="${id("back")}">&larr; ${esc(cfg.objectPlural)}</a><div class="crud-spacer"></div></div>
      <div class="acct-section">
        <h2 id="${id("edit-title")}" style="margin:0 0 12px;"></h2>
        <div id="${id("edit-err")}" class="settings-error hidden"></div>
        <div id="${id("edit-body")}"></div>
      </div>
    </div>`;

  const el = (s: string) => document.getElementById(id(s));
  let rows: R[] = [];
  let page = 0;

  const setError = (m: string) => { const e = el("error"); if (e) { e.textContent = m; e.classList.toggle("hidden", !m); } };
  const editError = (m: string) => { const e = el("edit-err"); if (e) { e.textContent = m; e.classList.toggle("hidden", !m); } };
  const showEdit = (on: boolean) => { el("list")?.classList.toggle("hidden", on); el("edit")?.classList.toggle("hidden", !on); };

  function openEditor(row: R): void {
    editError("");
    const t = el("edit-title"); if (t) t.textContent = cfg.editTitle(row);
    const body = el("edit-body"); if (!body) return;
    body.innerHTML = "";
    showEdit(true);
    cfg.renderEdit(row, body, { reload, back: () => showEdit(false), error: editError });
  }

  function paint(): void {
    const host = el("rows"); if (!host) return;
    const q = (el("search") as HTMLInputElement | null)?.value.trim().toLowerCase() || "";
    const filtered = rows.filter((r) => !q || cfg.searchText(r).toLowerCase().includes(q));
    host.innerHTML = "";
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "crud-empty";
      empty.textContent = q ? `No ${cfg.objectPlural.toLowerCase()} match your search.` : `No ${cfg.objectPlural.toLowerCase()} yet — create one.`;
      host.appendChild(empty);
      return;
    }
    const { items, state } = paginate(filtered, page);
    page = state.page;
    const table = document.createElement("table");
    table.className = "lib-table";
    table.innerHTML = `<thead><tr>${cfg.columns.map((c) => `<th>${esc(c.header)}</th>`).join("")}<th class="lib-row-kebab-cell"></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const r of items) {
      const tr = document.createElement("tr");
      tr.innerHTML = cfg.columns.map((c, i) => `<td class="${i === 0 ? "lib-table-name" : c.dim ? "lib-table-dim" : "lib-table-desc"}">${c.cell(r)}</td>`).join("");
      tr.addEventListener("click", () => openEditor(r));
      tr.appendChild(kebabCell(() => [
        { icon: ROW_MENU_ICONS.edit, label: "Edit", onClick: () => openEditor(r) },
        { icon: ROW_MENU_ICONS.delete, label: "Delete", danger: true, onClick: () => { void del(r); } },
      ]));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    host.appendChild(table);
    if (state.totalPages > 1) host.appendChild(renderPaginationBar(state, (p) => { page = p; paint(); }));
  }

  async function del(row: R): Promise<void> {
    const ok = await confirmAction({ title: `Delete this ${cfg.objectName}?`, body: cfg.deleteBody?.(row) || "", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    const r = await cfg.remove(row);
    if (!r.ok) { setError(r.error); return; }
    showEdit(false);
    await reload();
  }

  async function reload(): Promise<void> {
    setError("");
    try { rows = await cfg.load(); paint(); }
    catch (e) { setError(`Couldn't load ${cfg.objectPlural.toLowerCase()} — ${(e as Error).message}`); }
  }

  el("search")?.addEventListener("input", () => { page = 0; paint(); });
  el("back")?.addEventListener("click", (e) => { e.preventDefault(); showEdit(false); });
  el("new")?.addEventListener("click", () => {
    let created: R | null = null;
    void formModal({
      title: `New ${cfg.objectName}`,
      fields: cfg.newFields,
      submitLabel: "Create",
      onSubmit: async (values) => {
        const r = await cfg.create(values);
        if (r.ok) { created = r.row ?? null; return { ok: true }; }
        return r;
      },
    }).then(async (saved) => {
      if (!saved) return;
      await reload();
      // Land on the new object's detail page so its records/status are right there.
      if (created) openEditor(created);
    });
  });

  return { reload };
}
