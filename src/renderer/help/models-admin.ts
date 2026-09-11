/**
 * Models (org admin) — ONE page. The list is the PROVIDERS list (searchable,
 * paginated); each provider row expands to the models inside it. Glyphh
 * providers proxy through the gateway (enable + BYOK; catalog models with
 * Supported toggles); your own providers are any OpenAI-spec endpoint, with
 * a + to add models under them. Add/edit runs in the app's modal skeleton
 * (yo-modal — never inline); deletes go through the app-standard confirm.
 * Deleting a provider deletes its models with it; sessions/threads are
 * untouched. Every write rides the SDK surface; the server enforces org_admin.
 */

import { renderPaginationBar, confirmAction } from "./shared.js";
import { yoConfirm, hidePanelsForModal, restorePanelsForModal } from "../yo-modal.js";
import { openRowMenu, ROW_MENU_ICONS } from "./lib-editor.js";

interface OrgModelRow {
  id: string;
  name: string;
  providerSlug: string;
  kind: string;
  inputCreditsPerMTok: number;
  outputCreditsPerMTok: number;
  supported: boolean;
  providerEnabled: boolean;
  /** False when the org's PLAN excludes this model (free-tier gate). */
  planAllowed?: boolean;
}

interface ProviderRow {
  slug: string;
  name: string;
  kind: string;
  enabledForOrg: boolean;
  hasByokKey: boolean;
  byokHint?: string | null;
}

interface CustomProviderRow {
  slug: string;
  name: string;
  base_url: string;
  has_key: boolean;
  key_hint: string | null;
  active: boolean;
  model_count: number;
}

interface CustomModelRow {
  id: string;
  name: string;
  base_url: string;
  provider_slug: string | null;
  model_name: string;
  context_window: number;
  max_output_tokens: number;
  has_key: boolean;
  active: boolean;
}

const PAGE_SIZE = 15;   // 15 everywhere — the one pagination size (his rule)

let models: OrgModelRow[] = [];
let providers: ProviderRow[] = [];
let customProviders: CustomProviderRow[] = [];
let custom: CustomModelRow[] = [];
let initialized = false;
let page = 0;
const expanded = new Set<string>();
/** Rows the user CLOSED while a search had auto-opened them — a search
 *  suggests, it never pins (his report, 2026-09-11). Cleared per query. */
const searchClosed = new Set<string>();

const el = (id: string) => document.getElementById(id);

function showError(msg: string): void {
  const b = el("models-admin-error");
  if (!b) return;
  b.textContent = msg;
  b.classList.toggle("hidden", !msg);
}

// ── the app's modal skeleton, as a FORM dialog ───────────────────────────────

interface ModalField {
  id: string;
  label: string;
  hint?: string;
  type?: "text" | "password" | "number" | "checkbox";
  value?: string;
  checked?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** A circle-x at the input's far right (shown when `visible`): clears the
   *  STORED value immediately. On success the input resets to `after`. */
  clear?: { visible: boolean; title: string; after: string; onClear: () => Promise<boolean> };
}

