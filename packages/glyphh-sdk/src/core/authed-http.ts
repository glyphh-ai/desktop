/**
 * authed-http.ts — a thin wrapper that attaches the session bearer to each request,
 * so resource clients (org, members, …) don't repeat the token dance. `token()`
 * refreshes as needed and throws if signed out.
 *
 * 401 recovery: a locally-unexpired access token can still be DEAD server-side
 * (revoked family, sign-out elsewhere). Every call therefore retries exactly once
 * through `onUnauthorized` — a forced refresh. An unrecoverable refresh signs the
 * session out (the refresh manager clears the store and fires onSignedOut), so a
 * ghost "signed in but every call fails" state cannot persist.
 */

import type { HttpClient, RequestOptions } from "./http.js";
import { AuthError } from "./errors.js";
import type { TokenProvider } from "../auth/credential-provider.js";

export class AuthedHttp {
  constructor(
    private readonly http: HttpClient,
    private readonly token: TokenProvider,
    /** Forced-refresh hook for a 401 mid-call; absent for static API keys. */
    private readonly onUnauthorized?: () => Promise<string | null>,
  ) {}

  async #withAuth<T>(run: (bearer: string) => Promise<T>): Promise<T> {
    const bearer = await this.token();
    try {
      return await run(bearer);
    } catch (e) {
      if (e instanceof AuthError && this.onUnauthorized) {
        const fresh = await this.onUnauthorized();
        if (fresh) return run(fresh);
      }
      throw e;
    }
  }

  async get<T>(path: string): Promise<T> {
    return this.#withAuth((bearer) => this.http.get<T>(path, { bearer }));
  }
  /** A GET returning raw bytes (a file download) with the session bearer attached. */
  async getBytes(path: string): Promise<ArrayBuffer> {
    return this.#withAuth((bearer) => this.http.getBytes(path, { bearer }));
  }
  async post<T>(path: string, body?: unknown, opts: Omit<RequestOptions, "bearer"> = {}): Promise<T> {
    return this.#withAuth((bearer) => this.http.post<T>(path, body, { ...opts, bearer }));
  }
  /** POST raw bytes with an explicit content-type → JSON (audio upload / transcribe). */
  async postBinary<T>(path: string, bytes: Uint8Array, contentType: string): Promise<T> {
    return this.#withAuth((bearer) => this.http.postBinary<T>(path, bytes, contentType, { bearer }));
  }
  /** POST JSON and read the response as raw bytes (synthesized audio). */
  async postForBytes(path: string, body: unknown): Promise<ArrayBuffer> {
    return this.#withAuth((bearer) => this.http.postForBytes(path, body, { bearer }));
  }
  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.#withAuth((bearer) => this.http.patch<T>(path, body, { bearer }));
  }
  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.#withAuth((bearer) => this.http.put<T>(path, body, { bearer }));
  }
  /** A streaming POST with the session bearer attached. See HttpClient.stream. */
  async stream(path: string, body: unknown, opts: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
    return this.#withAuth((bearer) => this.http.stream(path, body, { ...opts, bearer }));
  }

  /** DELETE with the session bearer; `body` (optional) rides as JSON — a
   *  tombstone carries its LWW clock that way. */
  async del<T>(path: string, body?: unknown): Promise<T> {
    return this.#withAuth((bearer) => this.http.del<T>(path, body, { bearer }));
  }
}
