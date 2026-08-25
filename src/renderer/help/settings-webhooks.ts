/**
 * settings-webhooks.ts — the app DATA surfaces, two directions with two names
 * (his model, 2026-08-25):
 *
 *   WEBHOOKS  — OUTBOUND. The user registers a URL; the platform POSTs to it
 *               when the app's data changes (signed: X-Glyphh-Signature).
 *   PIPELINES — INBOUND. A token that authenticates POSTs of { table, rows }
 *               to the app's ingest door — how n8n / make / Boomi seed data in.
 *
 * Rendered in two places with one grammar (search + New + pagination):
 *   • App → edit → Data — this one app's webhooks (left) and pipelines (right).
 *   • Settings → Webhooks — the org admin aggregate across installed apps.
 *
 * Transport — settings-api.ts's law (the renderer never holds an SDK client):
 *   • web     — window.glyphhSdk.apps (checked FIRST; window.glyphh is a
 *               fabricating Proxy on web, so the SDK handle must win).
 *   • desktop — window.glyphh.apps* IPC → the MAIN-process SDK client.
 */

import { escapeHtml, confirmAction, paginate, renderPaginationBar } from "./shared.js";
import { kebabCell, ROW_MENU_ICONS } from "./lib-editor.js";
import { showTokenModal } from "./settings-apikeys.js";

interface IngestTokenRow { id: string; label: string; prefix: string; tokenHint: string; createdAt: string; lastUsedAt: string | null; expiresAt?: string | null; createdByEmail?: string | null }
interface WebhookRow { id: string; url: string; description: string; active: boolean; createdAt: string; createdByEmail: string | null; lastFiredAt: string | null; lastStatus: number | null }
interface AppData { slug: string; name: string; webhooks: WebhookRow[]; tokens: IngestTokenRow[]; pipelineUrl: string }

interface SdkApps {
  installed?: () => Promise<Array<{ slug: string; name: string }>>;
  ingest?: (slug: string) => Promise<{ tokens: IngestTokenRow[]; pipelineUrl?: string }>;
  createIngestToken?: (slug: string, label?: string, expiresDays?: number) => Promise<{ token: string; row: IngestTokenRow }>;
  revokeIngestToken?: (slug: string, id: string) => Promise<unknown>;
  webhooks?: (slug: string) => Promise<{ webhooks: WebhookRow[] }>;
  createWebhook?: (slug: string, input: { url: string; description?: string }) => Promise<{ webhook: { id: string }; secret: string }>;
  removeWebhook?: (slug: string, id: string) => Promise<unknown>;
}
interface DesktopIpc {
  appsIngestInstalled?: () => Promise<{ ok: boolean; apps?: Array<{ slug: string; name: string }>; error?: string }>;
  appsIngestList?: (slug: string) => Promise<{ ok: boolean; tokens?: IngestTokenRow[]; pipelineUrl?: string; error?: string }>;
  appsIngestTokenCreate?: (slug: string, label: string, expiresDays?: number) => Promise<{ ok: boolean; token?: string; row?: IngestTokenRow; error?: string }>;
  appsIngestTokenRevoke?: (slug: string, id: string) => Promise<{ ok: boolean; error?: string }>;
  appsWebhooksList?: (slug: string) => Promise<{ ok: boolean; webhooks?: WebhookRow[]; error?: string }>;
  appsWebhookCreate?: (slug: string, input: { url: string; description?: string }) => Promise<{ ok: boolean; secret?: string; error?: string }>;
  appsWebhookDelete?: (slug: string, id: string) => Promise<{ ok: boolean; error?: string }>;
}

interface Transport {
  installed(): Promise<Array<{ slug: string; name: string }>>;
  ingest(slug: string): Promise<{ tokens: IngestTokenRow[]; pipelineUrl: string }>;
  mint(slug: string, label: string, expiresDays?: number): Promise<{ token: string }>;
  revoke(slug: string, id: string): Promise<void>;
  webhooks(slug: string): Promise<WebhookRow[]>;
  createWebhook(slug: string, input: { url: string; description?: string }): Promise<{ secret: string }>;
  deleteWebhook(slug: string, id: string): Promise<void>;
}

