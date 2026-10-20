/**
 * wb-relay.test.js — the WEB workbench's window.wb for a DESKTOP session
 * (his report, 2026-10-05: "neither is the file system, or diff data"): every
 * Files / Diff / Editor verb reaches the attached desktop as the relay method
 * the desktop's door serves (remote-control.ts) and the server allowlists
 * (attach.py REMOTE_METHODS), with the exact params; the panels root at the
 * SESSION's folder; a failure keeps preload.ts's error shapes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createWbRelay } from '../src/wb-relay.js';
import { createWbSelector, noteSessionsSnapshot } from '../src/wb-pod.js';

// The locus event rides window; a bare EventTarget is all these units need.
globalThis.window = new EventTarget();

let calls;
let attached;
let answer;
let root;
const client = {
  attach: {
    status: async () => ({ attached }),
    dispatch(method, params) { calls.push([method, params]); if (answer instanceof Error) throw answer; return answer; },
  },
  token: async () => 'tok',
};
const wb = () => createWbRelay({ client, apiUrl: 'https://api.test', isAuthenticated: async () => true, getRoot: () => root });

beforeEach(() => { calls = []; attached = true; answer = { ok: true }; root = ''; });

describe('the Files / Diff / Editor verbs over the relay', () => {
  it('dispatches each verb as the method the desktop door serves, with its params', async () => {
    const w = wb();
    answer = { entries: [{ name: 'a.ts', path: '/g/app/a.ts', kind: 'file' }] };
    expect(await w.listDir('/g/app')).toEqual(answer);
    answer = { content: 'x' };
    expect(await w.readFile('/g/app/a.ts')).toEqual(answer);
    answer = { ok: true };
    expect(await w.writeFile('/g/app/a.ts', 'y')).toEqual(answer);
    expect(await w.deletePath('/g/app/a.ts')).toEqual(answer);
    expect(await w.renamePath('/g/app/a.ts', '/g/app/b.ts')).toEqual(answer);
    answer = { entries: [], truncated: false };
    expect(await w.searchFiles('/g/app', 'a')).toEqual(answer);
    answer = { text: 'diff' };
    expect(await w.gitDiff('/g/app')).toEqual(answer);
    expect(await w.gitDiff('/g/app', 'a.ts')).toEqual(answer);
    answer = { branch: 'main', entries: [{ status: ' M', path: 'a.ts' }] };
    expect(await w.gitStatus('/g/app')).toEqual(answer);
    answer = { isRepo: true, branch: 'main' };
    expect(await w.gitInfo('/g/app')).toEqual({ isRepo: true, branch: 'main' });
    expect(calls).toEqual([
      ['fs.listDir', { dir: '/g/app' }],
      ['fs.read', { path: '/g/app/a.ts' }],
      ['fs.write', { path: '/g/app/a.ts', content: 'y' }],
      ['fs.delete', { path: '/g/app/a.ts' }],
      ['fs.rename', { path: '/g/app/a.ts', to: '/g/app/b.ts' }],
      ['fs.search', { dir: '/g/app', query: 'a' }],
      ['fs.gitDiff', { root: '/g/app' }],
      ['fs.gitDiff', { root: '/g/app', file: 'a.ts' }],
      ['git.status', { path: '/g/app' }],
      ['fs.gitInfo', { path: '/g/app' }],
    ]);
  });

  it("keeps preload's error shapes when the desktop refuses or is gone", async () => {
    const w = wb();
    answer = new Error('that folder is not one this machine granted for remote control');
    expect(await w.readFile('/secret')).toEqual({ content: '', error: 'that folder is not one this machine granted for remote control' });
    expect(await w.writeFile('/secret', 'x')).toEqual({ ok: false, error: 'that folder is not one this machine granted for remote control' });
    expect(await w.deletePath('/secret')).toEqual({ ok: false, error: expect.stringMatching(/not one this machine granted/) });
    expect(await w.gitDiff('/secret')).toEqual({ text: '', error: expect.stringMatching(/not one this machine granted/) });
    expect(await w.gitStatus('/secret')).toEqual({ entries: [], error: expect.stringMatching(/not one this machine granted/) });
    attached = false;
    const off = wb();
    expect(await off.listDir('/g')).toEqual({ entries: [], error: 'no desktop attached' });
    expect(await off.webFsStatus()).toBe('desktop-offline');
  });

  it("roots the panels at the SESSION's folder, and only falls back to the desktop's own folder without one", async () => {
    const w = wb();
    answer = { cwd: '/desk/elsewhere', explicit: '/desk/elsewhere' };
    expect(await w.getCwd()).toBe('/desk/elsewhere');
    expect(calls).toEqual([['fs.cwd', {}]]);
    root = '/g/app';
    expect(await w.getCwd()).toBe('/g/app');
    expect(await w.getCwdExplicit()).toBe('/g/app');
    expect(await w.setCwd('/anything')).toBe('/g/app');
    expect(calls).toHaveLength(1); // no round trip for a session that names its folder
  });
});

describe('the selector follows a desktop session into its folder', () => {
  it('re-roots the relay panels when the current session changes folder, and flips transports for a cloud one', async () => {
    const roots = [];
    const relay = { onFileChanged: () => () => {}, onGitChanged: () => () => {}, onCwdChanged: () => () => {}, getCwd: async () => `relay:${roots.at(-1) ?? ''}` };
    const pod = { onFileChanged: () => () => {}, onGitChanged: () => () => {}, onCwdChanged: () => () => {}, getCwd: async () => 'pod:/ws' };
    let folder = '';
    let cloud = false;
    const sel = createWbSelector({ relay, pod, isCloud: () => cloud, getRoot: () => folder });
    const seen = [];
    sel.onCwdChanged((c) => seen.push(c));
    // The event the locus fires; wired here by hand since there is no window.
    const change = () => { roots.push(folder); window.dispatchEvent(new CustomEvent('glyphh:wb-locus-changed')); };
    folder = '/g/app'; change();
    await new Promise((r) => setTimeout(r, 0));
    folder = '/g/other'; change();
    await new Promise((r) => setTimeout(r, 0));
    cloud = true; change();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['relay:/g/app', 'relay:/g/other', 'pod:/ws']);
  });

  it('the locus names a local session\'s folder (its workdir, else its source path)', () => {
    const chats = [
      { id: 'a', source: { kind: 'local', path: '/g/app' } },
      { id: 'b', workdir: '/g/w', source: { kind: 'local', path: '/g/app' } },
      { id: 'c', source: { kind: 'cloud', space: 's' } },
    ];
    const seen = [];
    window.addEventListener('glyphh:wb-locus-changed', (e) => seen.push(e.detail.folder));
    noteSessionsSnapshot(chats, 'a');
    noteSessionsSnapshot(chats, 'b');
    noteSessionsSnapshot(chats, 'c');
    noteSessionsSnapshot([], '');
    expect(seen).toEqual(['/g/app', '/g/w', '', '']);
  });
});
