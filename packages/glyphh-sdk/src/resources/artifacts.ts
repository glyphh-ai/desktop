/**
 * resources/artifacts.ts — the member's artifacts (his direction, 2026-10-05:
 * artifacts like Claude's): publish, list by scope, read the bytes, rename or
 * share, delete; and the comment threads pinned on a page.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type {
  AddArtifactCommentInput, Artifact, ArtifactAccess, ArtifactComment, ArtifactScope, CreateArtifactInput, ShareArtifactResult, UpdateArtifactInput,
} from "../contract/artifacts.js";

const at = (id: string, tail = ""): string => `/api/artifacts/${encodeURIComponent(id)}${tail}`;

export class ArtifactCommentsClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The threads on an artifact: top-level comments with their replies nested. */
  list(artifactId: string): Promise<ArtifactComment[]> {
    return this.http.get<ArtifactComment[]>(at(artifactId, "/comments"));
  }

  add(artifactId: string, input: AddArtifactCommentInput): Promise<ArtifactComment> {
    return this.http.post<ArtifactComment>(at(artifactId, "/comments"), input);
  }

  /** Author or owner. */
  resolve(artifactId: string, commentId: string, resolved = true): Promise<ArtifactComment> {
    return this.http.patch<ArtifactComment>(at(artifactId, `/comments/${encodeURIComponent(commentId)}`), { resolved });
  }

  /** Author or owner. */
  remove(artifactId: string, commentId: string): Promise<void> {
    return this.http.del<void>(at(artifactId, `/comments/${encodeURIComponent(commentId)}`));
  }
}

export class ArtifactsClient {
  readonly comments: ArtifactCommentsClient;

  constructor(private readonly http: AuthedHttp) {
    this.comments = new ArtifactCommentsClient(http);
  }

  /** Newest first, 500 at most. `all` (the default) = mine + the org's shared. */
  list(scope: ArtifactScope = "all"): Promise<Artifact[]> {
    return this.http.get<Artifact[]>(`/api/artifacts?scope=${scope}`);
  }

  get(id: string): Promise<Artifact> {
    return this.http.get<Artifact>(at(id));
  }

  /** Publish: base64 `content` or UTF-8 `text`, 25 MB at most. The answer is private until shared. */
  create(input: CreateArtifactInput): Promise<Artifact> {
    return this.http.post<Artifact>("/api/artifacts", input);
  }

  /** The bytes, as stored. */
  content(id: string): Promise<ArrayBuffer> {
    return this.http.getBytes(at(id, "/content"));
  }

  /** Owner only, in place: a new name, access, mime or the bytes (base64 `content` or
   *  UTF-8 `text`) under the same id. `access: "public"` mints the share token; leaving public clears it. */
  update(id: string, input: UpdateArtifactInput): Promise<Artifact> {
    return this.http.put<Artifact>(at(id), input);
  }

  /** Owner only: the row and the bytes. */
  remove(id: string): Promise<void> {
    return this.http.del<void>(at(id));
  }

  /** The Share button: the access and the link to hand out (null unless public). */
  share(id: string, access: ArtifactAccess): Promise<ShareArtifactResult> {
    return this.http.post<ShareArtifactResult>(at(id, "/share"), { access });
  }
}
