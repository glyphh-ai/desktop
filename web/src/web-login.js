/**
 * web-login.js — the WEB target's sign-in screen. A faithful port of the platform
 * login (platform/app/auth/login/page.js): a primary email magic-link, plus a
 * "Continue with Google" button over Google Identity Services (GIS). Desktop uses
 * device-flow (src/renderer/onboarding.ts); this file is the web-only replacement,
 * only ever mounted by web-boot.js under __GLYPHH_WEB__.
 *
 * It reuses the renderer's already-ported `auth-shell` markup + CSS (scoped to
 * #onboarding-overlay), so it inherits the platform look with no new chrome. The
 * SDK does every server exchange; here we only collect an email or a Google ID
 * token and hand it over.
 */

import { CALLBACK_PATH } from './glyphh-core.js';

const GOOGLE_GSI_SRC = 'https://accounts.google.com/gsi/client';

/** Load an external script once; resolve when ready. (Ported from platform social.js.) */
let _gsiPromise = null;
function loadGsi() {
  if (_gsiPromise) return _gsiPromise;
  _gsiPromise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') return reject(new Error('no document'));
    const existing = document.querySelector(`script[src="${GOOGLE_GSI_SRC}"]`);
    if (existing) return resolve();
    const el = document.createElement('script');
    el.src = GOOGLE_GSI_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('failed to load Google sign-in'));
    document.head.appendChild(el);
  });
  return _gsiPromise;
}

/**
 * Render Google's official button into `container` and wire its ID-token callback.
 * The 4-colour "G" face is a click-through overlay (pointer-events:none) so the user
 * sees the app's button while the real GIS button captures the click — identical to
 * platform's GoogleButton. Resolves once the button is painted; onCredential fires
 * later with the Google ID token (a JWT) we hand to the SDK.
 */
async function renderGoogleButton(container, clientId, onCredential, onError) {
  await loadGsi();
  const google = (typeof window !== 'undefined' && window.google) || null;
  if (!google?.accounts?.id) throw new Error('Google sign-in unavailable');
  google.accounts.id.initialize({
    client_id: clientId,
    callback: (resp) => {
      if (resp?.credential) onCredential(resp.credential);
      else onError?.(new Error('Google sign-in was cancelled'));
    },
  });
  container.innerHTML = '';
  google.accounts.id.renderButton(container, {
    type: 'standard',
    theme: 'filled_black',
    size: 'large',
    shape: 'pill',
    text: 'continue_with',
    logo_alignment: 'center',
    width: Math.round(container.getBoundingClientRect().width) || 320,
  });
}

