/**
 * contract/oauth.ts — Glyphh as an OAuth 2.1 authorization server, so an MCP client
 * (Claude, Cursor, anything) can act on a user's behalf.
 *
 * Only the two USER-facing halves live in the SDK: rendering a consent screen, and
 * managing the connections a user has already authorized. The protocol endpoints
 * themselves — /oauth/authorize, /oauth/token, /oauth/register — are spoken by the
 * MCP client directly, in a browser and against a spec; wrapping them in a typed
 * method would imply the SDK is a participant in a flow it never touches.
 */

/** What a consent screen shows so a user can decide whether to trust a client. */
export interface OAuthClientInfo {
  clientId: string;
  clientName: string;
  /** Where a code may be sent. Shown so a user can see where they are being sent. */
  redirectUris: string[];
  logoUri: string | null;
  clientUri: string | null;
}

/** The consent decision. Every field comes from the authorization request the client
 *  started, and is passed back unchanged — the server re-validates all of it. */
export interface OAuthConsentInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod?: string | undefined;
  state?: string | undefined;
  scope?: string | undefined;
  resource?: string | undefined;
}

/** Where to send the browser once consent is granted (carries the authorization code). */
export interface OAuthConsentResult {
  redirectTo: string;
}

/** One third party currently authorized to act for the user. */
export interface OAuthGrant {
  grantId: string;
  clientId: string;
  clientName: string;
  scope: string;
  createdAt: string;
  /** Null until the client first uses it — an integration that never connected. */
  lastUsedAt: string | null;
}
