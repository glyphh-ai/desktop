/**
 * settings-apikeys.ts — Settings › API Keys.
 *
 * User-scoped `gy_ak_…` headless-auth keys: list, create (token shown once),
 * revoke. Ported from mobile.tsx ApiKeysTray.
 *
 * Transport — the ONE api-keys transport for BOTH surfaces, per settings-api.ts's
 * law that the renderer never holds an SDK client:
 *   • web     — window.glyphhSdk.apiKeys (checked FIRST; on web window.glyphh is
 *               a Proxy that fabricates any method, so the SDK handle must win).
 *   • desktop — window.glyphh.apiKeysList / apiKeysCreate / apiKeysRevoke →
 *               the MAIN-process SDK client (apikeys-ipc.ts → getClient().apiKeys).
 * Neither present → an honest "not available on this build" message.
 */

import { escapeHtml, confirmAction, paginate, renderPaginationBar } from "./shared.js";
import { kebabCell, ROW_MENU_ICONS } from "./lib-editor.js";
import { USD_PER_CREDIT } from "./settings-api.js";

export interface ApiKey {
  id: string; label: string; prefix: string; createdAt: string; expiresAt: string | null;
  userEmail?: string; lastUsedAt?: string | null;
  /** Console-style hint (`gy_ak_abcdefgh...wxyz`); null on pre-hint keys. */
  tokenHint?: string | null;
  /** Attributed spend in MICRO-credits (server-summed from the usage ledger). */
  creditsMicro?: number;
}
interface CreatedApiKey { key: ApiKey; token: string }

interface SdkApiKeys {
  list?: () => Promise<ApiKey[]>;
  create?: (input: { label: string; expiresInDays?: number }) => Promise<CreatedApiKey>;
  revoke?: (id: string) => Promise<void>;
}
interface DesktopApiKeysIpc {
  apiKeysList?: () => Promise<ApiKey[]>;
  apiKeysCreate?: (input: { label: string; expiresInDays?: number }) => Promise<{ ok: boolean; created?: CreatedApiKey; error?: string }>;
  apiKeysRevoke?: (id: string) => Promise<{ ok: boolean; error?: string }>;
}

interface ApiKeysTransport {
  list(): Promise<ApiKey[]>;
  create(label: string, expiresInDays?: number): Promise<CreatedApiKey>;
  revoke(id: string): Promise<void>;
}

const NO_TRANSPORT = "API keys aren't available on this build.";

function isWeb(): boolean {
  return !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
}

function transport(): ApiKeysTransport | null {
  if (isWeb()) {
    const a = (window as unknown as { glyphhSdk?: { apiKeys?: SdkApiKeys } }).glyphhSdk?.apiKeys;
    if (!a?.list || !a.create || !a.revoke) return null;
    return { list: () => a.list!(), create: (label, expiresInDays) => a.create!({ label, ...(expiresInDays ? { expiresInDays } : {}) }), revoke: (id) => a.revoke!(id) };
  }
  const g = (window as unknown as { glyphh?: DesktopApiKeysIpc }).glyphh;
  if (!g?.apiKeysList || !g.apiKeysCreate || !g.apiKeysRevoke) return null;
  return {
    list: () => g.apiKeysList!(),
    create: async (label, expiresInDays) => {
      const r = await g.apiKeysCreate!({ label, ...(expiresInDays ? { expiresInDays } : {}) });
      if (!r?.ok || !r.created) throw new Error(r?.error || "Could not create the key.");
      return r.created;
    },
    revoke: async (id) => {
      const r = await g.apiKeysRevoke!(id);
      if (!r?.ok) throw new Error(r?.error || "Could not revoke.");
    },
  };
}

const $ = (id: string) => document.getElementById(id);

/** The copy ladder shared by the modal: browser-native → IPC → execCommand. */
async function copyText(val: string, input?: HTMLInputElement | null): Promise<boolean> {
  try { await navigator.clipboard.writeText(val); return true; } catch { /* fall through */ }
  const ipc = (window as unknown as { glyphh?: { copyToClipboard?: (s: string) => void } }).glyphh?.copyToClipboard;
  if (ipc) { void ipc(val); return true; }
  if (input) { input.focus(); input.select(); return document.execCommand("copy"); }
  return false;
}

