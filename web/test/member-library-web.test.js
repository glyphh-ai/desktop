/**
 * member-library-web.test.js — the web's member library (member-library-web.js):
 * reads the server first, writes the server at this client's clock, and moves a
 * skill's files through the presigned URLs. Pure over the fake SDK + a fake fetch.
 */
import { describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { buildMemberLibrary, NEEDS_DESKTOP } from '../src/member-library-web.js';
import { fakeLibrary, seededLibrary } from './helpers/member-library.js';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const SKILL_MD = '---\nname: notes\ndescription: Keep notes\nauthor: me\n---\n\n# notes\n\nWrite things down.\n';
const skillSeed = () => fakeLibrary({
  skill: [{ id: 'notes', updatedAt: 5_000, data: { name: 'notes', description: 'Keep notes', frontmatter: { name: 'notes', description: 'Keep notes', author: 'me' }, body: '# notes\n', enabled: true, type: 'skill' },
    files: [{ path: 'SKILL.md', size: SKILL_MD.length, mtime: 5_000, sha256: 'abc' }, { path: 'scripts/run.sh', size: 3, mtime: 5_000, sha256: 'def' }] }],
  task: [{ id: 'digest', updatedAt: 6_000, data: { name: 'digest', description: 'Daily digest', frontmatter: {}, body: '', enabled: false, type: 'task', manifest: { name: 'digest', program: 'run.js', slots: { main: { label: 'Main', agent: null } }, schedule: '0 9 * * *', dependencies: { connections: [{ app: 'gmail', as: 'me' }] } } },
    files: [{ path: 'SKILL.md', size: 10, mtime: 6_000, sha256: 'x' }, { path: 'task.json', size: 10, mtime: 6_000, sha256: 'y' }, { path: 'run.js', size: 10, mtime: 6_000, sha256: 'z' }] }],
});

/** A fake R2: PUTs land in `stored`, GETs serve it (or the seed text). */
function fakeR2(seedText = {}) {
  const stored = new Map(Object.entries(seedText));
  const fetchImpl = vi.fn(async (url, init = {}) => {
    // The server's byte doors (his report, 2026-10-05): GET/PUT /api/library/v2/<kind>/<id>/files/<path>.
    const m = /^https:\/\/api\/api\/library\/v2\/[^/]+\/[^/]+\/files\/(.+)$/.exec(url);
    if (!m) return { ok: false, status: 400, arrayBuffer: async () => new ArrayBuffer(0) };
    if (!(init.headers && /^Bearer /.test(init.headers.authorization || ''))) return { ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) };
    if ((init.method || 'GET') === 'PUT') { stored.set(decodeURIComponent(m[1]), new TextDecoder().decode(init.body)); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }; }
    const text = stored.get(decodeURIComponent(m[1]));
    if (text === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
  });
  return { stored, fetchImpl };
}

describe('skills and tasks on web — list and view from the server', () => {
  it('skillsList answers the Skills page rows for the kinds the server holds, none for the machine kinds', async () => {
    const lib = buildMemberLibrary({ memberLibrary: skillSeed() });
    const r = await lib.skillsList(['skill', 'app', 'task', 'plugin']);
    expect(r.ok).toBe(true);
    expect(r.data.map((x) => x.id)).toEqual(['task:digest', 'glyphh:notes']); // newest first
    expect(r.data[1]).toMatchObject({ source: 'glyphh', type: 'skill', name: 'notes', description: 'Keep notes', author: 'me', enabled: true, updatedAt: new Date(5_000).toISOString() });
    expect(r.data[0]).toMatchObject({ source: 'task', type: 'task', enabled: false });
    expect((await lib.skillsList('app')).data).toEqual([]);
  });

  it('skillGet is the detail (frontmatter, body, the file manifest) without a download', async () => {
    const api = skillSeed();
    const lib = buildMemberLibrary({ memberLibrary: api });
    const r = await lib.skillGet('glyphh:notes');
    expect(r).toMatchObject({ ok: true, data: { id: 'glyphh:notes', frontmatter: { author: 'me' }, body: '# notes\n', files: [{ path: 'SKILL.md' }, { path: 'scripts/run.sh' }], fileCount: 2 } });
    expect(await lib.skillGet('claude:other')).toMatchObject({ ok: false, error: /not a library skill/ });
    expect(api.files).not.toHaveBeenCalled();
  });

  it('tasksSpecs / taskSpec project the task.json the record carries', async () => {
    const lib = buildMemberLibrary({ memberLibrary: skillSeed() });
    const r = await lib.tasksSpecs();
    expect(r.data).toEqual([{ slug: 'digest', name: 'digest', description: 'Daily digest', program: 'run.js', icon: null, slots: [{ name: 'main', label: 'Main', agent: null }], connections: ['gmail'], schedule: '0 9 * * *', enabled: false, dir: '' }]);
    expect((await lib.taskSpec('digest')).data.slug).toBe('digest');
    expect(await lib.taskSpec('nope')).toMatchObject({ ok: false });
  });
});

