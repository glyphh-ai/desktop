/**
 * contract/marketplace.ts — marketplace DEVELOPER PROFILES + their reviews. One
 * profile per org OR per user (the apps publisher XOR, mirrored): a handle, a
 * display name, an avatar, links, a support contact — and stars, because
 * developers are rated exactly like apps.
 */

export type DeveloperScope = "org" | "personal";

/** A developer profile as the marketplace renders it. */
export interface MarketplaceDeveloper {
  handle: string;
  displayName: string;
  scope: DeveloperScope;
  avatarUrl: string | null;
  bio: string | null;
  website: string | null;
  links: Record<string, string>;
  supportEmail: string | null;
  /** The profile's own DIRECT stars (developer reviews). */
  ratingAvg: number;
  ratingCount: number;
  /** The COMPUTED across-their-apps rollup, shown beside the direct rating. */
  apps: { ratingAvg: number; ratingCount: number; count: number };
  createdAt: string;
  updatedAt: string;
}

export interface CreateDeveloperInput {
  scope: DeveloperScope;
  /** Kebab-case, globally unique, immutable once created. */
  handle: string;
  displayName: string;
  bio?: string;
  website?: string;
  links?: Record<string, string>;
  supportEmail?: string;
}

export interface UpdateDeveloperInput {
  displayName?: string;
  bio?: string | null;
  website?: string | null;
  links?: Record<string, string>;
  supportEmail?: string | null;
}

/** One review of a developer — the AppReview shape, mirrored. */
export interface DeveloperReview {
  id: string;
  stars: number;
  body: string | null;
  status: "published" | "flagged" | "removed";
  authorName: string | null;
  ownerResponse: string | null;
  ownerRespondedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A flagged developer review as the moderation queue sees it. */
export interface FlaggedDeveloperReview extends DeveloperReview {
  developerHandle: string;
  reportReason: string | null;
  reportedAt: string | null;
}

// ── the developer program + payout ledger (marketplace M7) ────────────────────

export type DeveloperProgramStatus = "none" | "enrolled" | "suspended";

/** Payout readiness, derived server-side from Stripe's account.updated webhook:
 *  none (no account) → pending (attached, unconfirmed) → ready (payable) /
 *  restricted (Stripe says it cannot be paid). Only 'ready' is swept. */
export type DeveloperPayoutStatus = "none" | "pending" | "ready" | "restricted";

/** A profile's program state: enrollment, the agreement CONSENT RECORD (with
 *  the server's current version, so a client can tell "accepted" from
 *  "accepted, but the agreement moved on"), and payout config. */
export interface DeveloperProgram {
  handle: string;
  status: DeveloperProgramStatus;
  agreement: {
    currentVersion: string;
    acceptedVersion: string | null;
    acceptedAt: string | null;
    /** True when the accepted version IS the current one — the listing gate. */
    current: boolean;
  };
  payout: {
    /** MASKED ("acct_…" + last 4) — the raw Connect id never leaves the server. */
    stripeConnectAccountId: string | null;
    /** Whether a Connect account is attached at all (onboarded or manual). */
    connected: boolean;
    /** Webhook-derived readiness — 'ready' is the only payable state. */
    payoutStatus: DeveloperPayoutStatus;
    thresholdCredits: number;
    status: "configured" | "unconfigured";
  };
}

export interface PayoutConfigInput {
  /** A Stripe Connect account id (acct_…). null disconnects it. */
  stripeConnectAccountId?: string | null;
  /** Minimum unpaid NET credits before the monthly sweep pays out. */
  payoutThresholdCredits?: number;
}

/** One revenue-share ledger row (amounts in micro-credits). */
export interface DeveloperEarning {
  id: string;
  appSlug: string;
  kind: "install" | "renewal";
  grossCreditsMicro: number;
  storeCutCreditsMicro: number;
  netCreditsMicro: number;
  payoutId: string | null;
  createdAt: string;
}

export interface DeveloperEarningsTotals {
  grossCreditsMicro: number;
  storeCutCreditsMicro: number;
  netCreditsMicro: number;
  unpaidNetCreditsMicro: number;
}

export interface DeveloperPayout {
  id: string;
  amountCreditsMicro: number;
  status: "pending" | "paid" | "failed";
  stripeTransferId: string | null;
  error: string | null;
  createdAt: string;
  paidAt: string | null;
  /** Present on the admin queue only. */
  developerHandle?: string;
}

/** The admin earnings roll: one row per developer with money or a program. */
export interface AdminDeveloperEarningsSummary {
  handle: string;
  displayName: string;
  programStatus: string;
  payoutThresholdCredits: number;
  payoutConfigured: boolean;
  grossCreditsMicro: number;
  storeCutCreditsMicro: number;
  netCreditsMicro: number;
  unpaidNetCreditsMicro: number;
}

// ── Library marketplace (skills + loops, his order 2026-09-02) ───────────────

/** A skills/loops marketplace listing — a content snapshot frozen at publish,
 *  platform-reviewed like an app release. Always free to install. */
export interface LibraryListing {
  id: string;
  kind: "skill" | "loop";
  slug: string;
  name: string;
  description: string;
  manifest: Record<string, unknown>;
  reviewStatus: "submitted" | "in_review" | "approved" | "rejected";
  reviewNotes: string | null;
  submittedAt: string;
  listedAt: string | null;
  suspended: boolean;
  installs: number;
  /** Whether the CALLER holds an install seat. */
  installed: boolean;
}

/** An open org-share submission awaiting an org admin's ruling. */
export interface LibraryShareRequest {
  id: string;
  kind: "skill" | "loop";
  slug: string;
  name: string;
  requestedBy: string;
  submittedAt: string;
}
