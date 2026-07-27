/**
 * Models (org admin) — the desktop mirror of the platform's Configure → Models:
 * catalog support toggles (proxy + open weight), provider enablement + BYOK
 * keys, and the org's custom OpenAI-compatible models. All writes go to the
 * server through models-ipc; the server enforces org_admin — a non-admin sees
 * the refusal in the banner, and nothing here pretends otherwise.
 */

interface OrgModelRow {
  id: string;
  name: string;
  providerSlug: string;
  kind: string;
  inputCreditsPerMTok: number;
  outputCreditsPerMTok: number;
  supported: boolean;
  providerEnabled: boolean;
}

interface ProviderRow {
  slug: string;
  name: string;
  kind: string;
  enabledForOrg: boolean;
  hasByokKey: boolean;
}

interface CustomModelRow {
  id: string;
  name: string;
  base_url: string;
  model_name: string;
  context_window: number;
  max_output_tokens: number;
  has_key: boolean;
}

let models: OrgModelRow[] = [];
let providers: ProviderRow[] = [];
let custom: CustomModelRow[] = [];
let initialized = false;

const el = (id: string) => document.getElementById(id);

function showError(msg: string): void {
  const b = el("models-admin-error");
  if (!b) return;
  b.textContent = msg;
  b.classList.toggle("hidden", !msg);
}

// ── rendering ────────────────────────────────────────────────────────────────

function renderModelGrid(kind: "proxied" | "open_weight"): void {
  const tab = kind === "proxied" ? "proxy" : "open";
  const grid = el(`models-grid-${tab}`);
  if (!grid) return;
  const q = ((el(`models-search-${tab}`) as HTMLInputElement | null)?.value || "").trim().toLowerCase();
  const list = models.filter((m) => m.kind === kind &&
    (!q || m.name.toLowerCase().includes(q) || m.providerSlug.toLowerCase().includes(q)));
  grid.textContent = "";
  if (!list.length) {
    grid.innerHTML = `<div class="crud-empty">${q ? "No models match your search." : "No models in the catalog yet."}</div>`;
    return;
  }
  for (const m of list) {
    const card = document.createElement("div");
    card.className = "mdl-card" + (m.kind === "proxied" && !m.providerEnabled ? " mdl-provider-off" : "");
    const price = m.kind === "proxied"
      ? `${m.providerSlug} · ${m.inputCreditsPerMTok}/${m.outputCreditsPerMTok} cr per MTok`
      : (m.providerSlug === "local" ? "On-device · 0 credits" : `${m.providerSlug} · open weight`);
    card.innerHTML = `
      <div class="mdl-card-info">
        <div class="mdl-card-name"></div>
        <div class="mdl-card-sub"></div>
      </div>
      ${m.kind === "proxied" && !m.providerEnabled ? `<button type="button" class="mdl-chip-warn" title="Enable this model's provider on the Providers tab">Provider off</button>` : ""}
      <label class="settings-toggle mdl-toggle">
        <input type="checkbox" ${m.supported ? "checked" : ""} />
        <span class="toggle-switch"></span>
        <span class="mdl-toggle-text">Supported</span>
      </label>`;
    (card.querySelector(".mdl-card-name") as HTMLElement).textContent = m.name;
    (card.querySelector(".mdl-card-sub") as HTMLElement).textContent = price;
    card.querySelector(".mdl-chip-warn")?.addEventListener("click", () => switchTab("providers"));
    const box = card.querySelector("input[type=checkbox]") as HTMLInputElement;
    box.addEventListener("change", () => {
      void window.yo.orgModelsSetSupported(m.id, box.checked).then((r) => {
        if (!r.ok) { box.checked = !box.checked; showError(r.error || "Update failed"); return; }
        m.supported = box.checked;
        showError("");
      });
    });
    grid.appendChild(card);
  }
}

