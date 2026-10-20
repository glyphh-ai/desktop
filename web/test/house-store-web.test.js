/**
 * house-store-web.test.js — the house panels' data on the web
 * (web/src/house-store-web.js; his order, 2026-10-06: cloud is the one
 * home). Over the fake member library and a fake server byte lane: the
 * shims are the shared store's doors, a write lands on the server for the
 * desktop to read, bytes ride the server lane with the bearer, and the
 * browser's own parts — the picker and the download — do their bit.
 */
import { webcrypto } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { createHouseStoreWeb } from '../src/house-store-web.js';
import { fakeLibrary } from './helpers/member-library.js';

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

/** The server's byte lane: PUTs land in `stored`, GETs serve them; a bearer or 401. */
function fakeLane() {
  const stored = new Map();
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const m = /^https:\/\/api\/api\/library\/v2\/([^/]+)\/([^/]+)\/files\/(.+)$/.exec(url);
    if (!m) return { ok: false, status: 400, arrayBuffer: async () => new ArrayBuffer(0) };
    if (!/^Bearer tok$/.test(init.headers?.authorization || '')) return { ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) };
    const key = `${m[1]}/${decodeURIComponent(m[2])}/${decodeURIComponent(m[3])}`;
    if (init.method === 'PUT') { stored.set(key, { bytes: init.body, mime: init.headers['content-type'] }); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }; }
    const hit = stored.get(key);
    if (!hit) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => hit.bytes.buffer.slice(hit.bytes.byteOffset, hit.bytes.byteOffset + hit.bytes.byteLength) };
  });
  return { stored, fetchImpl };
}

function rig({ seed = {}, file = null } = {}) {
  const memberLibrary = fakeLibrary(seed);
  const lane = fakeLane();
  const clicks = [];
  const doc = {
    createElement: (tag) => {
      const el = { tag, listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; }, click() { clicks.push(this); if (tag === 'input') { this.files = file ? [file] : []; this.listeners[file ? 'change' : 'cancel'](); } } };
      return el;
    },
  };
  let t = 10_000;
  const client = { memberLibrary, token: async () => 'tok' };
  const house = createHouseStoreWeb({ client, apiUrl: 'https://api', fetchImpl: lane.fetchImpl, now: () => ++t, document: doc });
  return { house, memberLibrary, lane, clicks };
}

