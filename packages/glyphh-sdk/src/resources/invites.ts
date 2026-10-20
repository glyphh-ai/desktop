/**
 * resources/invites.ts — accept an org invite. `peek` is the unauthenticated
 * accept-page view; `accept` requires the signed-in user's email to match the invite.
 */

import type { HttpClient } from "../core/http.js";
import type { AuthedHttp } from "../core/authed-http.js";
import type { InvitePreview, Org } from "../contract/org.js";

export class InvitesClient {
  constructor(
    private readonly http: HttpClient,
    private readonly authed: AuthedHttp,
  ) {}

  /** Public: what this invite is for (no auth needed). */
  peek(token: string): Promise<InvitePreview> {
    return this.http.get<InvitePreview>(`/api/org/invites/${encodeURIComponent(token)}`);
  }

  /** Authenticated: join the org (the caller's email must match the invite). */
  accept(token: string): Promise<Org> {
    return this.authed.post<Org>("/api/org/invites/accept", { token });
  }
}
