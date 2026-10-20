/**
 * contract/member-library.ts — THE MEMBER LIBRARY, v2 (`/api/library/v2`): a
 * member's workspaces, app tabs, skills, agents and tasks, database-as-truth with
 * their files in R2. Every client (desktop, web) keeps a cache and syncs PER ITEM
 * against this surface, last-write-wins on `updatedAt` (epoch ms, the writer's
 * clock) with tombstones — the rule is `sync/lww.reconcile`. Ids are the
 * client's own; a PUT to an unknown id creates the item. `data` is the kind's
 * own payload, opaque to the server.
 *
 * Named `MemberLibrary*` at the package root: `LibraryKind`/`LibraryItem` are
 * already the legacy personal/org library's names there.
 */

/**
 * The kinds the server's member_library.py KINDS accepts. `plugin` (2026-10-05)
 * is a Claude Code plugin folder installed from the hub. The house apps
 * (2026-10-06: cloud is the one home): `design` and `deck` are a Design
 * document and a Slides deck, `image` / `video` / `audio` the media panels'
 * items, `file` a loose Drive file and `folder` a Drive folder.
 */
export type MemberLibraryKind =
  | "workspace" | "tab" | "skill" | "agent" | "task" | "drip" | "schedule" | "plugin"
  | "design" | "deck" | "image" | "video" | "audio" | "file" | "folder";

export const MEMBER_LIBRARY_KINDS: readonly MemberLibraryKind[] = [
  "workspace", "tab", "skill", "agent", "task", "drip", "schedule", "plugin",
  "design", "deck", "image", "video", "audio", "file", "folder",
];

/** One file of an item, as the server holds it in R2. */
export interface MemberLibraryFile {
  /** Path within the item (forward slashes, relative). */
  path: string;
  size: number;
  /** Epoch milliseconds. */
  mtime: number;
  sha256: string;
}

/**
 * The list projection — what a sync walks. `data` is present on live rows (always
 * without `since`; on the changed-since page only for the live ones); a tombstone
 * carries `deletedAt` and no data.
 */
export interface MemberLibraryRow<T = unknown> {
  kind: MemberLibraryKind;
  id: string;
  /** Epoch milliseconds — the LWW clock. */
  updatedAt: number;
  /** ISO timestamp when tombstoned; null while live. */
  deletedAt: string | null;
  data?: T;
}

/** One item in full: the row plus its creation stamp, payload and file manifest. */
export interface MemberLibraryItem<T = unknown> extends MemberLibraryRow<T> {
  /** ISO timestamp. */
  createdAt: string;
  data: T;
  files: MemberLibraryFile[];
}

export interface ListMemberLibraryOptions {
  /** Epoch ms: return only rows (live AND tombstoned) changed strictly after it. */
  since?: number;
}

/** The PUT body: the payload, optionally the file manifest, and the writer's clock. */
export interface PutMemberLibraryInput<T = unknown> {
  data: T;
  files?: MemberLibraryFile[];
  /** Epoch milliseconds — applies only when STRICTLY newer than the stored clock. */
  updatedAt: number;
}

/** The PUT verdict: whether the clock let it apply, plus the item as the server now holds it. */
export interface PutMemberLibraryResult<T = unknown> {
  applied: boolean;
  item: MemberLibraryItem<T>;
}

export interface RemoveMemberLibraryInput {
  /** Epoch milliseconds — the tombstone's clock; the server's now when omitted. */
  updatedAt?: number;
}

/** Presigned R2 URLs for the asked paths: `put` to upload, `get` to download. */
export interface MemberLibraryFileUrls {
  put: Record<string, string>;
  get: Record<string, string>;
}
