/**
 * contract/git.ts — GitHub connection surface. A user links GitHub via OAuth (the
 * `connect` link opens GitHub's consent screen; the callback lands server-side), after
 * which the control plane can list their repos and — at session-provision time — mint a
 * short-lived, repo-scoped installation clone token that is injected into the runtime
 * SERVER-SIDE and never returned to the client.
 */

/** One installation of the Glyphh Code App the member can reach: on their own
 *  account (`User`) or on an org they belong to (`Organization`). `url` is
 *  GitHub's settings page for THAT installation, where its repositories change
 *  (an org's lives under the org). */
export interface GitInstallation {
  id: string;
  /** The account the installation sits on: the member's login, or an org's. */
  account: string;
  type: "User" | "Organization";
  url: string;
}

export interface GitConnection {
  connected: boolean;
  /** GitHub login (username), when connected. The connection is the PERSON:
   *  repositories list across every installation they reach (2026-10-05). */
  login: string | null;
  /** The FIRST installation's id (the member's own account leads, then their
   *  orgs) — kept for a client that knows one installation; `installations`
   *  is the whole set. */
  installationId: string | null;
  connectedAt: string | null;
  /** True while an install this member started waits for `git.complete` (ten
   *  minutes from the callback). Absent otherwise. */
  pending?: boolean;
  /** GitHub's settings page for the FIRST installation. Present when
   *  connected and GitHub answered; `installations[].url` has every one. */
  installationUrl?: string;
  /** Every installation the member reaches, their own account first, then
   *  the orgs by name. Present when connected; empty when GitHub did not
   *  answer the read (the connection stands, the list is just unread). */
  installations?: GitInstallation[];
}

/** `git.connect` returns a GitHub URL for the user to open; `state` guards the callback.
 *  The callback lands on `returnTo` with `?github=pending&link=<nonce>`: the SAME
 *  member's session then calls `git.complete(link)` to finish, which is what binds
 *  the installation to the person who started it (a handed-around install link
 *  never lands on someone else's account). */
export interface GitConnectLink {
  url: string;
  state: string;
}

/** `git.connect` input: where GitHub's callback sends the person back once the
 *  App is installed (`?github=connected` or `?github=error&reason=…` appended).
 *  Only our own https hosts and localhost are honored; anything else ends on
 *  the server's plain "connected" page. */
export interface GitConnectOptions {
  returnTo?: string;
}

export interface Repo {
  /** GitHub numeric id as a string. */
  id: string;
  /** `owner/name`. */
  fullName: string;
  private: boolean;
  defaultBranch: string;
  url: string;
  /** The installation account the repo listed through (`GitInstallation.account`):
   *  what the picker groups by when the member reaches more than one. */
  account?: string;
  /** The installation it listed through (`GitInstallation.id`). */
  installationId?: string;
}

/** One branch of a repo, as `git.branches` lists them: the default first. */
export interface Branch {
  name: string;
  default: boolean;
}
