/**
 * settings-api.ts — the ONE account transport for Settings › Billing /
 * Organization / Account, on BOTH targets.
 *
 *   • web      — server calls go straight through the SDK handle (window.glyphhSdk).
 *   • desktop  — server calls go through thin IPC methods (billing… / account…)
 *                → the MAIN-process SDK client (account-ipc.ts), per the
 *                architecture law that the renderer never holds a client.
 *
 * The renderer cannot import from @glyphh/sdk (preload boundary), so the SDK's
 * shapes are mirrored structurally below — thread-store.ts's discipline.
 *
 * Two call conventions, deliberately:
 *   reads  reject, so a panel can paint an honest "couldn't load" state and say
 *          why instead of rendering zeros that look like real data;
 *   writes resolve to { ok, error }, because a 403 from a non-admin is an
 *          EXPECTED outcome a form must explain, not an exception.
 *
 * Everything crossing this boundary keeps the server's units — money in USD
 * cents, credits in MICRO-credits. The display helpers at the bottom are the
 * one place those become human numbers.
 */

// ── Shapes (structural mirrors of the SDK contract) ───────────────────────

export interface BillingPlan {
  tier: string;
  displayName: string;
  monthlyUsdCents: number;
  activeUsdCents?: number;
  monthlyCredits: number;
  maxSeats: number;
  sso: boolean;
  /** A PROVISIONED per-org plan — a real invoiced deal, not the generic tier. */
  bespoke?: boolean;
}

export interface Subscription {
  tier: string;
  billingStatus: string;
  seats: number;
  maxSeats: number;
}

/** USD cents; `created` is unix SECONDS. */
export interface Invoice {
  id: string;
  number: string | null;
  amountDue: number;
  amountPaid: number;
  status: string | null;
  hostedUrl: string | null;
  created: number;
}

export interface PlanChange { tier: string; effect: string; url?: string }

export interface Address {
  line1: string; line2?: string; city: string; state: string; postalCode: string; country: string;
}
export interface PendingInvite {
  id: string; email: string; role: string;
  invitedByEmail: string | null; createdAt: string; expiresAt: string;
}

export interface BillingContact { name: string; email: string; phone?: string }

export interface Org {
  id: string;
  name: string;
  tier: string;
  maxSeats: number;
  seatsUsed: number;
  address: Address | null;
  billingAddress: Address | null;
  billingSameAsAddress: boolean;
  billingContact: BillingContact | null;
}
export interface OrgUpdate {
  name?: string;
  address?: Address | null;
  billingAddress?: Address | null;
  billingSameAsAddress?: boolean;
  billingContact?: BillingContact | null;
}

export interface Profile {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  timezone: string;
  role: string;
  imageUrl: string | null;
  avatarUrl: string;
}
export interface ProfileUpdate {
  firstName?: string;
  lastName?: string;
  timezone?: string;
  imageUrl?: string | null;
}

export interface Member { userId: string; email: string; name: string | null; role: string; disabled?: boolean }
/** `members.updateProfile` — a member's display name, set by an org admin. */
export interface MemberProfileUpdate { firstName?: string; lastName?: string }
/** What `members.invite` answers with. `acceptUrl` is the shareable fallback
 *  for when the invite email doesn't arrive. */
export interface CreatedInvite { acceptUrl?: string }

/** A write's answer: honest failure text, never a silent no-op. */
export type WriteResult<T> = { ok: true; data: T } | { ok: false; error: string };

// ── Transport (per surface, SDK only) ────────────────────────────────────

