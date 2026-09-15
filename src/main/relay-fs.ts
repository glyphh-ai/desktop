/**
 * relay-fs.ts — the WEB workbench's filesystem, served by THIS attached
 * desktop over the attach relay (the same transport the web terminal's
 * relay-pty rides).
 *
 * The web Files tree / Diff / Monaco panels have no local machine; their
 * window.wb (web/src/wb-relay.js) dispatches these methods to the user's own
 * attached desktop:
 *
 *   fs.cwd     {}               → { cwd, explicit }  the machine's working folder
 *   fs.listDir {dir}            → { entries, error? }   the file tree's lazy listing
 *   fs.read    {path}           → { content, error? }
 *   fs.write   {path, content}  → { ok, error? }
 *   fs.gitDiff {root}           → { text, error? }
 *   fs.search  {dir, query}     → { entries, truncated?, error? }
 *   fs.watch   {channel}        → forward the debounced workdir watcher's
 *                                 events upstream as pushes on `channel`:
 *                                 {type:"fs-changed",path} / {type:"git-changed"}
 *                                 / {type:"cwd-changed",cwd}
 *   fs.unwatch {channel}        → stop forwarding on that channel
 *
 * (`fs.gitInfo` already exists on the registry — attach-handlers.ts registers
 * it for the web folder picker with a shape the workbench can consume, so it
 * is deliberately NOT re-registered here. Same for `fs.list`/`fs.mkdir`, the
 * picker's home-capped browse surface — different semantics, not clobbered.)
 *
 * Every implementation is the EXACT function the desktop's files:* IPC
 * handlers call (working-directory.ts) — one behavior, two transports.
 *
 * SECURITY — the relay is owner-scoped (the server only dispatches to the
 * signed-in user's own machine), but every path is still validated and
 * contained to the current working-directory tree: the web workbench operates
 * on the working folder and nothing else on this machine is its business.
 *
 * Lifecycle mirrors relay-pty: watches die with the attach socket
 * (onAttachDown), and pushes are dropped when the socket is down.
 */

import path from "path";
import { registerRelayHandler } from "./relay-client.js";
import { pushToAttach, onAttachDown } from "./attach-client.js";
import {
  getWorkingDirectory,
  getExplicitWorkingDirectory,
  listWorkdirDir,
  searchWorkdirFiles,
  readWorkdirFile,
  writeWorkdirFile,
  gitDiffWorkdir,
  onWorkdirEvent,
  type WorkdirEvent,
} from "./working-directory.js";
import { r2DiffWorkdir, appDirInWorkdir } from "./glyphh-app-builder.js";

/** Watch channels a browser bug must not grow unboundedly. */
const MAX_WATCH_CHANNELS = 8;
/** Push payload cap on fs.write — matches the read cap's order of magnitude. */
const MAX_WRITE_BYTES = 2_000_000;

/** Live watch channels — pushes fan out to each. */
const watchChannels = new Set<string>();
let workdirUnsubscribe: (() => void) | null = null;

function forwardEvent(ev: WorkdirEvent): void {
  if (watchChannels.size === 0) return;
  const data =
    ev.type === "file-changed" ? { type: "fs-changed", path: ev.path } :
    ev.type === "git-changed" ? { type: "git-changed" } :
    { type: "cwd-changed", cwd: ev.cwd };
  for (const channel of watchChannels) pushToAttach(channel, data);
}

function ensureSubscribed(): void {
  if (workdirUnsubscribe) return;
  workdirUnsubscribe = onWorkdirEvent(forwardEvent);
}

/** Drop every watch — the attach socket died or the app is quitting. */
export function clearAllRelayFsWatches(): void {
  watchChannels.clear();
  if (workdirUnsubscribe) { workdirUnsubscribe(); workdirUnsubscribe = null; }
}

/** A required string param, validated. */
function str(params: unknown, key: string): string {
  const v = (params as Record<string, unknown> | null)?.[key];
  if (typeof v !== "string" || !v) throw new Error(`fs.* requires a string { ${key} }`);
  return v;
}

/**
 * Resolve a caller path and require it inside the CURRENT working-directory
 * tree (the root itself included). The relay serves the working folder the
 * user is visibly working in — nothing else on the machine.
 */
function containedPath(params: unknown, key: string): string {
  const p = str(params, key);
  const root = path.resolve(getWorkingDirectory());
  const abs = path.resolve(p);
  const rel = path.relative(root, abs);
  if (rel.split(path.sep)[0] === ".." || path.isAbsolute(rel)) {
    throw new Error("path is outside the working folder");
  }
  return abs;
}

/** Register the fs relay methods + the socket-down sweep. Call once at boot. */
export function installRelayFs(): void {
  onAttachDown(clearAllRelayFsWatches);

  registerRelayHandler("fs.cwd", () => ({
    cwd: getWorkingDirectory(),
    explicit: getExplicitWorkingDirectory(),
  }));

  registerRelayHandler("fs.listDir", (params) => listWorkdirDir(containedPath(params, "dir")));

  registerRelayHandler("fs.read", (params) => readWorkdirFile(containedPath(params, "path")));

  registerRelayHandler("fs.write", (params) => {
    const abs = containedPath(params, "path");
    const content = (params as Record<string, unknown> | null)?.content;
    if (typeof content !== "string") throw new Error("fs.write requires a string { content }");
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      throw new Error("fs.write content too large");
    }
    return writeWorkdirFile(abs, content);
  });

  registerRelayHandler("fs.gitDiff", (params) => gitDiffWorkdir(containedPath(params, "root")));
  // The R2 lane twin (web = desktop tooling): drift + history + head→local diff.
  registerRelayHandler("fs.r2Diff", (params) => r2DiffWorkdir(appDirInWorkdir(containedPath(params, "root"))));

  registerRelayHandler("fs.search", (params) => {
    const dir = containedPath(params, "dir");
    const query = (params as Record<string, unknown> | null)?.query;
    if (typeof query !== "string") throw new Error("fs.search requires a string { query }");
    return searchWorkdirFiles(dir, query.slice(0, 200));
  });

  registerRelayHandler("fs.watch", (params) => {
    const channel = str(params, "channel");
    if (!/^[\w.:-]{1,80}$/.test(channel)) throw new Error("fs.watch channel must be a short token");
    if (!watchChannels.has(channel) && watchChannels.size >= MAX_WATCH_CHANNELS) {
      throw new Error(`fs.watch limit reached (${MAX_WATCH_CHANNELS})`);
    }
    watchChannels.add(channel);
    ensureSubscribed();
    // The current folder travels with the ack so the web can point its panels
    // without a second round trip.
    return { watching: true, cwd: getWorkingDirectory() };
  });

  // Idempotent — the web page may unwatch after the attach socket already
  // swept everything.
  registerRelayHandler("fs.unwatch", (params) => {
    const channel = str(params, "channel");
    const had = watchChannels.delete(channel);
    if (watchChannels.size === 0 && workdirUnsubscribe) {
      workdirUnsubscribe();
      workdirUnsubscribe = null;
    }
    return { watching: false, had };
  });
}
