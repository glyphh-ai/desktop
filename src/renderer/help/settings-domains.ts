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
import { paginate, renderPaginationBar } from "./shared.js";

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
const CLOCK_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px;"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
const WARN_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1.5px;margin-right:3px;"><path d="M10.3 3.8 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const copyBtn = (v: string): string => `<button class="action-btn od-copy" type="button" data-copy="${esc(v)}" title="Copy" style="height:22px;width:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;">${COPY_SVG}</button>`;

function apexOptions(selected: string | null | undefined): string {
  return `<option value=""${!selected ? " selected" : ""}>Not serving yet — pick your home app</option>`
    + apps.map((a) => `<option value="${esc(a.id)}"${a.id === selected ? " selected" : ""}>${esc(a.name)} (${esc(a.slug)})</option>`).join("");
}

function renderEdit(d: OrgDomain, body: HTMLElement, ctx: EditCtx): void {
  // STAGED state (his spec, 2026-09-01): the two capability toggles drive what
  // the form shows LIVE (the wire always carries every record; the UI filters),
  // but nothing is written until Save. Cancel/← discards.
  let pubApps = !!d.wildcard;          // 1 — publish apps at <app>.<domain>
  let hostBare = !!d.apexAppId;        // 2 — the bare domain serves a home app
  let apexSel = d.apexAppId ?? "";

  function paint(): void {
    // Far-right state chip per capability card: card 1 answers for the DOMAIN
    // (the TXT gate every subdomain rides); card 2 for the BARE hostname's own
    // cert/serving state. Shown only while the capability is on.
    const chip = (label: string, on: boolean) =>
      on && label ? `<span class="lib-badge${label === "Active" ? " on" : ""}" style="margin-left:auto;flex-shrink:0;">${esc(label)}</span>` : "";
    const bareState = (d.hostnames ?? {})[d.domain];
    const chip1 = chip(CHIP[d.status] ?? d.status, pubApps);
    const chip2 = chip(bareState ? (CHIP[bareState] ?? bareState) : "", hostBare);
    // Anything still verifying → set expectations honestly (his spec,
    // 2026-09-01): propagation is the customer's DNS host's clock, not ours.
    const anythingVerifying = (pubApps && (d.status === "pending" || d.status === "verifying"))
      || (hostBare && bareState === "verifying")
      || Object.values(d.hostnames ?? {}).includes("verifying");
    const verifyingNote = anythingVerifying
      ? `<p class="section-desc" style="margin:10px 0 0;">${CLOCK_SVG}Verifying — DNS changes can take <strong>up to 24 hours</strong> to propagate, though most complete within minutes. We re-check automatically every few minutes; <strong>Refresh</strong> checks right now.</p>`
      : "";
    const rows = d.dns.filter((r) =>
      r.type === "TXT" || (pubApps && r.type === "CNAME") || (hostBare && (r.type === "A" || r.type === "AAAA")));
    const showTable = pubApps || hostBare;
    body.innerHTML = `
      ${d.error ? `<p class="settings-error" style="margin:0 0 20px;">${esc(d.error)}</p>` : ""}

      <div class="lp-sec">
        <label class="settings-toggle" style="margin:0 0 14px;">
          <input id="dom-t-apps" type="checkbox" ${pubApps ? "checked" : ""} />
          <span class="toggle-switch"></span>
          <span class="toggle-info">
            <span class="toggle-title">Publish apps to <code>&lt;app&gt;.${esc(d.domain)}</code></span>
            <span class="toggle-desc">Every published app answers at its own subdomain via one wildcard <code>CNAME</code>. ${WARN_SVG}Undefined subdomains of <code>${esc(d.domain)}</code> (api, staging, mail…) will route to Glyphh too.</span>
          </span>
          ${chip1}
        </label>
        <label class="settings-toggle" style="margin:0;">
          <input id="dom-t-bare" type="checkbox" ${hostBare ? "checked" : ""} />
          <span class="toggle-switch"></span>
          <span class="toggle-info">
            <span class="toggle-title">Host your domain on a Glyphh app</span>
            <span class="toggle-desc">The bare <code>${esc(d.domain)}</code> serves one app you pick — your <code>www</code> and everything else stay untouched.</span>
          </span>
          ${chip2}
        </label>
      </div>

      ${showTable ? `<div class="lp-sec">
        <div style="display:flex;align-items:center;gap:12px;">
          <h4 class="acct-row-head" style="margin:0;">${d.status === "active" ? "DNS records" : "Publish these DNS records"}</h4>
          <div style="flex:1;"></div>
          <button id="dom-refresh" class="action-btn primary" type="button">Refresh</button>
        </div>
        <p class="section-desc" style="margin-top:8px;">${d.status === "active"
          ? "Keep these published — they are what serves your domain."
          : "Add them at your DNS host, then press Verify."}</p>
        <table class="lib-table dom-dns" style="font-size:12px;"><thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td>${esc(r.type)}</td><td><code>${esc(r.name)}</code> ${copyBtn(r.name)}</td><td><code>${esc(r.value)}</code> ${copyBtn(r.value)}</td></tr>`).join("")}</tbody>
        </table>
        ${d.status !== "active" ? `<div class="settings-actions" style="margin-top:14px;"><button id="dom-verify" class="action-btn primary" type="button">Verify</button></div>` : ""}
        ${verifyingNote}
      </div>` : ""}

      ${hostBare ? `<div class="lp-sec">
        <h4 class="acct-row-head">Home app</h4>
        <p class="section-desc">Which app the bare <code>${esc(d.domain)}</code> serves once the <code>A</code>/<code>AAAA</code> records above are published.</p>
        <select id="dom-apex" class="settings-input settings-input-md">${apexOptions(apexSel || null)}</select>
      </div>` : ""}

      `;
    wire();
    paintHostnames();
  }

  // ── App hostnames — BELOW the footer (his spec, 2026-09-01): a read-only
  // companion list with the standard grammar — full-width search + pagination.
  let hostQuery = "";
  let hostPage = 0;
  function paintHostnames(): void {
    const host = ctx.after;
    if (!host) return;
    const all = Object.entries(d.hostnames ?? {});
    const q = hostQuery.trim().toLowerCase();
    const filtered = q ? all.filter(([h]) => h.toLowerCase().includes(q)) : all;
    const { items, state } = paginate(filtered, hostPage);
    hostPage = state.page;
    host.innerHTML = all.length === 0 ? "" : `
      <div class="lp-sec" style="margin-top:26px;">
        <h4 class="acct-row-head">App hostnames</h4>
        <p class="section-desc">Hostnames currently serving under this domain. To point one hostname at one app — <code>abc.${esc(d.domain)}</code> or a bare client domain — add it from that app's Domains tab.</p>
        <div class="crud-toolbar">
          <div class="search-clear-wrap"><input id="dom-host-search" type="text" class="crud-search" placeholder="Search hostnames…" spellcheck="false" autocomplete="off" value="${esc(hostQuery)}" /></div>
        </div>
        ${filtered.length === 0
          ? `<div class="crud-empty">No hostnames match your search.</div>`
          : `<table class="lib-table dom-dns" style="font-size:12px;"><tbody>${items.map(([h, st]) => `<tr><td><code>${esc(h)}</code></td><td class="lib-table-dim">${esc(CHIP[st] ?? st)}</td></tr>`).join("")}</tbody></table>`}
        <div id="dom-host-pager"></div>
      </div>`;
    const search = host.querySelector<HTMLInputElement>("#dom-host-search");
    search?.addEventListener("input", () => {
      hostQuery = search.value; hostPage = 0;
      const pos = search.selectionStart ?? search.value.length;
      paintHostnames();
      const again = host.querySelector<HTMLInputElement>("#dom-host-search");
      again?.focus(); again?.setSelectionRange(pos, pos);
    });
    if (state.totalPages > 1) host.querySelector("#dom-host-pager")?.appendChild(
      renderPaginationBar(state, (p) => { hostPage = p; paintHostnames(); }));
  }

  function wire(): void {
    ($("dom-t-apps") as HTMLInputElement | null)?.addEventListener("change", (e) => {
      pubApps = (e.target as HTMLInputElement).checked; paint();
    });
    ($("dom-t-bare") as HTMLInputElement | null)?.addEventListener("change", (e) => {
      hostBare = (e.target as HTMLInputElement).checked; paint();
    });
    ($("dom-apex") as HTMLSelectElement | null)?.addEventListener("change", (e) => {
      apexSel = (e.target as HTMLSelectElement).value;
    });

    for (const b of Array.from(body.querySelectorAll<HTMLButtonElement>(".od-copy"))) {
      b.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(b.dataset.copy || ""); b.innerHTML = CHECK_SVG; setTimeout(() => { b.innerHTML = COPY_SVG; }, 1500); } catch { /* denied */ }
      });
    }

    // Verify + Refresh share ONE polling shape: spin with attempts, re-check
    // the domain (TXT + hostname sync), and on success re-render IN PLACE with
    // the fresh state. A retry loop OUTLIVES the render (up to a minute) — if
    // this render was replaced, die silently; a stale loop once fired
    // ctx.back() ~10s after whatever the user was doing, which read as "any
    // click closes the form". NEVER back() from here.
    const poll = (btnId: string, verbing: string, idle: string) => async () => {
      const btn = $(btnId) as HTMLButtonElement | null;
      if (!btn) return;
      ctx.error(""); btn.disabled = true; btn.style.color = "#fff";
      let last = "Couldn't verify the domain.";
      for (let a = 1; a <= 6; a++) {
        if (!btn.isConnected) return;
        btn.innerHTML = `${SPIN_SVG} ${verbing}…${a > 1 ? ` (${a}/6)` : ""}`;
        // A floor on the spin (700ms): an instant success otherwise repaints
        // identical data and reads as "the button did nothing" (his report).
        const [r] = await Promise.all([
          accountApi().verifyOrgDomain(d.id),
          new Promise((res) => setTimeout(res, 700)),
        ]);
        if (r.ok) {
          void ctx.reload(); // refresh the list behind us
          if (!btn.isConnected) return;
          // Adopt the fresh server row IN PLACE: records/status/hostnames
          // update, but STAGED toggle edits survive (his prod report,
          // 2026-09-01: toggling then Refresh discarded the unsaved flip).
          d = r.data;
          paint();
          // Visible receipt on the freshly-rendered button, then back to idle.
          const fresh = $(btnId) as HTMLButtonElement | null;
          if (fresh) {
            fresh.innerHTML = `${CHECK_SVG} ${idle === "Refresh" ? "Refreshed" : "Verified"}`;
            setTimeout(() => { if (fresh.isConnected) fresh.textContent = idle; }, 1800);
          }
          return;
        }
        last = r.error;
        if (a < 6) await new Promise((res) => setTimeout(res, 10_000));
      }
      if (!btn.isConnected) return;
      btn.disabled = false; btn.style.color = ""; btn.textContent = idle; ctx.error(last);
    };
    $("dom-verify")?.addEventListener("click", poll("dom-verify", "Verifying", "Verify"));
    $("dom-refresh")?.addEventListener("click", poll("dom-refresh", "Refreshing", "Refresh"));
  }

  // Save commits only what changed: toggle 1 → wildcard; toggle 2 + picker →
  // the home app (off clears it).
  ctx.onSave(async () => {
    const wantApex = hostBare ? (apexSel || null) : null;
    if (wantApex !== (d.apexAppId ?? null)) {
      const r = await accountApi().setOrgDomainApexApp(d.id, wantApex);
      if (!r.ok) return r;
    }
    if (pubApps !== (d.wildcard ?? false)) {
      const r = await accountApi().setOrgDomainWildcard(d.id, pubApps);
      if (!r.ok) return r;
    }
    return { ok: true as const };
  });

  paint();
}

let handle: ListPageHandle | null = null;

// ── Edge traffic (his order, 2026-09-02): the org's domain dashboard,
// painted by the shared traffic painter (apps.ts owns the shape). ──
let domTrafficWired = false;
const domTrafficChartRef = { current: null as { destroy: () => void } | null };

async function loadDomTraffic(): Promise<void> {
  const days = parseInt((document.getElementById("domtraffic-days") as HTMLSelectElement | null)?.value || "30", 10);
  const rep = await window.glyphh.orgDomainsTraffic?.(days);
  if (!rep) return;
  const { paintTrafficReport } = await import("./apps.js");
  paintTrafficReport(
    { totals: "domtraffic-totals", chart: "domtraffic-chart", empty: "domtraffic-empty", hosts: "domtraffic-hosts", error: "domtraffic-error" },
    rep, domTrafficChartRef,
  );
}

function showPanel(on: boolean): void {
  $("dom-admin-only")?.classList.toggle("hidden", on);
  $("dom-body")?.classList.toggle("hidden", !on);
  document.querySelector<HTMLElement>('.settings-nav .settings-nav-item[data-sub="domains"]')?.classList.toggle("hidden", !on);
}

export async function loadDomainsPanel(): Promise<void> {
  const account = await window.glyphh.getAccountInfo().catch(() => null);
  const role = account?.role || "";
  if (!role || !["org_admin", "admin", "super_admin"].includes(role)) { showPanel(false); return; }
  showPanel(true);
  void loadDomTraffic();
  if (!domTrafficWired) {
    domTrafficWired = true;
    $("domtraffic-days")?.addEventListener("change", () => { void loadDomTraffic(); });
  }

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
