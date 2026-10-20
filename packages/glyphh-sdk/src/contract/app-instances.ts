/**
 * contract/app-instances.ts — an installed Glyphh app: ONE row per instance
 * key (`<slug>` for the org's, `<slug>~<user>` for a personal one), served by
 * the always-on app server from versioned releases in R2. Releases ARE the
 * versioning: `n` climbs per key, `release` is the pinned one, `pin` rolls
 * back. Builds take the SOURCE (a .tgz of the Next.js project) and the
 * platform builds release n from it.
 */

export type AppInstanceKind = "org" | "personal";
export type AppInstanceAccess = "everyone" | "restricted";
export type AppInstanceStatus = "pending" | "ready" | "error";

/** The manifest fields the server keeps on the row. */
export interface AppInstanceManifest {
  name: string;
  tools: Array<{ name: string; description?: string; handler?: string; capability?: string; inputSchema?: unknown }>;
  capabilities: string[];
  connectors: string[];
}

export interface AppInstance {
  key: string;
  slug: string;
  kind: AppInstanceKind;
  access: AppInstanceAccess;
  public: boolean;
  status: AppInstanceStatus;
  members: string[];
  orgConnectionId: string | null;
  bundle: { sha256: string; sizeBytes: number };
  manifest: AppInstanceManifest;
  /** The pinned release number; null = nothing deployed yet. */
  release?: number | null;
  /** `/app-host/<key>/` — the panel loads `ui/` under it. */
  url: string;
}

/** One built release of an instance (newest last in the server's list). */
export interface AppRelease {
  n: number;
  sha256: string;
  sizeBytes: number;
  note: string;
  at: string;
  by: string | null;
  pinned: boolean;
}

/** A presigned PUT: the caller uploads the bytes straight to R2. */
export interface AppUpload {
  url: string;
  key: string;
}

export interface CreateAppInstanceInput {
  slug: string;
  kind: AppInstanceKind;
  /** The BUILT bundle about to be uploaded. */
  bundle: { sha256: string; sizeBytes: number };
  /** The bundle's manifest.json, parsed. */
  manifest: Record<string, unknown>;
}

export interface PatchAppInstanceInput {
  access?: AppInstanceAccess;
  members?: string[];
  public?: boolean;
  /** A shared org connection id; null revokes it. */
  orgConnectionId?: string | null;
  /** Config vars: merge; a null value deletes the key. */
  secrets?: Record<string, string | null>;
  /** null = the org's default embedding model. */
  embedModel?: string | null;
}

export interface AppInvokeResult {
  ok: boolean;
  tool?: string;
  result?: unknown;
  error?: string;
}

/** The answer to running a build: the release it made and the build log tail. */
export interface AppBuildResult {
  release: AppRelease;
  log: string;
}
