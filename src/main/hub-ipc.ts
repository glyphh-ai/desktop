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
import { getSkill, installSkill, filesFromHubPayload, readSkillFile, parseSkillMd, listSkills } from "./skills-fs.js";

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
/** The hub kind behind a local id: the apps home publishes as kind app. */
const kindOfId = (id: string): Kind => (id.startsWith("app:") ? "app" : id.startsWith("plugin:") ? "plugin" : id.startsWith("task:") ? "task" : "skill");

async function discover(kind: Kind): Promise<DiscoverRow[]> {
  const client = getClient();
  const [org, pub] = await Promise.all([
    client.http.get<OrgItem[]>(`/api/library/${kind}`).catch(() => [] as OrgItem[]),
    client.http.get<PublicItem[]>("/api/hub/public").catch(() => [] as PublicItem[]),
  ]);
  const rows: DiscoverRow[] = [];
  for (const it of Array.isArray(org) ? org : []) {
    if (!it.headVersion) continue;
    rows.push({ ref: `org:${it.id}`, from: "org", id: it.id, slug: it.slug, name: it.name, description: it.description, author: it.author || "", version: it.headVersion, installed: it.installed, installs: it.installs ?? 0, updatedAt: it.updatedAt, createdAt: it.createdAt || it.updatedAt, categories: it.categories ?? [], icon: it.icon ?? null, type: kind });
  }
  for (const p of (Array.isArray(pub) ? pub : []).filter((x) => x.kind === kind)) {
    rows.push({ ref: `glyphh:${p.id}`, from: "glyphh", id: p.id, slug: p.slug, name: p.name, description: p.description, author: p.sourceOrg, version: p.version, installed: p.installed, installs: p.installs ?? 0, updatedAt: p.updatedAt, createdAt: p.createdAt || p.updatedAt, categories: p.categories ?? [], icon: p.icon ?? null, type: kind });
  }
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function install(ref: string, kind: Kind): Promise<{ id: string }> {
  const client = getClient();
  const [from, id] = ref.split(":", 2) as ["org" | "glyphh", string];
  const base = from === "org" ? `/api/library/${kind}/${encodeURIComponent(id)}` : `/api/hub/public/${encodeURIComponent(id)}`;
  const rows = from === "org" ? await client.http.get<OrgItem[]>(`/api/library/${kind}`) : await client.http.get<PublicItem[]>("/api/hub/public");
  const meta = (rows as Array<{ id: string; slug: string; name: string; description: string }>).find((r) => r.id === id);
  if (!meta) throw new Error(`that ${kind} is no longer available to you`);
  const payload = await client.http.get<Record<string, unknown>>(`${base}/payload`);
  const files = filesFromHubPayload(meta.slug, meta.description, payload && typeof payload === "object" ? payload : {});
  const installed = installSkill(meta.slug, files, kind);
  await client.http.post(`${base}/install`, {}).catch(() => undefined); // the hub's install count; the folder is the truth
  return { id: installed.id };
}

/** What every desktop gets without asking (his order, 2026-09-16): the Glyphh
 *  skill and its plugin from the public catalog, installed once when absent. */
const DEFAULT_INSTALLS: ReadonlyArray<{ kind: Kind; slug: string }> = [{ kind: "skill", slug: "glyphh" }, { kind: "plugin", slug: "glyphh" }];
export async function installDefaultHubItems(): Promise<void> {
  try {
    const pub = await getClient().http.get<PublicItem[]>("/api/hub/public").catch(() => [] as PublicItem[]);
    for (const want of DEFAULT_INSTALLS) {
      if (listSkills(want.kind).some((s) => s.name === want.slug || s.id.endsWith(`:${want.slug}`))) continue;
      const hit = pub.find((p) => p.kind === want.kind && p.slug === want.slug);
      if (!hit) continue;
      await install(`glyphh:${hit.id}`, want.kind);
      console.info(`[hub] installed the default ${want.kind} "${want.slug}"`);
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
async function versionsFor(skillId: string): Promise<{ itemId: string | null; versions: Array<{ version: number; notes: string; createdAt: string }> }> {
  const skill = getSkill(skillId);
  const slug = skill.id.slice(skill.id.indexOf(":") + 1);
  const kind = kindOfId(skillId);
  const items = await getClient().http.get<OrgItem[]>(`/api/library/${kind}`).catch(() => [] as OrgItem[]);
  const item = (Array.isArray(items) ? items : []).find((it) => it.slug === slug || it.name === skill.name);
  if (!item) return { itemId: null, versions: [] };
  const rows = await getClient().http.get<Array<{ version: number; notes: string; created_at: string }>>(`/api/library/${kind}/${encodeURIComponent(item.id)}/versions`).catch(() => []);
  return { itemId: item.id, versions: (Array.isArray(rows) ? rows : []).map((r) => ({ version: r.version, notes: r.notes || "", createdAt: r.created_at })) };
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
  ipcMain.handle("hub-categories", () => env(categories));
  ipcMain.handle("skill-hub-files", (_e, ref: string, kind?: string) => env(() => hubFiles(String(ref), kindOf(kind))));
  ipcMain.handle("skill-versions", (_e, id: string) => env(() => versionsFor(String(id))));
  ipcMain.handle("skill-version-files", (_e, itemId: string, version: number, kind?: string) => env(() => versionFiles(String(itemId), Number(version), kindOf(kind))));
  ipcMain.handle("platform-url", (_e, next?: string) => env(async () => ({ url: await platformUrl(typeof next === "string" && next.startsWith("/ui/") ? next : "/ui/") })));
  ipcMain.handle("skills-discover", (_e, kind?: string) => env(() => discover(kindOf(kind))));
  ipcMain.handle("skill-install", (_e, ref: string, kind?: string) => env(() => install(String(ref), kindOf(kind))));
  ipcMain.handle("skill-publish", (_e, id: string, notes?: string) => env(() => publish(String(id), String(notes ?? ""))));
}
