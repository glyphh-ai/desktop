/**
 * contract/artifacts.ts — ARTIFACTS (his direction, 2026-10-05: artifacts like
 * Claude's). A page, a report or a file the loop publishes for a member: the
 * record lives in Postgres, the bytes in R2 under the org and the member, beside
 * Drive files and never one of them. Private to its owner, shared with the org,
 * or public behind a share token that rides the view link as `?t=`. A comment
 * thread pins a region of the page.
 */

export type ArtifactAccess = "private" | "org" | "public";
export const ARTIFACT_ACCESSES: readonly ArtifactAccess[] = ["private", "org", "public"];

/** The list scopes: `all` = mine + the org's shared; `shared` = the org's shared, not mine. */
export type ArtifactScope = "all" | "mine" | "shared";

/** An artifact is 25 MB at most. */
export const ARTIFACT_SIZE_CAP = 25 * 1024 * 1024;

export interface Artifact {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  access: ArtifactAccess;
  ownerId: string;
  ownerName: string;
  /** The caller owns it. */
  mine: boolean;
  /** The session that published it, when one did. */
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
  /** The page in the web app: <app>/a/<id>. */
  viewUrl: string;
  /** The link anyone can open: viewUrl + ?t=<token>. Present only while public. */
  shareUrl?: string;
}

/** `artifacts.create` input: the bytes as base64 `content` or as UTF-8 `text`,
 *  exactly one of them. `mime` absent is inferred from the name's extension. */
export interface CreateArtifactInput {
  /** 1 to 200 characters. */
  name: string;
  mime?: string;
  content?: string;
  text?: string;
  sessionId?: string;
}

/** `artifacts.update` input: only what is named changes, in place (the same id,
 *  comments kept). New bytes ride as base64 `content` or UTF-8 `text`, one of
 *  them, like create. `public` mints the share token; leaving public clears it. */
export interface UpdateArtifactInput {
  name?: string;
  access?: ArtifactAccess;
  mime?: string;
  content?: string;
  text?: string;
}

export interface ShareArtifactResult {
  access: ArtifactAccess;
  shareUrl: string | null;
}

/** A dashed region drawn on the page: fractions 0..1 of its width and height. */
export interface ArtifactRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ArtifactCommentAuthor {
  id: string;
  name: string;
  avatarUrl?: string;
}

export interface ArtifactComment {
  id: string;
  author: ArtifactCommentAuthor;
  region: ArtifactRegion | null;
  text: string;
  resolved: boolean;
  createdAt: string;
  /** Set on a reply. */
  parentId?: string;
  /** Glyphh's own reply, posted back by the member's client (author reads "Glyphh"). */
  agent?: boolean;
  /** The thread under a top-level comment (the list nests one level). */
  replies?: ArtifactComment[];
}

export interface AddArtifactCommentInput {
  /** 1 to 4000 characters. */
  text: string;
  region?: ArtifactRegion;
  /** Reply to a top-level comment. */
  parentId?: string;
  /** Post this reply as Glyphh's (requires parentId). */
  agent?: boolean;
}
