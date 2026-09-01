/**
 * settings-domains.ts — Settings › Domains, on the shared Security list-page
 * scaffold (settings-list-page.ts): title, description, full-width search +
 * “+ New domain” (validated modal), a lib-table with kebab Edit/Delete, and an
 * inline editor a row opens. Identical to every other Security page by
 * construction. All writes ride accountApi()'s SDK transport (web SDK / desktop
 * main-process SDK); nothing hits the API directly. org_admin gated below.
 */

import { accountApi, type OrgDomain } from "./settings-api.js";
import { mountListPage, type ListPageHandle, type EditCtx } from "./settings-list-page.js";

const $ = (id: string) => document.getElementById(id);
const esc = (v: unknown): string =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let apps: Array<{ id: string; name: string; slug: string }> = [];

const CHIP: Record<string, string> = { pending: "Waiting for DNS", verifying: "Verifying", active: "Active", error: "Error" };
const statusChip = (d: OrgDomain): string => `<span class="lib-badge${d.status === "active" ? " on" : ""}">${esc(CHIP[d.status] ?? d.status)}</span>`;
const appsCell = (d: OrgDomain): string => {
  const n = Object.keys(d.hostnames ?? {}).length;
  return esc(n ? `${n} app hostname${n === 1 ? "" : "s"}` : d.apexAppId ? "home app set" : "—");
};

// A bare DNS hostname — the same rule the server enforces.
const HOST_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

