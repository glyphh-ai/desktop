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

const infra = {
  infra: vi.fn(async () => ({ mode: 'shared', region: 'local', regionChosen: false, regions: [{ id: 'local' }] })),
  chooseInfra: vi.fn(async () => ({ mode: 'shared', region: 'local', regionChosen: true, regions: [{ id: 'local' }] })),
};
const web = {
  isAuthenticated: vi.fn(async () => false),
  serverReachable: vi.fn(async () => true),
  syncGating: vi.fn(async () => ({ email: 'a@b.co' })),
  signInWithGoogle: vi.fn(async () => {}),
  startEmailLink: vi.fn(async () => ({})),
  verifyEmailLink: vi.fn(async () => {}),
  exchangeCode: vi.fn(async () => {}),
  // LOGIN-FIRST first-run completion: web-boot persists the one-time region
  // choice through the SDK client (org.infra / org.chooseInfra).
  glyphh: () => ({ org: infra }),
};
vi.mock('../src/glyphh-web.js', () => web);

const login = { mountLogin: vi.fn() };
vi.mock('../src/web-login.js', () => login);

/** A throwaway element with the class-list + methods web-boot touches. */
function fakeEl() {
  return { classList: { add: vi.fn(), remove: vi.fn() }, textContent: '', remove: vi.fn() };
}

function installDom({ pathname = '/', search = '', webBoot = true, loginShell = true } = {}) {
  // The login shell (index.html) has the onboarding overlay; the home shell (home.html) does not.
  const els = { splash: fakeEl(), 'splash-status': fakeEl() };
  if (loginShell) els['onboarding-overlay'] = fakeEl();
  // Drivers, when present, forward their onComplete callback (the nav) so tests can
  // assert the hand-off nav fires.
  const glyphhWebBoot = webBoot
    ? { showFirstRun: vi.fn((cb) => cb && cb()), enterApp: vi.fn((cb) => cb && cb()) }
    : undefined;
  globalThis.window = {
    location: { pathname, search, origin: 'http://localhost:3002', reload: vi.fn(), assign: vi.fn(), href: '' },
    history: { replaceState: vi.fn() },
    __GLYPHH_GOOGLE_CLIENT_ID__: 'gid',
    glyphhWebBoot,
    dispatchEvent: vi.fn(),
    Event: class { constructor(t) { this.type = t; } },
  };
  globalThis.Event = globalThis.window.Event;
  globalThis.document = { getElementById: (id) => els[id] || null };
  return { els, drivers: glyphhWebBoot };
}

let startWebBoot;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  ({ startWebBoot } = await import('../src/web-boot.js'));
});