/** Open a yo-modal form. Resolves the field values on Save, null on cancel. */
function formModal(title: string, fields: ModalField[], saveText = "Save"): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    // Scope the stacking guard to OUR overlays — the settings surface itself
    // rides the yo-modal skeleton, and a bare ".yo-modal" sweep removes the
    // whole platform page (the black-screen bug).
    document.querySelectorAll(".yo-modal.mdl-form-overlay").forEach((n) => n.remove());
    // BrowserViews exist only in Electron; the web has nothing to freeze.
    const isWeb = !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
    let panelsWereHidden = false;
    if (!isWeb) void hidePanelsForModal().then((h) => { panelsWereHidden = h; });

    const overlay = document.createElement("div");
    overlay.className = "yo-modal mdl-form-overlay";
    const backdrop = document.createElement("div");
    backdrop.className = "yo-modal-backdrop";
    const panel = document.createElement("div");
    panel.className = "yo-modal-panel mdl-form-modal";

    const head = document.createElement("div");
    head.className = "yo-modal-title";
    head.textContent = title;
    panel.appendChild(head);

    const inputs = new Map<string, HTMLInputElement>();
    for (const f of fields) {
      if (f.type === "checkbox") {
        const lab = document.createElement("label");
        lab.className = "settings-label mdl-modal-check";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !!f.checked;
        lab.append(box, document.createTextNode(` ${f.label}`));
        inputs.set(f.id, box);
        panel.appendChild(lab);
        continue;
      }
      const lab = document.createElement("label");
      lab.className = "settings-label";
      lab.textContent = f.label;
      if (f.hint) {
        const hint = document.createElement("span");
        hint.className = "settings-hint";
        hint.textContent = ` ${f.hint}`;
        lab.appendChild(hint);
      }
      const inp = document.createElement("input");
      inp.type = f.type ?? "text";
      inp.className = "settings-input";
      inp.value = f.value ?? "";
      inp.placeholder = f.placeholder ?? "";
      inp.disabled = !!f.disabled;
      inp.spellcheck = false;
      inp.autocomplete = f.type === "password" ? "new-password" : "off";
      inputs.set(f.id, inp);
      if (f.clear) {
        const wrap = document.createElement("div");
        wrap.className = "mdl-input-clearwrap";
        const x = document.createElement("button");
        x.type = "button";
        x.className = "mdl-input-clear" + (f.clear.visible ? "" : " hidden");
        x.title = f.clear.title;
        x.setAttribute("aria-label", f.clear.title);
        x.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>`;
        const after = f.clear.after;
        const onClear = f.clear.onClear;
        x.addEventListener("click", () => {
          x.disabled = true;
          void onClear().then((okGo) => {
            x.disabled = false;
            if (!okGo) return;
            x.classList.add("hidden");
            inp.placeholder = after;
            inp.value = "";
          });
        });
        wrap.append(inp, x);
        panel.append(lab, wrap);
      } else {
        panel.append(lab, inp);
      }
    }

    const err = document.createElement("div");
    err.className = "crud-form-error hidden";
    panel.appendChild(err);

    const actions = document.createElement("div");
    actions.className = "settings-actions";
    actions.style.marginTop = "16px";
    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    const cancel = document.createElement("button");
    cancel.className = "action-btn";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.className = "action-btn primary";
    save.type = "button";
    save.textContent = saveText;
    actions.append(spacer, cancel, save);
    panel.appendChild(actions);

    const close = (result: Record<string, string> | null) => {
      overlay.remove();
      if (!isWeb) restorePanelsForModal(panelsWereHidden);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", () => close(null));
    cancel.addEventListener("click", () => close(null));
    save.addEventListener("click", () => {
      const out: Record<string, string> = {};
      for (const [id, inp] of inputs) out[id] = inp.type === "checkbox" ? (inp.checked ? "1" : "") : inp.value.trim();
      close(out);
    });

    overlay.append(backdrop, panel);
    document.body.appendChild(overlay);
    (panel.querySelector("input:not([disabled])") as HTMLInputElement | null)?.focus();
  });
}

// ── icons ────────────────────────────────────────────────────────────────────

export const MDL_SVG = {
  chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
};

export function icoBtn(svg: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mdl-ico-btn";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = svg;
  return b;
}

// ── provider forms (modals) ──────────────────────────────────────────────────

async function newCustomProviderModal(): Promise<void> {
  const v = await formModal("New custom provider", [
    { id: "name", label: "Name", placeholder: "Together AI" },
    { id: "slug", label: "Slug", placeholder: "together" },
    { id: "url", label: "Base URL", hint: "— OpenAI-compatible, speaks /chat/completions", placeholder: "https://api.together.xyz/v1" },
    { id: "key", label: "API key", hint: "— write-only", type: "password", placeholder: "sk-…" },
  ], "Add provider");
  if (!v) return;
  const slug = v.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!v.name || !slug || !v.url) { showError("A provider needs a name, slug, and base URL."); return; }
  const r = await window.glyphh.orgCustomProvidersSave({ slug, name: v.name, baseUrl: v.url, ...(v.key ? { key: v.key } : {}) });
  if (!r?.ok) { showError(r.error || "Save failed"); return; }
  showError("");
  expanded.add(`custom:${slug}`);
  void refresh();
}

/**
 * + New Provider (his order, 2026-09-11): ONE modal installs a vendor — a
 * searchable list of every catalog provider not yet installed, the API key
 * next to it, and that vendor's models as Supported toggles so the org picks
 * its set in the same breath. The page list then shows installed providers
 * only; the org returns here (or to the row's toggles) to adjust later.
 * Custom (own base URL) providers keep their form via the link at the foot.
 */
async function installProviderModal(): Promise<void> {
  document.querySelectorAll(".yo-modal.mdl-form-overlay").forEach((n) => n.remove());
  const isWeb = !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
  let panelsWereHidden = false;
  if (!isWeb) void hidePanelsForModal().then((h) => { panelsWereHidden = h; });

  const overlay = document.createElement("div");
  overlay.className = "yo-modal mdl-form-overlay";
  const backdrop = document.createElement("div");
  backdrop.className = "yo-modal-backdrop";
  const panel = document.createElement("div");
  panel.className = "yo-modal-panel mdl-form-modal mdl-install-modal";

  const head = document.createElement("div");
  head.className = "yo-modal-title";
  head.textContent = "New provider";
  panel.appendChild(head);

  const searchLab = document.createElement("label");
  searchLab.className = "settings-label";
  searchLab.textContent = "Provider";
  const search = document.createElement("input");
  search.type = "text";
  search.className = "settings-input";
  search.placeholder = "Search providers…";
  search.spellcheck = false;
  search.autocomplete = "off";
  const list = document.createElement("div");
  list.className = "mdl-install-list";
  panel.append(searchLab, search, list);

  // The key + models sections appear once a vendor is chosen.
  const keyLab = document.createElement("label");
  keyLab.className = "settings-label hidden";
  keyLab.innerHTML = `API key <span class="settings-hint">— pays the vendor directly; write-only</span>`;
  const key = document.createElement("input");
  key.type = "password";
  key.className = "settings-input hidden";
  key.placeholder = "sk-…";
  key.autocomplete = "new-password";
  key.spellcheck = false;
  const modelsLab = document.createElement("label");
  modelsLab.className = "settings-label hidden";
  modelsLab.innerHTML = `Models <span class="settings-hint">— toggle on the models to install; you can change these any time</span>`;
  const modelList = document.createElement("div");
  modelList.className = "mdl-install-models hidden";
  panel.append(keyLab, key, modelsLab, modelList);

  const err = document.createElement("div");
  err.className = "crud-form-error hidden";
  panel.appendChild(err);

  const actions = document.createElement("div");
  actions.className = "settings-actions";
  actions.style.marginTop = "16px";
  const customLink = document.createElement("a");
  customLink.href = "#";
  customLink.className = "settings-hint";
  customLink.textContent = "Custom provider (own base URL)…";
  const spacer = document.createElement("div");
  spacer.style.flex = "1";
  const cancel = document.createElement("button");
  cancel.className = "action-btn";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const install = document.createElement("button");
  install.className = "action-btn primary";
  install.type = "button";
  install.textContent = "Install";
  install.disabled = true;
  actions.append(customLink, spacer, cancel, install);
  panel.appendChild(actions);

  let selected: ProviderRow | null = null;
  const picks = new Set<string>();

  const paintModels = (): void => {
    modelList.textContent = "";
    if (!selected) return;
    const rows = models.filter((m) => m.kind === "proxied" && m.providerSlug === selected!.slug);
    if (!rows.length) {
      modelList.innerHTML = `<div class="crud-empty">No catalog models under this provider yet.</div>`;
      return;
    }
    for (const m of rows) {
      const line = document.createElement("div");
      line.className = "mdl-install-model";
      const n = document.createElement("div");
      n.className = "mdl-td-name";
      n.textContent = m.name;
      const lab = document.createElement("label");
      lab.className = "settings-toggle mdl-toggle";
      lab.title = "Install — roles can pick this model";
      lab.innerHTML = `<input type="checkbox" ${picks.has(m.id) ? "checked" : ""} /><span class="toggle-switch"></span>`;
      (lab.querySelector("input") as HTMLInputElement).addEventListener("change", (ev) => {
        if ((ev.target as HTMLInputElement).checked) picks.add(m.id); else picks.delete(m.id);
      });
      line.append(n, lab);
      modelList.appendChild(line);
    }
  };

  const paintList = (): void => {
    const q = search.value.trim().toLowerCase();
    list.textContent = "";
    const candidates = providers
      .filter((p) => !p.enabledForOrg)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!candidates.length) {
      list.innerHTML = `<div class="crud-empty">${q ? "No providers match." : "Every provider is already installed."}</div>`;
      return;
    }
    for (const p of candidates) {
      const row = document.createElement("div");
      row.className = "mdl-install-row" + (selected?.slug === p.slug ? " selected" : "");
      const n = document.createElement("div");
      n.className = "mdl-td-name";
      n.textContent = p.name;
      const sub = document.createElement("div");
      sub.className = "mdl-td-sub mono";
      sub.textContent = `${models.filter((m) => m.kind === "proxied" && m.providerSlug === p.slug).length} models`;
      row.append(n, sub);
      row.addEventListener("click", () => {
        selected = p;
        picks.clear();
        install.disabled = false;
        for (const elx of [keyLab, key, modelsLab, modelList]) elx.classList.remove("hidden");
        paintList();
        paintModels();
        key.focus();
      });
      list.appendChild(row);
    }
  };
  search.addEventListener("input", paintList);
  paintList();

  const close = (): void => {
    overlay.remove();
    if (!isWeb) restorePanelsForModal(panelsWereHidden);
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", close);
  cancel.addEventListener("click", close);
  customLink.addEventListener("click", (ev) => { ev.preventDefault(); close(); void newCustomProviderModal(); });

  install.addEventListener("click", () => {
    if (!selected) return;
    install.disabled = true;
    void (async () => {
      const slug = selected!.slug;
      const r = await window.glyphh.orgProviderEnable(slug, key.value.trim() || undefined);
      if (!r?.ok) {
        err.textContent = r?.error || "Install failed";
        err.classList.remove("hidden");
        install.disabled = false;
        return;
      }
      // Per-model installs — NEVER the bulk lane, which resets every other
      // provider's supported set to exactly the ids it is handed.
      const results = await Promise.all([...picks].map((id) => window.glyphh.orgModelsSetSupported(id, true)));
      const bad = results.find((x) => !x?.ok);
      if (bad) showError(bad.error || "Some models didn't install");
      else showError("");
      expanded.add(`gw:${slug}`);
      close();
      void refresh();
    })();
  });

  overlay.append(backdrop, panel);
  document.body.appendChild(overlay);
  search.focus();
}

async function editCustomProviderModal(p: CustomProviderRow): Promise<void> {
  let cleared = false;
  const v = await formModal(`Edit ${p.name}`, [
    { id: "name", label: "Name", value: p.name },
    { id: "slug", label: "Slug", value: p.slug, disabled: true },
    { id: "url", label: "Base URL", hint: "— OpenAI-compatible", value: p.base_url },
    {
      id: "key",
      label: "API key",
      hint: "— write-only",
      type: "password",
      placeholder: p.has_key ? (p.key_hint || "•••• (saved)") : "sk-…",
      clear: {
        visible: p.has_key,
        title: "Remove the saved key",
        after: "sk-…",
        onClear: async () => {
          const r = await window.glyphh.orgCustomProvidersSave({ slug: p.slug, name: p.name, baseUrl: p.base_url, clearKey: true });
          if (!r?.ok) { showError(r.error || "Remove failed"); return false; }
          cleared = true;
          return true;
        },
      },
    },
  ]);
  if (!v) { if (cleared) void refresh(); return; }
  if (!v.name || !v.url) { showError("A provider needs a name and base URL."); return; }
  const r = await window.glyphh.orgCustomProvidersSave({ slug: p.slug, name: v.name, baseUrl: v.url, ...(v.key ? { key: v.key } : {}) });
  if (!r?.ok) { showError(r.error || "Save failed"); return; }
  showError("");
  void refresh();
}

async function editGatewayProviderModal(p: ProviderRow): Promise<void> {
  let cleared = false;
  const v = await formModal(`Edit ${p.name}`, [
    {
      id: "key",
      label: "BYOK API key",
      hint: "— pays the vendor directly; write-only",
      type: "password",
      placeholder: p.hasByokKey ? (p.byokHint || "•••• (saved)") : `${p.name} API key`,
      clear: {
        visible: p.hasByokKey,
        title: "Remove the saved key",
        after: `${p.name} API key`,
        onClear: async () => {
          const r = await window.glyphh.orgProviderClearKey(p.slug);
          if (!r?.ok) { showError(r.error || "Remove failed"); return false; }
          cleared = true;
          return true;
        },
      },
    },
    { id: "enabled", label: "Enabled for this organization", type: "checkbox", checked: p.enabledForOrg },
  ]);
  if (!v) { if (cleared) void refresh(); return; }
  const r = v.enabled || v.key
    ? await window.glyphh.orgProviderEnable(p.slug, v.key || undefined)
    : await window.glyphh.orgProviderDisable(p.slug);
  if (!r?.ok) { showError(r.error || "Save failed"); return; }
  showError("");
  void refresh();
}

async function deleteProviderConfirm(p: CustomProviderRow): Promise<void> {
  const okGo = await yoConfirm({
    title: `Delete ${p.name}?`,
    message: p.model_count > 0
      ? `Its ${p.model_count} model${p.model_count === 1 ? " is" : "s are"} deleted with it. Sessions and threads are untouched.`
      : "Sessions and threads are untouched.",
    confirmText: "Delete",
    danger: true,
  });
  if (!okGo) return;
  const r = await window.glyphh.orgCustomProvidersDelete(p.slug);
  if (!r?.ok) { showError(r.error || "Delete failed"); return; }
  showError("");
  void refresh();
}

// ── model forms (modals) ─────────────────────────────────────────────────────

async function modelModal(providerSlug: string, m: CustomModelRow | null): Promise<void> {
  const v = await formModal(m ? `Edit ${m.name}` : "New model", [
    { id: "name", label: "Display name", value: m?.name ?? "", placeholder: "Llama 3 70B" },
    { id: "slug", label: "Slug", hint: "— id: custom::<slug>", value: m ? m.id.replace(/^custom::/, "") : "", placeholder: "my-llama", disabled: !!m },
    { id: "model", label: "Model name", hint: '— sent as "model"', value: m?.model_name ?? "", placeholder: "meta-llama/Llama-3-70b-chat-hf" },
    { id: "ctx", label: "Context window", type: "number", value: m ? String(m.context_window) : "", placeholder: "8192" },
    { id: "max", label: "Max output tokens", type: "number", value: m ? String(m.max_output_tokens) : "", placeholder: "4096" },
  ], m ? "Save" : "Add model");
  if (!v) return;
  const slug = v.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!v.name || !slug || !v.model) { showError("A model needs a name, slug, and model name."); return; }
  const r = await window.glyphh.orgCustomModelsSave({
    slug,
    name: v.name,
    providerSlug,
    modelName: v.model,
    contextWindow: Math.max(1, Number(v.ctx) || 8192),
    maxOutputTokens: Math.max(1, Number(v.max) || 4096),
  });
  if (!r?.ok) { showError(r.error || "Save failed"); return; }
  showError("");
  void refresh();
}

async function deleteModelConfirm(m: CustomModelRow): Promise<void> {
  const okGo = await yoConfirm({
    title: `Delete ${m.name}?`,
    message: "Sessions and threads are untouched.",
    confirmText: "Delete",
    danger: true,
  });
  if (!okGo) return;
  const r = await window.glyphh.orgCustomModelsDelete(m.id);
  if (!r?.ok) { showError(r.error || "Delete failed"); return; }
  showError("");
  void refresh();
}

// ── the providers list, models inside ────────────────────────────────────────

interface ListEntry {
  key: string;
  name: string;
  type: "Glyphh" | "Custom";
  sub: string;
  gateway?: ProviderRow;
  customProv?: CustomProviderRow;
  /** Search matched a MODEL inside — render the row open. */
  autoOpen?: boolean;
}

/** The provider dropdown's narrowing — "" = all. */
let providerFilter = "";

/** A searchable provider dropdown (search on top) — shared by the org
 *  Models page and the Roles model picker (his order, 2026-09-11). */
export function openProviderDropdown(
  anchor: HTMLElement,
  options: Array<{ slug: string; name: string }>,
  current: string,
  onPick: (slug: string, name: string) => void,
): void {
  document.querySelector(".mdl-provider-drop")?.remove();
  const menu = document.createElement("div");
  menu.className = "code-drop mdl-provider-drop";
  const search = document.createElement("input");
  search.type = "text";
  search.className = "loop-drop-search";
  search.placeholder = "Search providers…";
  search.spellcheck = false;
  search.autocomplete = "off";
  const listHost = document.createElement("div");
  listHost.className = "mdl-provider-drop-list";
  menu.append(search, listHost);
  const names = [{ slug: "", name: "All providers" }].concat(options);
  const paint = (): void => {
    const q = search.value.trim().toLowerCase();
    listHost.textContent = "";
    for (const n of names.filter((x) => !q || x.name.toLowerCase().includes(q) || x.slug.includes(q))) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "code-drop-item" + (n.slug === current ? " active" : "");
      row.textContent = n.name;
      row.addEventListener("click", () => { menu.remove(); onPick(n.slug, n.name); });
      listHost.appendChild(row);
    }
  };
  search.addEventListener("input", paint);
  paint();
  const r = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 280))}px`;
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.zIndex = "10000";
  document.body.appendChild(menu);
  const dismiss = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) { menu.remove(); document.removeEventListener("mousedown", dismiss, true); }
  };
  document.addEventListener("mousedown", dismiss, true);
  search.focus();
}

