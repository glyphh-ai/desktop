/**
 * admin-ipc.ts — the desktop renderer's transport to the SUPER-ADMIN console
 * surfaces (Settings › Platform): the global model catalog, plan pricing +
 * the Stripe price history, platform usage rollups, and the org list with
 * credit grants.
 *
 * Same shape as account-ipc.ts: the renderer has no SDK handle (preload
 * boundary), so these thin IPC methods call the MAIN-process @glyphh/sdk
 * client. The server enforces super_admin on every route — a non-admin's 403
 * surfaces as an error the panel shows honestly.
 *
 * Reads propagate rejections so the renderer can paint an honest error state
 * (never a fake empty). Writes return an `{ ok, error }` envelope.
 */

import { ipcMain } from "electron";
import { getClient } from "./glyphh-client";

// The SDK's index doesn't re-export the admin console input shapes, so they
// are mirrored structurally here (account-ipc.ts's discipline). All rates and
// credit fields keep the WIRE units (micro-credits / USD cents) end to end;
// the renderer owns display conversion.
interface AdminModelPatch {
  display_name?: string;
  alias?: string | null;
  active?: boolean;
  input_credits_per_mtok?: number | null;
  output_credits_per_mtok?: number | null;
  context_window?: number | null;
  max_output_tokens?: number | null;
}
interface AdminPlanPatch {
  display_name?: string;
  monthly_usd_cents?: number;
  included_credits?: number;
  max_seats?: number;
  active?: boolean;
  rate_limit_rpm?: number | null;
}
interface AdminDailyQueryInput {
  from: string;
  to: string;
  tz?: string;
}

/** Shape a write failure the way every settings form renders it. */
function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function registerAdminIpc(): void {
  // ── model catalog ───────────────────────────────────────────────────────
  ipcMain.handle("admin-models", () => getClient().admin.models());
  ipcMain.handle("admin-model-update", async (_e, provider: string, model: string, patch: AdminModelPatch) => {
    try { return { ok: true as const, model: (await getClient().admin.updateModel(String(provider), String(model), patch)).model }; }
    catch (err) { return fail(err); }
  });

  // Releasing NEW catalog entries (the old platform's release flows).
  ipcMain.handle("admin-provider-create", async (_e, input: { slug: string; name: string; kind: "proxied"; alias?: string | null; baseUrl?: string | null }) => {
    try { return { ok: true as const, provider: await getClient().admin.createProvider(input) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("admin-model-create", async (_e, input: { id: string; providerSlug: string; name: string; kind: "proxied"; alias?: string | null; contextWindow?: number | null; maxOutputTokens?: number | null; inputCreditsPerMTok: number; outputCreditsPerMTok: number }) => {
    try { return { ok: true as const, model: await getClient().admin.createModel(input) }; }
    catch (err) { return fail(err); }
  });

  // ── plans + the Stripe price history ────────────────────────────────────
  ipcMain.handle("admin-plans", () => getClient().admin.plans());
  ipcMain.handle("admin-plan-update", async (_e, tier: string, patch: AdminPlanPatch) => {
    try { return { ok: true as const, plan: (await getClient().admin.updatePlan(String(tier), patch)).plan }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("admin-plan-create", async (_e, input: { tier: string; display_name: string; monthly_usd_cents: number; included_credits: number; max_seats: number; rate_limit_rpm?: number | null; active?: boolean }) => {
    try { return { ok: true as const, plan: (await getClient().admin.createPlan(input)).plan }; }
    catch (err) { return fail(err); }
  });

  // ── platform provider keys (encrypted in the DB; rotation via activate) ───
  ipcMain.handle("admin-providers", async () => {
    try { return { ok: true as const, providers: (await getClient().admin.providers()).providers }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("admin-provider-keys", async (_e, slug: string) => {
    try { return { ok: true as const, keys: (await getClient().admin.providerKeys(String(slug))).keys }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("admin-provider-key-add", async (_e, slug: string, key: string, label?: string) => {
    try { return { ok: true as const, key: (await getClient().admin.addProviderKey(String(slug), String(key), label)).key }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("admin-provider-key-active", async (_e, id: string, active: boolean) => {
    try { return { ok: true as const, key: (await getClient().admin.setProviderKeyActive(String(id), !!active)).key }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("admin-provider-key-remove", async (_e, id: string) => {
    try { await getClient().admin.removeProviderKey(String(id)); return { ok: true as const }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("admin-plan-prices", (_e, tier: string) => getClient().admin.planPrices(String(tier)));
  ipcMain.handle("admin-plan-price-add", async (_e, tier: string, stripePriceId: string) => {
    try { return { ok: true as const, price: await getClient().admin.addPlanPrice(String(tier), String(stripePriceId)) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("admin-plan-price-activate", async (_e, id: string) => {
    try { return { ok: true as const, price: await getClient().admin.activatePlanPrice(String(id)) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("admin-plan-price-remove", async (_e, id: string) => {
    try { await getClient().admin.removePlanPrice(String(id)); return { ok: true as const }; }
    catch (err) { return fail(err); }
  });

  // ── platform usage ──────────────────────────────────────────────────────
  ipcMain.handle("admin-usage-by-user", (_e, days: number) =>
    getClient().admin.usageByUser(Math.max(1, Math.min(365, Number(days) || 30))));
  ipcMain.handle("admin-usage-daily", (_e, q: AdminDailyQueryInput) =>
    getClient().admin.usageDaily({ from: String(q?.from || ""), to: String(q?.to || ""), tz: q?.tz }));
  ipcMain.handle("admin-usage-by-runtime", (_e, q: { from: string; to: string }) =>
    getClient().admin.usageByRuntime({ from: String(q?.from || ""), to: String(q?.to || "") }));

  // ── orgs + credit grants ────────────────────────────────────────────────
  ipcMain.handle("admin-orgs", (_e, q: { q?: string; page?: number; limit?: number }) =>
    getClient().admin.orgs({ q: q?.q, page: q?.page, limit: q?.limit }));
  ipcMain.handle("admin-org", (_e, id: string) => getClient().admin.org(String(id)));
  ipcMain.handle("admin-org-update", (_e, id: string, patch: { name?: string; tier?: string; billingStatus?: string }) =>
    getClient().admin.updateOrg(String(id), patch));
  ipcMain.handle("admin-org-grant-credits", async (_e, id: string, credits: number, note?: string) => {
    try { return { ok: true as const, balance: (await getClient().admin.grantCredits(String(id), Number(credits) || 0, note)).balance }; }
    catch (err) { return fail(err); }
  });
}
