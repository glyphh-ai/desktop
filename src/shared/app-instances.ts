/**
 * app-instances.ts — the PURE side of "apps are installed in the cloud"
 * (his decision, 2026-10-04: "all apps are installed in the cloud… users
 * build apps, host them in the org, the org allows others to access them,
 * not re-install them 1000 times").
 *
 * An installed Glyphh app is an INSTANCE on the server (yo/app-platform.md:
 * `glyphh_app_instances`, one always-on app server serving versioned
 * RELEASES from R2, the UI proxied at `/app-host/<key>/ui/` with the
 * `window.glyphh.call` shim injected; `release` is the pinned n, `pin` rolls
 * back). This module is what the desktop's main process and the web bridge
 * share:
 *
 *   · the create request a bundle makes       (instanceRequestOf)
 *   · the `tab` library row an instance gets   (instanceTabRow) — it rides the
 *     member library to every surface, its launchConfig names the instance
 *   · the panel path an instance's UI loads at (panelPathOf / panelUrlOf)
 *   · the ONE list — instances + tab rows, one row per slug
 *     (mergeAppRows)
 *   · the Settings → Apps card of an instance  (instanceCardOf)
 *
 * No Electron, no fetch, no fs: everything here is data in, data out, so
 * both surfaces and the tests run the same code.
 */

import { tabRowOf, type OrgAppRowLike, type TabRowLike } from "./member-library.js";
import { houseViewOfApp } from "./house-store.js";

export type InstanceKind = "org" | "personal";
export type InstanceStatus = "pending" | "ready" | "stopped" | "error";

/** One row of `GET /api/app-instances` (the server's Instance.summary()). */
export interface AppInstanceSummary {
  key: string;
  slug: string;
  kind: InstanceKind;
  access: "everyone" | "restricted";
  public: boolean;
  status: InstanceStatus;
  members: string[];
  orgConnectionId: string | null;
  bundle: { sha256: string; bytes?: number };
  manifest: { name: string; tools: unknown[]; capabilities: string[]; connectors: string[]; description?: string };
  /** The pinned release number; null (or absent) = nothing deployed yet. */
  release?: number | null;
  /** The pinned release's manifest `version` (the developer's number), or null. */
  version?: string | null;
  /** APPS CARRY A VERSION (his order, 2026-10-07): whether the catalog's head
   *  rolled past the release this instance took, and what it would move to. */
  update?: { available: boolean; headVersion: string | null; headRelease: number | null; itemRef: string | null } | null;
  /** AN OUTPUT TARGET (his order, 2026-10-07): the manifest said `output: true`,
   *  so the composer's Output chip may point a turn's result at this app. */
  output?: boolean;
  /** THE APP'S OWN PAGE (his order, 2026-10-07): the SKILL.md its pinned
   *  release ships, rendered on the Overview so an installed app is never a
   *  blank page. Empty until a release is pinned. */
  skill?: string;
  /** `/app-host/<key>/` — the proxy prefix the server answers for it. */
  url: string;
}

/** The update an instance can take, or null: the card's and the Updates tab's one read. */
export interface InstanceUpdate { available: boolean; headVersion: string | null; headRelease: number | null }
export const updateOf = (inst: Pick<AppInstanceSummary, "update"> | null | undefined): InstanceUpdate | null => {
  const u = inst?.update;
  if (!u || typeof u !== "object") return null;
  return { available: !!u.available, headVersion: u.headVersion ?? null, headRelease: Number.isInteger(u.headRelease) ? (u.headRelease as number) : null };
};

/** The pinned release of an instance as a number, or null when nothing is deployed. */
export const releaseOf = (inst: Pick<AppInstanceSummary, "release"> | null | undefined): number | null =>
  Number.isInteger(inst?.release) && (inst!.release as number) > 0 ? (inst!.release as number) : null;

/** Rollback = pin n-1: the release a Rollback button pins, or null when there
 *  is nothing before the live one. */
