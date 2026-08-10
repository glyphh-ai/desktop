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

import { accountApi, type Org, type Address, type OrgUpdate } from "./settings-api.js";

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
  const seats = $("org-panel-seats");
  const tier = $("org-panel-tier");
  if (seats) seats.textContent = org ? `${org.seatsUsed ?? "—"} / ${org.maxSeats ?? "—"}` : "—";
  if (tier) tier.textContent = org?.tier ? org.tier.charAt(0).toUpperCase() + org.tier.slice(1) : "—";
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
  for (const [, id] of ADDR_FIELDS) {
    ($(id) as HTMLInputElement | null)?.addEventListener("blur", () => void save({ address: readAddress() }));
  }
}