const NO_TRANSPORT = "Webhooks aren't available on this build.";

function transport(): Transport | null {
  const s = (window as unknown as { glyphhSdk?: { apps?: SdkApps } }).glyphhSdk?.apps;
  if (s?.installed && s.ingest && s.createIngestToken && s.revokeIngestToken) {
    return {
      installed: () => s.installed!(),
      ingest: async (slug) => {
        const r = await s.ingest!(slug);
        return { tokens: r.tokens, pipelineUrl: r.pipelineUrl ?? "" };
      },
      mint: (slug, label, expiresDays) => s.createIngestToken!(slug, label, expiresDays),
      revoke: async (slug, id) => { await s.revokeIngestToken!(slug, id); },
      webhooks: async (slug) => {
        if (!s.webhooks) throw new Error("Webhooks aren't available on this build yet — refresh.");
        return (await s.webhooks(slug)).webhooks;
      },
      createWebhook: async (slug, input) => {
        if (!s.createWebhook) throw new Error("Webhooks aren't available on this build yet — refresh.");
        return { secret: (await s.createWebhook(slug, input)).secret };
      },
      deleteWebhook: async (slug, id) => {
        if (!s.removeWebhook) throw new Error("Webhooks aren't available on this build yet — refresh.");
        await s.removeWebhook(slug, id);
      },
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
      if (!r?.ok) throw new Error(r?.error || "Couldn't load pipelines.");
      return { tokens: r.tokens ?? [], pipelineUrl: r.pipelineUrl ?? "" };
    },
    mint: async (slug, label, expiresDays) => {
      const r = await g.appsIngestTokenCreate!(slug, label, expiresDays);
      if (!r?.ok || !r.token) throw new Error(r?.error || "Couldn't create the pipeline.");
      return { token: r.token };
    },
    revoke: async (slug, id) => {
      const r = await g.appsIngestTokenRevoke!(slug, id);
      if (!r?.ok) throw new Error(r?.error || "Couldn't revoke.");
    },
    webhooks: async (slug) => {
      const r = await g.appsWebhooksList?.(slug);
      if (!r?.ok) throw new Error(r?.error || "Couldn't load webhooks.");
      return r.webhooks ?? [];
    },
    createWebhook: async (slug, input) => {
      const r = await g.appsWebhookCreate?.(slug, input);
      if (!r?.ok || !r.secret) throw new Error(r?.error || "Couldn't create the webhook.");
      return { secret: r.secret };
    },
    deleteWebhook: async (slug, id) => {
      const r = await g.appsWebhookDelete?.(slug, id);
      if (!r?.ok) throw new Error(r?.error || "Couldn't delete the webhook.");
    },
  };
}

const $ = (id: string) => document.getElementById(id);

const fmtDay = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

function copyToClipboard(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => {
    const ipc = (window as unknown as { glyphh?: { copyToClipboard?: (s: string) => void } }).glyphh?.copyToClipboard;
    if (typeof ipc === "function") void ipc(text);
  });
}

// ── the shared create modal — SINGLE-WORD labels, description UNDER each ─────

interface ModalField {
  id: string;
  /** One word — "Label", "Endpoint", "Expiration". */
  label: string;
  /** The sentence under the label that actually explains the field. */
  description?: string;
  placeholder?: string;
  required?: boolean;
  /** Present → a select instead of a text input. */
  options?: Array<{ value: string; label: string }>;
}

