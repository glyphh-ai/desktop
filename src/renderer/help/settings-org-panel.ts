import { downscaleImage } from "./shared.js";
/**
 * settings-org-panel.ts — Settings › Organization (standalone Admin panel).
 *
 * The org record: name + address. org_admin only (nav gated in navigation.ts;
 * the server enforces the write). Every field commits itself on blur, matching
 * the other Settings panels. Ported from mobile.tsx OrganizationTray.
 *
 * Reuses the EXISTING account transport (settings-api.ts accountApi().org() /
 * updateOrg()) — already wired on both surfaces (web SDK handle / desktop
 * account-ipc.ts), so no new IPC is needed for this one. (Organization is also
 * folded into the Account panel for continuity; this is the dedicated page.)
 */

import { accountApi, type Org, type Address, type OrgUpdate, type BillingContact, type OrgDomain } from "./settings-api.js";

const $ = (id: string) => document.getElementById(id);
let org: Org | null = null;
let wired = false;
let statusTimer = 0;

function setError(msg: string): void {
  const el = $("org-panel-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function flashSaved(): void {
  const el = $("org-panel-status");
  if (!el) return;
  el.textContent = "Saved";
  el.className = "set-save-state success";
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => { el.textContent = ""; }, 1600);
}

/** Admin gate — same rule as Members/Workspaces. */
function showPanel(on: boolean): void {
  $("org-panel-admin-only")?.classList.toggle("hidden", on);
  $("org-panel-body")?.classList.toggle("hidden", !on);
  document.querySelector<HTMLElement>('.settings-nav .settings-nav-item[data-sub="organization"]')
    ?.classList.toggle("hidden", !on);
}

const ADDR_FIELDS: Array<[keyof Address, string]> = [
  ["line1", "org-panel-addr-line1"], ["line2", "org-panel-addr-line2"],
  ["city", "org-panel-addr-city"], ["state", "org-panel-addr-state"],
  ["postalCode", "org-panel-addr-postal"], ["country", "org-panel-addr-country"],
];


function paint(): void {
  const name = $("org-panel-name") as HTMLInputElement | null;
  if (name && document.activeElement !== name) name.value = org?.name || "";
  const a = org?.address;
  for (const [key, id] of ADDR_FIELDS) {
    const el = $(id) as HTMLInputElement | null;
    if (el && document.activeElement !== el) el.value = (a?.[key] as string | undefined) || "";
  }
  // Identity: the org image (uploaded logo) with the initial underneath.
  const img = $("org-panel-image") as HTMLImageElement | null;
  const initial = $("org-panel-initial");
  const idName = $("org-panel-id-name");
  const imageUrl = (org as { imageUrl?: string | null } | null)?.imageUrl || "";
  if (img) {
    img.classList.toggle("hidden", !imageUrl);
    if (imageUrl && img.src !== imageUrl) img.src = imageUrl;
  }
  if (initial) {
    initial.textContent = (org?.name || "—").charAt(0).toUpperCase();
    initial.classList.toggle("hidden", !!imageUrl);
  }
  if (idName) idName.textContent = org?.name || "—";
}

async function save(patch: OrgUpdate): Promise<void> {
  setError("");
  const res = await accountApi().updateOrg(patch);
  if (res.ok) { org = res.data; paint(); flashSaved(); }
  else setError(res.error);
}

/** Read the six address fields into an Address, or null when all are empty. */
function readAddress(): Address | null {
  const get = (id: string): string => ($(id) as HTMLInputElement | null)?.value.trim() || "";
  const addr: Address = {
    line1: get("org-panel-addr-line1"), line2: get("org-panel-addr-line2"),
    city: get("org-panel-addr-city"), state: get("org-panel-addr-state"),
    postalCode: get("org-panel-addr-postal"), country: get("org-panel-addr-country"),
  };
  const any = addr.line1 || addr.city || addr.postalCode || addr.state || addr.country || addr.line2;
  return any ? addr : null;
}

