/**
 * resources/environments.ts — the member's named cloud environments (his direction,
 * 2026-10-05: personal environments). Create one with a name, a network policy and
 * .env text; a cloud turn names it by id and the server injects the variables into
 * the worker — the values never come back through this client.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { CreateEnvironmentInput, Environment, EnvironmentSummary, UpdateEnvironmentInput } from "../contract/environments.js";

export class EnvironmentsClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The member's own environments, by name. "Default" is not among them: it is the absent pick. */
  list(): Promise<EnvironmentSummary[]> {
    return this.http.get<EnvironmentSummary[]>("/api/environments");
  }

  /** One environment with its variable KEYS and masked previews. `default` answers the built-in one. */
  get(id: string): Promise<Environment> {
    return this.http.get<Environment>(`/api/environments/${encodeURIComponent(id)}`);
  }

  create(input: CreateEnvironmentInput): Promise<Environment> {
    return this.http.post<Environment>("/api/environments", input);
  }

  /** Only the named fields change; `vars` replaces the whole set. */
  update(id: string, input: UpdateEnvironmentInput): Promise<Environment> {
    return this.http.put<Environment>(`/api/environments/${encodeURIComponent(id)}`, input);
  }

  delete(id: string): Promise<void> {
    return this.http.del<void>(`/api/environments/${encodeURIComponent(id)}`);
  }
}
