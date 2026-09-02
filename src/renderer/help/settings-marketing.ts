/**
 * settings-marketing.ts — Marketing › Links (his order, 2026-09-02), on the
 * shared list-page scaffold: the org's campaign links, each a target URL with
 * its ?glm=<code> applied. The apex edge attributes clicks and whole sessions
 * back to the code, so every row carries its window stats. Create = name +
 * target URL (any page on the org's domains, or a published app address).
 * All writes ride window.glyphh (desktop IPC / web SDK shim). Admin-gated.
 */

import { mountListPage, type ListPageHandle, type EditCtx } from "./settings-list-page.js";

const $ = (id: string) => document.getElementById(id);
const esc = (v: unknown): string =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmtInt = (n: number): string => Math.max(0, Math.round(n || 0)).toLocaleString();

type LinkRow = {
  id: string; code: string; name: string; targetUrl: string; url: string;
  appId: string | null; archived: boolean; createdAt: string;
  clicks: number; sessions: number; bounced: number; durationMsSum: number;
};

const bounceOf = (l: LinkRow): string =>
  l.sessions > 0 ? `${Math.round((l.bounced / l.sessions) * 100)}%` : "—";

const COPY_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

function renderEdit(l: LinkRow, body: HTMLElement, ctx: EditCtx): void {
  body.innerHTML = `
    <div class="lp-sec">
      <label class="settings-label">Campaign URL</label>
      <p class="section-desc" style="margin:4px 0 8px;">Share this anywhere — every click and the whole visit it starts count toward this link.</p>
      <div style="display:flex;align-items:center;gap:8px;">
        <code style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;" id="mkt-edit-url">${esc(l.url)}</code>
        <button class="action-btn" type="button" id="mkt-copy" style="height:24px;width:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;" title="Copy">${COPY_SVG}</button>
      </div>
    </div>
    <div class="lp-sec">
      <label class="settings-label">This window</label>
      <p class="settings-hint" style="margin:6px 0 0;">${fmtInt(l.clicks)} clicks · ${fmtInt(l.sessions)} sessions · ${bounceOf(l)} bounce</p>
    </div>
    <div class="lp-sec">
      <label class="settings-toggle" style="margin:0;">
        <input id="mkt-t-archived" type="checkbox" ${l.archived ? "checked" : ""} />
        <span class="toggle-switch"></span>
        <span class="toggle-info">
          <span class="toggle-title">Archived</span>
          <span class="toggle-desc">Hidden from day-to-day use. The URL keeps working — archive is bookkeeping, not a kill switch.</span>
        </span>
      </label>
    </div>`;
  body.querySelector<HTMLButtonElement>("#mkt-copy")?.addEventListener("click", () => {
    void navigator.clipboard?.writeText(l.url);
  });
  ctx.onSave(async () => {
    const archived = !!body.querySelector<HTMLInputElement>("#mkt-t-archived")?.checked;
    const r = await window.glyphh.marketingLinkUpdate(l.id, { archived });
    return r.ok ? { ok: true as const } : { ok: false as const, error: r.error || "Couldn't save." };
  });
}

let handle: ListPageHandle | null = null;

function showPanel(on: boolean): void {
  $("mkt-admin-only")?.classList.toggle("hidden", on);
  $("mkt-body")?.classList.toggle("hidden", !on);
}

export async function loadMarketingPanel(): Promise<void> {
  const account = await window.glyphh.getAccountInfo().catch(() => null);
  const role = account?.role || "";
  if (!role || !["org_admin", "admin", "super_admin"].includes(role)) { showPanel(false); return; }
  showPanel(true);

  if (!handle) {
    handle = mountListPage<LinkRow>({
      rootId: "mkt-root",
      objectName: "link",
      objectPlural: "Links",
      title: "Links",
      description: "Campaign links for your apps and domains. Each one is your page's URL carrying a tracking code — clicks and the visits they start show up here and on Metrics.",
      columns: [
        { header: "Name", cell: (l) => esc(l.name) + (l.archived ? ` <span class="lib-badge">Archived</span>` : "") },
        { header: "Target", cell: (l) => esc(l.targetUrl.replace(/^https?:\/\//, "")), dim: true },
        { header: "Clicks", cell: (l) => fmtInt(l.clicks), dim: true },
        { header: "Sessions", cell: (l) => fmtInt(l.sessions), dim: true },
        { header: "Bounce", cell: (l) => bounceOf(l), dim: true },
      ],
      rowId: (l) => l.id,
      searchText: (l) => `${l.name} ${l.targetUrl} ${l.code}`,
      load: async () => {
        const r = await window.glyphh.marketingLinks(30);
        if (!r.ok) throw new Error(r.error || "Couldn't load marketing links.");
        return r.links;
      },
      newFields: [
        { key: "name", label: "Name", placeholder: "Spring launch — X post", required: true },
        { key: "targetUrl", label: "Target URL", placeholder: "https://yourdomain.com/pricing", required: true,
          validate: (v) => {
            try { return ["http:", "https:"].includes(new URL(v).protocol) ? null : "Must be an http(s) URL."; }
            catch { return "Enter a full URL, like https://yourdomain.com/pricing."; }
          } },
      ],
      create: async (values) => {
        const r = await window.glyphh.marketingLinkCreate({ name: values.name!.trim(), targetUrl: values.targetUrl!.trim() });
        return r.ok && r.link ? { ok: true as const, row: r.link } : { ok: false as const, error: r.error || "Couldn't create the link." };
      },
      editTitle: (l) => l.name,
      renderEdit,
      remove: async (l) => {
        const r = await window.glyphh.marketingLinkDelete(l.id);
        return r.ok ? { ok: true as const } : { ok: false as const, error: r.error || "Couldn't delete the link." };
      },
      deleteBody: () => "Its URL stops being attributed immediately; past stats are kept under the code.",
    });
  }
  await handle.reload();
}
