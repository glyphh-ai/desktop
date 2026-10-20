/**
 * router-server.ts — THE ROUTER ON LOOPBACK, for the CLIs on the gateway route.
 *
 * Our own loop calls the router in process (createRouterFetch); a CLI can only
 * be handed a base URL. So the first launch on the gateway route starts ONE
 * listener (@glyphh/sdk/router startRouterServer) on 127.0.0.1, and every CLI
 * on that route — the chat lane and the terminal alike — is pointed at it.
 * The router reads providers.ts per call, so a key or model saved in Settings
 * applies to the next request without a restart.
 *
 * Started lazily (a member who never takes the gateway never opens a port)
 * and closed on quit. Its token is per process: a CLI launched in an earlier
 * run of the app is not let back in.
 */

import { createRouterFetch, startRouterServer, type RouterServer } from "@glyphh/sdk/router";
import { routerConfig } from "./providers.js";

let server: RouterServer | null = null;
let starting: Promise<RouterServer> | null = null;

/** The listener's address and token, started on first ask. Concurrent asks
 *  share one start; a failed start is retried by the next ask. */
export async function routerEndpoint(): Promise<{ url: string; token: string }> {
  if (server) return { url: server.url, token: server.token };
  starting ??= startRouterServer(createRouterFetch(routerConfig))
    .then((s) => {
      server = s;
      console.warn("[router] listening", JSON.stringify({ url: s.url }));
      return s;
    })
    .finally(() => { starting = null; });
  const s = await starting;
  return { url: s.url, token: s.token };
}

/** Is the listener up (for a status read; never starts it)? */
export function routerServerRunning(): boolean {
  return server !== null;
}

/** Close the listener (app quit). Any CLI still pointed at it fails its next call. */
export async function stopRouterServer(): Promise<void> {
  const s = server ?? (starting ? await starting.catch(() => null) : null);
  server = null;
  if (s) await s.close().catch(() => undefined);
}