function dataFormModal(title: string, fields: ModalField[], saveText: string): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    document.querySelectorAll(".yo-modal.wh-form-overlay").forEach((n) => n.remove());
    const overlay = document.createElement("div");
    overlay.className = "yo-modal wh-form-overlay";
    const backdrop = document.createElement("div");
    backdrop.className = "yo-modal-backdrop";
    const panel = document.createElement("div");
    panel.className = "yo-modal-panel";
    panel.style.maxWidth = "440px";

    const head = document.createElement("div");
    head.className = "yo-modal-title";
    head.textContent = title;
    panel.appendChild(head);

    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    for (const f of fields) {
      const lab = document.createElement("label");
      lab.className = "settings-label";
      lab.textContent = f.label;
      panel.appendChild(lab);
      if (f.description) {
        const d = document.createElement("p");
        d.className = "settings-hint";
        d.style.margin = "2px 0 6px";
        d.textContent = f.description;
        panel.appendChild(d);
      }
      if (f.options) {
        const sel = document.createElement("select");
        sel.className = "settings-input";
        for (const o of f.options) {
          const opt = document.createElement("option");
          opt.value = o.value;
          opt.textContent = o.label;
          sel.appendChild(opt);
        }
        inputs.set(f.id, sel);
        panel.appendChild(sel);
      } else {
        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "settings-input";
        inp.placeholder = f.placeholder ?? "";
        inp.spellcheck = false;
        inp.autocomplete = "off";
        inputs.set(f.id, inp);
        panel.appendChild(inp);
      }
    }
    const err = document.createElement("div");
    err.className = "crud-form-error hidden";
    err.style.marginTop = "8px";
    panel.appendChild(err);

    const row = document.createElement("div");
    row.className = "yo-modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "action-btn";
    cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "action-btn primary";
    save.textContent = saveText;
    row.append(cancel, save);
    panel.appendChild(row);

    const close = (value: Record<string, string> | null): void => { overlay.remove(); resolve(value); };
    cancel.addEventListener("click", () => close(null));
    backdrop.addEventListener("click", () => close(null));
    save.addEventListener("click", () => {
      const out: Record<string, string> = {};
      for (const f of fields) {
        const v = (inputs.get(f.id)?.value ?? "").trim();
        if (f.required && !v) {
          err.textContent = `${f.label} is required.`;
          err.classList.remove("hidden");
          return;
        }
        out[f.id] = v;
      }
      close(out);
    });

    overlay.append(backdrop, panel);
    document.body.appendChild(overlay);
    inputs.values().next().value?.focus();
  });
}

