/**
 * settings-webhooks.ts — Settings › Webhooks (beside API Keys).
 *
 * The org's INBOUND app webhooks in one place: every installed app that
 * declares ingest hooks, each hook's public URL (copyable — what you paste
 * into n8n / make.com / Boomi), and the per-app `gy_ing_` tokens that
 * authenticate those POSTs (mint shows the raw token once — the API-keys
 * modal — revoke via the kebab with a confirm).
 *
 * Transport — settings-api.ts's law (the renderer never holds an SDK client):
 *   • web     — window.glyphhSdk.apps (checked FIRST; window.glyphh is a
 *               fabricating Proxy on web, so the SDK handle must win).
 *   • desktop — window.glyphh.appsIngest* → the MAIN-process SDK client.
 */

import { escapeHtml, confirmAction, paginate, renderPaginationBar } from "./shared.js";
import { kebabCell, ROW_MENU_ICONS } from "./lib-editor.js";
import { showTokenModal } from "./settings-apikeys.js";

interface IngestHookRow { name: string; table: string; embed: string[]; description?: string; url: string }
interface IngestTokenRow { id: string; label: string; prefix: string; tokenHint: string; createdAt: string; lastUsedAt: string | null }
interface AppHooks { slug: string; name: string; hooks: IngestHookRow[]; tokens: IngestTokenRow[] }

interface SdkApps {
  installed?: () => Promise<Array<{ slug: string; name: string }>>;
  ingest?: (slug: string) => Promise<{ hooks: IngestHookRow[]; tokens: IngestTokenRow[] }>;
  createIngestToken?: (slug: string, label?: string) => Promise<{ token: string; row: IngestTokenRow }>;
  revokeIngestToken?: (slug: string, id: string) => Promise<unknown>;
}
interface DesktopIpc {
  appsIngestInstalled?: () => Promise<{ ok: boolean; apps?: Array<{ slug: string; name: string }>; error?: string }>;
  appsIngestList?: (slug: string) => Promise<{ ok: boolean; hooks?: IngestHookRow[]; tokens?: IngestTokenRow[]; error?: string }>;
  appsIngestTokenCreate?: (slug: string, label: string) => Promise<{ ok: boolean; token?: string; row?: IngestTokenRow; error?: string }>;
  appsIngestTokenRevoke?: (slug: string, id: string) => Promise<{ ok: boolean; error?: string }>;
}

interface Transport {
  installed(): Promise<Array<{ slug: string; name: string }>>;
  ingest(slug: string): Promise<{ hooks: IngestHookRow[]; tokens: IngestTokenRow[] }>;
  mint(slug: string, label: string): Promise<{ token: string; row: IngestTokenRow }>;
  revoke(slug: string, id: string): Promise<void>;
}

const NO_TRANSPORT = "Webhooks aren't available on this build.";

function transport(): Transport | null {
  const s = (window as unknown as { glyphhSdk?: { apps?: SdkApps } }).glyphhSdk?.apps;
  if (s?.installed && s.ingest && s.createIngestToken && s.revokeIngestToken) {
    return {
      installed: () => s.installed!(),
      ingest: (slug) => s.ingest!(slug),
      mint: (slug, label) => s.createIngestToken!(slug, label),
      revoke: async (slug, id) => { await s.revokeIngestToken!(slug, id); },
    };
  }
  const g = (window as unknown as { glyphh?: DesktopIpc }).glyphh;
  if (!g?.appsIngestInstalled || !g.appsIngestList || !g.appsIngestTokenCreate || !g.appsIngestTokenRevoke) return null;
  return {
    installed: async () => {
      const r = await g.appsIngestInstalled!();
      if (!r?.ok) throw new Error(r?.error || "Couldn't list apps.");
      return r.apps ?? [];
    },
    ingest: async (slug) => {
      const r = await g.appsIngestList!(slug);
      if (!r?.ok) throw new Error(r?.error || "Couldn't load hooks.");
      return { hooks: r.hooks ?? [], tokens: r.tokens ?? [] };
    },
    mint: async (slug, label) => {
      const r = await g.appsIngestTokenCreate!(slug, label);
      if (!r?.ok || !r.token || !r.row) throw new Error(r?.error || "Couldn't create the token.");
      return { token: r.token, row: r.row };
    },
    revoke: async (slug, id) => {
      const r = await g.appsIngestTokenRevoke!(slug, id);
      if (!r?.ok) throw new Error(r?.error || "Couldn't revoke.");
    },
  };
}

const $ = (id: string) => document.getElementById(id);
let wired = false;
let activeTab: "hooks" | "tokens" = "hooks";
let apps: AppHooks[] = [];
let query = "";
const PAGE_SIZE = 10;
let hookPage = 0;
let tokenPage = 0;

