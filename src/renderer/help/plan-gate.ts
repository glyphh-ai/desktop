/**
 * plan-gate.ts — the renderer's ONE licensing read.
 *
 * His rule, 2026-09-11: "There should be one place all licensing is gated by
 * in the SDK. One place!! Everything checks the same place!!" — this is that
 * place's client end. It reads `client.plans.gates()` (the SDK's single
 * licensing surface, which mirrors the server's `getPlanGates`) through one
 * IPC channel and hands every surface the same answer.
 *
 * No surface may read entitlements any other way, and there are no feature
 * flags: the plan matrix is two plan columns plus sso/rpm, read through here.
 *
 * WHAT A GATE DOES: it draws a surface as LOCKED — visible, inert, with a
 * line saying which plan carries it (his call: visible + disabled + upsell,
 * never hidden, so an admin can see what they'd get). It is NOT enforcement;
 * the server's write seams answer E_ENTITLEMENT regardless. A client that
 * got this wrong could only mis-draw a control, never grant reach.
 */

export interface PlanGates {
  gatewayAllowed: boolean;
  trialEndsAt: string | null;
  governance: boolean;
  sso: boolean;
  rpm: number;
}

/** Locked-down defaults: what a failed read answers, so an offline client
 *  shows paid surfaces as locked rather than as usable. */
const CLOSED: PlanGates = {
  gatewayAllowed: false, trialEndsAt: null, governance: false, sso: false, rpm: 0,
};

/** Which plan carries each capability — the upsell line's copy. */
const CARRIED_BY: Record<string, string> = {
  governance: "Pro",
  sso: "Enterprise",
};

let cached: Promise<PlanGates> | null = null;

/** The org's gates. The SDK caches with a TTL; this de-duplicates within a
 *  paint so twenty gated controls cost one IPC round-trip. */
export function planGates(): Promise<PlanGates> {
  cached ??= (window.glyphh as unknown as { planGates?: () => Promise<PlanGates> })
    .planGates?.().catch(() => CLOSED) ?? Promise.resolve(CLOSED);
  return cached;
}

/** Drop the memo — after a plan change, so the UI re-gates immediately. */
export function invalidatePlanGates(): void {
  cached = null;
}

/**
 * Gate a surface on a capability.
 *
 * Locked: every control inside `host` goes inert (disabled + not focusable)
 * and a single upsell line is placed at the top. Unlocked: any previous lock
 * is lifted, so re-gating after an upgrade needs no reload.
 *
 * `host` stays VISIBLE either way — hiding it would leave no way to discover
 * the feature exists.
 */
export async function gateSurface(
  host: HTMLElement | null,
  capability: "governance" | "sso" | "gateway",
  what: string,
): Promise<boolean> {
  if (!host) return false;
  const gates = await planGates();
  const allowed = capability === "governance" ? gates.governance
    : capability === "sso" ? gates.sso
    : gates.gatewayAllowed;

  host.querySelector(":scope > .plan-locked-note")?.remove();
  host.classList.toggle("plan-locked", !allowed);
  host.querySelectorAll<HTMLElement>("input, select, textarea, button").forEach((c) => {
    // Only ever UNSET what this gate set — a control disabled for its own
    // reasons (an empty form, a pending save) must stay disabled.
    if (!allowed) { (c as HTMLInputElement).disabled = true; c.dataset.planLocked = "1"; }
    else if (c.dataset.planLocked) { (c as HTMLInputElement).disabled = false; delete c.dataset.planLocked; }
  });
  if (!allowed) {
    const note = document.createElement("div");
    note.className = "plan-locked-note";
    const plan = CARRIED_BY[capability] ?? "a paid plan";
    note.textContent = `${what} is on ${plan}. You can see how it works here — upgrade to use it.`;
    host.prepend(note);
  }
  return allowed;
}
