/**
 * Local handler registry — the in-process method table the loopback local-MCP
 * server dispatches into.
 *
 * This used to also own a persistent WebSocket to yo-server's /ws/relay so the
 * cloud could drive this machine (external MCP callers, the app-proxy tunnel).
 * That reach-in was REMOVED — nothing dials into a personal machine anymore.
 * What survives is the registry itself: Glyphh and the loopback local-MCP
 * server both invoke these handlers on-machine, and it is the seed of the
 * future client↔runtime "attach" protocol (same shapes, over loopback).
 */

type Handler = (params: unknown) => Promise<unknown> | unknown;

const handlers = new Map<string, Handler>();

/** Register a handler for a method (idempotent — last write wins). */
export function registerRelayHandler(method: string, handler: Handler): void {
  handlers.set(method, handler);
}

/** Every registered method name — the attach client's `hello` capability list. */
export function listRelayMethods(): string[] {
  return [...handlers.keys()];
}

async function dispatch(method: string, params: unknown): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const handler = handlers.get(method);
  if (!handler) return { ok: false, error: `unknown method: ${method}` };
  try {
    const result = await handler(params);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Invoke a registered handler directly. The loopback local MCP server uses this
 * so every panels / apps / layouts tool behaves identically on-machine. Throws
 * on an unknown method or a handler error.
 */
export async function dispatchRelayMethod(method: string, params: unknown): Promise<unknown> {
  const out = await dispatch(method, params);
  if (!out.ok) throw new Error(out.error);
  return out.result;
}

// ── Local push bus ───────────────────────────────────────────────────────────
// THE PURGE: nothing streams off-machine. pty/fs/panel output that used to ride
// the attach socket lands HERE; the workbench (or the CLI workpanel host)
// subscribes to render it.
type PushListener = (channel: string, data: unknown) => void;
const pushListeners = new Set<PushListener>();

/** Subscribe to pushed frames (pty output, fs watch events, panel frames). */
export function onLocalPush(fn: PushListener): () => void {
  pushListeners.add(fn);
  return () => pushListeners.delete(fn);
}

/** Push a frame to every local subscriber. Replaces the dead pushToAttach. */
export function pushLocal(channel: string, data: unknown): void {
  for (const fn of pushListeners) {
    try { fn(channel, data); } catch { /* a listener's failure is its own */ }
  }
}
