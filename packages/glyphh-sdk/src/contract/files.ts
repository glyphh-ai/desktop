/**
 * contract/files.ts — the FILES surface: explicit ARTIFACTS an agent (or the user) saved
 * for the user. One set across every remote session + the desktop; the bytes live in R2,
 * this is the metadata the /files reader lists and renders with type-aware viewers.
 *
 * A `FileArtifact` is USER-scoped: an owner sees their own, an org_admin of the same org
 * may see the org's, a foreign org never resolves. `downloadUrl` is a short-lived,
 * browser-ready (no auth header) URL present only on `files.get(id)` — the list omits it
 * to avoid a pointless fan-out of signed grants.
 */

/** The coarse viewer bucket the reader keys its type-aware viewer off. */
export type FileKind = "code" | "text" | "markdown" | "image" | "pdf" | "other";

export interface FileArtifact {
  id: string;
  name: string;
  mime: string;
  kind: FileKind;
  /** The runtime session that produced it, or null (a desktop / out-of-session save). */
  sessionId: string | null;
  sizeBytes: number;
  createdAt: string;
  /** A short-lived download/view URL — present only on `files.get(id)`. */
  downloadUrl?: string;
}

/** Narrow the list to one runtime session (the /files session filter). */
export interface ListFilesQuery {
  sessionId?: string;
}

/**
 * Save an artifact. The AGENT/RUNTIME is the primary writer (server-side, via the
 * service token); this input is for the completeness case where the platform itself
 * uploads on the user's behalf — the bytes arrive base64-encoded and the save is scoped
 * to the authenticated caller.
 */
export interface CreateFileInput {
  name: string;
  mime?: string;
  /** The artifact bytes, base64-encoded. */
  contentBase64: string;
  /** Which runtime session it belongs to (optional). */
  sessionId?: string | null;
}
