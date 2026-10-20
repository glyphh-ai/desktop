/**
 * resources/member-library.ts — `client.memberLibrary`: the member library v2
 * (`/api/library/v2/<kind>`), one surface for every kind. A sync is
 * `list(kind, { since })` → `reconcile(local, rows)` → `put`/`get`/`remove` per
 * item, with `files()` minting the presigned R2 URLs for an item's files.
 * Envelope `{ data }`; errors `{ error, detail }` (404 → NotFoundError).
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type {
  ListMemberLibraryOptions,
  MemberLibraryFileUrls,
  MemberLibraryItem,
  MemberLibraryKind,
  MemberLibraryRow,
  PutMemberLibraryInput,
  PutMemberLibraryResult,
  RemoveMemberLibraryInput,
} from "../contract/member-library.js";

const BASE = "/api/library/v2";

const itemPath = (kind: MemberLibraryKind, id: string): string => `${BASE}/${kind}/${encodeURIComponent(id)}`;

export class MemberLibraryClient {
  constructor(private readonly http: AuthedHttp) {}

  /**
   * The rows of one kind. Without `since`: every live row, with data. With
   * `since` (epoch ms): the live AND tombstoned rows changed strictly after it,
   * data on the live ones — the page a sync reconciles against.
   */
  list<T = unknown>(kind: MemberLibraryKind, opts: ListMemberLibraryOptions = {}): Promise<MemberLibraryRow<T>[]> {
    const qs = opts.since !== undefined ? `?since=${encodeURIComponent(String(opts.since))}` : "";
    return this.http.get<MemberLibraryRow<T>[]>(`${BASE}/${kind}${qs}`);
  }

  /** One item in full (data + file manifest). Unknown or tombstoned → NotFoundError. */
  get<T = unknown>(kind: MemberLibraryKind, id: string): Promise<MemberLibraryItem<T>> {
    return this.http.get<MemberLibraryItem<T>>(itemPath(kind, id));
  }

  /**
   * LWW upsert: an unknown id creates the item; an existing one updates only when
   * `updatedAt` is strictly newer than the stored clock. Either way the result
   * carries the server's current item to reconcile against.
   */
  put<T = unknown>(kind: MemberLibraryKind, id: string, input: PutMemberLibraryInput<T>): Promise<PutMemberLibraryResult<T>> {
    return this.http.put<PutMemberLibraryResult<T>>(itemPath(kind, id), input);
  }

  /** Tombstone an item at `updatedAt` (the server's now when omitted). 204. */
  remove(kind: MemberLibraryKind, id: string, input: RemoveMemberLibraryInput = {}): Promise<void> {
    return this.http.del<void>(itemPath(kind, id), input);
  }

  /** Presigned R2 URLs (`put` to upload, `get` to download) for the item's given paths. */
  files(kind: MemberLibraryKind, id: string, paths: string[]): Promise<MemberLibraryFileUrls> {
    return this.http.post<MemberLibraryFileUrls>(`${itemPath(kind, id)}/files`, { paths });
  }
}
