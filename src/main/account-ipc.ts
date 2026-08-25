/**
 * account-ipc.ts — the desktop renderer's transport to the ACCOUNT SURFACES:
 * billing (plans, credits, top-ups, invoices, Stripe hand-offs), the org
 * record, the caller's own profile, and the member roster.
 *
 * The renderer has no SDK handle (preload boundary), so these thin IPC methods
 * call the MAIN-process @glyphh/sdk client — the SDK in main IS the desktop's
 * client, per the architecture law. Same shape as threads-ipc.ts.
 *
 * Reads propagate rejections so the renderer can paint an honest error state
 * (never a fake empty). Writes return an `{ ok, error }` envelope instead,
 * because a 403 from a non-admin is an EXPECTED outcome the form must explain,
 * not an exception the caller should have to decode.
 */

import { ipcMain } from "electron";
import type { MemberRole, OrgUpdate, GuardrailsPolicy } from "@glyphh/sdk";
import { getClient } from "./glyphh-client";

// OrgInfraChoice isn't re-exported from the SDK index, so its input is mirrored
// structurally here (threads-ipc.ts's discipline). region + tier ('shared' is
// the free default) — the SAME shape org.chooseInfra accepts.
interface OrgInfraChoiceInput { region: string; tier: string }

// The SDK's index re-exports `OrgUpdate` and `MemberRole` but not the
// auto-top-up / self-profile inputs, nor the member-write shapes, so those are
// mirrored structurally here (threads-ipc.ts's discipline) rather than
// reaching into the package's internal paths.
interface AutotopupInput { enabled: boolean; thresholdCredits: number; topupCredits: number }
interface SelfProfileUpdate { firstName?: string; lastName?: string; timezone?: string; imageUrl?: string | null }
type MemberSystemRole = "org_admin" | "admin" | "user";
interface MemberProfileUpdate { firstName?: string; lastName?: string }

