/**
 * settings-org.ts — Settings › Organization.
 *
 * Ported from the platform's Settings → Organization page and its shared data
 * layer (platform/app/lib/org/hooks.js): org name, the read-only seat ceiling,
 * one org address, a "billing address is the same" toggle that reveals a second
 * address block when off, and a billing contact that defaults to the org admin.
 *
 * Pack rules match the platform's exactly: blank fields are stripped, and an
 * all-blank address (or contact) serializes to null so the server stores
 * "unset" rather than a record of empty strings.
 *
 * org.update is org_admin — the server enforces it. The panel gates on the
 * caller's role too, so a member reads an explanation instead of a form that
 * would only ever 403.
 */

import { accountApi, type Address, type BillingContact, type Org, type OrgUpdate } from "./settings-api.js";

const ADDRESS_FIELDS = ["line1", "line2", "city", "state", "postalCode", "country"] as const;
type AddressField = typeof ADDRESS_FIELDS[number];

/** The server's copy — the baseline for dirty-checks. */
let saved: Org | null = null;
let wired = false;
let statusTimer = 0;
let saveTimer = 0;
/** True while hydrate() writes values in, so its own events aren't mistaken
 *  for edits and echoed back to the server. */
let hydrating = false;

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

/** The one place a save reports itself, now that there's no Save button. */
function setStatus(msg: string, kind: "success" | "error" | ""): void {
  const el = $("org-status");
  if (!el) return;
  el.textContent = msg;
  el.className = `set-save-state${kind ? ` ${kind}` : ""}`;
  window.clearTimeout(statusTimer);
  if (kind === "success") statusTimer = window.setTimeout(() => { el.textContent = ""; }, 2500);
}

function setError(msg: string): void {
  const el = $("org-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

/** Show the section's one-line gate (loading / failed) and hide the form. */
function gate(msg: string): void {
  const g = $("org-gate");
  const form = $("org-form");
  if (g) { g.textContent = msg; g.classList.toggle("hidden", !msg); }
  if (form) form.classList.toggle("hidden", !!msg);
}

/** Organization is a SECTION of Account now, not a tab — so a non-admin gets
 *  no section at all rather than an explanation of a form they can't see. */
function showSection(on: boolean): void {
  $("org-section")?.classList.toggle("hidden", !on);
}

/** The full-width bar above the form: name left, org id right. */
function paintOrgHeader(): void {
  const nameEl = $("org-header-name");
  const idEl = $("org-header-id");
  if (nameEl) nameEl.textContent = saved?.name || "—";
  if (idEl) idEl.textContent = saved?.id || "—";
}

// ── Address helpers (the platform's pack/strip rules) ────────────────────

/** Read one address block out of the DOM. */
function readAddress(prefix: "org" | "bill"): Record<AddressField, string> {
  const out = {} as Record<AddressField, string>;
  for (const f of ADDRESS_FIELDS) {
    const id = `${prefix}-addr-${f === "postalCode" ? "postal" : f}`;
    out[f] = ($<HTMLInputElement>(id)?.value || "").trim();
  }
  return out;
}

function writeAddress(prefix: "org" | "bill", addr: Address | null): void {
  for (const f of ADDRESS_FIELDS) {
    const id = `${prefix}-addr-${f === "postalCode" ? "postal" : f}`;
    const input = $<HTMLInputElement>(id);
    if (input) input.value = (addr?.[f] as string | undefined) || "";
  }
}

/** Strip empties; an all-empty address is `null` (the server's "unset"). */
function packAddress(a: Record<AddressField, string>): Address | null {
  const out: Record<string, string> = {};
  for (const f of ADDRESS_FIELDS) if (a[f]) out[f] = a[f];
  return Object.keys(out).length ? (out as unknown as Address) : null;
}

function packContact(c: { name: string; email: string; phone: string }): BillingContact | null {
  const out: Record<string, string> = {};
  for (const k of ["name", "email", "phone"] as const) if (c[k]) out[k] = c[k];
  return Object.keys(out).length ? (out as unknown as BillingContact) : null;
}

function readContact(): { name: string; email: string; phone: string } {
  return {
    name: ($<HTMLInputElement>("org-contact-name")?.value || "").trim(),
    email: ($<HTMLInputElement>("org-contact-email")?.value || "").trim(),
    phone: ($<HTMLInputElement>("org-contact-phone")?.value || "").trim(),
  };
}

/** Reveal/hide the two conditional blocks from their toggles. */
function syncConditionals(): void {
  const same = $<HTMLInputElement>("org-billing-same")?.checked ?? true;
  $("org-billing-addr-wrap")?.classList.toggle("hidden", same);
  const adminIsBilling = $<HTMLInputElement>("org-admin-is-billing")?.checked ?? true;
  $("org-contact-wrap")?.classList.toggle("hidden", adminIsBilling);
}

// ── Form state ───────────────────────────────────────────────────────────

/** Fill the form from the server copy. Only the initial load calls this — an
 *  auto-save must NOT rewrite the boxes underneath the caret. */
function hydrate(): void {
  if (!saved) return;
  hydrating = true;
  const name = $<HTMLInputElement>("org-name");
  if (name) name.value = saved.name || "";
  const seats = $("org-max-seats");
  if (seats) seats.textContent = String(saved.maxSeats ?? 1);
  writeAddress("org", saved.address);
  writeAddress("bill", saved.billingAddress);
  const same = $<HTMLInputElement>("org-billing-same");
  if (same) same.checked = saved.billingSameAsAddress !== false;
  // "No contact set" IS the signal that the org admin is the billing contact.
  const adminIsBilling = $<HTMLInputElement>("org-admin-is-billing");
  if (adminIsBilling) adminIsBilling.checked = saved.billingContact == null;
  const c = saved.billingContact;
  const set = (id: string, v: string): void => { const el = $<HTMLInputElement>(id); if (el) el.value = v; };
  set("org-contact-name", c?.name || "");
  set("org-contact-email", c?.email || "");
  set("org-contact-phone", c?.phone || "");
  paintOrgHeader();
  syncConditionals();
  setError("");
  setStatus("", "");
  hydrating = false;
}

/** The full patch the server takes — the platform sends every field, so a
 *  cleared address really clears rather than silently persisting. */
function buildPatch(): OrgUpdate {
  const same = $<HTMLInputElement>("org-billing-same")?.checked ?? true;
  const adminIsBilling = $<HTMLInputElement>("org-admin-is-billing")?.checked ?? true;
  return {
    name: ($<HTMLInputElement>("org-name")?.value || "").trim(),
    address: packAddress(readAddress("org")),
    billingSameAsAddress: same,
    billingAddress: same ? null : packAddress(readAddress("bill")),
    billingContact: adminIsBilling ? null : packContact(readContact()),
  };
}

/** Key-order-independent compare — the server's JSON needn't match ours. */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val);
}

