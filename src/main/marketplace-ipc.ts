/**
 * marketplace-ipc.ts — the desktop renderer's transport to the MARKETPLACE
 * (left-rail storefront, listing detail, reviews, developer profiles, the
 * developer console, and the platform-admin queues).
 *
 * Same shape as admin-ipc.ts: the renderer has no SDK handle (preload
 * boundary), so these thin IPC methods call the MAIN-process @glyphh/sdk
 * client and return the SDK CONTRACT shapes verbatim — the renderer's
 * marketplace modules read the same shapes on web (window.glyphhSdk) and
 * desktop (these channels). The server enforces auth/roles on every route.
 *
 * Reads propagate rejections so the renderer can paint an honest error state
 * (never a fake empty). Writes return an `{ ok, error }` envelope.
 */

import { ipcMain } from "electron";
import { getClient } from "./glyphh-client";
import { invalidateOrgApps } from "./org-apps";

/** Shape a write failure the way every settings form renders it. */
function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function registerMarketplaceIpc(): void {
  // ── storefront reads ──────────────────────────────────────────────────────
  // Browse + the caller's installs in one round trip — the storefront needs
  // both to mark installed cards, and every surface derives the same view.
  ipcMain.handle("mkt-browse", async () => {
    const client = getClient();
    const [apps, installs] = await Promise.all([
      client.apps.browse(),
      client.apps.installed().catch(() => []),
    ]);
    return { apps, installedSlugs: installs.map((i) => i.slug) };
  });
  ipcMain.handle("mkt-detail", async (_e, slug: string) => {
    const client = getClient();
    const [detail, installs] = await Promise.all([
      client.apps.get(String(slug)),
      client.apps.installed().catch(() => []),
    ]);
    return { detail, installed: installs.some((i) => i.slug === detail.slug) };
  });

  // ── install / uninstall ───────────────────────────────────────────────────
  ipcMain.handle("mkt-install", async (_e, slug: string) => {
    try {
      const app = await getClient().apps.install(String(slug));
      invalidateOrgApps();
      return { ok: true as const, slug: app?.slug };
    } catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-uninstall", async (_e, slug: string) => {
    try {
      await getClient().apps.uninstall(String(slug));
      invalidateOrgApps();
      return { ok: true as const };
    } catch (err) { return fail(err); }
  });

  // ── app reviews ───────────────────────────────────────────────────────────
  ipcMain.handle("mkt-reviews", (_e, slug: string, query: { limit?: number; offset?: number }) =>
    getClient().apps.reviews(String(slug), query || {}));
  ipcMain.handle("mkt-review-put", async (_e, slug: string, input: { stars: number; body?: string }) => {
    try { return { ok: true as const, review: await getClient().apps.review(String(slug), input) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-review-delete", async (_e, slug: string) => {
    try { await getClient().apps.removeReview(String(slug)); return { ok: true as const }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-review-report", async (_e, slug: string, reviewId: string, reason: string) => {
    try { return { ok: true as const, review: await getClient().apps.reportReview(String(slug), String(reviewId), String(reason)) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-review-respond", async (_e, slug: string, reviewId: string, response: string) => {
    try { return { ok: true as const, review: await getClient().apps.respondToReview(String(slug), String(reviewId), String(response)) }; }
    catch (err) { return fail(err); }
  });

  // ── malicious reports ─────────────────────────────────────────────────────
  ipcMain.handle("mkt-report-app", async (_e, slug: string, reason: string, detail?: string) => {
    try { return { ok: true as const, report: await getClient().apps.report(String(slug), String(reason), detail) }; }
    catch (err) { return fail(err); }
  });

  // ── developer console: the org's own listings, pricing, releases ──────────
  ipcMain.handle("mkt-my-apps", async () => ({ apps: await getClient().apps.mine() }));
  ipcMain.handle("mkt-pricing-set", async (_e, slug: string, patch: {
    monthlyCredits?: number; discountPercent?: number | null;
    discountStartsAt?: string | null; discountEndsAt?: string | null;
  }) => {
    try { await getClient().apps.setPricing(String(slug), patch); return { ok: true as const }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-releases", async (_e, slug: string) => ({ releases: await getClient().apps.releases(String(slug)) }));
  ipcMain.handle("mkt-release-submit", async (_e, slug: string, releaseId: string, note?: string) => {
    try { return { ok: true as const, release: await getClient().apps.submitRelease(String(slug), String(releaseId), note) }; }
    catch (err) { return fail(err); }
  });

  // ── developer profiles + their reviews ────────────────────────────────────
  ipcMain.handle("mkt-dev-me", () => getClient().marketplace.myDevelopers());
  ipcMain.handle("mkt-dev-get", (_e, handle: string) => getClient().marketplace.developer(String(handle)));
  ipcMain.handle("mkt-dev-create", async (_e, input: {
    scope: "org" | "personal"; handle: string; displayName: string;
    bio?: string; website?: string; links?: Record<string, string>; supportEmail?: string;
  }) => {
    try { return { ok: true as const, developer: await getClient().marketplace.createDeveloper(input) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-dev-update", async (_e, handle: string, patch: {
    displayName?: string; bio?: string | null; website?: string | null;
    links?: Record<string, string>; supportEmail?: string | null;
  }) => {
    try { return { ok: true as const, developer: await getClient().marketplace.updateDeveloper(String(handle), patch) }; }
    catch (err) { return fail(err); }
  });
  // Avatar bytes cross the boundary as an ArrayBuffer (structured clone).
  ipcMain.handle("mkt-dev-avatar", async (_e, handle: string, bytes: ArrayBuffer) => {
    try { return { ok: true as const, media: await getClient().marketplace.uploadDeveloperAvatar(String(handle), new Uint8Array(bytes)) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-dev-reviews", (_e, handle: string, query: { limit?: number; offset?: number }) =>
    getClient().marketplace.developerReviews(String(handle), query || {}));
  ipcMain.handle("mkt-dev-review-put", async (_e, handle: string, input: { stars: number; body?: string }) => {
    try { return { ok: true as const, review: await getClient().marketplace.reviewDeveloper(String(handle), input) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-dev-review-delete", async (_e, handle: string) => {
    try { await getClient().marketplace.removeDeveloperReview(String(handle)); return { ok: true as const }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-dev-review-respond", async (_e, handle: string, reviewId: string, response: string) => {
    try { return { ok: true as const, review: await getClient().marketplace.respondToDeveloperReview(String(handle), String(reviewId), String(response)) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-dev-review-report", async (_e, handle: string, reviewId: string, reason: string) => {
    try { return { ok: true as const, review: await getClient().marketplace.reportDeveloperReview(String(handle), String(reviewId), String(reason)) }; }
    catch (err) { return fail(err); }
  });

  // ── developer program (M7): consent, enrollment, payout, earnings ─────────
  // client.marketplace's program surface — HANDLE-scoped like the server
  // routes, contract shapes verbatim. Payout config rides INSIDE the
  // DeveloperProgram payload (there is no separate config read).
  ipcMain.handle("mkt-program-state", async (_e, handle: string) => {
    try { return { ok: true as const, state: await getClient().marketplace.program(String(handle)) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-program-enroll", async (_e, handle: string, agreementVersion: string) => {
    try { return { ok: true as const, state: await getClient().marketplace.enrollProgram(String(handle), String(agreementVersion)) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-payout-config-set", async (_e, handle: string, patch: {
    stripeConnectAccountId?: string | null; payoutThresholdCredits?: number;
  }) => {
    try { return { ok: true as const, state: await getClient().marketplace.setPayoutConfig(String(handle), patch || {}) }; }
    catch (err) { return fail(err); }
  });
  // Stripe Connect onboarding — the server mints the Express account ONCE and
  // a FRESH single-use Account Link on every call; only the URL crosses back
  // (the renderer opens it in the app's own browser panel, never externally).
  ipcMain.handle("mkt-stripe-onboarding", async (_e, handle: string) => {
    try { return { ok: true as const, url: (await getClient().marketplace.startStripeOnboarding(String(handle))).url }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-earnings", async (_e, handle: string, query?: { limit?: number; offset?: number }) => {
    try { return { ok: true as const, earnings: await getClient().marketplace.developerEarnings(String(handle), query || {}) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-payouts", async (_e, handle: string) => {
    try { return { ok: true as const, payouts: await getClient().marketplace.developerPayouts(String(handle)) }; }
    catch (err) { return fail(err); }
  });

  // ── platform-admin queues (server enforces the role on every route) ───────
  ipcMain.handle("mkt-admin-queue", async () => ({ releases: await getClient().apps.reviewQueue() }));
  ipcMain.handle("mkt-admin-review", async (_e, releaseId: string, action: "begin" | "approve" | "reject", notes?: string, share?: boolean) => {
    try { return { ok: true as const, release: await getClient().apps.reviewRelease(String(releaseId), action, notes, undefined, share === true) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-admin-source-tree", (_e, releaseId: string) => getClient().apps.releaseSourceTree(String(releaseId)));
  ipcMain.handle("mkt-admin-source-file", (_e, releaseId: string, path: string) => getClient().apps.releaseSourceFile(String(releaseId), String(path)));
  ipcMain.handle("mkt-admin-reports", async (_e, status?: "open" | "reviewing" | "resolved" | "dismissed") =>
    ({ reports: await getClient().apps.reports(status) }));
  ipcMain.handle("mkt-admin-report-resolve", async (_e, reportId: string, status: "reviewing" | "resolved" | "dismissed") => {
    try { return { ok: true as const, report: await getClient().apps.resolveReport(String(reportId), status) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-admin-flagged-reviews", async () => ({ reviews: await getClient().apps.flaggedReviews() }));
  ipcMain.handle("mkt-admin-review-moderate", async (_e, reviewId: string, action: "restore" | "remove") => {
    try { return { ok: true as const, review: await getClient().apps.moderateReview(String(reviewId), action) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-admin-dev-flagged", async () => ({ reviews: await getClient().marketplace.flaggedDeveloperReviews() }));
  ipcMain.handle("mkt-admin-dev-moderate", async (_e, reviewId: string, action: "restore" | "remove") => {
    try { return { ok: true as const, review: await getClient().marketplace.moderateDeveloperReview(String(reviewId), action) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-admin-suspend", async (_e, slug: string, suspend: boolean, reason?: string) => {
    try {
      const r = suspend ? await getClient().apps.suspend(String(slug), reason) : await getClient().apps.unsuspend(String(slug));
      return { ok: true as const, suspended: r.suspended };
    } catch (err) { return fail(err); }
  });
  ipcMain.handle("mkt-admin-app-search", (_e, q: string) => getClient().apps.adminSearch(String(q || "")));
}