describe('skills on web — files through the presigned URLs, the record re-put', () => {
  it('skillFileRead downloads the one file from its GET url', async () => {
    const { fetchImpl } = fakeR2({ 'scripts/run.sh': '#!/bin/sh\necho hi\n' });
    const lib = buildMemberLibrary({ memberLibrary: skillSeed(), token: async () => 'tok', token: async () => 'tok' }, { apiUrl: 'https://api', fetchImpl, apiUrl: 'https://api' });
    expect(await lib.skillFileRead('glyphh:notes', 'scripts/run.sh')).toEqual({ ok: true, data: { text: '#!/bin/sh\necho hi\n', binary: false, size: 18 } });
    expect(fetchImpl.mock.calls.map((c) => c[0])).toContain('https://api/api/library/v2/skill/notes/files/scripts/run.sh');
    expect(await lib.skillFileRead('glyphh:notes', 'missing.txt')).toMatchObject({ ok: false, error: /no file/ });
  });

  it('skillFileWrite uploads to the PUT url and re-puts the record with the new manifest (SKILL.md re-derives the data)', async () => {
    const api = skillSeed();
    const { stored, fetchImpl } = fakeR2();
    const lib = buildMemberLibrary({ memberLibrary: api, token: async () => 'tok' }, { apiUrl: 'https://api', fetchImpl, now: () => 9_000 });
    const md = '---\nname: notes\ndescription: Keep BETTER notes\n---\n\nBody.\n';
    expect(await lib.skillFileWrite('glyphh:notes', 'SKILL.md', md)).toEqual({ ok: true, data: true });
    expect(stored.get('SKILL.md')).toBe(md);
    const put = api.put.mock.calls.at(-1);
    expect(put[0]).toBe('skill'); expect(put[1]).toBe('notes'); expect(put[2].updatedAt).toBe(9_000);
    expect(put[2].data).toMatchObject({ description: 'Keep BETTER notes', body: '\nBody.\n', enabled: true, type: 'skill' }); // the body keeps its leading blank line, as skills-fs reads it
    const entry = put[2].files.find((f) => f.path === 'SKILL.md');
    expect(entry).toMatchObject({ size: new TextEncoder().encode(md).length, mtime: 9_000 });
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(put[2].files.find((f) => f.path === 'scripts/run.sh')).toMatchObject({ sha256: 'def' }); // untouched files keep their manifest entry
    // The put happened BEFORE the upload: a stale clock never uploads bytes nobody indexed.
    const putAt = api.put.mock.invocationCallOrder.at(-1);
    const uploadAt = fetchImpl.mock.invocationCallOrder.find((_, i) => fetchImpl.mock.calls[i][1]?.method === 'PUT');
    expect(putAt).toBeLessThan(uploadAt);
  });

  it('a stale clock is said, not silently lost', async () => {
    const api = skillSeed();
    const lib = buildMemberLibrary({ memberLibrary: api, token: async () => 'tok' }, { apiUrl: 'https://api', fetchImpl: fakeR2().fetchImpl, now: () => 1 });
    expect(await lib.skillFileWrite('glyphh:notes', 'SKILL.md', 'x')).toMatchObject({ ok: false, error: /newer copy/ });
  });

  it('skillCreate makes the standard folder (a task gets its task.json, run.js and package.json) and uploads every file', async () => {
    const api = fakeLibrary();
    const { stored, fetchImpl } = fakeR2();
    const lib = buildMemberLibrary({ memberLibrary: api, token: async () => 'tok' }, { apiUrl: 'https://api', fetchImpl });
    const r = await lib.skillCreate('My Task!', 'task');
    expect(r).toMatchObject({ ok: true, data: { id: 'task:my-task', type: 'task', fileCount: 4 } });
    expect([...stored.keys()].sort()).toEqual(['SKILL.md', 'package.json', 'run.js', 'task.json']);
    expect(JSON.parse(stored.get('task.json'))).toMatchObject({ name: 'my-task', program: 'run.js' });
    expect(api.rows.get('task:my-task').data).toMatchObject({ type: 'task', enabled: true, manifest: { name: 'my-task' } });
    expect(await lib.skillCreate('My Task!', 'task')).toMatchObject({ ok: false, error: /already exists/ });
    // A plugin is a record too since 2026-10-05 (his report): the desktop's template, put here.
    expect(await lib.skillCreate('x', 'plugin')).toMatchObject({ ok: true, data: { id: 'plugin:x', type: 'plugin', fileCount: 3 } });
  });

  it('skillSetEnabled and skillDelete write the server; the machine actions answer so', async () => {
    const api = skillSeed();
    const lib = buildMemberLibrary({ memberLibrary: api }, { now: () => 10_000 });
    expect(await lib.skillSetEnabled('task:digest', true)).toMatchObject({ ok: true, data: { enabled: true } });
    expect(api.rows.get('task:digest').data.enabled).toBe(true);
    expect(await lib.skillDelete('glyphh:notes')).toEqual({ ok: true, data: true });
    expect(api.rows.get('skill:notes').deletedAt).toBeTruthy();
    expect(await lib.skillDelete('glyphh:notes')).toEqual({ ok: true, data: true }); // already gone = done
    for (const name of ['skillReveal', 'skillImport', 'skillReplace', 'skillDownload', 'skillAdopt', 'skillTab']) {
      expect(await lib[name]('glyphh:x')).toEqual({ ok: false, error: NEEDS_DESKTOP });
    }
    expect(await lib.skillAgents('glyphh:x')).toEqual({ ok: true, data: [] });
  });

  it('taskSlotSet rewrites task.json through the same file lane', async () => {
    const api = skillSeed();
    const { stored } = fakeR2();
    const lib = buildMemberLibrary({ memberLibrary: api, token: async () => 'tok' }, { apiUrl: 'https://api', fetchImpl: fakeR2().fetchImpl, now: () => 11_000 });
    const r = await lib.taskSlotSet('digest', 'main', 'ada');
    expect(r).toMatchObject({ ok: true, data: { slots: [{ name: 'main', agent: 'ada' }] } });
    expect(api.rows.get('task:digest').data.manifest.slots.main.agent).toBe('ada');
    void stored;
  });
});

describe("workspaces on web — this surface's list (his order, 2026-10-06: a workspace carries where it was made)", () => {
  const grid = (name, extra = {}) => ({ name, version: 2, cols: 1, rows: 1, colWidths: [1], rowHeights: [1], cells: [], ...extra });
  it('layoutsList lists only the web-made rows: a desktop-stamped one and one from before the stamp (a desktop\'s) stay in the library, off this list', async () => {
    const lib = buildMemberLibrary({ memberLibrary: fakeLibrary({ workspace: [
      { id: 'research', updatedAt: 1_000, data: grid('Research', { surface: 'web' }) },
      { id: 'desk', updatedAt: 1_000, data: grid('Desk', { surface: 'desktop' }) },
      { id: 'old', updatedAt: 1_000, data: grid('Old') },
      { id: 'junk', updatedAt: 1_000, data: { nope: true } },
    ] }) });
    const rows = await lib.layoutsList();
    expect(rows.map((l) => l.name)).toEqual(['Research']);
    expect(rows[0]).toMatchObject({ cols: 1, splits: [], updatedAt: 1_000 });
  });
  it('layoutsSaveGrid stamps the workspace as made on the web; the save then lists here', async () => {
    const fake = fakeLibrary();
    const lib = buildMemberLibrary({ memberLibrary: fake }, { now: () => 5_000 });
    expect(await lib.layoutsSaveGrid(grid('Research'))).toBe(true);
    const [kind, id, input] = fake.put.mock.calls[0];
    expect([kind, id]).toEqual(['workspace', 'research']);
    expect(input.data).toMatchObject({ name: 'Research', version: 2, surface: 'web', updatedAt: 5_000 });
    expect((await lib.layoutsList()).map((l) => l.name)).toEqual(['Research']);
    // a grid that already names its surface keeps it (an edit never re-homes a workspace)
    expect(await lib.layoutsSaveGrid(grid('Desk', { surface: 'desktop' }))).toBe(true);
    expect(fake.put.mock.calls[1][2].data.surface).toBe('desktop');
    expect((await lib.layoutsList()).map((l) => l.name)).toEqual(['Research']);
  });
});

describe('agents on web — the member library record', () => {
  it('create builds the desktop\'s row shape and puts it; update keeps what the patch does not name; delete tombstones', async () => {
    const api = seededLibrary();
    const lib = buildMemberLibrary({ memberLibrary: api }, { now: () => 2_000 });
    const made = await lib.libraryAgentCreate({ name: 'Scout', prompt: 'Look around', skills: ['notes'] });
    expect(made).toMatchObject({ ok: true, data: { id: 'scout', slug: 'scout', name: 'Scout', prompt: 'Look around', skills: ['notes'], apps: [], live: true, guardrails: null, updatedAt: new Date(2_000).toISOString() } });
    expect(api.rows.get('agent:scout').updatedAt).toBe(2_000);
    expect(await lib.libraryAgentUpdate('scout', { live: false })).toMatchObject({ ok: true, data: { name: 'Scout', prompt: 'Look around', live: false } });
    expect(await lib.libraryAgentGet('scout')).toMatchObject({ ok: true, data: { live: false } });
    expect((await lib.libraryAgentsList()).data.map((a) => a.slug)).toEqual(['a', 'scout']);
    expect(await lib.libraryAgentDelete('scout')).toEqual({ ok: true, data: true });
    expect((await lib.libraryAgentsList()).data.map((a) => a.slug)).toEqual(['a']);
    expect(await lib.libraryAgentGet('scout')).toMatchObject({ ok: false });
    expect(await lib.libraryAgentCreate({})).toMatchObject({ ok: false, error: /needs a name/ });
  });
});

