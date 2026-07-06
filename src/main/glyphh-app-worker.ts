/**
 * glyphh-app-worker — the headless runtime for Glyphh apps (spec v2).
 *
 * An app that declares `worker` in its manifest gets a hidden, sandboxed
 * BrowserWindow running its worker.js. The worker registers named handlers
 * via `glyphh.handle(name, fn)` (see glyphh-app-worker-preload.ts); the host
 * invokes them for MCP tool calls (tools[].handler) and cron firings. The
 * worker talks back to the host only through the same capability bridge the
 * UI window uses — same per-app allowlist, enforced in the main process.
 *
 * Lifecycle: lazy — a worker starts on its first invoke and stays up until
 * the app is reinstalled, it crashes (next invoke restarts it), or Glyphh
 * quits. Workers are never shown and never get Node access.
 */

import { BrowserWindow, ipcMain } from "electron";
import fs from "fs";
import path from "path";
import { grantAppCaps, revokeAppCaps } from "./glyphh-app-grants.js";

/** Everything needed to start an app's worker, derived from its saved-app row. */
export interface AppWorkerSpec {
  slug: string;
  name: string;
  /** Directory the .glyphh was extracted to (the entry html's dir). */
  appDir: string;
  /** Worker script path relative to appDir (manifest `worker`). */
  workerFile: string;
  capabilities: string[];
  /** Connector app slugs the manifest declared (manifest `connectors`). */
  connectors: string[];
}

interface WorkerHandle {
  win: BrowserWindow;
  ready: Promise<void>;
}

const workers = new Map<string, WorkerHandle>(); // slug → handle
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; wcId: number }>();
let callSeq = 0;
let ipcRegistered = false;

const INVOKE_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 10_000;

function registerWorkerIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.on("glyphh-app:invoke-result", (event, callId: string, outcome: { ok: boolean; result?: unknown; error?: string }) => {
    const p = pending.get(String(callId));
    if (!p || p.wcId !== event.sender.id) return; // stale or spoofed
    pending.delete(String(callId));
    clearTimeout(p.timer);
    if (outcome?.ok) p.resolve(outcome.result ?? null);
    else p.reject(new Error(outcome?.error || "handler failed"));
  });
}

/**
 * The worker loads a host-generated shell page, not app HTML: a strict CSP
 * (no network, no eval, same-dir scripts only) wrapping a single
 * `<script src="worker.js">`. Rewritten on every start so it always matches
 * the installed manifest.
 */
function writeWorkerShell(spec: AppWorkerSpec): string {
  const shellPath = path.join(spec.appDir, ".glyphh-worker.html");
  const src = spec.workerFile.replace(/"/g, "&quot;");
  fs.writeFileSync(
    shellPath,
    `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'">
<title>${spec.name.replace(/</g, "&lt;")} (worker)</title>
</head><body><script src="${src}"></script></body></html>`,
    "utf8"
  );
  return shellPath;
}

function startWorker(spec: AppWorkerSpec): WorkerHandle {
  registerWorkerIpc();
  const workerPath = path.join(spec.appDir, spec.workerFile);
  if (!fs.existsSync(workerPath)) throw new Error(`worker script missing: ${spec.workerFile} — re-install the app`);
  const shellPath = writeWorkerShell(spec);

  const win = new BrowserWindow({
    show: false,
    width: 0,
    height: 0,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "glyphh-app-worker-preload.js"),
    },
  });
  grantAppCaps(win.webContents.id, spec.slug, spec.name, spec.capabilities, spec.connectors);

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`worker for "${spec.slug}" did not become ready in ${READY_TIMEOUT_MS / 1000}s`));
    }, READY_TIMEOUT_MS);
    const onReady = (event: Electron.IpcMainEvent) => {
      if (event.sender.id !== win.webContents.id) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      ipcMain.removeListener("glyphh-app:worker-ready", onReady);
    };
    ipcMain.on("glyphh-app:worker-ready", onReady);
    win.webContents.on("render-process-gone", () => {
      cleanup();
      reject(new Error(`worker for "${spec.slug}" crashed during startup`));
    });
  });

  const dropIfCurrent = () => {
    if (workers.get(spec.slug)?.win === win) workers.delete(spec.slug);
    revokeAppCaps(win.webContents.id);
    for (const [id, p] of pending) {
      if (p.wcId === win.webContents.id) {
        pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error(`worker for "${spec.slug}" went away`));
      }
    }
  };
  win.on("closed", dropIfCurrent);
  win.webContents.on("render-process-gone", () => {
    dropIfCurrent();
    if (!win.isDestroyed()) win.destroy();
  });

  void win.loadFile(shellPath, { search: `app=${encodeURIComponent(spec.slug)}` });
  const handle: WorkerHandle = { win, ready };
  workers.set(spec.slug, handle);
  return handle;
}

/** Start (or reuse) the app's worker and wait until its handlers are registered. */
export async function ensureAppWorker(spec: AppWorkerSpec): Promise<WorkerHandle> {
  const existing = workers.get(spec.slug);
  if (existing && !existing.win.isDestroyed()) {
    await existing.ready;
    return existing;
  }
  const handle = startWorker(spec);
  await handle.ready;
  return handle;
}

/**
 * Invoke a named handler in the app's worker (starting it if needed) and
 * return the handler's result. This is the execution path for handler-backed
 * MCP tools and for cron firings.
 */
export async function invokeAppWorkerHandler(
  spec: AppWorkerSpec,
  handler: string,
  args: Record<string, unknown>,
  timeoutMs = INVOKE_TIMEOUT_MS
): Promise<unknown> {
  const { win } = await ensureAppWorker(spec);
  const callId = `c${++callSeq}`;
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(new Error(`handler "${handler}" timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    pending.set(callId, { resolve, reject, timer, wcId: win.webContents.id });
    win.webContents.send("glyphh-app:invoke", callId, handler, args || {});
  });
}

/** Stop an app's worker (reinstall/uninstall). Next invoke starts it fresh. */
export function stopAppWorker(slug: string): void {
  const handle = workers.get(slug);
  if (handle && !handle.win.isDestroyed()) handle.win.destroy();
  workers.delete(slug);
}

/** Destroy every running worker window (app shutdown) so the hidden windows
 *  don't keep window-all-closed from firing / the process from exiting. */
export function stopAllAppWorkers(): void {
  for (const [slug, handle] of workers) {
    if (!handle.win.isDestroyed()) handle.win.destroy();
    workers.delete(slug);
  }
}
