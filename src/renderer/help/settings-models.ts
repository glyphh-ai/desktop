/**
 * Settings → Models: the user's own model providers, their keys, and the
 * models each serves — typed chat (the agent), transcription (dictation),
 * speech (spoken replies), embeddings (memory and search), image or video —
 * plus the default of each type and the speaking voice. Main stores it all (providers.ts) and the router calls the providers
 * directly; a key goes to main once and only ever comes back masked.
 */
import { confirmAction } from "./shared.js";
import { toastOk } from "./toast.js";

type ModelType = "chat" | "transcription" | "speech" | "embeddings" | "image" | "video";
type Kind = "anthropic" | "openai" | "gemini" | "openai-compatible";

interface ProviderRow { id: string; kind: Kind; name: string; baseUrl?: string; keySet: boolean; keyFrom: "saved" | "environment" | null; keyHint: string }
interface ModelRow { id: string; provider: string; model: string; type: ModelType; label?: string }
interface Page {
  providers: ProviderRow[];
  models: ModelRow[];
  defaults: Partial<Record<ModelType | "voice", string>>;
  kinds: Array<{ kind: Kind; name: string }>;
  types: ModelType[];
  voices: string[];
}
type Env<T> = { ok: true; data: T } | { ok: false; error: string };
interface Listed { model: string; type: ModelType; added: boolean }

interface Doors {
  modelsPage?: () => Promise<Env<Page>>;
  modelsProviderSave?: (input: { id?: string; kind: Kind; name?: string; baseUrl?: string; apiKey?: string; clearKey?: boolean }) => Promise<Env<Page>>;
  modelsProviderRemove?: (id: string) => Promise<Env<Page>>;
  modelsProviderList?: (id: string) => Promise<Env<Listed[]>>;
  modelsModelSave?: (input: { provider: string; model: string; type: ModelType; label?: string }) => Promise<Env<Page>>;
  modelsModelRemove?: (id: string) => Promise<Env<Page>>;
  modelsDefaultSet?: (key: ModelType | "voice", value: string) => Promise<Env<Page>>;
}
const doors = (): Doors => (window.glyphh ?? {}) as unknown as Doors;

export const TYPE_LABEL: Record<ModelType, string> = {
  chat: "Chat", transcription: "Transcription", speech: "Speech", embeddings: "Embeddings", image: "Image", video: "Video",
};
export const TYPE_HINT: Record<ModelType, string> = {
  chat: "What a new session runs on.",
  transcription: "Turns your voice into text when you dictate.",
  speech: "Reads replies aloud in voice mode.",
  embeddings: "Powers memory and search.",
  image: "Makes images when a loop asks for one.",
  video: "Makes video when a loop asks for one.",
};

/** Where a provider's key comes from, in words. */
export function keyLine(p: Pick<ProviderRow, "kind" | "keySet" | "keyFrom" | "keyHint">): string {
  if (p.keyFrom === "saved") return `Key saved (${p.keyHint})`;
  if (p.keyFrom === "environment") return `Key from ${ENV_OF[p.kind] ?? "the environment"} (${p.keyHint})`;
  return p.kind === "openai-compatible" ? "No key (fine for a local server)" : "No key yet";
}
const ENV_OF: Partial<Record<Kind, string>> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" };