/** Small DOM helper. Shared with web-device.js, which renders into the same shell. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Google's four-colour "G" mark (matches platform's GoogleG). */
function googleG() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 18 18');
  svg.setAttribute('aria-hidden', 'true');
  const paths = [
    ['#4285F4', 'M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z'],
    ['#34A853', 'M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z'],
    ['#FBBC05', 'M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z'],
    ['#EA4335', 'M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z'],
  ];
  for (const [fill, d] of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('fill', fill);
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Mount the login screen into the onboarding overlay and wire the flows.
 *
 * @param {object} deps
 * @param {() => Promise<void>|void} deps.onGoogle          exchange a Google ID token → session
 * @param {(email:string, redirectUri:string) => Promise<{devUrl?:string}>} deps.onStartEmailLink
 * @param {() => Promise<void>} deps.onAuthed               run after any successful in-page sign-in (Google)
 * @param {string|null} deps.googleClientId                 GIS client id (null hides the Google button)
 * @param {string} deps.origin                              page origin, for building the callback redirectUri
 * @param {string} [deps.redirectUri]                       override where the magic link returns (device page)
 * @param {string} [deps.title]                             heading override (device page: "Authorize your device")
 * @param {string} [deps.lede]                              sub-heading override
 * @param {(doc:Document) => Node} [deps.intro]             extra node rendered above the form (the device code)
 * @param {string} [deps.initialError]                      error to surface on first paint
 * @param {Document} [deps.doc]                             injectable for tests (defaults to document)
 */
export function mountLogin(deps) {
  const doc = deps.doc || document;
  const overlay = doc.getElementById('onboarding-overlay');
  const step = doc.getElementById('onboarding-step-auth');
  if (!overlay || !step) return; // not the main shell (home.html has no onboarding markup)

  overlay.classList.remove('hidden');
  // Surfaced ONCE, on first paint (e.g. "this sign-in link has expired" after a failed
  // callback exchange) — not re-shown when the user re-renders the form.
  let pendingError = deps.initialError || '';
  // Normally the magic link returns to /auth/callback and lands in the app; the
  // DEVICE page passes its own redirectUri so the link comes back to the pending
  // approval (code preserved) instead.
  const redirectUri = deps.redirectUri || `${deps.origin}${CALLBACK_PATH}`;

  const render = () => {
    step.innerHTML = '';
    if (deps.title) {
      // OVERRIDDEN heading (the device-approval page) keeps its own title + lede.
      step.append(el('h1', 'auth-shell-title', deps.title));
      step.append(el('p', 'auth-shell-lede', deps.lede || 'Enter your email for a magic link, or continue with a provider.'));
    } else {
      // The LOGIN landing: the product headline, the desktop download card,
      // then the form itself — no "Sign in" title, no instructional lede.
      step.append(el('h1', 'auth-shell-title', 'A New Way of Working with AI'));
      const card = doc.createElement('a');
      card.className = 'auth-download-card';
      card.href = 'https://github.com/glyphh-ai/glyphh-releases/releases/latest';
      card.target = '_blank';
      card.rel = 'noopener';
      const ic = doc.createElement('span');
      ic.className = 'auth-download-ic';
      ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
      const txt = el('span', 'auth-download-copy');
      txt.append(el('strong', 'auth-download-title', 'Get the desktop app'));
      txt.append(el('span', 'auth-download-sub', 'The full workspace on your machine — macOS, free.'));
      card.append(ic, txt);
      step.append(card);
    }
    if (deps.intro) step.append(deps.intro(doc));

    let loading = '';

    // ── Magic-link form ──────────────────────────────────────────────────────
    const form = el('form', 'auth-shell-form');
    form.setAttribute('novalidate', '');
    const field = el('div', 'auth-shell-field');
    const label = el('label', 'auth-shell-label', 'Email');
    label.htmlFor = 'login-email';
    const input = el('input', 'auth-shell-input');
    input.id = 'login-email';
    input.type = 'email';
    input.placeholder = 'you@example.com';
    input.autofocus = true;
    const fieldErr = el('p', 'auth-shell-field-error');
    fieldErr.style.display = 'none';
    field.append(label, input, fieldErr);

    const err = el('p', 'auth-shell-error');
    err.style.display = 'none';

    const submit = el('button', 'btn btn-primary btn-lg btn-full', 'Email me a magic link');
    submit.type = 'submit';
    const actions = el('div', 'auth-shell-actions');
    actions.append(submit);
    // The consent line under the button — the Privacy Policy opens in a new
    // tab (glyphh.ai/privacy, the marketing site's page, same as platform's
    // legal line), and continuing doubles as the promotional-email opt-in.
    const legal = el('p', 'auth-shell-legal');
    legal.append(doc.createTextNode('By continuing, you acknowledge Glyphh\u2019s '));
    const pp = el('a', '', 'Privacy Policy');
    pp.href = 'https://glyphh.ai/privacy';
    pp.target = '_blank';
    pp.rel = 'noreferrer';
    legal.append(pp);
    legal.append(doc.createTextNode(' and agree to receive occasional promotional emails and notifications.'));
    form.append(field, err, actions, legal);

    const showFieldErr = (m) => { fieldErr.textContent = m; fieldErr.style.display = ''; input.classList.add('has-error'); };
    const clearErrs = () => { fieldErr.style.display = 'none'; input.classList.remove('has-error'); err.style.display = 'none'; };
    input.addEventListener('input', () => { if (fieldErr.style.display !== 'none') clearErrs(); });

    const setBusy = (which) => {
      loading = which;
      submit.disabled = !!which;
      input.disabled = !!which;
      submit.textContent = which === 'email' ? 'Sending link…' : 'Email me a magic link';
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrs();
      const value = input.value.trim();
      if (!value) return showFieldErr('Email is required');
      if (!EMAIL_RE.test(value)) return showFieldErr('Enter a valid email address');
      setBusy('email');
      try {
        const res = await deps.onStartEmailLink(value, redirectUri);
        renderSent(value, res && res.devUrl);
      } catch (ex) {
        err.textContent = (ex && ex.message) || 'Could not send the link — please try again';
        err.style.display = '';
        setBusy('');
      }
    });

    step.append(form);

    // ── Google (GIS) — hidden when no client id is configured ────────────────
    if (deps.googleClientId) {
      const divider = el('div', 'auth-shell-divider');
      divider.append(el('span', undefined, 'or'));
      const social = el('div', 'auth-shell-social');
      const gWrap = el('div', 'google-btn');
      const gis = el('div', 'google-btn-gis');
      const face = el('span', 'btn btn-lg btn-full btn-social google-btn-face');
      face.setAttribute('aria-hidden', 'true');
      face.append(googleG(), el('span', undefined, 'Continue with Google'));
      gWrap.append(gis, face);
      social.append(gWrap);
      step.append(divider, social);

      renderGoogleButton(gis, deps.googleClientId, async (idToken) => {
        clearErrs();
        face.querySelector('span:last-child').textContent = 'Connecting…';
        try {
          await deps.onGoogle(idToken);
          await deps.onAuthed();
        } catch (ex) {
          err.textContent = (ex && ex.message) || 'Google sign-in failed';
          err.style.display = '';
          face.querySelector('span:last-child').textContent = 'Continue with Google';
        }
      }, (ex) => {
        err.textContent = (ex && ex.message) || 'Google sign-in failed';
        err.style.display = '';
      }).catch((ex) => {
        // GIS failed to load/init — drop the Google affordance, keep magic-link working.
        divider.remove();
        social.remove();
        console.warn('[web-login] Google sign-in disabled:', ex && ex.message);
      });
    }
  };

  // The "check your email" state — the emailed link completes the sign-in on return.
  const renderSent = (email, devUrl) => {
    step.innerHTML = '';
    step.append(el('h1', 'auth-shell-title', 'Check your email'));
    const lede = el('p', 'auth-shell-lede');
    lede.append(
      doc.createTextNode('We sent a sign-in link to '),
      el('strong', undefined, email),
      doc.createTextNode('. Open it on this device to continue.'),
    );
    step.append(lede);
    if (devUrl) {
      const actions = el('div', 'auth-shell-actions');
      const a = el('a', 'btn btn-primary btn-lg btn-full', 'Open sign-in link (dev)');
      a.href = devUrl;
      actions.append(a);
      step.append(actions);
    }
    const meta = el('p', 'auth-shell-meta');
    meta.append(doc.createTextNode('Wrong address? '));
    const again = el('a', undefined, 'Use a different email');
    again.href = '#';
    again.addEventListener('click', (e) => { e.preventDefault(); render(); });
    meta.append(again);
    step.append(meta);
  };

  render();
}
