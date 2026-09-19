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
  /** The org lets members drop into the loop's own CLI. Off = the terminal
   *  door is closed, so restricted loops and models cannot be walked around
   *  (his order, 2026-09-18). */
  cliAllowed: boolean;
  /** The org picks nothing: every turn goes to its auto-router. */
  autoOnly: boolean;
  /** Memory overrides (his order, 2026-09-19): member = the user's choice, on / off = forced. */
  memoryPolicy?: { inject?: "member" | "on" | "off"; capture?: "member" | "on" | "off"; sensitive?: "member" | "on" | "off" };
}

/** Locked-down defaults: what a failed read answers, so an offline client
 *  shows paid surfaces as locked rather than as usable. */
const CLOSED: PlanGates = {
  // cliAllowed defaults OPEN: a failed read must not lock a member out of a
  // door their org never closed, and the server is the enforcement anyway.
  gatewayAllowed: false, trialEndsAt: null, governance: false, sso: false, rpm: 0, cliAllowed: true, autoOnly: false,
};

let cached: Promise<PlanGates> | null = null;
let carrierCache: Promise<Record<string, string>> | null = null;

/** Which plan carries each capability, READ FROM THE CATALOG — the cheapest
 *  active tier whose column is true. Hardcoding "Pro" here would be correct
 *  today and a lie the day the matrix moves; the whole point of two plan
 *  columns is that the tiers are data. */
function carriers(): Promise<Record<string, string>> {
  carrierCache ??= (window.glyphh as unknown as {
    billingPlans?: () => Promise<Array<{ tier: string; displayName?: string; monthlyUsdCents?: number; sso?: boolean; governance?: boolean }>>;
  }).billingPlans?.()
    .then((plans) => {
      const byPrice = [...(plans ?? [])].sort((a, b) => (a.monthlyUsdCents ?? 0) - (b.monthlyUsdCents ?? 0));
      const name = (has: (p: typeof byPrice[number]) => boolean): string => {
        const hit = byPrice.find(has);
        return hit ? (hit.displayName || hit.tier) : "a paid plan";
      };
      return { governance: name((p) => !!p.governance), sso: name((p) => !!p.sso) };
    })
    .catch(() => ({})) ?? Promise.resolve({});
  return carrierCache;
}

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
  carrierCache = null;
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
    const msg = document.createElement("span");
    msg.textContent = `${what} is on a paid plan. You can see how it works here — upgrade to use it. `;
    // The SAME door on every gated page (his order, 2026-09-12): a link to
    // Billing right in the banner. Navigating = clicking the Billing nav item,
    // the user's own path — importing navigation.ts here would cycle through
    // the very pages that import this gate.
    const link = document.createElement("a");
    link.href = "#";
    link.className = "plan-locked-link";
    link.textContent = "Upgrade plan →";
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      document.querySelector<HTMLButtonElement>('.settings-nav-item[data-sub="billing"]')?.click();
    });
    note.append(msg, link);
    host.prepend(note);
    // Name the REAL tier once the catalog answers; the note reads correctly
    // either way, so a slow or failed lookup never blocks the paint.
    void carriers().then((by) => {
      const plan = by[capability];
      if (plan && note.isConnected) {
        msg.textContent = `${what} is on ${plan}. You can see how it works here — upgrade to use it. `;
      }
    });
  }
  return allowed;
}