let page: Page | null = null;
/** The provider whose form is open ("" = a new one), or null. */
let editing: string | null = null;
/** The provider whose fetched list is open, with its rows. */
let listing: { id: string; rows: Listed[] | null; error?: string } | null = null;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const h = (tag: string, cls?: string, text?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const button = (label: string, cls = "action-btn"): HTMLButtonElement => {
  const b = h("button", cls, label) as HTMLButtonElement;
  b.type = "button";
  return b;
};

function showError(msg: string): void {
  const e = $("models-error");
  if (!e) return;
  e.textContent = msg;
  e.classList.toggle("hidden", !msg);
}

/** Apply an answer: a page repaints, an error shows above the list. */
async function apply(p: Promise<Env<Page>> | undefined, ok?: string): Promise<boolean> {
  const r = await p?.catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
  if (!r) return false;
  if (!r.ok) { showError(r.error); return false; }
  showError("");
  page = r.data;
  paint();
  if (ok) toastOk(ok);
  return true;
}

export async function loadModelsSettings(): Promise<void> {
  const r = await doors().modelsPage?.().catch(() => null);
  if (!r) return;
  if (!r.ok) { showError(r.error); return; }
  page = r.data;
  paint();
}

function paint(): void {
  if (!page) return;
  paintDefaults(page);
  paintProviders(page);
}

// ── DEFAULTS ────────────────────────────────────────────────────────────────

function select(options: Array<{ value: string; label: string }>, value: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = h("select", "settings-input") as HTMLSelectElement;
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    s.appendChild(opt);
  }
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

function prefRow(title: string, desc: string, control: HTMLElement): HTMLElement {
  const row = h("div", "set-pref-row");
  const text = h("div", "set-pref-text");
  text.append(h("div", "set-pref-title", title), h("div", "set-pref-desc", desc));
  const value = h("div", "set-pref-value");
  value.appendChild(control);
  row.append(text, value);
  return row;
}

function paintDefaults(p: Page): void {
  const host = $("models-defaults");
  if (!host) return;
  host.textContent = "";
  const names = new Map(p.providers.map((x) => [x.id, x.name]));
  for (const t of p.types) {
    const ofType = p.models.filter((m) => m.type === t);
    const options = ofType.length
      ? ofType.map((m) => ({ value: m.id, label: `${m.label || m.model} · ${names.get(m.provider) ?? m.provider}` }))
      : [{ value: "", label: `No ${TYPE_LABEL[t].toLowerCase()} models yet` }];
    const current = p.defaults[t] ?? ofType[0]?.id ?? "";
    const s = select(options, current, (v) => { void apply(doors().modelsDefaultSet?.(t, v)); });
    s.disabled = !ofType.length;
    host.appendChild(prefRow(`${TYPE_LABEL[t]} model`, TYPE_HINT[t], s));
  }
  const speech = p.models.some((m) => m.type === "speech");
  const voice = select(p.voices.map((v) => ({ value: v, label: v })), p.defaults.voice ?? "alloy", (v) => { void apply(doors().modelsDefaultSet?.("voice", v)); });
  voice.disabled = !speech;
  host.appendChild(prefRow("Voice", speech ? "The voice replies are read in." : "Add a speech model to pick a voice.", voice));
}

// ── PROVIDERS ───────────────────────────────────────────────────────────────

function paintProviders(p: Page): void {
  const host = $("models-providers");
  if (!host) return;
  host.textContent = "";
  if (!p.providers.length && editing === null) {
    host.appendChild(h("div", "crud-empty", "No providers yet. Add Anthropic, OpenAI, Gemini, or any OpenAI-compatible server (Ollama, LM Studio, OpenRouter, Groq)."));
  }
  for (const prov of p.providers) host.appendChild(editing === prov.id ? providerForm(p, prov) : providerCard(p, prov));
  if (editing === "") host.appendChild(providerForm(p, null));
  const add = $("models-add-provider") as HTMLButtonElement | null;
  if (add) add.disabled = editing !== null;
}

function providerCard(p: Page, prov: ProviderRow): HTMLElement {
  const card = h("div", "pvd-card");
  const head = h("div", "pvd-head");
  const title = h("div", "pvd-title");
  title.append(h("span", "pvd-name", prov.name), h("span", "pvd-kind", p.kinds.find((k) => k.kind === prov.kind)?.name ?? prov.kind));
  const meta = h("div", "pvd-meta", [prov.baseUrl, keyLine(prov)].filter(Boolean).join(" · "));
  const left = h("div", "pvd-left");
  left.append(title, meta);
  const acts = h("div", "pvd-actions");
  const fetchBtn = button("Fetch models");
  fetchBtn.addEventListener("click", () => { void openListing(prov.id); });
  const edit = button("Edit");
  edit.addEventListener("click", () => { editing = prov.id; listing = null; paint(); });
  const remove = button("Remove");
  remove.addEventListener("click", () => {
    void confirmAction({ title: `Remove ${prov.name}?`, body: "Its key and its models leave Glyphh. Sessions on its models fall back to your default.", confirmLabel: "Remove", danger: true })
      .then((yes: boolean) => { if (yes) void apply(doors().modelsProviderRemove?.(prov.id), `${prov.name} removed`); });
  });
  acts.append(fetchBtn, edit, remove);
  head.append(left, acts);
  card.appendChild(head);
  if (listing?.id === prov.id) card.appendChild(listingBlock(prov));
  card.appendChild(modelsBlock(p, prov));
  return card;
}

function providerForm(p: Page, prov: ProviderRow | null): HTMLElement {
  const form = h("div", "pvd-card pvd-form");
  const kind = select(p.kinds.map((k) => ({ value: k.kind, label: k.name })), prov?.kind ?? "anthropic", () => syncKind());
  kind.disabled = !!prov;
  const name = h("input", "settings-input") as HTMLInputElement;
  name.placeholder = "Name";
  name.value = prov?.name ?? "";
  const base = h("input", "settings-input") as HTMLInputElement;
  base.placeholder = "Base URL, e.g. http://localhost:11434/v1";
  base.value = prov?.baseUrl ?? "";
  const key = h("input", "settings-input") as HTMLInputElement;
  key.type = "password";
  key.autocomplete = "off";
  key.placeholder = prov?.keySet ? "Leave empty to keep the current key" : "API key";
  const baseRow = field("Base URL", base);
  const syncKind = (): void => {
    const k = kind.value as Kind;
    baseRow.classList.toggle("hidden", k !== "openai-compatible" && !base.value);
    if (!prov) name.placeholder = p.kinds.find((x) => x.kind === k)?.name ?? "Name";
  };
  form.append(field("Type", kind), field("Name", name), baseRow, field("API key", key));
  syncKind();
  const acts = h("div", "pvd-form-actions");
  const save = button(prov ? "Save" : "Add provider", "action-btn primary");
  save.addEventListener("click", () => {
    void apply(doors().modelsProviderSave?.({
      ...(prov ? { id: prov.id } : {}), kind: kind.value as Kind, name: name.value, baseUrl: base.value, apiKey: key.value,
    }), prov ? "Provider saved" : "Provider added").then((ok) => { if (ok) { editing = null; paint(); } });
  });
  const cancel = button("Cancel");
  cancel.addEventListener("click", () => { editing = null; showError(""); paint(); });
  acts.append(save, cancel);
  if (prov?.keyFrom === "saved") {
    const clear = button("Remove key");
    clear.addEventListener("click", () => {
      void apply(doors().modelsProviderSave?.({ id: prov.id, kind: prov.kind, name: prov.name, ...(prov.baseUrl ? { baseUrl: prov.baseUrl } : {}), clearKey: true }), "Key removed")
        .then((ok) => { if (ok) { editing = null; paint(); } });
    });
    acts.appendChild(clear);
  }
  form.appendChild(acts);
  requestAnimationFrame(() => (prov ? key : name).focus());
  return form;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const row = h("label", "pvd-field");
  row.append(h("span", "pvd-field-label", label), control);
  return row;
}

// ── A PROVIDER'S MODELS ─────────────────────────────────────────────────────

function modelsBlock(p: Page, prov: ProviderRow): HTMLElement {
  const block = h("div", "pvd-models");
  const mine = p.models.filter((m) => m.provider === prov.id);
  if (!mine.length) block.appendChild(h("div", "pvd-none", "No models yet — fetch the provider's list or add one by name."));
  for (const m of mine) {
    const row = h("div", "pvd-model");
    row.appendChild(h("span", "pvd-model-name", m.label || m.model));
    const type = select(p.types.map((t) => ({ value: t, label: TYPE_LABEL[t] })), m.type, (v) => {
      void apply(doors().modelsModelSave?.({ provider: m.provider, model: m.model, type: v as ModelType, ...(m.label ? { label: m.label } : {}) }));
    });
    const del = button("×", "pvd-x");
    del.title = `Remove ${m.model}`;
    del.setAttribute("aria-label", `Remove ${m.model}`);
    del.addEventListener("click", () => { void apply(doors().modelsModelRemove?.(m.id)); });
    row.append(type, del);
    block.appendChild(row);
  }
  const add = h("div", "pvd-model pvd-add");
  const name = h("input", "settings-input") as HTMLInputElement;
  name.placeholder = "Model name, e.g. gpt-5.1";
  const type = select(p.types.map((t) => ({ value: t, label: TYPE_LABEL[t] })), "chat", () => undefined);
  const go = button("Add");
  const submit = (): void => {
    const model = name.value.trim();
    if (!model) return;
    void apply(doors().modelsModelSave?.({ provider: prov.id, model, type: type.value as ModelType }));
  };
  go.addEventListener("click", submit);
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  add.append(name, type, go);
  block.appendChild(add);
  return block;
}

async function openListing(id: string): Promise<void> {
  listing = { id, rows: null };
  paint();
  const r = await doors().modelsProviderList?.(id).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
  if (listing?.id !== id) return;
  listing = r?.ok ? { id, rows: r.data } : { id, rows: [], error: r && !r.ok ? r.error : "Couldn't read the list." };
  paint();
}

function listingBlock(prov: ProviderRow): HTMLElement {
  const block = h("div", "pvd-listing");
  const close = button("Close");
  close.addEventListener("click", () => { listing = null; paint(); });
  if (!listing?.rows) { block.append(h("div", "pvd-none", `Reading ${prov.name}'s models…`)); return block; }
  if (listing.error) { block.append(h("div", "settings-error", listing.error), close); return block; }
  const fresh = listing.rows.filter((r) => !r.added);
  if (!fresh.length) { block.append(h("div", "pvd-none", "Every model it lists is already added."), close); return block; }
  const picks = new Map<string, ModelType>();
  const list = h("div", "pvd-listing-rows");
  for (const r of fresh) {
    const row = h("label", "pvd-listing-row");
    const cb = h("input") as HTMLInputElement;
    cb.type = "checkbox";
    const type = select((page?.types ?? ["chat"]).map((t) => ({ value: t, label: TYPE_LABEL[t] })), r.type, (v) => { if (picks.has(r.model)) picks.set(r.model, v as ModelType); });
    cb.addEventListener("change", () => { if (cb.checked) picks.set(r.model, type.value as ModelType); else picks.delete(r.model); });
    row.append(cb, h("span", "pvd-model-name", r.model), type);
    list.appendChild(row);
  }
  const acts = h("div", "pvd-form-actions");
  const addSel = button("Add selected", "action-btn primary");
  addSel.addEventListener("click", () => {
    void (async () => {
      for (const [model, type] of picks) {
        if (!(await apply(doors().modelsModelSave?.({ provider: prov.id, model, type })))) return;
      }
      listing = null;
      paint();
      if (picks.size) toastOk(`${picks.size} model${picks.size === 1 ? "" : "s"} added`);
    })();
  });
  acts.append(addSel, close);
  block.append(list, acts);
  return block;
}

/** Wired once: the Add provider button. */
export function initModelsSettings(): void {
  $("models-add-provider")?.addEventListener("click", () => { editing = ""; listing = null; paint(); });
}
