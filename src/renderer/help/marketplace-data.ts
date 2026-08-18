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
  updatedAt: string;
}

export interface MktQueueRelease extends MktRelease {
  appSlug: string;
  appName: string;
  publisherOrgId: string;
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
// The program/payout surface SHIPS SEPARATELY on the SDK's marketplace branch
// (client.marketplace: program state/enroll, payout config, earnings). Until
// it lands, every read below resolves null — Settings → Developer renders its
// "coming online" state — and writes answer an honest offline error. Field
// names are normalized through 2–3 plausible spellings at the seam; tighten
// to a plain contract mirror once the SDK contract is in node_modules.

export type MktProgramStatus = "none" | "enrolled" | "suspended";

/** The org's developer-program standing + agreement-consent record. */
export interface MktProgramState {
  status: MktProgramStatus;
  /** Agreement version this org accepted (null before enrollment). */
  acceptedVersion: string | null;
  acceptedAt: string | null;
  /** The agreement version the server currently requires. */
  currentVersion: string | null;
  suspendedReason: string | null;
}

/** Stripe Connect payout configuration (M7: earned credits pay out monthly). */
export interface MktPayoutConfig {
  stripeAccountId: string | null;
  thresholdCredits: number | null;
  /** A server-minted Stripe Connect onboarding link, when the SDK exposes one. */
  connectUrl: string | null;
}

/** Earned-credit ledger rollup. */
export interface MktEarnings {
  accruedCredits: number;
  netCredits: number;
  paidCredits: number;
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
  submitRelease?: (slug: string, releaseId: string) => Promise<MktRelease>;
  reviewQueue?: () => Promise<MktQueueRelease[]>;
  reviewRelease?: (releaseId: string, action: "begin" | "approve" | "reject", notes?: string) => Promise<MktRelease>;
  reports?: (status?: string) => Promise<MktReport[]>;
  resolveReport?: (reportId: string, status: "reviewing" | "resolved" | "dismissed") => Promise<MktReport>;
  flaggedReviews?: () => Promise<MktFlaggedReview[]>;
  moderateReview?: (reviewId: string, action: "restore" | "remove") => Promise<MktReview>;
  suspend?: (slug: string) => Promise<{ ok: boolean; suspended: boolean }>;
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
}
// The M7 program surface (programState/enrollProgram/payoutConfig/
// setPayoutConfig/earnings) is deliberately NOT declared on SdkMarketplace —
// its exact spellings are unconfirmed until the SDK branch lands, so mktProgram
// feature-detects them by name at the seam (pickFn below).
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
  mktReleaseSubmit?: (slug: string, releaseId: string) => Promise<unknown>;
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
  mktAdminReview?: (releaseId: string, action: "begin" | "approve" | "reject", notes?: string) => Promise<unknown>;
  mktAdminReports?: (status?: string) => Promise<unknown>;
  mktAdminReportResolve?: (reportId: string, status: string) => Promise<unknown>;
  mktAdminFlaggedReviews?: () => Promise<unknown>;
  mktAdminReviewModerate?: (reviewId: string, action: "restore" | "remove") => Promise<unknown>;
  mktAdminDevFlagged?: () => Promise<unknown>;
  mktAdminDevModerate?: (reviewId: string, action: "restore" | "remove") => Promise<unknown>;
  mktAdminSuspend?: (slug: string, suspend: boolean) => Promise<unknown>;
  // Developer program (M7) — envelopes carry `unavailable: true` while the
  // SDK's program surface hasn't shipped, so reads can answer null honestly.
  mktProgramState?: () => Promise<unknown>;
  mktProgramEnroll?: (input: { agreementVersion?: string }) => Promise<unknown>;
  mktPayoutConfig?: () => Promise<unknown>;
  mktPayoutConfigSet?: (patch: { stripeAccountId?: string | null; thresholdCredits?: number | null }) => Promise<unknown>;
  mktEarnings?: () => Promise<unknown>;
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
  submitRelease: (slug: string, releaseId: string) =>
    write<MktRelease>((s) => s.apps?.submitRelease?.(slug, releaseId), (g) => g.mktReleaseSubmit?.(slug, releaseId), "release"),

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
  adminReview: (releaseId: string, action: "begin" | "approve" | "reject", notes?: string) =>
    write<MktRelease>((s) => s.apps?.reviewRelease?.(releaseId, action, notes), (g) => g.mktAdminReview?.(releaseId, action, notes), "release"),
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
  adminSuspend: (slug: string, suspend: boolean) =>
    write<unknown>(
      (s) => (suspend ? s.apps?.suspend?.(slug) : s.apps?.unsuspend?.(slug)),
      (g) => g.mktAdminSuspend?.(slug, suspend),
    ),
};

// ── Developer program transport (M7) ──────────────────────────────────────

type MktAnyFn = (...args: unknown[]) => Promise<unknown>;

/** First present function among candidate spellings — the program surface
 *  ships separately in the SDK, so `typeof fn === "function"` is the gate. */
function pickFn(obj: unknown, names: string[]): MktAnyFn | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  for (const n of names) {
    if (typeof rec[n] === "function") return (rec[n] as MktAnyFn).bind(obj);
  }
  return null;
}

const PROGRAM_OFFLINE = "The developer program hasn't come online in this build yet.";

const asStr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const unwrap = (r: unknown, keys: string[]): Record<string, unknown> | null => {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  for (const k of keys) {
    const inner = o[k];
    if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  }
  return o;
};

