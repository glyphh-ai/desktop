/**
 * contract/models.ts — MODEL GOVERNANCE. Two org-admin surfaces + one member read:
 *   • OrgModel — the whole catalog joined with the org's SUPPORT flag (is the org
 *     licensed / willing to run this model) + the provider's org status. The org
 *     toggles which models it supports.
 *   • AvailableModel — the EFFECTIVE set a caller may actually use: catalog ∩
 *     org-supported ∩ workspace allow-list, each tagged with how it's reached.
 *   • the model-governance audit slice (reuses the snake_case admin AuditEntry).
 */

import type { AuditEntry, AuditPage } from "./admin.js";

/** How a bound/available model is reached: our metered proxy, the org's BYOK account, or on-device. */
export type ModelSource = "proxy" | "byok" | "local";

/** One row of the org's model-support view (whole catalog + support/provider status). */
export interface OrgModel {
  id: string; // "anthropic::claude-opus-4-8"
  name: string;
  providerSlug: string;
  kind: string; // "proxied" | "open_weight"
  /** chat | image | video | speech | transcription. */
  modality: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /**
   * Total tokens the model accepts (prompt + completion). Null when the catalog has
   * not recorded it — callers must NOT invent a ceiling, since a wrong one fails
   * turns that would have worked.
   *
   * A loop reads this to decide what to send: which tools to introduce and when,
   * how much history to carry. An agent framework's opening system prompt can run
   * to tens of thousands of tokens on its own, so a small model needs a smaller
   * tool surface, not just a shorter conversation.
   */
  contextWindow: number | null;
  /** Largest single completion the model produces. Null = unrecorded. */
  maxOutputTokens: number | null;
  active: boolean;
  /** Whether the org supports (is licensed / willing to run) this model. */
  supported: boolean;
  /** Whether the org has turned the model's provider on. */
  providerEnabled: boolean;
  /** Whether the org has a BYOK key for the model's provider (never the key). */
  hasByokKey: boolean;
  /** False when the org's PLAN excludes this model (free-tier gate). */
  planAllowed?: boolean;
  /** The catalog flag: this model is one of the handful a Free org gets. */
  freePlan?: boolean;
}

/** A model the caller may actually use, with the route it resolves to. */
export interface AvailableModel {
  id: string;
  name: string;
  providerSlug: string;
  kind: string;
  /** chat | image | video | speech | transcription — for picker/slot filtering. */
  modality: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /**
   * Total tokens the model accepts (prompt + completion). Null when the catalog has
   * not recorded it — callers must NOT invent a ceiling, since a wrong one fails
   * turns that would have worked.
   *
   * A loop reads this to decide what to send: which tools to introduce and when,
   * how much history to carry. An agent framework's opening system prompt can run
   * to tens of thousands of tokens on its own, so a small model needs a smaller
   * tool surface, not just a shorter conversation.
   */
  contextWindow: number | null;
  /** Largest single completion the model produces. Null = unrecorded. */
  maxOutputTokens: number | null;
  source: ModelSource;
  /** The catalog flag: this model is one of the handful a Free org gets. */
  freePlan?: boolean;
  /** The model takes a reasoning effort (`LoopTurn.effort` → `reasoning_effort`
   *  on the wire); a picker shows the dial only for these. */
  reasoning?: boolean;
  /** The catalog flag: THE one shared chat model the platform runs its side
   *  tasks on (session titles). At most one row carries it; see pickUtilityModel. */
  utility?: boolean;
}

/** A custom model an org admin defined — BYO OpenAI-compatible endpoint. Keys
 *  are write-only; `hasKey` reports whether one is stored. */
export interface CustomModel {
  org_id: string;
  id: string;              // catalog id, `custom::<slug>`
  name: string;
  base_url: string;        // '' on a provider-backed row (endpoint from the provider)
  provider_slug: string | null;
  model_name: string;      // the string sent as "model" to the endpoint
  context_window: number;
  max_output_tokens: number;
  input_rate_micro: string;
  output_rate_micro: string;
  has_key: boolean;
  active: boolean;
}

/** Create/update input for a custom model. Omit `key` on an edit to keep the stored one. */
export interface CustomModelInput {
  slug: string;            // lowercase; the server namespaces it as custom::<slug>
  name: string;
  /** Direct endpoint — omit when `providerSlug` names an org provider. */
  baseUrl?: string | undefined;
  /** The org custom provider this model rides (endpoint + key come from it). */
  providerSlug?: string | null | undefined;
  modelName: string;
  contextWindow: number;
  maxOutputTokens: number;
  key?: string | undefined;
  active?: boolean | undefined;
}

/** An org custom PROVIDER — any OpenAI-spec endpoint (key write-only). */
export interface CustomProvider {
  org_id: string;
  slug: string;
  name: string;
  base_url: string;
  has_key: boolean;
  /** Non-secret summary of the stored key; null when unset. */
  key_hint: string | null;
  active: boolean;
  model_count: number;
}

/** Create/update input for a custom provider. Omit `key` on an edit to keep the stored one. */
export interface CustomProviderInput {
  slug: string;
  name: string;
  baseUrl: string;
  key?: string | undefined;
  /** Explicitly drop the stored key. */
  clearKey?: boolean | undefined;
  active?: boolean | undefined;
}

/** Filter for the org's model-governance audit slice (action is a model.* action). */
export interface ModelAuditQuery {
  action?: string | undefined;
  actor?: string | undefined;
  days?: number | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export type { AuditEntry as ModelAuditEntry, AuditPage as ModelAuditPage };
