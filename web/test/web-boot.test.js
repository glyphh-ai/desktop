/**
 * web-boot.test.js — the WEB boot-state decision + the callback/app/login routing.
 *
 * The pure decision (decideBootState / parseCallbackParams) is exercised directly.
 * For the orchestrator we mock the SDK-touching seams (glyphh-web.js) and the login
 * mount (web-login.js), and give web-boot a minimal DOM (splash + overlay) so we can
 * assert which branch it took without a browser or a server.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { decideBootState, parseCallbackParams, CALLBACK_PATH } from '../src/glyphh-core.js';

// ── Pure decision ──────────────────────────────────────────────────────────────

describe('parseCallbackParams', () => {
  it('extracts the magic-link token', () => {
    expect(parseCallbackParams('?token=abc123')).toEqual({ token: 'abc123', code: null, redirect: null });
  });
  it('extracts a one-time exchange code', () => {
    expect(parseCallbackParams('?code=xyz')).toMatchObject({ code: 'xyz', token: null });
  });
  it('keeps an in-app redirect but rejects off-site / protocol-relative ones', () => {
    expect(parseCallbackParams('?token=t&redirect=%2Fchat').redirect).toBe('/chat');
    expect(parseCallbackParams('?token=t&redirect=https://evil.com').redirect).toBe(null);
    expect(parseCallbackParams('?token=t&redirect=//evil.com').redirect).toBe(null);
  });
  it('is empty for a blank search', () => {
    expect(parseCallbackParams('')).toEqual({ token: null, code: null, redirect: null });
  });
});

describe('decideBootState', () => {
  it('authed → app', () => {
    expect(decideBootState({ pathname: '/', search: '', authenticated: true })).toBe('app');
  });
  it('unauthed → login', () => {
    expect(decideBootState({ pathname: '/', search: '', authenticated: false })).toBe('login');
  });
  it('callback path WITH a token → callback (even when unauthenticated)', () => {
    expect(decideBootState({ pathname: CALLBACK_PATH, search: '?token=t', authenticated: false })).toBe('callback');
  });
  it('callback path WITH a code → callback', () => {
    expect(decideBootState({ pathname: CALLBACK_PATH, search: '?code=c', authenticated: false })).toBe('callback');
  });
  it('callback path with NO token/code falls through to auth (login)', () => {
    expect(decideBootState({ pathname: CALLBACK_PATH, search: '', authenticated: false })).toBe('login');
  });
});

// ── Orchestrator (mocked seams) ─────────────────────────────────────────────────

const web = {
  isAuthenticated: vi.fn(async () => false),
  syncGating: vi.fn(async () => ({ email: 'a@b.co' })),
  signInWithGoogle: vi.fn(async () => {}),
  startEmailLink: vi.fn(async () => ({})),
  verifyEmailLink: vi.fn(async () => {}),
  exchangeCode: vi.fn(async () => {}),
};
vi.mock('../src/glyphh-web.js', () => web);

const login = { mountLogin: vi.fn() };
vi.mock('../src/web-login.js', () => login);

/** A throwaway element with the class-list + methods web-boot touches. */
function fakeEl() {
  return { classList: { add: vi.fn(), remove: vi.fn() }, textContent: '', remove: vi.fn() };
}

function installDom({ pathname = '/', search = '' } = {}) {
  const els = { splash: fakeEl(), 'splash-status': fakeEl(), 'onboarding-overlay': fakeEl() };
  globalThis.window = {
    location: { pathname, search, origin: 'http://localhost:3002', reload: vi.fn() },
    history: { replaceState: vi.fn() },
    __GLYPHH_GOOGLE_CLIENT_ID__: 'gid',
    dispatchEvent: vi.fn(),
    Event: class { constructor(t) { this.type = t; } },
  };
  globalThis.Event = globalThis.window.Event;
  globalThis.document = { getElementById: (id) => els[id] || null };
  return els;
}

let startWebBoot;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  ({ startWebBoot } = await import('../src/web-boot.js'));
});

describe('startWebBoot routing', () => {
  it('authenticated boot → syncGating + enter app (dispatches yo-onboarding-done), no login', async () => {
    const els = installDom({ pathname: '/' });
    web.isAuthenticated.mockResolvedValueOnce(true);
    await startWebBoot();
    expect(web.syncGating).toHaveBeenCalled();
    expect(login.mountLogin).not.toHaveBeenCalled();
    expect(els['onboarding-overlay'].classList.add).toHaveBeenCalledWith('hidden');
    expect(window.dispatchEvent).toHaveBeenCalled();
    expect(window.dispatchEvent.mock.calls[0][0].type).toBe('yo-onboarding-done');
  });

  it('unauthenticated boot → mounts the login screen, no syncGating', async () => {
    installDom({ pathname: '/' });
    web.isAuthenticated.mockResolvedValueOnce(false);
    await startWebBoot();
    expect(login.mountLogin).toHaveBeenCalledTimes(1);
    expect(login.mountLogin.mock.calls[0][0]).toMatchObject({ googleClientId: 'gid', origin: 'http://localhost:3002' });
    expect(web.syncGating).not.toHaveBeenCalled();
  });

  it('callback path with a token → verifyEmailLink, then enter app', async () => {
    const els = installDom({ pathname: CALLBACK_PATH, search: '?token=tok&redirect=%2Fchat' });
    await startWebBoot();
    expect(web.verifyEmailLink).toHaveBeenCalledWith('tok');
    expect(web.syncGating).toHaveBeenCalled();
    expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/chat');
    expect(login.mountLogin).not.toHaveBeenCalled();
    expect(window.dispatchEvent.mock.calls[0][0].type).toBe('yo-onboarding-done');
    void els;
  });

  it('callback path with a code → exchangeCode, then enter app', async () => {
    installDom({ pathname: CALLBACK_PATH, search: '?code=c' });
    await startWebBoot();
    expect(web.exchangeCode).toHaveBeenCalledWith('c');
    expect(web.syncGating).toHaveBeenCalled();
  });

  it('callback exchange failure → falls back to the login screen', async () => {
    installDom({ pathname: CALLBACK_PATH, search: '?token=bad' });
    web.verifyEmailLink.mockRejectedValueOnce(new Error('expired'));
    await startWebBoot();
    expect(login.mountLogin).toHaveBeenCalledTimes(1);
    expect(login.mountLogin.mock.calls[0][0].initialError).toBe('expired');
    expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/');
  });
});
