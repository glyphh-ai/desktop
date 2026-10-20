/**
 * member-library-web.js — THE MEMBER LIBRARY ON THE WEB (his rule, 2026-10-04:
 * database-as-truth; both surfaces write to the server; each syncs its own
 * file system from it). The browser has no file system, so here the server IS
 * the store: every list reads `client.memberLibrary` FIRST (merged with the
 * rows an attached desktop still holds, the server winning a tie), and every
 * write is a `put`/`remove` at this client's clock — the desktop pulls it on
 * its next sync.
 *
 *   workspaces  layoutsList / layoutsSaveGrid / layoutsDelete
 *   app tabs    panelAppsList / panelAppsCreate / panelAppsUpdate / panelAppsDelete
 *   skills+tasks skillsList / skillGet / skillFileRead / skillFileWrite / skillCreate /
 *   +plugins    skillDelete / skillSetEnabled  (files through the presigned R2 URLs)
 *   the hub     skillsDiscover / hubCategories / skillHubFiles / skillInstall / skillUpdate /
 *               skillUpdates / skillStandings / skillShares / skillWithdraw / skillVersions /
 *               skillVersionFiles / skillCategoriesSet / skillPublish — the same server
 *               routes main/hub-ipc.ts reads; INSTALL = a put into this library
 *               (his report, 2026-10-05: Discover was empty on the web) — an APP
 *               installs as this member's cloud instance (from-hub), the one
 *               shape an app has (his order, 2026-10-06)
 *   agents      libraryAgentsList / libraryAgentGet / libraryAgentCreate / libraryAgentUpdate / libraryAgentDelete
 *   tasks       tasksSpecs / taskSpec / taskSlotSet
 *   drips       dripsList / dripsSave / dripsDelete
 *   schedules   schedulesList / scheduleSave / scheduleSetEnabled / scheduleDelete
 *
 * What still needs the machine answers so, per action (NEEDS_DESKTOP): running
 * a task or a schedule now, an agent's schedules, revealing/importing/exporting
 * a folder, opening an app bundle as a tab; the runs (the desktop's clock,
 * until the cloud clock exists) list empty. Pure over the injected client +
 * fetch — the tests drive it with fakes.
 */
import {
  buildScheduleData, bundleDataOf, bundleOfPageId, bundlePageId, bundleRowOf, buildAgentRow, buildTabRow, dripId, dripRecordOf,
  hubPayloadFiles, isAgentRow, isCronShape, isDripData, isGridLayout, isScheduleData, isTabRow,
  layoutRowOf, parseSkillMd, scheduleViewOf, tabRecordOf, tabRowOf, workspaceId, workspaceSurfaceOf,
} from '../../src/shared/member-library';
import { instanceCardId, mergeAppRows } from '../../src/shared/app-instances';
import { HOUSE_VIEW_OF_APP } from '../../src/renderer/help/house-relay.ts';
import { buildAppInstancesWeb } from './app-instances-web.js';

/** The one line a machine-only action answers on web. */
export const NEEDS_DESKTOP = 'This runs on your desktop. Open the Glyphh desktop app for it — the record itself is here, synced from the server.';

const ok = (data) => ({ ok: true, data });
const fail = (err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) });
const isNotFound = (err) => err && (err.httpStatus === 404 || err.code === 'not_found' || /not found/i.test(String(err.message)));

/** sha256 as hex — the browser's SubtleCrypto (node's webcrypto under test). */
async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('no crypto.subtle — cannot hash the file');
  const buf = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const encode = (text) => new TextEncoder().encode(text);
/** A file's bytes as the hub carries it: text, or an image as a data URL
 *  (skills-fs.installSkill writes the same bytes on the desktop). */
