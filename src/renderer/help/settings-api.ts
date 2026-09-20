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
 * Everything crossing this boundary keeps the server's units — Stripe money in
 * USD cents, the budget in DOLLARS. The display helpers at the bottom
 * are the one place those become human numbers.
 */

// ── Shapes (structural mirrors of the SDK contract) ───────────────────────

export interface BillingPlan {
  tier: string;
  displayName: string;
  monthlyUsdCents: number;
  activeUsdCents?: number;
  /** The monthly budget the plan funds, in dollars — its price, dollar for dollar. */
  poolUsdPerMonth: number;
  maxSeats: number;
  sso: boolean;
  /** A PROVISIONED per-org plan — a real invoiced deal, not the generic tier. */
  bespoke?: boolean;
}

export interface UpcomingInvoice {
  hasUpcoming: boolean;
  amountDue?: number;
  currency?: string;
  dueAt?: number;
  prorations?: number;
}

export interface Subscription {
  tier: string;
  billingStatus: string;
  seats: number;
  maxSeats: number;
}

/** The org's budget this period, in dollars. */
export interface Balance {
  planUsd: number;
  fundsUsd: number;
  spentUsd: number;
  remainingUsd: number;
  periodStart: string;
  periodEnd: string;
}

/** The auto-reload rule, in dollars. */
export interface Autotopup {
  enabled: boolean;
  thresholdUsd: number;
  topupUsd: number;
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
    upcoming?: () => Promise<UpcomingInvoice>;
    reconcile?: () => Promise<Subscription>;
    balance?: () => Promise<Balance>;
    invoices?: () => Promise<Invoice[]>;
    autotopup?: () => Promise<Autotopup>;
    setAutotopup?: (input: Autotopup) => Promise<Autotopup>;
    subscribe?: (tier: string) => Promise<{ url: string }>;
    subscribeEmbedded?: (tier: string) => Promise<{ clientSecret?: string }>;
    changePlan?: (tier: string) => Promise<PlanChange>;
    topup?: (input: { usd: number; embedded?: boolean }) => Promise<{ url?: string; clientSecret?: string }>;
    config?: () => Promise<{ publishableKey: string | null }>;
    portal?: () => Promise<{ url: string }>;
  };
  org?: {
    get?: () => Promise<Org>; update?: (patch: OrgUpdate) => Promise<Org>;
    domains?: () => Promise<OrgDomain[]>; addDomain?: (domain: string) => Promise<OrgDomain>;
    verifyDomain?: (id: string) => Promise<OrgDomain>; removeDomain?: (id: string) => Promise<void>;
    setDomainApexApp?: (id: string, appId: string | null) => Promise<OrgDomain>;
    setDomainWildcard?: (id: string, wildcard: boolean) => Promise<OrgDomain>;
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

/** One org white-label domain (server docs/custom-domains.md). */
export interface OrgDomain {
  apexAppId?: string | null;
  wildcard?: boolean;
  id: string;
  domain: string;
  status: string;
  sso: string | null;
  error: string | null;
  verifiedAt: string | null;
  createdAt: string;
  dns: Array<{ type: string; name: string; value: string }>;
  hostnames: Record<string, string>;
}

interface DesktopAccountIpc {
  billingPlans?: () => Promise<BillingPlan[]>;
  billingStatus?: () => Promise<Subscription>;
  billingUpcoming?: () => Promise<{ ok: boolean; upcoming?: UpcomingInvoice; error?: string }>;
  billingReconcile?: () => Promise<Subscription>;
  billingBalance?: () => Promise<Balance>;
  billingInvoices?: () => Promise<Invoice[]>;
  billingAutotopupGet?: () => Promise<Autotopup>;
  billingAutotopupSet?: (input: Autotopup) => Promise<{ ok: boolean; config?: Autotopup; error?: string }>;
  billingSubscribe?: (tier: string, embedded?: boolean) => Promise<{ ok: boolean; url?: string; clientSecret?: string; error?: string }>;
  billingChangePlan?: (tier: string) => Promise<{ ok: boolean; change?: PlanChange; error?: string }>;
  billingTopup?: (usd: number, embedded?: boolean) => Promise<{ ok: boolean; url?: string; clientSecret?: string; error?: string }>;
  billingConfig?: () => Promise<{ ok: boolean; publishableKey?: string | null; error?: string }>;
  billingPortal?: () => Promise<{ ok: boolean; url?: string; error?: string }>;
  accountOrgGet?: () => Promise<Org>;
  orgDomainsList?: () => Promise<OrgDomain[]>;
  orgDomainAdd?: (domain: string) => Promise<{ ok: boolean; domain?: OrgDomain; error?: string }>;
  orgDomainVerify?: (id: string) => Promise<{ ok: boolean; domain?: OrgDomain; error?: string }>;
  orgDomainApexSet?: (id: string, appId: string | null) => Promise<{ ok: boolean; domain?: OrgDomain; error?: string }>;
  orgDomainWildcardSet?: (id: string, wildcard: boolean) => Promise<{ ok: boolean; domain?: OrgDomain; error?: string }>;
  orgDomainRemove?: (id: string) => Promise<{ ok: boolean; removed?: boolean; error?: string }>;
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
  /** The next invoice: the amount and the day it lands. */
  upcoming(): Promise<UpcomingInvoice>;
  /** Stripe's records applied now: plan + paid funds. Falls back to a plain status read. */
  reconcile(): Promise<Subscription>;
  /** The budget this period (dollars). */
  balance(): Promise<Balance>;
  invoices(): Promise<Invoice[]>;
  autotopup(): Promise<Autotopup>;
  setAutotopup(input: Autotopup): Promise<WriteResult<Autotopup>>;
  subscribe(tier: string): Promise<WriteResult<string>>;
  /** Embedded Checkout for a plan: a client secret to mount in-app. */
  subscribeEmbedded(tier: string): Promise<WriteResult<string>>;
  changePlan(tier: string): Promise<WriteResult<PlanChange>>;
  /** Add funds (whole dollars, min 5) — the hosted Checkout URL. */
  topup(usd: number): Promise<WriteResult<string>>;
  /** Embedded Checkout: a client secret to mount in-app. */
  topupEmbedded(usd: number): Promise<WriteResult<string>>;
  /** The public Stripe key, or null → embedded unavailable, use hosted. */
  billingConfig(): Promise<string | null>;
  portal(): Promise<WriteResult<string>>;
  org(): Promise<Org>;
  updateOrg(patch: OrgUpdate): Promise<WriteResult<Org>>;
  orgDomains(): Promise<OrgDomain[]>;
  addOrgDomain(domain: string): Promise<WriteResult<OrgDomain>>;
  verifyOrgDomain(id: string): Promise<WriteResult<OrgDomain>>;
  removeOrgDomain(id: string): Promise<WriteResult<unknown>>;
  setOrgDomainApexApp(id: string, appId: string | null): Promise<WriteResult<OrgDomain>>;
  setOrgDomainWildcard(id: string, wildcard: boolean): Promise<WriteResult<OrgDomain>>;
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
      upcoming: () => (b.upcoming ? need(b.upcoming, b) : Promise.resolve({ hasUpcoming: false })),
      reconcile: () => (b.reconcile ? b.reconcile() : need(b.status, b)),
      balance: () => need(b.balance, b),
      invoices: () => need(b.invoices, b),
      autotopup: () => need(b.autotopup, b),
      setAutotopup: (input) => web(b.setAutotopup && (() => b.setAutotopup!(input))),
      subscribe: async (tier) => {
        const r = await web(b.subscribe && (() => b.subscribe!(tier)));
        return r.ok ? { ok: true, data: r.data.url } : r;
      },
      subscribeEmbedded: async (tier) => {
        const r = await web(b.subscribeEmbedded && (() => b.subscribeEmbedded!(tier)));
        return r.ok && r.data.clientSecret ? { ok: true, data: r.data.clientSecret } : r.ok ? { ok: false, error: "no client secret" } : r;
      },
      changePlan: (tier) => web(b.changePlan && (() => b.changePlan!(tier))),
      topup: async (usd) => {
        const r = await web(b.topup && (() => b.topup!({ usd })));
        return r.ok && r.data.url ? { ok: true, data: r.data.url } : r.ok ? { ok: false, error: "no checkout url" } : r;
      },
      topupEmbedded: async (usd) => {
        const r = await web(b.topup && (() => b.topup!({ usd, embedded: true })));
        return r.ok && r.data.clientSecret ? { ok: true, data: r.data.clientSecret } : r.ok ? { ok: false, error: "no client secret" } : r;
      },
      billingConfig: async () => {
        try { return b.config ? (await b.config()).publishableKey : null; } catch { return null; }
      },
      portal: async () => {
        const r = await web(b.portal && (() => b.portal!()));
        return r.ok ? { ok: true, data: r.data.url } : r;
      },
      org: () => need(o?.get, o),
      updateOrg: (patch) => web(o?.update && (() => o.update!(patch))),
      orgDomains: () => need(o?.domains, o),
      addOrgDomain: (domain) => web(o?.addDomain && (() => o.addDomain!(domain))),
      verifyOrgDomain: (id) => web(o?.verifyDomain && (() => o.verifyDomain!(id))),
      removeOrgDomain: (id) => web(o?.removeDomain && (() => o.removeDomain!(id))),
      setOrgDomainApexApp: (id, appId) => web(o?.setDomainApexApp && (() => o.setDomainApexApp!(id, appId))),
      setOrgDomainWildcard: (id, wildcard) => web(o?.setDomainWildcard && (() => o.setDomainWildcard!(id, wildcard))),
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
    upcoming: async () => {
      try { const r = await g?.billingUpcoming?.(); return r?.ok && r.upcoming ? r.upcoming : { hasUpcoming: false }; }
      catch { return { hasUpcoming: false }; }
    },
    reconcile: () => (g?.billingReconcile ? g.billingReconcile() : need(g?.billingStatus, g)),
    balance: () => need(g?.billingBalance, g),
    invoices: () => need(g?.billingInvoices, g),
    autotopup: () => need(g?.billingAutotopupGet, g),
    setAutotopup: (input) => ipc(g?.billingAutotopupSet && (() => g.billingAutotopupSet!(input)), "config"),
    subscribe: (tier) => ipc(g?.billingSubscribe && (() => g.billingSubscribe!(tier)), "url"),
    subscribeEmbedded: (tier) => ipc(g?.billingSubscribe && (() => g.billingSubscribe!(tier, true)), "clientSecret"),
    changePlan: (tier) => ipc(g?.billingChangePlan && (() => g.billingChangePlan!(tier)), "change"),
    topup: (usd) => ipc(g?.billingTopup && (() => g.billingTopup!(usd)), "url"),
    topupEmbedded: (usd) => ipc(g?.billingTopup && (() => g.billingTopup!(usd, true)), "clientSecret"),
    billingConfig: async () => {
      try { const r = await g?.billingConfig?.(); return r?.ok ? (r.publishableKey ?? null) : null; } catch { return null; }
    },
    portal: () => ipc(g?.billingPortal && (() => g.billingPortal!()), "url"),
    org: () => need(g?.accountOrgGet, g),
    updateOrg: (patch) => ipc(g?.accountOrgUpdate && (() => g.accountOrgUpdate!(patch)), "org"),
    orgDomains: () => need(g?.orgDomainsList, g),
    addOrgDomain: (domain) => ipc(g?.orgDomainAdd && (() => g.orgDomainAdd!(domain)), "domain"),
    verifyOrgDomain: (id) => ipc(g?.orgDomainVerify && (() => g.orgDomainVerify!(id)), "domain"),
    removeOrgDomain: (id) => ipc(g?.orgDomainRemove && (() => g.orgDomainRemove!(id)), "removed"),
    setOrgDomainApexApp: (id, appId) => ipc(g?.orgDomainApexSet && (() => g.orgDomainApexSet!(id, appId)), "domain"),
    setOrgDomainWildcard: (id, wildcard) => ipc(g?.orgDomainWildcardSet && (() => g.orgDomainWildcardSet!(id, wildcard)), "domain"),
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

/** The Add-funds buckets, in whole dollars — dollar for dollar, no tiers. */
export const TOPUP_USD_BUCKETS = [20, 45, 80, 140];
/** The smallest Add-funds purchase the server accepts. */
export const TOPUP_MIN_USD = 5;

export const fmtInt = (n: number): string => Math.max(0, Math.round(n || 0)).toLocaleString();

/** Dollars for display — "$12.34"; a whole amount stays whole ("$20"). */
export function fmtUsd(usd: number): string {
  const v = Number.isFinite(usd) ? usd : 0;
  const whole = Number.isInteger(Math.round(v * 100) / 100) && Number.isInteger(v);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(v);
  } catch { return `$${v.toFixed(whole ? 0 : 2)}`; }
}

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
