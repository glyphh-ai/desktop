/**
 * resources/git.ts — GitHub connection. `connect` returns a URL the user opens to grant
 * GitHub access (the callback lands server-side); once linked, `repos` lists their
 * repositories and a session created with a `repo` gets a repo-scoped clone token
 * injected into its runtime SERVER-SIDE — the token never reaches the client.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { Branch, GitConnection, GitConnectLink, GitConnectOptions, Repo } from "../contract/git.js";

export class GitClient {
  constructor(private readonly http: AuthedHttp) {}

  /** Begin linking GitHub — open the returned `url` to grant access. `returnTo`
   *  (the phone, the web app) is where the callback lands the person afterwards. */
  connect(opts: GitConnectOptions = {}): Promise<GitConnectLink> {
    return this.http.post<GitConnectLink>("/api/git/connect", opts.returnTo ? { returnTo: opts.returnTo } : {});
  }

  /** Finish a link the callback parked: `link` is the nonce from the
   *  `?github=pending&link=` landing; without one, this member's newest
   *  pending install. 403 when someone else started it, 404 when none waits. */
  complete(link?: string): Promise<GitConnection> {
    return this.http.post<GitConnection>("/api/git/connect/complete", link ? { link } : {});
  }

  /** Whether GitHub is linked, and as whom (`pending` while a link waits). */
  status(): Promise<GitConnection> {
    return this.http.get<GitConnection>("/api/git/status");
  }

  /** Short-lived, repo-scoped clone token for a LOCAL `git clone` — the
   *  desktop's create-from-git door. 404 when the App doesn't cover the repo. */
  cloneToken(repo: string): Promise<{ token: string; expiresAt: string }> {
    return this.http.post<{ token: string; expiresAt: string }>("/api/git/clone-token", { repo });
  }

  /** The repositories across every installation the member reaches (their
   *  own account first, then their orgs); each row names its `account`. */
  repos(): Promise<Repo[]> {
    return this.http.get<Repo[]>("/api/git/repos");
  }

  /** A repo's branches (`owner/name`), the default first — the base branch
   *  pick for a cloud Code session (his direction, 2026-10-05). */
  branches(repo: string): Promise<Branch[]> {
    const [owner, name] = repo.split("/", 2);
    if (!owner || !name) throw new Error("repo must be owner/name");
    return this.http.get<Branch[]>(`/api/git/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`);
  }

  /** Unlink GitHub. */
  disconnect(): Promise<void> {
    return this.http.del<void>("/api/git/connection");
  }
}
