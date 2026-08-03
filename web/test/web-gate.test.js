/**
 * web-gate.test.js — the WEB tab-gate surface the bridge exposes as window.glyphhWeb.
 *
 * Chat is the open front door; Work (cowork) + Code are gated behind sign-in on web.
 * The renderer's rail tab-switch consults window.glyphhWeb SYNCHRONOUSLY on a click:
 *   • isAuthed()      — instant, reads the glyphh_logged_in gating cookie
 *   • gateTab(tab)    — 'switch' (allow) | 'auth' (route to sign-in)
 *   • requireAuth()   — navigates to the /auth login shell
 * glyphh-web.js (the SDK singleton) is mocked so bridge.js assembles with no server.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/glyphh-web.js', () => ({
  glyphh: () => ({}),
  isAuthenticated: vi.fn(async () => false),
  signOut: vi.fn(async () => {}),
  API_URL: 'https://api.glyphh.ai',
}));

// A minimal browser: a live classList (so reflectAuthClass runs) + a mutable
// document.cookie + an assignable location. No addEventListener → the bridge's
// real-browser boot wiring stays dormant (kept importable, like node --test).
function installWindow(cookie) {
  const classes = new Set();
  const assigned = [];
  globalThis.document = {
    cookie,
    documentElement: {
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
        has: (c) => classes.has(c),
      },
    },
  };
  globalThis.window = {
    location: { assign: (u) => assigned.push(u), href: '' },
  };
  return { classes, assigned };
}

async function loadBridge(cookie) {
  const ctx = installWindow(cookie);
  vi.resetModules();
  await import('../src/bridge.js');
  return { ...ctx, glyphhWeb: globalThis.window.glyphhWeb };
}

describe('window.glyphhWeb (web tab gate)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is assembled on the window with the gate surface', async () => {
    const { glyphhWeb } = await loadBridge('');
    expect(typeof glyphhWeb.isAuthed).toBe('function');
    expect(typeof glyphhWeb.gateTab).toBe('function');
    expect(typeof glyphhWeb.requireAuth).toBe('function');
  });

  it('isAuthed reflects the glyphh_logged_in cookie', async () => {
    expect((await loadBridge('')).glyphhWeb.isAuthed()).toBe(false);
    expect((await loadBridge('glyphh_logged_in=1')).glyphhWeb.isAuthed()).toBe(true);
  });

  it('logged out: Work + Code gate to auth, Chat always switches', async () => {
    const { glyphhWeb } = await loadBridge('');
    expect(glyphhWeb.gateTab('chat')).toBe('switch');
    expect(glyphhWeb.gateTab('cowork')).toBe('auth');
    expect(glyphhWeb.gateTab('code')).toBe('auth');
  });

  it('logged in: every tab switches', async () => {
    const { glyphhWeb } = await loadBridge('glyphh_logged_in=1');
    expect(glyphhWeb.gateTab('chat')).toBe('switch');
    expect(glyphhWeb.gateTab('cowork')).toBe('switch');
    expect(glyphhWeb.gateTab('code')).toBe('switch');
  });

  it('requireAuth navigates to the /auth login shell', async () => {
    const { glyphhWeb, assigned } = await loadBridge('');
    glyphhWeb.requireAuth();
    expect(assigned).toEqual(['/auth']);
  });

  it('reflects the auth state as a class on <html> for the lock affordance', async () => {
    const anon = await loadBridge('');
    expect(anon.classes.has('glyphh-web-anon')).toBe(true);
    expect(anon.classes.has('glyphh-web-authed')).toBe(false);

    const authed = await loadBridge('glyphh_logged_in=1');
    expect(authed.classes.has('glyphh-web-authed')).toBe(true);
    expect(authed.classes.has('glyphh-web-anon')).toBe(false);
  });
});
