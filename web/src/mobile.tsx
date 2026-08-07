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
import { useState, useEffect, useRef } from 'react';
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
function ChatsView({ title, onMenu, onOpen, onNewChat }: {
  title: string;
  onMenu: () => void;
  onOpen: (s: Recent) => void;
  onNewChat: () => void;
}) {
  return (
    <div className="m-chats">
      {/* Blur zone (top): the list scrolls fuzzily up under the header. */}
      <div className="m-chats-fade m-chats-fade-top" />
      <header className="m-chats-head">
        <button className="m-chats-icon" aria-label="Open menu" onClick={onMenu}><Icon name="menu" /></button>
        <span className="m-chats-title">{title}</span>
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
      {/* Blur zone: the list scrolls fuzzily under the New chat + search. */}
      <div className="m-chats-fade" />
      <button className="m-fab btn btn-primary btn-lg" onClick={onNewChat}><Icon name="plus" /><span>New chat</span></button>
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

/* ── Splash backdrop: the desktop app's #splash-flow canvas, ported VERBATIM
   from index.template.html (HeroFlow — flowing data streams, "fan" mode, the
   home purples). Runs over a solid var(--bg) ground while the splash holds,
   and tears itself down when the splash unmounts. ───────────────────────── */
function SplashFlow() {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const COLORS = ['179, 107, 251', '140, 59, 242', '236, 72, 153'];
    const PULSE = '255, 236, 180';
    const N = 28;
    let seed = 1337;
    function rand() {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    const streams: any[] = [];
    for (let i = 0; i < N; i++) {
      const st: any = {
        y0: 0.5 + (rand() - 0.5) * 0.14,
        endX: 0.42 + rand() * 0.56,
        y1: 0.5 + (rand() - 0.5) * 0.95,
        alpha: 0.12 + rand() * 0.24,
        tint: rand() < 0.72 ? 0 : rand() < 0.6 ? 1 : 2,
        dashSpeed: 0.02 + rand() * 0.05,
        dashPhase: rand() * 40,
        pulse: rand() < 0.5,
        pSpeed: 0.0001 + rand() * 0.00014,
        pPhase: rand(),
        scatter: [] as any[],
      };
      const n = 4 + Math.floor(rand() * 7);
      for (let j = 0; j < n; j++) {
        st.scatter.push({
          dx: rand() * 46, dy: (rand() - 0.5) * 26,
          s: 1 + rand() * 2, a: 0.3 + rand() * 0.6,
          tw: rand() * Math.PI * 2, tr: 0.5 + rand() * 1.5,
          tint: rand() < 0.5 ? 0 : rand() < 0.5 ? 2 : 3,
        });
      }
      streams.push(st);
    }
    let w = 0, h = 0;
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth; h = window.innerHeight;
      canvas!.width = Math.round(w * dpr);
      canvas!.height = Math.round(h * dpr);
      canvas!.style.width = w + 'px';
      canvas!.style.height = h + 'px';
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);
    function ctrl(S: any) {
      return [
        [0, S.y0 * h],
        [S.endX * 0.42 * w, S.y0 * h],
        [S.endX * 0.72 * w, S.y1 * h],
        [S.endX * w, S.y1 * h],
      ];
    }
    function pointAt(P: any, t: number) {
      const u = 1 - t;
      return [
        u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0],
        u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1],
      ];
    }
    let running = true;
    let raf = 0;
    function frame(now: number) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      ctx!.clearRect(0, 0, w, h);
      ctx!.lineWidth = 1;
      ctx!.lineCap = 'round';
      for (let i = 0; i < streams.length; i++) {
        const S = streams[i], P = ctrl(S);
        ctx!.setLineDash([2, 5]);
        ctx!.lineDashOffset = reduced ? 0 : -(now * S.dashSpeed) - S.dashPhase;
        ctx!.strokeStyle = 'rgba(' + COLORS[S.tint] + ', ' + S.alpha + ')';
        ctx!.beginPath();
        ctx!.moveTo(P[0][0], P[0][1]);
        ctx!.bezierCurveTo(P[1][0], P[1][1], P[2][0], P[2][1], P[3][0], P[3][1]);
        ctx!.stroke();
      }
      ctx!.setLineDash([]);
      ctx!.globalCompositeOperation = 'lighter';
      for (let i2 = 0; i2 < streams.length; i2++) {
        const S2 = streams[i2], P2 = ctrl(S2);
        const ex = P2[3][0], ey = P2[3][1];
        for (let k = 0; k < S2.scatter.length; k++) {
          const d = S2.scatter[k];
          const tw = reduced ? 0.8 : 0.45 + 0.55 * Math.sin(now * 0.0018 * d.tr + d.tw);
          const col = d.tint === 3 ? '255, 255, 255' : COLORS[d.tint];
          ctx!.fillStyle = 'rgba(' + col + ', ' + d.a * tw + ')';
          ctx!.beginPath();
          ctx!.arc(ex + d.dx, ey + d.dy, d.s / 2, 0, Math.PI * 2);
          ctx!.fill();
        }
        if (S2.pulse && !reduced) {
          const t = (now * S2.pSpeed + S2.pPhase) % 1;
          const pt = pointAt(P2, t);
          const g = Math.sin(t * Math.PI);
          ctx!.fillStyle = 'rgba(' + PULSE + ', ' + 0.9 * g + ')';
          ctx!.shadowColor = 'rgba(' + COLORS[S2.tint] + ', 0.9)';
          ctx!.shadowBlur = 10;
          ctx!.beginPath();
          ctx!.arc(pt[0], pt[1], 1.7, 0, Math.PI * 2);
          ctx!.fill();
          ctx!.shadowBlur = 0;
        }
      }
      ctx!.globalCompositeOperation = 'source-over';
      if (document.documentElement.getAttribute('data-theme') !== 'light') {
        const vg = ctx!.createRadialGradient(w / 2, h * 0.46, 0, w / 2, h * 0.46, h * 0.62);
        vg.addColorStop(0, 'rgba(8, 6, 12, 0.6)');
        vg.addColorStop(0.55, 'rgba(8, 6, 12, 0.12)');
        vg.addColorStop(1, 'rgba(8, 6, 12, 0)');
        ctx!.fillStyle = vg;
        ctx!.fillRect(0, 0, w, h);
      }
      if (reduced) running = false;
    }
    raf = requestAnimationFrame(frame);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);
  return <canvas ref={ref} className="m-splash-flow" aria-hidden="true" />;
}

function App() {
  const [active, setActive] = useState<SpaceId>('chat');
  const [drawer, setDrawer] = useState(false);
  const [screen, setScreen] = useState<'home' | 'list' | 'session'>('home');
  const [session, setSession] = useState<Recent | null>(null);
  const [splash, setSplash] = useState(true);

  // Splash on load → then the new-chat screen.
  useEffect(() => {
    const t = setTimeout(() => setSplash(false), 2200);
    return () => clearTimeout(t);
  }, []);

  const toggleDrawer = () => { haptic(); setDrawer((d) => !d); };
  const selectSpace = (id: SpaceId) => { haptic(); setActive(id); setScreen('list'); setSession(null); setDrawer(false); };
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
      {splash && (
        <div className="m-splash">
          <SplashFlow />
          <img className="m-splash-logo m-splash-logo-black" src="/brand/glyphh-logo-black.png" alt="Glyphh" />
          <img className="m-splash-logo m-splash-logo-white" src="/brand/glyphh-logo-white.png" alt="" />
        </div>
      )}
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
                  <ChatsView title={NAV.find((n) => n.id === active)?.label ?? 'Chats'} onMenu={toggleDrawer} onOpen={openSession} onNewChat={newChat} />
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
