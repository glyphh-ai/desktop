/**
 * Per-webContents capability grants for Glyphh apps. Both surfaces of an app —
 * the visible UI window and the hidden worker — get an entry here when they
 * start; the "glyphh-app:call" IPC handler consults it on every capability
 * call. Kept in its own module so glyphh-app-host.ts (IPC handler) and
 * glyphh-app-worker.ts (worker windows) can share it without importing each
 * other.
 */

export interface AppGrant {
  slug: string;
  name: string;
  caps: Set<string>;
  /** Connector app slugs (Pipedream) this app declared — the connector.*
   *  capabilities can only reach these. */
  connectors: Set<string>;
}

const grants = new Map<number, AppGrant>();

export function grantAppCaps(
  webContentsId: number,
  slug: string,
  name: string,
  caps: Iterable<string>,
  connectors: Iterable<string> = []
): void {
  grants.set(webContentsId, { slug, name, caps: new Set(caps), connectors: new Set(connectors) });
}

export function revokeAppCaps(webContentsId: number): void {
  grants.delete(webContentsId);
}

export function getAppGrant(webContentsId: number): AppGrant | undefined {
  return grants.get(webContentsId);
}
