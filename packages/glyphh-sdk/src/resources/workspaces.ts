/**
 * resources/workspaces.ts — the governance layer. list/create/update/delete +
 * assign a member + resolve the caller's effective grants. Mutations are org_admin
 * (server-enforced); the base workspace can't be deleted.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { Workspace, WorkspaceInput, EffectiveGrants } from "../contract/workspace.js";

export class WorkspacesClient {
  constructor(private readonly http: AuthedHttp) {}

  list(): Promise<Workspace[]> {
    return this.http.get<Workspace[]>("/api/workspaces");
  }

  create(input: WorkspaceInput): Promise<Workspace> {
    return this.http.post<Workspace>("/api/workspaces", input);
  }

  update(id: string, input: WorkspaceInput): Promise<Workspace> {
    return this.http.patch<Workspace>(`/api/workspaces/${encodeURIComponent(id)}`, input);
  }

  delete(id: string): Promise<void> {
    return this.http.del<void>(`/api/workspaces/${encodeURIComponent(id)}`);
  }

  /** Assign a member to a workspace (org_admin). */
  assign(userId: string, workspaceId: string): Promise<void> {
    return this.http.post<void>("/api/workspaces/assign", { userId, workspaceId });
  }

  /** The caller's effective grants (what the runtime enforces for them). */
  grants(): Promise<EffectiveGrants> {
    return this.http.get<EffectiveGrants>("/api/workspaces/grants");
  }

  // ── role-level provider keys (org_admin) — override the org's vendor key ──
  // Write-only: presence in, presence out. Removing one returns the role to
  // the organization's provider key.

  providerKeys(id: string): Promise<Array<{ providerSlug: string; updatedAt: string }>> {
    return this.http.get<Array<{ providerSlug: string; updatedAt: string }>>(
      `/api/workspaces/${encodeURIComponent(id)}/provider-keys`);
  }

  setProviderKey(id: string, providerSlug: string, key: string): Promise<{ providerSlug: string }> {
    return this.http.put<{ providerSlug: string }>(
      `/api/workspaces/${encodeURIComponent(id)}/provider-keys/${encodeURIComponent(providerSlug)}`, { key });
  }

  clearProviderKey(id: string, providerSlug: string): Promise<void> {
    return this.http.del<void>(
      `/api/workspaces/${encodeURIComponent(id)}/provider-keys/${encodeURIComponent(providerSlug)}`);
  }
}
