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
import { useState, useEffect } from 'react';
import { NAV, RECENTS, ALL_SESSIONS, MESSAGES, GHOST_QUOTES, USER, type SpaceId, type Recent } from './mock';

type IconName = SpaceId | 'menu' | 'plus' | 'chevron' | 'filter' | 'search' | 'back' | 'dots' | 'send' | 'mic';

/* ── Icons (stroke = currentColor, so they inherit the token color) ───────── */
const ICON: Record<IconName, React.ReactNode> = {
  chat: <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1 3.8-11.3 8.38 8.38 0 0 1 8.7 0A8.5 8.5 0 0 1 21 11.5z" />,
  work: <><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" /></>,
  code: <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />,
  files: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  desktop: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  menu: <><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  filter: <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />,
  search: <><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></>,
  back: <path d="M15 6l-6 6 6 6" />,
  dots: <><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>,
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  mic: <><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" /></>,
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON[name]}
    </svg>
  );
}

/* A light physical tap. Android/others: Vibration API. iOS 17.4+: toggling a
   hidden <input switch> inside the user gesture emits a subtle system haptic.
   Best-effort — silently no-ops where unsupported. */
let hapticSwitch: HTMLInputElement | null = null;
function haptic() {
  try { (navigator as Navigator & { vibrate?: (n: number) => boolean }).vibrate?.(10); } catch { /* */ }
  try {
    if (!hapticSwitch) {
      const label = document.createElement('label');
      label.setAttribute('aria-hidden', 'true');
      label.style.cssText = 'position:fixed;top:-100px;left:-100px;width:0;height:0;opacity:0;pointer-events:none;';
      hapticSwitch = document.createElement('input');
      hapticSwitch.type = 'checkbox';
      hapticSwitch.setAttribute('switch', '');
      label.appendChild(hapticSwitch);
      document.body.appendChild(label);
    }
    hapticSwitch.click();
  } catch { /* */ }
}

/* ── Left rail: brand → spaces → recents ──────────────────────────────────── */
function Rail({ active, onSelect, onOpenRecent, onAllChats, onAccount, onNewChat }: {
  active: SpaceId;
  onSelect: (id: SpaceId) => void;
  onOpenRecent: (id: string) => void;
  onAllChats: () => void;
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
          <button className="m-all-chats" onClick={onAllChats}>
            <span>All Chats</span>
            <Icon name="chevron" />
          </button>
        </div>
      </div>

      <div className="m-rail-footer">
        <button className="m-avatar" aria-label={USER.name} title={USER.name} onClick={onAccount}>
          {USER.initials}
        </button>
        <button className="btn btn-primary btn-lg" onClick={onNewChat}>
          <Icon name="plus" />
          <span>New Chat</span>
        </button>
      </div>
    </aside>
  );
}

/* ── The Glyphh composer (input + toolbar) — shared by new-chat & sessions. */
function Composer() {
  return (
    <div className="m-composer">
      <div className="m-composer-box">
        <div className="m-composer-input"><span className="m-composer-ph">Message Glyphh…</span></div>
        <div className="m-composer-tools">
          <button className="m-tool-btn" aria-label="Add"><Icon name="plus" /></button>
          <button className="m-tool-pill"><Icon name="code" /><span>Accept edits</span></button>
          <span className="m-composer-spacer" />
          <button className="m-tool-mic" aria-label="Voice"><Icon name="mic" /></button>
          <button className="m-composer-send" aria-label="Send"><Icon name="send" /></button>
        </div>
      </div>
    </div>
  );
}

/* ── Agent new-session empty state — the mark + a rotating quote. Matches the
   app's generic agent ghost (help/code.ts .code-ghost / GHOST_QUOTES). ────── */
function Ghost() {
  const [idx, setIdx] = useState(0);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    const iv = setInterval(() => {
      setFading(true);
      setTimeout(() => { setIdx((i) => (i + 1) % GHOST_QUOTES.length); setFading(false); }, 500);
    }, 7000);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="m-ghost">
      <img className="m-ghost-mark" src="/brand/glyphh-mark.png" alt="" />
      <div className="m-ghost-quote" style={fading ? { opacity: 0 } : undefined}>{GHOST_QUOTES[idx]}</div>
    </div>
  );
}

