/**
 * settings-oauth.ts — Settings › Security › OAuth.
 *
 * Organization SSO (WorkOS). The org connects its identity provider ONCE; its
 * members then sign in through it, and a members-only app (access='members')
 * rides that same org auth — no per-app OAuth. Controls are STATIC in
 * settings.html and wired ONCE in initOAuth(); loadOAuth() only paints state.
 * Transport law — the renderer never holds an SDK client:
 *   • web     — window.glyphhSdk.org.security / securityPortal / setRequireSso
 *   • desktop — window.glyphh.orgSecurity* → account-ipc.ts → getClient().org
 */

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
  const toggle = $("oauth-require-toggle") as HTMLInputElement | null;
  const hint = $("oauth-require-hint");
  if (!s) return;

  if (!s.configured) {
    if (idp) idp.textContent = "Single sign-on isn't enabled for this platform yet.";
    if (connectBtn) connectBtn.disabled = true;
    if (toggle) toggle.disabled = true;
    return;
  }

  const active = s.connections.find((c) => c.state === "active");
  const pending = s.connections.find((c) => c.state !== "active");
  if (idp) idp.textContent = active ? `Connected — ${active.name || active.type || "identity provider"}`
    : pending ? "Setup in progress" : "Not connected";
  if (connectBtn) { connectBtn.textContent = active ? "Manage connection" : "Connect identity provider"; connectBtn.disabled = false; }

  if (toggle) {
    toggle.checked = s.requireSso;
    toggle.disabled = !s.ssoActive && !s.requireSso;
  }
  if (hint) {
    const warn = !s.ssoActive && !s.requireSso;
    hint.textContent = warn ? "Connect an identity provider before requiring SSO — enabling it now would lock every member out." : "";
    hint.classList.toggle("hidden", !warn);
  }
}

/** Open the WorkOS Admin Portal. On WEB the tab MUST be opened synchronously in
 *  the click gesture — opening it after the async portal fetch gets eaten by the
 *  popup blocker (the "dead button"). So we open a blank tab now, then point it
 *  at the URL. On desktop we hand off to the shell after the fetch. */
async function openPortal(intent: PortalIntent): Promise<void> {
  if (busy) return;
  const t = transport();
  if (!t) { setError(NO_TRANSPORT); return; }
  busy = true; setError("");
  const web = isWeb();
  const tab = web ? window.open("about:blank", "_blank") : null;
  try {
    const { url } = await t.portal(intent);
    if (url) {
      if (tab) tab.location.href = url;
      else {
        const open = (window as unknown as { glyphh?: { openExternal?: (u: string) => void } }).glyphh?.openExternal;
        if (open) open(url); else window.location.href = url;
      }
    } else { tab?.close(); }
    await loadOAuth();
  } catch (e) {
    tab?.close();
    setError(`Couldn't open the setup portal — ${(e as Error).message}`);
  } finally { busy = false; }
}

async function toggleRequireSso(): Promise<void> {
  const toggle = $("oauth-require-toggle") as HTMLInputElement | null;
  if (busy || !current || !toggle) return;
  const desired = toggle.checked;
  const t = transport();
  if (!t) { setError(NO_TRANSPORT); toggle.checked = current.requireSso; return; }
  busy = true; setError("");
  try {
    const r = await t.setRequireSso(desired);
    current.requireSso = r.requireSso;
    paint();
  } catch (e) {
    toggle.checked = current.requireSso; // revert the switch
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
  const connectBtn = $("oauth-connect-btn");
  // Don't latch `wired` until the panel is actually in the DOM, or an early
  // boot() call would no-op the real wiring and leave the buttons dead.
  if (!connectBtn) return;
  wired = true;
  connectBtn.addEventListener("click", () => void openPortal("sso"));
  $("oauth-require-toggle")?.addEventListener("change", () => void toggleRequireSso());
}
