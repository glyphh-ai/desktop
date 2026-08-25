/**
 * marketplace-data.ts — the marketplace's TYPES + TRANSPORT + shared helpers.
 *
 * Shapes are structural mirrors of the SDK contract (contract/apps.ts +
 * contract/marketplace.ts) — the renderer program can't import the SDK
 * (settings-admin.ts's discipline), so the contract is mirrored once here and
 * every marketplace module reads these.
 *
 * Transport — web → window.glyphhSdk (the raw @glyphh/sdk client the web
 * bridge exposes; checked FIRST because on web window.glyphh is a Proxy that
 * fabricates methods); desktop → window.glyphh.mkt* IPC (marketplace-ipc.ts →
 * main-process SDK). Reads REJECT when neither transport can serve them, so
 * panels paint an honest "couldn't load"; writes always return `{ ok, error }`.
 */

import { appIconInner } from "./app-icon.js";

// ── Shapes (structural mirrors of the SDK contract) ───────────────────────

export type MktAppKind = "web" | "native" | "glyphh" | "workpanel";

export interface MktPricing {
  monthlyCredits: number;
  discountPercent: number | null;
  discountStartsAt: string | null;
  discountEndsAt: string | null;
  effectiveMonthlyCredits: number;
}

/** One browsed listing (contract AppListing). */
export interface MktListing {
  slug: string;
  name: string;
  version: string;
  description: string | null;
  publisherOrgId: string;
  visibility: "public" | "org" | "unlisted" | "private";
  installs: number;
  kind: MktAppKind;
  builtin: boolean;
  suspended: boolean;
  pricing: MktPricing;
  createdAt: string;
  updatedAt: string;
}

/** The listing's marketing record (contract AppListingRecord). */
export interface MktListingRecord {
  title: string;
  tagline: string | null;
  body: string | null;
  category: string | null;
  iconUrl: string | null;
  screenshots: { url: string; caption: string }[];
  videoUrl: string | null;
  website: string | null;
  supportEmail: string | null;
  ratingAvg: number;
  ratingCount: number;
  listedAt: string | null;
}

/** The publisher's developer card on a detail page (contract AppDeveloperCard). */
export interface MktDeveloperCard {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  supportEmail: string | null;
  ratingAvg: number;
  ratingCount: number;
}

/** The full detail payload (contract AppMarketplaceDetail). */
export interface MktDetail {
  slug: string;
  name: string;
  version: string;
  description: string | null;
  owned: boolean;
  installs: number;
  kind: MktAppKind;
  builtin: boolean;
  suspended: boolean;
  pricing: MktPricing;
  developer: MktDeveloperCard | null;
  /** PLATFORM ADMINS ONLY: an open malicious report exists. Absent otherwise. */
  reported?: boolean;
  listing: MktListingRecord;
  requiredConnections: { slug: string; actAs: string; connected: boolean }[];
}

