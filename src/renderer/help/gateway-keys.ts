/**
 * gateway-keys.ts — Gateway › API Keys (platform, org_admin).
 *
 * The keys the gateway HANDS OUT (his ruling, 2026-09-11): each key is a
 * router virtual key minted against ONE role — the role fixes the model list
 * and whose vendor credential burns underneath — named, with its own expiry.
 * The pre-purge Settings › API Keys grammar (aa04a2cc^): list ⇄ inline create
 * form, the one-time token modal with the copy ladder, never-expiry warning,
 * kebab revoke. Revoked keys STAY in the list — telemetry outlives the key.
 */

import { escapeHtml, confirmAction, promptAction, paginate, renderPaginationBar } from "./shared.js";
import { gateSurface } from "./plan-gate.js";
import { kebabCell, ROW_MENU_ICONS } from "./lib-editor.js";

interface GatewayKey {
  id: string;
  name: string;
  workspaceId: string;
  tokenHint: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
interface MintedGatewayKey { key: GatewayKey; token: string }
interface WorkspaceLite { id: string; name: string }

interface SdkGatewayKeys {
  gateway?: {
    keys?: () => Promise<GatewayKey[]>;
    createKey?: (input: { name: string; workspaceId: string; days?: number }) => Promise<MintedGatewayKey>;
    revokeKey?: (id: string) => Promise<void>;
    myKeys?: () => Promise<{ allowed: boolean; reason: string; keys: GatewayKey[] }>;
    mintMyKey?: (name: string, days?: number) => Promise<MintedGatewayKey>;
    revokeMyKey?: (id: string) => Promise<void>;
    memberKeysEnabled?: () => Promise<{ enabled: boolean }>;
    setMemberKeysEnabled?: (enabled: boolean) => Promise<{ enabled: boolean }>;
  };
  workspaces?: { list?: () => Promise<WorkspaceLite[]> };
}

const $ = (id: string) => document.getElementById(id);

const sdk = (): SdkGatewayKeys | null =>
  (window as unknown as { glyphhSdk?: SdkGatewayKeys }).glyphhSdk ?? null;

type IpcEnvelope = { ok: boolean; data?: unknown; error?: string };
const ipc = (): Record<string, ((...a: unknown[]) => Promise<IpcEnvelope>) | undefined> =>
  (window as unknown as { glyphh?: Record<string, ((...a: unknown[]) => Promise<IpcEnvelope>) | undefined> }).glyphh ?? {};

function setError(msg: string): void {
  const el = $("gwk-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

async function via<T>(web: (s: SdkGatewayKeys) => Promise<T> | undefined, method: string, ...args: unknown[]): Promise<T | null> {
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

/** The copy ladder shared by the token modal: browser-native → IPC → execCommand. */
async function copyText(val: string, input?: HTMLInputElement | null): Promise<boolean> {
  try { await navigator.clipboard.writeText(val); return true; } catch { /* fall through */ }
  const bridge = (window as unknown as { glyphh?: { copyToClipboard?: (s: string) => void } }).glyphh?.copyToClipboard;
  if (bridge) { void bridge(val); return true; }
  if (input) { input.focus(); input.select(); return document.execCommand("copy"); }
  return false;
}

/** After a mint: back on the list, the ONE-TIME token in a modal with the
 *  warning and a copy button (the aa04a2cc^ grammar, verbatim). */
function showTokenModal(label: string, token: string): void {
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
    void copyText(token, input).then((okGo) => {
      copy.textContent = okGo ? "Copied" : "Select + ⌘C";
      setTimeout(() => { copy.textContent = "Copy"; }, 1800);
    });
  });
  row.append(input, copy);
  const hint = document.createElement("p");
  hint.className = "settings-hint";
  hint.innerHTML = `Point your client at <code>https://router.glyphh.ai</code> with this key as the bearer.`;
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
  panel.append(head, warn, row, hint, actions);
  const close = (): void => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", close);
  done.addEventListener("click", close);
  overlay.append(backdrop, panel);
  document.body.appendChild(overlay);
  input.focus();
}

let keys: GatewayKey[] = [];
let roleNames = new Map<string, string>();
let wired = false;
let query = "";
const PAGE_SIZE = 15;
let page = 0;

function showEditor(open: boolean): void {
  $("gwk-list-view")?.classList.toggle("hidden", open);
  $("gwk-editor")?.classList.toggle("hidden", !open);
  if (open) {
    const input = $("gwk-name") as HTMLInputElement | null;
    if (input) { input.value = ""; input.focus(); }
    const exp = $("gwk-expires") as HTMLSelectElement | null;
    if (exp) exp.value = "30";
    syncNeverWarn();
    $("gwk-form-error")?.classList.add("hidden");
  }
}

/** "Never" is a real risk choice — the warn banner shows while it's selected. */
function syncNeverWarn(): void {
  const exp = $("gwk-expires") as HTMLSelectElement | null;
  $("gwk-never-warn")?.classList.toggle("hidden", !!exp?.value);
}

const fmtDay = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

/** Revoked beats expired beats active — the honest status line. */
function statusOf(k: GatewayKey): { label: string; dim: boolean } {
  if (k.revokedAt) return { label: `Revoked ${fmtDay(k.revokedAt)}`, dim: true };
  if (k.expiresAt && Date.parse(k.expiresAt) < Date.now()) return { label: `Expired ${fmtDay(k.expiresAt)}`, dim: true };
  if (k.expiresAt) return { label: `Expires ${fmtDay(k.expiresAt)}`, dim: false };
  return { label: "Never expires", dim: false };
}

function render(): void {
  const list = $("gwk-list");
  const empty = $("gwk-empty");
  if (!list) return;
  const q = query.toLowerCase();
  const shown = q
    ? keys.filter((k) => `${k.name} ${k.tokenHint} ${roleNames.get(k.workspaceId) || ""}`.toLowerCase().includes(q))
    : keys;
  empty?.classList.toggle("hidden", shown.length > 0);
  if (empty) empty.textContent = keys.length === 0 ? "No keys yet." : `No keys matching "${query}"`;
  list.innerHTML = "";
  if (!shown.length) return;

  const table = document.createElement("table");
  table.className = "lib-table";
  table.innerHTML = `<thead><tr><th>Key</th><th>Role</th><th>Created</th><th>Status</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  const pg = paginate(shown, page, PAGE_SIZE);
  page = pg.state.page;
  for (const k of pg.items) {
    const st = statusOf(k);
    const tr = document.createElement("tr");
    if (st.dim) tr.style.opacity = "0.55";
    tr.innerHTML =
      `<td class="lib-table-name"><span class="ak-name"></span><span class="ak-prefix"></span></td>` +
      `<td class="lib-table-desc"></td>` +
      `<td class="lib-table-dim">${escapeHtml(fmtDay(k.createdAt))}</td>` +
      `<td class="lib-table-dim">${escapeHtml(st.label)}</td>`;
    (tr.querySelector(".ak-name") as HTMLElement).textContent = k.name || "(unnamed)";
    (tr.querySelector(".ak-prefix") as HTMLElement).textContent = k.tokenHint;
    (tr.querySelector(".lib-table-desc") as HTMLElement).textContent = roleNames.get(k.workspaceId) || k.workspaceId;
    if (!k.revokedAt) {
      tr.appendChild(kebabCell(() => [
        { icon: ROW_MENU_ICONS.delete, label: "Revoke", danger: true, onClick: () => {
          void (async () => {
            if (!(await confirmAction({
              title: `Revoke “${k.name || "this key"}”?`,
              body: "Any client using this key immediately loses access. The key stays listed — its metrics live on.",
              confirmLabel: "Revoke",
              danger: true,
            }))) return;
            try {
              await via<unknown>((c) => c.gateway?.revokeKey?.(k.id)?.then(() => ({ ok: true })), "gatewayKeysRevoke", k.id);
              await loadGatewayKeys();
            } catch (e) { setError((e as Error).message); }
          })();
        } },
      ]));
    } else {
      const td = document.createElement("td");
      td.className = "lib-row-kebab-cell";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  list.appendChild(table);
  if (pg.state.totalPages > 1) {
    list.appendChild(renderPaginationBar(pg.state, (p) => { page = p; render(); }));
  }
}

async function loadRoles(): Promise<void> {
  const rows = await via<WorkspaceLite[]>((c) => c.workspaces?.list?.(), "workspacesList").catch(() => null);
  roleNames = new Map((rows ?? []).map((w) => [w.id, w.name]));
  const sel = $("gwk-role") as HTMLSelectElement | null;
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = "";
  for (const w of rows ?? []) {
    const opt = document.createElement("option");
    opt.value = w.id;
    opt.textContent = w.name;
    sel.appendChild(opt);
  }
  if (current) sel.value = current;
}

export async function loadGatewayKeys(): Promise<void> {
  // LICENSE first (his order, 2026-09-12: keys + metrics gate like every other
  // paid surface — same banner, same Billing door). Locked still paints the
  // page inert below the note; the server's E_ENTITLEMENT holds regardless.
  void gateSurface(document.querySelector<HTMLElement>('.settings-panel[data-sub="gateway-keys"]'),
    "gateway", "The gateway");
  const account = await window.glyphh.getAccountInfo().catch(() => null);
  const admin = !!account?.role && ["org_admin", "admin", "super_admin"].includes(account.role);
  // MEMBERS get their own keys view (his ruling, 2026-09-12) — never the
  // admin-only wall when the doors are open.
  $("gwk-admin-only")?.classList.add("hidden");
  $("gwk-member-view")?.classList.toggle("hidden", admin);
  $("gwk-list-view")?.classList.toggle("hidden", !admin);
  if (!admin) { await loadMemberKeys(); return; }
  initGatewayKeys();
  setError("");
  try {
    const [rows, memberSwitch] = await Promise.all([
      via<GatewayKey[]>((c) => c.gateway?.keys?.(), "gatewayKeysList"),
      via<{ enabled: boolean }>((c) => c.gateway?.memberKeysEnabled?.(), "gatewayMemberKeysEnabled").catch(() => null),
      loadRoles(),
    ]);
    const sw = $("gwk-member-switch") as HTMLInputElement | null;
    if (sw) {
      sw.checked = !!memberSwitch?.enabled;
      if (!sw.dataset.wired) {
        sw.dataset.wired = "1";
        sw.addEventListener("change", () => {
          void via((c) => c.gateway?.setMemberKeysEnabled?.(sw.checked), "gatewaySetMemberKeys", sw.checked)
            .catch((e) => { sw.checked = !sw.checked; setError(e instanceof Error ? e.message : String(e)); });
        });
      }
    }
    keys = rows ?? [];
    render();
  } catch (e) {
    keys = [];
    render();
    setError(`Couldn't load the keys — ${(e as Error).message}`);
  }
}

function initGatewayKeys(): void {
  if (wired) return;
  wired = true;
  $("gwk-new-btn")?.addEventListener("click", () => showEditor(true));
  $("gwk-expires")?.addEventListener("change", syncNeverWarn);
  $("gwk-back-link")?.addEventListener("click", () => showEditor(false));
  $("gwk-cancel-btn")?.addEventListener("click", () => showEditor(false));
  $("gwk-search")?.addEventListener("input", () => {
    query = (($("gwk-search") as HTMLInputElement | null)?.value || "").trim();
    page = 0;
    render();
  });
  const formError = (msg: string): void => {
    const el = $("gwk-form-error");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("hidden", !msg);
  };
  $("gwk-create-btn")?.addEventListener("click", () => {
    void (async () => {
      const input = $("gwk-name") as HTMLInputElement | null;
      const name = (input?.value || "").trim();
      if (!name) { formError("Give the key a name."); input?.focus(); return; }
      const workspaceId = ($("gwk-role") as HTMLSelectElement | null)?.value || "";
      if (!workspaceId) { formError("Pick the role this key acts as."); return; }
      const days = parseInt(($("gwk-expires") as HTMLSelectElement | null)?.value || "", 10);
      formError("");
      try {
        const minted = await via<MintedGatewayKey>(
          (c) => c.gateway?.createKey?.({ name, workspaceId, ...(Number.isFinite(days) && days > 0 ? { days } : {}) }),
          "gatewayKeysCreate", { name, workspaceId, ...(Number.isFinite(days) && days > 0 ? { days } : {}) });
        if (!minted) { formError("Couldn't create the key."); return; }
        await loadGatewayKeys();
        showEditor(false);
        showTokenModal(minted.key.name, minted.token);
      } catch (e) { formError((e as Error).message); }
    })();
  });
}

// ── The MEMBER view: your own keys (his ruling, 2026-09-12) ─────────────────
async function loadMemberKeys(): Promise<void> {
  const blocked = $("gwk-member-blocked");
  const open = $("gwk-member-open");
  let mine: { allowed: boolean; reason: string; keys: GatewayKey[] } | null = null;
  try {
    mine = await via<{ allowed: boolean; reason: string; keys: GatewayKey[] }>(
      (c) => c.gateway?.myKeys?.(), "gatewayMyKeys");
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    return;
  }
  const allowed = !!mine?.allowed;
  blocked?.classList.toggle("hidden", allowed);
  open?.classList.toggle("hidden", !allowed);
  if (!allowed) {
    if (blocked) blocked.textContent = mine?.reason || "Member API keys are not available.";
    return;
  }
  const list = $("gwk-member-list");
  const empty = $("gwk-member-empty");
  const rows = (mine?.keys ?? []).filter((k) => !k.revokedAt);
  empty?.classList.toggle("hidden", rows.length > 0);
  if (list) {
    list.innerHTML = "";
    for (const k of rows) {
      const row = document.createElement("div");
      row.className = "crud-row";
      row.innerHTML = `<div class="crud-cell" style="flex:1;"><b></b> <span class="mdl-hint"></span></div>
        <button class="action-btn" data-revoke type="button">Revoke</button>`;
      (row.querySelector("b") as HTMLElement).textContent = k.name;
      (row.querySelector(".mdl-hint") as HTMLElement).textContent =
        `${k.tokenHint ?? ""}${k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : " · never expires"}`;
      row.querySelector("[data-revoke]")?.addEventListener("click", () => {
        void confirmAction({ title: `Revoke ${k.name}?`, body: "Anything using this key stops working immediately.", confirmLabel: "Revoke", danger: true })
          .then(async (yes) => {
            if (!yes) return;
            await via((c) => c.gateway?.revokeMyKey?.(k.id), "gatewayRevokeMyKey", k.id);
            await loadMemberKeys();
          })
          .catch((e) => setError(e instanceof Error ? e.message : String(e)));
      });
      list.appendChild(row);
    }
  }
  const btn = $("gwk-member-new");
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => {
      void promptAction("New API key — name it", "", "e.g. my laptop", "Mint")
        .then(async (name) => {
          if (!name) return;
          const minted = await via<MintedGatewayKey>((c) => c.gateway?.mintMyKey?.(name), "gatewayMintMyKey", name);
          if (minted) showTokenModal(minted.key.name, minted.token);
          await loadMemberKeys();
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    });
  }
}