/** Same choices the org API-keys form offers ("Never" is a deliberate risk). */
const EXPIRY_OPTIONS: ModalField["options"] = [
  { value: "", label: "Never" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

async function newPipelineModal(t: Transport, slug: string, appName: string): Promise<boolean> {
  const v = await dataFormModal("New pipeline", [
    { id: "label", label: "Label", description: "Which external system holds this token — e.g. n8n production.", placeholder: "n8n production", required: true },
    { id: "expires", label: "Expiration", description: "A token that never expires stays valid until revoked — prefer an expiry." , options: EXPIRY_OPTIONS },
  ], "Create pipeline");
  if (!v) return false;
  const made = await t.mint(slug, v.label ?? "", v.expires ? Number(v.expires) : undefined);
  showTokenModal(`${appName} pipeline token`, made.token);
  return true;
}

async function newWebhookModal(t: Transport, slug: string, appName: string): Promise<boolean> {
  const v = await dataFormModal("New webhook", [
    { id: "url", label: "Endpoint", description: "The URL we POST to when this app's data changes.", placeholder: "https://hooks.example.com/glyphh", required: true },
    { id: "description", label: "Description", description: "What listens on the other end (optional).", placeholder: "Ops Slack notifier" },
  ], "Create webhook");
  if (!v) return false;
  const made = await t.createWebhook(slug, { url: v.url!, ...(v.description ? { description: v.description } : {}) });
  showTokenModal(`${appName} webhook signing secret`, made.secret);
  return true;
}

// ── shared table renderers (one grammar for the app tab and the org page) ────

const PAGE_SIZE = 10;

/** Webhooks: [App] | Endpoint | Created by | Created | Last fired | kebab. */
function renderWebhookTable(
  host: HTMLElement,
  rows: Array<{ app: { slug: string; name: string }; w: WebhookRow }>,
  page: number,
  setPage: (p: number) => void,
  withAppColumn: boolean,
  onDelete: (appSlug: string, appName: string, w: WebhookRow) => void,
): void {
  host.innerHTML = "";
  if (!rows.length) return;
  const table = document.createElement("table");
  table.className = "lib-table mbr-table";
  table.innerHTML = `<thead><tr>${withAppColumn ? "<th>App</th>" : ""}<th>Endpoint</th><th>Created by</th><th>Created</th><th>Last fired</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  const pg = paginate(rows, page, PAGE_SIZE);
  for (const { app, w } of pg.items) {
    const tr = document.createElement("tr");
    // Last fired carries the delivery verdict: 2xx = the timestamp, else failed.
    const fired = w.lastFiredAt
      ? (w.lastStatus && w.lastStatus >= 200 && w.lastStatus < 300 ? fmtDay(w.lastFiredAt) : `${fmtDay(w.lastFiredAt)} · failed (${w.lastStatus || "unreachable"})`)
      : "never";
    tr.innerHTML =
      (withAppColumn ? `<td class="lib-table-name"><span class="wh-app"></span></td>` : "") +
      `<td class="${withAppColumn ? "" : "lib-table-name"} wh-url-cell"><span class="wh-endpoint"></span>${w.description ? `<span class="wh-desc"></span>` : ""}</td>` +
      `<td class="lib-table-dim"><span class="wh-by"></span></td>` +
      `<td class="lib-table-dim">${escapeHtml(fmtDay(w.createdAt))}</td>` +
      `<td class="lib-table-dim">${escapeHtml(fired)}</td>`;
    if (withAppColumn) (tr.querySelector(".wh-app") as HTMLElement).textContent = app.name || app.slug;
    (tr.querySelector(".wh-endpoint") as HTMLElement).textContent = w.url;
    const desc = tr.querySelector(".wh-desc") as HTMLElement | null;
    if (desc) { desc.textContent = w.description; desc.className = "ak-prefix"; }
    (tr.querySelector(".wh-by") as HTMLElement).textContent = w.createdByEmail || "";
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.view, label: "Copy endpoint", onClick: () => copyToClipboard(w.url) },
      { icon: ROW_MENU_ICONS.delete, label: "Delete…", danger: true, onClick: () => onDelete(app.slug, app.name, w) },
    ]));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
  if (pg.state.totalPages > 1) host.appendChild(renderPaginationBar(pg.state, setPage));
}

/** Pipelines: [App] | Pipeline (label + mask) | Created by | Created | Last used | Expires | kebab. */
function renderPipelineTable(
  host: HTMLElement,
  rows: Array<{ app: { slug: string; name: string }; t: IngestTokenRow }>,
  page: number,
  setPage: (p: number) => void,
  withAppColumn: boolean,
  onRevoke: (appSlug: string, appName: string, t: IngestTokenRow) => void,
): void {
  host.innerHTML = "";
  if (!rows.length) return;
  const table = document.createElement("table");
  table.className = "lib-table mbr-table";
  table.innerHTML = `<thead><tr>${withAppColumn ? "<th>App</th>" : ""}<th>Pipeline</th><th>Created by</th><th>Created</th><th>Last used</th><th>Expires</th><th class="lib-row-kebab-cell"></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  const pg = paginate(rows, page, PAGE_SIZE);
  for (const { app, t } of pg.items) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      (withAppColumn ? `<td class="lib-table-name"><span class="pl-app"></span></td>` : "") +
      `<td class="${withAppColumn ? "" : "lib-table-name"}"><span class="pl-label"></span><span class="ak-prefix pl-hint"></span></td>` +
      `<td class="lib-table-dim"><span class="pl-by"></span></td>` +
      `<td class="lib-table-dim">${escapeHtml(fmtDay(t.createdAt))}</td>` +
      `<td class="lib-table-dim">${escapeHtml(t.lastUsedAt ? fmtDay(t.lastUsedAt) : "never")}</td>` +
      `<td class="lib-table-dim">${escapeHtml(t.expiresAt ? fmtDay(t.expiresAt) : "never")}</td>`;
    if (withAppColumn) (tr.querySelector(".pl-app") as HTMLElement).textContent = app.name || app.slug;
    (tr.querySelector(".pl-label") as HTMLElement).textContent = t.label || "(unnamed)";
    (tr.querySelector(".pl-hint") as HTMLElement).textContent = t.tokenHint || t.prefix;
    (tr.querySelector(".pl-by") as HTMLElement).textContent = t.createdByEmail || "";
    tr.appendChild(kebabCell(() => [
      { icon: ROW_MENU_ICONS.delete, label: "Revoke…", danger: true, onClick: () => onRevoke(app.slug, app.name, t) },
    ]));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
  if (pg.state.totalPages > 1) host.appendChild(renderPaginationBar(pg.state, setPage));
}

// ── Settings → Webhooks — the org admin AGGREGATE across installed apps ──────

let wired = false;
let activeTab: "hooks" | "tokens" = "hooks";   // hooks = webhooks (out), tokens = pipelines (in)
let apps: AppData[] = [];
let query = "";
let hookPage = 0;
let tokenPage = 0;

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
function paintTabCounts(webhookCount: number, pipelineCount: number): void {
  const hooksBtn = document.querySelector<HTMLElement>('#webhooks-tabs [data-wtab="hooks"]');
  const tokensBtn = document.querySelector<HTMLElement>('#webhooks-tabs [data-wtab="tokens"]');
  if (hooksBtn) hooksBtn.textContent = webhookCount ? `Webhooks (${webhookCount})` : "Webhooks";
  if (tokensBtn) tokensBtn.textContent = pipelineCount ? `Pipelines (${pipelineCount})` : "Pipelines";
}

function render(): void {
  const hooksList = $("webhooks-hooks-list");
  const tokensList = $("webhooks-tokens-list");
  const empty = $("webhooks-empty");
  if (!hooksList || !tokensList) return;

  const q = query.toLowerCase();
  const webhookRows = apps.flatMap((a) => a.webhooks.map((w) => ({ app: a, w })))
    .filter((r) => !q || `${r.app.name} ${r.app.slug} ${r.w.url} ${r.w.description}`.toLowerCase().includes(q));
  const tokenRows = apps.flatMap((a) => a.tokens.map((t) => ({ app: a, t })))
    .filter((r) => !q || `${r.app.name} ${r.app.slug} ${r.t.label}`.toLowerCase().includes(q));
  paintTabCounts(webhookRows.length, tokenRows.length);

  const activeEmpty = activeTab === "hooks" ? webhookRows.length === 0 : tokenRows.length === 0;
  empty?.classList.toggle("hidden", !activeEmpty);
  if (empty) {
    empty.textContent = q
      ? `Nothing matching "${query}"`
      : activeTab === "hooks"
        ? "No webhooks yet — register one with + New and we POST to it when an app's data changes."
        : "No pipelines yet — create one with + New and point your external system at its door.";
  }

  const t = transport();
  if (!t) return;
  if (activeTab === "hooks") {
    renderWebhookTable(hooksList, webhookRows, hookPage, (p) => { hookPage = p; render(); }, true,
      (appSlug, appName, w) => {
        void (async () => {
          if (!(await confirmAction({
            title: "Delete this webhook?",
            body: `${appName} stops POSTing to ${w.url} immediately.`,
            confirmLabel: "Delete",
            danger: true,
          }))) return;
          try { await t.deleteWebhook(appSlug, w.id); await loadWebhooks(); }
          catch (e) { setError((e as Error).message); }
        })();
      });
  } else {
    renderPipelineTable(tokensList, tokenRows, tokenPage, (p) => { tokenPage = p; render(); }, true,
      (appSlug, appName, tk) => {
        void (async () => {
          if (!(await confirmAction({
            title: `Revoke “${tk.label || "this pipeline"}”?`,
            body: `Anything posting into ${appName} with this token immediately loses access.`,
            confirmLabel: "Revoke",
            danger: true,
          }))) return;
          try { await t.revoke(appSlug, tk.id); await loadWebhooks(); }
          catch (e) { setError((e as Error).message); }
        })();
      });
  }
}

export async function loadWebhooks(): Promise<void> {
  setError("");
  const t = transport();
  if (!t) { apps = []; render(); setError(NO_TRANSPORT); return; }
  try {
    const installed = await t.installed();
    // Per-app reads, best-effort — one broken app must not blank the page.
    const rows = await Promise.all(installed.map(async (a) => {
      const [ing, whs] = await Promise.all([
        t.ingest(a.slug).catch(() => ({ tokens: [] as IngestTokenRow[], pipelineUrl: "" })),
        t.webhooks(a.slug).catch(() => [] as WebhookRow[]),
      ]);
      return { slug: a.slug, name: a.name, webhooks: whs, tokens: ing.tokens, pipelineUrl: ing.pipelineUrl };
    }));
    apps = rows.filter((r) => r.webhooks.length > 0 || r.tokens.length > 0);
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
    void (async () => {
      const t = transport();
      if (!t) { setError(NO_TRANSPORT); return; }
      const installed = await t.installed().catch(() => [] as Array<{ slug: string; name: string }>);
      if (!installed.length) { setError("No installed apps yet."); return; }
      const createFor = (a: { slug: string; name: string }): void => {
        void (async () => {
          try {
            const made = activeTab === "hooks"
              ? await newWebhookModal(t, a.slug, a.name || a.slug)
              : await newPipelineModal(t, a.slug, a.name || a.slug);
            if (made) await loadWebhooks();
          } catch (e) { setError((e as Error).message); }
        })();
      };
      if (installed.length === 1) { createFor(installed[0]!); return; }
      // Several apps → the small anchored picker (the row-menu pattern).
      const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      const menu = document.createElement("div");
      menu.className = "ws-tab-ctx-menu";
      for (const a of installed) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ws-tab-ctx-item";
        b.textContent = a.name || a.slug;
        b.addEventListener("click", () => { menu.remove(); createFor(a); });
        menu.appendChild(b);
      }
      document.body.appendChild(menu);
      menu.style.left = `${Math.max(6, r.right - menu.getBoundingClientRect().width)}px`;
      menu.style.top = `${r.bottom + 4}px`;
      const away = (e: MouseEvent): void => {
        if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener("mousedown", away, true); }
      };
      document.addEventListener("mousedown", away, true);
    })();
  });
}

