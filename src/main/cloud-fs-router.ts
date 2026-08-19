/**
 * Cloud-session filesystem router — the desktop half of the pod-fs seam.
 *
 * When the composer's active session is a CLOUD session (source.kind !==
 * "local"), the workpanel filesystem must show the POD's workspace, not this
 * Mac. The web app already does this (wb-pod.js → harnessViaApi → server
 * /api/harness/fs/* → rrotor fs-routes); this module is the desktop mirror,
 * living in the main process so the renderer's files:* IPC surface stays
 * byte-identical — working-directory.ts branches here per call.
 *
 * Locus: derived from the SAME seam the web uses — every session save/load
 * (glyphh-agent-sessions-save) flows through noteSessionsSnapshot(). The
 * scope sent to the pod is the renderer chat id, matching remote-run.ts's
 * threadId, so panels browse exactly where the session's turns execute.
 *
 * Change events: the pod side is a polled cursor (fsEvents, 2s); this module
 * translates pages into the push channels the panels already listen to
 * (workdir:file-changed / workdir:git-changed / working-dir-changed).
 */

import type { BrowserWindow } from "electron";
import { getClient } from "./glyphh-client";
import type { StoredChat } from "./glyphh-agent-context";

type Broadcast = (channel: string, ...args: unknown[]) => void;

let getMainWindow: () => BrowserWindow | null = () => null;
let broadcastToPanels: Broadcast = () => {};
let getLocalCwd: () => string = () => "";

// ── Locus ────────────────────────────────────────────────────────────────
let cloud = false;
let chatId = "";

/** Workspace root per scope — one fsInfo round-trip each, then cached. */
const roots = new Map<string, string>();

function harness() {
  return getClient().harnessViaApi();
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendAll(channel: string, ...args: unknown[]): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  broadcastToPanels(channel, ...args);
}

export function cloudFsActive(): boolean {
  return cloud;
}

/** The pod workspace root for the active cloud session. Throws when the
 *  runtime is unreachable — callers pick their own fallback. */
export async function cloudRoot(): Promise<string> {
  const scope = chatId;
  const hit = roots.get(scope);
  if (hit) return hit;
  const info = await harness().fsInfo({ scope });
  roots.set(scope, info.root);
  return info.root;
}

/** cloudRoot with a local fallback — for the working-dir:get surface, which
 *  must always answer with SOME path even when the runtime is offline. */
export async function cloudRootOr(fallback: string): Promise<string> {
  try { return await cloudRoot(); } catch { return fallback; }
}

/** The locus decision — the exact rule the web uses (wb-pod.js
 *  noteSessionsSnapshot): the current chat's source absent or "local" means
 *  this machine; anything else means the pod. Called on every session
 *  save/load, so switches, births, and source binds all flow through. */
export function noteSessionsSnapshot(chats: StoredChat[], currentId: string): void {
  const c = chats.find((x) => x.id === currentId);
  const nextCloud = !!(c && c.source && c.source.kind !== "local");
  const nextId = nextCloud ? currentId : "";
  if (nextCloud === cloud && nextId === chatId) return;
  cloud = nextCloud;
  chatId = nextId;
  restartPoll();
  // Re-root every open panel in place — the same synthetic cwd-change the
  // web selector emits on a locus flip. On a runtime error we stay quiet;
  // the next listDir surfaces the failure in the tree itself.
  void (async () => {
    try {
      sendAll("working-dir-changed", cloud ? await cloudRoot() : getLocalCwd());
    } catch { /* runtime offline — panels keep their root, ops report errors */ }
  })();
}

// ── Event poll (pod cursor → desktop push channels) ──────────────────────
const POLL_MS = 2000;
const RETRY_MS = 6000;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollScope = "";
let cursor = -1;

function restartPoll(): void {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  cursor = -1;
  pollScope = chatId;
  if (cloud) pollTimer = setTimeout(() => void poll(), POLL_MS);
}

async function poll(): Promise<void> {
  if (!cloud || chatId !== pollScope) return;
  try {
    const page = await harness().fsEvents({ from: cursor, scope: pollScope });
    if (!cloud || chatId !== pollScope) return; // flipped mid-flight
    cursor = page.seq;
    const prevRoot = roots.get(pollScope);
    if (page.root && page.root !== prevRoot) {
      roots.set(pollScope, page.root);
      if (prevRoot) sendAll("working-dir-changed", page.root);
    }
    for (const ev of page.events ?? []) {
      if (ev.type === "file-changed" && ev.path) sendAll("workdir:file-changed", ev.path);
      else if (ev.type === "git-changed") sendAll("workdir:git-changed");
    }
    pollTimer = setTimeout(() => void poll(), POLL_MS);
  } catch {
    if (cloud && chatId === pollScope) pollTimer = setTimeout(() => void poll(), RETRY_MS);
  }
}

// ── Operations — same shapes as working-directory.ts's local impls ───────

export async function cloudListDir(dir: string): Promise<{ entries: Array<{ name: string; path: string; kind: "dir" | "file" }>; error?: string }> {
  try {
    const r = await harness().fsList({ ...(dir ? { dir } : {}), scope: chatId });
    return { entries: r.entries ?? [], ...(r.error ? { error: r.error } : {}) };
  } catch (err) {
    return { entries: [], error: msg(err) };
  }
}

export async function cloudSearch(query: string): Promise<{ entries: Array<{ name: string; rel: string; path: string; kind: "dir" | "file" }>; truncated?: boolean; error?: string }> {
  try {
    const r = await harness().fsSearch({ query: String(query ?? ""), scope: chatId });
    return { entries: r.entries ?? [], ...(r.truncated ? { truncated: true } : {}), ...(r.error ? { error: r.error } : {}) };
  } catch (err) {
    return { entries: [], error: msg(err) };
  }
}

export async function cloudReadFile(path: string): Promise<{ content: string; error?: string }> {
  try {
    const r = await harness().fsRead({ path, scope: chatId });
    return { content: r.content ?? "", ...(r.error ? { error: r.error } : {}) };
  } catch (err) {
    return { content: "", error: msg(err) };
  }
}

export async function cloudWriteFile(path: string, content: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await harness().fsWrite({ path, content: typeof content === "string" ? content : "", scope: chatId });
    return { ok: !!r.ok, ...(r.error ? { error: r.error } : {}) };
  } catch (err) {
    return { ok: false, error: msg(err) };
  }
}

export async function cloudGitInfo(): Promise<{ isRepo: boolean; branch?: string }> {
  try {
    const info = await harness().fsInfo({ scope: chatId });
    roots.set(chatId, info.root);
    return { isRepo: !!info.isRepo, ...(info.branch ? { branch: info.branch } : {}) };
  } catch {
    return { isRepo: false };
  }
}

export async function cloudGitDiff(): Promise<{ text: string; error?: string }> {
  try {
    const r = await harness().fsDiff({ scope: chatId });
    return { text: r.text ?? "", ...(r.error ? { error: r.error } : {}) };
  } catch (err) {
    return { text: "", error: msg(err) };
  }
}

/** mkdir/delete/rename/preview have no pod-side routes yet — same honest
 *  refusal the web transport returns, never a silent local-disk fallback. */
export const CLOUD_FS_UNSUPPORTED = "Not available for cloud workspaces yet";

export function initCloudFsRouter(deps: {
  getMainWindow: () => BrowserWindow | null;
  broadcastToPanels: Broadcast;
  getLocalCwd: () => string;
}): void {
  getMainWindow = deps.getMainWindow;
  broadcastToPanels = deps.broadcastToPanels;
  getLocalCwd = deps.getLocalCwd;
}
