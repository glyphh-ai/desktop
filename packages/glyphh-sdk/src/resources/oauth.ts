/**
 * resources/oauth.ts — the user-facing half of Glyphh's OAuth authorization server:
 * showing a consent screen, and managing what a user has already authorized.
 *
 * The protocol endpoints (/oauth/authorize, /oauth/token, /oauth/register) are
 * deliberately absent: an MCP client speaks those itself, in a browser and against the
 * spec. Only the parts a Glyphh UI drives belong here.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { OAuthClientInfo, OAuthConsentInput, OAuthConsentResult, OAuthGrant } from "../contract/oauth.js";

export class OAuthClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The client asking for access — what the consent screen renders. 404s an unknown id. */
  clientInfo(clientId: string): Promise<OAuthClientInfo> {
    return this.http.get<OAuthClientInfo>(`/oauth/client/${encodeURIComponent(clientId)}`);
  }

  /**
   * Grant consent: mints a single-use authorization code and returns where to send the
   * browser. The server re-validates the whole authorization request — a redirect_uri
   * that is not registered for this client is refused here, not just at /authorize.
   */
  consent(input: OAuthConsentInput): Promise<OAuthConsentResult> {
    return this.http.post<OAuthConsentResult>("/oauth/consent", {
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      code_challenge_method: input.codeChallengeMethod ?? "S256",
      ...(input.state ? { state: input.state } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.resource ? { resource: input.resource } : {}),
    });
  }

  /** Everything currently authorized to act for the caller. */
  async grants(): Promise<OAuthGrant[]> {
    const { grants } = await this.http.get<{ grants: OAuthGrant[] }>("/api/oauth/grants");
    return grants;
  }

  /** Revoke one connection. Independent of the user's own session: cutting off Claude
   *  must not sign them out, and signing out must not kill a background agent. */
  revokeGrant(grantId: string): Promise<{ ok: boolean }> {
    return this.http.del<{ ok: boolean }>(`/api/oauth/grants/${encodeURIComponent(grantId)}`);
  }
}