describe('drips on web — the member library record (2026-10-04: a preset is a db row with cloud storage)', () => {
  it('dripsList reads the server; dripsSave puts `{ name, recipe }` under the lowercased name; dripsDelete tombstones', async () => {
    const api = fakeLibrary({ drip: [{ id: 'party', updatedAt: 1_000, data: { name: 'party', recipe: '3 confetti fireworks' } }, { id: 'junk', updatedAt: 1_000, data: 'not a drip' }] });
    const lib = buildMemberLibrary({ memberLibrary: api }, { now: () => 5_000 });
    expect(await lib.dripsList()).toEqual([{ name: 'party', recipe: '3 confetti fireworks' }]);
    expect(await lib.dripsSave('  Aurora ', '-1  0.5 aurora')).toBe('saved drip "aurora" → -1 0.5 aurora');
    expect(api.put).toHaveBeenCalledWith('drip', 'aurora', { data: { name: 'aurora', recipe: '-1 0.5 aurora' }, updatedAt: 5_000 });
    expect((await lib.dripsList()).map((d) => d.name).sort()).toEqual(['aurora', 'party']);
    expect(await lib.dripsSave('', 'x')).toMatch(/needs a name/);
    expect(await lib.dripsSave('empty', '   ')).toMatch(/at least one effect/);
    expect(await lib.dripsDelete('Party')).toBe('deleted drip "party"');
    expect(api.remove).toHaveBeenCalledWith('drip', 'party', { updatedAt: 5_001 });
    expect(await lib.dripsList()).toEqual([{ name: 'aurora', recipe: '-1 0.5 aurora' }]);
    expect(await lib.dripsDelete('party')).toBe('no custom drip "party"');
  });

  it('a stale save is said in the status string, as the desktop manager would', async () => {
    const api = fakeLibrary({ drip: [{ id: 'party', updatedAt: 9_000, data: { name: 'party', recipe: 'confetti' } }] });
    const lib = buildMemberLibrary({ memberLibrary: api }, { now: () => 5_000 });
    expect(await lib.dripsSave('party', 'hearts')).toMatch(/^failed to save drip "party": .*newer copy/);
  });
});

describe('schedules on web — the record, with the runs left to the desktop clock', () => {
  const seed = () => fakeLibrary({
    schedule: [{ id: 's1', updatedAt: 1_000, data: { name: 'Digest', cron: '0 9 * * 1-5', kind: 'task', target: 'digest', agentId: null, ownerAgentId: null, args: { n: 1 }, enabled: true } },
      { id: 's2', updatedAt: 2_000, data: { name: 'Brief', cron: '30 8 * * *', kind: 'skill', target: 'brief', agentId: 'a', ownerAgentId: null, args: {}, enabled: false } }],
    agent: [{ id: 'a', updatedAt: 1_000, data: { id: 'a', slug: 'a', name: 'Ada', description: '', prompt: '', provider: '', model: '', skills: [], apps: [], live: true, guardrails: null, createdAt: '', updatedAt: '2026-10-01T00:00:00.000Z' } }],
  });

  it('schedulesList is the Schedules page shape: the agent named off the agent records, the run columns null', async () => {
    const lib = buildMemberLibrary({ memberLibrary: seed() });
    const r = await lib.schedulesList();
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([
      { id: 's2', name: 'Brief', kind: 'skill', target: 'brief', cron: '30 8 * * *', enabled: false, agentId: 'a', agentName: 'Ada', ownerAgentId: null, args: '{}', createdAt: new Date(2_000).toISOString(), updatedAt: 2_000, lastRunAt: null, lastStatus: null, lastError: null },
      { id: 's1', name: 'Digest', kind: 'task', target: 'digest', cron: '0 9 * * 1-5', enabled: true, agentId: null, agentName: null, ownerAgentId: null, args: '{"n":1}', createdAt: new Date(1_000).toISOString(), updatedAt: 1_000, lastRunAt: null, lastStatus: null, lastError: null },
    ]);
    expect(await lib.scheduleRuns('s1')).toEqual({ ok: true, data: [] });
    expect(await lib.scheduleRecentRuns()).toEqual({ ok: true, data: [] });
    expect(await lib.scheduleRunNow('s1')).toEqual({ ok: false, error: NEEDS_DESKTOP });
  });

  it('scheduleSave puts a new record (its own id) or rewrites one; a bad cron, a missing target or a skill without an agent is refused before any put', async () => {
    const api = seed();
    const lib = buildMemberLibrary({ memberLibrary: api }, { now: () => 7_000 });
    const made = await lib.scheduleSave({ name: 'Nightly', kind: 'task', target: 'backup', cron: '0 2 * * *', args: { deep: true } });
    expect(made).toMatchObject({ ok: true, data: { id: expect.any(String) } });
    const put = api.put.mock.calls.at(-1);
    expect(put[0]).toBe('schedule');
    expect(put[2]).toEqual({ data: { name: 'Nightly', cron: '0 2 * * *', kind: 'task', target: 'backup', agentId: null, ownerAgentId: null, args: { deep: true }, enabled: true }, updatedAt: 7_000 });
    // An edit keeps what the patch does not name (the args, the owner).
    expect(await lib.scheduleSave({ id: 's1', kind: 'task', target: 'digest', cron: '15 9 * * 1-5', enabled: false })).toEqual({ ok: true, data: { id: 's1' } });
    expect(api.put.mock.calls.at(-1)[2]).toEqual({ data: { name: 'Digest', cron: '15 9 * * 1-5', kind: 'task', target: 'digest', agentId: null, ownerAgentId: null, args: { n: 1 }, enabled: false }, updatedAt: 7_001 });
    const puts = api.put.mock.calls.length;
    expect(await lib.scheduleSave({ kind: 'task', target: 'x', cron: 'every tuesday' })).toMatchObject({ ok: false, error: /cron/ });
    expect(await lib.scheduleSave({ kind: 'task', target: '', cron: '0 9 * * *' })).toMatchObject({ ok: false, error: /something to run/ });
    expect(await lib.scheduleSave({ kind: 'skill', target: 'brief', cron: '0 9 * * *' })).toMatchObject({ ok: false, error: /agent/ });
    expect(await lib.scheduleSave({ id: 'nope', kind: 'task', target: 'x', cron: '0 9 * * *' })).toMatchObject({ ok: false, error: /not found/ });
    expect(api.put.mock.calls.length).toBe(puts);
  });

  it('scheduleSetEnabled re-puts the record with the flag; scheduleDelete tombstones at this clock; a stale write is said', async () => {
    const api = seed();
    const lib = buildMemberLibrary({ memberLibrary: api }, { now: () => 7_000 });
    expect(await lib.scheduleSetEnabled('s2', true)).toEqual({ ok: true, data: { updated: true } });
    expect(api.put.mock.calls.at(-1)[2]).toMatchObject({ data: { name: 'Brief', enabled: true, agentId: 'a' }, updatedAt: 7_000 });
    expect(await lib.scheduleSetEnabled('ghost', true)).toEqual({ ok: true, data: { updated: false } });
    expect(await lib.scheduleDelete('s1')).toEqual({ ok: true, data: { deleted: true } });
    expect(api.remove).toHaveBeenCalledWith('schedule', 's1', { updatedAt: 7_001 });
    expect((await lib.schedulesList()).data.map((s) => s.id)).toEqual(['s2']);
    expect(await lib.scheduleDelete('s1')).toEqual({ ok: true, data: { deleted: true } });   // already gone: fine
    const stale = buildMemberLibrary({ memberLibrary: seed() }, { now: () => 500 });
    expect(await stale.scheduleSetEnabled('s2', true)).toMatchObject({ ok: false, error: /newer copy/ });
  });
});