function openProviderFilter(anchor: HTMLElement): void {
  const options = providers.map((p) => ({ slug: p.slug, name: p.name }))
    .concat(customProviders.map((p) => ({ slug: p.slug, name: p.name })));
  openProviderDropdown(anchor, options, providerFilter, (slug, name) => {
    providerFilter = slug;
    // The funnel icon IS the "All providers" state (his order, 2026-09-11) —
    // the label only appears when a provider is actually narrowing the list.
    const label = el("models-provider-filter-label");
    if (label) {
      label.textContent = slug ? name : "";
      label.classList.toggle("hidden", !slug);
    }
    page = 0;
    renderList();
  });
}

function listEntries(): ListEntry[] {
  const q = ((el("models-search") as HTMLInputElement | null)?.value || "").trim().toLowerCase();
  // Installed vendors only (his order, 2026-09-11) — the whole catalog lives
  // in the + New Provider modal; the page is what the org actually runs.
  const gw: ListEntry[] = providers.filter((p) => p.enabledForOrg).map((p) => ({
    key: `gw:${p.slug}`,
    name: p.name,
    type: "Glyphh",
    sub: `${models.filter((m) => m.kind === "proxied" && m.providerSlug === p.slug).length} models`
      + (p.hasByokKey && p.byokHint ? ` · BYOK Key: ${p.byokHint}` : ""),
    gateway: p,
  }));
  const own: ListEntry[] = customProviders.map((p) => ({
    key: `custom:${p.slug}`,
    name: p.name,
    type: "Custom",
    sub: `${p.model_count} model${p.model_count === 1 ? "" : "s"} · ${p.base_url}`
      + (p.has_key && p.key_hint ? ` · Key: ${p.key_hint}` : ""),
    customProv: p,
  }));
  const scoped = providerFilter
    ? gw.concat(own).filter((e) => (e.gateway?.slug ?? e.customProv?.slug) === providerFilter)
    : gw.concat(own);
  const matchModels = (e: ListEntry): boolean => {
    if (e.gateway) return models.some((m) => m.kind === "proxied" && m.providerSlug === e.gateway!.slug && m.name.toLowerCase().includes(q));
    return custom.some((m) => m.provider_slug === e.customProv!.slug && m.name.toLowerCase().includes(q));
  };
  return scoped
    .map((e) => ({ ...e, autoOpen: !!q && matchModels(e) }))
    .filter((e) => !q || e.name.toLowerCase().includes(q) || e.type.toLowerCase().includes(q) || e.autoOpen)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function modelLine(name: string, sub: string, toggle: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean; disabledTitle?: string }, icons?: HTMLElement[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "mdl-model-line";
  const info = document.createElement("div");
  info.className = "mdl-model-info";
  const n = document.createElement("div");
  n.className = "mdl-td-name";
  n.textContent = name;
  const s = document.createElement("div");
  s.className = "mdl-td-sub mono";
  s.textContent = sub;
  info.append(n, s);
  row.appendChild(info);
  for (const ic of icons ?? []) row.appendChild(ic);
  const lab = document.createElement("label");
  lab.className = "settings-toggle mdl-toggle";
  lab.title = "Supported — roles can pick this model";
  lab.innerHTML = `<input type="checkbox" ${toggle.on ? "checked" : ""} ${toggle.disabled ? "disabled" : ""} /><span class="toggle-switch"></span>`;
  if (toggle.disabled && toggle.disabledTitle) lab.title = toggle.disabledTitle;
  const box = lab.querySelector("input") as HTMLInputElement;
  box.addEventListener("change", () => toggle.onChange(box.checked));
  row.appendChild(lab);
  return row;
}

function renderList(): void {
  const wrap = el("models-provider-list");
  if (!wrap) return;
  const all = listEntries();
  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  if (page >= totalPages) page = totalPages - 1;
  const slice = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  wrap.textContent = "";
  if (!slice.length) {
    wrap.innerHTML = `<div class="crud-empty">No providers match your search.</div>`;
  }
  for (const e of slice) {
    const row = document.createElement("div");
    row.className = "mdl-prov-row";
    const isOpen = expanded.has(e.key) || (!!e.autoOpen && !searchClosed.has(e.key));

    const head = document.createElement("div");
    head.className = "mdl-prov-head" + (isOpen ? " open" : "");
    const chev = document.createElement("span");
    chev.className = "mdl-prov-chevron";
    chev.innerHTML = MDL_SVG.chevron;
    const info = document.createElement("div");
    info.className = "mdl-prov-info";
    const name = document.createElement("div");
    name.className = "mdl-td-name";
    name.textContent = e.name;
    const typeChip = document.createElement("span");
    typeChip.className = "mdl-type-chip" + (e.type === "Glyphh" ? " glyphh" : "");
    typeChip.textContent = e.type;
    name.appendChild(typeChip);
    const sub = document.createElement("div");
    sub.className = "mdl-td-sub";
    sub.textContent = e.sub;
    info.append(name, sub);
    head.append(chev, info);

    if (e.customProv) {
      const add = icoBtn(MDL_SVG.plus, "Add a model");
      add.addEventListener("click", (ev) => { ev.stopPropagation(); void modelModal(e.customProv!.slug, null); });
      head.appendChild(add);
    }
    if (e.gateway) {
      const p = e.gateway;
      const lab = document.createElement("label");
      lab.className = "settings-toggle mdl-toggle";
      lab.title = "Enabled for this organization";
      lab.innerHTML = `<input type="checkbox" ${p.enabledForOrg ? "checked" : ""} /><span class="toggle-switch"></span>`;
      lab.addEventListener("click", (ev) => ev.stopPropagation());
      const box = lab.querySelector("input") as HTMLInputElement;
      box.addEventListener("change", () => {
        const call = box.checked ? window.glyphh.orgProviderEnable(p.slug) : window.glyphh.orgProviderDisable(p.slug);
        void call.then((r) => {
          if (!r?.ok) { box.checked = !box.checked; showError(r.error || "Update failed"); return; }
          p.enabledForOrg = box.checked;
          showError("");
        });
      });
      head.appendChild(lab);
    }
    // KEY STATE (his order, 2026-09-11): a set key shows the green check; the
    // red ✗ beside it confirms, then turns the provider OFF for the whole org
    // (disable clears the key server-side — the message states exactly that).
    if (e.gateway?.hasByokKey) {
      const check = document.createElement("span");
      check.className = "mdl-key-check";
      check.title = "API key is set";
      check.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      const removeKey = icoBtn(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`, "Remove the API key");
      removeKey.classList.add("mdl-key-remove");
      removeKey.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void (async () => {
          const sure = await confirmAction({
            title: `Remove the ${e.gateway!.name} API key?`,
            body: "Removing the key turns off this provider for all users in your organization.",
            confirmLabel: "Remove key",
            danger: true,
          });
          if (!sure) return;
          const r = await window.glyphh.orgProviderDisable(e.gateway!.slug);
          if (!r?.ok) { showError(r?.error || "Couldn't remove the key"); return; }
          e.gateway!.hasByokKey = false;
          e.gateway!.enabledForOrg = false;
          showError("");
          renderList();
        })();
      });
      head.appendChild(check);
      head.appendChild(removeKey);
    }
    // Edit — the Catalog page's pencil, replacing the old ⋮ menu. With a key
    // SET the row shows ✓/✗ instead (his order, 2026-09-11): remove the key
    // first, then edit.
    if (!e.gateway?.hasByokKey) {
      const editBtn = icoBtn(MDL_SVG.edit, "Edit");
      editBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (e.gateway) void editGatewayProviderModal(e.gateway);
        else void editCustomProviderModal(e.customProv!);
      });
      head.appendChild(editBtn);
    }
    if (e.customProv) {
      const delBtn = icoBtn(MDL_SVG.trash, "Delete provider");
      delBtn.addEventListener("click", (ev) => { ev.stopPropagation(); void deleteProviderConfirm(e.customProv!); });
      head.appendChild(delBtn);
    }
    head.addEventListener("click", () => {
      if (isOpen) { expanded.delete(e.key); if (e.autoOpen) searchClosed.add(e.key); }
      else { expanded.add(e.key); searchClosed.delete(e.key); }
      renderList();
    });
    row.appendChild(head);

    if (isOpen) {
      const body = document.createElement("div");
      body.className = "mdl-prov-models";
      if (e.gateway) {
        const list = models.filter((m) => m.kind === "proxied" && m.providerSlug === e.gateway!.slug);
        if (!list.length) body.innerHTML = `<div class="crud-empty">No catalog models for this provider yet.</div>`;
        for (const m of list) {
          const gated = m.planAllowed === false;
          body.appendChild(modelLine(m.name,
            gated ? `${m.inputCreditsPerMTok}/${m.outputCreditsPerMTok} cr per MTok · paid plans` : `${m.inputCreditsPerMTok}/${m.outputCreditsPerMTok} cr per MTok`, {
            on: gated ? false : m.supported,
            disabled: gated,
            disabledTitle: "Upgrade to a paid plan to use this model.",
            onChange: (on) => {
              void window.glyphh.orgModelsSetSupported(m.id, on).then((r) => {
                if (!r?.ok) { showError(r.error || "Update failed"); renderList(); return; }
                m.supported = on;
                showError("");
              });
            },
          }));
        }
      } else if (e.customProv) {
        const list = custom.filter((m) => m.provider_slug === e.customProv!.slug);
        if (!list.length) body.innerHTML = `<div class="crud-empty">No models yet — add one with +.</div>`;
        for (const m of list) {
          const editIc = icoBtn(MDL_SVG.edit, "Edit model");
          editIc.addEventListener("click", (ev) => { ev.stopPropagation(); void modelModal(e.customProv!.slug, m); });
          const delIc = icoBtn(MDL_SVG.trash, "Delete model");
          delIc.classList.add("danger");
          delIc.addEventListener("click", (ev) => { ev.stopPropagation(); void deleteModelConfirm(m); });
          body.appendChild(modelLine(m.name, m.model_name, {
            on: m.active,
            onChange: (on) => {
              void window.glyphh.orgCustomModelsSave({
                slug: m.id.replace(/^custom::/, ""),
                name: m.name,
                providerSlug: e.customProv!.slug,
                modelName: m.model_name,
                contextWindow: m.context_window,
                maxOutputTokens: m.max_output_tokens,
                active: on,
              }).then((r) => {
                if (!r?.ok) { showError(r.error || "Update failed"); renderList(); return; }
                m.active = on;
                showError("");
              });
            },
          }, [editIc, delIc]));
        }
      }
      row.appendChild(body);
    }
    wrap.appendChild(row);
  }

  const pager = el("models-pager");
  if (pager) {
    pager.textContent = "";
    pager.appendChild(renderPaginationBar(
      { page, totalPages, total: all.length, pageSize: PAGE_SIZE },
      (p) => { page = p; renderList(); },
    ));
  }
}

// ── data + wiring ────────────────────────────────────────────────────────────

async function refresh(): Promise<void> {
  const [m, p, cp, c] = await Promise.all([
    window.glyphh.orgModelsList(),
    window.glyphh.orgProvidersList(),
    window.glyphh.orgCustomProvidersList(),
    window.glyphh.orgCustomModelsList(),
  ]);
  const firstError = [m, p, cp, c].find((r) => !r.ok)?.error;
  showError(firstError ? `Couldn't load: ${firstError}` : "");
  if (m.ok && m.data) models = m.data as OrgModelRow[];
  // The plan-gate nudge (his spec, 2026-09-01, same grammar as the members
  // seat note): visible whenever the org's plan excludes any catalog model.
  document.getElementById("models-plan-note")?.classList.toggle(
    "hidden", !models.some((x) => x.planAllowed === false));
  if (p.ok && p.data) providers = p.data as ProviderRow[];
  if (cp.ok && cp.data) customProviders = cp.data as CustomProviderRow[];
  if (c.ok && c.data) custom = c.data as CustomModelRow[];
  renderList();
}

export function loadModelsAdmin(): void {
  if (!initialized) {
    initialized = true;
    el("models-search")?.addEventListener("input", () => { page = 0; searchClosed.clear(); renderList(); });
    el("models-provider-filter")?.addEventListener("click", (ev) => { ev.stopPropagation(); openProviderFilter(ev.currentTarget as HTMLElement); });
    el("provider-new-btn")?.addEventListener("click", () => void installProviderModal());
  }
  void refresh();
}
