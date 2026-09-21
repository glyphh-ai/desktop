/**
 * attach-host.ts — this machine's OUTBOUND socket to the server (RELAY-RESEARCH.md
 * §4): one authenticated WebSocket the server dispatches method calls down and
 * we push frames up. Nothing dials in. The SDK's attach host does the wire;
 * this file binds it to the app: the signed-in client, the capability
 * registry, the local push bus, and the pty teardown when the socket drops.
 *
 * Starts on sign-in, stops on sign-out (auth.ts). Re-advertises the table
 * once main.ts has installed every handler (refreshHello), so the first hello
 * never lists a partial method table.
 */

import { hostname } from "node:os";
import { app } from "electron";
import { startAttachHost, type AttachHost } from "@glyphh/sdk/runtime";
import { getClient, SERVER_URL } from "./glyphh-client.js";
import { dispatchRelayMethod, listRelayMethods, onLocalPush } from "./relay-client.js";
import { killAllRelayPtys } from "./relay-pty.js";

let host: AttachHost | null = null;
let unsubscribePush: (() => void) | null = null;

/** The registry as a live handler table: read on every hello. */
function table(): Record<string, (params: unknown) => Promise<unknown>> {
  return Object.fromEntries(listRelayMethods().map((m) => [m, (params: unknown) => dispatchRelayMethod(m, params)]));
}

export function startAttach(): void {
  if (host) return;
  host = startAttachHost({
    client: getClient(),
    server: SERVER_URL,
    app: "glyphh-desktop",
    version: app.getVersion(),
    name: hostname(),
    handlers: table,
    // A dropped socket kills the relayed shells: nothing buffers forever for a
    // web terminal that is gone.
    onDown: () => { try { killAllRelayPtys(); } catch { /* none open */ } },
  });
  // fs watchers and ptys push on the local bus; the socket carries the same frames.
  unsubscribePush = onLocalPush((channel, data) => { host?.push(channel, data); });
  console.info("[attach] host started", { server: SERVER_URL });
}

export function stopAttach(): void {
  unsubscribePush?.();
  unsubscribePush = null;
  host?.stop();
  host = null;
  console.info("[attach] host stopped");
}

/** Send a frame up the socket; false (and dropped) while it is down. */
export function pushToAttach(channel: string, data: unknown): boolean {
  return host?.push(channel, data) ?? false;
}

/** Re-advertise the capability table after handlers were installed. */
export function attachRefreshHello(): void {
  host?.refreshHello();
}

export function attachStatus(): { attached: boolean; server: string } {
  return { attached: host?.attached() ?? false, server: SERVER_URL };
}
