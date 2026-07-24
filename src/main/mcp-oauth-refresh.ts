/**
 * mcp-oauth-refresh.ts — keep OAuth-authed remote MCP connections alive.
 *
 * Desktop's remote MCP runs SERVER-SIDE: yo-server dials the endpoint using a
 * bearer header we hand it at create time. That header is static, so an OAuth
 * access token would lapse and the server would start getting 401s (tools
 * vanish) — and the app never sees that 401 to react to it. So the APP keeps the
 * token ahead of expiry: on a timer it refreshes any connection whose token is
 * near expiry (via the encrypted mcp-oauth store) and re-stamps the server
 * connection's `Authorization` header. Connections with no stored OAuth token
 * (static-header or unauthenticated servers) are left untouched.
 */

import { hasStoredAuth, refreshBearerIfExpiring } from "./mcp-oauth.js";
import { getClient } from "./glyphh-client.js";

const INTERVAL_MS = 3 * 60_000;    // check every 3 min
const EXPIRING_WINDOW_MS = 10 * 60_000; // refresh when <10 min of validity is left

/** The last Authorization value pushed per slug — so we only PATCH the server
 *  when the token actually rotated, not on every tick. */
const lastPushed = new Map<string, string>();
let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  let conns: Array<{ slug: string; url: string }>;
  try {
    conns = await getClient().connections.personalMcpList();
  } catch {
    return; // offline / signed out — nothing to do this round
  }
  for (const c of conns) {
    if (!c.url || !hasStoredAuth(c.url)) continue; // only OAuth-managed endpoints
    let header: Record<string, string> | null;
    try {
      header = await refreshBearerIfExpiring(c.url, EXPIRING_WINDOW_MS);
    } catch {
      continue;
    }
    if (!header?.Authorization) continue; // refresh failed → needs interactive re-auth
    if (lastPushed.get(c.slug) === header.Authorization) continue; // unchanged
    try {
      await getClient().connections.personalMcpUpdate(c.slug, { headers: { Authorization: header.Authorization } });
      lastPushed.set(c.slug, header.Authorization);
    } catch (err) {
      console.warn(`[mcp-oauth] couldn't push a refreshed token for "${c.slug}":`, err);
    }
  }
}

/** Start the background refresh loop (idempotent). Runs once now, then on a timer. */
export function startMcpOAuthRefresh(): void {
  if (timer) return;
  void tick();
  timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref?.();
}

export function stopMcpOAuthRefresh(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