export async function loadOrgPanel(): Promise<void> {
  initOrgPanel();
  setError("");
  const account = await window.glyphh.getAccountInfo().catch(() => null);
  const role = account?.role || "";
  if (!role || !["org_admin", "super_admin"].includes(role)) { showPanel(false); return; }
  showPanel(true);
  try { org = await accountApi().org(); paint(); }
  catch (e) { setError(`Couldn't load your organization — ${(e as Error).message}`); }
  // Domain management lives on the PLATFORM only (his order, 2026-08-31 — one
  // surface). The group is hidden in settings.html; skip the fetch too.
}

export function initOrgPanel(): void {
  if (wired) return;
  wired = true;
  ($("org-panel-name") as HTMLInputElement | null)?.addEventListener("blur", (e) => {
    void save({ name: (e.target as HTMLInputElement).value.trim() });
  });
  // Org image upload — desktop rides the IPC; web goes straight to the SDK.
  const pick = $("org-panel-image-pick") as HTMLButtonElement | null;
  const file = $("org-panel-image-file") as HTMLInputElement | null;
  pick?.addEventListener("click", () => file?.click());
  file?.addEventListener("change", async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    setError("");
    // DOWNSCALE, never reject (his bug, 2026-08-20): a normal photo is MBs —
    // bouncing it off the 512KB limit read as "nothing happened".
    const scaled = await downscaleImage(f);
    if (scaled.byteLength > 512 * 1024) { setError("That image couldn't be shrunk under 512 KB — try a different one."); return; }
    const bytes = scaled.buffer.slice(scaled.byteOffset, scaled.byteOffset + scaled.byteLength) as ArrayBuffer;
    const sdk = (window as unknown as { glyphhSdk?: { org?: { uploadImage?: (b: Uint8Array) => Promise<unknown> } } }).glyphhSdk;
    try {
      if (sdk?.org?.uploadImage) await sdk.org.uploadImage(scaled);
      else {
        const g = (window as unknown as { glyphh: { accountOrgImage?: (b: ArrayBuffer) => Promise<{ ok: boolean; error?: string }> } }).glyphh;
        if (typeof g.accountOrgImage !== "function") { setError("This build can't upload an org image yet — update the app."); return; }
        const r = await g.accountOrgImage(bytes);
        if (!r?.ok) { setError(r?.error || "Couldn't upload the image."); return; }
      }
      org = await accountApi().org();
      paint();
      flashSaved();
    } catch (e) { setError(`Couldn't upload the image — ${(e as Error).message}`); }
  });
  for (const [, id] of ADDR_FIELDS) {
    ($(id) as HTMLInputElement | null)?.addEventListener("blur", () => void save({ address: readAddress() }));
  }
}

// ── Custom domain (org white-label — server docs/custom-domains.md P1) ──────
// Add → the row shows the TWO DNS records to publish → Verify → active, with
// per-app hostname states beneath. All writes ride accountApi()'s dual
// transport (desktop IPC / web SDK); org_admin is the panel's existing gate.

