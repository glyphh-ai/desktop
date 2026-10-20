/**
 * contract/auth.ts — the auth wire shapes, shared as the single source of truth for
 * the request/response bodies the control plane exposes. Pure types, zero runtime.
 */

/** The authenticated principal — `client.me()`. */
export interface Identity {
  userId: string;
  email: string;
  name: string | null;
  /** The EFFECTIVE org-local role for the session's active org. */
  role: string;
  orgId: string | null;
  tier: string;
  /** The platform-admin axis — orthogonal to org role. Gates the admin console. */
  isPlatformAdmin: boolean;
  /** Present only while a platform admin is impersonating an org; otherwise null. */
  impersonating: { orgId: string } | null;
  /** The user-set profile image URL, or null when unset. */
  imageUrl: string | null;
  /** The resolved avatar: `imageUrl` when set, else a Gravatar identicon for the email. */
  avatarUrl: string;
  /** Has the user's org completed the one-time region/first-run choice? The server
   *  derives this per-user on /api/auth/me (false = a genuinely NEW user → surfaces
   *  the first-run flow; true = returning → skip it). Optional so an older server
   *  that omits it degrades to "returning" rather than re-onboarding everyone. */
  regionChosen?: boolean;
}

/** What every auth method returns from the server: an opaque session pair. */
export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

/** The client-held session, with an absolute expiry stamped on receipt. */
export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  /** ms epoch when the access token expires. */
  expiresAt: number;
}

export interface MagicLinkStart {
  sent: boolean;
  expiresInSeconds: number;
  /** Present only in non-prod server builds, to test without a mailbox. */
  devToken?: string;
  devUrl?: string;
}

export interface OrgSsoStart {
  authorizationUrl: string;
}

export interface AppleName {
  givenName?: string | null;
  familyName?: string | null;
}

export interface OrgSsoParams {
  email?: string;
  organizationId?: string;
  redirectUri: string;
  machineId?: string;
}

// ── device authorization grant (RFC 8628) — the CLI/TUI sign-in ────────────────

/** `device/start` — the secret `deviceCode` (kept by the SDK) + what to show the user. */
export interface DeviceAuthStart {
  /** Secret handle the SDK polls with; never shown to the user. */
  deviceCode: string;
  /** The short human code the user types on the verification page, e.g. `WDJB-MJHT`. */
  userCode: string;
  /** Where the user goes to approve, e.g. `https://api.glyphh.ai/device`. */
  verificationUri: string;
  /** The verification URI with the code prefilled. */
  verificationUriComplete: string;
  /** Seconds until this request expires. */
  expiresIn: number;
  /** Minimum seconds between polls. */
  interval: number;
}

/** What the SDK hands the UI to display while it polls. */
export interface DevicePrompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
}

export type DevicePollStatus = "pending" | "slow_down" | "approved" | "denied" | "expired";

/** `device/token` — the poll result; `session` is present only when `approved`. */
export interface DevicePoll {
  status: DevicePollStatus;
  session?: IssuedSession;
}

export interface DeviceLoginOptions {
  /** Called once with the code + URL to show the user. */
  onPrompt: (prompt: DevicePrompt) => void;
  /** Abort the poll loop (e.g. the user pressed Esc). */
  signal?: AbortSignal;
  machineId?: string;
}