describe('startWebBoot routing', () => {
  it('NOT authenticated → login ONLY (no syncGating, no first-run)', async () => {
    const { drivers } = installDom({ pathname: '/' });
    web.isAuthenticated.mockResolvedValueOnce(false);
    await startWebBoot();
    expect(login.mountLogin).toHaveBeenCalledTimes(1);
    expect(login.mountLogin.mock.calls[0][0]).toMatchObject({ googleClientId: 'gid', origin: 'http://localhost:3002' });
    expect(web.syncGating).not.toHaveBeenCalled();
    expect(drivers.showFirstRun).not.toHaveBeenCalled();
    expect(drivers.enterApp).not.toHaveBeenCalled();
  });

  it('authed + regionChosen=false (NEW user) → first-run shown once, then navigates to Chat tab on completion', async () => {
    const { els, drivers } = installDom({ pathname: '/' });
    web.isAuthenticated.mockResolvedValueOnce(true);
    web.syncGating.mockResolvedValueOnce({ email: 'new@b.co', regionChosen: false });
    await startWebBoot();
    expect(web.syncGating).toHaveBeenCalled();
    expect(login.mountLogin).not.toHaveBeenCalled();
    expect(els['onboarding-overlay'].classList.add).toHaveBeenCalledWith('hidden');
    // LOGIN-FIRST: the login shell never consults renderer drivers (blank browser
    // workspace) — a new user gets the region choice stamped, then navigates.
    expect(drivers.showFirstRun).not.toHaveBeenCalled();
    expect(drivers.enterApp).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(window.location.assign).toHaveBeenCalledWith('/platform'));
    expect(infra.chooseInfra).toHaveBeenCalledWith({ region: 'local', tier: 'shared' });
  });

  it('authed + regionChosen=true (RETURNING user) → straight into app, navigates to Chat tab, NO first-run', async () => {
    const { drivers } = installDom({ pathname: '/' });
    web.isAuthenticated.mockResolvedValueOnce(true);
    web.syncGating.mockResolvedValueOnce({ email: 'ret@b.co', regionChosen: true });
    await startWebBoot();
    // Drivers are never consulted on the login shell; a returning user just lands.
    expect(drivers.enterApp).not.toHaveBeenCalled();
    expect(drivers.showFirstRun).not.toHaveBeenCalled();
    expect(window.location.assign).toHaveBeenCalledWith('/platform');
  });

  it('remembered Builder tab (glyphhSurfaceTab=builder) → lands on /apps instead of /platform', async () => {
    installDom({ pathname: '/' });
    globalThis.localStorage = { getItem: vi.fn(() => 'builder'), setItem: vi.fn() };
    try {
      web.isAuthenticated.mockResolvedValueOnce(true);
      web.syncGating.mockResolvedValueOnce({ email: 'ret@b.co', regionChosen: true });
      await startWebBoot();
      expect(window.location.assign).toHaveBeenCalledWith('/apps');
    } finally {
      delete globalThis.localStorage;
    }
  });

  it('callback token → verifyEmailLink, then first-run for a new user', async () => {
    const { drivers } = installDom({ pathname: CALLBACK_PATH, search: '?token=tok&redirect=%2Fchat' });
    web.syncGating.mockResolvedValueOnce({ email: 'new@b.co', regionChosen: false });
    await startWebBoot();
    expect(web.verifyEmailLink).toHaveBeenCalledWith('tok');
    expect(web.syncGating).toHaveBeenCalled();
    expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/chat');
    expect(login.mountLogin).not.toHaveBeenCalled();
    // New user via magic link: region stamped through the SDK, then /home — no
    // tutorial on the blank login shell.
    expect(drivers.showFirstRun).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(window.location.assign).toHaveBeenCalledWith('/platform'));
    expect(infra.chooseInfra).toHaveBeenCalled();
  });

  it('callback code → exchangeCode, then enter app for a returning user', async () => {
    const { drivers } = installDom({ pathname: CALLBACK_PATH, search: '?code=c' });
    web.syncGating.mockResolvedValueOnce({ email: 'ret@b.co', regionChosen: true });
    await startWebBoot();
    expect(web.exchangeCode).toHaveBeenCalledWith('c');
    expect(web.syncGating).toHaveBeenCalled();
    expect(drivers.enterApp).not.toHaveBeenCalled();
    expect(window.location.assign).toHaveBeenCalledWith('/platform');
  });

  it('callback exchange failure → falls back to the login screen', async () => {
    const { drivers } = installDom({ pathname: CALLBACK_PATH, search: '?token=bad' });
    web.verifyEmailLink.mockRejectedValueOnce(new Error('expired'));
    await startWebBoot();
    expect(login.mountLogin).toHaveBeenCalledTimes(1);
    expect(login.mountLogin.mock.calls[0][0].initialError).toBe('expired');
    expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(drivers.showFirstRun).not.toHaveBeenCalled();
    expect(drivers.enterApp).not.toHaveBeenCalled();
  });

  it('drivers never appear → dispatches yo-onboarding-done AND navigates to Chat tab so the app still lands', async () => {
    installDom({ pathname: '/', webBoot: false });
    web.isAuthenticated.mockResolvedValueOnce(true);
    web.syncGating.mockResolvedValueOnce({ email: 'x@b.co', regionChosen: true });
    const p = startWebBoot();
    await vi.advanceTimersByTimeAsync(4100); // exhaust the whenWebBootReady poll timeout
    await p;
    expect(window.dispatchEvent).toHaveBeenCalled();
    expect(window.dispatchEvent.mock.calls[0][0].type).toBe('yo-onboarding-done');
    expect(window.location.assign).toHaveBeenCalledWith('/platform');
  });
});

describe('startWebBoot — Chat tab / home shell (input-first, no login wall)', () => {
  it('LOGGED-OUT on the Chat tab → renders (no login, no redirect, no first-run)', async () => {
    const { drivers } = installDom({ pathname: '/', loginShell: false });
    web.isAuthenticated.mockResolvedValueOnce(false);
    await startWebBoot();
    // Anonymous visitor is left to render home.ts; never walled or bounced.
    expect(login.mountLogin).not.toHaveBeenCalled();
    expect(window.location.assign).not.toHaveBeenCalled();
    expect(web.syncGating).not.toHaveBeenCalled();
    expect(drivers.showFirstRun).not.toHaveBeenCalled();
    expect(drivers.enterApp).not.toHaveBeenCalled();
  });

  it('AUTHED on the Chat tab → renders, best-effort syncGating, no redirect/login', async () => {
    installDom({ pathname: '/', loginShell: false });
    web.isAuthenticated.mockResolvedValueOnce(true);
    await startWebBoot();
    expect(login.mountLogin).not.toHaveBeenCalled();
    expect(window.location.assign).not.toHaveBeenCalled();
    expect(web.syncGating).toHaveBeenCalled(); // lights up the session-aware UI
  });
});