// ── editor body (DNS records + Verify + apex picker) ─────────────────────────
const COPY_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const SPIN_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="vertical-align:-1px"><path d="M21 12a9 9 0 1 1-6.2-8.56"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></path></svg>`;
const CHECK_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const copyBtn = (v: string): string => `<button class="action-btn od-copy" type="button" data-copy="${esc(v)}" title="Copy" style="height:22px;width:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;">${COPY_SVG}</button>`;

function apexOptions(selected: string | null | undefined): string {
  return `<option value=""${!selected ? " selected" : ""}>Not serving yet — pick your home app</option>`
    + apps.map((a) => `<option value="${esc(a.id)}"${a.id === selected ? " selected" : ""}>${esc(a.name)} (${esc(a.slug)})</option>`).join("");
}

function renderEdit(d: OrgDomain, body: HTMLElement, ctx: EditCtx): void {
  const hostRows = Object.entries(d.hostnames ?? {});
  body.innerHTML = `
    <p style="margin:0 0 12px;">${statusChip(d)}</p>
    ${d.error ? `<p class="settings-error" style="margin:0 0 10px;">${esc(d.error)}</p>` : ""}
    ${d.status !== "active" ? `
    <h4 class="acct-row-head">Publish these DNS records</h4>
    <p class="section-desc">Add them at your DNS host, then press Verify.</p>
    <table class="lib-table dom-dns" style="font-size:12px;"><thead><tr><th style="width:64px;">Type</th><th>Name</th><th>Value</th></tr></thead>
      <tbody>${d.dns.map((r) => `<tr><td>${esc(r.type)}</td><td><code>${esc(r.name)}</code> ${copyBtn(r.name)}</td><td><code>${esc(r.value)}</code> ${copyBtn(r.value)}</td></tr>`).join("")}</tbody>
    </table>
    <div class="settings-actions" style="margin:12px 0;"><button id="dom-verify" class="action-btn primary" type="button">Verify</button></div>` : ""}

    <h4 class="acct-row-head">Home app</h4>
    <p class="section-desc">Which app the bare <code>${esc(d.domain)}</code> serves once you publish the <code>A</code>/<code>AAAA</code> records above. Your own <code>www</code> and apex stay untouched until you deliberately point them here; leave unset to serve nothing at the naked domain.</p>
    <select id="dom-apex" class="settings-input settings-input-md">${apexOptions(d.apexAppId)}</select>

    <p class="section-desc" style="margin-top:14px;">To point one hostname at one app — <code>abc.${esc(d.domain)}</code> or a bare client domain — add it from that <strong>app's Domains tab</strong>. Only the hostname you bind resolves; nothing else on <code>${esc(d.domain)}</code> is touched.</p>

    <h4 class="acct-row-head" style="margin-top:16px;">Wildcard (whole catalog)</h4>
    <label class="settings-toggle" style="margin:6px 0;">
      <input id="dom-wildcard" type="checkbox" ${d.wildcard ? "checked" : ""} />
      <span class="toggle-switch"></span>
      <span class="toggle-info">
        <span class="toggle-title">Publish every app at <code>&lt;app&gt;.${esc(d.domain)}</code></span>
        <span class="toggle-desc">Adds a wildcard <code>CNAME *.${esc(d.domain)}</code>. ⚠ Every <em>undefined</em> subdomain of <code>${esc(d.domain)}</code> (api, staging, mail…) will then route to Glyphh. Leave off unless this domain exists only to front your Glyphh apps.</span>
      </span>
    </label>

    ${hostRows.length ? `<h4 class="acct-row-head" style="margin-top:16px;">App hostnames</h4>
    <table class="lib-table dom-dns" style="font-size:12px;"><tbody>${hostRows.map(([h, s]) => `<tr><td><code>${esc(h)}</code></td><td class="lib-table-dim">${esc(s)}</td></tr>`).join("")}</tbody></table>` : ""}`;

  for (const b of Array.from(body.querySelectorAll<HTMLButtonElement>(".od-copy"))) {
    b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy || ""); b.innerHTML = CHECK_SVG; setTimeout(() => { b.innerHTML = COPY_SVG; }, 1500); } catch { /* denied */ }
    });
  }

  const vb = $("dom-verify") as HTMLButtonElement | null;
  vb?.addEventListener("click", async () => {
    ctx.error(""); vb.disabled = true; vb.style.color = "#fff";
    let last = "Couldn't verify the domain.";
    for (let a = 1; a <= 6; a++) {
      vb.innerHTML = `${SPIN_SVG} Verifying…${a > 1 ? ` (${a}/6)` : ""}`;
      const r = await accountApi().verifyOrgDomain(d.id);
      if (r.ok) { await ctx.reload(); ctx.back(); return; }
      last = r.error;
      if (a < 6) await new Promise((res) => setTimeout(res, 10_000));
    }
    vb.disabled = false; vb.style.color = ""; vb.textContent = "Verify"; ctx.error(last);
  });

  ($("dom-apex") as HTMLSelectElement | null)?.addEventListener("change", async (e) => {
    ctx.error("");
    const r = await accountApi().setOrgDomainApexApp(d.id, (e.target as HTMLSelectElement).value || null);
    if (!r.ok) { ctx.error(r.error); return; }
    await ctx.reload(); ctx.back();
  });

  ($("dom-wildcard") as HTMLInputElement | null)?.addEventListener("change", async (e) => {
    ctx.error("");
    const box = e.target as HTMLInputElement;
    const r = await accountApi().setOrgDomainWildcard(d.id, box.checked);
    if (!r.ok) { box.checked = !box.checked; ctx.error(r.error); return; }
    await ctx.reload(); ctx.back();
  });
}

let handle: ListPageHandle | null = null;

function showPanel(on: boolean): void {
  $("dom-admin-only")?.classList.toggle("hidden", on);
  $("dom-body")?.classList.toggle("hidden", !on);
  document.querySelector<HTMLElement>('.settings-nav .settings-nav-item[data-sub="domains"]')?.classList.toggle("hidden", !on);
}

export async function loadDomainsPanel(): Promise<void> {
  const account = await window.glyphh.getAccountInfo().catch(() => null);
  const role = account?.role || "";
  if (!role || !["org_admin", "super_admin"].includes(role)) { showPanel(false); return; }
  showPanel(true);

  try { apps = await accountApi().orgApps(); } catch { apps = []; }
  if (!handle) {
    handle = mountListPage<OrgDomain>({
      rootId: "dom-root",
      objectName: "domain",
      objectPlural: "Domains",
      title: "Domains",
      description: "Point your own domains at Glyphh. Add a domain, publish the DNS records it shows, then Verify — every published app answers at <code>&lt;app&gt;.yourdomain</code>, and the bare domain can serve a flagship app.",
      columns: [
        { header: "Domain", cell: (d) => esc(d.domain) },
        { header: "Status", cell: (d) => statusChip(d) },
        { header: "Apps", cell: (d) => appsCell(d), dim: true },
      ],
      rowId: (d) => d.id,
      searchText: (d) => d.domain,
      load: () => accountApi().orgDomains(),
      newFields: [
        { key: "domain", label: "Domain", placeholder: "acme.com", required: true,
          validate: (v) => HOST_RE.test(v.toLowerCase()) ? null : "Enter a bare domain like acme.com (no scheme, no wildcard)." },
      ],
      create: (values) => accountApi().addOrgDomain(values.domain!.trim().toLowerCase())
        .then((r) => r.ok ? { ok: true as const, row: r.data } : { ok: false as const, error: r.error }),
      editTitle: (d) => d.domain,
      renderEdit,
      remove: (d) => accountApi().removeOrgDomain(d.id).then((r) => r.ok ? { ok: true as const } : { ok: false as const, error: r.error }),
      deleteBody: () => "Its app hostnames stop resolving immediately.",
    });
  }
  await handle.reload();
}