/** One installer's review (contract AppReview / DeveloperReview). */
export interface MktReview {
  id: string;
  stars: number;
  body: string | null;
  version?: string | null;
  status: "published" | "flagged" | "removed";
  authorName: string | null;
  ownerResponse: string | null;
  ownerRespondedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MktFlaggedReview extends MktReview {
  appSlug?: string;
  developerHandle?: string;
  reportReason: string | null;
  reportedAt: string | null;
}

export type MktReleaseReviewStatus = "draft" | "submitted" | "in_review" | "approved" | "rejected";

/** One immutable build (contract AppRelease). */
export interface MktRelease {
  id: string;
  version: string;
  status: "pending" | "uploading" | "building" | "ready" | "failed";
  error: string | null;
  notes: string | null;
  channel: "dev" | "live";
  promotedAt: string | null;
  reviewStatus: MktReleaseReviewStatus;
  reviewNotes: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;  reviewRecommendations?: { summary: string; items: Array<{ severity: string; area: string; note: string }>; author: string; createdAt: string } | null;
}

export interface MktAdminApp {
  id: string; slug: string; name: string; kind: string; suspended: boolean;
  suspendReason: string | null; listed: boolean; publisherOrg: string | null; installs: number;
}

export interface MktQueueRelease extends MktRelease {
  submitNote?: string | null;
  appSlug: string;
  appName: string;
  publisherOrgId: string;  reviewRecommendations?: { summary: string; items: Array<{ severity: string; area: string; note: string }>; author: string; createdAt: string } | null;
}

/** One malicious report in the triage queue (contract AppReport). */
export interface MktReport {
  id: string;
  appSlug: string | null;
  appName: string | null;
  reason: string;
  detail: string | null;
  status: "open" | "reviewing" | "resolved" | "dismissed";
  createdAt: string;
  resolvedAt: string | null;
}

/** A developer profile (contract MarketplaceDeveloper). */
export interface MktDeveloper {
  handle: string;
  displayName: string;
  scope: "org" | "personal";
  avatarUrl: string | null;
  bio: string | null;
  website: string | null;
  links: Record<string, string>;
  supportEmail: string | null;
  ratingAvg: number;
  ratingCount: number;
  /** The COMPUTED across-their-apps rollup, shown beside the direct stars. */
  apps: { ratingAvg: number; ratingCount: number; count: number };
  createdAt: string;
  updatedAt: string;
}

export interface MktDeveloperInput {
  scope: "org" | "personal";
  handle: string;
  displayName: string;
  bio?: string;
  website?: string;
  links?: Record<string, string>;
  supportEmail?: string;
}

export interface MktDeveloperPatch {
  displayName?: string;
  bio?: string | null;
  website?: string | null;
  links?: Record<string, string>;
  supportEmail?: string | null;
}

export interface MktPricingPatch {
  monthlyCredits?: number;
  discountPercent?: number | null;
  discountStartsAt?: string | null;
  discountEndsAt?: string | null;
}

// ── Developer program (M7) ────────────────────────────────────────────────
//
// Contract mirrors of the SDK's program surface (contract/marketplace.ts):
// client.marketplace.program / enrollProgram / setPayoutConfig /
// developerEarnings / developerPayouts — all HANDLE-scoped (a profile, not
// the org, holds a program). Reads resolve null only when the SDK build in
// front of us predates the surface ("coming online").

export type MktProgramStatus = "none" | "enrolled" | "suspended";

/** Payout readiness (contract DeveloperPayoutStatus), derived server-side
 *  from Stripe's account.updated webhook: none (no account) → pending
 *  (attached, unconfirmed) → ready (payable) / restricted (Stripe says it
 *  cannot be paid). Only 'ready' is swept. */
export type MktPayoutStatus = "none" | "pending" | "ready" | "restricted";

/** A profile's program state (contract DeveloperProgram): enrollment, the
 *  agreement CONSENT RECORD, and payout config. Owner-only on the server. */
export interface MktProgramState {
  handle: string;
  status: MktProgramStatus;
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
    payoutStatus: MktPayoutStatus;
    /** Minimum unpaid NET credits before the monthly sweep pays out (server default 1000). */
    thresholdCredits: number;
    status: "configured" | "unconfigured";
  };
}

/** Payout-config patch (contract PayoutConfigInput). */
export interface MktPayoutPatch {
  /** acct_… — null disconnects it. */
  stripeConnectAccountId?: string | null;
  payoutThresholdCredits?: number;
}

/** One revenue-share ledger row (contract DeveloperEarning; micro-credits). */
export interface MktEarningRow {
  id: string;
  appSlug: string;
  kind: "install" | "renewal";
  grossCreditsMicro: number;
  storeCutCreditsMicro: number;
  netCreditsMicro: number;
  payoutId: string | null;
  createdAt: string;
}

/** Lifetime rollup (contract DeveloperEarningsTotals; micro-credits). */
export interface MktEarningsTotals {
  grossCreditsMicro: number;
  storeCutCreditsMicro: number;
  netCreditsMicro: number;
  unpaidNetCreditsMicro: number;
}

/** The developerEarnings page: ledger rows (newest first) + lifetime totals. */
export interface MktEarningsPage {
  earnings: MktEarningRow[];
  total: number;
  totals: MktEarningsTotals;
}

