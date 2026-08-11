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

import { escapeHtml, confirmAction } from "./shared.js";

export interface ApiKey { id: string; label: string; prefix: string; createdAt: string; expiresAt: string | null }
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
  create(label: string): Promise<CreatedApiKey>;
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
    return { list: () => a.list!(), create: (label) => a.create!({ label }), revoke: (id) => a.revoke!(id) };
  }
  const g = (window as unknown as { glyphh?: DesktopApiKeysIpc }).glyphh;
  if (!g?.apiKeysList || !g.apiKeysCreate || !g.apiKeysRevoke) return null;
  return {
    list: () => g.apiKeysList!(),
    create: async (label) => {
      const r = await g.apiKeysCreate!({ label });
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
let keys: ApiKey[] = [];
let wired = false;
let query = "";

/** List ⇄ inline create form (the standard CRUD view switch). */
function showEditor(open: boolean): void {
  $("apikeys-list-view")?.classList.toggle("hidden", open);
  $("apikeys-editor")?.classList.toggle("hidden", !open);
  if (open) {
    // Fresh form every open — no stale label, no stale one-time token.
    const input = $("apikeys-label") as HTMLInputElement | null;
    if (input) { input.value = ""; input.focus(); }
    $("apikeys-new-token")?.classList.add("hidden");
  }
}

function setError(msg: string): void {
  const el = $("apikeys-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function render(): void {
  const list = $("apikeys-list");
  const empty = $("apikeys-empty");
  if (!list) return;
  const q = query.toLowerCase();
  const shown = q ? keys.filter((k) => `${k.label || ""} ${k.prefix}`.toLowerCase().includes(q)) : keys;
  empty?.classList.toggle("hidden", shown.length > 0);
  if (empty) empty.textContent = keys.length === 0 ? "No keys yet." : `No keys matching "${query}"`;
  list.innerHTML = "";
  for (const k of shown) {
    const row = document.createElement("div");
    row.className = "a4-row";
    const when = k.createdAt ? new Date(k.createdAt).toLocaleDateString() : "";
    row.innerHTML = `<span class="a4-row-main"><span class="a4-row-name">${escapeHtml(k.label || "(unnamed)")}</span><span class="a4-row-sub">${escapeHtml(k.prefix)}${when ? ` · ${escapeHtml(when)}` : ""}</span></span><button class="action-btn danger" type="button">Revoke</button>`;
    row.querySelector("button")!.addEventListener("click", async () => {
      if (!(await confirmAction({ title: `Revoke “${k.label || "this key"}”?`, body: "Any client using this key immediately loses access.", confirmLabel: "Revoke", danger: true }))) return;
      try { await transport()!.revoke(k.id); await loadApiKeys(); }
      catch (e) { setError((e as Error).message); }
    });
    list.appendChild(row);
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
  $("apikeys-back-link")?.addEventListener("click", () => showEditor(false));
  $("apikeys-search")?.addEventListener("input", () => {
    query = (($("apikeys-search") as HTMLInputElement | null)?.value || "").trim();
    render();
  });
  $("apikeys-create-btn")?.addEventListener("click", async () => {
    const input = $("apikeys-label") as HTMLInputElement | null;
    const label = (input?.value || "").trim();
    if (!label) return;
    const t = transport();
    if (!t) { setError(NO_TRANSPORT); return; }
    setError("");
    try {
      const created = await t.create(label);
      if (input) input.value = "";
      const box = $("apikeys-new-token");
      const val = $("apikeys-new-token-value") as HTMLInputElement | null;
      if (box && val) { val.value = created.token; box.classList.remove("hidden"); }
      await loadApiKeys();
    } catch (e) { setError((e as Error).message); }
  });
  $("apikeys-new-token-copy")?.addEventListener("click", () => {
    const val = ($("apikeys-new-token-value") as HTMLInputElement | null)?.value || "";
    void (window as unknown as { glyphh?: { copyToClipboard?: (s: string) => void } }).glyphh?.copyToClipboard?.(val);
    const btn = $("apikeys-new-token-copy") as HTMLButtonElement | null;
    if (btn) { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy"; }, 1600); }
  });
}