function bytesOf(rel, text) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(text);
  if (m && /\.(png|jpe?g|gif|webp|svg)$/i.test(rel)) {
    const bin = atob(m[2]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return encode(text);
}

/**
 * @param {object} client the SDK client (client.memberLibrary)
 * @param {object} deps  { fetchImpl }
 */
export function buildMemberLibrary(client, deps = {}) {
  const lib = () => client.memberLibrary;
  const fetchImpl = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  // THE BYTES GO THROUGH THE SERVER (his report, 2026-10-05: "Failed to fetch"
  // installing a plugin — a browser cannot reach the presigned R2 URLs
  // cross-origin, and the bucket's CORS is not ours to set). The server's
  // GET/PUT /api/library/v2/<kind>/<id>/files/<path> move a file on the
  // member's own prefix; the desktop keeps the presigned lane.
  const apiUrl = String(deps.apiUrl ?? '').replace(/\/+$/, '');
  const fileUrl = (kind, id, rel) => `${apiUrl}/api/library/v2/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/files/${String(rel).split('/').map(encodeURIComponent).join('/')}`;
  const authHeaders = async () => { let t = null; try { t = (await client.token()) || null; } catch { t = null; } return t ? { authorization: `Bearer ${t}` } : {}; };
  const fileGet = async (kind, id, rel) => fetchImpl(fileUrl(kind, id, rel), { method: 'GET', headers: await authHeaders() });
  const filePut = async (kind, id, rel, body) => fetchImpl(fileUrl(kind, id, rel), { method: 'PUT', headers: await authHeaders(), body });
  // THE CLOCK: this client's `Date.now()`, strictly increasing across the
  // writes of this page — a save and a delete in the same millisecond must
  // not collide on the server's strictly-newer rule.
  const wall = deps.now ?? (() => Date.now());
  let lastClock = 0;
  const now = () => { lastClock = Math.max(wall(), lastClock + 1); return lastClock; };
  const STALE = 'the server holds a newer copy — reload and try again';

  const listRows = async (kind) => {
    try { return await lib().list(kind); } catch { return []; }
  };
  // APPS LIVE IN THE CLOUD (his decision, 2026-10-04): the instances this
  // member may open join the tab list and the Apps page (app-instances-web.js).
  const appInstances = deps.appInstances ?? buildAppInstancesWeb(client, { now, document: deps.document, secure: deps.secure });

  // ── Workspaces ────────────────────────────────────────────────────────────
  // ONE LIST (his order, 2026-10-06: "Cloud is first and every surface pulls
  // from it"): the member library's `workspace` rows ARE the workspaces, on
  // every surface. The desktop's workspaces folder is a cache of these rows
  // (library-adapters.ts workspaceAdapter syncs both ways); a desktop's own
  // `layouts.list` over the relay never joins — it is the same rows.
  // THIS SURFACE'S LIST (his order, 2026-10-06: "the workspaces should carry
  // a desktop vs web key for where they are created"): a workspace carries
  // the surface it was made on; the web lists only the web-made ones (a row
  // without the stamp predates it and is a desktop's — shared/member-library
  // workspaceSurfaceOf). The row keeps every workspace; the desktop lists
  // its own the same way (layout-manager.ts desktopLayouts).
  const layoutsList = async () => {
    const srv = await listRows('workspace');
    return srv.filter((r) => isGridLayout(r.data) && workspaceSurfaceOf(r.data) === 'web').map((r) => layoutRowOf({ ...r.data, updatedAt: r.updatedAt }));
  };
  const layoutsSaveGrid = async (grid) => {
    try {
      const name = String(grid?.name ?? '').trim();
      if (!name) return { error: 'A name is required.' };
      const { loop, modelSelections, sessionMode, type, gateway, folder, space, ...rest } = grid;
      const at = now();
      const data = {
        ...rest, name, version: 2,
        // Made HERE (his order, 2026-10-06): a grid without a surface is the web's.
        surface: grid.surface ?? 'web',
        folderMode: grid.folderMode ?? 'single',
        target: grid.target ?? 'glyphh',
        ...(loop ? { loop } : {}),
        ...(modelSelections && Object.keys(modelSelections).length ? { modelSelections } : {}),
        ...(sessionMode && sessionMode !== 'keep' ? { sessionMode } : {}),
        // THE TYPE (2026-10-07): Work or Code, the same rule as the desktop's layouts-save-grid.
        ...(type === 'work' || type === 'code' ? { type } : {}),
        // THE GATEWAY BYPASS (2026-10-07): the same rule as the desktop's layouts-save-grid.
        ...(gateway === 'on' || gateway === 'off' ? { gateway } : {}),
        ...(folder ? { folder } : {}),
        ...(space === 'chat' || space === 'cowork' || space === 'code' ? { space } : {}),
        updatedAt: at,
      };
      const res = await lib().put('workspace', workspaceId(name), { data, updatedAt: at });
      return res.applied ? true : { error: STALE };
    } catch (err) { return { error: err?.message ?? String(err) }; }
  };
  const layoutsDelete = async (name) => {
    try { await lib().remove('workspace', workspaceId(name), { updatedAt: now() }); return true; }
    catch (err) { return isNotFound(err) ? true : { error: err?.message ?? String(err) }; }
  };

  // ── App tabs ──────────────────────────────────────────────────────────────
  // THE HOUSE APPS ARE APPS (his law, 2026-10-06): Images, Drive and the rest
  // are cloud instances the server installs for every member, listed here
  // like any instance — never a synthesized row. Their tab's `tool` names the
  // built-in panel (shared/app-instances.ts), which is where Open lands.
  const panelAppsList = async () => {
    const [srv, instances] = await Promise.all([listRows('tab'), appInstances.listInstances()]);
    const tabs = srv.filter((r) => isTabRow(r.data)).map((r) => ({ ...r.data, slug: r.id, updatedAt: new Date(r.updatedAt).toISOString() }));
    // THE ONE LIST (his order, 2026-10-06): the server's tabs and every
    // instance no tab names yet. The Echo, the Apps page and the ⋮ menu all
    // read this; nothing from a desktop joins it.
    return mergeAppRows(instances, tabs);
  };
  /** A Glyphh-app panel on the web: the instance's UI through this origin's proxy. */
  const glyphhAppPreviewOpen = async (slug) => {
    let rows = [];
    try { rows = await panelAppsList(); } catch { rows = []; }
    return appInstances.previewOpen(slug, rows);
  };
  const glyphhAppPreviewClear = async () => ({ ok: true });
  const tabInputOf = (o) => ({
    ...(o.name !== undefined ? { name: String(o.name) } : {}),
    ...(o.url !== undefined && o.url !== null ? { url: String(o.url) } : {}),
    ...(o.execPath !== undefined && o.execPath !== null ? { nativeRef: String(o.execPath) } : {}),
    ...(o.description !== undefined ? { description: String(o.description) } : {}),
    ...(o.launchConfig !== undefined ? { config: o.launchConfig ?? {} } : {}),
    ...(o.access !== undefined ? { access: o.access } : {}),
  });
  const tabKindOf = (o) => (String(o.appArchetype ?? '') === 'glyphh-app' ? 'glyphh' : (o.isBrowser === false || o.execPath ? 'native' : 'web'));
  const readTab = async (slug) => {
    try { const item = await lib().get('tab', slug); return isTabRow(item.data) ? { ...item.data, slug, updatedAt: new Date(item.updatedAt).toISOString() } : null; }
    catch (err) { if (isNotFound(err)) return null; throw err; }
  };
  const panelAppsCreate = async (input) => {
    try {
      const slug = String(input?.slug || input?.name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!slug) return { ok: false, error: 'A name is required.' };
      if (await readTab(slug)) return { ok: false, error: `an app named "${slug}" already exists` };
      const at = now();
      const row = buildTabRow({ kind: tabKindOf(input), slug, name: String(input.name || slug), ...tabInputOf(input) }, null, new Date(at).toISOString());
      const res = await lib().put('tab', slug, { data: tabRecordOf(row), updatedAt: at });
      return res.applied ? { ok: true, app: tabRowOf(row) } : { ok: false, error: STALE };
    } catch (err) { return fail(err); }
  };
  const panelAppsUpdate = async (id, patch) => {
    try {
      const existing = await readTab(String(id).toLowerCase().trim());
      if (!existing) return { ok: false, error: `app "${id}" not found` };
      const kind = patch?.isBrowser !== undefined ? tabKindOf(patch) : undefined;
      const at = now();
      const input = tabInputOf(patch ?? {});
      // A General save carries the tab's RPA mapping forward (desktop maps it; 2026-10-07).
      if (input.config && !('rpa' in input.config) && existing.config?.rpa) input.config = { ...input.config, rpa: existing.config.rpa };
      const row = buildTabRow({ ...input, ...(kind === 'web' || kind === 'native' ? { kind } : {}) }, existing, new Date(at).toISOString());
      const res = await lib().put('tab', existing.slug, { data: tabRecordOf(row), updatedAt: at });
      return res.applied ? { ok: true, app: tabRowOf(row) } : { ok: false, error: STALE };
    } catch (err) { return fail(err); }
  };
  const panelAppsDelete = async (id) => {
    try { await lib().remove('tab', String(id).toLowerCase().trim(), { updatedAt: now() }); return { ok: true }; }
    catch (err) { return isNotFound(err) ? { ok: true } : fail(err); }
  };

  // ── Skills and tasks ──────────────────────────────────────────────────────
  // PLUGINS ARE RECORDS TOO (his report, 2026-10-05): a Claude Code plugin
  // folder in the library, installed on the machine by the desktop's sync.
  const BUNDLE_KINDS = { skill: 'skill', task: 'task', plugin: 'plugin' };
  // THE INSTALLED APPS THAT ARE TAB ROWS (his report, 2026-10-05: "build in
  // the web doesn't carry apps yet"): the house apps — Drive, Slides, Design,
  // Images… — and any Glyphh app the desktop registered are `tab` rows of
  // kind "glyphh" in the member library, not instances, so the desktop's
  // Skills page lists them and the web's did not. They list here as app
  // cards (`app-tab:<slug>`); an instance of the same slug IS that card.
  // A tab's panel: its launchConfig.tool, else the house panel its slug names
  // (Images → gimage) — a row relayed from a desktop can arrive without the
  // tool, and Open then took the desktop door (his report, 2026-10-05: "on
  // web this open doesn't do anything").
  /** A Discover card for a house app wears that app's own mark (his report,
   *  2026-10-07: generic icons on Drive, Images, …): the panel its slug names. */
  const houseToolOfSlug = (kind, slug) => (kind === 'app' ? (HOUSE_VIEW_OF_APP[String(slug || '').toLowerCase()] ?? null) : null);
  const houseToolOf = (t) => (t.config && typeof t.config === 'object' && typeof t.config.tool === 'string') ? t.config.tool : (HOUSE_VIEW_OF_APP[String(t.slug || '').toLowerCase()] ?? null);
  const TAB_CARD = 'app-tab:';
  const isTabCardId = (id) => String(id || '').startsWith(TAB_CARD);
  const tabCardOf = (t) => ({
    id: `${TAB_CARD}${t.slug}`, source: 'app', type: 'app',
    name: String(t.name || t.slug), description: String(t.description || ''), author: 'you',
    enabled: true, dir: '', fileCount: 0, updatedAt: t.updatedAt,
    icon: null, tool: houseToolOf(t),
  });
  const tabApps = async () => {
    const srv = await listRows('tab');
    return srv.filter((r) => isTabRow(r.data) && r.data.kind === 'glyphh').map((r) => ({ ...r.data, slug: r.id, updatedAt: new Date(r.updatedAt).toISOString() }));
  };
  const tabCard = async (pageId) => {
    const slug = String(pageId).slice(TAB_CARD.length);
    const t = (await tabApps()).find((x) => x.slug === slug);
    if (t) return t;
    // The merged list (server tabs + the attached desktop's rows) as the
    // fallback: a row the desktop reported but the server has not synced yet
    // (his report, 2026-10-05: "no app audio").
    const merged = (await panelAppsList().catch(() => [])).find((x) => String(x.slug || x.id || '').toLowerCase() === slug.toLowerCase());
    if (!merged) throw new Error(`no app ${slug}`);
    const cfg = merged.launchConfig ?? merged.config ?? null;
    return { slug, name: String(merged.name || slug), description: String(merged.description || ''), config: cfg, nativeRef: merged.execPath ?? merged.nativeRef ?? null, updatedAt: new Date(now()).toISOString() };
  };
  const skillsList = async (kind) => {
    const asked = Array.isArray(kind) ? kind : [kind ?? 'skill'];
    const kinds = [...new Set(asked.map((k) => BUNDLE_KINDS[k]).filter(Boolean))];
    const rows = [];
    for (const k of kinds) {
      for (const r of await listRows(k)) {
        if (!r.data || typeof r.data !== 'object') continue;
        rows.push(bundleRowOf(k, r.id, r.data, r.updatedAt, Array.isArray(r.data.files) ? r.data.files.length : (r.fileCount ?? 0)));
      }
    }
    // Settings → Apps on the web = the cloud instances + the installed tab apps.
    if (asked.includes('app')) {
      const instances = await appInstances.cards();
      const have = new Set(instances.map((c) => String(c.name).toLowerCase()));
      const haveSlugs = new Set((await appInstances.listInstances()).map((i) => String(i.slug).toLowerCase()));
      rows.push(...instances);
      // A glyphh tab row is an app only with a bundle on a machine behind it
      // (nativeRef); one left over from a deleted instance is nothing (his
      // report, 2026-10-07).
      for (const t of await tabApps()) if (t.nativeRef && !haveSlugs.has(t.slug.toLowerCase()) && !have.has(String(t.name).toLowerCase())) rows.push(tabCardOf(t));
    }
    return ok(rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  };
  const bundleItem = async (pageId) => {
    const ref = bundleOfPageId(String(pageId));
    if (!ref) throw new Error(`${pageId}: not a library skill or task`);
    const item = await lib().get(ref.kind, ref.id);
    return { ref, item };
  };
  const skillGet = async (pageId) => {
    try {
      if (appInstances.isInstanceCardId(String(pageId))) return ok(await appInstances.detail(pageId));
      if (isTabCardId(pageId)) { const t = await tabCard(pageId); return ok({ ...tabCardOf(t), frontmatter: {}, body: t.description || '', files: [] }); }
      const { ref, item } = await bundleItem(pageId);
      const data = item.data ?? {};
      const files = (item.files ?? []).map((f) => ({ path: f.path, size: f.size }));
      return ok({
        ...bundleRowOf(ref.kind, ref.id, data, item.updatedAt, files.length),
        frontmatter: data.frontmatter ?? {}, body: data.body ?? '', files,
      });
    } catch (err) { return fail(err); }
  };
  const skillFileRead = async (pageId, rel) => {
    try {
      const { ref, item } = await bundleItem(pageId);
      const f = (item.files ?? []).find((x) => x.path === rel);
      if (!f) return { ok: false, error: `no file ${rel}` };
      const res = await fileGet(ref.kind, ref.id, rel);
      if (!res.ok) return { ok: false, error: `read ${rel}: HTTP ${res.status}` };
      const buf = new Uint8Array(await res.arrayBuffer());
      const binary = buf.subarray(0, 4096).includes(0);
      return ok({ text: binary ? '' : new TextDecoder().decode(buf), binary, size: buf.length });
    } catch (err) { return fail(err); }
  };
  /** The file that carries a bundle's manifest: task.json for a task, the
   *  plugin manifest for a plugin. */
  const MANIFEST_FILE = { task: 'task.json', plugin: '.claude-plugin/plugin.json' };
  /** Write files: upload the bytes, then re-put the record with the new
   *  manifest (and, for SKILL.md / task.json / plugin.json, the data it
   *  derives). `opts.enabled` sets the flag; `opts.patch` lands on the data
   *  (an install's origin); `opts.drop` names files the manifest loses. */
  const putBundleFiles = async (kind, id, item, writes, opts = {}) => {
    const at = now();
    const manifest = new Map((item?.files ?? []).map((f) => [f.path, { path: f.path, size: f.size, mtime: f.mtime, sha256: f.sha256 }]));
    for (const rel of opts.drop ?? []) manifest.delete(rel);
    const bytes = {};
    for (const [rel, text] of Object.entries(writes)) {
      bytes[rel] = bytesOf(rel, text);
      manifest.set(rel, { path: rel, size: bytes[rel].length, mtime: at, sha256: await sha256Hex(bytes[rel]) });
    }
    const files = [...manifest.values()];
    const data = { ...(item?.data ?? {}) };
    const manifestFile = MANIFEST_FILE[kind];
    if (manifestFile && writes[manifestFile] !== undefined) { try { data.manifest = JSON.parse(writes[manifestFile]); } catch { /* not json — the manifest field waits */ } }
    const skillMd = writes['SKILL.md'] ?? null;
    if (skillMd !== null || !item || (kind === 'plugin' && writes[manifestFile] !== undefined)) {
      const text = skillMd ?? '';
      Object.assign(data, bundleDataOf(kind, id, text, opts.enabled ?? data.enabled !== false, manifestFile ? data.manifest ?? null : null));
    }
    if (opts.enabled !== undefined) data.enabled = opts.enabled;
    if (opts.patch) Object.assign(data, opts.patch);
    data.type = kind;
    const res = await lib().put(kind, id, { data, files, updatedAt: at });
    if (!res.applied) throw new Error(STALE);
    const paths = Object.keys(writes);
    for (const rel of paths) {
      const r = await filePut(kind, id, rel, bytes[rel]);
      if (!r.ok) throw new Error(`upload ${rel}: HTTP ${r.status}`);
    }
    return res.item;
  };
  const skillFileWrite = async (pageId, rel, text) => {
    try {
      const { ref, item } = await bundleItem(pageId);
      await putBundleFiles(ref.kind, ref.id, item, { [String(rel)]: String(text) });
      return ok(true);
    } catch (err) { return fail(err); }
  };
  const skillCreate = async (rawName, kind = 'skill') => {
    try {
      const k = BUNDLE_KINDS[kind];
      if (!k) return { ok: false, error: NEEDS_DESKTOP };
      const name = String(rawName ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
      if (!name) return { ok: false, error: 'a skill needs a name' };
      try { await lib().get(k, name); return { ok: false, error: `a ${k} named "${name}" already exists` }; }
      catch (err) { if (!isNotFound(err)) throw err; }
      const md = `---\nname: ${name}\ndescription: What this ${k} is for, in one line — the agent reads this to decide when to use it.\n---\n\n# ${name}\n\nInstructions the agent follows when this ${k} applies.\n`;
      // The same template skills-fs.createSkill writes on the desktop.
      const writes = k === 'plugin'
        ? {
          '.claude-plugin/plugin.json': JSON.stringify({ name, description: 'What this plugin is for, in one line.', version: '0.1.0' }, null, 2) + '\n',
          'README.md': `# ${name}\n\nA Claude Code plugin: skills/, commands/, agents/, hooks/ and .mcp.json travel together.\n`,
          [`skills/${name}/SKILL.md`]: md,
        }
        : { 'SKILL.md': md };
      if (k === 'task') {
        writes['task.json'] = JSON.stringify({ name, program: 'run.js', slots: { main: { label: 'Main', description: 'The agent this task runs through.', agent: null } }, schedule: null, dependencies: { connections: [] } }, null, 2) + '\n';
        writes['run.js'] = `// A Glyphh task: the desktop runs this program itself. Agents only where it slots them.\n// A decision with fixed options: ctx.route(state, ["a", "b"], { minConfidence, fallback }) (Jev, deterministic).\nmodule.exports = async function run(ctx, input) {\n  const turn = await ctx.checkpoint("turn", () => ctx.agents.main.run("Say what this task should do."));\n  return { output: turn.text };\n};\n`;
        writes['package.json'] = JSON.stringify({ type: 'commonjs', private: true }, null, 2) + '\n';
      }
      const item = await putBundleFiles(k, name, null, writes, { enabled: true });
      return ok(bundleRowOf(k, name, item.data ?? {}, item.updatedAt, item.files?.length ?? Object.keys(writes).length));
    } catch (err) { return fail(err); }
  };
  const skillDelete = async (pageId, opts = {}) => {
    try {
      if (appInstances.isInstanceCardId(String(pageId))) return ok(await appInstances.remove(pageId, { purge: !!opts?.purge }));
      // A TAB ROW IS A LIBRARY ROW (his report, 2026-10-07: deleting an app on
      // the web answered "this runs on your desktop"): the record lives in the
      // cloud, so the web tombstones it like any row — nothing is on a desktop.
      if (isTabCardId(pageId)) {
        await lib().remove('tab', String(pageId).slice(TAB_CARD.length), { updatedAt: now() });
        return ok(true);
      }
      const ref = bundleOfPageId(String(pageId));
      if (!ref) return { ok: false, error: NEEDS_DESKTOP };
      await lib().remove(ref.kind, ref.id, { updatedAt: now() });
      return ok(true);
    } catch (err) { return isNotFound(err) ? ok(true) : fail(err); }
  };
  /** Settings → Apps → Rollback on the web: the same IPC name as the desktop's. */
  const appInstancePin = async (pageId, n) => {
    try { return ok(await appInstances.pin(pageId, n)); } catch (err) { return fail(err); }
  };
  /** Update one / all / the defaults (2026-10-07): the same IPC names as the desktop's. */
  const appInstanceUpdate = async (pageId) => {
    try { return ok(await appInstances.update(pageId)); } catch (err) { return fail(err); }
  };
  const appInstancesUpdateAll = async () => {
    try { return ok(await appInstances.updateAll()); } catch (err) { return fail(err); }
  };
  const skillSetEnabled = async (pageId, on) => {
    try {
      const { ref, item } = await bundleItem(pageId);
      const at = now();
      const data = { ...(item.data ?? {}), enabled: !!on };
      const res = await lib().put(ref.kind, ref.id, { data, files: item.files ?? [], updatedAt: at });
      if (!res.applied) return { ok: false, error: STALE };
      return ok(bundleRowOf(ref.kind, ref.id, data, at, item.files?.length ?? 0));
    } catch (err) { return fail(err); }
  };

  // ── Agents ────────────────────────────────────────────────────────────────
  const agentRow = (r) => (isAgentRow(r.data) ? { ...r.data, updatedAt: new Date(r.updatedAt).toISOString() } : null);
  const libraryAgentsList = async () => {
    try { return ok((await lib().list('agent')).map(agentRow).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))); }
    catch (err) { return fail(err); }
  };
  const readAgent = async (ref) => {
    try { const row = agentRow(await lib().get('agent', String(ref))); return row; }
    catch (err) { if (isNotFound(err)) return null; throw err; }
  };
  const libraryAgentGet = async (ref) => {
    try { const row = await readAgent(ref); return row ? ok(row) : { ok: false, error: `agent "${ref}" not found` }; }
    catch (err) { return fail(err); }
  };
  const saveAgent = async (input, slug) => {
    const existing = slug ? await readAgent(slug) : null;
    const at = now();
    const row = buildAgentRow({ ...(input ?? {}), ...(slug ? { slug } : {}) }, existing, new Date(at).toISOString());
    const res = await lib().put('agent', row.slug, { data: row, updatedAt: at });
    if (!res.applied) throw new Error(STALE);
    return row;
  };
  const libraryAgentCreate = async (input) => { try { return ok(await saveAgent(input, null)); } catch (err) { return fail(err); } };
  const libraryAgentUpdate = async (ref, patch) => { try { return ok(await saveAgent(patch, String(ref))); } catch (err) { return fail(err); } };
  const libraryAgentDelete = async (ref) => {
    try { await lib().remove('agent', String(ref), { updatedAt: now() }); return ok(true); }
    catch (err) { return isNotFound(err) ? ok(true) : fail(err); }
  };

  // ── Tasks (the Tasks page + the schedules picker) ─────────────────────────
  const taskSpecOf = (r) => {
    const d = r.data ?? {};
    const m = d.manifest ?? {};
    return {
      slug: r.id, name: m.name || d.name || r.id, description: d.description || '', program: m.program || 'run.js', icon: null,
      slots: Object.entries(m.slots ?? {}).map(([name, s]) => ({ name, ...(s?.label ? { label: s.label } : {}), ...(s?.description ? { description: s.description } : {}), agent: s?.agent ?? null, ...(s?.model ? { model: s.model } : {}) })),
      connections: (m.dependencies?.connections ?? []).map((c) => (typeof c === 'string' ? c : c?.app)).filter(Boolean),
      schedule: m.schedule ?? null, enabled: d.enabled !== false, dir: '',
    };
  };
  const tasksSpecs = async () => {
    try { return ok((await lib().list('task')).map(taskSpecOf).sort((a, b) => a.name.localeCompare(b.name))); }
    catch (err) { return fail(err); }
  };
  const taskSpec = async (slug) => {
    try { return ok(taskSpecOf(await lib().get('task', String(slug)))); }
    catch (err) { return fail(err); }
  };
  const taskSlotSet = async (slug, slot, agentId) => {
    try {
      const item = await lib().get('task', String(slug));
      const manifest = { ...(item.data?.manifest ?? {}) };
      manifest.slots = { ...(manifest.slots ?? {}), [slot]: { ...(manifest.slots?.[slot] ?? {}), agent: agentId ? String(agentId) : null } };
      await putBundleFiles('task', String(slug), item, { 'task.json': JSON.stringify(manifest, null, 2) + '\n' });
      return ok(taskSpecOf({ id: String(slug), data: { ...(item.data ?? {}), manifest } }));
    } catch (err) { return fail(err); }
  };

  // ── Drips (the Drips page: `{ name, recipe }` rows, strings back) ─────────
  const dripsList = async () => (await listRows('drip')).filter((r) => isDripData(r.data)).map((r) => dripRecordOf(r.id, r.data.recipe));
  const dripsSave = async (name, recipe) => {
    try {
      const rec = dripRecordOf(name, recipe);
      if (!rec.name) return 'a drip needs a name';
      if (!rec.recipe) return 'a drip needs at least one effect';
      const res = await lib().put('drip', rec.name, { data: rec, updatedAt: now() });
      return res.applied ? `saved drip "${rec.name}" → ${rec.recipe}` : `failed to save drip "${rec.name}": ${STALE}`;
    } catch (err) { return `failed to save drip "${dripId(name)}": ${err?.message ?? String(err)}`; }
  };
  const dripsDelete = async (name) => {
    const id = dripId(name);
    try { await lib().remove('drip', id, { updatedAt: now() }); return `deleted drip "${id}"`; }
    catch (err) { return isNotFound(err) ? `no custom drip "${id}"` : `failed to delete drip "${id}": ${err?.message ?? String(err)}`; }
  };

  // ── Schedules (the Schedules page's rows; the runs are the desktop's) ─────
  const agentNames = async () => {
    try { return new Map((await lib().list('agent')).filter((r) => isAgentRow(r.data)).map((r) => [r.id, r.data.name])); }
    catch { return new Map(); }
  };
  const schedulesList = async () => {
    try {
      const [rows, names] = await Promise.all([lib().list('schedule'), agentNames()]);
      return ok(rows.filter((r) => isScheduleData(r.data))
        .map((r) => scheduleViewOf(r.id, buildScheduleData(r.data), r.updatedAt, r.data.agentId ? names.get(r.data.agentId) ?? null : null))
        .sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) { return fail(err); }
  };
  const readSchedule = async (id) => {
    try { const item = await lib().get('schedule', String(id)); return isScheduleData(item.data) ? buildScheduleData(item.data) : null; }
    catch (err) { if (isNotFound(err)) return null; throw err; }
  };
  const newScheduleId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const scheduleSave = async (input) => {
    try {
      const existing = input?.id ? await readSchedule(input.id) : null;
      if (input?.id && !existing) return { ok: false, error: `schedule "${input.id}" not found` };
      const data = buildScheduleData(input ?? {}, existing);
      if (!isCronShape(data.cron)) return { ok: false, error: "that cron expression doesn't parse (five fields, e.g. 0 9 * * 1-5)" };
      if (!data.target) return { ok: false, error: 'a schedule needs something to run' };
      if (data.kind === 'skill' && !data.agentId) return { ok: false, error: 'a skill needs an agent to run through' };
      const id = input?.id ? String(input.id) : newScheduleId();
      const res = await lib().put('schedule', id, { data, updatedAt: now() });
      return res.applied ? ok({ id }) : { ok: false, error: STALE };
    } catch (err) { return fail(err); }
  };
  const scheduleSetEnabled = async (id, enabled) => {
    try {
      const existing = await readSchedule(id);
      if (!existing) return ok({ updated: false });
      const res = await lib().put('schedule', String(id), { data: { ...existing, enabled: !!enabled }, updatedAt: now() });
      return res.applied ? ok({ updated: true }) : { ok: false, error: STALE };
    } catch (err) { return fail(err); }
  };
  const scheduleDelete = async (id) => {
    try { await lib().remove('schedule', String(id), { updatedAt: now() }); return ok({ deleted: true }); }
    catch (err) { return isNotFound(err) ? ok({ deleted: true }) : fail(err); }
  };

  // ── The hub (main/hub-ipc.ts, on the web) ─────────────────────────────────
  // Every read is the route the desktop reads: the org's published items at
  // GET /api/library/<kind>, the Glyphh catalog at GET /api/hub/public, the
  // shelves at GET /api/hub/categories, an item's folder at …/payload. The
  // projections are hub-ipc's, field for field, so the Skills page paints
  // the same rows on both surfaces.
  const http = () => client.http;
  const HUB_KINDS = ['skill', 'app', 'plugin', 'task'];
  const kindOf = (k) => (HUB_KINDS.includes(k) ? k : 'skill');
  const kindsOf = (k) => (Array.isArray(k) ? [...new Set(k.map(kindOf))] : [kindOf(k)]);
  const orgList = (k) => http().get(`/api/library/${k}`).then((r) => (Array.isArray(r) ? r : [])).catch(() => []);
  const pubList = () => http().get('/api/hub/public').then((r) => (Array.isArray(r) ? r : [])).catch(() => []);
  const baseFor = (from, kind, itemId) => (from === 'org' ? `/api/library/${kind}/${encodeURIComponent(itemId)}` : `/api/hub/public/${encodeURIComponent(itemId)}`);
  /** A catalog row's LIVE version, or 0 while nothing of it is approved. */
  const versionOf = (r) => Number(r?.headVersion ?? r?.version ?? 0);
  const slugOfPageId = (pageId) => String(pageId).slice(String(pageId).indexOf(':') + 1).toLowerCase();
  const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

  /** Every bundle this member holds here, by kind — the honest "already yours". */
  const mineRows = async () => {
    const out = [];
    for (const k of Object.values(BUNDLE_KINDS)) for (const r of await listRows(k)) out.push({ kind: k, id: r.id, data: r.data ?? {} });
    return out;
  };
  const skillsDiscover = async (kind) => {
    try {
      const kinds = kindsOf(kind);
      const [orgLists, pub, mine, instances] = await Promise.all([
        Promise.all(kinds.map(async (k) => [k, await orgList(k)])),
        pubList(),
        mineRows(),
        kinds.includes('app') ? appInstances.listInstances() : Promise.resolve([]),
      ]);
      // ALREADY YOURS IS NOT THE SAME AS ADDABLE (his report, 2026-09-18): the
      // library row is the honest answer, the hub's `installed` only counts installs.
      // ON THE WEB ONLY THE LIBRARY ROW SAYS INSTALLED (his report, 2026-10-05: a
      // plugin read "Added" that was nowhere in his plugins — the hub's flag was
      // another device's folder install from before plugins were a library kind).
      const have = new Set(mine.map((m) => `${m.kind}:${m.id.toLowerCase()}`));
      // AN APP IS INSTALLED WHEN THE MEMBER HAS AN INSTANCE OF IT (his report,
      // 2026-10-07: Discover "has no idea it is already installed").
      for (const i of instances) have.add(`app:${String(i.slug || '').toLowerCase()}`);
      const has = (k, slug) => have.has(`${k}:${String(slug || '').toLowerCase()}`);
      const rows = [];
      for (const [k, org] of orgLists) {
        for (const it of org) {
          if (!it.headVersion) continue;
          rows.push({ ref: `org:${it.id}`, from: 'org', id: it.id, slug: it.slug, name: it.name, description: it.description, author: it.author || '', version: it.headVersion, installed: has(k, it.slug), installs: it.installs ?? 0, updatedAt: it.updatedAt, createdAt: it.createdAt || it.updatedAt, categories: it.categories ?? [], icon: it.icon ?? null, tool: houseToolOfSlug(k, it.slug), type: k });
        }
      }
      for (const p of pub.filter((x) => kinds.includes(x.kind))) {
        rows.push({ ref: `glyphh:${p.id}`, from: 'glyphh', id: p.id, slug: p.slug, name: p.name, description: p.description, author: p.sourceOrg, version: p.version, installed: has(p.kind, p.slug), installs: p.installs ?? 0, updatedAt: p.updatedAt, createdAt: p.createdAt || p.updatedAt, categories: p.categories ?? [], icon: p.icon ?? null, tool: houseToolOfSlug(p.kind, p.slug), type: p.kind });
      }
      return ok(rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
    } catch (err) { return fail(err); }
  };
  const hubCategories = async () => {
    try { const r = await http().get('/api/hub/categories').catch(() => []); return ok(Array.isArray(r) ? r : []); }
    catch (err) { return fail(err); }
  };
  const payloadOf = async (base, version) => {
    const p = await http().get(`${base}/payload${version ? `?version=${version}` : ''}`);
    return p && typeof p === 'object' ? p : {};
  };
  const skillHubFiles = async (ref, kind) => {
    try {
      const [from, itemId] = String(ref).split(':', 2);
      return ok(hubPayloadFiles('skill', '', await payloadOf(baseFor(from, kindOf(kind), itemId))));
    } catch (err) { return fail(err); }
  };
  /** The catalog row behind a ref, from the list the desktop reads too. */
  const catalogMeta = async (from, kind, itemId) => {
    const rows = from === 'org' ? await orgList(kind) : await pubList();
    const meta = rows.find((r) => r.id === itemId);
    if (!meta) throw new Error(`that ${kind} is no longer available to you`);
    return meta;
  };
  /** AN APP IS A CLOUD INSTANCE (his order, 2026-10-06): a hub app becomes
   *  this member's personal instance, made server-side; the card is the id. */
  const appInstall = async (itemId) => ok({ id: instanceCardId((await appInstances.installFromHub(itemId)).key) });
  /** INSTALL = A PUT INTO THIS LIBRARY (his rule, 2026-10-04; his report,
   *  2026-10-05): the hub item's files go to R2 under the member's record,
   *  the record carries where it came from, and the desktop's sync lands it
   *  as a folder on the machine. An app installs in the cloud (appInstall). */
  const skillInstall = async (ref, kind) => {
    try {
      const k = kindOf(kind);
      const [from, itemId] = String(ref).split(':', 2);
      if (from !== 'org' && from !== 'glyphh') return { ok: false, error: `not a hub item: ${ref}` };
      const meta = await catalogMeta(from, k, itemId);
      if (k === 'app') return await appInstall(itemId);
      const base = baseFor(from, k, itemId);
      const files = hubPayloadFiles(meta.slug, meta.description || '', await payloadOf(base));
      if (k === 'plugin' && !files['.claude-plugin/plugin.json']) return { ok: false, error: 'a plugin needs .claude-plugin/plugin.json' };
      if (k !== 'plugin' && !files['SKILL.md']) return { ok: false, error: `a ${k} needs a SKILL.md` };
      const id = String(meta.slug || '');
      if (!NAME_RE.test(id)) return { ok: false, error: `bad ${k} name: ${id}` };
      let existing = null;
      try { existing = await lib().get(k, id); } catch (err) { if (!isNotFound(err)) throw err; }
      const author = from === 'glyphh' ? 'Glyphh' : (meta.author || 'your organization');
      const origin = { from, itemId, kind: k, slug: meta.slug, version: versionOf(meta), files: Object.keys(files), installedAt: new Date().toISOString(), author };
      // A reinstall takes the catalog's folder whole: what the last install wrote and the payload dropped goes.
      const drop = (existing?.data?.origin?.files ?? []).filter((f) => !(f in files));
      await putBundleFiles(k, id, existing, files, { enabled: true, patch: { origin }, drop });
      await http().post(`${base}/install`, {}).catch(() => undefined); // the hub's install count; the record is the truth
      return ok({ id: bundlePageId(k, id) });
    } catch (err) { return fail(err); }
  };
  /** Every catalog row this member can see, by kind, org rows first (hub-ipc.catalogRows). */
  const catalogRows = async (kinds) => {
    const [orgLists, pub] = await Promise.all([Promise.all(kinds.map(async (k) => [k, await orgList(k)])), pubList()]);
    const out = [];
    for (const [k, rows] of orgLists) for (const row of rows) out.push({ from: 'org', kind: k, row });
    for (const row of pub) if (row.kind && kinds.includes(row.kind)) out.push({ from: 'glyphh', kind: row.kind, row });
    return out;
  };
  /** Where a bundle came from: the origin the install recorded, else the
   *  catalog row with its slug or name (hub-ipc.originFor). */
  const originFor = (m, catalog) => {
    const recorded = m.data?.origin;
    if (recorded && typeof recorded === 'object' && recorded.itemId) return recorded;
    const slug = m.id.toLowerCase();
    const rows = catalog.filter((c) => versionOf(c.row) > 0);
    const hit = rows.find((c) => c.kind === m.kind && c.row.slug?.toLowerCase() === slug)
      ?? rows.find((c) => c.kind === m.kind && c.row.name?.toLowerCase() === slug);
    if (!hit) return null;
    return { from: hit.from, itemId: hit.row.id, kind: m.kind, slug: hit.row.slug, version: 0, files: [], installedAt: '' };
  };
  const standingsOf = async () => {
    const out = {};
    const mine = await mineRows();
    if (!mine.length) return out;
    const catalog = await catalogRows([...new Set(mine.map((m) => m.kind))]);
    if (!catalog.length) return out;
    for (const m of mine) {
      const o = originFor(m, catalog);
      if (!o) continue;
      const hit = catalog.find((c) => c.from === o.from && c.kind === m.kind && c.row.id === o.itemId);
      if (!hit) continue;
      out[bundlePageId(m.kind, m.id)] = {
        from: o.from,
        sourceName: o.from === 'org' ? "your organization's hub" : 'the Glyphh catalog',
        name: hit.row.name,
        have: Number(o.version || 0),
        latest: versionOf(hit.row),
      };
    }
    return out;
  };
  const skillStandings = async () => { try { return ok(await standingsOf()); } catch (err) { return fail(err); } };
  const skillUpdates = async () => {
    try {
      const out = {};
      for (const [id, st] of Object.entries(await standingsOf())) if (st.latest > 0 && st.latest > st.have) out[id] = { have: st.have, latest: st.latest, name: st.name };
      return ok(out);
    } catch (err) { return fail(err); }
  };
  /** Take the catalog's current version over this copy: the payload's files
   *  are written, what the last install wrote and the payload dropped goes,
   *  anything the member added stays (hub-ipc.update). */
  const skillUpdate = async (pageId) => {
    try {
      const { ref, item } = await bundleItem(pageId);
      const o = originFor({ kind: ref.kind, id: ref.id, data: item.data ?? {} }, await catalogRows([ref.kind]));
      if (!o) return { ok: false, error: 'no catalog item matches this one by slug, so there is nothing to update from' };
      const meta = await catalogMeta(o.from, ref.kind, o.itemId);
      const base = baseFor(o.from, ref.kind, o.itemId);
      const files = hubPayloadFiles(meta.slug, meta.description || '', await payloadOf(base));
      const version = versionOf(meta);
      const drop = (o.files ?? []).filter((f) => !(f in files));
      await putBundleFiles(ref.kind, ref.id, item, files, { patch: { origin: { ...o, version, files: Object.keys(files) } }, drop });
      return ok({ version });
    } catch (err) { return fail(err); }
  };
  /** The org item behind a library record: the one whose slug is the record's id, else its name. */
  const orgItemFor = async (kind, id, name) => {
    const items = await orgList(kind);
    return items.find((it) => it.slug?.toLowerCase() === id.toLowerCase() || it.name === name) ?? null;
  };
  const skillShares = async () => {
    try {
      const out = {};
      const mine = await mineRows();
      const kinds = [...new Set(mine.map((m) => m.kind))];
      const byKind = new Map(await Promise.all(kinds.map(async (k) => [k, await orgList(k)])));
      for (const m of mine) {
        const hit = (byKind.get(m.kind) ?? []).find((it) => it.slug?.toLowerCase() === m.id.toLowerCase() || it.name === m.data.name);
        if (!hit) continue;
        const state = { head: hit.headVersion ?? null, pending: hit.pendingVersion ?? null, rejected: hit.rejectedVersion ?? null };
        if (state.head || state.pending || state.rejected) out[bundlePageId(m.kind, m.id)] = state;
      }
      // An app INSTANCE's share stands on its slug's org item (2026-10-07).
      const apps = byKind.get('app') ?? await orgList('app');
      for (const inst of await appInstances.listInstances().catch(() => [])) {
        const hit = apps.find((it) => it.slug?.toLowerCase() === String(inst.slug || '').toLowerCase());
        if (!hit) continue;
        const state = { head: hit.headVersion ?? null, pending: hit.pendingVersion ?? null, rejected: hit.rejectedVersion ?? null };
        if (state.head || state.pending || state.rejected) out[`app-instance:${inst.key}`] = state;
      }
      return ok(out);
    } catch (err) { return fail(err); }
  };
  /** The slug + name a page id stands for on the hub: a record's, or an instance's (2026-10-07). */
  const hubIdentity = async (pageId) => {
    if (appInstances.isInstanceCardId(String(pageId))) {
      const inst = await appInstances.find(pageId);
      return { kind: 'app', id: inst.slug, name: String(inst.manifest?.name || inst.slug) };
    }
    const { ref, item } = await bundleItem(pageId);
    return { kind: ref.kind, id: ref.id, name: item.data?.name };
  };
  const skillWithdraw = async (pageId) => {
    try {
      const ref = await hubIdentity(pageId);
      const hit = await orgItemFor(ref.kind, ref.id, ref.name);
      if (!hit) return { ok: false, error: "this one isn't on your organization's hub" };
      const r = await http().del(`/api/library/${ref.kind}/${encodeURIComponent(hit.id)}/submission`);
      return ok({ withdrawn: Number(r?.withdrawn ?? 0) });
    } catch (err) { return fail(err); }
  };
  const skillVersions = async (pageId) => {
    try {
      const ref = await hubIdentity(pageId);
      const kind = ref.kind;
      const hit = await orgItemFor(kind, ref.id, ref.name);
      if (!hit) return ok({ itemId: null, kind, versions: [], head: null, pending: null, declined: null, changes: null, lifecycle: 'live', lifecycleNote: '', visibility: 'org', own: false, categories: [] });
      const rows = await http().get(`/api/library/${kind}/${encodeURIComponent(hit.id)}/versions`).catch(() => []);
      const list = (Array.isArray(rows) ? rows : []).map((r) => ({ version: r.version, notes: r.notes || '', createdAt: r.created_at, status: r.status || 'approved', reviewSummary: r.review_summary || '', decisionNote: r.decision_note || '' }));
      // A DECLINE IS NEWS (his order, 2026-09-17): the newest rejected version counts while nothing newer stands.
      const newest = list[0];
      const declined = newest && newest.status === 'rejected' ? { version: newest.version, summary: newest.reviewSummary } : null;
      // CHANGES REQUESTED is a standing of its own (2026-10-07) — the desktop's versionsFor.
      const changesRow = list.find((v) => v.status === 'changes');
      let me = '';
      try { me = String((await client.me())?.userId || ''); } catch { me = ''; }
      return ok({
        itemId: hit.id, kind, versions: list, declined, head: hit.headVersion ?? null, pending: hit.pendingVersion ?? null,
        changes: hit.changesVersion ? { version: hit.changesVersion, note: changesRow?.decisionNote || hit.decisionNote || '' } : null,
        lifecycle: hit.lifecycle || 'live', lifecycleNote: hit.lifecycleNote || '', visibility: hit.visibility || 'org', own: !!me && hit.createdBy === me,
        categories: Array.isArray(hit.categories) ? hit.categories : [],
      });
    } catch (err) { return fail(err); }
  };
  // THE REVIEW THREAD, THE LIFECYCLE, THE PUBLIC LANE, THE DESK (2026-10-07) — the desktop's hub-ipc names.
  const versionIdOf = async (kind, itemId, version) => {
    const rows = await http().get(`/api/library/${kindOf(kind)}/${encodeURIComponent(itemId)}/versions`).catch(() => []);
    const hit = (Array.isArray(rows) ? rows : []).find((r) => r.version === Number(version) && r.id);
    if (hit?.id) return hit.id;
    const head = await http().get(`/api/library/${kindOf(kind)}/${encodeURIComponent(itemId)}/head`).catch(() => ({ versionId: null }));
    if (!head?.versionId) throw new Error(`no version ${version} to open a thread on`);
    return head.versionId;
  };
  const skillComments = async (ref) => {
    try {
      const vid = ref?.versionId || await versionIdOf(ref?.kind, String(ref?.itemId || ''), Number(ref?.version || 0));
      return ok(await http().get(`/api/library/versions/${encodeURIComponent(vid)}/comments`));
    } catch (err) { return fail(err); }
  };
  const skillCommentAdd = async (versionId, body) => {
    try { return ok(await http().post(`/api/library/versions/${encodeURIComponent(String(versionId))}/comments`, { body: String(body ?? '') })); }
    catch (err) { return fail(err); }
  };
  const skillLifecycle = async (itemId, kind, state, note) => {
    try { return ok(await http().post(`/api/library/${kindOf(kind)}/${encodeURIComponent(String(itemId))}/lifecycle`, { state: state === 'retired' || state === 'removed' ? state : 'live', ...(note ? { note: String(note) } : {}) })); }
    catch (err) { return fail(err); }
  };
  const skillSubmitPublic = async (itemId, kind, notes) => {
    try { return ok(await http().post(`/api/library/${kindOf(kind)}/${encodeURIComponent(String(itemId))}/public`, { notes: String(notes ?? '') })); }
    catch (err) { return fail(err); }
  };
  const skillWithdrawPublic = async (itemId, kind) => {
    try { return ok(await http().del(`/api/library/${kindOf(kind)}/${encodeURIComponent(String(itemId))}/public`)); }
    catch (err) { return fail(err); }
  };
  const libraryQueue = async () => {
    try { const rows = await http().get('/api/library/queue'); return ok(Array.isArray(rows) ? rows : []); }
    catch (err) { return fail(err); }
  };
  const libraryDecide = async (versionId, verdict, note) => {
    try { return ok(await http().post(`/api/library/versions/${encodeURIComponent(String(versionId))}/decide`, { verdict: verdict === 'approve' || verdict === 'reject' ? verdict : 'changes', note: String(note ?? '') })); }
    catch (err) { return fail(err); }
  };
  const libraryVersionFiles = async (versionId) => {
    try {
      const v = await http().get(`/api/library/versions/${encodeURIComponent(String(versionId))}`);
      const p = v?.payload && typeof v.payload === 'object' ? v.payload : {};
      const files = p.files && typeof p.files === 'object' ? p.files : null;
      return ok(files ?? { 'SKILL.md': typeof p.prompt === 'string' ? p.prompt : '' });
    } catch (err) { return fail(err); }
  };
  const appInstanceReleases = async (pageId) => {
    try { return ok(await appInstances.releases(pageId)); } catch (err) { return fail(err); }
  };
  const skillVersionFiles = async (itemId, version, kind) => {
    try {
      const payload = await payloadOf(`/api/library/${kindOf(kind)}/${encodeURIComponent(String(itemId))}`, Number(version));
      const files = payload.files && typeof payload.files === 'object' ? payload.files : null;
      return ok(files ?? { 'SKILL.md': typeof payload.prompt === 'string' ? payload.prompt : '' });
    } catch (err) { return fail(err); }
  };
  const skillCategoriesSet = async (itemId, kind, ids) => {
    try {
      const categories = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
      await http().post(`/api/library/${kindOf(kind)}/${encodeURIComponent(String(itemId))}/categories`, { categories });
      return ok(categories);
    } catch (err) { return fail(err); }
  };
  /** SHARE = PROMOTE (hub-ipc.publish): the record's files, read back off R2,
   *  go to the org's hub as text; a binary file stops it, as on the desktop. */
  /** A folder share's media (the desktop's hub-ipc withFolderMedia): files beside the bundle + the icon and screenshots on <kind>.json. */
  const withFolderMedia = (kind, files, media) => {
    if (!media || (!media.icon && !(media.screenshots?.length))) return files;
    const out = { ...files };
    const manifestName = kind === 'app' || kind === 'task' ? `${kind}.json` : null;
    let manifest = {};
    if (manifestName) { try { manifest = JSON.parse(out[manifestName] || '{}'); } catch { manifest = {}; } }
    if (media.icon) { out['icon.svg'] = media.icon; manifest.icon = 'icon.svg'; }
    if (media.screenshots?.length) {
      for (const k of Object.keys(out)) if (k.startsWith('screenshots/')) delete out[k];
      manifest.screenshots = media.screenshots.map((s) => { out[`screenshots/${s.name}`] = s.dataUrl; return { path: `screenshots/${s.name}`, caption: s.caption ?? '' }; });
    }
    if (manifestName) out[manifestName] = JSON.stringify({ name: '', ...manifest }, null, 2);
    return out;
  };
  const skillPublish = async (pageId, notes = '', media) => {
    try {
      // SHARE TO PUBLISH an app INSTANCE (2026-10-07): the server promotes its pinned release by key.
      if (appInstances.isInstanceCardId(String(pageId))) return ok(await appInstances.share(pageId, notes, media));
      const { ref, item } = await bundleItem(pageId);
      const paths = (item.files ?? []).map((f) => f.path);
      const files = {};
      let bytes = 0;
      if (paths.length) {
        for (const rel of paths) {
          const res = await fileGet(ref.kind, ref.id, rel);
          if (!res.ok) throw new Error(`read ${rel}: HTTP ${res.status}`);
          const buf = new Uint8Array(await res.arrayBuffer());
          if (buf.subarray(0, 4096).includes(0)) throw new Error(`"${rel}" is binary — the hub carries text files only (put assets behind a URL)`);
          bytes += buf.length;
          if (bytes > 900_000) throw new Error(`this ${ref.kind}'s files exceed the hub's 1 MB text limit`);
          files[rel] = new TextDecoder().decode(buf);
        }
      }
      const data = item.data ?? {};
      const { body } = parseSkillMd(files['SKILL.md'] || '');
      const name = data.name || ref.id;
      const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'skill';
      const r = await http().post(`/api/library/${ref.kind}/promote`, {
        slug, name, description: data.description || '', notes: String(notes ?? ''), payload: { files: withFolderMedia(ref.kind, files, media), prompt: body, manifest: data.frontmatter ?? {} },
      });
      return ok(r);
    } catch (err) { return fail(err); }
  };

  const needsDesktop = async () => ({ ok: false, error: NEEDS_DESKTOP });
  const emptyList = async () => ok([]);

  /** An instance's card opens as its tab; anything else needs the desktop's folder. */
  const skillTab = async (pageId) => {
    // OPEN ON THE WEB OPENS THE WEB PANEL (his report, 2026-10-05: Open
    // "opens the local desktop and then opens that app there instead of
    // opening the web panel"): a house app's tab answers its TOOL so the
    // page opens the built-in panel here; a cloud instance's tab is marked
    // `cloud` so the page opens it as a web panel, never on the desktop.
    if (isTabCardId(pageId)) {
      try {
        const t = await tabCard(pageId);
        const tool = houseToolOf(t);
        return ok({ slug: t.slug, name: t.name, ...(tool ? { tool } : {}), cloud: !t.nativeRef });
      } catch (err) { return fail(err); }
    }
    if (!appInstances.isInstanceCardId(String(pageId))) return { ok: false, error: NEEDS_DESKTOP };
    try { return ok({ ...(await appInstances.tab(pageId)), cloud: true }); } catch (err) { return fail(err); }
  };

  return {
    layoutsList, layoutsSaveGrid, layoutsDelete,
    panelAppsList, panelAppsCreate, panelAppsUpdate, panelAppsDelete,
    glyphhAppPreviewOpen, glyphhAppPreviewClear, skillTab,
    skillsList, skillGet, skillFileRead, skillFileWrite, skillCreate, skillDelete, skillSetEnabled, appInstancePin, appInstanceUpdate, appInstancesUpdateAll, appInstanceReleases, skillComments, skillCommentAdd, skillLifecycle, skillSubmitPublic, skillWithdrawPublic, libraryQueue, libraryDecide, libraryVersionFiles,
    // A bundle's own agents (agents/*.md) are read off the folder on the desktop; the record carries none.
    skillAgents: emptyList,
    skillAgentSet: needsDesktop,
    // What touches the machine: its folders, its dialogs, its tabs.
    skillReveal: needsDesktop, skillImport: needsDesktop, skillReplace: needsDesktop, skillDownload: needsDesktop,
    skillAdopt: needsDesktop, skillImage: needsDesktop,
    skillsHome: async () => ({ ok: false, error: NEEDS_DESKTOP }),
    libraryAgentsList, libraryAgentGet, libraryAgentCreate, libraryAgentUpdate, libraryAgentDelete,
    // An agent's schedules are rows on the desktop's clock.
    libraryAgentTasks: emptyList, libraryAgentTaskAdd: needsDesktop, libraryAgentTaskUpdate: needsDesktop,
    libraryAgentTaskRunNow: needsDesktop, libraryAgentTaskRuns: emptyList, libraryAgentTaskRunning: async () => ok(false),
    tasksSpecs, taskSpec, taskSlotSet,
    // Runs happen on the desktop: nothing to list here, nothing to start.
    taskRun: needsDesktop, taskRuns: emptyList, taskRunGet: needsDesktop, taskRunCancel: needsDesktop,
    // THE HUB ON THE WEB (his report, 2026-10-05): the same routes as the
    // desktop's hub-ipc lane; an install is a put into this library.
    skillsDiscover, skillUpdates, skillShares, skillStandings, skillVersions,
    hubCategories, skillInstall, skillUpdate, skillHubFiles, skillCategoriesSet,
    skillPublish, skillWithdraw, skillVersionFiles,
    dripsList, dripsSave, dripsDelete,
    // The schedules are records here; the RUNS are the desktop's clock until
    // the cloud clock exists (schedules.ts says so on the page).
    schedulesList, scheduleSave, scheduleDelete, scheduleSetEnabled,
    scheduleRecentRuns: emptyList, scheduleRuns: emptyList,
    scheduleRunNow: async () => ({ ok: false, error: NEEDS_DESKTOP }),
  };
}
