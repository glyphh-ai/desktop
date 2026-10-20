/**
 * resources/providers.ts — org-level provider enablement + BYOK (org_admin). The
 * key is write-only: sent to the server (encrypted at rest), never returned.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { Provider } from "../contract/catalog.js";

export class ProvidersClient {
  constructor(private readonly http: AuthedHttp) {}

  /** Enable a provider for the org, optionally attaching a BYOK key. */
  enable(slug: string, key?: string): Promise<Provider> {
    return this.http.post<Provider>("/api/providers", key ? { slug, key } : { slug });
  }

  /** Remove the org's BYOK key but KEEP the provider enabled — drops back to
   *  the platform proxy key (metered) for this provider. */
  clearKey(slug: string): Promise<void> {
    return this.http.del<void>(`/api/providers/${encodeURIComponent(slug)}/key`);
  }
  disable(slug: string): Promise<void> {
    return this.http.del<void>(`/api/providers/${encodeURIComponent(slug)}`);
  }
}
