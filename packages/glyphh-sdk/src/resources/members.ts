/**
 * resources/members.ts — org membership + seats. Invite/remove/role are org_admin
 * actions (server-enforced); a seat-full invite surfaces as an entitlement error.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { CreatedInvite, Member, MemberRole, MemberSystemRole, MemberProfileUpdate, PendingInvite } from "../contract/org.js";

export class MembersClient {
  constructor(private readonly http: AuthedHttp) {}

  list(): Promise<Member[]> {
    return this.http.get<Member[]>("/api/org/members");
  }

  invite(email: string, role: MemberRole = "user"): Promise<CreatedInvite> {
    return this.http.post<CreatedInvite>("/api/org/members/invite", { email, role });
  }

  /** The org's PENDING invites (unaccepted + unexpired) — the Invited tab. */
  pendingInvites(): Promise<PendingInvite[]> {
    return this.http.get<PendingInvite[]>("/api/org/invites");
  }

  /** Revoke a pending invite by id. */
  revokeInvite(id: string): Promise<void> {
    return this.http.del<void>(`/api/org/invites/id/${encodeURIComponent(id)}`);
  }

  remove(userId: string): Promise<void> {
    return this.http.del<void>(`/api/org/members/${encodeURIComponent(userId)}`);
  }

  /** Set a member's display name from a first/last pair (org_admin). */
  updateProfile(userId: string, patch: MemberProfileUpdate): Promise<Member> {
    return this.http.patch<Member>(`/api/org/members/${encodeURIComponent(userId)}`, patch);
  }

  /** Set a member's system role — user | admin | org_admin (org_admin). */
  /** Disable ⇄ enable a member — one flip locks their sessions out, reversibly. */
  setStatus(userId: string, disabled: boolean): Promise<{ ok: boolean; disabled: boolean }> {
    return this.http.patch(`/api/org/members/${encodeURIComponent(userId)}/status`, { disabled }) as Promise<{ ok: boolean; disabled: boolean }>;
  }

  setRole(userId: string, role: MemberSystemRole): Promise<Member> {
    return this.http.patch<Member>(`/api/org/members/${encodeURIComponent(userId)}/role`, { role });
  }

  /**
   * Assign a member to a workspace (access role), or clear them back to the org's
   * base workspace with `null` (org_admin).
   */
  assignWorkspace(userId: string, workspaceId: string | null): Promise<Member> {
    return this.http.patch<Member>(`/api/org/members/${encodeURIComponent(userId)}/org-role`, { roleId: workspaceId });
  }
}
