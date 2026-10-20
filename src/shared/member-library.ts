/**
 * member-library.ts — THE MEMBER LIBRARY'S RECORD SHAPES, pure (his rule,
 * 2026-10-04: the library is DATABASE-AS-TRUTH; both surfaces write to the
 * server and each syncs its own file system from it, per item, latest wins,
 * with tombstones).
 *
 * One record per kind rides `/api/library/v2/<kind>/<id>` as `{ id, updatedAt,
 * deletedAt, data }` (+ a `files` manifest for the folder kinds). What goes in
 * `data` — and what NEVER does — is decided here, once, so the desktop's sync
 * (main/library-sync.ts), the web's reads and writes (web/src/web-contract.js)
 * and the tests all agree:
 *
 *   workspace  id = the folder slug           data = the workspace.json grid (+ updatedAt)
 *   tab        id = the app slug              data = tab.json MINUS its local config vars
 *   skill      id = the folder name           data = { name, description, frontmatter, body, enabled, type }  files = the folder
 *   agent      id = the agent slug            data = the agent record (updatedAt ISO)
 *   task       id = the bundle slug           data = { name, description, frontmatter, body, enabled, type, manifest }  files = the bundle
 *
 * Every clock is the WRITER'S `Date.now()` (epoch ms): workspaces carry it as a
 * number; tabs and agents already stamp an ISO `updatedAt` on save and project
 * it with `Date.parse` (millisecond-exact both ways); the folder kinds take the
 * newest file mtime, or the clock recorded at the last sync when nothing moved;
 * drips and schedules (SQLite rows on the desktop, 2026-10-04: "anything that
 * could be local before is now a db row with cloud storage") stamp `updated_ms`
 * on every save, and a row written before the stamp takes its SQL datetime.
 *
 * No electron, no fs: the web bundle imports this file.
 */

/** The kinds the desktop's sync walks. `plugin` is a library kind on the
 *  server and the web since 2026-10-05 (his report: "why can't plugins be
 *  installed on the web?"), see BundleKind; it joins this union — and the
 *  SDK's MemberLibraryKind, which this one is handed to in library-sync-core
 *  — with the desktop's plugin adapter. */
/** The SDK's own union (sdk contract/member-library.ts), repeated here because
 *  the renderer never imports the SDK: the house kinds and plugins joined on
 *  2026-10-06 (cloud is the one home). */
export type MemberLibraryKind =
  | "workspace" | "tab" | "skill" | "agent" | "task" | "drip" | "schedule" | "plugin"
  | "design" | "deck" | "image" | "video" | "audio" | "file" | "folder";

/** A row as the server lists it. `deletedAt` arrives as a number (epoch ms) on
 *  the `since` page and as an ISO string on an item read; the SDK's reconcile
 *  wants `string | null`, so every remote row goes through normalizeRemoteRow. */
export interface RemoteRow<T = unknown> {
  id: string;
  updatedAt: number;
  deletedAt?: string | number | null;
  data?: T;
}

export interface LwwRemoteRow<T = unknown> {
  id: string;
  updatedAt: number;
  deletedAt: string | null;
  data?: T;
}

export function normalizeRemoteRow<T>(row: RemoteRow<T>): LwwRemoteRow<T> {
  const d = row.deletedAt;
  const deletedAt = d === null || d === undefined || d === "" ? null
    : typeof d === "number" ? new Date(d).toISOString()
    : String(d);
  return { ...row, updatedAt: Number(row.updatedAt) || 0, deletedAt };
}

// ── Workspaces ───────────────────────────────────────────────────────────────

export interface GridCellLike {
  panelId: string; col: number; row: number; colSpan: number; rowSpan: number; sticky?: boolean;
  config?: Record<string, unknown>;
}

