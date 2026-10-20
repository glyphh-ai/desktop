/**
 * app-instances-web.test.js — APPS ARE INSTALLED IN THE CLOUD on the web
 * (his decision, 2026-10-04). The web shims (web/src/app-instances-web.js)
 * over a fake SDK client and a fake document: a panel open answers the
 * proxy path and sets the panel cookie; the Apps page lists instances as
 * cards; Open writes the tab record; Remove deletes the instance. And the
 * member library (member-library-web.js) folds instances into the tab list
 * and exposes the same preview-open the desktop's preload has.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildAppInstancesWeb, panelCookieOf, PANEL_COOKIE } from '../src/app-instances-web.js';
import { buildMemberLibrary } from '../src/member-library-web.js';
import { fakeLibrary, CRM } from './helpers/member-library.js';

const SHA = 'a'.repeat(64);
const ORG = {
  key: 'expense-desk', slug: 'expense-desk', kind: 'org', access: 'everyone', public: false, status: 'ready', members: [], orgConnectionId: null,
  bundle: { sha256: SHA, bytes: 10 }, manifest: { name: 'Expense Desk', tools: [{ name: 'list_expenses' }], capabilities: ['db.exec'], connectors: [], description: 'Expenses, filed.' },
  url: '/app-host/expense-desk/',
};
const MINE = { ...ORG, key: 'notes~u1', slug: 'notes', kind: 'personal', manifest: { name: 'Notes', tools: [], capabilities: [], connectors: [] }, url: '/app-host/notes~u1/' };

function fakeClient({ instances = [ORG, MINE], token = 'tok-1', library = fakeLibrary({ tab: [{ id: 'crm', updatedAt: 1_000, data: CRM }] }), attached = null, fromHub = null } = {}) {
  const dels = [];
  const posts = [];
  const pins = [];
  return {
    dels, posts, pins,
    // The SDK's app-instances resource (sdk/src/resources/app-instances.ts): what Rollback calls.
    appInstances: { pin: vi.fn(async (key, n) => { pins.push([key, n]); const inst = instances.find((i) => i.key === key); return { ...inst, release: n }; }) },
    memberLibrary: library,
    me: vi.fn(async () => ({ userId: 'u1' })),
    token: vi.fn(async () => { if (!token) throw new Error('signed out'); return token; }),
    http: {
      get: vi.fn(async (path) => { if (path === '/api/app-instances') return instances; throw new Error(`unexpected GET ${path}`); }),
      post: vi.fn(async (path, body) => {
        posts.push({ path, body });
        if (path === '/api/app-instances/from-hub') return fromHub;
        // APPS CARRY A VERSION (2026-10-07): the update, update-all and defaults routes.
        const up = path.match(/^\/api\/app-instances\/([^/]+)\/update$/);
        if (up) { const inst = instances.find((i) => i.key === decodeURIComponent(up[1])); return { ...inst, release: (inst.release ?? 0) + 1, version: inst.update?.headVersion ?? null, update: null }; }
        if (path === '/api/app-instances/update-all') return { updated: instances.filter((i) => i.update?.available), failed: [] };
        throw new Error(`unexpected POST ${path}`);
      }),
      del: vi.fn(async (path) => { dels.push(path); }),
    },
    ...(attached === null ? {} : { attach: { status: vi.fn(async () => ({ attached, machines: attached ? [{ id: 'm1', name: 'Mac' }] : [] })) } }),
  };
}
const fakeDoc = () => ({ cookie: '' });

describe('the panel open (glyphhAppPreviewOpen on the web)', () => {
  it('answers this origin\'s proxy path for the instance a tab names, and sets the panel cookie', async () => {
    const doc = fakeDoc();
    const w = buildAppInstancesWeb(fakeClient(), { document: doc, secure: true });
    const rows = [{ slug: 'expense-desk', name: 'Expense Desk', launchConfig: { instance: 'expense-desk' } }];
    expect(await w.previewOpen('expense-desk', rows)).toEqual({ ok: true, fileUrl: '/app-host/expense-desk/ui/', hosted: true });
    expect(doc.cookie).toBe(`${PANEL_COOKIE}=tok-1; path=/app-host; SameSite=Strict; Secure`);
  });
  it('resolves a bare slug against the instances (org first, then the member\'s own)', async () => {
    const w = buildAppInstancesWeb(fakeClient(), { document: fakeDoc(), secure: false });
    expect((await w.previewOpen('notes', [])).fileUrl).toBe('/app-host/notes~u1/ui/');
    expect((await w.previewOpen('expense-desk', [])).fileUrl).toBe('/app-host/expense-desk/ui/');
  });
  it('an app that is not in the cloud, or a signed-out member, gets an honest refusal', async () => {
    const w = buildAppInstancesWeb(fakeClient(), { document: fakeDoc() });
    expect(await w.previewOpen('nothing', [{ slug: 'nothing', name: 'Nothing', execPath: '/x/index.html' }])).toMatchObject({ ok: false, error: expect.stringMatching(/not installed in the cloud/) });
    const out = buildAppInstancesWeb(fakeClient({ token: null }), { document: fakeDoc() });
    expect(await out.previewOpen('expense-desk', [])).toEqual({ ok: false, error: 'sign in to open this app' });
  });
  it('the cookie line is scoped to the proxy path and Secure only on https', () => {
    expect(panelCookieOf('a b', false)).toBe('glyphh_session=a%20b; path=/app-host; SameSite=Strict');
    expect(panelCookieOf('t', true)).toMatch(/; Secure$/);
  });
});

describe('Settings → Apps on the web', () => {
  it('lists each instance as a card (no folder), skipping slugs the desktop holds as folders', async () => {
    const w = buildAppInstancesWeb(fakeClient(), { now: () => 1_000 });
    const cards = await w.cards(new Set(['notes']));
    expect(cards.map((c) => c.id)).toEqual(['app-instance:expense-desk']);
    expect(cards[0]).toMatchObject({ type: 'app', dir: '', fileCount: 0, name: 'Expense Desk', author: 'your organization' });
    const detail = await w.detail('app-instance:expense-desk');
    expect(detail.frontmatter).toMatchObject({ instance: 'expense-desk', kind: 'org' });
    expect(detail.body).toContain('`list_expenses`');
  });
  it('Open writes the tab record naming the instance; Remove deletes the instance and its tab', async () => {
    const client = fakeClient();
    const w = buildAppInstancesWeb(client, { now: () => 2_000 });
    expect(await w.tab('app-instance:expense-desk')).toEqual({ slug: 'expense-desk', name: 'Expense Desk' });
    const put = client.memberLibrary.put.mock.calls.at(-1);
    expect(put[0]).toBe('tab');
    expect(put[1]).toBe('expense-desk');
    expect(put[2].data).toMatchObject({ kind: 'glyphh', nativeRef: null, config: { instance: 'expense-desk', instanceKind: 'org' } });
    expect(await w.remove('app-instance:expense-desk')).toBe(true);
    expect(client.dels).toEqual(['/api/app-instances/expense-desk']);
    await expect(client.memberLibrary.get('tab', 'expense-desk')).rejects.toThrow(/not found/);
  });
});

describe('the member library folds instances in', () => {
  it('panelAppsList = the server\'s tabs + every instance no tab names — the one list; a desktop\'s rows never join (his order, 2026-10-06)', async () => {
    const client = fakeClient();
    const desktopRead = vi.fn(async () => [{ id: 'local', slug: 'local-only', name: 'Local', appArchetype: 'glyphh-app', execPath: '/x/index.html' }]);
    const lib = buildMemberLibrary(client, { document: fakeDoc(), desktopRead });
    const rows = await lib.panelAppsList();
    expect(desktopRead).not.toHaveBeenCalled();
    expect(rows.map((r) => r.slug).sort()).toEqual(['crm', 'expense-desk', 'notes']);
    expect(rows.find((r) => r.slug === 'expense-desk').launchConfig).toMatchObject({ instance: 'expense-desk', instanceStatus: 'ready' });
    expect(rows.find((r) => r.slug === 'expense-desk').appArchetype).toBe('glyphh-app');
  });
  it('glyphhAppPreviewOpen answers through the library; skillsList("app") is the cards; skillGet/skillTab/skillDelete route by id', async () => {
    const client = fakeClient();
    const doc = fakeDoc();
    const lib = buildMemberLibrary(client, { document: doc, secure: true });
    expect(await lib.glyphhAppPreviewOpen('expense-desk')).toEqual({ ok: true, fileUrl: '/app-host/expense-desk/ui/', hosted: true });
    expect(doc.cookie).toContain('glyphh_session=tok-1');
    const list = await lib.skillsList('app');
    expect(list.ok).toBe(true);
    expect(list.data.map((c) => c.id).sort()).toEqual(['app-instance:expense-desk', 'app-instance:notes~u1']);
    expect((await lib.skillGet('app-instance:notes~u1')).data.frontmatter.kind).toBe('personal');
    expect((await lib.skillTab('app-instance:notes~u1')).data).toEqual({ slug: 'notes', name: 'Notes', cloud: true });   // a cloud app opens as a web panel (his report, 2026-10-05)
    expect((await lib.skillTab('skill:plain')).ok).toBe(false);
    expect((await lib.skillDelete('app-instance:notes~u1')).ok).toBe(true);
    expect(client.dels).toEqual(['/api/app-instances/notes~u1']);
  });
  it('offline: no instances, the tab list still lands', async () => {
    const client = fakeClient();
    client.http.get = vi.fn(async () => { throw new Error('offline'); });
    const lib = buildMemberLibrary(client, { document: fakeDoc() });
    expect((await lib.panelAppsList()).map((r) => r.slug)).toEqual(['crm']);
  });
  // THE HOUSE APPS ARE APPS (his law, 2026-10-06): an `images` instance the
  // server installed lists like any instance — never a synthesized row — and
  // its row names the built-in panel (tool gimage), which is where the tile,
  // the ⋮ menu and Settings → Apps → Open all land on the web.
  it('a house app is an instance like any other; its row and its Open name the built-in panel', async () => {
    const images = { ...MINE, key: 'images~u1', slug: 'images', manifest: { name: 'Images', tools: [{ name: 'save_image' }], capabilities: ['library.*'], connectors: [] }, url: '/app-host/images~u1/' };
    const client = fakeClient({ instances: [ORG, images] });
    const lib = buildMemberLibrary(client, { document: fakeDoc() });
    const rows = await lib.panelAppsList();
    expect(rows.map((r) => r.slug).sort()).toEqual(['crm', 'expense-desk', 'images']);
    expect(rows.find((r) => r.slug === 'images')).toMatchObject({ appArchetype: 'glyphh-app', launchConfig: { instance: 'images~u1', tool: 'gimage', instanceStatus: 'ready' } });
    expect(rows.find((r) => r.slug === 'expense-desk').launchConfig).not.toHaveProperty('tool');
    expect((await lib.skillTab('app-instance:images~u1')).data).toEqual({ slug: 'images', name: 'Images', tool: 'gimage', cloud: true });
    expect(client.memberLibrary.put).toHaveBeenCalledWith('tab', 'images', expect.objectContaining({ data: expect.objectContaining({ config: expect.objectContaining({ instance: 'images~u1', tool: 'gimage' }) }) }));
    // With nothing installed there is nothing: no row is made up for a house app.
    expect((await buildMemberLibrary(fakeClient({ instances: [], library: fakeLibrary({}) }), { document: fakeDoc() }).panelAppsList())).toEqual([]);
  });
});

// ── AN APP IS A CLOUD INSTANCE (his order, 2026-10-06) ───────────────────────
describe('a hub app as this member\'s instance, and a tab\'s panel on the web', () => {
  it('installFromHub posts the item id and answers the instance — bare or wrapped — and drops the cached list', async () => {
    const c = fakeClient({ fromHub: MINE });
    const w = buildAppInstancesWeb(c, { document: fakeDoc() });
    await w.listInstances();
    expect(await w.installFromHub('pub-4')).toEqual(MINE);
    expect(c.posts).toEqual([{ path: '/api/app-instances/from-hub', body: { itemId: 'pub-4' } }]);
    await w.listInstances();
    expect(c.http.get).toHaveBeenCalledTimes(2); // the install invalidated the cache
    const wrapped = buildAppInstancesWeb(fakeClient({ fromHub: { instance: ORG } }), { document: fakeDoc() });
    expect(await wrapped.installFromHub('pub-1')).toEqual(ORG);
    await expect(buildAppInstancesWeb(fakeClient({ fromHub: { nope: true } }), { document: fakeDoc() }).installFromHub('x')).rejects.toThrow(/no instance/);
    await expect(w.installFromHub('')).rejects.toThrow(/needs the hub item/);
  });

  it('a tab with no instance answers the honest line, whatever its old row said; a tab that names its instance opens it', async () => {
    const rows = [{ slug: 'vault', name: 'Vault', launchConfig: { data: 'local' } }, { slug: 'notes', name: 'Notes', launchConfig: { instance: 'notes~u1' } }];
    const on = buildAppInstancesWeb(fakeClient({ attached: true }), { document: fakeDoc() });
    const answer = await on.previewOpen('vault', rows);
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/not installed in the cloud/);
    expect(answer).not.toHaveProperty('localApp');
    expect(await on.previewOpen('notes', rows)).toEqual({ ok: true, fileUrl: '/app-host/notes~u1/ui/', hosted: true });
  });
});

describe('Rollback on the web (appInstancePin — the same IPC name as the desktop)', () => {
  it('pins release n of the instance a card id or a key names through the SDK resource and answers the instance', async () => {
    const client = fakeClient({ instances: [{ ...ORG, release: 3 }, MINE] });
    const w = buildAppInstancesWeb(client, { document: fakeDoc() });
    expect(await w.pin('app-instance:expense-desk', 2)).toMatchObject({ key: 'expense-desk', release: 2 });
    expect(await w.pin('notes~u1', 1)).toMatchObject({ key: 'notes~u1', release: 1 });
    expect(client.pins).toEqual([['expense-desk', 2], ['notes~u1', 1]]);
    await expect(w.pin('app-instance:missing', 1)).rejects.toThrow(/no cloud app missing/);
    await expect(w.pin('expense-desk', 0)).rejects.toThrow(/release number/);
    await expect(w.pin('expense-desk', 'x')).rejects.toThrow(/release number/);
  });
  it('the card carries `release n`; the library answers the envelope', async () => {
    const client = fakeClient({ instances: [{ ...ORG, release: 3 }] });
    const lib = buildMemberLibrary(client, { document: fakeDoc(), secure: true });
    const list = await lib.skillsList('app');
    const card = list.data.find((c) => c.id === 'app-instance:expense-desk');
    expect(card.instance.release).toBe(3);
    expect(await lib.appInstancePin('app-instance:expense-desk', 2)).toMatchObject({ ok: true, data: { release: 2 } });
    expect(await lib.appInstancePin('app-instance:nothing', 2)).toMatchObject({ ok: false, error: expect.stringMatching(/no cloud app/) });
  });
});

describe('SHARE TO PUBLISH with the Publish tab\'s media (2026-10-07)', () => {
  it('share posts the notes, the icon and the screenshots to the instance\'s share route', async () => {
    const client = fakeClient({ instances: [ORG, MINE] });
    client.http.post = vi.fn(async (path, body) => { client.posts.push({ path, body }); return { id: 'i', version: 2, status: 'pending' }; });
    const w = buildAppInstancesWeb(client, { document: fakeDoc() });
    const shot = { name: 'one.png', caption: 'The list', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
    expect(await w.share('app-instance:notes~u1', 'v2', { icon: '<svg/>', screenshots: [shot] })).toMatchObject({ version: 2 });
    expect(client.posts[0]).toEqual({ path: '/api/app-instances/notes~u1/share', body: { notes: 'v2', icon: '<svg/>', screenshots: [shot] } });
    await w.share('notes~u1', '');
    expect(client.posts[1].body).toEqual({ notes: '' });
  });
});

describe('APPS CARRY A VERSION (2026-10-07): Update, Update All and the defaults on the web, by the desktop\'s IPC names', () => {
  const STALE = { ...MINE, release: 2, version: '1.0.0', update: { available: true, headVersion: '1.1.0', headRelease: 3, itemRef: 'glyphh:notes' } };
  it('the card carries version + update, and update() moves one instance to the head and drops the cache', async () => {
    const client = fakeClient({ instances: [ORG, STALE] });
    const lib = buildMemberLibrary(client, { document: fakeDoc(), secure: true });
    const list = await lib.skillsList('app');
    const card = list.data.find((c) => c.id === 'app-instance:notes~u1');
    expect(card.instance.version).toBe('1.0.0');
    expect(card.instance.update).toEqual({ available: true, headVersion: '1.1.0', headRelease: 3 });
    expect(await lib.appInstanceUpdate('app-instance:notes~u1')).toMatchObject({ ok: true, data: { key: 'notes~u1', release: 3, version: '1.1.0' } });
    expect(client.posts.map((p) => p.path)).toContain('/api/app-instances/notes~u1/update');
    expect(await lib.appInstanceUpdate('app-instance:missing')).toMatchObject({ ok: false, error: expect.stringMatching(/no cloud app/) });
  });
  it('updateAll answers what moved; nothing installs by default (2026-10-09)', async () => {
    const client = fakeClient({ instances: [ORG, STALE] });
    const lib = buildMemberLibrary(client, { document: fakeDoc(), secure: true });
    const all = await lib.appInstancesUpdateAll();
    expect(all.ok).toBe(true);
    expect(all.data.updated.map((i) => i.key)).toEqual(['notes~u1']);
    expect(all.data.failed).toEqual([]);
    expect(lib.appInstancesInstallDefaults).toBeUndefined();
    expect(client.posts.map((p) => p.path)).toEqual(['/api/app-instances/update-all']);
  });
});
