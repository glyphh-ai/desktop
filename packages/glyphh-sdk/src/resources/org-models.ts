/**
 * resources/org-models.ts — the org's SUPPORTED model set (org_admin). The org sees
 * the whole catalog with a support flag and toggles which models it's licensed /
 * willing to run — one at a time or the full set at once — plus reads its own
 * model-governance audit slice. Support (the legal set) is distinct from provider
 * enablement (the connection) and workspace allow-lists (per-team scoping).
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { OrgModel, ModelAuditQuery, ModelAuditPage, CustomModel, CustomModelInput, CustomProvider, CustomProviderInput } from "../contract/models.js";

/** Append defined params to a path as a query string. */
function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export class OrgModelsClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The whole catalog joined with the org's support flag + provider status. */
  list(): Promise<OrgModel[]> {
    return this.http.get<OrgModel[]>("/api/org/models");
  }

  /** Toggle support for one model. Returns the updated row. */
  setSupported(modelId: string, supported: boolean): Promise<OrgModel> {
    return this.http.put<OrgModel>(`/api/org/models/${encodeURIComponent(modelId)}`, { supported });
  }

  /** Set the FULL supported set at once — every listed id becomes supported, the rest not. */
  setSupportedBulk(modelIds: string[]): Promise<OrgModel[]> {
    return this.http.put<OrgModel[]>("/api/org/models", { supported: modelIds });
  }

  /** The org's model-governance audit slice (model.* actions, scoped to the org). */
  audit(query: ModelAuditQuery = {}): Promise<ModelAuditPage> {
    return this.http.get<ModelAuditPage>(
      withQuery("/api/org/model-audit", {
        action: query.action, actor: query.actor, days: query.days, page: query.page, limit: query.limit,
      }),
    );
  }

  // ── custom models — the org brings its own OpenAI-compatible endpoint ──

  /** The org's custom models (no keys returned). */
  listCustom(): Promise<CustomModel[]> {
    return this.http.get<{ models: CustomModel[] }>("/api/org/custom-models").then((r) => r.models);
  }

  /** Create or update a custom model. Omit `key` on an edit to keep the stored one. */
  saveCustom(input: CustomModelInput): Promise<CustomModel> {
    return this.http.post<{ model: CustomModel }>("/api/org/custom-models", input).then((r) => r.model);
  }

  /** Delete a custom model by its catalog id (`custom::<slug>`). */
  deleteCustom(id: string): Promise<void> {
    return this.http.del<void>(`/api/org/custom-models/${encodeURIComponent(id)}`);
  }

  // ── custom providers — any OpenAI-spec endpoint the org brings ──────────

  /** The org's custom providers (no keys returned). */
  listProviders(): Promise<CustomProvider[]> {
    return this.http.get<{ providers: CustomProvider[] }>("/api/org/custom-providers").then((r) => r.providers);
  }

  /** Create or update a provider. Omit `key` on an edit to keep the stored one. */
  saveProvider(input: CustomProviderInput): Promise<CustomProvider> {
    return this.http.post<{ provider: CustomProvider }>("/api/org/custom-providers", input).then((r) => r.provider);
  }

  /** Delete a provider — its models are deleted with it. */
  deleteProvider(slug: string): Promise<void> {
    return this.http.del<void>(`/api/org/custom-providers/${encodeURIComponent(slug)}`);
  }
}