function renderProviders(): void {
  const wrap = el("models-providers-list");
  if (!wrap) return;
  const q = ((el("models-search-providers") as HTMLInputElement | null)?.value || "").trim().toLowerCase();
  const list = providers.filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q));
  wrap.textContent = "";
  if (!list.length) {
    wrap.innerHTML = `<div class="crud-empty">${q ? "No providers match your search." : "No providers in the catalog yet."}</div>`;
    return;
  }
  for (const p of list) {
    const row = document.createElement("div");
    row.className = "mdl-row";
    row.innerHTML = `
      <div class="mdl-row-id">
        <div class="mdl-card-name"></div>
        <div class="mdl-card-sub mono"></div>
      </div>
      <input class="settings-input mdl-key" type="password" autocomplete="new-password" />
      <button type="button" class="action-btn mdl-key-save" disabled></button>
      <span class="mdl-key-state"></span>
      <label class="settings-toggle" title="">
        <input type="checkbox" ${p.enabledForOrg ? "checked" : ""} />
        <span class="toggle-switch"></span>
      </label>`;
    (row.querySelector(".mdl-card-name") as HTMLElement).textContent = p.name;
    (row.querySelector(".mdl-card-sub") as HTMLElement).textContent = p.slug;
    const keyInput = row.querySelector(".mdl-key") as HTMLInputElement;
    const saveBtn = row.querySelector(".mdl-key-save") as HTMLButtonElement;
    const state = row.querySelector(".mdl-key-state") as HTMLElement;
    keyInput.placeholder = p.hasByokKey ? "•••••••• (saved — enter a new key to replace)" : `${p.name} API key`;
    saveBtn.textContent = p.hasByokKey ? "Replace key" : "Save";
    state.textContent = p.hasByokKey ? "✓ key set" : "—";
    state.classList.toggle("mdl-key-ok", p.hasByokKey);
    keyInput.addEventListener("input", () => { saveBtn.disabled = !keyInput.value.trim(); });
    const saveKey = () => {
      const value = keyInput.value.trim();
      if (!value) return;
      saveBtn.disabled = true;
      void window.yo.orgProviderEnable(p.slug, value).then((r) => {
        if (!r.ok) { showError(r.error || "Save failed"); saveBtn.disabled = false; return; }
        showError("");
        void refresh();
      });
    };
    saveBtn.addEventListener("click", saveKey);
    keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveKey(); });
    const toggle = row.querySelector(".settings-toggle input") as HTMLInputElement;
    toggle.addEventListener("change", () => {
      const call = toggle.checked ? window.yo.orgProviderEnable(p.slug) : window.yo.orgProviderDisable(p.slug);
      void call.then((r) => {
        if (!r.ok) { toggle.checked = !toggle.checked; showError(r.error || "Update failed"); return; }
        p.enabledForOrg = toggle.checked;
        showError("");
        // Support cards show "Provider off" chips — keep them truthful.
        void refreshModelsOnly();
      });
    });
    wrap.appendChild(row);
  }
}

function renderCustom(): void {
  const wrap = el("models-custom-list");
  if (!wrap) return;
  wrap.textContent = "";
  if (!custom.length) {
    wrap.innerHTML = `<div class="crud-empty">No custom models yet.</div>`;
    return;
  }
  for (const m of custom) {
    const row = document.createElement("div");
    row.className = "mdl-row";
    row.innerHTML = `
      <div class="mdl-row-id mdl-row-wide">
        <div class="mdl-card-name"></div>
        <div class="mdl-card-sub mono"></div>
      </div>
      <button type="button" class="action-btn mdl-edit">Edit</button>
      <button type="button" class="action-btn danger mdl-del">Delete</button>`;
    (row.querySelector(".mdl-card-name") as HTMLElement).textContent = `${m.name}  ·  ${m.id}`;
    (row.querySelector(".mdl-card-sub") as HTMLElement).textContent =
      `${m.base_url} · ${m.model_name} · ${m.context_window.toLocaleString()} ctx · ${m.has_key ? "✓ key" : "no key"}`;
    row.querySelector(".mdl-edit")?.addEventListener("click", () => {
      (el("mc-name") as HTMLInputElement).value = m.name;
      (el("mc-slug") as HTMLInputElement).value = m.id.replace(/^custom::/, "");
      (el("mc-url") as HTMLInputElement).value = m.base_url;
      (el("mc-model") as HTMLInputElement).value = m.model_name;
      (el("mc-ctx") as HTMLInputElement).value = String(m.context_window);
      (el("mc-max") as HTMLInputElement).value = String(m.max_output_tokens);
      (el("mc-key") as HTMLInputElement).value = "";
    });
    row.querySelector(".mdl-del")?.addEventListener("click", () => {
      void window.yo.orgCustomModelsDelete(m.id).then((r) => {
        if (!r.ok) { showError(r.error || "Delete failed"); return; }
        showError("");
        void refresh();
      });
    });
    wrap.appendChild(row);
  }
}

