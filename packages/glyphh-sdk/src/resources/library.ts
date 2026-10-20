/**
 * resources/library.ts — one generic library resource, instantiated per kind. The same
 * CRUD backs `client.rotors`, `client.skills`, `client.agents`, `client.layouts`,
 * `client.drips`, and `client.messageSessions`; each is bound to its `LibraryKind` and
 * targets `/api/library/<kind>`. `list` returns your personal items plus the org's
 * shared ones; `save` creates or updates (pass `id` to update; `scope:"org"` needs admin).
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { LibraryItem, LibraryKind, SaveLibraryItemInput } from "../contract/library.js";

export class LibraryClient {
  private readonly base: string;

  constructor(
    private readonly http: AuthedHttp,
    private readonly kind: LibraryKind,
  ) {
    this.base = `/api/library/${kind}`;
  }

  /** Your personal items of this kind plus the org's shared ones. */
  list(): Promise<LibraryItem[]> {
    return this.http.get<LibraryItem[]>(this.base);
  }

  /** One item by id (if visible to you). */
  get(id: string): Promise<LibraryItem> {
    return this.http.get<LibraryItem>(`${this.base}/${encodeURIComponent(id)}`);
  }

  /** Create (no `id`) or update (with `id`). `scope:"org"` requires org_admin. */
  save(input: SaveLibraryItemInput): Promise<LibraryItem> {
    return this.http.post<LibraryItem>(this.base, input);
  }

  /** Delete an item by id. */
  delete(id: string): Promise<void> {
    return this.http.del<void>(`${this.base}/${encodeURIComponent(id)}`);
  }
}
