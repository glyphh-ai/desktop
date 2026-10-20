/**
 * resources/marketplace.ts — marketplace DEVELOPER PROFILES + their reviews.
 * One profile per org OR per user; developers carry stars exactly like apps
 * (install-gated, one review per person, respond/report/moderate). App-side
 * marketplace listings themselves are the hub's (`client.libraryMarket`).
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type {
  MarketplaceDeveloper, CreateDeveloperInput, UpdateDeveloperInput,
  DeveloperReview, FlaggedDeveloperReview,
  DeveloperProgram, PayoutConfigInput, DeveloperEarning, DeveloperEarningsTotals,
  DeveloperPayout, AdminDeveloperEarningsSummary,
  LibraryListing, LibraryShareRequest,
} from "../contract/marketplace.js";

export class MarketplaceClient {
  constructor(private readonly http: AuthedHttp) {}

  // ── developer profiles ─────────────────────────────────────────────────────

  /** Create YOUR developer profile — your personal one, or your org's. One each. */
  createDeveloper(input: CreateDeveloperInput): Promise<MarketplaceDeveloper> {
    return this.http.post<MarketplaceDeveloper>("/api/marketplace/developers", input);
  }

  /** The caller's own profiles (personal + org), either nullable. */
  myDevelopers(): Promise<{ personal: MarketplaceDeveloper | null; org: MarketplaceDeveloper | null }> {
    return this.http.get<{ personal: MarketplaceDeveloper | null; org: MarketplaceDeveloper | null }>(
      "/api/marketplace/developers/me",
    );
  }

  /** One profile by handle — the public read. */
  developer(handle: string): Promise<MarketplaceDeveloper> {
    return this.http.get<MarketplaceDeveloper>(`/api/marketplace/developers/${encodeURIComponent(handle)}`);
  }

  /** Edit an owned profile. The handle itself is immutable. */
  updateDeveloper(handle: string, patch: UpdateDeveloperInput): Promise<MarketplaceDeveloper> {
    return this.http.patch<MarketplaceDeveloper>(`/api/marketplace/developers/${encodeURIComponent(handle)}`, patch);
  }

  /** Upload the profile's avatar (PNG/JPEG/GIF/WebP, ≤0.5MB; sniffed server-side). */
  uploadDeveloperAvatar(handle: string, bytes: Uint8Array): Promise<{ key: string; contentType: string; bytes: number }> {
    return this.http.post<{ key: string; contentType: string; bytes: number }>(
      `/api/marketplace/developers/${encodeURIComponent(handle)}/avatar`, bytes,
    );
  }

  // ── developer reviews (mirroring app reviews) ──────────────────────────────

  /** A developer's reviews, newest first. */
  developerReviews(handle: string, query: { limit?: number; offset?: number } = {}): Promise<{ reviews: DeveloperReview[]; total: number }> {
    const qs = new URLSearchParams();
    if (query.limit) qs.set("limit", String(query.limit));
    if (query.offset) qs.set("offset", String(query.offset));
    const q = qs.toString();
    return this.http.get<{ reviews: DeveloperReview[]; total: number }>(
      `/api/marketplace/developers/${encodeURIComponent(handle)}/reviews${q ? `?${q}` : ""}`,
    );
  }

  /** Create or edit YOUR review of a developer. One per person; requires your org
   *  to run at least one of their apps. */
  reviewDeveloper(handle: string, input: { stars: number; body?: string }): Promise<DeveloperReview> {
    return this.http.put<DeveloperReview>(`/api/marketplace/developers/${encodeURIComponent(handle)}/reviews`, input);
  }

  /** Delete your own review of a developer. */
  removeDeveloperReview(handle: string): Promise<void> {
    return this.http.del<void>(`/api/marketplace/developers/${encodeURIComponent(handle)}/reviews`);
  }

  /** Reply publicly to a review of YOUR profile — the refutation path. */
  respondToDeveloperReview(handle: string, reviewId: string, response: string): Promise<DeveloperReview> {
    return this.http.post<DeveloperReview>(
      `/api/marketplace/developers/${encodeURIComponent(handle)}/reviews/${encodeURIComponent(reviewId)}/response`,
      { response },
    );
  }

  /** Flag a review of YOUR profile for platform moderation. It stays visible
   *  until a ruling. */
  reportDeveloperReview(handle: string, reviewId: string, reason: string): Promise<DeveloperReview> {
    return this.http.post<DeveloperReview>(
      `/api/marketplace/developers/${encodeURIComponent(handle)}/reviews/${encodeURIComponent(reviewId)}/report`,
      { reason },
    );
  }

  // ── the developer program (M7): consent, enrollment, payout config ─────────

  /** Enroll a profile you own in the developer program by ACCEPTING the current
   *  developer agreement (its version, from `program(...).agreement.currentVersion`).
   *  Re-running after a version bump is the re-consent path. */
  enrollProgram(handle: string, agreementVersion: string): Promise<DeveloperProgram> {
    return this.http.post<DeveloperProgram>(
      `/api/marketplace/developers/${encodeURIComponent(handle)}/program/enroll`, { agreementVersion },
    );
  }

  /** Your profile's program state (owner-only): enrollment, consent, payout config. */
  program(handle: string): Promise<DeveloperProgram> {
    return this.http.get<DeveloperProgram>(`/api/marketplace/developers/${encodeURIComponent(handle)}/program`);
  }

  /** Update your payout config: Stripe Connect account (acct_…, null disconnects)
   *  and/or the payout threshold in whole credits. Setting a manual id parks
   *  payout status at 'pending' until the webhook confirms readiness. */
  setPayoutConfig(handle: string, patch: PayoutConfigInput): Promise<DeveloperProgram> {
    return this.http.patch<DeveloperProgram>(
      `/api/marketplace/developers/${encodeURIComponent(handle)}/program/payout`, patch,
    );
  }

  /** Start (or resume) self-serve Stripe Connect onboarding for a profile you
   *  own. The server mints the Express account ONCE and a FRESH Account Link on
   *  every call (links are single-use — re-calling recovers a stuck
   *  onboarding). Open the returned url in the in-app browser panel; payout
   *  status flips to 'ready' via webhook once Stripe confirms the account. */
  startStripeOnboarding(handle: string, input: { country?: string } = {}): Promise<{ url: string }> {
    return this.http.post<{ url: string }>(
      `/api/marketplace/developers/${encodeURIComponent(handle)}/stripe/onboard`, input,
    );
  }

  // ── earnings + payouts (own) ───────────────────────────────────────────────

  /** Your revenue-share ledger (newest first) + lifetime totals. */
  developerEarnings(
    handle: string,
    query: { limit?: number; offset?: number } = {},
  ): Promise<{ earnings: DeveloperEarning[]; total: number; totals: DeveloperEarningsTotals }> {
    const qs = new URLSearchParams();
    if (query.limit) qs.set("limit", String(query.limit));
    if (query.offset) qs.set("offset", String(query.offset));
    const q = qs.toString();
    return this.http.get<{ earnings: DeveloperEarning[]; total: number; totals: DeveloperEarningsTotals }>(
      `/api/marketplace/developers/${encodeURIComponent(handle)}/earnings${q ? `?${q}` : ""}`,
    );
  }

  /** Your payouts, newest first. */
  async developerPayouts(handle: string): Promise<DeveloperPayout[]> {
    const { payouts } = await this.http.get<{ payouts: DeveloperPayout[] }>(
      `/api/marketplace/developers/${encodeURIComponent(handle)}/payouts`,
    );
    return payouts;
  }

  // ── the developer program + payout queue (platform admin) ──────────────────

  /** Suspend a developer's program participation (blocks listing + payouts). */
  suspendDeveloperProgram(handle: string): Promise<DeveloperProgram> {
    return this.http.post<DeveloperProgram>(
      `/api/admin/marketplace/program/${encodeURIComponent(handle)}/suspend`, {},
    );
  }

  /** Reinstate a suspended developer (back to enrolled if they had consented). */
  reinstateDeveloperProgram(handle: string): Promise<DeveloperProgram> {
    return this.http.post<DeveloperProgram>(
      `/api/admin/marketplace/program/${encodeURIComponent(handle)}/reinstate`, {},
    );
  }

  /** The payout queue across every developer, optionally one status. */
  async adminPayouts(status?: "pending" | "paid" | "failed"): Promise<DeveloperPayout[]> {
    const { payouts } = await this.http.get<{ payouts: DeveloperPayout[] }>(
      `/api/admin/marketplace/payouts${status ? `?status=${status}` : ""}`,
    );
    return payouts;
  }

  /** Earnings per developer — the platform-admin roll, biggest unpaid first. */
  async adminDeveloperEarnings(): Promise<AdminDeveloperEarningsSummary[]> {
    const { developers } = await this.http.get<{ developers: AdminDeveloperEarningsSummary[] }>(
      "/api/admin/marketplace/earnings",
    );
    return developers;
  }

  // ── moderation (platform admin) ────────────────────────────────────────────

  /** The flagged developer-review queue, newest report first. */
  async flaggedDeveloperReviews(): Promise<FlaggedDeveloperReview[]> {
    const { reviews } = await this.http.get<{ reviews: FlaggedDeveloperReview[] }>(
      "/api/admin/developer-reviews/flagged",
    );
    return reviews;
  }

  /** Settle a flagged developer review: restore it, or remove it from readers. */
  moderateDeveloperReview(reviewId: string, action: "restore" | "remove"): Promise<DeveloperReview> {
    return this.http.post<DeveloperReview>(
      `/api/admin/developer-reviews/${encodeURIComponent(reviewId)}/moderate`, { action },
    );
  }
}

