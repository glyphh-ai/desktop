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
import { NAV, RECENTS, ALL_SESSIONS, MESSAGES, GHOST_QUOTES, USER, DESKTOPS, CODE_SESSIONS, WORK_GROUPS,
  SETTINGS_GROUPS, MODELS, MORE_MODELS, ALL_MODELS, LOOPS, PERMISSIONS,
  type SpaceId, type Recent, type CodeSession, type Task } from './mock';

// Injected at build time from package.json (esbuild --define). Guarded so a
// bundle built without the define still renders.
declare const __GLYPHH_VERSION__: string;
const APP_VERSION = typeof __GLYPHH_VERSION__ !== 'undefined' ? __GLYPHH_VERSION__ : '';

// The real Glyphh legal pages that exist on the site (see web/app/*).
const LEGAL = {
  terms: 'https://glyphh.ai/terms',
  privacy: 'https://glyphh.ai/privacy',
  refund: 'https://glyphh.ai/refund',
  help: 'https://glyphh.ai',
};

type IconName = SpaceId | 'menu' | 'plus' | 'chevron' | 'filter' | 'search' | 'back' | 'dots' | 'send' | 'mic'
  | 'laptop' | 'monitor' | 'monitor-off' | 'cloud' | 'branch' | 'caret'
  | 'circle' | 'progress' | 'check'
  | 'close' | 'info' | 'user' | 'dollar' | 'chart' | 'bell' | 'shield' | 'link'
  | 'sliders' | 'grid' | 'perms' | 'voice'
  | 'camera' | 'image' | 'filedoc' | 'tick' | 'external';

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
  laptop: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M2 20h20" /></>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><line x1="8" y1="20" x2="16" y2="20" /></>,
  'monitor-off': <><rect x="3" y="4" width="18" height="12" rx="2" /><line x1="8" y1="20" x2="16" y2="20" /><line x1="3.5" y1="3" x2="20.5" y2="20" /></>,
  cloud: <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />,
  branch: <><line x1="6" y1="4" x2="6" y2="15" /><circle cx="18" cy="7" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 10a9 9 0 0 1-9 9" /></>,
  caret: <path d="M6 9l6 6 6-6" />,
  circle: <circle cx="12" cy="12" r="8" />,
  progress: <path d="M12 4a8 8 0 1 0 7.5 5.3" />,
  check: <><circle cx="12" cy="12" r="8" /><path d="M8.5 12l2.5 2.5 4.5-5" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.6h.01" /></>,
  user: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="2.8" /><path d="M6.5 18.2a5.6 5.6 0 0 1 11 0" /></>,
  dollar: <><circle cx="12" cy="12" r="9" /><path d="M12 7v10M14.2 9.3c-.5-.9-1.3-1.3-2.2-1.3-1.3 0-2.2.7-2.2 1.8 0 1 .8 1.5 2.2 1.8 1.4.3 2.3.8 2.3 1.9 0 1.1-1 1.8-2.3 1.8-1 0-1.8-.4-2.3-1.3" /></>,
  chart: <><path d="M4 4v16h16" /><path d="M7.5 14l3-4 3 3 4-6" /></>,
  bell: <><path d="M18 8.5a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5" /><path d="M10.4 20a1.7 1.7 0 0 0 3.2 0" /></>,
  shield: <><path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" /><rect x="9.5" y="11.5" width="5" height="4" rx="1" /><path d="M10.5 11.5v-1.2a1.5 1.5 0 0 1 3 0v1.2" /></>,
  link: <><path d="M10.5 13.5a4 4 0 0 0 5.7 0l2-2a4 4 0 1 0-5.7-5.7l-1.2 1.2" /><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2 2a4 4 0 1 0 5.7 5.7l1.2-1.2" /></>,
  sliders: <><line x1="4" y1="8" x2="20" y2="8" /><line x1="4" y1="16" x2="20" y2="16" /><circle cx="9" cy="8" r="2.3" /><circle cx="15" cy="16" r="2.3" /></>,
  grid: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" /></>,
  perms: <><rect x="3" y="4.5" width="18" height="6.5" rx="3.25" /><rect x="3" y="13" width="18" height="6.5" rx="3.25" /><circle cx="7.8" cy="7.75" r="1.4" /><circle cx="16.2" cy="16.25" r="1.4" /></>,
  voice: <><line x1="4" y1="10" x2="4" y2="14" /><line x1="8" y1="7" x2="8" y2="17" /><line x1="12" y1="4" x2="12" y2="20" /><line x1="16" y1="7" x2="16" y2="17" /><line x1="20" y1="10" x2="20" y2="14" /></>,
  camera: <><path d="M3 8a2 2 0 0 1 2-2h1.5l1.2-1.8a1 1 0 0 1 .84-.45h3.92a1 1 0 0 1 .84.45L15.5 6H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><circle cx="12" cy="12.5" r="3.4" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.7" /><path d="M4 16.5l4.5-3.5 3.5 2.5 3-2.5 4 3.5" /></>,
  filedoc: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M8.5 13.5c1-.9 2 .9 3.5 0M8.5 16.5c1-.9 2 .9 3.5 0" /></>,
  tick: <path d="M20 6L9 17l-5-5" />,
  external: <><rect x="4" y="4" width="16" height="16" rx="3.5" /><path d="M10 14l5-5" /><path d="M11 9h4v4" /></>,
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
function Composer({ onPlus, onSelector, permLabel }: {
  onPlus: () => void;
  onSelector: () => void;
  permLabel: string;
}) {
  return (
    <div className="m-composer">
      <div className="m-composer-box">
        <div className="m-composer-input"><span className="m-composer-ph">Message Glyphh…</span></div>
        <div className="m-composer-tools">
          <button className="m-tool-btn" aria-label="Add" onClick={onPlus}><Icon name="plus" /></button>
          <button className="m-tool-pill" onClick={onSelector}><Icon name="code" /><span>{permLabel}</span></button>
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

/* ── Code: attached Desktops strip + a Sessions list that distinguishes a
   session's runtime — running on a connected desktop, on a now-unreachable
   desktop, or in the cloud. ──────────────────────────────────────────────── */
function CodeRowMeta({ s }: { s: CodeSession }) {
  if (s.where === 'cloud') {
    return (
      <span className="m-code-meta" data-where="cloud">
        <Icon name="cloud" /><span className="m-code-loc">{s.location}</span>
      </span>
    );
  }
  const connected = s.where === 'connected';
  return (
    <span className="m-code-meta" data-where={s.where}>
      <Icon name={connected ? 'monitor' : 'monitor-off'} />
      <span className="m-code-state">{connected ? 'Connected' : 'Disconnected'}</span>
      <span className="m-code-dot">·</span>
      <span className="m-code-loc">{s.location}</span>
    </span>
  );
}

function CodeView({ onMenu, onOpen, onNewSession }: {
  onMenu: () => void;
  onOpen: (s: Recent) => void;
  onNewSession: () => void;
}) {
  return (
    <div className="m-code">
      {/* Header + footer are the EXACT chats classes — identical transparency,
          size, and the search input. Only the middle content differs. */}
      <div className="m-chats-fade m-chats-fade-top" />
      <header className="m-chats-head">
        <button className="m-chats-icon" aria-label="Open menu" onClick={onMenu}><Icon name="menu" /></button>
        <span className="m-chats-title">Code</span>
        <button className="m-chats-icon" aria-label="Filter"><Icon name="filter" /></button>
      </header>
      <div className="m-code-scroll">
        <div className="m-code-label">Desktops</div>
        <div className="m-desktops">
          {DESKTOPS.map((d) => (
            <div key={d.id} className="m-desktop" data-status={d.status}>
              <span className="m-desktop-icon"><Icon name="laptop" /><i className="m-desktop-badge" /></span>
              <span className="m-desktop-name">{d.name}</span>
              <span className="m-desktop-status">{d.status === 'connected' ? 'Connected' : 'Offline'}</span>
            </div>
          ))}
        </div>

        <div className="m-code-sessions-head">
          <span className="m-code-label">Sessions</span>
          <button className="m-code-filter">All <Icon name="caret" /></button>
        </div>
        <div className="m-code-list">
          {CODE_SESSIONS.map((s) => (
            <button key={s.id} className="m-code-card" onClick={() => onOpen({ id: s.id, title: s.title, when: s.when })}>
              <span className="m-code-thumb" data-kind={s.kind ?? 'plain'}>
                {s.kind === 'branch' ? <Icon name="branch" /> : null}
              </span>
              <span className="m-code-body">
                <span className="m-code-top">
                  <span className="m-code-name">{s.title}</span>
                  <span className="m-code-when">{s.when}</span>
                </span>
                <CodeRowMeta s={s} />
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="m-chats-fade" />
      <button className="m-fab btn btn-primary btn-lg" onClick={onNewSession}><Icon name="plus" /><span>New session</span></button>
      <div className="m-search"><Icon name="search" /><span>Search</span></div>
    </div>
  );
}

/* ── Work: tasks grouped by time bucket, each a card with a status
   glyph, title, timestamp and an optional note. ─────────────────────────── */
function WorkView({ onMenu, onOpen, onNewTask }: {
  onMenu: () => void;
  onOpen: (s: Recent) => void;
  onNewTask: () => void;
}) {
  const glyph = (s: Task['state']) => (s === 'doing' ? 'progress' : s === 'done' ? 'check' : 'circle');
  return (
    <div className="m-work">
      {/* Header + footer are the EXACT chats classes (same transparency/size +
          search input). */}
      <div className="m-chats-fade m-chats-fade-top" />
      <header className="m-chats-head">
        <button className="m-chats-icon" aria-label="Open menu" onClick={onMenu}><Icon name="menu" /></button>
        <span className="m-chats-title">Work</span>
        <button className="m-chats-icon" aria-label="Filter"><Icon name="filter" /></button>
      </header>
      <div className="m-work-scroll">
        {WORK_GROUPS.map((g) => (
          <div key={g.label} className="m-work-section">
            <div className="m-work-label">{g.label}</div>
            <div className="m-work-group">
              {g.tasks.map((t) => (
                <button key={t.id} className="m-task" onClick={() => onOpen({ id: t.id, title: t.title, when: t.when })}>
                  <span className="m-task-check" data-state={t.state}><Icon name={glyph(t.state)} /></span>
                  <span className="m-task-body">
                    <span className="m-task-top">
                      <span className="m-task-title">{t.title}</span>
                      <span className="m-task-when">{t.when}</span>
                    </span>
                    {t.note && <span className="m-task-note">{t.note}</span>}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="m-chats-fade" />
      <button className="m-fab btn btn-primary btn-lg" onClick={onNewTask}><Icon name="plus" /><span>New task</span></button>
      <div className="m-search"><Icon name="search" /><span>Search</span></div>
    </div>
  );
}

/* ── Session: the standard Glyphh agent view (transparent blurred header,
   messages, composer pinned at the bottom). ─────────────────────────────── */
interface CompProps { onPlus: () => void; onSelector: () => void; permLabel: string; }

function SessionView({ session, onBack, comp }: { session: Recent; onBack: () => void; comp: CompProps }) {
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
      <Composer {...comp} />
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

/* ── Settings: a bottom sheet that slides up over the app and back down on
   close. Rows slide into their sub-screen on a horizontal track (Profile is
   wired); the < back slides that tray back to the main list. ─────────────── */
function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [profile, setProfile] = useState(false);
  const [info, setInfo] = useState(false);
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => { setProfile(false); setInfo(false); }, 260);
    return () => clearTimeout(t);
  }, [open]);

  const legalRow = (href: string, label: string) => (
    <a className="m-info-row" href={href} target="_blank" rel="noopener noreferrer" onClick={() => setInfo(false)}>
      <Icon name="external" /><span>{label}</span>
    </a>
  );

  return (
    <div className="m-sheet-overlay" data-open={open ? 'true' : 'false'}>
      <div className="m-sheet-scrim" onClick={onClose} />
      <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="m-sheet-track" data-open={profile ? 'true' : 'false'}>
          {/* Panel A — the settings list. */}
          <section className="m-sheet-panel">
            <header className="m-sheet-head">
              <button className="m-sheet-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
              <span className="m-sheet-title">Settings</span>
              <button className="m-sheet-btn m-sheet-info" aria-label="About" onClick={() => { haptic(); setInfo((v) => !v); }}><Icon name="info" /></button>
            </header>
            <div className="m-sheet-scroll">
              <div className="m-set-email">{USER.email}</div>
              {SETTINGS_GROUPS.map((g) => (
                <div key={g.label} className="m-set-section">
                  <div className="m-set-label">{g.label}</div>
                  <div className="m-set-group">
                    {g.rows.map((r) => (
                      <button key={r.label} className="m-set-row" onClick={r.label === 'Profile' ? () => { haptic(); setProfile(true); } : undefined}>
                        <span className="m-set-ico"><Icon name={r.icon as IconName} /></span>
                        <span className="m-set-name">{r.label}</span>
                        {r.value && <span className="m-set-val">{r.value}</span>}
                        <Icon name="chevron" />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Panel B — Profile (slides in from the right; < slides back). */}
          <section className="m-sheet-panel">
            <header className="m-sheet-head">
              <button className="m-sheet-btn" aria-label="Back" onClick={() => { haptic(); setProfile(false); }}><Icon name="back" /></button>
              <span className="m-sheet-title">Profile</span>
              <span className="m-sheet-btn" aria-hidden="true" style={{ visibility: 'hidden' }} />
            </header>
            <div className="m-sheet-scroll">
              <div className="m-profile-top">
                <div className="m-profile-avatar">{USER.initials}</div>
                <div className="m-profile-name">{USER.name}</div>
                <div className="m-profile-email">{USER.email}</div>
              </div>
              <div className="m-set-label">Details</div>
              <div className="m-sel-group">
                <button className="m-sel-row"><span className="m-sel-row-label">Full name</span><span className="m-sel-row-val">{USER.name}</span><Icon name="chevron" /></button>
                <button className="m-sel-row"><span className="m-sel-row-label">Display name</span><span className="m-sel-row-val">Chris</span><Icon name="chevron" /></button>
                <button className="m-sel-row"><span className="m-sel-row-label">Email</span><span className="m-sel-row-val">{USER.email}</span><Icon name="chevron" /></button>
                <button className="m-sel-row"><span className="m-sel-row-label">Organization</span><span className="m-sel-row-val">Glyphh</span><Icon name="chevron" /></button>
              </div>
              <button className="m-profile-signout">Sign out</button>
            </div>
          </section>
        </div>

        {/* About / legal dropdown — attached under the info "i". Policies open
            the real glyphh.ai pages in a new tab. */}
        {info && (
          <>
            <div className="m-info-scrim" onClick={() => setInfo(false)} />
            <div className="m-info-menu" role="menu">
              <div className="m-info-ver">Glyphh{APP_VERSION ? ` v${APP_VERSION}` : ''}</div>
              <div className="m-info-sep" />
              {legalRow(LEGAL.terms, 'Terms of Service')}
              {legalRow(LEGAL.privacy, 'Privacy Policy')}
              {legalRow(LEGAL.refund, 'Refund Policy')}
              <div className="m-info-sep" />
              {legalRow(LEGAL.help, 'Help & Support')}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Attachment menu: a popover above the composer's + (camera / photo / file).
   Rendered at app root so it escapes the shell's transform. ──────────────── */
function AttachMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <div className="m-attach-overlay" data-open={open ? 'true' : 'false'}>
      <div className="m-attach-scrim" onClick={onClose} />
      <div className="m-attach-menu" role="menu">
        <button className="m-attach-row" onClick={onClose}><Icon name="camera" /><span>Take Photo</span></button>
        <button className="m-attach-row" onClick={onClose}><Icon name="image" /><span>Choose photo or video</span></button>
        <button className="m-attach-row" onClick={onClose}><Icon name="filedoc" /><span>Choose file</span></button>
      </div>
    </div>
  );
}

/* ── Composer selector: a bottom sheet with three sections — Loop / Models /
   Permission. Each row's chevron slides open that section's tray, which has a
   < back. (Models tray mirrors the Glyphh agent's model picker.) ─────────── */
function OptionList({ items, selected, onPick }: { items: { id: string; name: string; desc?: string }[]; selected: string; onPick: (id: string) => void }) {
  return (
    <div className="m-sel-group">
      {items.map((o) => (
        <button key={o.id} className="m-opt" onClick={() => onPick(o.id)}>
          <span className="m-opt-text">
            <span className="m-opt-name">{o.name}</span>
            {o.desc && <span className="m-opt-desc">{o.desc}</span>}
          </span>
          {selected === o.id && <span className="m-opt-tick"><Icon name="tick" /></span>}
        </button>
      ))}
    </div>
  );
}

function SelectorSheet({ open, onClose, model, setModel, loop, setLoop, perm, setPerm }: {
  open: boolean;
  onClose: () => void;
  model: string; setModel: (v: string) => void;
  loop: string; setLoop: (v: string) => void;
  perm: string; setPerm: (v: string) => void;
}) {
  // Depth-based track: 0 = the three sections, 1 = a section's tray, 2 = the
  // "More models" list under Models. `tray` persists during slide-backs.
  const [tray, setTray] = useState<'loop' | 'models' | 'permission'>('models');
  const [depth, setDepth] = useState(0);
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => setDepth(0), 260);
    return () => clearTimeout(t);
  }, [open]);

  const nameOf = (arr: { id: string; name: string }[], id: string) => arr.find((x) => x.id === id)?.name ?? '';
  const openTray = (t: 'loop' | 'models' | 'permission') => { haptic(); setTray(t); setDepth(1); };
  const trayTitle = tray === 'loop' ? 'Loop' : tray === 'models' ? 'Select model' : 'Permission';
  const pickModel = (id: string) => { haptic(); setModel(id); setDepth(0); };

  return (
    <div className="m-sel-overlay" data-open={open ? 'true' : 'false'}>
      <div className="m-sel-scrim" onClick={onClose} />
      <div className="m-sel" role="dialog" aria-modal="true">
        <div className="m-sel-grip" />
        <div className="m-sel-track" data-depth={depth}>
          {/* Panel 0 — the three sections. */}
          <section className="m-sel-panel">
            <div className="m-sel-head">
              <button className="m-sheet-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
              <span className="m-sel-title">Model &amp; runtime</span>
            </div>
            <div className="m-sel-body">
              <div className="m-sel-group">
                <button className="m-sel-row" onClick={() => openTray('loop')}>
                  <span className="m-sel-row-label">Loop</span>
                  <span className="m-sel-row-val">{nameOf(LOOPS, loop)}</span>
                  <Icon name="chevron" />
                </button>
                <button className="m-sel-row" onClick={() => openTray('models')}>
                  <span className="m-sel-row-label">Models</span>
                  <span className="m-sel-row-val">{nameOf(ALL_MODELS, model)}</span>
                  <Icon name="chevron" />
                </button>
                <button className="m-sel-row" onClick={() => openTray('permission')}>
                  <span className="m-sel-row-label">Permission</span>
                  <span className="m-sel-row-val">{nameOf(PERMISSIONS, perm)}</span>
                  <Icon name="chevron" />
                </button>
              </div>
            </div>
          </section>

          {/* Panel 1 — the active section's tray. */}
          <section className="m-sel-panel">
            <div className="m-sel-head">
              <button className="m-sheet-btn" aria-label="Back" onClick={() => { haptic(); setDepth(0); }}><Icon name="back" /></button>
              <span className="m-sel-title">{trayTitle}</span>
            </div>
            <div className="m-sel-body">
              {tray === 'loop' && (
                <OptionList items={LOOPS} selected={loop} onPick={(id) => { haptic(); setLoop(id); setDepth(0); }} />
              )}
              {tray === 'models' && (
                <>
                  <div className="m-sel-search"><Icon name="search" /><span>Search</span></div>
                  <OptionList items={MODELS} selected={model} onPick={pickModel} />
                  {/* Effort removed — the SDK turn API has no effort/reasoning param.
                      "More models" opens the rest of the resolved catalog (panel 2). */}
                  <div className="m-sel-group">
                    <button className="m-sel-row" onClick={() => { haptic(); setDepth(2); }}><span className="m-sel-row-label">More models</span><Icon name="chevron" /></button>
                  </div>
                </>
              )}
              {tray === 'permission' && (
                <OptionList items={PERMISSIONS} selected={perm} onPick={(id) => { haptic(); setPerm(id); setDepth(0); }} />
              )}
            </div>
          </section>

          {/* Panel 2 — More models (nested under Models; back returns to it). */}
          <section className="m-sel-panel">
            <div className="m-sel-head">
              <button className="m-sheet-btn" aria-label="Back" onClick={() => { haptic(); setDepth(1); }}><Icon name="back" /></button>
              <span className="m-sel-title">More models</span>
            </div>
            <div className="m-sel-body">
              <div className="m-sel-search"><Icon name="search" /><span>Search all models</span></div>
              <OptionList items={MORE_MODELS} selected={model} onPick={pickModel} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [active, setActive] = useState<SpaceId>('chat');
  const [drawer, setDrawer] = useState(false);
  const [screen, setScreen] = useState<'home' | 'list' | 'session'>('home');
  const [session, setSession] = useState<Recent | null>(null);
  const [splash, setSplash] = useState(true);
  const [settings, setSettings] = useState(false);
  const [attach, setAttach] = useState(false);
  const [selector, setSelector] = useState(false);
  const [model, setModel] = useState('sonnet-5');
  const [loop, setLoop] = useState('default');
  const [perm, setPerm] = useState('accept-edits');
  const comp: CompProps = {
    onPlus: () => { haptic(); setAttach(true); },
    onSelector: () => { haptic(); setSelector(true); },
    permLabel: PERMISSIONS.find((p) => p.id === perm)?.name ?? 'Accept edits',
  };

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
  const account = () => { haptic(); setSettings(true); };  /* leave the rail open behind the sheet */
  const newChat = () => { haptic(); setActive('chat'); setScreen('home'); setSession(null); setDrawer(false); };
  const newSession = () => { haptic(); setScreen('home'); setSession(null); setDrawer(false); };

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
              <Composer {...comp} />
            </div>
          )}
          {(screen === 'list' || screen === 'session') && (
            <div className="m-nav" data-screen={screen}>
              <div className="m-nav-track">
                <section className="m-nav-panel">
                  {active === 'code'
                    ? <CodeView onMenu={toggleDrawer} onOpen={openSession} onNewSession={newSession} />
                    : active === 'work'
                    ? <WorkView onMenu={toggleDrawer} onOpen={openSession} onNewTask={newSession} />
                    : <ChatsView title={NAV.find((n) => n.id === active)?.label ?? 'Chats'} onMenu={toggleDrawer} onOpen={openSession} onNewChat={newChat} />}
                </section>
                <section className="m-nav-panel">
                  {session && <SessionView session={session} onBack={backToList} comp={comp} />}
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
      <SettingsSheet open={settings} onClose={() => { haptic(); setSettings(false); }} />
      <AttachMenu open={attach} onClose={() => { haptic(); setAttach(false); }} />
      <SelectorSheet
        open={selector}
        onClose={() => { haptic(); setSelector(false); }}
        model={model} setModel={setModel}
        loop={loop} setLoop={setLoop}
        perm={perm} setPerm={setPerm}
      />
    </div>
  );
}

const el = document.getElementById('glyphh-mobile-root');
if (el) createRoot(el).render(<App />);