function renderCounts(): void {
  const set = (id: string, n: number) => { const e = el(id); if (e) e.textContent = String(n); };
  set("models-count-proxy", models.filter((m) => m.kind === "proxied").length);
  set("models-count-open", models.filter((m) => m.kind === "open_weight").length);
  set("models-count-custom", custom.length);
  set("models-count-providers", providers.length);
}

// ── data ─────────────────────────────────────────────────────────────────────

async function refreshModelsOnly(): Promise<void> {
  const r = await window.yo.orgModelsList();
  if (r.ok && r.data) models = r.data as OrgModelRow[];
  renderModelGrid("proxied");
  renderModelGrid("open_weight");
  renderCounts();
}

async function refresh(): Promise<void> {
  const [m, p, c] = await Promise.all([
    window.yo.orgModelsList(),
    window.yo.orgProvidersList(),
    window.yo.orgCustomModelsList(),
  ]);
  const firstError = [m, p, c].find((r) => !r.ok)?.error;
  showError(firstError ? `Couldn't load: ${firstError}` : "");
  if (m.ok && m.data) models = m.data as OrgModelRow[];
  if (p.ok && p.data) providers = p.data as ProviderRow[];
  if (c.ok && c.data) custom = c.data as CustomModelRow[];
  renderModelGrid("proxied");
  renderModelGrid("open_weight");
  renderProviders();
  renderCustom();
  renderCounts();
}

// ── wiring ───────────────────────────────────────────────────────────────────

function switchTab(tab: string): void {
  document.querySelectorAll<HTMLElement>("#models-tabs .app-detail-tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.mtab === tab));
  document.querySelectorAll<HTMLElement>(".mdl-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.mtab === tab));
}

async function saveCustom(): Promise<void> {
  const v = (id: string) => (el(id) as HTMLInputElement).value.trim();
  const slug = v("mc-slug").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!v("mc-name") || !slug || !v("mc-url") || !v("mc-model")) {
    showError("Custom models need a name, slug, base URL, and model name.");
    return;
  }
  const btn = el("mc-save") as HTMLButtonElement;
  btn.disabled = true;
  const r = await window.yo.orgCustomModelsSave({
    slug,
    name: v("mc-name"),
    baseUrl: v("mc-url"),
    modelName: v("mc-model"),
    contextWindow: Math.max(1, Number(v("mc-ctx")) || 8192),
    maxOutputTokens: Math.max(1, Number(v("mc-max")) || 4096),
    ...(v("mc-key") ? { key: v("mc-key") } : {}),
  });
  btn.disabled = false;
  if (!r.ok) { showError(r.error || "Save failed"); return; }
  showError("");
  clearCustomForm();
  void refresh();
}

function clearCustomForm(): void {
  for (const id of ["mc-name", "mc-slug", "mc-url", "mc-model", "mc-ctx", "mc-max", "mc-key"]) {
    const input = el(id) as HTMLInputElement | null;
    if (input) input.value = "";
  }
}

export function loadModelsAdmin(): void {
  if (!initialized) {
    initialized = true;
    document.querySelectorAll<HTMLElement>("#models-tabs .app-detail-tab").forEach((b) =>
      b.addEventListener("click", () => switchTab(b.dataset.mtab || "proxy")));
    el("models-search-proxy")?.addEventListener("input", () => renderModelGrid("proxied"));
    el("models-search-open")?.addEventListener("input", () => renderModelGrid("open_weight"));
    el("models-search-providers")?.addEventListener("input", renderProviders);
    el("mc-save")?.addEventListener("click", () => void saveCustom());
    el("mc-clear")?.addEventListener("click", () => { clearCustomForm(); showError(""); });
  }
  void refresh();
}
