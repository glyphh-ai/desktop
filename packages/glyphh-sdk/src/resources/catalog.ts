/**
 * resources/catalog.ts — the provider/model catalog (read). What Glyphh released,
 * joined with the caller org's enablement.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { Provider, Model, Voice, HfSearchResult, HfQuant } from "../contract/catalog.js";

export class CatalogClient {
  constructor(private readonly http: AuthedHttp) {}

  providers(): Promise<Provider[]> {
    return this.http.get<Provider[]>("/api/catalog/providers");
  }

  models(): Promise<Model[]> {
    return this.http.get<Model[]>("/api/catalog/models");
  }

  /** A TTS provider's available voices (for the Voice-settings picker). */
  voices(providerSlug: string): Promise<Voice[]> {
    return this.http.get<Voice[]>(`/api/catalog/voices?provider=${encodeURIComponent(providerSlug)}`);
  }

  /** Search Hugging Face for GGUF open-weight repos (proxied server-side). */
  hfSearch(query: string): Promise<HfSearchResult> {
    return this.http.get<HfSearchResult>(`/api/models/hf-search?q=${encodeURIComponent(query)}`);
  }

  /** List a repo's downloadable GGUF quants (proxied server-side). */
  hfQuants(repo: string): Promise<{ quants: HfQuant[] }> {
    return this.http.get<{ quants: HfQuant[] }>(`/api/models/hf-quants?repo=${encodeURIComponent(repo)}`);
  }
}
