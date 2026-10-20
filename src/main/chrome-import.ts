/**
 * chrome-import — IMPORT FROM GOOGLE (his order, 2026-09-23): a Chrome profile's
 * bookmarks become saved tabs, and the cookies for those sites are copied into
 * the partition the app's web panels use, so an imported tab opens already
 * signed in.
 *
 * Two calls, because the dialog must say exactly what it is about to take:
 * `scanChromeProfiles()` reads nothing secret — profile names and counts — and
 * `importFromChrome()` does the work the user then confirmed.
 *
 * WHAT IS AND IS NOT TOUCHED. Bookmarks are plain JSON in the profile. Cookies
 * are AES-128-CBC in a SQLite file, keyed by a password macOS keeps in the
 * login Keychain ("Chrome Safe Storage"); reading it makes macOS ask the user
 * for permission the first time, which is the user's call, not ours. Only
 * cookies whose host matches a bookmark being imported are read — the rest of
 * the jar (hundreds of sites) is never decrypted. History, passwords, payment
 * data and extensions are not read at all.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { session } from "electron";
import Database from "better-sqlite3";
import { addSavedTab, tabSlugOf } from "./saved-tabs.js";
import { fetchOrgApps } from "./org-apps.js";

/** Where Chrome keeps its profiles, per platform. */
function chromeRoot(): string {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Google", "Chrome");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
  return path.join(home, ".config", "google-chrome");
}

export interface ChromeProfile {
  /** Profile directory name ("Default", "Profile 3") — what the import takes. */
  dir: string;
  /** The name Chrome shows for it, when Local State knows one. */
  name: string;
  bookmarks: number;
  /** How many of those bookmarks are NOT already saved tabs. */
  newBookmarks: number;
  /** Distinct hosts in the jar whose cookies this import would carry. */
  cookieSites: number;
}

interface BookmarkNode { type?: string; name?: string; url?: string; children?: BookmarkNode[] }

/** Every bookmarked page in a profile, in Chrome's own order. */
function readBookmarks(dir: string): Array<{ name: string; url: string }> {
  const file = path.join(dir, "Bookmarks");
  let roots: Record<string, BookmarkNode>;
  try { roots = (JSON.parse(fs.readFileSync(file, "utf-8")) as { roots?: Record<string, BookmarkNode> }).roots ?? {}; }
  catch { return []; }
  const out: Array<{ name: string; url: string }> = [];
  const walk = (n: BookmarkNode): void => {
    // Only http(s) — a javascript: or chrome:// bookmark is not a tab.
    if (n.type === "url" && n.url && /^https?:\/\//i.test(n.url)) out.push({ name: String(n.name || n.url), url: n.url });
    for (const c of n.children ?? []) walk(c);
  };
  for (const root of Object.values(roots)) if (root && typeof root === "object") walk(root);
  return out;
}

/** The registrable-ish host a cookie domain belongs to, for matching bookmarks. */
const bareHost = (h: string): string => h.replace(/^\./, "").toLowerCase();

/** Does this cookie domain cover that bookmark host? (".github.com" covers
 *  "gist.github.com"; an exact host covers only itself.) */
function domainCovers(cookieDomain: string, host: string): boolean {
  const d = bareHost(cookieDomain);
  return host === d || host.endsWith(`.${d}`);
}

/** Chrome holds a write lock on the live file — read a copy. */
function withCookieDb<T>(profileDir: string, fn: (db: Database.Database) => T): T | null {
  const src = path.join(profileDir, "Cookies");
  if (!fs.existsSync(src)) return null;
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "glyphh-ck-")), "Cookies");
  try {
    fs.copyFileSync(src, tmp);
    const db = new Database(tmp, { readonly: true });
    try { return fn(db); } finally { db.close(); }
  } catch { return null; }
  finally { try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch { /* gone */ } }
}

export async function scanChromeProfiles(): Promise<{ ok: boolean; installed: boolean; cookiesSupported: boolean; profiles: ChromeProfile[]; error?: string }> {
  const root = chromeRoot();
  const cookiesSupported = process.platform === "darwin";
  if (!fs.existsSync(root)) return { ok: true, installed: false, cookiesSupported, profiles: [] };
  let names: Record<string, string> = {};
  try {
    const ls = JSON.parse(fs.readFileSync(path.join(root, "Local State"), "utf-8")) as { profile?: { info_cache?: Record<string, { name?: string }> } };
    names = Object.fromEntries(Object.entries(ls.profile?.info_cache ?? {}).map(([k, v]) => [k, String(v?.name || k)]));
  } catch { names = {}; }
  // Which tabs already exist — the dialog promises "N new", not "N".
  const existing = new Set((await fetchOrgApps().catch(() => [])).map((a) => a.slug));
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (e.name === "Default" || /^Profile \d+$/.test(e.name)))
    .map((e) => e.name)
    .sort((a, b) => (a === "Default" ? -1 : b === "Default" ? 1 : a.localeCompare(b, undefined, { numeric: true })));
  const profiles: ChromeProfile[] = [];
  for (const dir of dirs) {
    const marks = readBookmarks(path.join(root, dir));
    if (!marks.length) continue;   // nothing to import from this one
    const hosts = new Set<string>();
    for (const m of marks) { try { hosts.add(new URL(m.url).hostname.toLowerCase()); } catch { /* skip */ } }
    const cookieSites = cookiesSupported
      ? withCookieDb(path.join(root, dir), (db) => {
        const rows = db.prepare("SELECT DISTINCT host_key FROM cookies").all() as Array<{ host_key: string }>;
        return rows.filter((r) => [...hosts].some((h) => domainCovers(r.host_key, h))).length;
      }) ?? 0
      : 0;
    profiles.push({
      dir,
      name: names[dir] || dir,
      bookmarks: marks.length,
      newBookmarks: marks.filter((m) => !existing.has(tabSlugOf(m.name || m.url))).length,
      cookieSites,
    });
  }
  return { ok: true, installed: true, cookiesSupported, profiles };
}

