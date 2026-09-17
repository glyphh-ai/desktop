/**
 * hub-ipc — the hub lanes for SKILLS (his order, 2026-09-16: skills are the
 * Agent Skills standard, folders on disk; the hub stores a folder as files).
 *
 *   skills-discover   what the member may install: the org's approved skills
 *                     and the Glyphh catalog items the org allowed
 *   skill-install     a hub skill → a folder in Glyphh's skills directory,
 *                     mirrored into every CLI's skills directory on the box
 *   skill-publish     a local folder → the org's hub (an org admin's goes live,
 *                     a member's waits on the review desk)
 *
 * Payload on the wire: { files: { "SKILL.md": "...", "scripts/x.py": "..." },
 * prompt: <SKILL.md body> } — `prompt` keeps the proxy's skills mirror fed.
 */

import { ipcMain } from "electron";
import { getClient, PLATFORM_URL } from "./glyphh-client.js";
import { getSkill, installSkill, filesFromHubPayload, readSkillFile, parseSkillMd, listSkills, setInstallForgetter, removeSkillFiles } from "./skills-fs.js";
import { getPreference, setPreference, preferencesByPrefix } from "./stores/preferences-db.js";

interface OrgItem { id: string; slug: string; name: string; description: string; author?: string; installed: boolean; installs?: number; headVersion: number | null; updatedAt: string; createdAt?: string; visibility?: string; categories?: string[]; icon?: string | null }
interface PublicItem { id: string; slug: string; name: string; description: string; sourceOrg: string; installed: boolean; installs?: number; version: number; updatedAt: string; createdAt?: string; kind: string; categories?: string[]; icon?: string | null }

export interface DiscoverRow {
  ref: string;
  from: "org" | "glyphh";
  id: string;
  slug: string;
  name: string;
  description: string;
  author: string;
  version: number | null;
  installed: boolean;
  installs: number;
  updatedAt: string;
  createdAt: string;
  categories: string[];
  /** App and task items: the manifest's icon.svg, from the catalog row. */
  icon?: string | null;
  /** What kind of skill this is — the hub kind it was listed under. */
  type: Kind;
}

