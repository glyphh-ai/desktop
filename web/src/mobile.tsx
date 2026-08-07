// mobile.tsx — Glyphh mobile web app (phone-first, works on tablet).
//
// A from-scratch React surface with its own ui/ux, sharing only the backend
// (the @glyphh SDK + auth) with desktop/web. Styling lives in mobile.css and is
// TOKENISED — every color is a var(--…); the theme owns the accent, and login is
// the one surface a theme never overrides. No brand hexes in here.
//
// MOCK PASS: data comes from ./mock; the SDK gets wired in later behind the same
// shapes. Served at /m by web/serve.mjs; bundled by `npm run build:web-mobile`.

import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { NAV, RECENTS, USER, type SpaceId } from './mock';

type IconName = SpaceId | 'menu' | 'plus';

/* ── Icons (stroke = currentColor, so they inherit the token color) ───────── */
const ICON: Record<IconName, React.ReactNode> = {
  chat: <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1 3.8-11.3 8.38 8.38 0 0 1 8.7 0A8.5 8.5 0 0 1 21 11.5z" />,
  work: <><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" /></>,
  code: <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />,
  files: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  desktop: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  menu: <><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON[name]}
    </svg>
  );
}

/* ── Left rail: brand → spaces → recents ──────────────────────────────────── */
function Rail({ active, onSelect, onOpenRecent, onAccount, onNewChat }: {
  active: SpaceId;
  onSelect: (id: SpaceId) => void;
  onOpenRecent: (id: string) => void;
  onAccount: () => void;
  onNewChat: () => void;
}) {
  return (
    <aside className="m-rail">
      <div className="m-rail-brand">
        <img className="m-wordmark" src="/brand/glyphh-logo-text.png" alt="Glyphh" />
      </div>

      <nav className="m-rail-nav">
        {NAV.map((n) => (
          <button
            key={n.id}
            className="m-nav-item"
            aria-current={active === n.id ? 'page' : undefined}
            onClick={() => onSelect(n.id)}
          >
            <Icon name={n.id} />
            <span>{n.label}</span>
          </button>
        ))}
      </nav>

      <div className="m-recents">
        <div className="m-recents-label">Recents</div>
        <div className="m-recents-list">
          {RECENTS.map((r) => (
            <button key={r.id} className="m-recent" onClick={() => onOpenRecent(r.id)}>
              <span className="m-recent-title">{r.title}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="m-rail-footer">
        <button className="m-avatar" aria-label={USER.name} title={USER.name} onClick={onAccount}>
          {USER.initials}
        </button>
        <button className="m-new-chat" onClick={onNewChat}>
          <Icon name="plus" />
          <span>New Chat</span>
        </button>
      </div>
    </aside>
  );
}

function App() {
  const [active, setActive] = useState<SpaceId>('chat');
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    }
  }, []);

  const selectSpace = (id: SpaceId) => { setActive(id); setDrawer(false); };
  const openRecent = (_id: string) => { setDrawer(false); /* main view lands here later */ };
  const account = () => { setDrawer(false); /* account view lands here later */ };
  const newChat = () => { setActive('chat'); setDrawer(false); /* new chat lands here later */ };

  const label = NAV.find((n) => n.id === active)?.label ?? '';

  return (
    <div className="m-app" data-drawer={drawer ? 'open' : 'closed'}>
      <div className="m-scrim" onClick={() => setDrawer(false)} />
      <Rail active={active} onSelect={selectSpace} onOpenRecent={openRecent} onAccount={account} onNewChat={newChat} />
      <main className="m-main">
        <div className="m-topbar">
          <button className="m-menu-btn" aria-label="Open menu" onClick={() => setDrawer(true)}>
            <Icon name="menu" />
          </button>
          <span className="m-topbar-title">{label}</span>
        </div>
        <div className="m-content">
          <span className="m-placeholder">{label}</span>
        </div>
      </main>
    </div>
  );
}

const el = document.getElementById('glyphh-mobile-root');
if (el) createRoot(el).render(<App />);
