/**
 * resources/files.ts — the FILES artifact store. `list` returns the caller's saved
 * artifacts (newest first, optionally narrowed to one session); `get` returns one with a
 * short-lived, browser-ready `downloadUrl`; `delete` removes the object + row. `create`
 * uploads on the user's behalf (base64) — included for completeness, but the primary
 * writer is the AGENT/RUNTIME, which saves server-side over the service token.
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type { FileArtifact, ListFilesQuery, CreateFileInput } from "../contract/files.js";

export class FilesClient {
  constructor(private readonly http: AuthedHttp) {}

  /** The caller's saved artifacts, newest first. Pass `{ sessionId }` to narrow to one session. */
  list(query: ListFilesQuery = {}): Promise<FileArtifact[]> {
    const qs = query.sessionId ? `?sessionId=${encodeURIComponent(query.sessionId)}` : "";
    return this.http.get<FileArtifact[]>(`/api/files${qs}`);
  }

  /** One artifact by id — metadata plus a short-lived `downloadUrl` a viewer can read directly. */
  get(id: string): Promise<FileArtifact> {
    return this.http.get<FileArtifact>(`/api/files/${encodeURIComponent(id)}`);
  }

  /** Save an artifact on the caller's behalf (the runtime is the primary writer). */
  create(input: CreateFileInput): Promise<FileArtifact> {
    return this.http.post<FileArtifact>("/api/files", input);
  }

  /** Delete an artifact (owner / org_admin): removes the stored object and the index row. */
  delete(id: string): Promise<void> {
    return this.http.del<void>(`/api/files/${encodeURIComponent(id)}`);
  }
}