// ── App → edit → Data — this ONE app's webhooks (left) and pipelines (right) ──

let appWebhookPage = 0;
let appPipelinePage = 0;
let appWebhookQuery = "";
let appPipelineQuery = "";

export async function renderAppData(slug: string, appName: string): Promise<void> {
  const webhooksEl = $("app-data-webhooks");
  const pipelinesEl = $("app-data-pipelines");
  const errEl = $("app-data-error");
  if (!webhooksEl || !pipelinesEl) return;
  const say = (msg: string): void => {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.classList.toggle("hidden", !msg);
  };
  say("");
  const t = transport();
  if (!t) { say(NO_TRANSPORT); return; }
  let webhooks: WebhookRow[] = [];
  let tokens: IngestTokenRow[] = [];
  let pipelineUrl = "";
  try {
    const [whs, ing] = await Promise.all([t.webhooks(slug), t.ingest(slug)]);
    webhooks = whs;
    tokens = ing.tokens;
    pipelineUrl = ing.pipelineUrl;
  } catch (e) { say((e as Error).message); return; }

  // The pipeline door — the one URL every pipeline POSTs { table, rows } to.
  const urlEl = $("app-data-pipeline-url");
  if (urlEl) urlEl.textContent = pipelineUrl;
  $("app-data-pipeline-url-copy")?.addEventListener("click", () => copyToClipboard(pipelineUrl), { once: true });

  const paint = (): void => {
    const wq = appWebhookQuery.toLowerCase();
    const wRows = webhooks.filter((w) => !wq || `${w.url} ${w.description}`.toLowerCase().includes(wq))
      .map((w) => ({ app: { slug, name: appName }, w }));
    renderWebhookTable(webhooksEl, wRows, appWebhookPage, (p) => { appWebhookPage = p; paint(); }, false,
      (appSlug, name, w) => {
        void (async () => {
          if (!(await confirmAction({
            title: "Delete this webhook?",
            body: `${name} stops POSTing to ${w.url} immediately.`,
            confirmLabel: "Delete",
            danger: true,
          }))) return;
          try { await t.deleteWebhook(appSlug, w.id); await renderAppData(slug, appName); }
          catch (e) { say((e as Error).message); }
        })();
      });
    if (!wRows.length) {
      webhooksEl.innerHTML = `<div class="crud-empty">${webhooks.length ? `Nothing matching "${escapeHtml(appWebhookQuery)}"` : "No webhooks yet — register a URL and we POST to it when this app's data changes."}</div>`;
    }

    const pq = appPipelineQuery.toLowerCase();
    const pRows = tokens.filter((tk) => !pq || (tk.label || "").toLowerCase().includes(pq))
      .map((tk) => ({ app: { slug, name: appName }, t: tk }));
    renderPipelineTable(pipelinesEl, pRows, appPipelinePage, (p) => { appPipelinePage = p; paint(); }, false,
      (appSlug, name, tk) => {
        void (async () => {
          if (!(await confirmAction({
            title: `Revoke “${tk.label || "this pipeline"}”?`,
            body: `Anything posting into ${name} with this token immediately loses access.`,
            confirmLabel: "Revoke",
            danger: true,
          }))) return;
          try { await t.revoke(appSlug, tk.id); await renderAppData(slug, appName); }
          catch (e) { say((e as Error).message); }
        })();
      });
    if (!pRows.length) {
      pipelinesEl.innerHTML = `<div class="crud-empty">${tokens.length ? `Nothing matching "${escapeHtml(appPipelineQuery)}"` : "No pipelines yet — create one and point your external system at the door above."}</div>`;
    }
  };
  paint();

  const wireSearch = (id: string, apply: (v: string) => void): void => {
    const input = $(id) as HTMLInputElement | null;
    if (input && !input.dataset.wired) {
      input.dataset.wired = "1";
      input.addEventListener("input", () => { apply(input.value.trim()); paint(); });
    }
  };
  wireSearch("app-data-webhooks-search", (v) => { appWebhookQuery = v; appWebhookPage = 0; });
  wireSearch("app-data-pipelines-search", (v) => { appPipelineQuery = v; appPipelinePage = 0; });

  const wireNew = (id: string, open: () => Promise<boolean>): void => {
    const btn = $(id) as HTMLButtonElement | null;
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => {
        void (async () => {
          try { if (await open()) await renderAppData(slug, appName); }
          catch (e) { say((e as Error).message); }
        })();
      });
    }
  };
  wireNew("app-data-new-webhook", () => newWebhookModal(t, slug, appName));
  wireNew("app-data-new-pipeline", () => newPipelineModal(t, slug, appName));
}
