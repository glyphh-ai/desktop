/**
 * contract/library.ts — org + personal LIBRARIES. A library item is a named, versioned
 * artifact (a rotor loop, skill, agent, layout, drip, or saved message session) carrying
 * an opaque kind-specific `data` payload the runtime interprets. `personal` items are
 * owned by and visible to one user; `org` items are shared across the org's members
 * (writable by an org_admin). One uniform CRUD surface backs every kind.
 */

export type LibraryKind = "rotor" | "layout" | "drip" | "message_session";

export type LibraryScope = "personal" | "org";

export interface LibraryItem {
  id: string;
  kind: LibraryKind;
  scope: LibraryScope;
  name: string;
  /** Kind-specific spec; opaque to the control plane. */
  data: unknown;
  orgId: string;
  /** The owning user for `personal` items; null for `org` items. */
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveLibraryItemInput {
  name: string;
  data: unknown;
  /** Defaults to `personal`. */
  scope?: LibraryScope;
  /** Present to update an existing item; omit to create. */
  id?: string;
}