/** Shape a write failure the way every account form renders it. */
function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function registerAccountIpc(): void {
  // ── Billing (reads) ─────────────────────────────────────────────────────
  ipcMain.handle("billing-plans", () => getClient().billing.plans());
  ipcMain.handle("billing-status", () => getClient().billing.status());
  ipcMain.handle("billing-credits", () => getClient().billing.credits());
  ipcMain.handle("billing-invoices", () => getClient().billing.invoices());
  ipcMain.handle("billing-payment-method", () => getClient().billing.paymentMethod());

  // ── voice settings (STT input + TTS output + voice) ───────────────────────
  ipcMain.handle("catalog-models", () => getClient().catalog.models());
  ipcMain.handle("catalog-voices", (_e, provider: string) => getClient().catalog.voices(provider));
  ipcMain.handle("voice-settings-get", () => getClient().profile.voiceSettings());
  ipcMain.handle("voice-settings-set", (_e, patch: unknown) => getClient().profile.setVoiceSettings(patch as never));
  ipcMain.handle("voice-transcribe", (_e, audio: ArrayBuffer, mime: string, model: string, ms: number) =>
    getClient().voice.transcribe(new Uint8Array(audio), model, mime, ms));
  ipcMain.handle("voice-synthesize", (_e, text: string, model: string, voiceId: string | null) =>
    getClient().voice.synthesize(text, model, voiceId).then((buf) => Buffer.from(buf)));
  ipcMain.handle("billing-autotopup-get", () => getClient().billing.autotopup());

  // ── Billing (writes + Stripe hand-offs) ─────────────────────────────────
  // Each returns the hosted URL (or the plan-change effect) inside an ok/error
  // envelope: Stripe is not configured on every deployment, and an org without
  // it must read "billing isn't available", not throw into the void.
  ipcMain.handle("billing-autotopup-set", async (_e, input: AutotopupInput) => {
    try { return { ok: true as const, config: await getClient().billing.setAutotopup(input) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("billing-subscribe", async (_e, tier: string) => {
    try { return { ok: true as const, url: (await getClient().billing.subscribe(String(tier || ""))).url }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("billing-change-plan", async (_e, tier: string) => {
    try { return { ok: true as const, change: await getClient().billing.changePlan(String(tier || "")) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("billing-topup", async (_e, credits: number, embedded?: boolean) => {
    try {
      const out = await getClient().billing.topup({ credits: Number(credits) || 0, ...(embedded ? { embedded: true } : {}) });
      return { ok: true as const, url: out.url, clientSecret: out.clientSecret };
    } catch (err) { return fail(err); }
  });
  ipcMain.handle("billing-config", async () => {
    try { return { ok: true as const, publishableKey: (await getClient().billing.config()).publishableKey }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("billing-portal", async () => {
    try { return { ok: true as const, url: (await getClient().billing.portal()).url }; }
    catch (err) { return fail(err); }
  });

  ipcMain.handle("org-invites-list", () => getClient().members.pendingInvites());
  ipcMain.handle("org-invite-revoke", async (_e, id: string) => {
    try { await getClient().members.revokeInvite(String(id)); return { ok: true as const }; }
    catch (err) { return fail(err); }
  });

  // ── Organization ────────────────────────────────────────────────────────
  ipcMain.handle("account-org-get", () => getClient().org.get());
  ipcMain.handle("org-app-blocks", () => getClient().org.appBlocks());
  ipcMain.handle("org-app-block-set", async (_e, ref: string, blocked: boolean) => {
    try {
      const r = blocked ? await getClient().org.blockApp(String(ref)) : await getClient().org.unblockApp(String(ref));
      return { ok: true as const, blocked: r.blocked, slug: r.slug };
    } catch (err) { return fail(err); }
  });
  ipcMain.handle("account-org-image", async (_e, bytes: ArrayBuffer) => {
    try { return { ok: true as const, media: await getClient().org.uploadImage(new Uint8Array(bytes)) }; }
    catch (err) { return fail(err); }
  });
  // ── App ingest webhooks (the Webhooks settings page) ────────────────────
  ipcMain.handle("apps-ingest-installed", async () => {
    try { return { ok: true as const, apps: await getClient().apps.installed() }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("apps-ingest-list", async (_e, slug: string) => {
    try { return { ok: true as const, ...(await getClient().apps.ingest(String(slug))) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("apps-ingest-token-create", async (_e, slug: string, label: string) => {
    try { return { ok: true as const, ...(await getClient().apps.createIngestToken(String(slug), String(label ?? ""))) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("apps-ingest-token-revoke", async (_e, slug: string, id: string) => {
    try { await getClient().apps.revokeIngestToken(String(slug), String(id)); return { ok: true as const }; }
    catch (err) { return fail(err); }
  });

  ipcMain.handle("account-user-image", async (_e, bytes: ArrayBuffer) => {
    try { return { ok: true as const, media: await getClient().profile.uploadImage(new Uint8Array(bytes)) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("account-org-update", async (_e, patch: OrgUpdate) => {
    try { return { ok: true as const, org: await getClient().org.update(patch) }; }
    catch (err) { return fail(err); }
  });

  // ── Runtime region (org infra) ──────────────────────────────────────────
  // infra() is any-member (reads the current region + choice state); chooseInfra
  // is org_admin — a non-admin's 403 rides the ok/error envelope.
  ipcMain.handle("account-org-infra", () => getClient().org.infra());
  ipcMain.handle("account-org-choose-infra", async (_e, choice: OrgInfraChoiceInput) => {
    try { return { ok: true as const, infra: await getClient().org.chooseInfra(choice) }; }
    catch (err) { return fail(err); }
  });

  // ── Org guardrails (org_admin) ──────────────────────────────────────────
  // guardrails() reads the policy; setGuardrails replaces it wholesale (null
  // clears). The server enforces org_admin on the write.
  ipcMain.handle("account-org-guardrails", () => getClient().org.guardrails());
  ipcMain.handle("account-org-set-guardrails", async (_e, policy: GuardrailsPolicy | null) => {
    try { return { ok: true as const, guardrails: await getClient().org.setGuardrails(policy) }; }
    catch (err) { return fail(err); }
  });

  // ── The caller's own profile ────────────────────────────────────────────
  ipcMain.handle("account-profile-get", () => getClient().profile.get());
  ipcMain.handle("account-profile-update", async (_e, patch: SelfProfileUpdate) => {
    try { return { ok: true as const, profile: await getClient().profile.update(patch) }; }
    catch (err) { return fail(err); }
  });

  // ── Members — the roster plus the org_admin writes behind Settings ›
  // Members. A plain member's 403 on any of these is an expected outcome the
  // panel explains, so the writes use the ok/error envelope like every other
  // account form. ──
  ipcMain.handle("account-members-list", () => getClient().members.list());
  ipcMain.handle("account-members-invite", async (_e, email: string, role: MemberRole) => {
    try { return { ok: true as const, invite: await getClient().members.invite(email, role) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("account-members-remove", async (_e, userId: string) => {
    try { await getClient().members.remove(userId); return { ok: true as const }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("account-members-set-role", async (_e, userId: string, role: MemberSystemRole) => {
    try { return { ok: true as const, member: await getClient().members.setRole(userId, role) }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("account-members-set-status", async (_e, userId: string, disabled: boolean) => {
    try { await getClient().members.setStatus(String(userId), !!disabled); return { ok: true as const }; }
    catch (err) { return fail(err); }
  });
  ipcMain.handle("account-members-update-profile", async (_e, userId: string, patch: MemberProfileUpdate) => {
    try { return { ok: true as const, member: await getClient().members.updateProfile(userId, patch) }; }
    catch (err) { return fail(err); }
  });
}