const esc = (v: unknown): string =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function domainsError(msg: string): void {
  const el = $("org-domains-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function domainsStatus(msg: string): void {
  const el = $("org-domains-status");
  if (el) el.textContent = msg;
}

const COPY_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const SPIN_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="vertical-align:-1px"><path d="M21 12a9 9 0 1 1-6.2-8.56"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></path></svg>`;
const CHECK_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

/** A tiny copy button for a DNS record value — flips to a green check on success. */
function copyBtnHtml(value: string): string {
  return `<button class="action-btn od-copy" type="button" data-copy="${esc(value)}" title="Copy" style="height:22px;width:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;">${COPY_SVG}</button>`;
}

function wireCopyButtons(root: HTMLElement): void {
  for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>(".od-copy"))) {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy || "");
        btn.innerHTML = CHECK_SVG;
        setTimeout(() => { btn.innerHTML = COPY_SVG; }, 1500);
      } catch { /* clipboard denied — leave the icon */ }
    });
  }
}

const DOMAIN_CHIP: Record<string, string> = {
  pending: "Waiting for DNS", verifying: "Verifying", active: "Active", error: "Error",
};

function paintDomains(domains: OrgDomain[]): void {
  const list = $("org-domains-list");
  if (!list) return;
  list.innerHTML = "";
  for (const d of domains) {
    const row = document.createElement("div");
    row.className = "acct-section";
    row.style.cssText = "border:1px solid var(--border-2);border-radius:10px;padding:14px 16px;margin:10px 0;";
    const hostRows = Object.entries(d.hostnames);
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;">
        <b style="font-size:14px;">${esc(d.domain)}</b>
        <span class="mkt-listed-chip ${d.status === "active" ? "on" : ""}">${esc(DOMAIN_CHIP[d.status] ?? d.status)}</span>
        <span style="flex:1;"></span>
        ${d.status !== "active" ? `<button class="action-btn primary od-verify" type="button">Verify</button>` : ""}
        <button class="action-btn danger od-remove" type="button">Remove</button>
      </div>
      ${d.error ? `<p class="settings-error" style="margin:8px 0 0;">${esc(d.error)}</p>` : ""}
      ${d.status !== "active" ? `
      <p class="settings-hint" style="margin:10px 0 6px;">Publish these DNS records, then press Verify:</p>
      <table class="yo-md-table" style="font-size:12px;"><thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead>
        <tbody>${d.dns.map((r) => `<tr><td>${esc(r.type)}</td><td><code>${esc(r.name)}</code> ${copyBtnHtml(r.name)}</td><td><code>${esc(r.value)}</code> ${copyBtnHtml(r.value)}</td></tr>`).join("")}</tbody>
      </table>` : ""}
      ${hostRows.length ? `
      <p class="settings-hint" style="margin:10px 0 4px;">App hostnames:</p>
      ${hostRows.map(([h, st]) => `<div style="display:flex;gap:8px;align-items:center;font-size:12.5px;padding:2px 0;"><code>${esc(h)}</code><span class="mkt-listed-chip ${st === "active" ? "on" : ""}">${esc(st)}</span></div>`).join("")}` : ""}
    `;
    wireCopyButtons(row);
    // Verify retries while DNS propagates (his spec, 2026-08-31): 6 attempts,
    // 10s apart, spinner on the button; the first success reloads, the last
    // failure surfaces its reason.
    const verifyBtn = row.querySelector<HTMLButtonElement>(".od-verify");
    verifyBtn?.addEventListener("click", async () => {
      domainsError("");
      verifyBtn.disabled = true;
      verifyBtn.style.color = "#fff";
      const ATTEMPTS = 6;
      let lastError = "Couldn't verify the domain.";
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        verifyBtn.innerHTML = `${SPIN_SVG} Verifying…${attempt > 1 ? ` (${attempt}/${ATTEMPTS})` : ""}`;
        const r = await accountApi().verifyOrgDomain(d.id);
        if (r.ok) { void loadDomains(); return; }
        lastError = r.error;
        if (attempt < ATTEMPTS) await new Promise((res) => setTimeout(res, 10_000));
      }
      verifyBtn.disabled = false;
      verifyBtn.style.color = "";
      verifyBtn.textContent = "Verify";
      domainsError(lastError);
    });
    row.querySelector<HTMLButtonElement>(".od-remove")?.addEventListener("click", async () => {
      domainsError("");
      const r = await accountApi().removeOrgDomain(d.id);
      if (!r.ok) { domainsError(r.error); return; }
      void loadDomains();
    });
    list.appendChild(row);
  }
}

let domainsWired = false;
async function loadDomains(): Promise<void> {
  if (!domainsWired) {
    domainsWired = true;
    $("org-domain-add")?.addEventListener("click", async () => {
      const input = $("org-domain-input") as HTMLInputElement | null;
      const domain = input?.value.trim() || "";
      if (!domain) return;
      domainsError("");
      domainsStatus("Adding…");
      const r = await accountApi().addOrgDomain(domain);
      domainsStatus("");
      if (!r.ok) { domainsError(r.error); return; }
      if (input) input.value = "";
      void loadDomains();
    });
  }
  try { paintDomains(await accountApi().orgDomains()); }
  catch { /* older build / server — the section just stays empty */ }
}