/* ── Chats list (slides in from the rail's "All Chats") ───────────────────── */
function ChatsView({ onMenu, onOpen, onNewChat }: {
  onMenu: () => void;
  onOpen: (s: Recent) => void;
  onNewChat: () => void;
}) {
  return (
    <div className="m-chats">
      <header className="m-chats-head">
        <button className="m-chats-icon" aria-label="Open menu" onClick={onMenu}><Icon name="menu" /></button>
        <span className="m-chats-title">Chats</span>
        <button className="m-chats-icon" aria-label="Filter"><Icon name="filter" /></button>
      </header>
      <div className="m-chats-list">
        {ALL_SESSIONS.map((s) => (
          <button key={s.id} className="m-chat-row" onClick={() => onOpen(s)}>
            <span className="m-chat-text">
              <span className="m-chat-title">{s.title}</span>
              <span className="m-chat-when">{s.when}</span>
            </span>
            <Icon name="chevron" />
          </button>
        ))}
      </div>
      <button className="m-fab btn btn-primary" onClick={onNewChat}><Icon name="plus" /><span>New chat</span></button>
      <div className="m-search"><Icon name="search" /><span>Search</span></div>
    </div>
  );
}

/* ── Session: the standard Glyphh agent view (transparent blurred header,
   messages, composer pinned at the bottom). ─────────────────────────────── */
function SessionView({ session, onBack }: { session: Recent; onBack: () => void }) {
  return (
    <div className="m-sv">
      <header className="m-sv-head">
        <button className="m-chats-icon" aria-label="Back" onClick={onBack}><Icon name="back" /></button>
        <span className="m-sv-name">{session.title}</span>
        <button className="m-chats-icon" aria-label="Options"><Icon name="dots" /></button>
      </header>
      <div className="m-sv-messages">
        {MESSAGES.map((m) => (
          <div key={m.id} className={`m-msg m-msg-${m.role}`}>{m.text}</div>
        ))}
      </div>
      <Composer />
    </div>
  );
}

function App() {
  const [active, setActive] = useState<SpaceId>('chat');
  const [drawer, setDrawer] = useState(false);
  const [screen, setScreen] = useState<'home' | 'list' | 'session'>('home');
  const [session, setSession] = useState<Recent | null>(null);

  const toggleDrawer = () => { haptic(); setDrawer((d) => !d); };
  const selectSpace = (id: SpaceId) => { haptic(); setActive(id); setScreen('home'); setSession(null); setDrawer(false); };
  const openSession = (s: Recent) => { haptic(); setSession(s); setScreen('session'); setDrawer(false); };
  const openRecent = (id: string) => {
    const s = ALL_SESSIONS.find((x) => x.id === id) || RECENTS.find((x) => x.id === id);
    if (s) openSession(s);
  };
  const allChats = () => { haptic(); setScreen('list'); setDrawer(false); };
  const backToList = () => { haptic(); setScreen('list'); };
  const account = () => { setDrawer(false); /* account view lands here later */ };
  const newChat = () => { haptic(); setActive('chat'); setScreen('home'); setSession(null); setDrawer(false); };

  return (
    <div className="m-app" data-drawer={drawer ? 'open' : 'closed'}>
      <div className="m-shell">
        <Rail active={active} onSelect={selectSpace} onOpenRecent={openRecent} onAllChats={allChats} onAccount={account} onNewChat={newChat} />
        <main className="m-main">
          {screen === 'home' && (
            <div className="m-home">
              <Ghost />
              <Composer />
            </div>
          )}
          {(screen === 'list' || screen === 'session') && (
            <div className="m-nav" data-screen={screen}>
              <div className="m-nav-track">
                <section className="m-nav-panel">
                  <ChatsView onMenu={toggleDrawer} onOpen={openSession} onNewChat={newChat} />
                </section>
                <section className="m-nav-panel">
                  {session && <SessionView session={session} onBack={backToList} />}
                </section>
              </div>
            </div>
          )}
          {/* Blurs the pushed-out content while the drawer is open; tap to close. */}
          <div className="m-scrim" onClick={() => setDrawer(false)} />
          {/* Hamburger sits ABOVE the blur scrim (rendered after it). Slides with
              the rail. Toggles the drawer. */}
          {screen === 'home' && (
            <button className="m-hamburger" aria-label="Menu" onClick={toggleDrawer}>
              <Icon name="menu" />
            </button>
          )}
        </main>
      </div>
    </div>
  );
}

const el = document.getElementById('glyphh-mobile-root');
if (el) createRoot(el).render(<App />);