describe('createHouseStoreWeb — the member library is the store, reads and writes alike', () => {
  it('a design made here is a `design` row on the server, listed and read back; the empty library is an empty list, never an error', async () => {
    const { house, memberLibrary } = rig();
    expect(await house.designList()).toEqual({ ok: true, designs: [] });
    expect(await house.designWrite('Brand', { name: 'Brand' })).toEqual({ ok: true, file: 'brand.json', title: 'Brand' });
    expect(memberLibrary.put).toHaveBeenCalledWith('design', 'brand.json', { data: { title: 'Brand', document: { name: 'Brand' }, folderId: null }, files: [], updatedAt: 10_001 });
    const l = await house.designList();
    expect(l.designs.map((d) => d.file)).toEqual(['brand.json']);
    expect(await house.designRead('brand')).toEqual({ ok: true, title: 'Brand', document: { name: 'Brand' } });
  });

  it('a deck the desktop saved is in the Slides panel here; + New here writes deck.html through the server lane with the bearer', async () => {
    const { house, lane, memberLibrary } = rig({ seed: { deck: [{ id: 'q3.html', updatedAt: 1_000, data: { title: 'Q3', slides: 4, sizeBytes: 12, folderId: null } }] } });
    lane.stored.set('deck/q3.html/deck.html', { bytes: new TextEncoder().encode('<html><title>Q3</title></html>'), mime: 'text/html' });
    const list = await house.gpointList();
    expect(list.decks).toEqual([{ file: 'q3.html', title: 'Q3', slides: 4, mtime: 1_000, size: 12 }]);
    expect(await house.gpointRead('q3')).toEqual({ ok: true, content: '<html><title>Q3</title></html>' });
    const n = await house.gpointNew('Pitch', 'Pitch');
    expect(n).toEqual({ ok: true, file: 'pitch.html', title: 'Pitch' });
    const put = lane.fetchImpl.mock.calls.find(([u, i]) => i.method === 'PUT' && u.endsWith('/deck/pitch.html/files/deck.html'));
    expect(put[1].headers).toEqual({ authorization: 'Bearer tok', 'content-type': 'text/html' });
    expect(new TextDecoder().decode(put[1].body)).toContain('<title>Pitch</title>');
    expect(memberLibrary.rows.get('deck:pitch.html').data).toMatchObject({ title: 'Pitch', slides: 1 });
    expect(memberLibrary.rows.get('deck:pitch.html').files[0]).toMatchObject({ path: 'deck.html' });
    expect(memberLibrary.rows.get('deck:pitch.html').files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('upload is the browser picker into the library; the url a card plays is the presigned GET; download is a Blob the browser saves', async () => {
    const png = new Uint8Array([1, 2, 3]);
    const file = { name: 'Sunset beach.png', type: 'image/png', arrayBuffer: async () => png.buffer };
    const { house, lane, clicks } = rig({ file });
    expect(await house.mediaUploadPick('image')).toEqual({ ok: true, id: 'image/Sunset-beach.png', kind: 'image', title: 'Sunset-beach' });
    expect(lane.stored.get('image/Sunset-beach.png/Sunset-beach.png')).toEqual({ bytes: png, mime: 'image/png' });
    const l = await house.mediaList('image');
    expect(l.assets.map((a) => [a.id, a.mime, a.sizeBytes])).toEqual([['image/Sunset-beach.png', 'image/png', 3]]);
    expect(await house.mediaUrl('image/Sunset-beach.png')).toEqual({ ok: true, url: 'https://r2/get/image/Sunset-beach.png/Sunset-beach.png' });
    expect(await house.mediaThumbBytes('image/Sunset-beach.png')).toEqual({ ok: true, bytes: png, mime: 'image/png' });
    const urls = [];
    globalThis.URL.createObjectURL = (b) => { urls.push(b); return 'blob:x'; };
    globalThis.URL.revokeObjectURL = () => {};
    globalThis.Blob = class { constructor(parts, opts) { this.parts = parts; this.type = opts.type; } };
    expect(await house.mediaSave('image/Sunset-beach.png')).toEqual({ ok: true, path: 'Sunset-beach.png' });
    expect(urls[0].type).toBe('image/png');
    expect(clicks.at(-1)).toMatchObject({ tag: 'a', href: 'blob:x', download: 'Sunset-beach.png' });
    expect(await house.mediaDelete('image/Sunset-beach.png')).toEqual({ ok: true });
    expect((await house.mediaList('image')).assets).toEqual([]);
  });

  it('a cancelled pick says so; the legacy sub-kinds answer empty; generation stays the agent\'s', async () => {
    const { house } = rig();
    expect(await house.mediaUploadPick('image')).toEqual({ ok: false, error: 'cancelled' });
    expect(await house.mediaList('avatar')).toEqual({ ok: true, assets: [] });
    expect((await house.mediaGenerate({})).ok).toBe(false);
    expect((await house.mediaJob('j')).ok).toBe(false);
  });

  it('Drive is the view across every kind, with folders made here', async () => {
    const { house } = rig({ seed: { image: [{ id: 'a.png', updatedAt: 1_000, data: { title: 'a', mime: 'image/png', sizeBytes: 3, width: null, height: null, durationMs: null, meta: {}, folderId: null } }] } });
    const f = await house.gdriveMkdir('Shots');
    expect(f.ok).toBe(true);
    expect(await house.gdriveMove('media', 'image/a.png', f.folder.id)).toEqual({ ok: true });
    const d = await house.gdriveList();
    expect(d.folders).toEqual([{ id: f.folder.id, name: 'Shots', parentId: null }]);
    expect(d.files).toEqual([{ kind: 'media', subkind: 'image', mime: 'image/png', ref: 'image/a.png', file: 'image/a.png', title: 'a', sizeBytes: 3, updatedAt: expect.any(String), folderId: f.folder.id }]);
    expect(await house.gdriveFolderRename(f.folder.id, 'Pictures')).toMatchObject({ ok: true, folder: { name: 'Pictures' } });
    expect(await house.gdriveFolderDelete(f.folder.id)).toEqual({ ok: true });
    expect((await house.gdriveList()).files[0].folderId).toBeNull();
  });
});
