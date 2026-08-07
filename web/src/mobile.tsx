// mobile.tsx — Glyphh mobile web app (phone-first, works on tablet).
//
// A from-scratch React surface with its own ui/ux, sharing only the backend
// (the @glyphh SDK + auth) with desktop/web. Styling lives in mobile.css and is
// TOKENISED — every color is a var(--…); the theme owns the accent, and login is
// the one surface a theme never overrides. No brand hexes in here.
//
// Served at /m by web/serve.mjs; bundled by `npm run build:web-mobile`.

import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';

/** The left rail — brand at the top-left, navigation to follow. Persistent on
 *  tablet; on phone it rides in as a drawer (see mobile.css). */
function Rail() {
  return (
    <aside className="m-rail">
      <div className="m-rail-brand">
        <img className="m-wordmark" src="/brand/glyphh-logo-text.png" alt="Glyphh" />
      </div>
    </aside>
  );
}

/** Hamburger (phone only — the top bar is hidden ≥768px). */
function MenuIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function App() {
  const [drawer, setDrawer] = useState(false);

  // Register the PWA service worker (installability + offline shell). Harmless
  // if unsupported; network-first so it never serves stale during dev.
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    }
  }, []);

  return (
    <div className="m-app" data-drawer={drawer ? 'open' : 'closed'}>
      {/* Scrim closes the drawer on phone; hidden on tablet. */}
      <div className="m-scrim" onClick={() => setDrawer(false)} />
      <Rail />
      <main className="m-main">
        <div className="m-topbar">
          <button className="m-menu-btn" aria-label="Open menu" onClick={() => setDrawer(true)}>
            <MenuIcon />
          </button>
        </div>
      </main>
    </div>
  );
}

const el = document.getElementById('glyphh-mobile-root');
if (el) createRoot(el).render(<App />);
