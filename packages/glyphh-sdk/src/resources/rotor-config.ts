/**
 * resources/rotor-config.ts — the rotor catalog + role→model bindings. Pick a rotor, see the
 * model roles it needs, bind each to a catalog model, and read back the resolved registry the
 * runtime injects. This is the control-plane half of "configure the rotor."
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { RotorCatalogEntry } from "../contract/rotors.js";
import type { RotorBinding, RotorRegistry, SetBindingInput } from "../contract/bindings.js";

export class RotorConfigClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The runnable rotors + the model roles each declares. */
  rotors(): Promise<RotorCatalogEntry[]> {
    return this.http.get<RotorCatalogEntry[]>("/api/rotors");
  }

  /** One rotor + its roles. */
  rotor(slug: string): Promise<RotorCatalogEntry> {
    return this.http.get<RotorCatalogEntry>(`/api/rotors/${encodeURIComponent(slug)}`);
  }

  /** The current role→model binding for a rotor (workspace-scoped). */
  binding(slug: string): Promise<RotorBinding> {
    return this.http.get<RotorBinding>(`/api/rotors/${encodeURIComponent(slug)}/binding`);
  }

  /** Bind a rotor's roles to catalog models. */
  setBinding(slug: string, input: SetBindingInput): Promise<RotorBinding> {
    return this.http.put<RotorBinding>(`/api/rotors/${encodeURIComponent(slug)}/binding`, input);
  }

  /** The resolved registry (gateway models addressed; local models awaiting a device url). */
  registry(slug: string): Promise<RotorRegistry> {
    return this.http.get<RotorRegistry>(`/api/rotors/${encodeURIComponent(slug)}/registry`);
  }
}
