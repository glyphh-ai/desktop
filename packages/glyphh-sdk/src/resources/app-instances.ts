/**
 * resources/app-instances.ts — the installed apps (`/api/app-instances`).
 *
 * Two ways in: a BUILT bundle (`create` → PUT the zip to `upload.url` →
 * `ready`), or the SOURCE (`builds` → PUT the .tgz → `runBuild`, the platform
 * builds release n). Either way the instance ends up pinned to a release the
 * app server serves at `/app-host/<key>/ui/`; `releases` + `pin` roll back.
 * `invoke` runs one of the app's tools as the caller (what app_call_tool does).
 */

import type { AuthedHttp } from "../core/authed-http.js";
import type {
  AppInstance, AppRelease, AppUpload, AppInvokeResult, AppBuildResult,
  CreateAppInstanceInput, PatchAppInstanceInput,
} from "../contract/app-instances.js";

const enc = encodeURIComponent;

export class AppInstancesClient {
  constructor(private readonly http: AuthedHttp) {}

  /** Every instance the caller may open (the org's + their own personal ones). */
  list(): Promise<AppInstance[]> {
    return this.http.get<AppInstance[]>("/api/app-instances");
  }

  /** Register an instance for a BUILT bundle. Upload the zip to `upload.url`
   *  (PUT, application/zip), then call `ready`. */
  create(input: CreateAppInstanceInput): Promise<{ instance: AppInstance; upload: AppUpload }> {
    return this.http.post<{ instance: AppInstance; upload: AppUpload }>("/api/app-instances", input);
  }

  /** Install a public hub app as it is (the hub item's payload IS the bundle). */
  fromHub(itemId: string): Promise<AppInstance> {
    return this.http.post<AppInstance>("/api/app-instances/from-hub", { itemId });
  }

  /** The uploaded bundle is in place: the server records it as the next
   *  release, pins it, and reloads the app server. */
  ready(key: string, opts: { note?: string } = {}): Promise<AppInstance> {
    return this.http.post<AppInstance>(`/api/app-instances/${enc(key)}/ready`, opts.note ? { note: opts.note } : {});
  }

  /** The instance's releases, oldest first; `pinned` marks the live one. */
  releases(key: string): Promise<AppRelease[]> {
    return this.http.get<AppRelease[]>(`/api/app-instances/${enc(key)}/releases`);
  }

  /** Pin an existing release (rollback = pin n-1). */
  pin(key: string, n: number): Promise<AppInstance> {
    return this.http.post<AppInstance>(`/api/app-instances/${enc(key)}/pin`, { n });
  }

  /** Start a build from SOURCE: answers the build number and a presigned PUT
   *  for the project's .tgz (application/gzip). Then `runBuild`. */
  builds(key: string): Promise<{ build: { n: number }; upload: AppUpload }> {
    return this.http.post<{ build: { n: number }; upload: AppUpload }>(`/api/app-instances/${enc(key)}/builds`, {});
  }

  /** Build source n into the next release (the platform runs npm ci + next
   *  build + the worker bundler; waits up to 10 min). */
  runBuild(key: string, n: number, opts: { note?: string } = {}): Promise<AppBuildResult> {
    return this.http.post<AppBuildResult>(`/api/app-instances/${enc(key)}/builds/${enc(String(n))}/run`, opts.note ? { note: opts.note } : {});
  }

  /** Run one of the app's tools as the caller. */
  invoke(key: string, tool: string, args: Record<string, unknown> = {}): Promise<AppInvokeResult> {
    return this.http.post<AppInvokeResult>(`/api/app-instances/${enc(key)}/invoke`, { tool, args });
  }

  /** Access, members, public, the shared org connection, config vars, the embedding model. */
  patch(key: string, input: PatchAppInstanceInput): Promise<AppInstance> {
    return this.http.patch<AppInstance>(`/api/app-instances/${enc(key)}`, input);
  }

  /** Remove the instance (tombstone; its releases stay in R2). */
  remove(key: string): Promise<void> {
    return this.http.del<void>(`/api/app-instances/${enc(key)}`);
  }
}
