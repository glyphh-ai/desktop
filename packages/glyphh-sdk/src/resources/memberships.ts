/**
 * resources/memberships.ts — the caller's org memberships + the session's active-org
 * scope (the scoped/union model). `orgs()` lists every org the identity belongs to
 * (for the org-switcher); `setActiveOrg()` pins the current session to one of them.
 * A platform admin who is NOT a member cannot switch here (403) — that's what
 * `admin.impersonate()` is for. Authz is server-side.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { Membership, EffectiveContext } from "../contract/membership.js";

export class MembershipsClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The caller's memberships (oldest first); each flags whether it's the active one. */
  orgs(): Promise<Membership[]> {
    return this.http.get<Membership[]>("/api/me/orgs");
  }

  /** Switch this session's active org (must be a member); returns the new effective scope. */
  setActiveOrg(orgId: string): Promise<EffectiveContext> {
    return this.http.post<EffectiveContext>("/api/session/active-org", { orgId });
  }
}