/** After a create/regenerate: back on the list, the ONE-TIME token in a modal
 *  with the warning and a copy button (his spec, 2026-08-25). */
export function showTokenModal(label: string, token: string): void {
  document.querySelectorAll(".yo-modal.ak-token-overlay").forEach((n) => n.remove());
  const overlay = document.createElement("div");
  overlay.className = "yo-modal ak-token-overlay";
  const backdrop = document.createElement("div");
  backdrop.className = "yo-modal-backdrop";
  const panel = document.createElement("div");
  panel.className = "yo-modal-panel ak-token-modal";
  const head = document.createElement("div");
  head.className = "yo-modal-title";
  head.textContent = `API key created — ${label}`;
  const warn = document.createElement("div");
  warn.className = "settings-warn";
  warn.textContent = "Copy your key now — it won't be shown again.";
  const row = document.createElement("div");
  row.className = "settings-inline";
  const input = document.createElement("input");
  input.className = "settings-input";
  input.readOnly = true;
  input.value = token;
  input.spellcheck = false;
  input.addEventListener("focus", () => input.select());
  const copy = document.createElement("button");
  copy.className = "action-btn primary";
  copy.type = "button";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => {
    void copyText(token, input).then((ok) => {
      copy.textContent = ok ? "Copied" : "Select + ⌘C";
      setTimeout(() => { copy.textContent = "Copy"; }, 1800);
    });
  });
  row.append(input, copy);
  const actions = document.createElement("div");
  actions.className = "settings-actions";
  actions.style.marginTop = "16px";
  const spacer = document.createElement("div");
  spacer.style.flex = "1";
  const done = document.createElement("button");
  done.className = "action-btn";
  done.type = "button";
  done.textContent = "Done";
  actions.append(spacer, done);
  panel.append(head, warn, row, actions);
  const close = (): void => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", close);
  done.addEventListener("click", close);
  overlay.append(backdrop, panel);
  document.body.appendChild(overlay);
  input.focus();
}
let keys: ApiKey[] = [];
let wired = false;
let query = "";

/** List ⇄ inline create form (the standard CRUD view switch). */
function showEditor(open: boolean): void {
  $("apikeys-list-view")?.classList.toggle("hidden", open);
  $("apikeys-editor")?.classList.toggle("hidden", !open);
  if (open) {
    // Fresh form every open — no stale label/expiry/error, no stale token.
    const input = $("apikeys-label") as HTMLInputElement | null;
    if (input) { input.value = ""; input.focus(); }
    const exp = $("apikeys-expires") as HTMLSelectElement | null;
    if (exp) exp.value = "";
    syncNeverWarn();
    $("apikeys-form-error")?.classList.add("hidden");
  }
}

/** "Never" is a real risk choice — the warn banner shows while it's selected. */
function syncNeverWarn(): void {
  const exp = $("apikeys-expires") as HTMLSelectElement | null;
  $("apikeys-never-warn")?.classList.toggle("hidden", !!exp?.value);
}