/** The workspace.json grid — layout-manager's GridLayout, structurally. */
export interface GridLayoutLike {
  name: string;
  version: 2;
  cols: number;
  rows: number;
  colWidths: number[];
  rowHeights: number[];
  cells: GridCellLike[];
  folderMode?: "single" | "multi";
  target?: "glyphh" | "desktop";
  loop?: string;
  /** The face the workspace's agents open with: the chat panel or the loop's terminal. */
  view?: "glyphh" | "cli";
  /** Route the workspace's CLI agents through the user's own providers (on) or their own login (off). */
  gateway?: "on" | "off";
  modelSelections?: Record<string, string>;
  sessionMode?: "keep" | "new" | "last";
  /** THE TYPE (his order, 2026-10-07): Work or Code — what every agent
   *  session this workspace creates carries, unless its own agent cell names
   *  one. Absent = follow the panels (a dev panel makes it Code). */
  type?: "work" | "code";
  folder?: string;
  space?: "chat" | "cowork" | "code";
  /** Epoch ms — the writer's clock (added 2026-10-04; absent on older files). */
  updatedAt?: number;
  /** THE SURFACE IT WAS MADE ON (his order, 2026-10-06: "the workspaces
   *  should carry a desktop vs web key for where they are created"). Stamped
   *  at the save on each surface; absent on every workspace before then —
   *  all of those were made on a desktop (workspaceSurfaceOf). */
  surface?: WorkspaceSurface;
}

/** Where a workspace was created: a desktop app or the web. */
export type WorkspaceSurface = "desktop" | "web";

/** The surface a workspace belongs to. A row without the stamp predates it —
 *  every workspace before 2026-10-06 was made on a desktop. Each surface
 *  lists only its own (layout-manager's desktop list, member-library-web's
 *  layoutsList); the library row keeps every workspace. */
export function workspaceSurfaceOf(g: Pick<GridLayoutLike, "surface"> | null | undefined): WorkspaceSurface {
  return g?.surface === "web" ? "web" : "desktop";
}

/** The row the Workspaces page, the wall and the attach socket read — the
 *  `layouts-list` IPC's shape, projected in ONE place so every surface sees
 *  exactly what the desktop's own renderer sees. */
export interface LayoutRowLike {
  name: string;
  cols: number;
  rows: number;
  colWidths: number[];
  rowHeights: number[];
  target: "glyphh" | "desktop";
  loop: string | null;
  /** The agents' opening face; null = the member's default. */
  view: "glyphh" | "cli" | null;
  /** The CLI route; null = the member's default. */
  gateway: "on" | "off" | null;
  modelSelections: Record<string, string>;
  sessionMode: "keep" | "new" | "last";
  /** THE TYPE (his report, 2026-10-07: "the type overall is not persisting on
   *  save" — the save wrote it, this row never carried it back). */
  type: "work" | "code" | null;
  folder: string | null;
  space: "chat" | "cowork" | "code" | null;
  splits: GridCellLike[];
  updatedAt?: number;
}