function normProgram(r: unknown): MktProgramState | null {
  const o = unwrap(r, ["state", "program"]);
  if (!o) return null;
  const raw = String(o.status ?? o.programStatus ?? "none");
  return {
    status: raw === "enrolled" || raw === "suspended" ? raw : "none",
    acceptedVersion: asStr(o.acceptedVersion ?? o.agreementVersion),
    acceptedAt: asStr(o.acceptedAt ?? o.consentedAt ?? o.enrolledAt),
    currentVersion: asStr(o.currentVersion ?? o.currentAgreementVersion ?? o.latestAgreementVersion),
    suspendedReason: asStr(o.suspendedReason ?? o.suspensionReason),
  };
}

function normPayout(r: unknown): MktPayoutConfig | null {
  const o = unwrap(r, ["config", "payout"]);
  if (!o) return null;
  return {
    stripeAccountId: asStr(o.stripeAccountId ?? o.accountId ?? o.stripeAccount),
    thresholdCredits: asNum(o.thresholdCredits ?? o.payoutThresholdCredits ?? o.threshold),
    connectUrl: asStr(o.connectUrl ?? o.onboardingUrl ?? o.stripeConnectUrl),
  };
}

function normEarnings(r: unknown): MktEarnings | null {
  const o = unwrap(r, ["earnings"]);
  if (!o) return null;
  return {
    accruedCredits: asNum(o.accruedCredits ?? o.accrued) ?? 0,
    netCredits: asNum(o.netCredits ?? o.net) ?? 0,
    paidCredits: asNum(o.paidCredits ?? o.paid) ?? 0,
  };
}

/** One desktop program envelope: null = surface not shipped, throw = real
 *  failure the panel must show honestly, value = normalized payload. */
async function programIpcRead<T>(
  p: Promise<unknown> | undefined,
  field: string,
  norm: (r: unknown) => T | null,
): Promise<T | null> {
  const r = (await p) as ({ ok?: boolean; unavailable?: boolean; error?: string } & Record<string, unknown>) | null | undefined;
  if (!r || r.unavailable) return null; // no preload / SDK method → not shipped yet
  if (r.ok !== true) throw new Error(r.error || "Request failed");
  return norm(r[field]);
}

async function programIpcWrite<T>(
  p: Promise<unknown> | undefined,
  field: string,
  norm: (r: unknown) => T | null,
): Promise<MktWrite<T | null>> {
  try {
    const r = (await p) as ({ ok?: boolean; unavailable?: boolean; error?: string } & Record<string, unknown>) | null | undefined;
    if (!r) return { ok: false, error: NO_TRANSPORT };
    if (r.unavailable) return { ok: false, error: PROGRAM_OFFLINE };
    if (r.ok !== true) return { ok: false, error: r.error || "Request failed" };
    return { ok: true, data: norm(r[field]) };
  } catch (err) { return { ok: false, error: errText(err) }; }
}

/** The developer-program surface. Reads resolve null while the SDK/program
 *  surface hasn't shipped ("coming online"), and REJECT on real failures. */
export const mktProgram = {
  state: async (): Promise<MktProgramState | null> => {
    const s = sdk();
    if (s) {
      const fn = pickFn(s.marketplace, ["programState", "program"]);
      return fn ? normProgram(await fn()) : null;
    }
    return programIpcRead(ipc().mktProgramState?.(), "state", normProgram);
  },
  enroll: async (agreementVersion: string | null): Promise<MktWrite<MktProgramState | null>> => {
    const input = agreementVersion ? { agreementVersion } : {};
    const s = sdk();
    if (s) {
      const fn = pickFn(s.marketplace, ["enrollProgram", "programEnroll"]);
      if (!fn) return { ok: false, error: PROGRAM_OFFLINE };
      try { return { ok: true, data: normProgram(await fn(input)) }; }
      catch (err) { return { ok: false, error: errText(err) }; }
    }
    return programIpcWrite(ipc().mktProgramEnroll?.(input), "state", normProgram);
  },
  payout: async (): Promise<MktPayoutConfig | null> => {
    const s = sdk();
    if (s) {
      const fn = pickFn(s.marketplace, ["payoutConfig", "getPayoutConfig"]);
      return fn ? normPayout(await fn()) : null;
    }
    return programIpcRead(ipc().mktPayoutConfig?.(), "config", normPayout);
  },
  setPayout: async (patch: { stripeAccountId?: string | null; thresholdCredits?: number | null }): Promise<MktWrite<MktPayoutConfig | null>> => {
    const s = sdk();
    if (s) {
      const fn = pickFn(s.marketplace, ["setPayoutConfig", "updatePayoutConfig"]);
      if (!fn) return { ok: false, error: PROGRAM_OFFLINE };
      try { return { ok: true, data: normPayout(await fn(patch)) }; }
      catch (err) { return { ok: false, error: errText(err) }; }
    }
    return programIpcWrite(ipc().mktPayoutConfigSet?.(patch), "config", normPayout);
  },
  earnings: async (): Promise<MktEarnings | null> => {
    const s = sdk();
    if (s) {
      const fn = pickFn(s.marketplace, ["earnings", "programEarnings"]);
      return fn ? normEarnings(await fn()) : null;
    }
    return programIpcRead(ipc().mktEarnings?.(), "earnings", normEarnings);
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
