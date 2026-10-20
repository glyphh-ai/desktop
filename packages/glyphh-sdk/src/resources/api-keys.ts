/**
 * resources/api-keys.ts — user-scoped `gy_ak_…` API keys. A key authenticates headless
 * SDK/CLI use (pass it as `apiKey` to createClient) and the desktop relay as its owner.
 * The raw token is returned once from `create`; thereafter only metadata is visible.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { ApiKey, ApiKeyInput, CreatedApiKey } from "../contract/api-keys.js";

export class ApiKeysClient {
  constructor(private readonly http: AuthedHttp) {}

  /** Mint a key for the calling user. The `token` is shown ONCE — store it now. */
  create(input: ApiKeyInput): Promise<CreatedApiKey> {
    return this.http.post<CreatedApiKey>("/api/keys", input);
  }

  /** The caller's own keys (metadata only). */
  list(): Promise<ApiKey[]> {
    return this.http.get<ApiKey[]>("/api/keys");
  }

  /** Every key in the caller's org, grouped by user — the platform view (org_admin). */
  listOrg(): Promise<ApiKey[]> {
    return this.http.get<ApiKey[]>("/api/keys/org");
  }

  /** Revoke a key by id (owner, or an org_admin for any key in the org). */
  revoke(id: string): Promise<void> {
    return this.http.del<void>(`/api/keys/${encodeURIComponent(id)}`);
  }
}
