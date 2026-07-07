/**
 * glyphh-app-fs — brokered filesystem access for installed Glyphh apps.
 *
 * Filesystem is NEVER ambient. An app that declares fs.read/fs.write/fs.pick
 * gets NOTHING until the user points it at a location via fs.pick (an OS
 * dialog). Each pick records an allowed ROOT — a file or a directory subtree —
 * with a read/readwrite mode, persisted per-app on THIS machine. fs.read /
 * fs.write then succeed only for real paths that resolve UNDER a granted root
 * (realpath defeats `..` and symlink escape), never for a hard deny-list of
 * sensitive locations (even under a granted parent), and only within size caps.
 *
 * Roots live device-locally (a picked folder is machine-specific) at
 * ~/.glyphh/app-fs-grants.json. fs.pick is interactive-only: a headless worker
 * or a remote MCP caller has no window for the dialog, so it can only reuse
 * roots the owner already granted at the machine.
 */

import { BrowserWindow, dialog, WebContents } from "electron";
import fs from "fs";
import os from "os";
import path from "path";
import { glyphhPath, GLYPHH_DIR } from "./app-paths.js";

export type FsMode = "read" | "readwrite";
export interface FsRoot { path: string; mode: FsMode }

const grantsFile = () => glyphhPath("app-fs-grants.json");
const MAX_READ_BYTES = 25 * 1024 * 1024;
const MAX_WRITE_BYTES = 25 * 1024 * 1024;

/** Locations an app may NEVER touch, even under a granted parent (defense in
 *  depth if the user grants a broad root like their home dir). */
function denyRoots(): string[] {
  const home = os.homedir();
  return [
    GLYPHH_DIR,                                                   // all app data + encrypted secrets
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".config", "gcloud"),
    path.join(home, "Library", "Keychains"),
    path.join(home, "Library", "Application Support", "Google", "Chrome"),
    path.join(home, "Library", "Application Support", "Firefox"),
    path.join(home, "Library", "Application Support", "com.apple.TCC"),
  ];
}

// ── persistence ──────────────────────────────────────────────
function readAll(): Record<string, FsRoot[]> {
  try {
    const obj = JSON.parse(fs.readFileSync(grantsFile(), "utf8"));
    return obj && typeof obj === "object" ? obj : {};
  } catch { return {}; }
}
function writeAll(all: Record<string, FsRoot[]>): void {
  try {
    fs.mkdirSync(path.dirname(grantsFile()), { recursive: true });
    fs.writeFileSync(grantsFile(), JSON.stringify(all, null, 2), "utf8");
  } catch (err) {
    console.error("[glyphh-app-fs] persist failed:", err instanceof Error ? err.message : err);
  }
}

export function listFsRoots(slug: string): FsRoot[] {
  const r = readAll()[slug];
  return Array.isArray(r) ? r.filter((x) => x && typeof x.path === "string") : [];
}
function saveFsRoots(slug: string, roots: FsRoot[]): void {
  const all = readAll();
  all[slug] = roots;
  writeAll(all);
}
export function removeFsRoot(slug: string, target: string): void {
  saveFsRoots(slug, listFsRoots(slug).filter((r) => r.path !== target));
}
function addFsRoot(slug: string, root: FsRoot): void {
  const roots = listFsRoots(slug).filter((r) => r.path !== root.path);
  roots.push(root);
  saveFsRoots(slug, roots);
}

// ── path safety ──────────────────────────────────────────────
/** Realpath the deepest EXISTING ancestor, then re-append the missing tail, so
 *  a not-yet-created write target validates while symlinks in the existing
 *  prefix are still resolved. */
function realParent(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const realBase = fs.realpathSync(cur);
  return tail.length ? path.join(realBase, ...tail) : realBase;
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolve a requested path to a safe absolute path under a granted root, or
 *  throw. `needWrite` requires a readwrite root. */
function resolveSafe(slug: string, requested: unknown, needWrite: boolean): string {
  const req = String(requested || "");
  if (!req) throw new Error("path is required");
  const real = realParent(req);

  for (const d of denyRoots()) {
    let realDeny: string;
    try { realDeny = fs.realpathSync(d); } catch { realDeny = d; }
    if (isUnder(real, realDeny)) throw new Error(`"${req}" is in a protected location and can't be accessed`);
  }

  const ok = listFsRoots(slug).some((r) => {
    let realRoot: string;
    try { realRoot = fs.realpathSync(r.path); } catch { return false; } // stale/removed root
    return isUnder(real, realRoot) && (!needWrite || r.mode === "readwrite");
  });
  if (!ok) {
    throw new Error(needWrite
      ? `no write access to "${req}" — the user must grant a writable folder via fs.pick`
      : `no access to "${req}" — the user must grant it via fs.pick`);
  }
  return real;
}

// ── capabilities ─────────────────────────────────────────────
/** fs.pick — interactive OS dialog; records the picked path as an allowed root.
 *  Interactive-only: throws without a real parent window (worker / relay). */
export async function fsPick(senderWc: WebContents | undefined, args: Record<string, unknown>, slug: string): Promise<{ path: string; mode: FsMode } | { canceled: true }> {
  const parent = senderWc ? BrowserWindow.fromWebContents(senderWc) : null;
  if (!parent) throw new Error("fs.pick requires an interactive app window");
  const wantDir = args.mode === "dir" || args.mode === "directory";
  const wantWrite = args.write === true;
  const result = await dialog.showOpenDialog(parent, {
    title: wantDir ? "Choose a folder to share with this app" : "Choose a file to share with this app",
    properties: [wantDir ? "openDirectory" : "openFile"] as Array<"openDirectory" | "openFile">,
    buttonLabel: "Grant access",
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const picked = fs.realpathSync(result.filePaths[0]);
  const mode: FsMode = wantWrite ? "readwrite" : "read";
  addFsRoot(slug, { path: picked, mode });
  return { path: picked, mode };
}

export function fsRead(slug: string, args: Record<string, unknown>): { path: string; content: string; encoding: string; bytes: number } {
  const safe = resolveSafe(slug, args.path, false);
  const st = fs.statSync(safe);
  if (!st.isFile()) throw new Error("not a file");
  if (st.size > MAX_READ_BYTES) throw new Error(`file too large (max ${MAX_READ_BYTES} bytes)`);
  const encoding = args.encoding === "base64" ? "base64" : "utf8";
  return { path: safe, content: fs.readFileSync(safe).toString(encoding as BufferEncoding), encoding, bytes: st.size };
}

export function fsWrite(slug: string, args: Record<string, unknown>): { path: string; bytes: number } {
  const encoding = args.encoding === "base64" ? "base64" : "utf8";
  const buf = Buffer.from(String(args.content ?? ""), encoding as BufferEncoding);
  if (buf.length > MAX_WRITE_BYTES) throw new Error(`content too large (max ${MAX_WRITE_BYTES} bytes)`);
  const safe = resolveSafe(slug, args.path, true);
  fs.writeFileSync(safe, buf);
  return { path: safe, bytes: buf.length };
}