/** One payout (contract DeveloperPayout; micro-credits). */
export interface MktPayout {
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

/** Micro-credits (1e6 per credit, the ledger's unit) → display credits. */
export function mktCreditsFromMicro(micro: number): string {
  return (micro / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** One of the org's own apps as the console lists them (subset of OrgApp). */
export interface MktOrgApp {
  id: string;
  slug: string;
  name: string;
  kind: MktAppKind;
  version: string;
  owned?: boolean;
  listing?: MktListingRecord;
}

// ── Transport ─────────────────────────────────────────────────────────────

/** The subset of the raw @glyphh/sdk client the marketplace reads (web). */
interface SdkApps {
  browse?: () => Promise<MktListing[]>;
  installed?: () => Promise<{ slug: string }[]>;
  get?: (slug: string) => Promise<MktDetail>;
  install?: (slug: string) => Promise<{ slug: string }>;
  uninstall?: (slug: string) => Promise<void>;
  reviews?: (slug: string, q?: { limit?: number; offset?: number }) => Promise<{ reviews: MktReview[]; total: number }>;
  review?: (slug: string, input: { stars: number; body?: string }) => Promise<MktReview>;
  removeReview?: (slug: string) => Promise<void>;
  reportReview?: (slug: string, reviewId: string, reason: string) => Promise<MktReview>;
  respondToReview?: (slug: string, reviewId: string, response: string) => Promise<MktReview>;
  report?: (slug: string, reason: string, detail?: string) => Promise<MktReport>;
  mine?: () => Promise<MktOrgApp[]>;
  setPricing?: (slug: string, patch: MktPricingPatch) => Promise<{ ok: boolean }>;
  releases?: (slug: string) => Promise<MktRelease[]>;
  submitRelease?: (slug: string, releaseId: string, note?: string) => Promise<MktRelease>;
  adminSearch?: (q: string) => Promise<{ apps: MktAdminApp[] }>;
  reviewQueue?: () => Promise<MktQueueRelease[]>;
  reviewRelease?: (releaseId: string, action: "begin" | "approve" | "reject", notes?: string, force?: boolean, shareRecommendations?: boolean) => Promise<MktRelease>;
  releaseSourceTree?: (releaseId: string) => Promise<{ files: Array<{ path: string; size: number }> }>;
  releaseSourceFile?: (releaseId: string, path: string) => Promise<{ path: string; size: number; content: string }>;
  reports?: (status?: string) => Promise<MktReport[]>;
  resolveReport?: (reportId: string, status: "reviewing" | "resolved" | "dismissed") => Promise<MktReport>;
  flaggedReviews?: () => Promise<MktFlaggedReview[]>;
  moderateReview?: (reviewId: string, action: "restore" | "remove") => Promise<MktReview>;
  suspend?: (slug: string, reason?: string) => Promise<{ ok: boolean; suspended: boolean }>;
  unsuspend?: (slug: string) => Promise<{ ok: boolean; suspended: boolean }>;
}
interface SdkMarketplace {
  createDeveloper?: (input: MktDeveloperInput) => Promise<MktDeveloper>;
  myDevelopers?: () => Promise<{ personal: MktDeveloper | null; org: MktDeveloper | null }>;
  developer?: (handle: string) => Promise<MktDeveloper>;
  updateDeveloper?: (handle: string, patch: MktDeveloperPatch) => Promise<MktDeveloper>;
  uploadDeveloperAvatar?: (handle: string, bytes: Uint8Array) => Promise<{ key: string }>;
  developerReviews?: (handle: string, q?: { limit?: number; offset?: number }) => Promise<{ reviews: MktReview[]; total: number }>;
  reviewDeveloper?: (handle: string, input: { stars: number; body?: string }) => Promise<MktReview>;
  removeDeveloperReview?: (handle: string) => Promise<void>;
  respondToDeveloperReview?: (handle: string, reviewId: string, response: string) => Promise<MktReview>;
  reportDeveloperReview?: (handle: string, reviewId: string, reason: string) => Promise<MktReview>;
  flaggedDeveloperReviews?: () => Promise<MktFlaggedReview[]>;
  moderateDeveloperReview?: (reviewId: string, action: "restore" | "remove") => Promise<MktReview>;
  // The M7 program surface — handle-scoped, contract shapes verbatim. Still
  // optional (`?.`) so an SDK bundle that predates it reads as "coming online".
  program?: (handle: string) => Promise<MktProgramState>;
  enrollProgram?: (handle: string, agreementVersion: string) => Promise<MktProgramState>;
  setPayoutConfig?: (handle: string, patch: MktPayoutPatch) => Promise<MktProgramState>;
  startStripeOnboarding?: (handle: string, input?: { country?: string }) => Promise<{ url: string }>;
  developerEarnings?: (handle: string, q?: { limit?: number; offset?: number }) => Promise<MktEarningsPage>;
  developerPayouts?: (handle: string) => Promise<MktPayout[]>;
}
interface MktSdkHandle { apps?: SdkApps; marketplace?: SdkMarketplace }

/** The desktop IPC methods (preload → marketplace-ipc.ts), typed loosely and
 *  narrowed at the seam — the contract shapes cross the boundary verbatim. */
interface MktIpc {
  mktBrowse?: () => Promise<unknown>;
  mktDetail?: (slug: string) => Promise<unknown>;
  mktInstall?: (slug: string) => Promise<unknown>;
  mktUninstall?: (slug: string) => Promise<unknown>;
  mktReviews?: (slug: string, q?: { limit?: number; offset?: number }) => Promise<unknown>;
  mktReviewPut?: (slug: string, input: { stars: number; body?: string }) => Promise<unknown>;
  mktReviewDelete?: (slug: string) => Promise<unknown>;
  mktReviewReport?: (slug: string, reviewId: string, reason: string) => Promise<unknown>;
  mktReviewRespond?: (slug: string, reviewId: string, response: string) => Promise<unknown>;
  mktReportApp?: (slug: string, reason: string, detail?: string) => Promise<unknown>;
  mktMyApps?: () => Promise<unknown>;
  mktPricingSet?: (slug: string, patch: MktPricingPatch) => Promise<unknown>;
  mktReleases?: (slug: string) => Promise<unknown>;
  mktReleaseSubmit?: (slug: string, releaseId: string, note?: string) => Promise<unknown>;
  mktDevMe?: () => Promise<unknown>;
  mktDevGet?: (handle: string) => Promise<unknown>;
  mktDevCreate?: (input: MktDeveloperInput) => Promise<unknown>;
  mktDevUpdate?: (handle: string, patch: MktDeveloperPatch) => Promise<unknown>;
  mktDevAvatar?: (handle: string, bytes: ArrayBuffer) => Promise<unknown>;
  mktDevReviews?: (handle: string, q?: { limit?: number; offset?: number }) => Promise<unknown>;
  mktDevReviewPut?: (handle: string, input: { stars: number; body?: string }) => Promise<unknown>;
  mktDevReviewDelete?: (handle: string) => Promise<unknown>;
  mktDevReviewRespond?: (handle: string, reviewId: string, response: string) => Promise<unknown>;
  mktDevReviewReport?: (handle: string, reviewId: string, reason: string) => Promise<unknown>;
  mktAdminQueue?: () => Promise<unknown>;
  mktAdminReview?: (releaseId: string, action: "begin" | "approve" | "reject", notes?: string, share?: boolean) => Promise<unknown>;
  mktAdminSourceTree?: (releaseId: string) => Promise<{ files: Array<{ path: string; size: number }> }>;
  mktAdminSourceFile?: (releaseId: string, path: string) => Promise<{ path: string; size: number; content: string }>;
  mktAdminReports?: (status?: string) => Promise<unknown>;
  mktAdminReportResolve?: (reportId: string, status: string) => Promise<unknown>;
  mktAdminFlaggedReviews?: () => Promise<unknown>;
  mktAdminReviewModerate?: (reviewId: string, action: "restore" | "remove") => Promise<unknown>;
  mktAdminDevFlagged?: () => Promise<unknown>;
  mktAdminDevModerate?: (reviewId: string, action: "restore" | "remove") => Promise<unknown>;
  mktAdminSuspend?: (slug: string, suspend: boolean, reason?: string) => Promise<unknown>;
  mktAdminAppSearch?: (q: string) => Promise<{ apps: MktAdminApp[] }>;
  // Developer program (M7) — handle-scoped, `{ ok, … }` envelopes.
  mktProgramState?: (handle: string) => Promise<unknown>;
  mktProgramEnroll?: (handle: string, agreementVersion: string) => Promise<unknown>;
  mktPayoutConfigSet?: (handle: string, patch: MktPayoutPatch) => Promise<unknown>;
  mktStripeOnboarding?: (handle: string) => Promise<unknown>;
  mktEarnings?: (handle: string, q?: { limit?: number; offset?: number }) => Promise<unknown>;
  mktPayouts?: (handle: string) => Promise<unknown>;
}

const NO_TRANSPORT = "This build can't reach the marketplace.";

const sdk = (): MktSdkHandle | null =>
  (window as unknown as { glyphhSdk?: MktSdkHandle }).glyphhSdk ?? null;
const ipc = (): MktIpc =>
  (window as unknown as { glyphh?: MktIpc }).glyphh ?? {};

const errText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)) || "Request failed";

/** A read on whichever transport this surface has; REJECTS when neither can
 *  serve it. SDK first — on web window.glyphh is a fabricating Proxy. */
async function read<T>(web: (s: MktSdkHandle) => Promise<T> | undefined, desk: (g: MktIpc) => Promise<unknown> | undefined): Promise<T> {
  const s = sdk();
  if (s) {
    const p = web(s);
    if (p) return p;
  }
  const p = desk(ipc());
  if (p) {
    const r = await p;
    // On web, fabricated methods resolve undefined — a nullish answer is a
    // MISSING transport, not an empty result.
    if (r == null) throw new Error(NO_TRANSPORT);
    return r as T;
  }
  throw new Error(NO_TRANSPORT);
}

export type MktWrite<T = void> = { ok: true; data: T } | { ok: false; error: string };

/** A write on whichever transport exists — always the `{ ok, error }` envelope
 *  (a 403/402 is an EXPECTED outcome a form must explain, never a throw). */
async function write<T>(
  web: (s: MktSdkHandle) => Promise<T> | undefined,
  desk: (g: MktIpc) => Promise<unknown> | undefined,
  field?: string,
): Promise<MktWrite<T>> {
  const s = sdk();
  if (s) {
    try {
      const p = web(s);
      if (p) return { ok: true, data: await p };
    } catch (err) { return { ok: false, error: errText(err) }; }
  }
  try {
    const p = desk(ipc());
    if (!p) return { ok: false, error: NO_TRANSPORT };
    const res = (await p) as ({ ok: boolean; error?: string } & Record<string, unknown>) | null | undefined;
    if (!res || typeof res.ok !== "boolean") return { ok: false, error: NO_TRANSPORT };
    if (!res.ok) return { ok: false, error: res.error || "Request failed" };
    return { ok: true, data: (field ? res[field] : undefined) as T };
  } catch (err) { return { ok: false, error: errText(err) }; }
}

/** The marketplace transport — every marketplace module's single data seam. */
export const mkt = {
  // storefront
  browse: () => read<{ apps: MktListing[]; installedSlugs: string[] }>(
    (s) => {
      const b = s.apps?.browse?.(); const i = s.apps?.installed?.();
      if (!b) return undefined;
      return Promise.all([b, i ?? Promise.resolve([])]).then(([apps, installs]) => ({
        apps, installedSlugs: (installs || []).map((x) => x.slug),
      }));
    },
    (g) => g.mktBrowse?.(),
  ),
  detail: (slug: string) => read<{ detail: MktDetail; installed: boolean }>(
    (s) => {
      const d = s.apps?.get?.(slug); const i = s.apps?.installed?.();
      if (!d) return undefined;
      return Promise.all([d, i ?? Promise.resolve([])]).then(([detail, installs]) => ({
        detail, installed: (installs || []).some((x) => x.slug === detail.slug),
      }));
    },
    (g) => g.mktDetail?.(slug),
  ),
  install: (slug: string) => write<{ slug: string } | undefined>(
    (s) => s.apps?.install?.(slug), (g) => g.mktInstall?.(slug)),
  uninstall: (slug: string) => write<void>(
    (s) => s.apps?.uninstall?.(slug), (g) => g.mktUninstall?.(slug)),

  // app reviews
  reviews: (slug: string, q: { limit?: number; offset?: number } = {}) =>
    read<{ reviews: MktReview[]; total: number }>((s) => s.apps?.reviews?.(slug, q), (g) => g.mktReviews?.(slug, q)),
  putReview: (slug: string, input: { stars: number; body?: string }) =>
    write<MktReview>((s) => s.apps?.review?.(slug, input), (g) => g.mktReviewPut?.(slug, input), "review"),
  deleteReview: (slug: string) =>
    write<void>((s) => s.apps?.removeReview?.(slug), (g) => g.mktReviewDelete?.(slug)),
  reportReview: (slug: string, reviewId: string, reason: string) =>
    write<MktReview>((s) => s.apps?.reportReview?.(slug, reviewId, reason), (g) => g.mktReviewReport?.(slug, reviewId, reason), "review"),
  respondToReview: (slug: string, reviewId: string, response: string) =>
    write<MktReview>((s) => s.apps?.respondToReview?.(slug, reviewId, response), (g) => g.mktReviewRespond?.(slug, reviewId, response), "review"),

  // malicious reports
  reportApp: (slug: string, reason: string, detail?: string) =>
    write<MktReport>((s) => s.apps?.report?.(slug, reason, detail), (g) => g.mktReportApp?.(slug, reason, detail), "report"),

  // developer console
  myApps: () => read<{ apps: MktOrgApp[] }>(
    (s) => s.apps?.mine?.()?.then((apps) => ({ apps })), (g) => g.mktMyApps?.()),
  setPricing: (slug: string, patch: MktPricingPatch) =>
    write<unknown>((s) => s.apps?.setPricing?.(slug, patch), (g) => g.mktPricingSet?.(slug, patch)),
  releases: (slug: string) => read<{ releases: MktRelease[] }>(
    (s) => s.apps?.releases?.(slug)?.then((releases) => ({ releases })), (g) => g.mktReleases?.(slug)),
  submitRelease: (slug: string, releaseId: string, note?: string) =>
    write<MktRelease>((s) => s.apps?.submitRelease?.(slug, releaseId, note), (g) => g.mktReleaseSubmit?.(slug, releaseId, note), "release"),

  // developer profiles + their reviews
  devMe: () => read<{ personal: MktDeveloper | null; org: MktDeveloper | null }>(
    (s) => s.marketplace?.myDevelopers?.(), (g) => g.mktDevMe?.()),
  devGet: (handle: string) => read<MktDeveloper>(
    (s) => s.marketplace?.developer?.(handle), (g) => g.mktDevGet?.(handle)),
  devCreate: (input: MktDeveloperInput) =>
    write<MktDeveloper>((s) => s.marketplace?.createDeveloper?.(input), (g) => g.mktDevCreate?.(input), "developer"),
  devUpdate: (handle: string, patch: MktDeveloperPatch) =>
    write<MktDeveloper>((s) => s.marketplace?.updateDeveloper?.(handle, patch), (g) => g.mktDevUpdate?.(handle, patch), "developer"),
  devAvatar: (handle: string, bytes: Uint8Array) =>
    write<unknown>(
      (s) => s.marketplace?.uploadDeveloperAvatar?.(handle, bytes),
      (g) => g.mktDevAvatar?.(handle, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
    ),
  devReviews: (handle: string, q: { limit?: number; offset?: number } = {}) =>
    read<{ reviews: MktReview[]; total: number }>((s) => s.marketplace?.developerReviews?.(handle, q), (g) => g.mktDevReviews?.(handle, q)),
  putDevReview: (handle: string, input: { stars: number; body?: string }) =>
    write<MktReview>((s) => s.marketplace?.reviewDeveloper?.(handle, input), (g) => g.mktDevReviewPut?.(handle, input), "review"),
  deleteDevReview: (handle: string) =>
    write<void>((s) => s.marketplace?.removeDeveloperReview?.(handle), (g) => g.mktDevReviewDelete?.(handle)),
  respondToDevReview: (handle: string, reviewId: string, response: string) =>
    write<MktReview>((s) => s.marketplace?.respondToDeveloperReview?.(handle, reviewId, response), (g) => g.mktDevReviewRespond?.(handle, reviewId, response), "review"),
  reportDevReview: (handle: string, reviewId: string, reason: string) =>
    write<MktReview>((s) => s.marketplace?.reportDeveloperReview?.(handle, reviewId, reason), (g) => g.mktDevReviewReport?.(handle, reviewId, reason), "review"),

  // platform-admin queues
  adminQueue: () => read<{ releases: MktQueueRelease[] }>(
    (s) => s.apps?.reviewQueue?.()?.then((releases) => ({ releases })), (g) => g.mktAdminQueue?.()),
  adminReview: (releaseId: string, action: "begin" | "approve" | "reject", notes?: string, share?: boolean) =>
    write<MktRelease>((s) => s.apps?.reviewRelease?.(releaseId, action, notes, undefined, share), (g) => g.mktAdminReview?.(releaseId, action, notes, share), "release"),
  adminSourceTree: (releaseId: string) =>
    read<{ files: Array<{ path: string; size: number }> }>((s) => s.apps?.releaseSourceTree?.(releaseId), (g) => g.mktAdminSourceTree?.(releaseId)),
  adminSourceFile: (releaseId: string, path: string) =>
    read<{ path: string; size: number; content: string }>((s) => s.apps?.releaseSourceFile?.(releaseId, path), (g) => g.mktAdminSourceFile?.(releaseId, path)),
  adminReports: (status?: "open" | "reviewing" | "resolved" | "dismissed") =>
    read<{ reports: MktReport[] }>((s) => s.apps?.reports?.(status)?.then((reports) => ({ reports })), (g) => g.mktAdminReports?.(status)),
  adminResolveReport: (reportId: string, status: "reviewing" | "resolved" | "dismissed") =>
    write<MktReport>((s) => s.apps?.resolveReport?.(reportId, status), (g) => g.mktAdminReportResolve?.(reportId, status), "report"),
  adminFlaggedReviews: () => read<{ reviews: MktFlaggedReview[] }>(
    (s) => s.apps?.flaggedReviews?.()?.then((reviews) => ({ reviews })), (g) => g.mktAdminFlaggedReviews?.()),
  adminModerateReview: (reviewId: string, action: "restore" | "remove") =>
    write<MktReview>((s) => s.apps?.moderateReview?.(reviewId, action), (g) => g.mktAdminReviewModerate?.(reviewId, action), "review"),
  adminFlaggedDevReviews: () => read<{ reviews: MktFlaggedReview[] }>(
    (s) => s.marketplace?.flaggedDeveloperReviews?.()?.then((reviews) => ({ reviews })), (g) => g.mktAdminDevFlagged?.()),
  adminModerateDevReview: (reviewId: string, action: "restore" | "remove") =>
    write<MktReview>((s) => s.marketplace?.moderateDeveloperReview?.(reviewId, action), (g) => g.mktAdminDevModerate?.(reviewId, action), "review"),
  adminSuspend: (slug: string, suspend: boolean, reason?: string) =>
    write<unknown>(
      (s) => (suspend ? s.apps?.suspend?.(slug, reason) : s.apps?.unsuspend?.(slug)),
      (g) => g.mktAdminSuspend?.(slug, suspend, reason),
    ),
  adminAppSearch: (q: string) =>
    read<{ apps: MktAdminApp[] }>((s) => s.apps?.adminSearch?.(q), (g) => g.mktAdminAppSearch?.(q)),
};

// ── Developer program transport (M7) ──────────────────────────────────────

const PROGRAM_OFFLINE = "The developer program hasn't come online in this build yet.";

/** One desktop program envelope: null = surface not in this build (old
 *  preload), throw = real failure the panel must show honestly. */
async function programIpcRead<T>(p: Promise<unknown> | undefined, field: string): Promise<T | null> {
  const r = (await p) as ({ ok?: boolean; error?: string } & Record<string, unknown>) | null | undefined;
  if (!r) return null; // no preload method → the surface predates this build
  if (r.ok !== true) throw new Error(r.error || "Request failed");
  return (r[field] ?? null) as T | null;
}

async function programIpcWrite<T>(p: Promise<unknown> | undefined, field: string): Promise<MktWrite<T | null>> {
  try {
    const r = (await p) as ({ ok?: boolean; error?: string } & Record<string, unknown>) | null | undefined;
    if (!r) return { ok: false, error: PROGRAM_OFFLINE };
    if (r.ok !== true) return { ok: false, error: r.error || "Request failed" };
    return { ok: true, data: (r[field] ?? null) as T | null };
  } catch (err) { return { ok: false, error: errText(err) }; }
}

/** The developer-program surface — HANDLE-scoped, contract shapes verbatim.
 *  Reads resolve null only when the SDK/preload in front of us predates the
 *  surface ("coming online"), and REJECT on real failures. */
export const mktProgram = {
  state: async (handle: string): Promise<MktProgramState | null> => {
    const s = sdk();
    if (s) {
      const p = s.marketplace?.program?.(handle);
      return p ? await p : null;
    }
    return programIpcRead<MktProgramState>(ipc().mktProgramState?.(handle), "state");
  },
  enroll: async (handle: string, agreementVersion: string): Promise<MktWrite<MktProgramState | null>> => {
    const s = sdk();
    if (s) {
      const p = s.marketplace?.enrollProgram?.(handle, agreementVersion);
      if (!p) return { ok: false, error: PROGRAM_OFFLINE };
      try { return { ok: true, data: await p }; }
      catch (err) { return { ok: false, error: errText(err) }; }
    }
    return programIpcWrite<MktProgramState>(ipc().mktProgramEnroll?.(handle, agreementVersion), "state");
  },
  setPayout: async (handle: string, patch: MktPayoutPatch): Promise<MktWrite<MktProgramState | null>> => {
    const s = sdk();
    if (s) {
      const p = s.marketplace?.setPayoutConfig?.(handle, patch);
      if (!p) return { ok: false, error: PROGRAM_OFFLINE };
      try { return { ok: true, data: await p }; }
      catch (err) { return { ok: false, error: errText(err) }; }
    }
    return programIpcWrite<MktProgramState>(ipc().mktPayoutConfigSet?.(handle, patch), "state");
  },
  /** Start (or resume) self-serve Stripe Connect onboarding — resolves the
   *  hosted Account Link URL. Links are SINGLE-USE and short-lived: the server
   *  mints a fresh one on every call, so re-calling recovers a stuck
   *  onboarding. Data is the URL string. */
  startOnboarding: async (handle: string): Promise<MktWrite<string | null>> => {
    const s = sdk();
    if (s) {
      const p = s.marketplace?.startStripeOnboarding?.(handle);
      if (!p) return { ok: false, error: PROGRAM_OFFLINE };
      try { return { ok: true, data: (await p).url }; }
      catch (err) { return { ok: false, error: errText(err) }; }
    }
    return programIpcWrite<string>(ipc().mktStripeOnboarding?.(handle), "url");
  },
  earnings: async (handle: string, q: { limit?: number; offset?: number } = {}): Promise<MktEarningsPage | null> => {
    const s = sdk();
    if (s) {
      const p = s.marketplace?.developerEarnings?.(handle, q);
      return p ? await p : null;
    }
    return programIpcRead<MktEarningsPage>(ipc().mktEarnings?.(handle, q), "earnings");
  },
  payouts: async (handle: string): Promise<MktPayout[] | null> => {
    const s = sdk();
    if (s) {
      const p = s.marketplace?.developerPayouts?.(handle);
      return p ? await p : null;
    }
    return programIpcRead<MktPayout[]>(ipc().mktPayouts?.(handle), "payouts");
  },
};

/** True when a publish/listing refusal reads as the M7 program gate — the cue
 *  to offer "Set up the developer program" beside the server's actual reason. */
export function mktIsProgramRefusal(error: string): boolean {
  return /developer program|enroll|consent|developer agreement/i.test(error);
}

// ── Role gate ─────────────────────────────────────────────────────────────

/** The super_admin gate the admin surfaces share (settings-admin's rule):
 *  unknown role → null (load and let the server's 403 speak). */
export async function mktIsPlatformAdmin(): Promise<boolean | null> {
  try {
    const info = await window.glyphh.getAccountInfo?.();
    if ((info as { isPlatformAdmin?: boolean } | null)?.isPlatformAdmin === true) return true;
    return info?.role ? info.role === "super_admin" : null;
  } catch { return null; }
}

// ── Shared render helpers (also used by the app editor in apps.ts) ────────

export function escMkt(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A caught marketplace error → user-facing text. Transport-level failures
 *  (fetch/socket refusals — the surface simply isn't reachable) get a helpful
 *  line instead of raw stack noise; real server errors keep their text. */
export function mktErrorText(err: unknown): string {
  const raw = ((err instanceof Error ? err.message : String(err ?? "")) || "").trim();
  if (!raw) return "Request failed.";
  if (/fetch failed|failed to fetch|networkerror|load failed|econnrefused|econnreset|enotfound|etimedout|socket hang up|network request failed/i.test(raw)) {
    return "The marketplace service isn't reachable — restart the local server?";
  }
  return raw;
}

/** The marketplace's inline notice banner — icon + message on a quiet surface
 *  (never a raw red text row). `kind` picks the icon color: "error" for
 *  failures, "info" for muted service states. */
export function mktNoticeHtml(message: string, kind: "error" | "info" | "warn" = "error"): string {
  const icon = kind === "error" || kind === "warn"
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
  return `
    <div class="mkt-notice ${kind}" role="${kind === "error" ? "alert" : "status"}">
      <span class="mkt-notice-icon">${icon}</span>
      <span class="mkt-notice-text">${escMkt(message)}</span>
    </div>`;
}

// Canonical domain per connection slug — feeds appIconInner's favicon fallback
// so a real brand icon still shows if the Pipedream catalog icon isn't cached.
const CONN_DOMAIN: Record<string, string> = {
  slack: "slack.com", slack_v2: "slack.com", gmail: "mail.google.com", notion: "notion.so", github: "github.com",
  linear: "linear.app", google_sheets: "sheets.google.com", hubspot: "hubspot.com",
  stripe: "stripe.com", figma: "figma.com", google_calendar: "calendar.google.com",
  snowflake: "snowflake.com", google_drive: "drive.google.com", google_slides: "slides.google.com",
  okta: "okta.com", zendesk: "zendesk.com",
};

/** A single required-connection icon — identical to the Layouts row
 *  (appIconInner, icon only, name on hover), just sized smaller. */
export function mktConnChip(conn: { name: string; slug: string }): string {
  const domain = CONN_DOMAIN[conn.slug];
  const app = { url: domain ? `https://${domain}` : undefined, connection: { accountId: "mkt", pipedreamSlug: conn.slug } };
  return `<span class="mkt-conn" title="${escMkt(conn.name)}">${appIconInner(app, conn.name, "mkt-conn-initial")}</span>`;
}

// Pretty display name for a connector slug ("slack_v2" → "Slack").
const CONN_LABEL: Record<string, string> = {
  slack_v2: "Slack", gmail: "Gmail", google_calendar: "Google Calendar",
  google_sheets: "Google Sheets", google_drive: "Google Drive",
};
export function connLabel(slug: string): string {
  return CONN_LABEL[slug] || slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Pseudo-apps (connection-only) to hand to primeConnectedIcons so it fetches
 *  the Pipedream catalog icon for every required-connection slug on screen. */
export function mktConnIconApps(conns: Array<{ slug: string }>): Array<{ connection: { accountId: string; pipedreamSlug: string } }> {
  const slugs = new Set(conns.map((c) => c.slug));
  return [...slugs].map((slug) => ({ connection: { accountId: "mkt", pipedreamSlug: slug } }));
}

/** A YouTube or Vimeo demo as an embedded iframe. Only these two hosts (the
 *  server restricts the link to them), so the embed URL is derived safely. */
export function mktVideoEmbed(url: string | null | undefined): string {
  if (!url) return "";
  let embed = "";
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") embed = `https://www.youtube.com/embed/${u.pathname.slice(1)}`;
    else if (host.endsWith("youtube.com")) { const v = u.searchParams.get("v"); if (v) embed = `https://www.youtube.com/embed/${v}`; }
    else if (host.endsWith("vimeo.com")) { const id = u.pathname.split("/").filter(Boolean).pop(); if (id) embed = `https://player.vimeo.com/video/${id}`; }
  } catch { /* not a URL — no embed */ }
  if (!embed) return "";
  return `<section class="mkt-dt-section"><h3>Demo</h3>
    <div class="mkt-video"><iframe src="${escMkt(embed)}" allow="fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div></section>`;
}

export const MKT_CATEGORY_LABELS: Record<string, string> = {
  productivity: "Productivity", communication: "Communication", developer: "Developer tools",
  ai: "AI & automation", marketing: "Marketing & sales", finance: "Finance",
  design: "Design", data: "Data & analytics",
};

/** 5-glyph star row for a rating (rounded). */
export function mktStarRow(rating: number): string {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return `<span class="mkt-stars">${"★".repeat(full)}${"☆".repeat(5 - full)}</span>`;
}

/** "12 Aug 2026"-style date for review/release rows. */
export function mktDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Whether the pricing's discount window is OPEN right now. */
export function mktDiscountActive(p: MktPricing): boolean {
  if (!p.discountPercent) return false;
  const now = Date.now();
  if (p.discountStartsAt && Date.parse(p.discountStartsAt) > now) return false;
  if (p.discountEndsAt && Date.parse(p.discountEndsAt) < now) return false;
  return p.effectiveMonthlyCredits < p.monthlyCredits;
}

/** The card/CTA price line: "Free", "50 credits/mo", or the discounted pair. */
export function mktPriceLabel(p: MktPricing): string {
  if (!p || p.monthlyCredits <= 0) return "Free";
  if (mktDiscountActive(p)) {
    return `<s>${p.monthlyCredits}</s> ${p.effectiveMonthlyCredits} credits/mo`;
  }
  return `${p.monthlyCredits} credits/mo`;
}
