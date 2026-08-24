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

import { accountApi, type Org, type Address, type OrgUpdate, type BillingContact } from "./settings-api.js";

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

// The billing address + contact — the bottom part of the old Account org form,
// now living on this page (his spec, 2026-08-24).
const BILL_FIELDS: Array<[keyof Address, string]> = [
  ["line1", "bill-addr-line1"], ["line2", "bill-addr-line2"],
  ["city", "bill-addr-city"], ["state", "bill-addr-state"],
  ["postalCode", "bill-addr-postal"], ["country", "bill-addr-country"],
];

function readFields(fields: Array<[keyof Address, string]>): Address | null {
  const get = (id: string): string => ($(id) as HTMLInputElement | null)?.value.trim() || "";
  const addr = Object.fromEntries(fields.map(([k, id]) => [k, get(id)])) as unknown as Address;
  return Object.values(addr).some(Boolean) ? addr : null;
}

function readContact(): BillingContact | null {
  const get = (id: string): string => ($(id) as HTMLInputElement | null)?.value.trim() || "";
  const c = { name: get("org-contact-name"), email: get("org-contact-email"), phone: get("org-contact-phone") };
  const out: Record<string, string> = {};
  for (const k of ["name", "email", "phone"] as const) if (c[k]) out[k] = c[k];
  return Object.keys(out).length ? (out as unknown as BillingContact) : null;
}

/** Reveal/hide the two conditional blocks from their toggles. */
function syncConditionals(): void {
  const same = ($("org-billing-same") as HTMLInputElement | null)?.checked ?? true;
  $("org-billing-addr-wrap")?.classList.toggle("hidden", same);
  const adminIsBilling = ($("org-admin-is-billing") as HTMLInputElement | null)?.checked ?? true;
  $("org-contact-wrap")?.classList.toggle("hidden", adminIsBilling);
}

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
  // Billing address + contact.
  const ba = org?.billingAddress;
  for (const [key, id] of BILL_FIELDS) {
    const el = $(id) as HTMLInputElement | null;
    if (el && document.activeElement !== el) el.value = (ba?.[key] as string | undefined) || "";
  }
  const same = $("org-billing-same") as HTMLInputElement | null;
  if (same) same.checked = org ? org.billingSameAsAddress !== false : true;
  // "No contact set" IS the signal that the org admin is the billing contact.
  // A saved contact forces it off; while none is saved the user's staged
  // un-check (fields revealed, not yet filled) is left alone.
  const adminIsBilling = $("org-admin-is-billing") as HTMLInputElement | null;
  if (adminIsBilling && org?.billingContact) adminIsBilling.checked = false;
  const c = org?.billingContact;
  const setV = (id: string, v: string): void => {
    const el = $(id) as HTMLInputElement | null;
    if (el && document.activeElement !== el) el.value = v;
  };
  setV("org-contact-name", c?.name || "");
  setV("org-contact-email", c?.email || "");
  setV("org-contact-phone", c?.phone || "");
  syncConditionals();
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
  ($("org-billing-same") as HTMLInputElement | null)?.addEventListener("change", (e) => {
    const same = (e.currentTarget as HTMLInputElement).checked;
    syncConditionals();
    void save({ billingSameAsAddress: same, billingAddress: same ? null : readFields(BILL_FIELDS) });
  });
  for (const [, id] of BILL_FIELDS) {
    ($(id) as HTMLInputElement | null)?.addEventListener("blur", () => void save({ billingAddress: readFields(BILL_FIELDS) }));
  }
  ($("org-admin-is-billing") as HTMLInputElement | null)?.addEventListener("change", (e) => {
    const adminIs = (e.currentTarget as HTMLInputElement).checked;
    syncConditionals();
    // OFF saves nothing yet — an empty contact round-trips as null and the
    // repaint would snap the switch straight back on. The contact fields
    // commit themselves on blur; ON clears the stored contact at once.
    if (adminIs) void save({ billingContact: null });
  });
  for (const id of ["org-contact-name", "org-contact-email", "org-contact-phone"]) {
    ($(id) as HTMLInputElement | null)?.addEventListener("blur", () => void save({ billingContact: readContact() }));
  }
}