// ── THE HUB ON THE WEB (his report, 2026-10-05: "Nothing to discover yet" on
// every Build tab; "why can't plugins be installed on the web?") ─────────────

/** The control plane's hub routes as `client.http`: every call is recorded. */
function fakeHttp(routes) {
  const calls = [];
  const call = (method) => vi.fn(async (path, body) => {
    calls.push({ method, path, body });
    const h = routes[`${method} ${path}`] ?? routes[`${method} ${path.split('?')[0]}`];
    if (h === undefined) { const e = new Error(`stub: ${method} ${path}`); e.httpStatus = 404; throw e; }
    return typeof h === 'function' ? h(body, path) : h;
  });
  return { calls, get: call('GET'), post: call('POST'), put: call('PUT'), del: call('DELETE') };
}
const PUB = [
  { id: 'pub-1', slug: 'notes-pro', name: 'Notes Pro', description: 'Better notes', sourceOrg: 'Glyphh', installed: false, installs: 12, version: 2, updatedAt: '2026-10-02T00:00:00.000Z', createdAt: '2026-09-30T00:00:00.000Z', kind: 'skill', categories: ['productivity'], icon: null },
  { id: 'pub-2', slug: 'weekly', name: 'Weekly digest', description: 'Mail digest', sourceOrg: 'Glyphh', installed: false, installs: 3, version: 1, updatedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', kind: 'task', categories: ['productivity'], icon: '<svg/>' },
  { id: 'pub-3', slug: 'glyphh', name: 'Glyphh', description: 'The Glyphh plugin', sourceOrg: 'Glyphh', installed: false, installs: 40, version: 3, updatedAt: '2026-10-04T00:00:00.000Z', createdAt: '2026-09-20T00:00:00.000Z', kind: 'plugin', categories: ['apps'], icon: null },
  { id: 'pub-4', slug: 'crm', name: 'CRM', description: 'An app', sourceOrg: 'Glyphh', installed: false, installs: 0, version: 1, updatedAt: '2026-09-29T00:00:00.000Z', createdAt: '2026-09-29T00:00:00.000Z', kind: 'app', categories: [], icon: null },
  // An app row from before the cloud may still carry a `data` word; it says nothing now (his order, 2026-10-06).
  { id: 'pub-6', slug: 'images', name: 'Images', description: "The member's image library", sourceOrg: 'Glyphh', installed: false, installs: 1, version: 1, updatedAt: '2026-09-27T00:00:00.000Z', createdAt: '2026-09-27T00:00:00.000Z', kind: 'app', categories: [], icon: null },
  { id: 'pub-5', slug: 'vault', name: 'Vault', description: 'An app', sourceOrg: 'Glyphh', installed: false, installs: 0, version: 1, updatedAt: '2026-09-28T00:00:00.000Z', createdAt: '2026-09-28T00:00:00.000Z', kind: 'app', categories: [], icon: null, data: 'local' },
];
const ORG_SKILLS = [
  { id: 'org-1', slug: 'notes', name: 'notes', description: 'Keep notes', author: 'Ada', installed: false, installs: 1, headVersion: 1, pendingVersion: 2, rejectedVersion: null, updatedAt: '2026-10-03T00:00:00.000Z', createdAt: '2026-10-03T00:00:00.000Z', categories: ['memory'], icon: null },
  { id: 'org-2', slug: 'draft', name: 'draft', description: 'On the desk', author: 'Bob', installed: false, installs: 0, headVersion: null, pendingVersion: 1, rejectedVersion: null, updatedAt: '2026-10-03T00:00:00.000Z', categories: [] },
];
const PLUGIN_JSON = JSON.stringify({ name: 'glyphh', description: 'The Glyphh plugin', version: '0.3.0' });
const TASK_JSON = JSON.stringify({ name: 'weekly', program: 'run.js', slots: { main: { agent: null } }, schedule: '0 9 * * 1', dependencies: { connections: [] } });
const hubRoutes = () => ({
  'GET /api/hub/public': PUB,
  'GET /api/hub/categories': [{ id: 'productivity', label: 'Productivity' }, { id: 'apps', label: 'Apps' }],
  'GET /api/library/skill': ORG_SKILLS,
  'GET /api/library/task': [],
  'GET /api/library/plugin': [],
  'GET /api/library/app': [],
  'GET /api/hub/public/pub-1/payload': { files: { 'SKILL.md': '---\nname: notes-pro\ndescription: Better notes\n---\n\nDo it.\n', 'scripts/run.sh': 'echo hi\n', 'assets/shot.png': 'data:image/png;base64,iVBORw0KGgo=' } },
  'GET /api/hub/public/pub-2/payload': { files: { 'SKILL.md': '---\nname: weekly\ndescription: Mail digest\n---\n\nRun weekly.\n', 'task.json': TASK_JSON, 'run.js': 'module.exports = async () => ({});\n' } },
  'GET /api/hub/public/pub-3/payload': { files: { '.claude-plugin/plugin.json': PLUGIN_JSON, 'README.md': '# glyphh\n', 'skills/glyphh/SKILL.md': '---\nname: glyphh\ndescription: Drive Glyphh\n---\n\nUse the tools.\n' } },
  'GET /api/library/skill/org-1/payload': { prompt: 'Body from the org.\n', code: 'console.log(1)\n' },
  'POST /api/hub/public/pub-1/install': {}, 'POST /api/hub/public/pub-2/install': {}, 'POST /api/hub/public/pub-3/install': {}, 'POST /api/library/skill/org-1/install': {},
  'GET /api/library/skill/org-1/versions': [{ version: 2, notes: 'v2', created_at: '2026-10-03', status: 'rejected', review_summary: 'too long' }, { version: 1, notes: 'first', created_at: '2026-10-01' }],
  'GET /api/library/skill/org-1/payload?version=1': { files: { 'SKILL.md': 'v1 text' } },
  'DELETE /api/library/skill/org-1/submission': { withdrawn: 2 },
  'POST /api/library/skill/org-1/categories': {},
  'POST /api/library/skill/promote': { version: 3, status: 'pending' },
});
const hubLib = (seed = fakeLibrary(), routes = hubRoutes(), deps = {}, client = {}) => {
  const http = fakeHttp(routes);
  const lib = buildMemberLibrary({ memberLibrary: seed, http, token: async () => 'tok', ...client }, { now: () => 9_000, apiUrl: 'https://api', ...deps });
  return { lib, http, api: seed };
};
/** An attach client: the connected desktops. An install never dispatches to one. */
const attachOf = (machines) => ({
  attach: { status: vi.fn(async () => ({ attached: machines.length > 0, machines })), dispatch: vi.fn(async () => { throw new Error('never dispatched'); }) },
});
const MAC = { id: 'm1', name: "Chris's MacBook" };

describe('Discover on web — the same catalog reads as hub-ipc', () => {
  it('skillsDiscover lists the org items with a live version and the Glyphh catalog items of the asked kinds, newest first, in hub-ipc\'s row shape', async () => {
    const { lib, http } = hubLib();
    const r = await lib.skillsDiscover(['skill', 'task', 'plugin']);
    expect(r.ok).toBe(true);
    expect(r.data.map((d) => d.ref)).toEqual(['glyphh:pub-3', 'org:org-1', 'glyphh:pub-1', 'glyphh:pub-2']);
    expect(r.data[1]).toEqual({ ref: 'org:org-1', from: 'org', id: 'org-1', slug: 'notes', name: 'notes', description: 'Keep notes', author: 'Ada', version: 1, installed: false, installs: 1, updatedAt: '2026-10-03T00:00:00.000Z', createdAt: '2026-10-03T00:00:00.000Z', categories: ['memory'], icon: null, tool: null, type: 'skill' });
    expect(r.data[0]).toMatchObject({ from: 'glyphh', author: 'Glyphh', version: 3, installs: 40, type: 'plugin', icon: null });
    expect(r.data[3]).toMatchObject({ type: 'task', icon: '<svg/>' });
    expect(http.calls.filter((c) => c.method === 'GET').map((c) => c.path).sort()).toEqual(['/api/hub/public', '/api/library/plugin', '/api/library/skill', '/api/library/task']);
    // Only the asked kinds: the Plugins page sees the plugin alone, the app never (no app home here).
    expect((await lib.skillsDiscover('plugin')).data.map((d) => d.ref)).toEqual(['glyphh:pub-3']);
    const withApps = (await lib.skillsDiscover(['skill', 'app', 'task'])).data;
    expect(withApps.map((d) => d.ref)).toEqual(['org:org-1', 'glyphh:pub-1', 'glyphh:pub-2', 'glyphh:pub-4', 'glyphh:pub-5', 'glyphh:pub-6']);
    // A house app's card wears its own panel's mark; any other app none (his report, 2026-10-07: generic icons on Discover).
    expect(withApps.find((d) => d.ref === 'glyphh:pub-6')).toMatchObject({ slug: 'images', tool: 'gimage' });
    expect(withApps.find((d) => d.ref === 'glyphh:pub-4')).toMatchObject({ slug: 'crm', tool: null });
    // An instance of the slug = installed (his report, 2026-10-07: Discover "has no idea it is already installed").
    const withInst = hubLib(fakeLibrary(), { ...hubRoutes(), 'GET /api/app-instances': [{ key: 'images~u1', slug: 'images', kind: 'personal', status: 'ready', manifest: { name: 'Images' } }] });
    const rows2 = (await withInst.lib.skillsDiscover(['skill', 'app'])).data;
    expect(rows2.find((d) => d.ref === 'glyphh:pub-6')?.installed).toBe(true);
    expect(rows2.find((d) => d.ref === 'glyphh:pub-4')?.installed).toBe(false);
    // No row carries a word on where its data lives: an app is a cloud instance.
    expect(withApps.every((d) => !('data' in d))).toBe(true);
  });

  it('already yours is not addable: a library row with the item\'s slug marks it installed', async () => {
    const seed = fakeLibrary({ plugin: [{ id: 'glyphh', updatedAt: 1, data: { name: 'glyphh', type: 'plugin', enabled: true } }] });
    const { lib } = hubLib(seed);
    const rows = (await lib.skillsDiscover(['skill', 'plugin'])).data;
    expect(rows.find((d) => d.ref === 'glyphh:pub-3').installed).toBe(true);
    expect(rows.find((d) => d.ref === 'glyphh:pub-1').installed).toBe(false);
  });

  it('a hub that does not answer is an empty list, not an error; hubCategories and skillHubFiles read their routes', async () => {
    const { lib } = hubLib(fakeLibrary(), { 'GET /api/hub/categories': [{ id: 'x', label: 'X' }] });
    expect(await lib.skillsDiscover('skill')).toEqual({ ok: true, data: [] });
    expect(await lib.hubCategories()).toEqual({ ok: true, data: [{ id: 'x', label: 'X' }] });
    const { lib: lib2 } = hubLib();
    expect((await lib2.skillHubFiles('glyphh:pub-3', 'plugin')).data).toHaveProperty(['.claude-plugin/plugin.json'], PLUGIN_JSON);
    // The legacy { prompt, code } payload becomes a SKILL.md and a script, as on the desktop.
    expect((await lib2.skillHubFiles('org:org-1', 'skill')).data).toEqual({ 'SKILL.md': '---\nname: skill\ndescription: \n---\n\nBody from the org.\n', 'scripts/program.js': 'console.log(1)\n' });
  });
});

describe('Install on web = a put into the member library (his rule, 2026-10-04)', () => {
  it('a Glyphh catalog skill: the record (data + manifest + origin) is put at this clock, every file lands on R2, the hub counts the install', async () => {
    const { stored, fetchImpl } = fakeR2();
    const { lib, http, api } = hubLib(fakeLibrary(), hubRoutes(), { fetchImpl });
    expect(await lib.skillInstall('glyphh:pub-1', 'skill')).toEqual({ ok: true, data: { id: 'glyphh:notes-pro' } });
    const [kind, id, body] = api.put.mock.calls[0];
    expect([kind, id, body.updatedAt]).toEqual(['skill', 'notes-pro', 9_000]);
    expect(body.data).toMatchObject({ name: 'notes-pro', description: 'Better notes', type: 'skill', enabled: true, body: '\nDo it.\n', frontmatter: { name: 'notes-pro' } });
    expect(body.data.origin).toMatchObject({ from: 'glyphh', itemId: 'pub-1', kind: 'skill', slug: 'notes-pro', version: 2, author: 'Glyphh', files: ['SKILL.md', 'scripts/run.sh', 'assets/shot.png'] });
    expect(body.files.map((f) => f.path)).toEqual(['SKILL.md', 'scripts/run.sh', 'assets/shot.png']);
    for (const f of body.files) expect(f).toMatchObject({ mtime: 9_000, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(stored.get('scripts/run.sh')).toBe('echo hi\n');
    // A screenshot rides the hub as a data URL and lands as the bytes it was (installSkill does the same).
    expect(body.files.find((f) => f.path === 'assets/shot.png').size).toBe(8);
    expect(http.calls.at(-1)).toEqual({ method: 'POST', path: '/api/hub/public/pub-1/install', body: {} });
    // It is under "Your skills" at once, by its publisher.
    const mine = (await lib.skillsList(['skill', 'app', 'task'])).data;
    expect(mine).toEqual([expect.objectContaining({ id: 'glyphh:notes-pro', source: 'glyphh', type: 'skill', name: 'notes-pro', author: 'Glyphh', enabled: true })]);
    expect((await lib.skillGet('glyphh:notes-pro')).data).toMatchObject({ fileCount: 3, author: 'Glyphh' });
    expect((await lib.skillsDiscover('skill')).data.find((d) => d.ref === 'glyphh:pub-1').installed).toBe(true);
  });

  it('an org task: kind task, the manifest off task.json, the origin from the org with its author', async () => {
    const { fetchImpl } = fakeR2();
    const { lib, api } = hubLib(fakeLibrary(), hubRoutes(), { fetchImpl });
    expect(await lib.skillInstall('glyphh:pub-2', 'task')).toEqual({ ok: true, data: { id: 'task:weekly' } });
    const [kind, id, body] = api.put.mock.calls[0];
    expect([kind, id]).toEqual(['task', 'weekly']);
    expect(body.data).toMatchObject({ type: 'task', manifest: JSON.parse(TASK_JSON), origin: { from: 'glyphh', itemId: 'pub-2', version: 1 } });
    expect((await lib.tasksSpecs()).data[0]).toMatchObject({ slug: 'weekly', schedule: '0 9 * * 1', program: 'run.js' });
    expect(await lib.skillInstall('org:org-1', 'skill')).toEqual({ ok: true, data: { id: 'glyphh:notes' } });
    expect(api.put.mock.calls[1][2].data).toMatchObject({ name: 'notes', description: 'Keep notes', origin: { from: 'org', itemId: 'org-1', version: 1, author: 'Ada' } });
  });

  it('a PLUGIN: kind plugin, its name and description off .claude-plugin/plugin.json, listed on the Plugins page as plugin:<slug>', async () => {
    const { stored, fetchImpl } = fakeR2();
    const { lib, api } = hubLib(fakeLibrary(), hubRoutes(), { fetchImpl });
    expect(await lib.skillInstall('glyphh:pub-3', 'plugin')).toEqual({ ok: true, data: { id: 'plugin:glyphh' } });
    const [kind, id, body] = api.put.mock.calls[0];
    expect([kind, id]).toEqual(['plugin', 'glyphh']);
    expect(body.data).toMatchObject({ name: 'glyphh', description: 'The Glyphh plugin', type: 'plugin', enabled: true, manifest: JSON.parse(PLUGIN_JSON), origin: { kind: 'plugin', version: 3 } });
    expect(body.files.map((f) => f.path)).toEqual(['.claude-plugin/plugin.json', 'README.md', 'skills/glyphh/SKILL.md']);
    expect(stored.get('.claude-plugin/plugin.json')).toBe(PLUGIN_JSON);
    expect((await lib.skillsList('plugin')).data).toEqual([expect.objectContaining({ id: 'plugin:glyphh', source: 'plugin', type: 'plugin', name: 'glyphh', author: 'Glyphh' })]);
    expect((await lib.skillGet('plugin:glyphh')).data).toMatchObject({ id: 'plugin:glyphh', files: [{ path: '.claude-plugin/plugin.json' }, { path: 'README.md' }, { path: 'skills/glyphh/SKILL.md' }] });
    // A payload without the plugin manifest is refused, as installSkill refuses it.
    const bad = hubLib(fakeLibrary(), { ...hubRoutes(), 'GET /api/hub/public/pub-3/payload': { files: { 'README.md': 'x' } } }, { fetchImpl });
    expect(await bad.lib.skillInstall('glyphh:pub-3', 'plugin')).toEqual({ ok: false, error: 'a plugin needs .claude-plugin/plugin.json' });
  });

  it('a vanished item says so; a reinstall drops what the last install wrote and the payload lost', async () => {
    const { fetchImpl } = fakeR2();
    const { lib, api } = hubLib(fakeLibrary(), hubRoutes(), { fetchImpl });
    expect(await lib.skillInstall('glyphh:gone', 'skill')).toEqual({ ok: false, error: 'that skill is no longer available to you' });
    expect(api.put).not.toHaveBeenCalled();
    await lib.skillInstall('glyphh:pub-1', 'skill');
    const item = api.rows.get('skill:notes-pro');
    api.rows.set('skill:notes-pro', { ...item, files: [...item.files, { path: 'notes/mine.md', size: 2, mtime: 1, sha256: 'z' }], data: { ...item.data, origin: { ...item.data.origin, files: ['SKILL.md', 'scripts/run.sh', 'assets/shot.png', 'old.txt'] } } });
    api.rows.get('skill:notes-pro').files.push({ path: 'old.txt', size: 1, mtime: 1, sha256: 'o' });
    expect((await lib.skillInstall('glyphh:pub-1', 'skill')).ok).toBe(true);
    const again = api.put.mock.calls.at(-1)[2];
    expect(again.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'assets/shot.png', 'notes/mine.md', 'scripts/run.sh']);
    expect(again.updatedAt).toBeGreaterThan(9_000);
  });
});

describe('standings, updates, shares, versions and publish on web', () => {
  const installed = () => fakeLibrary({
    skill: [{ id: 'notes-pro', updatedAt: 100, data: { name: 'notes-pro', description: 'Better notes', frontmatter: {}, body: '', enabled: true, type: 'skill', origin: { from: 'glyphh', itemId: 'pub-1', kind: 'skill', slug: 'notes-pro', version: 1, files: ['SKILL.md', 'old.txt'], installedAt: '', author: 'Glyphh' } },
      files: [{ path: 'SKILL.md', size: 5, mtime: 100, sha256: 'a' }, { path: 'old.txt', size: 1, mtime: 100, sha256: 'b' }, { path: 'mine.md', size: 1, mtime: 100, sha256: 'c' }] },
    { id: 'notes', updatedAt: 100, data: { name: 'notes', description: 'Keep notes', frontmatter: { author: 'me' }, body: 'Mine.\n', enabled: true, type: 'skill' }, files: [{ path: 'SKILL.md', size: 5, mtime: 100, sha256: 'a' }] }],
    plugin: [{ id: 'glyphh', updatedAt: 100, data: { name: 'glyphh', type: 'plugin', enabled: true, origin: { from: 'glyphh', itemId: 'pub-3', kind: 'plugin', slug: 'glyphh', version: 3, files: [], installedAt: '', author: 'Glyphh' } }, files: [] }],
  });

  it('skillStandings: the recorded origin, else the catalog row with the slug (version 0 = take whatever the catalog has); skillUpdates = what moved past', async () => {
    const { lib } = hubLib(installed());
    expect((await lib.skillStandings()).data).toEqual({
      'glyphh:notes-pro': { from: 'glyphh', sourceName: 'the Glyphh catalog', name: 'Notes Pro', have: 1, latest: 2 },
      'glyphh:notes': { from: 'org', sourceName: "your organization's hub", name: 'notes', have: 0, latest: 1 },
      'plugin:glyphh': { from: 'glyphh', sourceName: 'the Glyphh catalog', name: 'Glyphh', have: 3, latest: 3 },
    });
    expect((await lib.skillUpdates()).data).toEqual({ 'glyphh:notes-pro': { have: 1, latest: 2, name: 'Notes Pro' }, 'glyphh:notes': { have: 0, latest: 1, name: 'notes' } });
  });

  it('skillUpdate takes the catalog\'s version: the payload\'s files, minus what the last install wrote and the payload dropped, plus what the member added', async () => {
    const { fetchImpl } = fakeR2();
    const { lib, api } = hubLib(installed(), hubRoutes(), { fetchImpl });
    expect(await lib.skillUpdate('glyphh:notes-pro')).toEqual({ ok: true, data: { version: 2 } });
    const body = api.put.mock.calls[0][2];
    expect(body.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'assets/shot.png', 'mine.md', 'scripts/run.sh']);
    expect(body.data.origin).toMatchObject({ itemId: 'pub-1', version: 2, files: ['SKILL.md', 'scripts/run.sh', 'assets/shot.png'] });
    expect(await lib.skillUpdate('glyphh:nope')).toMatchObject({ ok: false });
  });

  it('skillShares / skillWithdraw / skillVersions / skillVersionFiles / skillCategoriesSet read and write the org hub\'s routes', async () => {
    const { lib, http } = hubLib(installed());
    expect((await lib.skillShares()).data).toEqual({ 'glyphh:notes': { head: 1, pending: 2, rejected: null } });
    expect(await lib.skillWithdraw('glyphh:notes')).toEqual({ ok: true, data: { withdrawn: 2 } });
    expect(await lib.skillWithdraw('glyphh:notes-pro')).toEqual({ ok: false, error: "this one isn't on your organization's hub" });
    // THE DEVELOPER'S DESK (2026-10-07): each version carries the reviewer's note; the item its
    // changes-requested standing, lifecycle, visibility and whether it is the caller's own.
    expect((await lib.skillVersions('glyphh:notes')).data).toEqual({
      itemId: 'org-1', kind: 'skill', head: 1, pending: 2, categories: ['memory'],
      versions: [{ version: 2, notes: 'v2', createdAt: '2026-10-03', status: 'rejected', reviewSummary: 'too long', decisionNote: '' }, { version: 1, notes: 'first', createdAt: '2026-10-01', status: 'approved', reviewSummary: '', decisionNote: '' }],
      declined: { version: 2, summary: 'too long' }, changes: null, lifecycle: 'live', lifecycleNote: '', visibility: 'org', own: false,
    });
    expect((await lib.skillVersions('glyphh:notes-pro')).data).toEqual({ itemId: null, kind: 'skill', versions: [], head: null, pending: null, declined: null, changes: null, lifecycle: 'live', lifecycleNote: '', visibility: 'org', own: false, categories: [] });
    expect(await lib.skillVersionFiles('org-1', 1, 'skill')).toEqual({ ok: true, data: { 'SKILL.md': 'v1 text' } });
    expect(await lib.skillCategoriesSet('org-1', 'skill', ['memory', '', 'apps'])).toEqual({ ok: true, data: ['memory', 'apps'] });
    expect(http.calls.at(-1)).toEqual({ method: 'POST', path: '/api/library/skill/org-1/categories', body: { categories: ['memory', 'apps'] } });
  });

  it('skillPublish promotes the record\'s files, read back off R2, as text; a binary file stops it', async () => {
    const md = '---\nname: notes\ndescription: Keep notes\n---\n\nMine.\n';
    const { fetchImpl } = fakeR2({ 'SKILL.md': md });
    const { lib, http } = hubLib(installed(), hubRoutes(), { fetchImpl });
    expect(await lib.skillPublish('glyphh:notes', 'first share')).toEqual({ ok: true, data: { version: 3, status: 'pending' } });
    expect(http.calls.at(-1)).toEqual({ method: 'POST', path: '/api/library/skill/promote', body: { slug: 'notes', name: 'notes', description: 'Keep notes', notes: 'first share', payload: { files: { 'SKILL.md': md }, prompt: '\nMine.\n', manifest: { author: 'me' } } } });
    const bin = fakeR2({ 'SKILL.md': 'ok\u0000bin' });
    expect(await hubLib(installed(), hubRoutes(), { fetchImpl: bin.fetchImpl }).lib.skillPublish('glyphh:notes')).toMatchObject({ ok: false, error: /binary/ });
  });

  it('skillCreate on the Plugins page writes the desktop\'s plugin template', async () => {
    const { fetchImpl, stored } = fakeR2();
    const lib = buildMemberLibrary({ memberLibrary: fakeLibrary(), token: async () => 'tok' }, { apiUrl: 'https://api', fetchImpl, now: () => 9_000 });
    const r = await lib.skillCreate('My Plugin', 'plugin');
    expect(r.data).toMatchObject({ id: 'plugin:my-plugin', type: 'plugin', name: 'my-plugin', description: 'What this plugin is for, in one line.', fileCount: 3 });
    expect([...stored.keys()].sort()).toEqual(['.claude-plugin/plugin.json', 'README.md', 'skills/my-plugin/SKILL.md']);
  });
});

// ── AN APP IS A CLOUD INSTANCE (his order, 2026-10-06: cloud is the one home) ─
describe('an app installs as this member\'s instance', () => {
  const INST = { key: 'crm~u1', slug: 'crm', kind: 'personal', status: 'ready', manifest: { name: 'CRM' } };
  const routes = (fromHub = INST) => ({ ...hubRoutes(), 'POST /api/app-instances/from-hub': fromHub });

  it('POST /api/app-instances/from-hub {itemId} — desktop attached or not — and the instance card is the id; nothing rides the relay', async () => {
    for (const machines of [[], [MAC]]) {
      const client = attachOf(machines);
      const { lib, http, api } = hubLib(fakeLibrary(), routes(), {}, client);
      expect(await lib.skillInstall('glyphh:pub-4', 'app')).toEqual({ ok: true, data: { id: 'app-instance:crm~u1' } });
      expect(http.calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: '/api/app-instances/from-hub', body: { itemId: 'pub-4' } }]);
      expect(api.put).not.toHaveBeenCalled();
      expect(client.attach.dispatch).not.toHaveBeenCalled();
    }
    // The server may wrap the instance; both shapes read the same.
    const { lib } = hubLib(fakeLibrary(), routes({ instance: INST }), {}, attachOf([]));
    expect(await lib.skillInstall('glyphh:pub-4', 'app')).toEqual({ ok: true, data: { id: 'app-instance:crm~u1' } });
  });

  it('an app whose old row still says data: local installs the same way', async () => {
    const { lib, http } = hubLib(fakeLibrary(), routes({ ...INST, key: 'vault~u1', slug: 'vault' }), {}, attachOf([]));
    expect(await lib.skillInstall('glyphh:pub-5', 'app')).toEqual({ ok: true, data: { id: 'app-instance:vault~u1' } });
    expect(http.calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: '/api/app-instances/from-hub', body: { itemId: 'pub-5' } }]);
  });
});