function setError(msg: string): void {
  const el = $("apikeys-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

const PAGE_SIZE = 10;
let page = 0;

const fmtDay = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

/** Attributed spend: micro-credits → dollars at the flat display rate. */
const fmtCost = (micro: number | undefined): string =>
  `$${(((micro ?? 0) / 1_000_000) * USD_PER_CREDIT).toFixed(2)}`;

function render(): void {
  const list = $("apikeys-list");
  const empty = $("apikeys-empty");
  if (!list) return;
  const q = query.toLowerCase();
  const shown = q ? keys.filter((k) => `${k.label || ""} ${k.prefix} ${k.userEmail || ""}`.toLowerCase().includes(q)) : keys;
  empty?.classList.toggle("hidden", shown.length > 0);
  if (empty) empty.textContent = keys.length === 0 ? "No keys yet." : `No keys matching "${query}"`;
  list.innerHTML = "";
  if (!shown.length) return;

  // The console-style key table: Key (label + masked token), Created by,
  // Created, Last used, Cost, kebab.
  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Key</th><th>Created by</th><th>Created</th><th>Last used</th><th>Cost</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  const pg = paginate(shown, page, PAGE_SIZE);
  page = pg.state.page;
  for (const k of pg.items) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="lib-table-name"><span class="ak-name"></span><span class="ak-prefix"></span></td>` +
      `<td class="lib-table-desc"></td>` +
      `<td class="lib-table-dim">${escapeHtml(fmtDay(k.createdAt))}</td>` +
      `<td class="lib-table-dim">${escapeHtml(fmtDay(k.lastUsedAt))}</td>` +
      `<td>${escapeHtml(fmtCost(k.creditsMicro))}</td>`;
    (tr.querySelector(".ak-name") as HTMLElement).textContent = k.label || "(unnamed)";
    const prefixEl = tr.querySelector(".ak-prefix") as HTMLElement;
    prefixEl.textContent = k.tokenHint || `${k.prefix}...`;
    if (!k.tokenHint) {
      // Pre-hint key: only its hash survives — the full mask exists solely
      // for keys minted (or used) after hints landed.
      prefixEl.title = "Created before key hints — the full mask appears after this key's next use, or regenerate it.";
    }
    (tr.querySelector(".lib-table-desc") as HTMLElement).textContent = k.userEmail || "";
    tr.appendChild(kebabCell(() => [
      // Pre-hint keys can never show first...last4 (only their hash survives)
      // — one click swaps them for a fresh key with the same label.
      ...(!k.tokenHint ? [{ icon: ROW_MENU_ICONS.edit, label: "Regenerate…", onClick: () => {
        void (async () => {
          if (!(await confirmAction({
            title: `Regenerate “${k.label || "this key"}”?`,
            body: "A new key is minted with the same label and shown once; the old token stops working immediately.",
            confirmLabel: "Regenerate",
            danger: true,
          }))) return;
          const t = transport();
          if (!t) { setError(NO_TRANSPORT); return; }
          try {
            const created = await t.create(k.label || "key", undefined);
            await t.revoke(k.id);
            await loadApiKeys();
            showTokenModal(created.key.label, created.token);
          } catch (e) { setError((e as Error).message); }
        })();
      } }] : []),
      { icon: ROW_MENU_ICONS.delete, label: "Revoke", danger: true, onClick: () => {
        void (async () => {
          if (!(await confirmAction({ title: `Revoke “${k.label || "this key"}”?`, body: "Any client using this key immediately loses access.", confirmLabel: "Revoke", danger: true }))) return;
          try { await transport()!.revoke(k.id); await loadApiKeys(); }
          catch (e) { setError((e as Error).message); }
        })();
      } },
    ]));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  list.appendChild(table);
  if (pg.state.totalPages > 1) {
    list.appendChild(renderPaginationBar(pg.state, (p) => { page = p; render(); }));
  }
}

export async function loadApiKeys(): Promise<void> {
  setError("");
  const t = transport();
  if (!t) { keys = []; render(); setError(NO_TRANSPORT); return; }
  try { keys = await t.list(); render(); }
  catch (e) { keys = []; render(); setError(`Couldn't load your keys — ${(e as Error).message}`); }
}

export function initApiKeys(): void {
  if (wired) return;
  wired = true;
  $("apikeys-new-btn")?.addEventListener("click", () => showEditor(true));
  $("apikeys-expires")?.addEventListener("change", syncNeverWarn);
  $("apikeys-back-link")?.addEventListener("click", () => showEditor(false));
  $("apikeys-cancel-btn")?.addEventListener("click", () => showEditor(false));
  $("apikeys-search")?.addEventListener("input", () => {
    query = (($("apikeys-search") as HTMLInputElement | null)?.value || "").trim();
    render();
  });
  const formError = (msg: string): void => {
    const el = $("apikeys-form-error");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("hidden", !msg);
  };
  $("apikeys-create-btn")?.addEventListener("click", async () => {
    const input = $("apikeys-label") as HTMLInputElement | null;
    const label = (input?.value || "").trim();
    if (!label) { formError("Give the key a label."); input?.focus(); return; }
    const days = parseInt(($("apikeys-expires") as HTMLSelectElement | null)?.value || "", 10);
    const t = transport();
    if (!t) { formError(NO_TRANSPORT); return; }
    formError("");
    try {
      const created = await t.create(label, Number.isFinite(days) && days > 0 ? days : undefined);
      if (input) input.value = "";
      await loadApiKeys();
      showEditor(false);
      showTokenModal(created.key.label, created.token);
    } catch (e) { formError((e as Error).message); }
  });
}
