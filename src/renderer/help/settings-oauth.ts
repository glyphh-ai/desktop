/**
 * settings-oauth.ts — Settings › Security › OAuth.
 *
 * Organization SSO (WorkOS). The org connects its identity provider ONCE; its
 * members then sign in through it, and a members-only app (access='members')
 * rides that same org auth — no per-app OAuth. Mirrors the transport law of the
 * other settings pages (the renderer never holds an SDK client):
 *   • web     — window.glyphhSdk.org.security / securityPortal / setRequireSso
 *   • desktop — window.glyphh.orgSecurity* → account-ipc.ts → getClient().org
 * Neither present → an honest "not available on this build" message.
 */

import { escapeHtml } from "./shared.js";

interface OrgSecurityStatus {
  configured: boolean;
  linked: boolean;
  ssoActive: boolean;
  requireSso: boolean;
  connections: Array<{ id: string; name: string; type: string; state: string }>;
  domains: Array<{ domain: string; status: string }>;
}

type PortalIntent = "sso" | "dsync" | "domain_verification";

interface SdkOrg {
  security?: () => Promise<OrgSecurityStatus>;
  securityPortal?: (intent: PortalIntent) => Promise<{ url: string }>;
  setRequireSso?: (v: boolean) => Promise<{ requireSso: boolean }>;
}
interface DesktopOrgIpc {
  orgSecurity?: () => Promise<OrgSecurityStatus>;
  orgSecurityPortal?: (intent: PortalIntent) => Promise<{ url: string }>;
  orgSecurityRequireSso?: (v: boolean) => Promise<{ requireSso: boolean }>;
}

interface Transport {
  status(): Promise<OrgSecurityStatus>;
  portal(intent: PortalIntent): Promise<{ url: string }>;
  setRequireSso(v: boolean): Promise<{ requireSso: boolean }>;
}

const NO_TRANSPORT = "Single sign-on isn't available on this build.";

const $ = (id: string) => document.getElementById(id);

function isWeb(): boolean {
  return !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
}

function transport(): Transport | null {
  if (isWeb()) {
    const o = (window as unknown as { glyphhSdk?: { org?: SdkOrg } }).glyphhSdk?.org;
    if (!o?.security || !o.securityPortal || !o.setRequireSso) return null;
    return { status: () => o.security!(), portal: (i) => o.securityPortal!(i), setRequireSso: (v) => o.setRequireSso!(v) };
  }
  const g = (window as unknown as { glyphh?: DesktopOrgIpc }).glyphh;
  if (!g?.orgSecurity || !g.orgSecurityPortal || !g.orgSecurityRequireSso) return null;
  return { status: () => g.orgSecurity!(), portal: (i) => g.orgSecurityPortal!(i), setRequireSso: (v) => g.orgSecurityRequireSso!(v) };
}

/** WorkOS Admin Portal links are external — open in the system browser. */
function openExternal(url: string): void {
  const open = (window as unknown as { glyphh?: { openExternal?: (u: string) => void } }).glyphh?.openExternal;
  if (open) open(url);
  else window.open(url, "_blank", "noopener");
}

function setError(msg: string): void {
  const el = $("oauth-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

let current: OrgSecurityStatus | null = null;
let busy = false;

function render(): void {
  const body = $("oauth-body");
  if (!body) return;
  const s = current;
  if (!s) { body.innerHTML = `<div class="crud-empty">Loading…</div>`; return; }

  if (!s.configured) {
    body.innerHTML = `<div class="crud-empty">Single sign-on isn't enabled for this platform yet. Contact your Glyphh administrator to turn on organization SSO.</div>`;
    return;
  }

  const active = s.connections.find((c) => c.state === "active");
  const pending = s.connections.find((c) => c.state !== "active");
  const statusBadge = active
    ? `<span class="lib-badge">Connected</span>`
    : pending
      ? `<span class="lib-table-dim">Setup in progress</span>`
      : `<span class="lib-table-dim">Not connected</span>`;
  const idpName = active ? escapeHtml(active.name || active.type || "Identity provider")
    : pending ? escapeHtml(pending.name || pending.type || "Identity provider")
    : "No identity provider connected";

  const domainsHtml = s.domains.length
    ? s.domains.map((d) => `<div class="mbr-row"><span class="mbr-name">${escapeHtml(d.domain)}</span><span class="lib-table-dim">${escapeHtml(d.status)}</span></div>`).join("")
    : `<div class="crud-empty">No verified domains yet — verify one so WorkOS can match your members by email domain.</div>`;

  body.innerHTML = `
    <div class="settings-block">
      <div class="settings-inline settings-inline-spread">
        <div>
          <div class="settings-label">Identity provider ${statusBadge}</div>
          <div class="lib-table-dim">${idpName}</div>
        </div>
        <button id="oauth-connect-btn" class="action-btn primary" type="button">${active ? "Manage connection" : "Connect identity provider"}</button>
      </div>
    </div>

    <div class="settings-block">
      <div class="settings-label">Verified domains</div>
      <div class="mbr-list">${domainsHtml}</div>
      <div class="settings-actions">
        <button id="oauth-verify-btn" class="action-btn" type="button">Verify a domain</button>
      </div>
    </div>

    <div class="settings-block">
      <div class="settings-inline settings-inline-spread">
        <div>
          <div class="settings-label">Require SSO for all members</div>
          <div class="lib-table-dim">Members must sign in through your identity provider — magic-link and social sign-in are turned off for your org.</div>
        </div>
        <button id="oauth-require-btn" class="action-btn${s.requireSso ? " danger" : " primary"}" type="button" ${!s.ssoActive && !s.requireSso ? "disabled" : ""}>${s.requireSso ? "SSO required — turn off" : "Require SSO"}</button>
      </div>
      ${!s.ssoActive && !s.requireSso ? `<div class="settings-warn">Connect an identity provider before requiring SSO — enabling it now would lock every member out.</div>` : ""}
    </div>
  `;

  $("oauth-connect-btn")?.addEventListener("click", () => void openPortal("sso"));
  $("oauth-verify-btn")?.addEventListener("click", () => void openPortal("domain_verification"));
  $("oauth-require-btn")?.addEventListener("click", () => void toggleRequireSso());
}

async function openPortal(intent: PortalIntent): Promise<void> {
  if (busy) return;
  const t = transport();
  if (!t) { setError(NO_TRANSPORT); return; }
  busy = true; setError("");
  try {
    const { url } = await t.portal(intent);
    if (url) openExternal(url);
    // The admin returns from the portal; refresh so a new connection shows.
    await loadOAuth();
  } catch (e) {
    setError(`Couldn't open the setup portal — ${(e as Error).message}`);
  } finally { busy = false; }
}

async function toggleRequireSso(): Promise<void> {
  if (busy || !current) return;
  const t = transport();
  if (!t) { setError(NO_TRANSPORT); return; }
  busy = true; setError("");
  try {
    const r = await t.setRequireSso(!current.requireSso);
    current.requireSso = r.requireSso;
    render();
  } catch (e) {
    setError((e as Error).message);
  } finally { busy = false; }
}

export async function loadOAuth(): Promise<void> {
  setError("");
  const t = transport();
  if (!t) { current = null; render(); setError(NO_TRANSPORT); return; }
  try {
    current = await t.status();
    render();
  } catch (e) {
    current = null; render();
    setError(`Couldn't load SSO settings — ${(e as Error).message}`);
  }
}

let wired = false;
export function initOAuth(): void {
  // The page rebuilds its own controls in render(); nothing static to wire, but
  // keep the init hook for parity with the other settings pages' boot contract.
  if (wired) return;
  wired = true;
}