const env = async <T>(fn: () => Promise<T>): Promise<{ ok: boolean; data?: T; error?: string }> => {
  try { return { ok: true, data: await fn() }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
};

/** The CONSOLE, signed in: a console session minted on this login handed to
 *  the console's own login page, which sets the cookie and lands on `next`. */
export async function platformUrl(next = "/ui/"): Promise<string> {
  const { token } = await getClient().http.post<{ token: string }>("/api/gateway/ui-session", {});
  if (!token) throw new Error("the console session couldn't be minted");
  return `${PLATFORM_URL}/ui/login?handoff=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
}

type Kind = "skill" | "app" | "plugin" | "task";
const kindOf = (k: unknown): Kind => (k === "app" ? "app" : k === "plugin" ? "plugin" : k === "task" ? "task" : "skill");
const kindsOf = (k: unknown): Kind[] => (Array.isArray(k) ? [...new Set(k.map(kindOf))] : [kindOf(k)]);
/** The hub kind behind a local bundle: what the folder IS (its manifest), and
 *  only if it can't be read, the home its id names. */
const kindOfId = (id: string): Kind => {
  try { return getSkill(id).type; } catch { /* unreadable or gone — fall back */ }
  return id.startsWith("app:") ? "app" : id.startsWith("plugin:") ? "plugin" : id.startsWith("task:") ? "task" : "skill";
};

async function discover(kinds: Kind[]): Promise<DiscoverRow[]> {
  const client = getClient();
  // The org list is per kind; the public catalog is one list for all of them.
  const [orgLists, pub] = await Promise.all([
    Promise.all(kinds.map(async (k) => [k, await client.http.get<OrgItem[]>(`/api/library/${k}`).catch(() => [] as OrgItem[])] as const)),
    client.http.get<PublicItem[]>("/api/hub/public").catch(() => [] as PublicItem[]),
  ]);
  const rows: DiscoverRow[] = [];
  for (const [kind, org] of orgLists) {
    for (const it of Array.isArray(org) ? org : []) {
      if (!it.headVersion) continue;
      rows.push({ ref: `org:${it.id}`, from: "org", id: it.id, slug: it.slug, name: it.name, description: it.description, author: it.author || "", version: it.headVersion, installed: it.installed, installs: it.installs ?? 0, updatedAt: it.updatedAt, createdAt: it.createdAt || it.updatedAt, categories: it.categories ?? [], icon: it.icon ?? null, type: kind });
    }
  }
  for (const p of (Array.isArray(pub) ? pub : []).filter((x) => kinds.includes(x.kind as Kind))) {
    rows.push({ ref: `glyphh:${p.id}`, from: "glyphh", id: p.id, slug: p.slug, name: p.name, description: p.description, author: p.sourceOrg, version: p.version, installed: p.installed, installs: p.installs ?? 0, updatedAt: p.updatedAt, createdAt: p.createdAt || p.updatedAt, categories: p.categories ?? [], icon: p.icon ?? null, type: p.kind as Kind });
  }
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** WHERE AN INSTALLED BUNDLE CAME FROM (2026-09-17). Without this an installed
 *  folder is an orphan: the hub can't be told when it goes, and nothing knows
 *  a newer version exists. Kept in the user's prefs (no local store), keyed by
 *  the folder's own id, and cleared when the folder goes. */
export interface InstallOrigin {
  from: "org" | "glyphh";
  itemId: string;
  kind: Kind;
  slug: string;
  /** The catalog version this copy was written from. */
  version: number;
  /** What the payload wrote, so an update can take away what it removed. */
  files: string[];
  installedAt: string;
}
const ORIGIN_KEY = (skillId: string): string => `bundleSource:${skillId}`;
const originOf = (skillId: string): InstallOrigin | null => {
  const v = getPreference<InstallOrigin | null>(ORIGIN_KEY(skillId), null);
  return v && typeof v === "object" && v.itemId ? v : null;
};
const baseFor = (o: { from: "org" | "glyphh"; kind: Kind; itemId: string }): string =>
  (o.from === "org" ? `/api/library/${o.kind}/${encodeURIComponent(o.itemId)}` : `/api/hub/public/${encodeURIComponent(o.itemId)}`);

/** The folder is gone: tell the hub this member no longer has it, and forget
 *  where it came from. Best effort — the folder is the truth either way. */
async function forget(skillId: string): Promise<void> {
  const o = originOf(skillId);
  setPreference(ORIGIN_KEY(skillId), null);
  if (!o) return;
  await getClient().http.del(`${baseFor(o)}/install`).catch(() => undefined);
}

async function install(ref: string, kind: Kind): Promise<{ id: string }> {
  const client = getClient();
  const [from, id] = ref.split(":", 2) as ["org" | "glyphh", string];
  const base = from === "org" ? `/api/library/${kind}/${encodeURIComponent(id)}` : `/api/hub/public/${encodeURIComponent(id)}`;
  const rows = from === "org" ? await client.http.get<OrgItem[]>(`/api/library/${kind}`) : await client.http.get<PublicItem[]>("/api/hub/public");
  const meta = (rows as Array<{ id: string; slug: string; name: string; description: string; headVersion?: number | null; version?: number | null }>).find((r) => r.id === id);
  if (!meta) throw new Error(`that ${kind} is no longer available to you`);
  const payload = await client.http.get<Record<string, unknown>>(`${base}/payload`);
  const files = filesFromHubPayload(meta.slug, meta.description, payload && typeof payload === "object" ? payload : {});
  const installed = installSkill(meta.slug, files, kind);
  setPreference(ORIGIN_KEY(installed.id), {
    from, itemId: id, kind, slug: meta.slug, version: versionOf(meta), files: Object.keys(files), installedAt: new Date().toISOString(),
  } satisfies InstallOrigin);
  await client.http.post(`${base}/install`, {}).catch(() => undefined); // the hub's install count; the folder is the truth
  return { id: installed.id };
}

const versionOf = (r: { headVersion?: number | null; version?: number | null }): number => Number(r.headVersion ?? r.version ?? 1);

/** Installed bundles the catalog has moved past, by folder id. */
async function updatesAvailable(): Promise<Record<string, { have: number; latest: number; name: string }>> {
  const origins = preferencesByPrefix<InstallOrigin>("bundleSource:");
  const out: Record<string, { have: number; latest: number; name: string }> = {};
  const wanted = Object.entries(origins).filter(([, o]) => o && typeof o === "object" && o.itemId);
  if (!wanted.length) return out;
  const client = getClient();
  const kinds = [...new Set(wanted.map(([, o]) => o.kind))];
  const [orgLists, pub] = await Promise.all([
    Promise.all(kinds.map(async (k) => [k, await client.http.get<OrgItem[]>(`/api/library/${k}`).catch(() => [] as OrgItem[])] as const)),
    client.http.get<PublicItem[]>("/api/hub/public").catch(() => [] as PublicItem[]),
  ]);
  const org = new Map(orgLists.flatMap(([, rows]) => (Array.isArray(rows) ? rows : []).map((r) => [r.id, r] as const)));
  const glyphh = new Map((Array.isArray(pub) ? pub : []).map((r) => [r.id, r] as const));
  for (const [key, o] of wanted) {
    const row = o.from === "org" ? org.get(o.itemId) : glyphh.get(o.itemId);
    if (!row) continue;
    const latest = versionOf(row);
    if (latest > Number(o.version || 1)) out[key] = { have: Number(o.version || 1), latest, name: row.name };
  }
  return out;
}

/** Take the catalog's current version over this copy: write what the payload
 *  has, take away what it dropped, and keep anything the user added. */
async function update(skillId: string): Promise<{ version: number }> {
  const o = originOf(skillId);
  if (!o) throw new Error("this one didn't come from the hub, so there is nothing to update from");
  const client = getClient();
  const rows = o.from === "org"
    ? await client.http.get<OrgItem[]>(`/api/library/${o.kind}`)
    : await client.http.get<PublicItem[]>("/api/hub/public");
  const meta = (rows as Array<{ id: string; slug: string; name: string; description: string; headVersion?: number | null; version?: number | null }>).find((r) => r.id === o.itemId);
  if (!meta) throw new Error(`that ${o.kind} is no longer available to you`);
  const payload = await client.http.get<Record<string, unknown>>(`${baseFor(o)}/payload`);
  const files = filesFromHubPayload(meta.slug, meta.description, payload && typeof payload === "object" ? payload : {});
  const name = skillId.slice(skillId.indexOf(":") + 1);
  const gone = (o.files ?? []).filter((f) => !(f in files));
  installSkill(name, files, o.kind);
  if (gone.length) removeSkillFiles(skillId, gone);
  const version = versionOf(meta);
  setPreference(ORIGIN_KEY(skillId), { ...o, version, files: Object.keys(files) } satisfies InstallOrigin);
  return { version };
}

/** What every desktop gets without asking (his order, 2026-09-16): the Glyphh
 *  skill and its plugin from the public catalog, installed once when absent. */
const DEFAULT_INSTALLS: ReadonlyArray<{ kind: Kind; slug: string }> = [{ kind: "skill", slug: "glyphh" }, { kind: "plugin", slug: "glyphh" }];
export async function installDefaultHubItems(): Promise<void> {
  try {
    const pub = await getClient().http.get<PublicItem[]>("/api/hub/public").catch(() => [] as PublicItem[]);
    for (const want of DEFAULT_INSTALLS) {
      const hit = pub.find((p) => p.kind === want.kind && p.slug === want.slug);
      if (!hit) continue;
      const have = listSkills(want.kind).find((s) => s.name === want.slug || s.id.endsWith(`:${want.slug}`));
      if (!have) {
        await install(`glyphh:${hit.id}`, want.kind);
        console.info(`[hub] installed the default ${want.kind} "${want.slug}"`);
        continue;
      }
      // THE HOUSE SKILL FOLLOWS THE SERVER (his report, 2026-09-17: "i didn't
      // update the glyphh skill on me"). These two are Glyphh's own writing —
      // the tool surface an agent reads — so a newer catalog version replaces
      // this copy instead of waiting for a button nobody presses. Everything
      // else keeps the Update button, where the user decides.
      const origin = originOf(have.id);
      if (origin && versionOf(hit) <= Number(origin.version || 1)) continue;
      // No origin recorded means this copy predates the bookkeeping: install
      // over it, which also writes the origin so later boots just compare.
      if (origin) await update(have.id);
      else await install(`glyphh:${hit.id}`, want.kind);
      console.info(`[hub] refreshed the default ${want.kind} "${want.slug}" to v${versionOf(hit)}`);
    }
  } catch (err) {
    console.warn("[hub] default installs:", err instanceof Error ? err.message : String(err));
  }
}

async function publish(skillId: string, notes: string): Promise<{ version: number; status: string }> {
  const skill = getSkill(skillId);
  const files: Record<string, string> = {};
  let bytes = 0;
  for (const f of skill.files) {
    const r = readSkillFile(skillId, f.path);
    if (r.binary) throw new Error(`"${f.path}" is binary — the hub carries text files only (put assets behind a URL)`);
    bytes += Buffer.byteLength(r.text);
    if (bytes > 900_000) throw new Error("this skill's files exceed the hub's 1 MB text limit");
    files[f.path] = r.text;
  }
  const { body } = parseSkillMd(files["SKILL.md"] || "");
  const slug = skill.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "skill";
  const r = await getClient().http.post<{ version: number; status: string }>(`/api/library/${kindOfId(skillId)}/promote`, {
    slug, name: skill.name, description: skill.description, notes, payload: { files, prompt: body, manifest: skill.frontmatter },
  });
  return r;
}

/** The hub versions behind a local skill: the org item whose slug is the
 *  folder's name. "current" is the disk; these are the immutable shares. */
async function versionsFor(skillId: string): Promise<{ itemId: string | null; kind: Kind; versions: Array<{ version: number; notes: string; createdAt: string }>; head: number | null; pending: number | null; categories: string[] }> {
  const skill = getSkill(skillId);
  const slug = skill.id.slice(skill.id.indexOf(":") + 1);
  const kind = kindOfId(skillId);
  const items = await getClient().http.get<OrgItem[]>(`/api/library/${kind}`).catch(() => [] as OrgItem[]);
  const item = (Array.isArray(items) ? items : []).find((it) => it.slug === slug || it.name === skill.name);
  if (!item) return { itemId: null, kind, versions: [], head: null, pending: null, categories: [] };
  const rows = await getClient().http.get<Array<{ version: number; notes: string; created_at: string }>>(`/api/library/${kind}/${encodeURIComponent(item.id)}/versions`).catch(() => []);
  return {
    itemId: item.id,
    kind,
    versions: (Array.isArray(rows) ? rows : []).map((r) => ({ version: r.version, notes: r.notes || "", createdAt: r.created_at })),
    // What the SHARE actually did: the live version on the org's hub, and the
    // one still sitting on the review desk.
    head: item.headVersion ?? null,
    pending: (item as { pendingVersion?: number | null }).pendingVersion ?? null,
    categories: Array.isArray((item as { categories?: unknown }).categories) ? ((item as { categories: string[] }).categories) : [],
  };
}

/** One hub version's files, for read-only viewing beside the disk copy. */
async function versionFiles(itemId: string, version: number, kind: Kind): Promise<Record<string, string>> {
  const payload = await getClient().http.get<Record<string, unknown>>(`/api/library/${kind}/${encodeURIComponent(itemId)}/payload?version=${version}`);
  const files = payload && typeof payload.files === "object" && payload.files ? (payload.files as Record<string, string>) : null;
  if (files) return files;
  return { "SKILL.md": typeof payload?.prompt === "string" ? payload.prompt : "" };
}

/** A hub item's folder as files, for the Discover detail view (read-only). */
async function hubFiles(ref: string, kind: Kind): Promise<Record<string, string>> {
  const [from, id] = ref.split(":", 2) as ["org" | "glyphh", string];
  const base = from === "org" ? `/api/library/${kind}/${encodeURIComponent(id)}` : `/api/hub/public/${encodeURIComponent(id)}`;
  const payload = await getClient().http.get<Record<string, unknown>>(`${base}/payload`);
  return filesFromHubPayload("skill", "", payload && typeof payload === "object" ? payload : {});
}

async function categories(): Promise<Array<{ id: string; label: string }>> {
  const r = await getClient().http.get<Array<{ id: string; label: string }>>("/api/hub/categories").catch(() => []);
  return Array.isArray(r) ? r : [];
}

export function registerHubIpc(): void {
  // A removed folder tells the hub it is gone (skills-fs owns the delete).
  setInstallForgetter((id) => { void forget(id); });
  ipcMain.handle("hub-categories", () => env(categories));
  ipcMain.handle("skill-hub-files", (_e, ref: string, kind?: string) => env(() => hubFiles(String(ref), kindOf(kind))));
  ipcMain.handle("skill-versions", (_e, id: string) => env(() => versionsFor(String(id))));
  ipcMain.handle("skill-version-files", (_e, itemId: string, version: number, kind?: string) => env(() => versionFiles(String(itemId), Number(version), kindOf(kind))));
  ipcMain.handle("platform-url", (_e, next?: string) => env(async () => ({ url: await platformUrl(typeof next === "string" && next.startsWith("/ui/") ? next : "/ui/") })));
  ipcMain.handle("skills-discover", (_e, kind?: string | string[]) => env(() => discover(kindsOf(kind))));
  ipcMain.handle("skill-install", (_e, ref: string, kind?: string) => env(() => install(String(ref), kindOf(kind))));
  ipcMain.handle("skill-updates", () => env(updatesAvailable));
  // The shelves a shared bundle sits on. Promote guesses them from the payload;
  // this is how a person corrects the guess without leaving the app.
  ipcMain.handle("skill-categories-set", (_e, itemId: string, kind: string, ids: unknown) => env(async () => {
    const categories = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
    await getClient().http.post(`/api/library/${kindOf(kind)}/${encodeURIComponent(String(itemId))}/categories`, { categories });
    return categories;
  }));
  ipcMain.handle("skill-update", (_e, id: string) => env(() => update(String(id))));
  ipcMain.handle("skill-publish", (_e, id: string, notes?: string) => env(() => publish(String(id), String(notes ?? ""))));
}