/**
 * Whether the form differs from the server's copy. The patch carries every
 * field by design, so without this every blur would POST an identical record.
 */
function isDirty(patch: OrgUpdate): boolean {
  if (!saved) return false;
  const same = saved.billingSameAsAddress !== false;
  const current: OrgUpdate = {
    name: saved.name || "",
    address: saved.address,
    billingSameAsAddress: same,
    billingAddress: same ? null : saved.billingAddress,
    billingContact: saved.billingContact,
  };
  return stable(current) !== stable(patch);
}

async function save(): Promise<void> {
  const patch = buildPatch();
  // A cleared name is an unfinished edit, not a request to blank the org.
  if (!patch.name) { setError("Organization name is required."); setStatus("", ""); return; }
  if (!isDirty(patch)) { setStatus("", ""); return; }

  setError("");
  setStatus("Saving…", "");
  try {
    const res = await accountApi().updateOrg(patch);
    if (!res.ok) { setError(res.error); setStatus("Not saved", "error"); return; }
    saved = res.data;
    // The bar follows the save; the INPUTS deliberately don't get rewritten, or
    // a keystroke landing mid-flight would be yanked back to the old value.
    paintOrgHeader();
    setStatus("Saved", "success");
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
    setStatus("Not saved", "error");
  }
}

/**
 * Commit after the user stops typing. Every field routes through here, so a
 * burst of keystrokes is one request and a toggle lands right away.
 */
function scheduleSave(delay = 700): void {
  if (hydrating) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { void save(); }, delay);
}

/** Fold the section open or shut. */
function setExpanded(on: boolean): void {
  $("org-toggle")?.setAttribute("aria-expanded", String(on));
  $("org-body")?.classList.toggle("hidden", !on);
}

export function initOrg(): void {
  if (wired) return;
  wired = true;

  $("org-toggle")?.addEventListener("click", () => {
    setExpanded($("org-toggle")?.getAttribute("aria-expanded") !== "true");
  });

  // Toggles change what's SENT (a hidden block serializes to null), so each one
  // both re-syncs the form and commits.
  for (const id of ["org-billing-same", "org-admin-is-billing"]) {
    $(id)?.addEventListener("change", () => { syncConditionals(); scheduleSave(0); });
  }
  // Every text field in the section, without naming all seventeen by hand.
  $("org-form")?.querySelectorAll<HTMLInputElement>("input.settings-input").forEach((input) => {
    input.addEventListener("input", () => scheduleSave());
    input.addEventListener("blur", () => scheduleSave(0));
  });

  // Copy the org id — it's what support tickets and API calls ask for. Inside
  // the disclosure button, so its click must not also fold the section.
  const copy = $("org-copy-id");
  const doCopy = (ev: Event): void => {
    ev.stopPropagation();
    if (!saved?.id || !copy) return;
    void navigator.clipboard.writeText(saved.id).then(() => {
      copy.classList.add("copied");
      window.setTimeout(() => copy.classList.remove("copied"), 1400);
    }).catch(() => { /* clipboard denied — the id is on screen to select */ });
  };
  copy?.addEventListener("click", doCopy);
  copy?.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key === "Enter" || (ev as KeyboardEvent).key === " ") doCopy(ev);
  });
}

/**
 * Load the org record into Account's Organization section. Editing is
 * org_admin, so a member gets no section at all rather than a form the server
 * would refuse — and a transport failure says what happened instead of
 * rendering an empty organization.
 */
export async function loadOrg(): Promise<void> {
  initOrg();
  try {
    const account = await window.glyphh.getAccountInfo().catch(() => null);
    const role = account?.role || "";
    if (!role || !["org_admin", "super_admin"].includes(role)) {
      showSection(false);
      return;
    }
    showSection(true);
    gate("Loading…");
    saved = await accountApi().org();
    gate("");
    hydrate();
    // The hint names the admin whose inbox invoices land in, when we know it.
    const hint = $("org-billing-contact-hint");
    if (hint && account?.email) {
      hint.textContent = `Billing questions and invoices go to the org admin (${account.email}). Turn this off to designate someone else.`;
    }
  } catch (err) {
    gate(`Couldn't load your organization — ${err instanceof Error ? err.message : String(err)}`);
  }
}
