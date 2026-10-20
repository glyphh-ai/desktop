/**
 * contract/membership.ts — the scoped/union membership wire shapes. An identity holds
 * many memberships (one per org, each with an org-local role); a session acts in ONE
 * of them at a time. `Membership` is a row of the caller's org-switcher; `EffectiveContext`
 * is the session-scope snapshot returned after a scope change (active-org switch or a
 * platform-admin impersonation start/stop).
 */

/** One of the caller's org memberships, flagged with whether the session is acting in it. */
export interface Membership {
  orgId: string;
  orgName: string;
  role: string;
  active: boolean;
}

/** The session's effective scope after a change — the shape a client re-reads to resync. */
export interface EffectiveContext {
  orgId: string | null;
  role: string;
  isPlatformAdmin: boolean;
  /** Present only while a platform admin is impersonating an org; otherwise null. */
  impersonating: { orgId: string } | null;
}