/** Chrome's cookie key: the Keychain password, stretched the way Chrome does.
 *  macOS only — Windows wraps the key with DPAPI and Linux may use a plain
 *  "peanuts" password, neither of which is implemented here. */
async function cookieKey(): Promise<Buffer> {
  if (process.platform !== "darwin") throw new Error("cookie import is macOS-only for now");
  const pw = await new Promise<string>((resolve, reject) => {
    execFile("/usr/bin/security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"], (err, stdout) => {
      if (err) reject(new Error("macOS did not grant access to Chrome's Keychain entry — the import cannot read cookies without it"));
      else resolve(stdout.trim());
    });
  });
  if (!pw) throw new Error("Chrome's Keychain entry was empty");
  return crypto.pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
}

/** A cookie value is printable text — no control bytes. Used to recognise a
 *  binary prefix we don't have the exact domain spelling for. */
const looksLikeValue = (b: Buffer): boolean => !/[\u0000-\u0008\u000e-\u001f]/.test(b.toString("utf-8"));

/** One cookie's plaintext. `v10` values are AES-128-CBC under a fixed IV of
 *  spaces. Chrome 127+ prefixes the plaintext with a SHA-256 of the cookie's
 *  domain, and which spelling it hashes (with or without the leading dot) has
 *  moved between versions — both are tried, then a last resort for a variant
 *  neither matches: a 32-byte head that is not text in front of a tail that is.
 *  Older files carry no prefix at all and pass through untouched. */
function decryptCookie(blob: Buffer, key: Buffer, hostKey: string): string | null {
  if (!blob.length) return "";
  const version = blob.subarray(0, 3).toString("latin1");
  if (version !== "v10") return blob.toString("utf-8");   // unencrypted legacy value
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    const out = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
    if (out.length >= 32) {
      const head = out.subarray(0, 32);
      const tail = out.subarray(32);
      const hashed = [hostKey, bareHost(hostKey)]
        .some((d) => head.equals(crypto.createHash("sha256").update(d).digest()));
      if (hashed || (!looksLikeValue(head) && looksLikeValue(tail))) return tail.toString("utf-8");
    }
    return out.toString("utf-8");
  } catch { return null; }
}

export interface ChromeImportResult {
  ok: boolean;
  tabsAdded: number;
  tabsSkipped: number;
  cookiesImported: number;
  cookiesFailed: number;
  /** Set when the tabs landed but the cookie half could not run. */
  cookieError?: string;
  error?: string;
}

export async function importFromChrome(opts: { profile?: string; cookies?: boolean }): Promise<ChromeImportResult> {
  const base: ChromeImportResult = { ok: true, tabsAdded: 0, tabsSkipped: 0, cookiesImported: 0, cookiesFailed: 0 };
  const dir = path.join(chromeRoot(), String(opts.profile || "Default"));
  if (!fs.existsSync(dir)) return { ...base, ok: false, error: `no Chrome profile "${opts.profile}"` };
  const marks = readBookmarks(dir);
  if (!marks.length) return { ...base, ok: false, error: "that profile has no bookmarks" };

  // THE TABS. addSavedTab owns the rules (slug, duplicates, work panels) and
  // announces the change, so the wall and the Tabs page repaint as they land.
  const hosts = new Set<string>();
  for (const m of marks) {
    try {
      await addSavedTab({ name: m.name, url: m.url });
      base.tabsAdded++;
    } catch { base.tabsSkipped++; }   // already there, or a name with no slug
    try { hosts.add(new URL(m.url).hostname.toLowerCase()); } catch { /* skip */ }
  }

  if (!opts.cookies || !hosts.size) return base;

  // THE COOKIES, for those hosts only, into the partition web panels use.
  try {
    const key = await cookieKey();
    const rows = withCookieDb(dir, (db) => db.prepare(
      "SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, has_expires FROM cookies",
    ).all() as Array<{ host_key: string; name: string; encrypted_value: Buffer; path: string; expires_utc: number; is_secure: number; is_httponly: number; has_expires: number }>) ?? [];
    const jar = session.fromPartition("persist:yo").cookies;
    for (const r of rows) {
      if (![...hosts].some((h) => domainCovers(r.host_key, h))) continue;
      const value = decryptCookie(r.encrypted_value, key, r.host_key);
      if (value == null) { base.cookiesFailed++; continue; }
      const host = bareHost(r.host_key);
      try {
        await jar.set({
          url: `${r.is_secure ? "https" : "http"}://${host}${r.path || "/"}`,
          name: r.name,
          value,
          domain: r.host_key,
          path: r.path || "/",
          secure: r.is_secure === 1,
          httpOnly: r.is_httponly === 1,
          // Chrome counts microseconds from 1601-01-01; a session cookie
          // (has_expires 0) is set without an expiry, as it was in Chrome.
          ...(r.has_expires === 1 && r.expires_utc > 0
            ? { expirationDate: r.expires_utc / 1_000_000 - 11_644_473_600 }
            : {}),
        });
        base.cookiesImported++;
      } catch { base.cookiesFailed++; }
    }
    // To disk now: an import followed by a quick quit must not lose the jar
    // (2026-10-07: "Browsers are not remembering auth cookies or states").
    try { await jar.flushStore(); } catch { /* best effort */ }
  } catch (err) {
    base.cookieError = err instanceof Error ? err.message : String(err);
  }
  return base;
}
