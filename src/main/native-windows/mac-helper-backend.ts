/**
 * mac-helper-backend — Node client for glyphh-window-helper (the bundled
 * Swift binary in native/mac-window-helper). Spawns it once, speaks NDJSON
 * over stdio, and supervises restarts. Every call is an in-process AX/CG
 * operation on the helper side (~1-20ms) — this replaced per-call osascript
 * (~1-15s with the System Events full enumeration).
 *
 * Binary resolution: packaged → process.resourcesPath (electron-builder
 * extraResources); dev → native/mac-window-helper/build (scripts/
 * build-mac-helper.sh, wired into `npm run build`).
 */

import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable, Writable } from "stream";
import path from "path";
import fs from "fs";
import { app } from "electron";

export interface HelperWindow {
  id: string;       // "pid:cgWindowId"
  pid: number;
  proc: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HelperApp { proc: string; path: string; pid: number; }

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPAWNS = 3;          // within RESPAWN_WINDOW_MS
const RESPAWN_WINDOW_MS = 60_000;

let child: ChildProcessByStdio<Writable, Readable, null> | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let respawnTimes: number[] = [];

function helperPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "glyphh-window-helper");
  // dist/main/native-windows → repo root is three levels up.
  return path.join(__dirname, "..", "..", "..", "native", "mac-window-helper", "build", "glyphh-window-helper");
}

function failAllPending(err: Error): void {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); }
  pending.clear();
}

function ensureChild(): ChildProcessByStdio<Writable, Readable, null> | null {
  if (child && child.exitCode === null && !child.killed) return child;

  // Respawn backstop — if the helper is crash-looping, stop trying for a while.
  const now = Date.now();
  respawnTimes = respawnTimes.filter((t) => now - t < RESPAWN_WINDOW_MS);
  if (respawnTimes.length >= MAX_RESPAWNS) return null;
  respawnTimes.push(now);

  const bin = helperPath();
  if (!fs.existsSync(bin)) {
    console.error(`[mac-helper] binary missing at ${bin} — run scripts/build-mac-helper.sh`);
    return null;
  }

  const c = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
  child = c;

  let buf = "";
  c.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; ok?: boolean; data?: unknown; error?: string };
      try { msg = JSON.parse(line); } catch { continue; }
      const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
      if (!p) continue;
      pending.delete(msg.id as number);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error || "helper error"));
    }
  });

  c.on("error", (err) => {
    console.error("[mac-helper] spawn error:", err.message);
    if (child === c) child = null;
    failAllPending(err);
  });
  c.on("exit", (code) => {
    console.error(`[mac-helper] exited (${code}) — will respawn on next call`);
    if (child === c) child = null;
    failAllPending(new Error("window helper exited"));
  });

  return c;
}

function request<T>(cmd: string, params: Record<string, unknown> = {}): Promise<T> {
  const c = ensureChild();
  if (!c) return Promise.reject(new Error("window helper unavailable"));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`window helper timed out on ${cmd}`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    try {
      c.stdin.write(JSON.stringify({ id, cmd, ...params }) + "\n");
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ── public API ──────────────────────────────────────────────────────────

export function macHelperAvailable(): boolean {
  return process.platform === "darwin" && (fs.existsSync(helperPath()) || (child !== null && child.exitCode === null));
}

/** Pre-spawn the helper so the first window op doesn't pay startup. */
export function initMacHelper(): void {
  if (process.platform !== "darwin") return;
  ensureChild();
  void request("ping").catch(() => {});
}

export const macList = () => request<HelperWindow[]>("list");
export const macApps = () => request<HelperApp[]>("apps");
export const macFront = () => request<HelperWindow>("front");
export const macBounds = (items: Array<{ win: string; x: number; y: number; width: number; height: number }>) =>
  request<{ applied: number }>("bounds", { items });
export const macMinimizeWin = (win: string) => request<void>("minimize", { win });
export const macMinimizeWins = (wins: string[]) => request<{ minimized: number }>("minimizeWins", { wins });
export const macMinimizeAllWins = () => request<{ minimized: number }>("minimizeAll");
export const macFocusApp = (name: string) => request<{ pid: number }>("focusApp", { name });
export const macPerms = (prompt: boolean) => request<{ trusted: boolean }>("perms", { prompt });

export function disposeMacHelper(): void {
  if (child && child.exitCode === null) { try { child.kill(); } catch { /* ignore */ } }
  child = null;
  failAllPending(new Error("window helper disposed"));
}
