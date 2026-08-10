/**
 * settings-guardrails.ts — Settings › Guardrails (org-wide runtime limits).
 *
 * org_admin only (nav item gated in navigation.ts; the server enforces the
 * write). Blank = no limit. Each field commits itself on blur, matching the
 * "every field saves itself" contract of the other Settings panels. Ported from
 * mobile.tsx GuardrailsTray.
 *
 * Transport — web → window.glyphhSdk.org.guardrails/setGuardrails; desktop →
 * window.glyphh.orgGuardrailsGet/orgGuardrailsSet IPC (account-ipc.ts).
 */

type Policy = Record<string, number>;
interface Guardrails { guardrails_policy: Policy | null }

interface SdkOrgGuardrails {
  guardrails?: () => Promise<Guardrails>;
  setGuardrails?: (policy: Policy | null) => Promise<Guardrails>;
}
interface DesktopGuardrailsIpc {
  orgGuardrailsGet?: () => Promise<Guardrails>;
  orgGuardrailsSet?: (policy: Policy | null) => Promise<{ ok: boolean; guardrails?: Guardrails; error?: string }>;
}

interface GuardrailsTransport {
  get(): Promise<Guardrails>;
  set(policy: Policy | null): Promise<Guardrails>;
}

const NO_TRANSPORT = "Guardrails aren't available on this build.";
const isWeb = (): boolean => !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;

function transport(): GuardrailsTransport | null {
  if (isWeb()) {
    const o = (window as unknown as { glyphhSdk?: { org?: SdkOrgGuardrails } }).glyphhSdk?.org;
    if (!o?.guardrails || !o.setGuardrails) return null;
    return { get: () => o.guardrails!(), set: (p) => o.setGuardrails!(p) };
  }
  const g = (window as unknown as { glyphh?: DesktopGuardrailsIpc }).glyphh;
  if (!g?.orgGuardrailsGet || !g.orgGuardrailsSet) return null;
  return {
    get: () => g.orgGuardrailsGet!(),
    set: async (p) => {
      const r = await g.orgGuardrailsSet!(p);
      if (!r?.ok || !r.guardrails) throw new Error(r?.error || "Could not save.");
      return r.guardrails;
    },
  };
}

const KEYS = ["maxInputTokens", "maxOutputTokens", "maxConcurrent", "windowSeconds", "windowTokens", "windowCalls"] as const;

const $ = (id: string) => document.getElementById(id);
let policy: Policy | null = null;
let wired = false;
let statusTimer = 0;

function setError(msg: string): void {
  const el = $("guardrails-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function flashSaved(): void {
  const el = $("guardrails-status");
  if (!el) return;
  el.textContent = "Saved";
  el.className = "set-save-state success";
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => { el.textContent = ""; }, 1600);
}

/** Show the panel only to an org admin — same rule as Members/Workspaces. */
function showPanel(on: boolean): void {
  $("guardrails-admin-only")?.classList.toggle("hidden", on);
  $("guardrails-body")?.classList.toggle("hidden", !on);
  document.querySelector<HTMLElement>('.settings-nav .settings-nav-item[data-sub="guardrails"]')
    ?.classList.toggle("hidden", !on);
}

function paintFields(): void {
  for (const k of KEYS) {
    const input = $(`gr-${k}`) as HTMLInputElement | null;
    if (input && document.activeElement !== input) input.value = policy?.[k] != null ? String(policy[k]) : "";
  }
}

async function save(key: string, raw: string): Promise<void> {
  const next: Policy = { ...(policy || {}) };
  const n = raw.trim() === "" ? NaN : Number(raw);
  if (Number.isNaN(n) || n < 0) delete next[key]; else next[key] = n;
  const nextPolicy = Object.keys(next).length ? next : null;
  const t = transport();
  if (!t) { setError(NO_TRANSPORT); return; }
  setError("");
  try {
    const res = await t.set(nextPolicy);
    policy = res.guardrails_policy;
    paintFields();
    flashSaved();
  } catch (e) { setError((e as Error).message); }
}

export async function loadGuardrails(): Promise<void> {
  initGuardrails();
  setError("");
  const account = await (window as unknown as { glyphh?: { getAccountInfo?: () => Promise<{ role?: string } | null> } })
    .glyphh?.getAccountInfo?.().catch(() => null);
  const role = account?.role || "";
  if (!role || !["org_admin", "super_admin"].includes(role)) { showPanel(false); return; }
  showPanel(true);
  const t = transport();
  if (!t) { policy = null; paintFields(); setError(NO_TRANSPORT); return; }
  try { policy = (await t.get()).guardrails_policy; paintFields(); }
  catch (e) { policy = null; paintFields(); setError(`Couldn't load guardrails — ${(e as Error).message}`); }
}

export function initGuardrails(): void {
  if (wired) return;
  wired = true;
  for (const k of KEYS) {
    const input = $(`gr-${k}`) as HTMLInputElement | null;
    input?.addEventListener("blur", () => void save(k, input.value));
  }
}
