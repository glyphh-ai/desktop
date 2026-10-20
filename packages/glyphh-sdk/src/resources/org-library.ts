/**
 * resources/org-library.ts — the ORG LIBRARY client.
 *
 * The one grammar of the Build plane:
 *
 *   installed (mine)  ←install—  published (org's, role-filtered)
 *        │                              ↑
 *        └——— promote → review desk ————┘
 *
 * `list` is already narrowed to what the CALLER may see; the review desk and
 * access control answer only to org admins (the server enforces).
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type {
  OrgLibraryKind, OrgLibraryItem, OrgLibraryPending,
  OrgLibraryPromoteInput, OrgLibraryPromoteResult, OrgLibraryMetrics,
} from "../contract/org-library.js";

export class OrgLibraryClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The published list of one kind, role-narrowed to the caller. */
  list(kind: OrgLibraryKind): Promise<OrgLibraryItem[]> {
    return this.http.get<OrgLibraryItem[]>(`/api/library/${kind}`);
  }

  /** Promote a local build: payload → an immutable version, pending review. */
  promote(kind: OrgLibraryKind, input: OrgLibraryPromoteInput): Promise<OrgLibraryPromoteResult> {
    return this.http.post<OrgLibraryPromoteResult>(`/api/library/${kind}/promote`, input);
  }

  /** The review desk — every pending version, oldest first (org_admin). */
  queue(): Promise<OrgLibraryPending[]> {
    return this.http.get<OrgLibraryPending[]>("/api/library/queue");
  }

  /** Approve or reject one pending version (org_admin). */
  decide(versionId: string, approve: boolean): Promise<{ id: string; status: string }> {
    return this.http.post<{ id: string; status: string }>(`/api/library/versions/${versionId}/decide`, { approve });
  }

  /** Set one item's role access: the restricted flag + the full grant list,
   *  rebuilt wholesale (org_admin). */
  setAccess(kind: OrgLibraryKind, id: string, restricted: boolean, userIds: string[]): Promise<void> {
    return this.http.post<void>(`/api/library/${kind}/${id}/access`, { restricted, userIds });
  }

  /** The admin's kill-switch — off hides it from members, installs kept. */
  setEnabled(kind: OrgLibraryKind, id: string, enabled: boolean): Promise<void> {
    return this.http.post<void>(`/api/library/${kind}/${id}/enable`, { enabled });
  }

  /** DESTRUCTIVE: the item leaves the library AND every member's installs. */
  remove(kind: OrgLibraryKind, id: string): Promise<void> {
    return this.http.del<void>(`/api/library/${kind}/${id}`);
  }

  /** Light per-item metrics — installs + version history (org_admin). */
  metrics(kind: OrgLibraryKind, id: string): Promise<OrgLibraryMetrics> {
    return this.http.get<OrgLibraryMetrics>(`/api/library/${kind}/${id}/metrics`);
  }

  /** Join the caller's installed list. */
  install(kind: OrgLibraryKind, id: string): Promise<void> {
    return this.http.post<void>(`/api/library/${kind}/${id}/install`, {});
  }

  /** Leave it. */
  uninstall(kind: OrgLibraryKind, id: string): Promise<void> {
    return this.http.del<void>(`/api/library/${kind}/${id}/install`);
  }

  /** The approved payload — head by default, `version` for a pin. */
  payload<T = unknown>(kind: OrgLibraryKind, id: string, version?: number): Promise<T> {
    const q = version ? `?version=${version}` : "";
    return this.http.get<T>(`/api/library/${kind}/${id}/payload${q}`);
  }
}
