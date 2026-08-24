/**
 * Preload for Glyphh app WORKERS — the headless surface of an installed app
 * (GLYPHH-APP-SPEC §worker). A worker is the app's `worker.js` running in a
 * hidden, sandboxed window: no DOM anyone sees, no Node, just the SDK below.
 *
 *   glyphh.call(method, args)     — same capability bridge the UI gets
 *   glyphh.handle(name, fn)       — register a named handler; the host invokes
 *                                   it for MCP tool calls and cron firings
 *   glyphh.app                    — { slug } identity, informational
 *
 * The host waits for "worker-ready" (fired after the script's top-level code
 * ran, so all synchronous handle() registrations are in) before invoking.
 */

import { contextBridge, ipcRenderer } from "electron";

// src/main compiles without the DOM lib (preloads are the only renderer-side
// code here) — declare just the two page globals this preload touches.
declare const window: { addEventListener(type: string, listener: () => void): void };
declare const location: { search: string };

type HandlerFn = (args: Record<string, unknown>) => unknown | Promise<unknown>;

const handlers = new Map<string, HandlerFn>();

ipcRenderer.on("glyphh-app:invoke", async (_event, callId: string, name: string, args: unknown) => {
  const fn = handlers.get(String(name));
  if (!fn) {
    ipcRenderer.send("glyphh-app:invoke-result", callId, { ok: false, error: `no handler registered: ${name}` });
    return;
  }
  try {
    const result = await fn((args || {}) as Record<string, unknown>);
    ipcRenderer.send("glyphh-app:invoke-result", callId, { ok: true, result: result ?? null });
  } catch (err) {
    ipcRenderer.send("glyphh-app:invoke-result", callId, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

window.addEventListener("load", () => {
  // After `load`, the worker script's top-level code (and its synchronous
  // glyphh.handle() calls) has run — safe for the host to start invoking.
  ipcRenderer.send("glyphh-app:worker-ready");
});

contextBridge.exposeInMainWorld("glyphh", {
  call: (method: string, args?: unknown) =>
    ipcRenderer.invoke("glyphh-app:call", method, args) as Promise<
      { ok: true; result: unknown } | { ok: false; error: string }
    >,
  handle: (name: string, fn: HandlerFn) => {
    if (typeof name !== "string" || !name.trim()) throw new Error("handler name is required");
    if (typeof fn !== "function") throw new Error("handler must be a function");
    handlers.set(name.trim(), fn);
  },
  app: { slug: new URLSearchParams(location.search).get("app") || "" },
});