/** The folder id a workspace persists under — its name, slugged. */
export function workspaceId(name: string): string {
  return String(name ?? "").trim().toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

export function layoutRowOf(l: GridLayoutLike): LayoutRowLike {
  const cells = Array.isArray(l.cells) ? l.cells : [];
  return {
    name: l.name,
    cols: l.cols,
    rows: l.rows,
    colWidths: Array.isArray(l.colWidths) ? l.colWidths : [],
    rowHeights: Array.isArray(l.rowHeights) ? l.rowHeights : [],
    target: l.target ?? "glyphh",
    loop: l.loop ?? null,
    view: l.view === "glyphh" || l.view === "cli" ? l.view : null,
    gateway: l.gateway === "on" || l.gateway === "off" ? l.gateway : null,
    modelSelections: l.modelSelections ?? {},
    sessionMode: l.sessionMode ?? "keep",
    type: l.type === "work" || l.type === "code" ? l.type : null,
    folder: l.folder ?? null,
    space: l.space ?? null,
    splits: cells.map((c) => ({ panelId: c.panelId, col: c.col, row: c.row, colSpan: c.colSpan, rowSpan: c.rowSpan, sticky: c.sticky, config: c.config })),
    ...(typeof l.updatedAt === "number" ? { updatedAt: l.updatedAt } : {}),
  };
}

/** Is this a workspace grid at all? (a `data` the server handed back is opaque to it) */
export function isGridLayout(v: unknown): v is GridLayoutLike {
  const g = v as GridLayoutLike | null;
  return !!g && typeof g === "object" && typeof g.name === "string" && Array.isArray(g.cells);
}

/** The LWW clock of a workspace file: its stamp, else nothing (0 — a file
 *  written before stamps existed loses to any server row, which is right:
 *  the server copy was written by a build that stamps). */
export const workspaceClock = (g: GridLayoutLike): number => (typeof g.updatedAt === "number" ? g.updatedAt : 0);

// ── App tabs ─────────────────────────────────────────────────────────────────

/** tab.json — apps-store's LocalAppRow, structurally. */
export interface TabRowLike {
  id: string;
  kind: "web" | "native" | "glyphh";
  slug: string;
  name: string;
  prodUrl: string | null;
  nativeRef: string | null;
  config: Record<string, unknown> | null;
  description: string;
  access: "public" | "members";
  owned: boolean;
  latestVersion: string | null;
  version: string;
  secretNames: string[];
  requiredConnections: { slug: string; actAs: string; connected: boolean }[];
  listing: null;
  createdAt: string;
  updatedAt: string;
}

/** The renderer's Apps record (preload's SavedPanelApp / org-apps' OrgAppRow). */
export interface OrgAppRowLike {
  id: string;
  orgId: string;
  createdBy: string;
  name: string;
  slug: string;
  system: boolean;
  url: string | null;
  isBrowser: boolean;
  execPath: string | null;
  appArchetype: string | null;
  launchConfig: Record<string, unknown> | null;
  access: string;
  owned: boolean;
  latestVersion: string | null;
  version: string;
  secretNames: string[];
  requiredConnections: { slug: string; actAs: string; connected: boolean }[];
  iconUrl: string | null;
  listing: null;
  connectionIds: string[];
  mcp: null;
  commands: Record<string, never>;
  createdAt: string;
  updatedAt: string;
}

/** CONFIG VARS STAY ON THE MACHINE. A tab's launch config may carry what the
 *  app is started with — environment, headers, cookies, tokens — and none of
 *  that is library data. These keys (and any key that names a secret) are
 *  stripped before a tab rides to the server and restored from the local copy
 *  when a pull lands. */
export const TAB_LOCAL_CONFIG_KEYS: readonly string[] = ["vars", "env", "secrets", "headers", "cookies", "credentials", "auth"];
const SECRET_KEY = /(token|secret|password|passwd|apikey|api_key|private)/i;

export const isLocalConfigKey = (key: string): boolean => TAB_LOCAL_CONFIG_KEYS.includes(key) || SECRET_KEY.test(key);

/** The tab as it rides to the server: every field but the local config vars. */
export function tabRecordOf(row: TabRowLike): TabRowLike {
  const config = row.config && typeof row.config === "object"
    ? Object.fromEntries(Object.entries(row.config).filter(([k]) => !isLocalConfigKey(k)))
    : null;
  return { ...row, config: config && Object.keys(config).length ? config : (row.config ? {} : null) };
}

/** A pulled tab over the local one: the server's fields, the machine's config vars. */
export function mergeTabLocal(remote: TabRowLike, local: TabRowLike | null): TabRowLike {
  if (!local?.config) return remote;
  const kept = Object.fromEntries(Object.entries(local.config).filter(([k]) => isLocalConfigKey(k)));
  if (!Object.keys(kept).length) return remote;
  return { ...remote, config: { ...(remote.config ?? {}), ...kept } };
}

/** Is this a tab row at all? */
export function isTabRow(v: unknown): v is TabRowLike {
  const t = v as TabRowLike | null;
  return !!t && typeof t === "object" && typeof t.slug === "string" && (t.kind === "web" || t.kind === "native" || t.kind === "glyphh");
}

export const tabClock = (t: TabRowLike): number => Date.parse(t.updatedAt) || 0;

/** Native and glyphh apps launch from a local path; every other kind opens a
 *  URL. A glyphh row keeps the desktop's long-standing "glyphh-app" archetype
 *  tag (isGlyphhAppRow and friends match on it). */
/** THE KIND OF A LISTED ROW, read back off the projection above (and off a
 *  cloud instance's row, which carries no local entry): "glyphh" = an
 *  installed Glyphh app bundle (appArchetype "glyphh-app"), "web" = a URL
 *  tab, "native" = an OS app; null = a system / navigation row, or nothing a
 *  panel can open. The web's agent menu lists ONLY the "glyphh" rows (his
 *  review, 2026-10-05). */
export function appRowKind(row: { system?: boolean | null; appArchetype?: string | null; url?: string | null; execPath?: string | null }): "glyphh" | "web" | "native" | null {
  if (!row || row.system) return null;
  if (row.appArchetype === "glyphh-app") return "glyphh";
  if (row.appArchetype === "native" || (!row.url && row.execPath)) return "native";
  if (row.appArchetype === "web" || row.url) return "web";
  return null;
}

export function tabRowOf(app: TabRowLike): OrgAppRowLike {
  const required = Array.isArray(app.requiredConnections) ? app.requiredConnections : [];
  return {
    id: app.id,
    orgId: "",
    createdBy: "",
    name: app.name,
    slug: app.slug,
    system: false,
    url: app.prodUrl,
    isBrowser: app.kind !== "native" && app.kind !== "glyphh",
    execPath: app.nativeRef,
    appArchetype: app.kind === "glyphh" ? "glyphh-app" : app.kind,
    launchConfig: app.config ?? null,
    access: app.access,
    owned: app.owned,
    latestVersion: app.latestVersion,
    version: app.version,
    secretNames: app.secretNames ?? [],
    requiredConnections: required,
    connectionIds: required.map((c) => c.slug),
    iconUrl: typeof app.config?.iconUrl === "string" ? app.config.iconUrl : null,
    listing: null,
    mcp: null,
    commands: {},
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  };
}

/** The tab record a create/update input makes — the SAME row the desktop's
 *  apps-store writes (createEntry/updateEntry), so a tab made on the web is
 *  indistinguishable from one made on the desktop once pulled. */
export interface TabInput {
  kind?: "web" | "native" | "glyphh";
  slug?: string;
  name?: string;
  url?: string | null;
  nativeRef?: string | null;
  description?: string;
  config?: Record<string, unknown> | null;
  access?: "public" | "members";
  secretNames?: string[];
}

export function buildTabRow(input: TabInput, existing: TabRowLike | null, nowIso: string): TabRowLike {
  const slug = String(input.slug ?? existing?.slug ?? "").toLowerCase().trim();
  if (!slug) throw new Error("an app needs a slug");
  if (!existing) {
    return {
      id: slug,
      kind: input.kind ?? "web",
      slug,
      name: input.name || slug,
      prodUrl: input.url ?? null,
      nativeRef: input.nativeRef ?? null,
      config: input.config ?? null,
      description: input.description ?? "",
      access: input.access === "public" ? "public" : "members",
      owned: true,
      latestVersion: null,
      version: "0.1.0",
      secretNames: [],
      requiredConnections: [],
      listing: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }
  const row: TabRowLike = { ...existing };
  if (input.name !== undefined) row.name = String(input.name);
  if (input.url !== undefined) row.prodUrl = input.url ?? null;
  if (input.nativeRef !== undefined) row.nativeRef = input.nativeRef ?? null;
  if (input.description !== undefined) row.description = String(input.description);
  if (input.config !== undefined) row.config = input.config ?? null;
  if (input.access !== undefined) row.access = input.access === "public" ? "public" : "members";
  if (input.kind !== undefined) row.kind = input.kind;
  if (input.secretNames !== undefined) row.secretNames = input.secretNames.map(String);
  row.updatedAt = nowIso;
  return row;
}

// ── Agents ───────────────────────────────────────────────────────────────────

export interface GuardrailsPolicyLike {
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
  windowSeconds?: number | null;
  windowTokens?: number | null;
  windowCalls?: number | null;
  maxConcurrent?: number | null;
}

/** ~/.glyphh/<user>/agents/<slug>.json — local-agents' AgentRow, structurally. */
export interface AgentRowLike {
  id: string;
  slug: string;
  name: string;
  description: string;
  prompt: string;
  provider: string;
  model: string;
  skills: string[];
  apps: string[];
  live: boolean;
  guardrails: GuardrailsPolicyLike | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentInputLike {
  slug?: string; name?: string; description?: string; prompt?: string;
  provider?: string; model?: string; skills?: string[]; apps?: string[];
  live?: boolean; guardrails?: GuardrailsPolicyLike | null;
}

export const agentSlug = (name: string): string =>
  String(name ?? "").trim().toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";

const numOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

export function cleanGuardrails(g: GuardrailsPolicyLike | null | undefined): GuardrailsPolicyLike | null {
  if (!g) return null;
  const out: GuardrailsPolicyLike = {
    maxInputTokens: numOrNull(g.maxInputTokens),
    maxOutputTokens: numOrNull(g.maxOutputTokens),
    windowSeconds: numOrNull(g.windowSeconds),
    windowTokens: numOrNull(g.windowTokens),
    windowCalls: numOrNull(g.windowCalls),
    maxConcurrent: numOrNull(g.maxConcurrent),
  };
  // All blank = no policy at all, so the detail view says "none" instead of
  // rendering six empty rows.
  return Object.values(out).some((v) => v !== null) ? out : null;
}

/** The agent record an input makes over an existing one — local-agents'
 *  saveAgent and the web's create/update build the SAME row through this. */
export function buildAgentRow(input: AgentInputLike, existing: AgentRowLike | null, nowIso: string): AgentRowLike {
  const name = String(input.name ?? existing?.name ?? "").trim();
  if (!name) throw new Error("an agent needs a name");
  const slug = agentSlug(String(input.slug || existing?.slug || name));
  return {
    id: slug,
    slug,
    name,
    description: String(input.description ?? existing?.description ?? ""),
    prompt: String(input.prompt ?? existing?.prompt ?? ""),
    provider: input.provider === undefined ? existing?.provider ?? "" : String(input.provider || ""),
    model: String(input.model ?? existing?.model ?? ""),
    skills: Array.isArray(input.skills) ? input.skills.map(String) : existing?.skills ?? [],
    apps: Array.isArray(input.apps) ? input.apps.map(String) : existing?.apps ?? [],
    live: input.live === undefined ? existing?.live ?? true : !!input.live,
    guardrails: input.guardrails === undefined ? existing?.guardrails ?? null : cleanGuardrails(input.guardrails),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

export function isAgentRow(v: unknown): v is AgentRowLike {
  const a = v as AgentRowLike | null;
  return !!a && typeof a === "object" && typeof a.slug === "string" && typeof a.name === "string";
}

export const agentClock = (a: AgentRowLike): number => Date.parse(a.updatedAt) || 0;

// ── Skills and tasks (folders) ───────────────────────────────────────────────

/** One file of a folder kind, as the server's manifest holds it. */
export interface LibraryFileLike { path: string; size: number; mtime: number; sha256: string }

/** The `data` of a skill or task record — what a list or a detail page reads
 *  WITHOUT downloading the folder. The folder itself is the `files` manifest. */
/** The folder kinds the library holds: a skill, a task, a plugin. */
export type BundleKind = "skill" | "task" | "plugin";

/** Where an installed bundle came from (the desktop's `bundleSource:` pref,
 *  carried in the record on the web — his report, 2026-10-05). */
export interface BundleOriginLike {
  from: "org" | "glyphh";
  itemId: string;
  kind: string;
  slug: string;
  version: number;
  files: string[];
  installedAt: string;
  author?: string;
}

export interface BundleDataLike {
  name: string;
  description: string;
  frontmatter: Record<string, string>;
  body: string;
  enabled: boolean;
  type: BundleKind;
  /** Tasks: task.json, verbatim. Plugins: .claude-plugin/plugin.json. */
  manifest?: Record<string, unknown> | null;
  /** Installed from the hub: which catalog item, at which version. */
  origin?: BundleOriginLike | null;
}

/** Frontmatter is a flat YAML block between --- fences: `key: value` lines.
 *  (skills-fs.parseSkillMd — here so the web reads a SKILL.md the same way.) */
export function parseSkillMd(text: string): { frontmatter: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const fm: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const fold = value.startsWith(">");
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) block.push(lines[++i].trim());
      value = fold ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
    }
    fm[key] = value.replace(/^["']|["']$/g, "");
  }
  return { frontmatter: fm, body: text.slice(m[0].length) };
}

/** The record's `data` from a bundle's SKILL.md (+ task.json for a task; a
 *  plugin has no root SKILL.md — its name and description come off
 *  .claude-plugin/plugin.json, passed as the manifest). */
export function bundleDataOf(kind: BundleKind, name: string, skillMd: string, enabled: boolean, manifest: Record<string, unknown> | null = null): BundleDataLike {
  const { frontmatter, body } = parseSkillMd(skillMd);
  const m = kind === "plugin" && manifest ? manifest : {};
  return {
    name: frontmatter.name || (typeof m.name === "string" ? m.name : "") || name,
    description: frontmatter.description || (typeof m.description === "string" ? m.description : ""),
    frontmatter, body, enabled, type: kind,
    ...(kind === "task" || kind === "plugin" ? { manifest } : {}),
  };
}

/** The hub payload ({ files } today; { prompt, code } before) as folder files
 *  — the same projection as main/skills-fs.filesFromHubPayload, here so the
 *  web installs what the desktop installs (his report, 2026-10-05). */
export function hubPayloadFiles(name: string, description: string, p: Record<string, unknown>): Record<string, string> {
  const files = (p.files && typeof p.files === "object" ? p.files : null) as Record<string, string> | null;
  if (files && Object.keys(files).length) return files;
  const body = typeof p.prompt === "string" ? p.prompt : "";
  const fm = `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n`;
  const out: Record<string, string> = { "SKILL.md": fm + body };
  if (typeof p.code === "string" && p.code.trim()) out["scripts/program.js"] = p.code;
  return out;
}

/** The manifest's identity — what "the files changed" means for the clock. */
export function filesSignature(files: readonly LibraryFileLike[]): string {
  return [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}@${f.sha256}`).join("\n");
}

/** The newest mtime in a manifest — the folder's clock when nothing recorded a newer one. */
export const filesClock = (files: readonly LibraryFileLike[]): number => files.reduce((m, f) => Math.max(m, Number(f.mtime) || 0), 0);

/** The Skills page's row id for a library record: the desktop's `<source>:<name>`. */
export const bundlePageId = (kind: BundleKind, id: string): string => `${kind === "task" ? "task" : kind === "plugin" ? "plugin" : "glyphh"}:${id}`;
/** …and back: which kind and record a page id names (null for the homes the server does not hold). */
export function bundleOfPageId(pageId: string): { kind: BundleKind; id: string } | null {
  const cut = pageId.indexOf(":");
  if (cut < 0) return null;
  const source = pageId.slice(0, cut);
  const id = pageId.slice(cut + 1);
  if (!id) return null;
  if (source === "glyphh") return { kind: "skill", id };
  if (source === "task") return { kind: "task", id };
  if (source === "plugin") return { kind: "plugin", id };
  return null;
}

/** The Skills page's list row (settings-skills' SkillRow) from a record. An
 *  installed bundle is BY its publisher (the origin's author), never "you". */
export function bundleRowOf(kind: BundleKind, id: string, data: BundleDataLike, updatedAt: number, fileCount: number): Record<string, unknown> {
  return {
    id: bundlePageId(kind, id),
    source: kind === "task" ? "task" : kind === "plugin" ? "plugin" : "glyphh",
    type: kind,
    name: data.name || id,
    description: data.description || "",
    author: data.frontmatter?.author || data.frontmatter?.from || data.origin?.author || "",
    enabled: data.enabled !== false,
    dir: "",
    fileCount,
    updatedAt: new Date(updatedAt || 0).toISOString(),
    icon: null,
    tool: null,
  };
}

// ── Merge (the web's reads) ──────────────────────────────────────────────────

/** THE SERVER FIRST: its rows, then the relay's rows the server does not hold
 *  (a desktop that has not synced yet). One row per key; the server wins a
 *  tie. Pure. */
export function mergeServerFirst<T>(server: readonly T[], relay: readonly T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of [...server, ...relay]) {
    const k = key(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

// ── Drips ────────────────────────────────────────────────────────────────────

/** The `data` of a drip record: the preset, nothing of the machine that plays
 *  it (the overlay windows, what is running now). */
export interface DripDataLike { name: string; recipe: string }

/** The preset's id: its name, lowercased and trimmed — the `.drip save` command
 *  and the Drips page both lowercase names, so one preset has one id. */
export const dripId = (name: string): string => String(name ?? "").trim().toLowerCase();

export function dripRecordOf(name: string, recipe: string): DripDataLike {
  return { name: dripId(name), recipe: String(recipe ?? "").trim().split(/\s+/).join(" ") };
}

export function isDripData(v: unknown): v is DripDataLike {
  const d = v as DripDataLike | null;
  return !!d && typeof d === "object" && typeof d.name === "string" && typeof d.recipe === "string";
}

/** A SQL `datetime('now')` ("YYYY-MM-DD HH:MM:SS", UTC) or an ISO stamp as epoch
 *  ms — the clock of a row written before `updated_ms` existed. 0 when unreadable. */
export function sqlClock(stamp: string | null | undefined): number {
  const s = String(stamp ?? "").trim();
  if (!s) return 0;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  return Date.parse(iso) || 0;
}

/** The LWW clock of a stamped SQLite row: its `updated_ms`, else its SQL datetime. */
export const rowClock = (updatedMs: number | null | undefined, stamp: string | null | undefined): number =>
  (typeof updatedMs === "number" && updatedMs > 0 ? Math.floor(updatedMs) : sqlClock(stamp));

// ── Schedules ────────────────────────────────────────────────────────────────

/** The `data` of a schedule record — what puts a task or a skill on a clock.
 *  The runs, and whether a job is armed right now, are the machine's: they
 *  never ride. */
export interface ScheduleDataLike {
  name: string;
  /** Five fields. */
  cron: string;
  kind: "task" | "skill";
  /** The task bundle's slug, or the skill's. */
  target: string;
  /** The agent a SKILL reads through (a task fills its own slots). */
  agentId: string | null;
  /** The agent that OWNS this schedule (an Agents-page task), else null. */
  ownerAgentId: string | null;
  /** Arguments handed to the target. */
  args: Record<string, unknown>;
  enabled: boolean;
}

export interface ScheduleInputLike {
  name?: string | null; cron: string; kind?: string | null; target: string;
  agentId?: string | null; ownerAgentId?: string | null; args?: unknown; enabled?: boolean | null;
}

/** Does this read as a cron line at all (five fields of cron characters)? The
 *  desktop's clock validates for real (node-cron); the web checks the shape so
 *  a typo never lands as a record nothing can arm. */
export const isCronShape = (cron: string): boolean => /^(?:[\d*,/#?LW-]+\s+){4}[\d*,/#?LW-]+$/i.test(String(cron ?? "").trim());

export function buildScheduleData(input: ScheduleInputLike, existing: ScheduleDataLike | null = null): ScheduleDataLike {
  const target = String(input.target ?? existing?.target ?? "").trim();
  const args = input.args === undefined ? existing?.args ?? {} : input.args;
  return {
    name: String(input.name ?? "").trim() || existing?.name || target,
    cron: String(input.cron ?? existing?.cron ?? "").trim().split(/\s+/).join(" "),
    kind: (input.kind ?? existing?.kind) === "skill" ? "skill" : "task",
    target,
    agentId: input.agentId === undefined ? existing?.agentId ?? null : (input.agentId ? String(input.agentId) : null),
    ownerAgentId: input.ownerAgentId === undefined ? existing?.ownerAgentId ?? null : (input.ownerAgentId ? String(input.ownerAgentId) : null),
    args: args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {},
    enabled: input.enabled === undefined || input.enabled === null ? existing?.enabled ?? true : !!input.enabled,
  };
}

export function isScheduleData(v: unknown): v is ScheduleDataLike {
  const d = v as ScheduleDataLike | null;
  return !!d && typeof d === "object" && typeof d.cron === "string" && typeof d.target === "string" && (d.kind === "task" || d.kind === "skill");
}

/** The row the Schedules page reads (the `schedules-list` IPC's shape) from a
 *  record: the machine's run columns are null until its clock reports. */
export function scheduleViewOf(id: string, data: ScheduleDataLike, updatedAt: number, agentName: string | null = null): Record<string, unknown> {
  return {
    id, name: data.name, kind: data.kind, target: data.target, cron: data.cron, enabled: data.enabled,
    agentId: data.agentId, agentName: agentName ?? data.agentId, ownerAgentId: data.ownerAgentId,
    args: JSON.stringify(data.args ?? {}), createdAt: new Date(updatedAt).toISOString(), updatedAt,
    lastRunAt: null, lastStatus: null, lastError: null,
  };
}

// ── Threads ──────────────────────────────────────────────────────────────────

/** WHERE A THREAD RUNS: in the cloud (a cloud-* source, or a thread adopted
 *  from the server's list that carries no source, no folder and no local
 *  bodies yet) or on this machine (everything else — a local source, a bound
 *  folder, or a chat this store wrote itself). The desktop's publisher stamps
 *  every thread it publishes `source.kind = "local"`, so the ambiguity only
 *  exists for threads born before stamps. */
/** The cloud workers' session root (kept in step with help/thread-locus.ts). */
export const CLOUD_WORKSPACE_ROOT = "/data/glyphh-harness/";
export function isCloudWorkspacePath(p: unknown): boolean {
  return typeof p === "string" && p.startsWith(CLOUD_WORKSPACE_ROOT);
}
export function threadLocus(c: { source?: unknown; workdir?: unknown; messages?: unknown[]; messageCount?: number }): "local" | "cloud" {
  const src = c.source as { kind?: unknown; path?: unknown } | null | undefined;
  const kind = src && typeof src === "object" && typeof src.kind === "string" ? src.kind : "";
  if (kind === "local" && isCloudWorkspacePath(src?.path)) return "cloud";
  if (kind === "local") return "local";
  if (isCloudWorkspacePath(c.workdir)) return "cloud";
  if (kind.startsWith("cloud")) return "cloud";
  if (typeof c.workdir === "string" && c.workdir) return "local";
  const adoptedStub = typeof c.messageCount === "number" && c.messageCount > 0 && !(c.messages?.length);
  return adoptedStub ? "cloud" : "local";
}
