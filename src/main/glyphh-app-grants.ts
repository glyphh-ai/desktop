/**
 * Per-webContents capability grants for Glyphh apps. An app's visible UI
 * window/preview gets an entry here when it starts; the "glyphh-app:call"
 * IPC handler consults it on every capability call. (Hidden local worker
 * windows are gone — app workers run on the cloud runtime.)
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