/**
 * The LIBRARY marketplace (skills + loops, his order 2026-09-02): browse,
 * free install (copies the snapshot into your library), the org admin's
 * share-approval queue, and the platform review desk.
 */
export class LibraryMarketClient {
  constructor(private readonly http: AuthedHttp) {}

  /** Approved public listings (+ your org's shared items under `org`). */
  browse(kind?: "skill" | "loop"): Promise<{
    listings: LibraryListing[];
    org: Array<{ kind: "skill" | "loop"; slug: string; name: string; description: string }>;
  }> {
    return this.http.get(`/api/marketplace/library${kind ? `?kind=${kind}` : ""}`) as Promise<{
      listings: LibraryListing[];
      org: Array<{ kind: "skill" | "loop"; slug: string; name: string; description: string }>;
    }>;
  }

  /** Install FREE: copies the listing into your library as a personal item. */
  install(listingId: string): Promise<{ ok: boolean; kind: string; slug: string }> {
    return this.http.post<{ ok: boolean; kind: string; slug: string }>(
      `/api/marketplace/library/${encodeURIComponent(listingId)}/install`, {},
    );
  }

  /** Drop the seat — the copied item stays yours to keep or delete. */
  uninstall(listingId: string): Promise<void> {
    return this.http.del<void>(`/api/marketplace/library/${encodeURIComponent(listingId)}/install`);
  }

  /** ORG ADMIN: open share submissions awaiting a ruling. */
  pendingShares(): Promise<{ pending: LibraryShareRequest[] }> {
    return this.http.get<{ pending: LibraryShareRequest[] }>("/api/org/library/pending");
  }

  /** ORG ADMIN: rule on a share (approval flips the item org-wide). Self-review is refused. */
  reviewShare(id: string, action: "approve" | "reject"): Promise<void> {
    return this.http.post<void>(`/api/org/library/shares/${encodeURIComponent(id)}/review`, { action });
  }

  /** PLATFORM ADMIN: the review desk's queue, full content, oldest first. */
  reviewQueue(): Promise<{ queue: Array<LibraryListing & { prompt: string; code: string; submittedBy: string | null }> }> {
    return this.http.get("/api/admin/library/queue") as Promise<{ queue: Array<LibraryListing & { prompt: string; code: string; submittedBy: string | null }> }>;
  }

  /** PLATFORM ADMIN: rule on a listing. Approval lists it, free forever. */
  reviewListing(id: string, action: "begin" | "approve" | "reject", notes?: string): Promise<void> {
    return this.http.post<void>(`/api/admin/library/${encodeURIComponent(id)}/review`, { action, ...(notes ? { notes } : {}) });
  }
}