export const rollbackTargetOf = (inst: Pick<AppInstanceSummary, "release"> | null | undefined): number | null => {
  const n = releaseOf(inst);
  return n !== null && n > 1 ? n - 1 : null;
};

/** The manifest fields the install sends up (the desktop's GlyphhAppManifest,
 *  structurally — the server stores what it is handed and answers
 *  `manifest: {name, tools, capabilities, connectors}` back). */
export interface BundleManifestLike {
  name: string;
  slug: string;
  entry?: string;
  description?: string;
  capabilities?: string[];
  connectors?: string[];
  tools?: Array<{ name: string; description?: string; capability?: string; handler?: string; inputSchema?: Record<string, unknown> }>;
  window?: { width?: number; height?: number } | null;
  worker?: string;
  release?: { version: string; notes?: string | null; channel?: "dev" | "live"; releasedAt?: string | null };
  /** The bundle's icon.svg as a data URL, when the installer read one. */
  iconUrl?: string;
}

/** `POST /api/app-instances` body. */
export interface InstanceCreateRequest {
  slug: string;
  kind: InstanceKind;
  bundle: { sha256: string; sizeBytes: number };
  manifest: Record<string, unknown>;
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

/** The key a tab's launchConfig carries to name its instance. */
export const INSTANCE_CONFIG_KEY = "instance";
/** The id prefix of an instance's Settings → Apps card. */
export const INSTANCE_CARD_PREFIX = "app-instance:";

/** The create request for a bundle: slug, kind, the zip's identity and the
 *  manifest as it is. Throws on what the server would refuse, so a bad bundle
 *  never costs a round trip. */
export function instanceRequestOf(manifest: BundleManifestLike, bundle: { sha256: string; sizeBytes: number }, kind: InstanceKind): InstanceCreateRequest {
  const slug = String(manifest.slug || "").toLowerCase().trim();
  if (!SLUG_RE.test(slug)) throw new Error(`the manifest's slug must match ${SLUG_RE.source} (got "${manifest.slug}")`);
  if (kind !== "org" && kind !== "personal") throw new Error('kind is "org" or "personal"');
  if (!SHA_RE.test(bundle.sha256)) throw new Error("bundle.sha256 must be 64 hex characters");
  if (!Number.isInteger(bundle.sizeBytes) || bundle.sizeBytes <= 0) throw new Error("bundle.sizeBytes must be a positive integer");
  return { slug, kind, bundle: { sha256: bundle.sha256, sizeBytes: bundle.sizeBytes }, manifest: { ...manifest, slug } };
}

/** The instance key for a slug: the slug for an org instance, `slug~user` for a personal one. */
export const instanceKeyOf = (slug: string, kind: InstanceKind, userId: string): string => (kind === "personal" ? `${slug}~${userId}` : slug);

/** The slug an instance key names (`slug~user` → slug). */
export const slugOfKey = (key: string): string => key.split("~", 1)[0];

/** Where an instance's UI loads: the server's proxy, the release's `ui/`
 *  tree — a TRAILING SLASH (app-platform.md §10): the app server resolves
 *  `index.html` and the Next.js export's `./_next/…` assets resolve under it. */
export const panelPathOf = (key: string): string => `/app-host/${encodeURIComponent(key)}/ui/`;
export const panelUrlOf = (apiBase: string, key: string): string => `${apiBase.replace(/\/+$/, "")}${panelPathOf(key)}`;
/** Where the page's `glyphh.call` lands for that instance. */
export const callPathOf = (key: string): string => `/app-host/${encodeURIComponent(key)}/call`;

/** The launchConfig a tab row carries for an instance: the key, the kind, and
 *  the manifest's contract (the loop's tool list and the panel read the same
 *  keys) — and, for a HOUSE app (Images, Drive, …), the built-in panel its
 *  slug names (`tool`): the one key every open door on both surfaces already
 *  reads (the wall tile, the ⋮ menu, Settings → Apps → Open), so an instance
 *  of one of the six opens the native panel over the member's records, never
 *  its ui frame. */
export function tabConfigOf(inst: Pick<AppInstanceSummary, "key" | "kind" | "slug" | "manifest">, manifest?: BundleManifestLike | null): Record<string, unknown> {
  const m = manifest ?? inst.manifest;
  const tool = houseViewOfApp(inst.slug);
  return {
    [INSTANCE_CONFIG_KEY]: inst.key,
    instanceKind: inst.kind,
    capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
    connectors: Array.isArray(m.connectors) ? m.connectors : [],
    tools: Array.isArray(m.tools) ? m.tools : [],
    window: (manifest?.window ?? null) as Record<string, unknown> | null,
    // An installed app is a chromeless panel (his rule, 2026-08-20).
    workbench: true,
    ...(tool ? { tool } : {}),
    ...(manifest?.release ? { release: manifest.release } : {}),
    ...(typeof manifest?.iconUrl === "string" ? { iconUrl: manifest.iconUrl } : {}),
  };
}

/** THE OPEN RULE for an instance's tab (the Settings → Apps card's Open, on
 *  both surfaces): a house app answers its panel; anything else is a panel
 *  of the instance's own UI. */
export function instanceTabOpen(row: Pick<TabRowLike, "slug" | "name" | "config">): { slug: string; name: string; tool?: string } {
  const tool = typeof row.config?.tool === "string" && row.config.tool ? row.config.tool : houseViewOfApp(row.slug);
  return { slug: row.slug, name: row.name, ...(tool ? { tool } : {}) };
}

/** The tab row an instance gets (kind glyphh, no entry on any machine, config
 *  names the instance). `existing` keeps the row's identity, dates and config
 *  vars; a row from before the cloud (nativeRef = a file) is RETARGETED: its
 *  entry goes. */
export function instanceTabRow(inst: AppInstanceSummary, manifest: BundleManifestLike | null, existing: TabRowLike | null, nowIso: string): TabRowLike {
  const config = tabConfigOf(inst, manifest);
  const keptVars = existing?.config && typeof existing.config === "object"
    ? Object.fromEntries(Object.entries(existing.config).filter(([k]) => k === "secrets" || k === "vars" || k === "env"))
    : {};
  const name = String(manifest?.name || inst.manifest?.name || inst.slug);
  return {
    id: existing?.id ?? inst.slug,
    kind: "glyphh",
    slug: inst.slug,
    name,
    prodUrl: null,
    nativeRef: null,
    config: { ...keptVars, ...config },
    description: String(manifest?.description ?? inst.manifest?.description ?? existing?.description ?? ""),
    access: existing?.access ?? "members",
    owned: existing?.owned ?? true,
    latestVersion: manifest?.release?.version ?? existing?.latestVersion ?? null,
    version: manifest?.release?.version ?? existing?.version ?? "0.1.0",
    secretNames: existing?.secretNames ?? [],
    requiredConnections: (Array.isArray(manifest?.connectors) ? manifest!.connectors! : inst.manifest?.connectors ?? []).map((slug) => ({ slug: String(slug), actAs: "user", connected: false })),
    listing: null,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

/** The instance key a tab row (or its renderer projection) names, or null. */
export function instanceKeyOfRow(row: { config?: Record<string, unknown> | null; launchConfig?: Record<string, unknown> | null } | null | undefined): string | null {
  const cfg = row?.launchConfig ?? row?.config;
  const key = cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>)[INSTANCE_CONFIG_KEY] : null;
  return typeof key === "string" && key ? key : null;
}

/** THE LIST. Every tab row the member has (web, native, glyphh) and every
 *  instance they may open that no tab row names yet (an org instance an admin
 *  installed shows for every member without a row of their own) — one row per
 *  slug. Instance rows carry the instance's status in launchConfig so a
 *  surface reads it without a second lookup. */
export function mergeAppRows(instances: AppInstanceSummary[], tabs: TabRowLike[], nowIso = new Date(0).toISOString()): OrgAppRowLike[] {
  const bySlug = new Map<string, AppInstanceSummary>();
  for (const inst of instances) {
    // An org instance wins over the member's personal one of the same slug
    // for the row's identity; both stay reachable by key through the tools.
    const have = bySlug.get(inst.slug);
    if (!have || (have.kind === "personal" && inst.kind === "org")) bySlug.set(inst.slug, inst);
  }
  const out: OrgAppRowLike[] = [];
  const seen = new Set<string>();
  for (const tab of tabs) {
    const slug = tab.slug.toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    const inst = bySlug.get(slug);
    if (tab.kind === "glyphh" && inst && !instanceKeyOfRow(tab)) {
      // A row from before the cloud whose slug is in the cloud: the instance
      // is the app; the old row stands behind it.
      out.push(withInstance(tabRowOf(instanceTabRow(inst, null, tab, tab.updatedAt || nowIso)), inst));
      continue;
    }
    const row = tabRowOf(tab);
    const named = instanceKeyOfRow(tab);
    const live = named ? instances.find((i) => i.key === named) : undefined;
    // A GLYPHH TAB WITH NOTHING BEHIND IT IS NOT AN APP (his report, 2026-10-07:
    // tiles on the wall for apps he no longer held, each opening to "not
    // installed in the cloud"): an app is an instance, or a bundle on this
    // machine (nativeRef). A row left over from a deleted instance names
    // nothing that exists and lists nowhere.
    if (tab.kind === "glyphh" && !live && !inst && !tab.nativeRef) continue;
    out.push(live ? withInstance(row, live) : row);
  }
  for (const inst of bySlug.values()) {
    if (seen.has(inst.slug)) continue;
    seen.add(inst.slug);
    out.push(withInstance(tabRowOf(instanceTabRow(inst, null, null, nowIso)), inst));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** An instance-backed row carries the instance's live status — and a house
 *  app's panel (`tool`), even on a tab the server wrote before this rule, so
 *  every door opens it the same way. */
function withInstance(row: OrgAppRowLike, inst: AppInstanceSummary): OrgAppRowLike {
  const tool = typeof row.launchConfig?.tool === "string" && row.launchConfig.tool ? null : houseViewOfApp(inst.slug);
  return { ...row, launchConfig: { ...(row.launchConfig ?? {}), ...(tool ? { tool } : {}), instanceStatus: inst.status, instanceAccess: inst.access, instancePublic: inst.public } };
}

/** The Settings → Apps card of an instance — the shape the library page lists
 *  (skills-fs's SkillSummary, structurally), with no folder behind it. */
export interface InstanceCard {
  id: string;
  source: "app";
  type: "app";
  name: string;
  description: string;
  author: string;
  enabled: boolean;
  dir: string;
  fileCount: number;
  updatedAt: string;
  icon: null;
  /** A house app's panel (gimage, gdrive, …): the card's mark. */
  tool: string | null;
  /** Not a folder: the instance it stands for; `release` = the pinned n,
   *  `version` the developer's, `update` what the catalog would move it to. */
  instance: { key: string; kind: InstanceKind; status: InstanceStatus; access: string; public: boolean; tools: string[]; release: number | null; version: string | null; update: InstanceUpdate | null; output: boolean };
}

export const instanceCardId = (key: string): string => `${INSTANCE_CARD_PREFIX}${key}`;
export const isInstanceCardId = (id: string): boolean => id.startsWith(INSTANCE_CARD_PREFIX);
export const instanceKeyOfCardId = (id: string): string => (isInstanceCardId(id) ? id.slice(INSTANCE_CARD_PREFIX.length) : "");

export function instanceCardOf(inst: AppInstanceSummary, nowIso = new Date(0).toISOString()): InstanceCard {
  const tools = (Array.isArray(inst.manifest?.tools) ? inst.manifest.tools : [])
    .map((t) => (t && typeof t === "object" ? String((t as { name?: unknown }).name ?? "") : ""))
    .filter(Boolean);
  return {
    id: instanceCardId(inst.key),
    source: "app",
    type: "app",
    name: String(inst.manifest?.name || inst.slug),
    description: String(inst.manifest?.description ?? ""),
    // A house app is Glyphh's (his report, 2026-10-07: "by you" on Design); an
    // org instance the org's; a member's own install theirs.
    author: houseViewOfApp(inst.slug) ? "Glyphh" : inst.kind === "org" ? "your organization" : "you",
    enabled: inst.status !== "stopped" && inst.status !== "error",
    dir: "",
    fileCount: 0,
    updatedAt: nowIso,
    icon: null,
    // A house app's card wears its panel's mark, as every other door does.
    tool: houseViewOfApp(inst.slug),
    instance: { key: inst.key, kind: inst.kind, status: inst.status, access: inst.access, public: inst.public, tools, release: releaseOf(inst), version: inst.version ?? null, update: updateOf(inst), output: inst.output === true || (inst.manifest as { output?: unknown } | undefined)?.output === true },
  };
}

/** The card's detail: what the page shows when the card opens. */
export function instanceDetailOf(inst: AppInstanceSummary, nowIso?: string): InstanceCard & { frontmatter: Record<string, string>; body: string; files: never[] } {
  const card = instanceCardOf(inst, nowIso);
  const tools = (Array.isArray(inst.manifest?.tools) ? inst.manifest.tools : []) as Array<{ name?: string; description?: string }>;
  const where = inst.kind === "org" ? (inst.access === "restricted" ? "members on its list" : "every member of your organization") : "you";
  const release = releaseOf(inst);
  // THE PAGE IS THE APP'S OWN SKILL.md when its release ships one (his order,
  // 2026-10-07: "at the very least the .md description of the app"); the
  // synthesized page below is the fallback for an app that ships none.
  const skill = String(inst.skill ?? "").trim();
  const lines = skill ? [skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim()] : [
    `# ${card.name}`,
    "",
    card.description,
    "",
    `Installed in the cloud as ${inst.kind === "org" ? "an organization" : "a personal"} app (instance \`${inst.key}\`, status ${inst.status}, ${release === null ? "nothing deployed yet" : `release ${release}`}). Open to ${where}${inst.public ? ", and public on its own hostname" : ""}.`,
    "",
    ...(tools.length ? ["## Tools", "", ...tools.map((t) => `- \`${t.name}\`${t.description ? ` — ${t.description}` : ""}`)] : []),
    ...(inst.manifest?.connectors?.length ? ["", "## Connections", "", ...inst.manifest.connectors.map((c) => `- ${c}`)] : []),
  ];
  return {
    ...card,
    frontmatter: { name: card.name, description: card.description, type: "app", instance: inst.key, kind: inst.kind, status: inst.status, access: inst.access, author: card.author, ...(release === null ? {} : { release: String(release) }) },
    body: lines.join("\n"),
    files: [],
  };
}

/** The `app_list_tools` row an instance answers (same shape as the gateway's). */
export function instanceToolRows(instances: AppInstanceSummary[]): Array<{ app: string; name: string; kind: InstanceKind; status: InstanceStatus; tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }> {
  return instances.map((inst) => ({
    app: inst.key,
    name: String(inst.manifest?.name || inst.slug),
    kind: inst.kind,
    status: inst.status,
    tools: (Array.isArray(inst.manifest?.tools) ? inst.manifest.tools : [])
      .filter((t): t is { name: string; description?: string; inputSchema?: Record<string, unknown> } => !!t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string")
      .map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}) })),
  })).filter((r) => r.tools.length > 0);
}

/** Which instance a tool call names: the exact key, else the org instance of
 *  that slug, else the caller's personal one. */
export function resolveInstance(instances: AppInstanceSummary[], ref: string, userId: string): AppInstanceSummary | undefined {
  const key = String(ref || "").trim().toLowerCase();
  if (!key) return undefined;
  return instances.find((i) => i.key === key)
    ?? instances.find((i) => i.slug === key && i.kind === "org")
    ?? instances.find((i) => i.key === `${key}~${userId}`)
    ?? instances.find((i) => i.slug === key);
}
