/**
 * settings-oauth.ts — Settings › Security › OAuth.
 *
 * Organization SSO (WorkOS). The org connects its identity provider ONCE; its
 * members then sign in through it, and a members-only app (access='members')
 * rides that same org auth — no per-app OAuth. Controls are STATIC in
 * settings.html and wired ONCE in initOAuth() (same pattern as the other
 * settings pages); loadOAuth() only paints the dynamic status. Transport law —
 * the renderer never holds an SDK client:
 *   • web     — window.glyphhSdk.org.security / securityPortal / setRequireSso
 *   • desktop — window.glyphh.orgSecurity* → account-ipc.ts → getClient().org
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
const $ = (id: string): HTMLElement | null => document.getElementById(id);

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

function paint(): void {
  const s = current;
  const idp = $("oauth-idp-status");
  const connectBtn = $("oauth-connect-btn") as HTMLButtonElement | null;
  const verifyBtn = $("oauth-verify-btn") as HTMLButtonElement | null;
  const domains = $("oauth-domains");
  const requireBtn = $("oauth-require-btn") as HTMLButtonElement | null;
  const hint = $("oauth-require-hint");
  if (!s) return;

  if (!s.configured) {
    if (idp) idp.textContent = "Unavailable";
    setError("Single sign-on isn't enabled for this platform yet.");
    for (const b of [connectBtn, verifyBtn, requireBtn]) if (b) b.disabled = true;
    return;
  }

  const active = s.connections.find((c) => c.state === "active");
  const pending = s.connections.find((c) => c.state !== "active");
  if (idp) idp.textContent = active ? "Connected" : pending ? "Setup…" : "Not connected";
  if (connectBtn) connectBtn.textContent = active ? "Manage connection" : "Connect identity provider";

  if (domains) {
    domains.innerHTML = s.domains.length
      ? s.domains.map((d) => `<div><span>${escapeHtml(d.domain)}</span><b>${escapeHtml(d.status)}</b></div>`).join("")
      : `<div><span>No verified domains yet</span><b>—</b></div>`;
  }

  if (requireBtn) {
    requireBtn.textContent = s.requireSso ? "SSO required — turn off" : "Require SSO";
    requireBtn.classList.toggle("primary", !s.requireSso);
    requireBtn.disabled = !s.ssoActive && !s.requireSso;
  }
  if (hint) {
    const warn = !s.ssoActive && !s.requireSso;
    hint.textContent = warn ? "Connect an identity provider before requiring SSO — enabling it now would lock every member out." : "";
    hint.classList.toggle("hidden", !warn);
  }
}

async function openPortal(intent: PortalIntent): Promise<void> {
  if (busy) return;
  const t = transport();
  if (!t) { setError(NO_TRANSPORT); return; }
  busy = true; setError("");
  try {
    const { url } = await t.portal(intent);
    if (url) openExternal(url);
    await loadOAuth(); // a new connection may show after the admin returns
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
    paint();
  } catch (e) {
    setError((e as Error).message);
  } finally { busy = false; }
}

export async function loadOAuth(): Promise<void> {
  setError("");
  const t = transport();
  if (!t) { current = null; setError(NO_TRANSPORT); return; }
  try {
    current = await t.status();
    paint();
  } catch (e) {
    current = null;
    setError(`Couldn't load SSO settings — ${(e as Error).message}`);
  }
}

let wired = false;
export function initOAuth(): void {
  if (wired) return;
  wired = true;
  $("oauth-connect-btn")?.addEventListener("click", () => void openPortal("sso"));
  $("oauth-verify-btn")?.addEventListener("click", () => void openPortal("domain_verification"));
  $("oauth-require-btn")?.addEventListener("click", () => void toggleRequireSso());
}