interface SdkAccountHandle {
  billing?: {
    plans?: () => Promise<BillingPlan[]>;
    status?: () => Promise<Subscription>;
    invoices?: () => Promise<Invoice[]>;
    subscribe?: (tier: string) => Promise<{ url: string }>;
    changePlan?: (tier: string) => Promise<PlanChange>;
    config?: () => Promise<{ publishableKey: string | null }>;
    portal?: () => Promise<{ url: string }>;
  };
  org?: {
    get?: () => Promise<Org>; update?: (patch: OrgUpdate) => Promise<Org>;
  };
  profile?: { get?: () => Promise<Profile>; update?: (patch: ProfileUpdate) => Promise<Profile> };
  members?: {
    list?: () => Promise<Member[]>;
    invite?: (email: string, role?: string) => Promise<CreatedInvite>;
    pendingInvites?: () => Promise<PendingInvite[]>;
    revokeInvite?: (id: string) => Promise<void>;
    remove?: (userId: string) => Promise<void>;
    setRole?: (userId: string, role: string) => Promise<Member>;
    setStatus?: (userId: string, disabled: boolean) => Promise<unknown>;
    updateProfile?: (userId: string, patch: MemberProfileUpdate) => Promise<Member>;
  };
}

interface DesktopAccountIpc {
  billingPlans?: () => Promise<BillingPlan[]>;
  billingStatus?: () => Promise<Subscription>;
  billingInvoices?: () => Promise<Invoice[]>;
  billingSubscribe?: (tier: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
  billingChangePlan?: (tier: string) => Promise<{ ok: boolean; change?: PlanChange; error?: string }>;
  billingConfig?: () => Promise<{ ok: boolean; publishableKey?: string | null; error?: string }>;
  billingPortal?: () => Promise<{ ok: boolean; url?: string; error?: string }>;
  accountOrgGet?: () => Promise<Org>;
  accountOrgUpdate?: (patch: OrgUpdate) => Promise<{ ok: boolean; org?: Org; error?: string }>;
  accountProfileGet?: () => Promise<Profile>;
  accountProfileUpdate?: (patch: ProfileUpdate) => Promise<{ ok: boolean; profile?: Profile; error?: string }>;
  accountMembersList?: () => Promise<Member[]>;
  accountMembersInvite?: (email: string, role: string) => Promise<{ ok: boolean; invite?: CreatedInvite; error?: string }>;
  orgInvitesList?: () => Promise<PendingInvite[]>;
  orgInviteRevoke?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  accountMembersRemove?: (userId: string) => Promise<{ ok: boolean; error?: string }>;
  accountMembersSetRole?: (userId: string, role: string) => Promise<{ ok: boolean; error?: string }>;
  accountMembersSetStatus?: (userId: string, disabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  accountMembersUpdateProfile?: (userId: string, patch: MemberProfileUpdate) => Promise<{ ok: boolean; error?: string }>;
}

export interface AccountApi {
  plans(): Promise<BillingPlan[]>;
  status(): Promise<Subscription>;
  invoices(): Promise<Invoice[]>;
  subscribe(tier: string): Promise<WriteResult<string>>;
  changePlan(tier: string): Promise<WriteResult<PlanChange>>;
  /** The public Stripe key, or null → embedded unavailable, use hosted. */
  billingConfig(): Promise<string | null>;
  portal(): Promise<WriteResult<string>>;
  org(): Promise<Org>;
  updateOrg(patch: OrgUpdate): Promise<WriteResult<Org>>;
  orgApps(): Promise<Array<{ id: string; name: string; slug: string }>>;
  profile(): Promise<Profile>;
  updateProfile(patch: ProfileUpdate): Promise<WriteResult<Profile>>;
  members(): Promise<Member[]>;
  inviteMember(email: string, role: string): Promise<WriteResult<CreatedInvite>>;
  pendingInvites(): Promise<PendingInvite[]>;
  revokeInvite(id: string): Promise<WriteResult<unknown>>;
  removeMember(userId: string): Promise<WriteResult<unknown>>;
  setMemberRole(userId: string, role: string): Promise<WriteResult<unknown>>;
  setMemberStatus(userId: string, disabled: boolean): Promise<WriteResult<unknown>>;
  updateMemberProfile(userId: string, patch: MemberProfileUpdate): Promise<WriteResult<unknown>>;
}

/** Message text for a transport that has no method for this call — a REAL gap
 *  (an old desktop build, or the web SDK handle not booted yet), reported as
 *  such rather than swallowed. */
const NO_TRANSPORT = "This build can't reach the account service.";

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg || "Request failed";
}

/** Wrap an SDK promise (web) into the shared write envelope. */
async function web<T>(run: (() => Promise<T>) | undefined): Promise<WriteResult<T>> {
  if (!run) return { ok: false, error: NO_TRANSPORT };
  try { return { ok: true, data: await run() }; }
  catch (err) { return { ok: false, error: errText(err) }; }
}

/** Unwrap the desktop `{ ok, <field>, error }` envelope into the shared one. */
async function ipc<T>(
  run: (() => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>) | undefined,
  field: string,
): Promise<WriteResult<T>> {
  if (!run) return { ok: false, error: NO_TRANSPORT };
  try {
    const res = await run();
    if (!res?.ok) return { ok: false, error: res?.error || "Request failed" };
    return { ok: true, data: res[field] as T };
  } catch (err) { return { ok: false, error: errText(err) }; }
}

/** A read whose transport is missing must FAIL, not resolve empty — an empty
 *  balance is indistinguishable from a real zero, and that lies to the user.
 *
 *  `owner` is REQUIRED: passing `b.plans` alone hands over a DETACHED method,
 *  and the SDK's own methods reach for `this.http`. Calling one bare threw
 *  "Cannot read properties of undefined (reading 'http')" the moment Billing
 *  opened. Bind it to the object it came from. */
function need<T>(fn: (() => Promise<T>) | undefined, owner: unknown): Promise<T> {
  return fn ? fn.call(owner) : Promise.reject(new Error(NO_TRANSPORT));
}

/**
 * The account transport for THIS surface. Order matters: on web `window.glyphh`
 * is a Proxy that fabricates a function for ANY name, so the SDK handle must be
 * checked first (thread-store.ts's trap).
 */
export function accountApi(): AccountApi {
  const sdk = (window as unknown as { glyphhSdk?: SdkAccountHandle }).glyphhSdk;
  if (sdk?.billing) {
    const b = sdk.billing, o = sdk.org, p = sdk.profile, m = sdk.members;
    return {
      plans: () => need(b.plans, b),
      status: () => need(b.status, b),
      invoices: () => need(b.invoices, b),
      subscribe: async (tier) => {
        const r = await web(b.subscribe && (() => b.subscribe!(tier)));
        return r.ok ? { ok: true, data: r.data.url } : r;
      },
      changePlan: (tier) => web(b.changePlan && (() => b.changePlan!(tier))),
      billingConfig: async () => {
        try { return b.config ? (await b.config()).publishableKey : null; } catch { return null; }
      },
      portal: async () => {
        const r = await web(b.portal && (() => b.portal!()));
        return r.ok ? { ok: true, data: r.data.url } : r;
      },
      org: () => need(o?.get, o),
      updateOrg: (patch) => web(o?.update && (() => o.update!(patch))),
      orgApps: async () => {
        const apps = (window as unknown as { glyphhSdk?: { apps?: { mine?: () => Promise<Array<{ id: string; name: string; slug: string }>> } } }).glyphhSdk?.apps;
        return apps?.mine ? (await apps.mine()).map((a) => ({ id: a.id, name: a.name, slug: a.slug })) : [];
      },
      profile: () => need(p?.get, p),
      updateProfile: (patch) => web(p?.update && (() => p.update!(patch))),
      members: () => need(m?.list, m),
      inviteMember: (email, role) => web(m?.invite && (() => m.invite!(email, role))),
      pendingInvites: () => need(m?.pendingInvites, m),
      revokeInvite: (id) => web(m?.revokeInvite && (() => m.revokeInvite!(id))),
      removeMember: (userId) => web(m?.remove && (() => m.remove!(userId))),
      setMemberRole: (userId, role) => web(m?.setRole && (() => m.setRole!(userId, role))),
      setMemberStatus: (userId, disabled) => web(m?.setStatus && (() => m.setStatus!(userId, disabled))),
      updateMemberProfile: (userId, patch) => web(m?.updateProfile && (() => m.updateProfile!(userId, patch))),
    };
  }

  const g = window.glyphh as unknown as DesktopAccountIpc;
  return {
    plans: () => need(g?.billingPlans, g),
    status: () => need(g?.billingStatus, g),
    invoices: () => need(g?.billingInvoices, g),
    subscribe: (tier) => ipc(g?.billingSubscribe && (() => g.billingSubscribe!(tier)), "url"),
    changePlan: (tier) => ipc(g?.billingChangePlan && (() => g.billingChangePlan!(tier)), "change"),
    billingConfig: async () => {
      try { const r = await g?.billingConfig?.(); return r?.ok ? (r.publishableKey ?? null) : null; } catch { return null; }
    },
    portal: () => ipc(g?.billingPortal && (() => g.billingPortal!()), "url"),
    org: () => need(g?.accountOrgGet, g),
    updateOrg: (patch) => ipc(g?.accountOrgUpdate && (() => g.accountOrgUpdate!(patch)), "org"),
    orgApps: async () => {
      const list = (window as unknown as { glyphh?: { panelAppsList?: () => Promise<Array<{ id: string; name: string; slug: string; appArchetype?: string | null }>> } }).glyphh?.panelAppsList;
      if (!list) return [];
      return (await list()).filter((a) => a.appArchetype === "glyphh-app").map((a) => ({ id: a.id, name: a.name, slug: a.slug }));
    },
    profile: () => need(g?.accountProfileGet, g),
    updateProfile: (patch) => ipc(g?.accountProfileUpdate && (() => g.accountProfileUpdate!(patch)), "profile"),
    members: () => need(g?.accountMembersList, g),
    inviteMember: (email, role) => ipc(g?.accountMembersInvite && (() => g.accountMembersInvite!(email, role)), "invite"),
    pendingInvites: () => need(g?.orgInvitesList, g),
    revokeInvite: (id) => ipc(g?.orgInviteRevoke && (() => g.orgInviteRevoke!(id)), "ok"),
    removeMember: (userId) => ipc(g?.accountMembersRemove && (() => g.accountMembersRemove!(userId)), "removed"),
    setMemberRole: (userId, role) => ipc(g?.accountMembersSetRole && (() => g.accountMembersSetRole!(userId, role)), "member"),
    setMemberStatus: (userId, disabled) => ipc(g?.accountMembersSetStatus && (() => g.accountMembersSetStatus!(userId, disabled)), "member"),
    updateMemberProfile: (userId, patch) => ipc(g?.accountMembersUpdateProfile && (() => g.accountMembersUpdateProfile!(userId, patch)), "member"),
  };
}

// ── Units + formatting (the one place server units become human ones) ─────

/** 1 credit = 1e6 micro-credits. */
export const MICRO = 1_000_000;

/** Top-up rate — DISPLAY only; the server prices the actual purchase. */
/** VOLUME DISCOUNTS — mirrors the server's TOPUP_DISCOUNT_TIERS (pricing.ts);
 *  thresholds in credits, fraction off the flat rate. Keep them in sync. */
export const toCredits = (micro: number): number => Math.floor((micro || 0) / MICRO);
export const fmtInt = (n: number): string => Math.max(0, Math.round(n || 0)).toLocaleString();

/** Stripe amounts arrive in USD cents. */
export function fmtMoney(cents: number, currency = "usd"): string {
  const amount = (cents || 0) / 100;
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(amount); }
  catch { return `$${amount.toFixed(2)}`; }
}

/** Stripe timestamps arrive in unix SECONDS. */
export function fmtDate(unixSeconds: number | null): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Open a Stripe-hosted page (Checkout, Customer Portal, an invoice). On
 * desktop it becomes a workbench browser panel beside the agent — the same
 * mechanics Settings → Manage Account uses; on web there is no workbench, so
 * it opens a new tab. Either way the user never leaves the app they're in.
 */
export function openHostedPage(name: string, url: string, inWorkbench: (n: string, u: string) => void): boolean {
  // A Stripe hand-off is always an https URL; anything else is a malformed
  // server response and is refused rather than navigated to. The boolean lets
  // the caller say so out loud instead of appearing to have done nothing.
  if (!/^https:\/\//i.test(url || "")) return false;
  const isWeb = !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
  if (isWeb) window.open(url, "_blank", "noopener");
  else inWorkbench(name, url);
  return true;
}