describe("the web's Skills page carries the installed APPS that are tab rows (his report, 2026-10-05: 'build in the web doesn't carry apps yet')", () => {
  const tabs = () => fakeLibrary({
    tab: [
      { id: 'drive', updatedAt: 7_000, data: { id: 'drive', kind: 'glyphh', slug: 'drive', name: 'Drive', prodUrl: null, nativeRef: null, config: { tool: 'gdrive' }, description: "Glyphh's Drive", access: 'members', owned: true, latestVersion: null, version: '0.1.0', secretNames: [], requiredConnections: [], listing: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' } },
      { id: 'gmail', updatedAt: 8_000, data: { id: 'gmail', kind: 'web', slug: 'gmail', name: 'Gmail', prodUrl: 'https://mail.google.com', nativeRef: null, config: null, description: '', access: 'members', owned: true, latestVersion: null, version: '0.1.0', secretNames: [], requiredConnections: [], listing: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' } },
    ],
  });
  it('a Glyphh tab row with a bundle on a machine lists as an app card; one with nothing behind it and a URL tab do not; its detail and its open answer', async () => {
    const fake = tabs();
    const base = await fake.list('tab');
    fake.list = vi.fn(async (kind) => (kind === 'tab' ? base.map((r) => (r.id === 'drive' ? { ...r, data: { ...r.data, nativeRef: '/Users/me/.glyphh/apps/drive/app.json' } } : r)) : []));
    const lib = buildMemberLibrary({ memberLibrary: fake }, { now: () => 9_000 });
    const rows = (await lib.skillsList(['skill', 'app', 'task'])).data;
    expect(rows.map((r) => r.id)).toEqual(['app-tab:drive']);   // the bundle on the machine makes it an app
    expect((await buildMemberLibrary({ memberLibrary: tabs() }, { now: () => 9_000 }).skillsList('app')).data).toEqual([]);   // a row left over from a delete is nothing
    expect(rows[0]).toMatchObject({ source: 'app', type: 'app', name: 'Drive', tool: 'gdrive', author: 'you' });
    expect(rows[0]).not.toHaveProperty('locus');
    expect(rows[0]).not.toHaveProperty('data');
    expect((await lib.skillGet('app-tab:drive')).data).toMatchObject({ name: 'Drive', body: "Glyphh's Drive", files: [] });
    expect(await lib.skillTab('app-tab:drive')).toEqual({ ok: true, data: { slug: 'drive', name: 'Drive', tool: 'gdrive', cloud: false } });   // a bundle on a machine, not a cloud instance
  });
  it("the panel app list is what is installed — an instance, or a bundle on a machine — and nothing synthesized; a glyphh row with nothing behind it is not an app (his law, 2026-10-06; his report, 2026-10-07)", async () => {
    const lib = buildMemberLibrary({ memberLibrary: tabs() }, { now: () => 9_000 });
    const rows = await lib.panelAppsList();
    expect(rows.map((r) => r.slug)).toEqual(['gmail']);   // drive has no instance and no bundle: a row left over from a delete
    expect((await lib.skillTab('app-tab:images')).ok).toBe(false);
    const withInst = buildMemberLibrary({ memberLibrary: tabs(), http: { get: async (p) => (p === '/api/app-instances' ? [{ key: 'drive~u1', slug: 'drive', kind: 'personal', status: 'ready', manifest: { name: 'Drive' } }] : undefined) }, token: async () => 't' }, { now: () => 9_000 });
    const rows2 = await withInst.panelAppsList();
    expect(rows2.map((r) => r.slug)).toEqual(['drive', 'gmail']);
    expect(rows2.find((r) => r.slug === 'drive')).toMatchObject({ name: 'Drive', appArchetype: 'glyphh-app', launchConfig: { tool: 'gdrive', instance: 'drive~u1' } });
  });
  it("deleting a tab-row card on the web tombstones the library row — never 'this runs on your desktop' (his report, 2026-10-07)", async () => {
    const fake = tabs();
    const lib = buildMemberLibrary({ memberLibrary: fake }, { now: () => 9_000 });
    expect(await lib.skillDelete('app-tab:drive')).toEqual({ ok: true, data: true });
    expect(fake.remove).toHaveBeenCalledWith('tab', 'drive', { updatedAt: 9_000 });
  });
  it("a house tab row that arrives WITHOUT its tool still opens its own panel on the web (Images → gimage; his report 2026-10-05: Open did nothing)", async () => {
    const fake = tabs();
    const rows = await fake.list('tab');
    fake.list = vi.fn(async (kind) => (kind === 'tab' ? [...rows, { id: 'images', updatedAt: 7_500, data: { ...rows[0].data, id: 'images', slug: 'images', name: 'Images', nativeRef: '/Users/me/.glyphh/apps/images/app.json', config: null } }] : []));
    const lib = buildMemberLibrary({ memberLibrary: fake }, { now: () => 9_000 });
    expect(await lib.skillTab('app-tab:images')).toEqual({ ok: true, data: { slug: 'images', name: 'Images', tool: 'gimage', cloud: false } });
    expect((await lib.skillsList(['app'])).data.find((r) => r.id === 'app-tab:images')).toMatchObject({ tool: 'gimage' });
    expect((await lib.skillsList('skill')).data).toEqual([]);
  });
});


describe("THE DEVELOPER'S DESK + THE REVIEW DESK on the web (2026-10-07) — the desktop's hub-ipc names", () => {
  const routes = () => ({
    ...hubRoutes(),
    'GET /api/library/skill/org-1/head': { versionId: 'v-2' },
    'GET /api/library/versions/v-2/comments': { versionId: 'v-2', itemId: 'org-1', kind: 'skill', version: 2, status: 'changes', decisionNote: 'shorter', priorVersionId: 'v-1', comments: [{ id: 'ai:v-2', by: 'ai', author: 'Review agent', body: 'Too long.', verdict: 'changes', createdAt: null }] },
    'POST /api/library/versions/v-2/comments': { id: 'c-1', by: 'u1', author: 'Ada', body: 'Trimmed it.', createdAt: '2026-10-07' },
    'POST /api/library/skill/org-1/lifecycle': { lifecycle: 'retired', lifecycleNote: 'use notes-pro' },
    'POST /api/library/skill/org-1/public': { id: 'pub-9', status: 'pending' },
    'DELETE /api/library/skill/org-1/public': { ok: true },
    'GET /api/library/queue': [{ id: 'v-2', kind: 'skill', entity_id: 'org-1', version: 2, status: 'pending', notes: 'v2', slug: 'notes', name: 'notes', submitted_by: 'u2', created_at: '2026-10-03' }],
    'POST /api/library/versions/v-2/decide': { id: 'v-2', status: 'changes', kind: 'skill', version: 2, note: 'shorter' },
    'GET /api/library/versions/v-2': { id: 'v-2', payload: { files: { 'SKILL.md': '# v2' } } },
  });
  it('the thread hangs on a version id, or on an item + version through the versions list and the head', async () => {
    const { lib, http } = hubLib(fakeLibrary(), routes());
    const t = await lib.skillComments({ versionId: 'v-2' });
    expect(t.ok).toBe(true);
    expect(t.data.comments[0]).toMatchObject({ by: 'ai', verdict: 'changes' });
    // the list carries no ids for the author: the head names the one on the desk
    expect((await lib.skillComments({ kind: 'skill', itemId: 'org-1', version: 2 })).data.versionId).toBe('v-2');
    expect(http.calls.map((c) => `${c.method} ${c.path}`)).toContain('GET /api/library/skill/org-1/head');
    expect(await lib.skillCommentAdd('v-2', 'Trimmed it.')).toEqual({ ok: true, data: { id: 'c-1', by: 'u1', author: 'Ada', body: 'Trimmed it.', createdAt: '2026-10-07' } });
  });
  it('lifecycle, the public lane, the queue, a decision and a version\'s files answer the server\'s routes', async () => {
    const { lib, http } = hubLib(fakeLibrary(), routes());
    expect(await lib.skillLifecycle('org-1', 'skill', 'retired', 'use notes-pro')).toEqual({ ok: true, data: { lifecycle: 'retired', lifecycleNote: 'use notes-pro' } });
    expect(await lib.skillSubmitPublic('org-1', 'skill', 'to Glyphh')).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(await lib.skillWithdrawPublic('org-1', 'skill')).toMatchObject({ ok: true });
    expect((await lib.libraryQueue()).data.map((r) => r.id)).toEqual(['v-2']);
    expect(await lib.libraryDecide('v-2', 'changes', 'shorter')).toMatchObject({ ok: true, data: { status: 'changes' } });
    expect(await lib.libraryVersionFiles('v-2')).toEqual({ ok: true, data: { 'SKILL.md': '# v2' } });
    expect(http.calls.map((c) => `${c.method} ${c.path}`)).toEqual(expect.arrayContaining([
      'POST /api/library/skill/org-1/lifecycle', 'POST /api/library/skill/org-1/public', 'DELETE /api/library/skill/org-1/public',
      'GET /api/library/queue', 'POST /api/library/versions/v-2/decide', 'GET /api/library/versions/v-2',
    ]));
  });
});
