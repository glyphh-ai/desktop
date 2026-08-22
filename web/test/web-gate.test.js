/**
 * web-gate.test.js — the LOGIN-FIRST wall (2026-08-03).
 *
 * `/` is the login shell; `/home` is the AUTHED app surface. The bridge bounces an
 * anonymous visitor landing on /home back to `/` BEFORE the renderer paints, and
 * exposes a minimal window.glyphhWeb with the instant cookie-backed isAuthed().
 * The old per-tab Work/Code gating (gateTab/requireAuth + lock affordances) was
 * removed with the wall — nobody signed-out reaches the tabs at all.
 * glyphh-web.js (the SDK singleton) is mocked so bridge.js assembles with no server.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/glyphh-web.js', () => ({
  glyphh: () => ({}),
  isAuthenticated: vi.fn(async () => false),
  signOut: vi.fn(async () => {}),
  API_URL: 'https://api.glyphh.ai',
}));

// A minimal browser: a live classList + a mutable document.cookie + a location
// with a pathname (the wall reads it) and replace/assign spies. No
// addEventListener → the bridge's real-browser boot wiring stays dormant.
function installWindow(cookie, pathname = '/') {
  const classes = new Set();
  const assigned = [];
  const replaced = [];
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
    location: {
      pathname,
      assign: (u) => assigned.push(u),
      replace: (u) => replaced.push(u),
      href: '',
    },
  };
  return { classes, assigned, replaced };
}

async function loadBridge(cookie, pathname = '/') {
  const ctx = installWindow(cookie, pathname);
  vi.resetModules();
  await import('../src/bridge.js');
  return { ...ctx, glyphhWeb: globalThis.window.glyphhWeb };
}

describe('window.glyphhWeb (login-first wall)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes the minimal surface — isAuthed only, per-tab gating is gone', async () => {
    const { glyphhWeb } = await loadBridge('');
    expect(typeof glyphhWeb.isAuthed).toBe('function');
    expect(glyphhWeb.gateTab).toBeUndefined();
    expect(glyphhWeb.requireAuth).toBeUndefined();
  });

  it('isAuthed reflects the glyphh_logged_in cookie', async () => {
    expect((await loadBridge('')).glyphhWeb.isAuthed()).toBe(false);
    expect((await loadBridge('glyphh_logged_in=1')).glyphhWeb.isAuthed()).toBe(true);
  });

  it('anonymous on /home bounces to the login shell before paint', async () => {
    const { replaced } = await loadBridge('', '/home');
    expect(replaced).toEqual(['/']);
  });

  it('anonymous on /home.html bounces too (direct file path)', async () => {
    const { replaced } = await loadBridge('', '/home.html');
    expect(replaced).toEqual(['/']);
  });

  it('an AUTHED session on /home is NOT bounced', async () => {
    const { replaced } = await loadBridge('glyphh_logged_in=1', '/home');
    expect(replaced).toEqual([]);
  });

  it('anonymous on /platform (the admin surface) bounces to the login shell too', async () => {
    const { replaced } = await loadBridge('', '/platform');
    expect(replaced).toEqual(['/']);
  });

  it('an AUTHED session on /platform is NOT bounced', async () => {
    const { replaced } = await loadBridge('glyphh_logged_in=1', '/platform');
    expect(replaced).toEqual([]);
  });

  it('the login shell itself never bounces (no redirect loop)', async () => {
    const anon = await loadBridge('', '/');
    expect(anon.replaced).toEqual([]);
    const authed = await loadBridge('glyphh_logged_in=1', '/');
    expect(authed.replaced).toEqual([]);
  });
});
