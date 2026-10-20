/**
 * contract/billing.ts — plans, the org's subscription state, and its Pipedream
 * budget. Money is dollars: the plan pool (the plan price, dollar for dollar),
 * purchased funds and admin grants are all USD. Stripe amounts stay USD cents.
 */

export interface Plan {
  tier: string;
  displayName: string;
  monthlyUsdCents: number;
  /** The TRUE active Stripe price amount (cents) for this tier, when resolvable —
   *  falls back to monthlyUsdCents. Prefer this for display. */
  activeUsdCents?: number;
  /** The monthly budget the plan funds, in dollars — the plan price,
   *  dollar for dollar (free = $1). */
  poolUsdPerMonth: number;
  maxSeats: number;
  sso: boolean;
  /** Role governance — which tier carries it, so an upsell can name the real
   *  plan rather than a hardcoded guess. */
  governance?: boolean;
  /** True for the caller org's own PROVISIONED per-org (enterprise) plan — a real invoiced
   *  price + pool, shown as the current plan rather than the "contact sales" card. */
  bespoke?: boolean;
  active?: boolean;
}

export interface Subscription {
  tier: string;
  billingStatus: string; // trial | active | past_due | canceled | none
  seats: number;
  maxSeats: number;
  /** The org's current RUNTIME IMAGE (§7b) + its recurring price in whole credits/mo —
   *  the data hook recurring image billing consumes. Null when the bound key resolves
   *  to no catalog row in the org's region. */
  runtimeImage?: { key: string; region: string; monthlyCredits: number } | null;
}

/**
 * The org's budget for the current period, in dollars.
 *   planUsd      — what the plan funds this month (its price, dollar for dollar)
 *   fundsUsd     — purchased funds + admin grants on top of the plan
 *   spentUsd     — Pipedream connector spend so far this period
 *   remainingUsd — planUsd + fundsUsd − spentUsd
 */
export interface Balance {
  planUsd: number;
  fundsUsd: number;
  spentUsd: number;
  remainingUsd: number;
  periodStart: string;
  periodEnd: string;
}

/**
 * The caller's own budget: what their organization lets them spend
 * (limitUsd, from their key, their team, or the organization's cap; null = no
 * limit set) plus what runs through Glyphh (poolUsd). spentUsd is
 * this month's spend on their key, calls through Glyphh included.
 */
export interface MemberBudget {
  limitUsd: number | null;
  limitSource: "member" | "team" | "organization" | null;
  spentUsd: number;
  poolUsd: number;
  poolSpentUsd: number;
  poolRemainingUsd: number;
  /** The member's ONE line: "member" = their own limit, "team" = their child team's budget, "org" = the org's pool. */
  poolSource: "member" | "team" | "org";
  planUsd: number;
  fundsUsd: number;
  periodStart: string;
  periodEnd: string;
}

/** A Stripe-hosted URL (Checkout or Customer Portal). */
export interface HostedUrl {
  url: string;
}

/** The org's auto-reload rule, in dollars. */
export interface AutotopupConfig {
  enabled: boolean;
  thresholdUsd: number; // reload when the remaining budget falls to/below this
  topupUsd: number; // dollars to add per reload
}

/** The input to configure auto-reload (dollars). */
export interface AutotopupInput {
  enabled: boolean;
  thresholdUsd: number;
  topupUsd: number;
}

/** The outcome of a change-plan call. */
export interface PlanChange {
  tier: string;
  billingStatus: string;
  /** 'upgrade' (invoiced now) | 'downgrade' (next renewal) | 'checkout' (free→paid). */
  effect: "upgrade" | "downgrade" | "checkout";
  /** Present only when effect === 'checkout': the hosted Checkout url to open. */
  url?: string;
  /** Present when effect === 'checkout' and EMBEDDED was asked: the client
   *  secret the in-app modal mounts — the same flow Add funds uses. */
  clientSecret?: string;
}

/** One normalized Stripe invoice (money in USD cents; times in unix seconds). */
export interface Invoice {
  id: string;
  number: string | null;
  amountDue: number;
  amountPaid: number;
  status: string | null;
  hostedUrl: string | null;
  pdfUrl: string | null;
  created: number;
  periodStart: number | null;
  periodEnd: number | null;
}

/** The input to add funds (whole dollars, minimum 5). `embedded` asks for an
 *  Embedded Checkout client secret instead of a hosted url. */
export interface TopupInput {
  usd: number;
  embedded?: boolean;
}

/** A started Add-funds checkout: hosted url OR embedded client secret, per the request. */
export interface TopupCheckout {
  url?: string;
  clientSecret?: string;
}

/** Client-side billing config — the PUBLIC Stripe key (pk_*), or null when
 *  the server has none (clients then fall back to hosted checkout). */
export interface BillingConfig {
  publishableKey: string | null;
}

/** What the org owes next. The billing date is anchored at subscription
 *  creation and a seat change never moves it. */
export interface UpcomingInvoice {
  hasUpcoming: boolean;
  amountDue?: number;
  subtotal?: number;
  currency?: string;
  dueAt?: number;
  periodStart?: number | null;
  periodEnd?: number | null;
  prorations?: number;
  lines?: Array<{ description: string; amount: number; quantity: number; proration: boolean }>;
}
