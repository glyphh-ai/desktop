/**
 * resources/plans.ts — THE ONE PLACE LICENSING IS READ.
 *
 * His rule, 2026-09-11: "There should be one place all licensing is gated by
 * in the SDK. One place!! Everything checks the same place!!" — so every
 * surface (desktop, the platform at /platform, mobile, the CLI) answers
 * "may we?" here, and nowhere else. There is no second gate to drift, and no
 * feature flags: the plan matrix is TWO plan columns plus sso/rpm, read
 * through this.
 *
 * It mirrors the server's single read, `getPlanGates(db, orgId)` in
 * billing/plans.ts. Those two are the whole licensing surface.
 *
 * READS NEVER REFUSE. These gates decide what a surface SHOWS (disabled with
 * an upsell, never hidden); the server's write seams are what actually
 * enforce, answering E_ENTITLEMENT. A client that lies to itself here can
 * only mis-draw a button, never grant reach.
 *
 * Distinct from its neighbours on purpose:
 *   billing.plans()  — the catalog you can BUY
 *   admin.plans()    — super-admin CRUD over every plan
 *   plans.gates()    — what THIS org's plan allows, right now
 */

import type { AuthedHttp } from "../core/authed-http.js";

/** What a plan carries. One shape, shared by the server and every client. */
export interface PlanGates {
  /** The gateway is usable (false once a trial window has closed). */
  gatewayAllowed: boolean;
  /** Every turn MUST ride the gateway (the org's Require Gateway switch, or the
   *  server forcing it). With the gateway allowed but not required a member
   *  picks each turn's lane — gateway or the CLI's own login — in the model picker. */
  gatewayRequired?: boolean;
  /** When the gateway trial ends, ISO — null when the plan has no trial. */
  trialEndsAt: string | null;
  /** ROLE governance: may this org differentiate BETWEEN members — role
   *  model/provider grants, workspace assignment, forced routing. The org's
   *  own provider + model configuration is NOT this; that binds every plan. */
  governance: boolean;
  /** SSO (WorkOS) is available — one IdP connection per org. */
  sso: boolean;
  /** The plan's requests-per-minute CEILING; a role narrows under it. 0 = unset. */
  rpm: number;
  /** Dollars left in the org's budget this period (plan pool +
   *  funds − spent). The only thing Glyphh funds; LLM calls never touch it. */
  poolRemainingUsd: number;
  /** Bridge Mode for Claude Desktop is on this plan (Pro and above). */
  bridgeAllowed?: boolean;
  /** The org requires Bridge Mode: the desktop is the bridge TUI and nothing else. */
  forceBridge?: boolean;
  /** The model a new session opens on when the member has picked none (the
   *  team's flag, else the org's default, else the team's router or first chat model). */
  defaultModel?: string;
  /** The model the platform runs its side tasks on (session titles): the row
   *  flagged "Utility" on the console, else the cheapest shared chat model. "" when
   *  the catalog has no chat model. */
  utilityModel?: string;
}

/** Every capability name a caller may ask about — a closed set, so a typo is
 *  a compile error rather than a silently-false gate. */
export type PlanCapability = "governance" | "sso" | "gateway" | "bridge";

/** The gates of an org with no plan at all: nothing but the floor. Used when
 *  the read fails, so an offline or erroring client degrades to LOCKED
 *  rather than accidentally showing paid surfaces as usable. */
const CLOSED: PlanGates = {
  gatewayAllowed: false, trialEndsAt: null, governance: false, sso: false, rpm: 0, poolRemainingUsd: 0,
};

/** How long a gates read stays fresh. Short on purpose: a plan change must
 *  land in the UI within a minute, and a never-expiring cache is exactly how
 *  a stale entitlement once served a plan-gated model (2026-09-04). */
const TTL_MS = 60_000;

export class PlansClient {
  private cached: { at: number; gates: PlanGates } | null = null;
  private inflight: Promise<PlanGates> | null = null;

  constructor(private readonly http: AuthedHttp) {}

  /**
   * The org's gates. Cached briefly and de-duplicated, so a page painting
   * twenty gated controls costs one request, not twenty.
   *
   * Never throws: a failed read answers {@link CLOSED}, which draws paid
   * surfaces as locked. The server still decides on write.
   */
  async gates(): Promise<PlanGates> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < TTL_MS) return this.cached.gates;
    if (this.inflight) return this.inflight;
    this.inflight = this.http
      .get<{ gates?: Partial<PlanGates> }>("/api/license")
      .then((r) => {
        const gates: PlanGates = { ...CLOSED, ...(r?.gates ?? {}) };
        this.cached = { at: Date.now(), gates };
        return gates;
      })
      .catch(() => CLOSED)
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Does the plan carry this capability? The call every surface makes. */
  async allows(capability: PlanCapability): Promise<boolean> {
    const g = await this.gates();
    if (capability === "governance") return g.governance;
    if (capability === "sso") return g.sso;
    if (capability === "bridge") return g.bridgeAllowed === true;
    return g.gatewayAllowed;
  }

  /** Drop the cache — call after a plan change so the UI re-gates at once
   *  instead of waiting out the TTL. */
  invalidate(): void {
    this.cached = null;
  }
}