const fmtDay = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

function setError(msg: string): void {
  const el = $("webhooks-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function setTab(tab: "hooks" | "tokens"): void {
  activeTab = tab;
  document.querySelectorAll<HTMLElement>('#webhooks-tabs .app-detail-tab').forEach((b) => {
    b.classList.toggle("active", b.dataset.wtab === tab);
  });
  $("webhooks-hooks-list")?.classList.toggle("hidden", tab !== "hooks");
  $("webhooks-tokens-list")?.classList.toggle("hidden", tab !== "tokens");
  render();
}

/** Tab labels carry live counts — the Invited-tab pattern on Members. */
function paintTabCounts(hookCount: number, tokenCount: number): void {
  const hooksBtn = document.querySelector<HTMLElement>('#webhooks-tabs [data-wtab="hooks"]');
  const tokensBtn = document.querySelector<HTMLElement>('#webhooks-tabs [data-wtab="tokens"]');
  if (hooksBtn) hooksBtn.textContent = hookCount ? `Hooks (${hookCount})` : "Hooks";
  if (tokensBtn) tokensBtn.textContent = tokenCount ? `Tokens (${tokenCount})` : "Tokens";
}

function render(): void {
  const hooksList = $("webhooks-hooks-list");
  const tokensList = $("webhooks-tokens-list");
  const empty = $("webhooks-empty");
  if (!hooksList || !tokensList) return;

  const q = query.toLowerCase();
  const hookRows = apps.flatMap((a) => a.hooks.map((hk) => ({ app: a, hk })))
    .filter((r) => !q || `${r.app.name} ${r.app.slug} ${r.hk.name} ${r.hk.table}`.toLowerCase().includes(q));
  const tokenRows = apps.flatMap((a) => a.tokens.map((t) => ({ app: a, t })))
    .filter((r) => !q || `${r.app.name} ${r.app.slug} ${r.t.label}`.toLowerCase().includes(q));
  paintTabCounts(hookRows.length, tokenRows.length);

  const activeEmpty = activeTab === "hooks" ? hookRows.length === 0 : tokenRows.length === 0;
  empty?.classList.toggle("hidden", !activeEmpty);
  if (empty) {
    empty.textContent = apps.length === 0
      ? "No installed app declares ingest hooks yet — add ingest: [{ name, table }] to an app's manifest and release it."
      : q ? `Nothing matching "${query}"` : (activeTab === "tokens" ? "No tokens yet — mint one with + New token." : "No hooks declared.");
  }

  // ── Hooks: App / Hook / Table / URL / kebab (Copy URL) ──
  hooksList.innerHTML = "";
  if (hookRows.length && activeTab === "hooks") {
    const table = document.createElement("table");
    table.className = "lib-table mbr-table";
    table.innerHTML = `<thead><tr><th>App</th><th>Hook</th><th>Table</th><th>URL</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    const pg = paginate(hookRows, hookPage, PAGE_SIZE);
    hookPage = pg.state.page;
    for (const { app, hk } of pg.items) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="lib-table-name"><span class="wh-app"></span></td>` +
        `<td><span class="wh-hook"></span></td>` +
        `<td class="lib-table-dim"><span class="wh-table"></span></td>` +
        `<td class="lib-table-dim wh-url-cell"><code class="wh-url"></code></td>`;
      (tr.querySelector(".wh-app") as HTMLElement).textContent = app.name || app.slug;
      (tr.querySelector(".wh-hook") as HTMLElement).textContent = hk.name;
      (tr.querySelector(".wh-table") as HTMLElement).textContent = hk.table + (hk.embed?.length ? ` · embeds ${hk.embed.join(", ")}` : "");
      (tr.querySelector(".wh-url") as HTMLElement).textContent = hk.url;
      tr.appendChild(kebabCell(() => [
        { icon: ROW_MENU_ICONS.view, label: "Copy URL", onClick: () => {
          void navigator.clipboard.writeText(hk.url).catch(() => {
            const ipc = (window as unknown as { glyphh?: { copyToClipboard?: (s: string) => void } }).glyphh?.copyToClipboard;
            if (typeof ipc === "function") void ipc(hk.url);
          });
        } },
      ]));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    hooksList.appendChild(table);
    if (pg.state.totalPages > 1) hooksList.appendChild(renderPaginationBar(pg.state, (p) => { hookPage = p; render(); }));
  }

  // ── Tokens: App / Label / Key / Created / Last used / kebab (Revoke…) ──
  tokensList.innerHTML = "";
  if (tokenRows.length && activeTab === "tokens") {
    const table = document.createElement("table");
    table.className = "lib-table mbr-table";
    table.innerHTML = `<thead><tr><th>App</th><th>Label</th><th>Key</th><th>Created</th><th>Last used</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    const pg = paginate(tokenRows, tokenPage, PAGE_SIZE);
    tokenPage = pg.state.page;
    for (const { app, t } of pg.items) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="lib-table-name"><span class="wh-tk-app"></span></td>` +
        `<td><span class="wh-tk-label"></span></td>` +
        `<td class="lib-table-dim"><span class="wh-tk-hint"></span></td>` +
        `<td class="lib-table-dim">${escapeHtml(fmtDay(t.createdAt))}</td>` +
        `<td class="lib-table-dim">${escapeHtml(t.lastUsedAt ? fmtDay(t.lastUsedAt) : "never")}</td>`;
      (tr.querySelector(".wh-tk-app") as HTMLElement).textContent = app.name || app.slug;
      (tr.querySelector(".wh-tk-label") as HTMLElement).textContent = t.label || "(unnamed)";
      (tr.querySelector(".wh-tk-hint") as HTMLElement).textContent = t.tokenHint || t.prefix;
      tr.appendChild(kebabCell(() => [
        { icon: ROW_MENU_ICONS.delete, label: "Revoke…", danger: true, onClick: () => {
          void (async () => {
            if (!(await confirmAction({
              title: `Revoke “${t.label || "this token"}”?`,
              body: `Any pipeline posting to ${app.name || app.slug} with this token immediately loses access.`,
              confirmLabel: "Revoke",
              danger: true,
            }))) return;
            try { await transport()!.revoke(app.slug, t.id); await loadWebhooks(); }
            catch (e) { setError((e as Error).message); }
          })();
        } },
      ]));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tokensList.appendChild(table);
    if (pg.state.totalPages > 1) tokensList.appendChild(renderPaginationBar(pg.state, (p) => { tokenPage = p; render(); }));
  }
}

export async function loadWebhooks(): Promise<void> {
  setError("");
  const t = transport();
  if (!t) { apps = []; render(); setError(NO_TRANSPORT); return; }
  try {
    const installed = await t.installed();
    // Only apps that DECLARE hooks appear; each read is per app, best-effort.
    const rows = await Promise.all(installed.map(async (a) => {
      try {
        const r = await t.ingest(a.slug);
        return { slug: a.slug, name: a.name, hooks: r.hooks, tokens: r.tokens };
      } catch { return { slug: a.slug, name: a.name, hooks: [], tokens: [] }; }
    }));
    apps = rows.filter((r) => r.hooks.length > 0 || r.tokens.length > 0);
  } catch (e) {
    apps = [];
    setError(`Couldn't load webhooks — ${(e as Error).message}`);
  }
  render();
}

export function initWebhooksPanel(): void {
  if (wired) return;
  wired = true;
  document.querySelectorAll<HTMLElement>('#webhooks-tabs .app-detail-tab').forEach((b) => {
    b.addEventListener("click", () => setTab((b.dataset.wtab as "hooks" | "tokens") || "hooks"));
  });
  $("webhooks-search")?.addEventListener("input", () => {
    query = (($("webhooks-search") as HTMLInputElement | null)?.value || "").trim();
    hookPage = 0;
    tokenPage = 0;
    render();
  });
  $("webhooks-new-btn")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const withHooks = apps.filter((a) => a.hooks.length > 0);
    if (!withHooks.length) { setError("No installed app declares ingest hooks yet."); return; }
    // One app declaring hooks → mint straight away; several → a small picker
    // via confirmAction is clumsy, so a prompt-less default: first app when
    // one, else the row-menu pattern anchored to the button.
    const mintFor = (a: AppHooks): void => {
      void (async () => {
        try {
          const made = await transport()!.mint(a.slug, "");
          await loadWebhooks();
          showTokenModal(`${a.name || a.slug} webhook token`, made.token);
        } catch (e) { setError((e as Error).message); }
      })();
    };
    if (withHooks.length === 1) { mintFor(withHooks[0]!); return; }
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "ws-tab-ctx-menu";
    for (const a of withHooks) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ws-tab-ctx-item";
      b.textContent = a.name || a.slug;
      b.addEventListener("click", () => { menu.remove(); mintFor(a); });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    menu.style.left = `${Math.max(6, r.right - menu.getBoundingClientRect().width)}px`;
    menu.style.top = `${r.bottom + 4}px`;
    const away = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener("mousedown", away, true); }
    };
    document.addEventListener("mousedown", away, true);
  });
}
