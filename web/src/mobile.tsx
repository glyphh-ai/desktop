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
import { NAV, RECENTS, ALL_SESSIONS, MESSAGES, GHOST_QUOTES, DESKTOPS, CODE_SESSIONS, WORK_GROUPS,
  SETTINGS_GROUPS, MODELS, MODEL_TOP_N, LOOP_ROLES, DEFAULT_ROLE, LOOPS, PERMISSIONS,
  type SpaceId, type Recent, type CodeSession, type Task } from './mock';
// Real auth + client — the same SDK wiring app-web uses (localStorage token store,
// gating cookies, refresh, signed-out event). We reuse it; we don't fork the client.
import {
  glyphh, syncGating, isAuthenticated, signInWithGoogle, startEmailLink,
  verifyEmailLink, exchangeCode, signOut as sdkSignOut, cachedUser,
} from './glyphh-web.js';

/** Micro-credits (1 credit = 1e6) → a rounded whole-credit string. */
function credits(v: number | null | undefined): string {
  return v == null ? '—' : Math.round(v / 1e6).toLocaleString();
}

/** Persist + apply the theme live (same contract as mobile.html's pre-paint). */
function applyTheme(t: string) {
  try { localStorage.setItem('yoTheme', t); } catch { /* */ }
  const resolved = t === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : t;
  document.documentElement.setAttribute('data-theme', resolved);
}
function currentTheme(): string { try { return localStorage.getItem('yoTheme') || 'dark'; } catch { return 'dark'; } }

/* ── Current user (derived from the SDK identity / cached legacy user) ─────── */
interface DisplayUser { name: string; email: string; initials: string; avatarUrl: string | null; role: string; tier: string; }
function toDisplayUser(u: { name?: string | null; email?: string | null; avatarUrl?: string | null; role?: string | null; tier?: string | null } | null): DisplayUser {
  const name = (u?.name || u?.email || 'You').trim();
  const email = u?.email || '';
  const parts = name.split(/\s+/).filter(Boolean);
  const initials = (parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : (name[0] || 'U')).toUpperCase();
  return { name, email, initials, avatarUrl: u?.avatarUrl || null, role: u?.role || '', tier: u?.tier || '' };
}
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const deviceTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } };
/** The IANA zone list when the runtime supports it (modern browsers); else null. */
let _zones: string[] | null | undefined;
function tzList(): string[] | null {
  if (_zones !== undefined) return _zones;
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    _zones = sv ? sv('timeZone') : null;
  } catch { _zones = null; }
  return _zones;
}

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
  | 'camera' | 'image' | 'filedoc' | 'tick' | 'external' | 'pin' | 'chats' | 'pencil' | 'trash'
  | 'swap' | 'loop';

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
  pin: <><path d="M12 17v5" /><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></>,
  chats: <><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" /><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" /></>,
  pencil: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  trash: <><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></>,
  swap: <><path d="M16 3l4 4-4 4" /><path d="M20 7H8a4 4 0 0 0-4 4" /><path d="M8 21l-4-4 4-4" /><path d="M4 17h12a4 4 0 0 0 4-4" /></>,
  loop: <><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>,
  contrast: <><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" /></>,
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

/* ── Loop role helpers (shared by the composer chip + the selector) ───────── */
function rolesForLoop(loopId: string) { return LOOP_ROLES[loopId] ?? [DEFAULT_ROLE]; }
function seedRoleModels(loopId: string): Record<string, string> {
  const rm: Record<string, string> = {};
  for (const r of rolesForLoop(loopId)) rm[r.id] = r.defaultModel;
  return rm;
}
function modelNameOf(id: string) { return MODELS.find((m) => m.id === id)?.name ?? ''; }
function loopNameOf(loopId: string) { return LOOPS.find((l) => l.id === loopId)?.name ?? ''; }
/** "Sonnet 5 +1" — the primary role's model, with a +N for extra role slots. */
function modelSummaryText(loopId: string, roleModels: Record<string, string>): string {
  const roles = rolesForLoop(loopId);
  const primary = modelNameOf(roleModels[roles[0]?.id] ?? '');
  return roles.length > 1 ? `${primary} +${roles.length - 1}` : primary;
}

/* ── Left rail: brand → spaces → recents ──────────────────────────────────── */
function Rail({ active, onSelect, onOpenRecent, onAllChats, onAccount, onNewChat, user }: {
  active: SpaceId;
  onSelect: (id: SpaceId) => void;
  onOpenRecent: (id: string) => void;
  onAllChats: () => void;
  onAccount: () => void;
  onNewChat: () => void;
  user: DisplayUser;
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
        <button className="m-avatar" aria-label={user.name} title={user.name} onClick={onAccount}>
          {user.initials}
        </button>
        <button className="btn btn-primary btn-lg" onClick={onNewChat}>
          <Icon name="plus" />
          <span>New Chat</span>
        </button>
      </div>
    </aside>
  );
}

/* ── The Glyphh composer (input + toolbar) — shared by new-chat & sessions.
   The chip is the permission-mode selector; model + loop live in the session
   dots menu. */
function Composer({ onPlus, onOpenSelector, permLabel }: {
  onPlus: () => void;
  onOpenSelector: (section: 'loop' | 'models' | 'permission') => void;
  permLabel: string;
}) {
  return (
    <div className="m-composer">
      <div className="m-composer-box">
        <div className="m-composer-input"><span className="m-composer-ph">Message Glyphh…</span></div>
        <div className="m-composer-tools">
          <button className="m-tool-btn" aria-label="Add" onClick={onPlus}><Icon name="plus" /></button>
          <button className="m-tool-pill m-pill-cfg" onClick={() => onOpenSelector('permission')}><Icon name="shield" /><span>{permLabel}</span></button>
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

/* ── Header filter: a dropdown under the funnel — "All <things>" (checked) vs
   "Pinned". Closes on outside tap. Used by Chats / Work / Code. ──────────── */
function FilterMenu({ allLabel, allIcon }: { allLabel: string; allIcon: IconName }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'pinned'>('all');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, [open]);
  const row = (id: 'all' | 'pinned', icon: IconName, label: string) => (
    <button className="m-filter-row" onClick={() => { haptic(); setFilter(id); setOpen(false); }}>
      <span className="m-filter-check">{filter === id && <Icon name="tick" />}</span>
      <Icon name={icon} /><span>{label}</span>
    </button>
  );
  return (
    <div className="m-filter" ref={ref}>
      <button className="m-chats-icon" aria-label="Filter" onClick={() => { haptic(); setOpen((v) => !v); }}><Icon name="filter" /></button>
      {open && (
        <div className="m-filter-menu" role="menu">
          {row('all', allIcon, allLabel)}
          {row('pinned', 'pin', 'Pinned')}
        </div>
      )}
    </div>
  );
}

/* ── Chats list (slides in from the rail's "All Chats") ───────────────────── */
function ChatsView({ title, onMenu, onOpen, onNewChat, onSearch }: {
  title: string;
  onMenu: () => void;
  onOpen: (s: Recent) => void;
  onNewChat: () => void;
  onSearch: () => void;
}) {
  return (
    <div className="m-chats">
      {/* Blur zone (top): the list scrolls fuzzily up under the header. */}
      <div className="m-chats-fade m-chats-fade-top" />
      <header className="m-chats-head">
        <button className="m-chats-icon" aria-label="Open menu" onClick={onMenu}><Icon name="menu" /></button>
        <span className="m-chats-title">{title}</span>
        <FilterMenu allLabel="All chats" allIcon="chats" />
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
      <button className="m-search" onClick={onSearch}><Icon name="search" /><span>Search</span></button>
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

function CodeView({ onMenu, onOpen, onNewSession, onSearch }: {
  onMenu: () => void;
  onOpen: (s: Recent) => void;
  onNewSession: () => void;
  onSearch: () => void;
}) {
  return (
    <div className="m-code">
      {/* Header + footer are the EXACT chats classes — identical transparency,
          size, and the search input. Only the middle content differs. */}
      <div className="m-chats-fade m-chats-fade-top" />
      <header className="m-chats-head">
        <button className="m-chats-icon" aria-label="Open menu" onClick={onMenu}><Icon name="menu" /></button>
        <span className="m-chats-title">Code</span>
        <FilterMenu allLabel="All sessions" allIcon="code" />
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
      <button className="m-search" onClick={onSearch}><Icon name="search" /><span>Search</span></button>
    </div>
  );
}

/* ── Work: tasks grouped by time bucket, each a card with a status
   glyph, title, timestamp and an optional note. ─────────────────────────── */
function WorkView({ onMenu, onOpen, onNewTask, onSearch }: {
  onMenu: () => void;
  onOpen: (s: Recent) => void;
  onNewTask: () => void;
  onSearch: () => void;
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
        <FilterMenu allLabel="All tasks" allIcon="work" />
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
      <button className="m-search" onClick={onSearch}><Icon name="search" /><span>Search</span></button>
    </div>
  );
}

/* ── Session: the standard Glyphh agent view (transparent blurred header,
   messages, composer pinned at the bottom). ─────────────────────────────── */
type SelSection = 'sections' | 'loop' | 'models' | 'permission';
interface CompProps {
  onPlus: () => void;
  onOpenSelector: (section: SelSection) => void;
  permLabel: string;
  modelSummary: string;   // dots "Change model" subtitle / home dropdown
  loopName: string;       // dots "Change loop" subtitle / home dropdown
}

function SessionView({ session, onBack, comp }: { session: Recent; onBack: () => void; comp: CompProps }) {
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [pinned, setPinned] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: Event) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, [menu]);

  return (
    <div className="m-sv">
      <header className="m-sv-head">
        <button className="m-chats-icon" aria-label="Back" onClick={onBack}><Icon name="back" /></button>
        <span className="m-sv-name">{session.title}</span>
        <div className="m-sv-menu-wrap" ref={menuRef}>
          <button className="m-chats-icon" aria-label="Options" onClick={() => { haptic(); setMenu((v) => !v); }}><Icon name="dots" /></button>
          {menu && (
            <div className="m-sv-menu" role="menu">
              <button className="m-sv-menu-row" onClick={() => { haptic(); setMenu(false); comp.onOpenSelector('models'); }}>
                <Icon name="swap" />
                <span className="m-sv-menu-text"><span className="m-sv-menu-t">Change model</span><span className="m-sv-menu-s">{comp.modelSummary}</span></span>
              </button>
              <button className="m-sv-menu-row" onClick={() => { haptic(); setMenu(false); comp.onOpenSelector('loop'); }}>
                <Icon name="loop" />
                <span className="m-sv-menu-text"><span className="m-sv-menu-t">Change loop</span><span className="m-sv-menu-s">{comp.loopName}</span></span>
              </button>
              <div className="m-sv-menu-sep" />
              <button className="m-sv-menu-row" onClick={() => { haptic(); setMenu(false); /* rename (mock) */ }}>
                <Icon name="pencil" /><span>Rename</span>
              </button>
              <button className="m-sv-menu-row" onClick={() => { haptic(); setMenu(false); setPinned((p) => !p); }}>
                <Icon name="pin" /><span>{pinned ? 'Unpin' : 'Pin'}</span>
              </button>
              <button className="m-sv-menu-row m-danger" onClick={() => { haptic(); setMenu(false); setConfirm(true); }}>
                <Icon name="trash" /><span>Delete</span>
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="m-sv-messages">
        {MESSAGES.map((m) => (
          <div key={m.id} className={`m-msg m-msg-${m.role}`}>{m.text}</div>
        ))}
      </div>
      <Composer {...comp} />

      {/* Delete confirmation (app modal, never a native confirm). */}
      {confirm && (
        <div className="m-confirm-overlay" role="dialog" aria-modal="true">
          <div className="m-confirm-scrim" onClick={() => setConfirm(false)} />
          <div className="m-confirm">
            <div className="m-confirm-title">Delete chat?</div>
            <div className="m-confirm-msg">“{session.title}” will be permanently deleted. This can’t be undone.</div>
            <div className="m-confirm-actions">
              <button className="m-confirm-btn" onClick={() => { haptic(); setConfirm(false); }}>Cancel</button>
              <button className="m-confirm-btn m-confirm-danger" onClick={() => { haptic(); setConfirm(false); onBack(); }}>Delete</button>
            </div>
          </div>
        </div>
      )}
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
/* Settings sub-trays — real SDK data. */
function ProfileTray({ user, onUpdated }: { user: DisplayUser; onUpdated: () => void }) {
  const [p, setP] = useState<Record<string, unknown> | null>(null);
  const [img, setImg] = useState('');          // live profile-image field + preview
  const [imgBad, setImgBad] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let on = true;
    glyphh().profile.get()
      .then((d: Record<string, unknown>) => { if (!on) return; setP(d); setImg((d.imageUrl as string) || ''); })
      .catch(() => { if (on) setErr('Could not load your profile.'); });
    return () => { on = false; };
  }, []);
  const save = async (patch: Record<string, unknown>) => {
    try {
      setErr('');
      const d = await glyphh().profile.update(patch);
      setP(d as Record<string, unknown>);
      setSaved(true); setTimeout(() => setSaved(false), 1300);
      onUpdated();   // refresh the app-wide user so the rail avatar + name follow
    } catch { setErr('Couldn’t save. Check your connection and try again.'); }
  };
  const zones = tzList();
  const tz = (p?.timezone as string) || '';
  const preview = (!imgBad && img) || (p?.avatarUrl as string) || user.avatarUrl || '';
  return (
    <>
      <div className="m-profile-top">
        {preview ? <img className="m-profile-avatar-img" src={preview} alt="" onError={() => setImgBad(true)} /> : <div className="m-profile-avatar">{user.initials}</div>}
        <div className="m-profile-name">{user.name}</div>
        <div className="m-profile-email">{user.email}</div>
        {(user.role || user.tier) && (
          <div className="m-profile-chips">
            {user.role && <span className="m-chip">{cap(user.role)}</span>}
            {user.tier && <span className="m-chip">{cap(user.tier)}</span>}
          </div>
        )}
      </div>
      {!p ? <div className="m-set-loading">Loading…</div> : (
        <>
          <div className="m-set-label">Details {saved && <span className="m-saved">Saved</span>}</div>
          <div className="m-set-form">
            <label className="m-field"><span className="m-field-l">First name</span>
              <input className="m-field-in" defaultValue={(p.firstName as string) ?? ''} onBlur={(e) => save({ firstName: e.currentTarget.value.trim() })} /></label>
            <label className="m-field"><span className="m-field-l">Last name</span>
              <input className="m-field-in" defaultValue={(p.lastName as string) ?? ''} onBlur={(e) => save({ lastName: e.currentTarget.value.trim() })} /></label>
            <label className="m-field"><span className="m-field-l">Profile image URL</span>
              <input className="m-field-in" type="url" inputMode="url" placeholder="https://…" value={img}
                onChange={(e) => { setImg(e.currentTarget.value); setImgBad(false); }}
                onBlur={() => save({ imageUrl: img.trim() || null })} /></label>
            <label className="m-field"><span className="m-field-l">Timezone</span>
              {zones ? (
                <select className="m-field-in" value={tz} onChange={(e) => save({ timezone: e.currentTarget.value })}>
                  {tz && !zones.includes(tz) && <option value={tz}>{tz}</option>}
                  {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                </select>
              ) : (
                <input className="m-field-in" defaultValue={tz} onBlur={(e) => save({ timezone: e.currentTarget.value.trim() })} />
              )}
            </label>
          </div>
          <button className="m-field-btn" onClick={() => save({ timezone: deviceTz() })}>Use this device’s timezone</button>
          {err && <div className="m-field-err">{err}</div>}
        </>
      )}
    </>
  );
}

function BillingTray() {
  const [d, setD] = useState<{ sub?: Record<string, unknown>; credits?: Record<string, number> } | null>(null);
  useEffect(() => {
    let on = true;
    Promise.all([glyphh().billing.status(), glyphh().billing.credits()])
      .then(([s, c]) => { if (on) setD({ sub: s, credits: c }); }).catch(() => { if (on) setD({}); });
    return () => { on = false; };
  }, []);
  const portal = async () => { try { const r = await glyphh().billing.portal(); const url = (r as { url?: string })?.url || (r as unknown as string); if (url) window.open(url, '_blank', 'noopener'); } catch { /* */ } };
  if (!d) return <div className="m-set-loading">Loading…</div>;
  const s = d.sub as Record<string, unknown> | undefined; const c = d.credits;
  const tierRaw = (s?.tier as string) || '';
  const tier = tierRaw ? tierRaw.charAt(0).toUpperCase() + tierRaw.slice(1) : '—';
  return (
    <>
      <div className="m-bill-plan">
        <div className="m-bill-tier">{tier}</div>
        {s && <div className="m-bill-seats">{String(s.seats)}/{String(s.maxSeats)} seats · {String(s.billingStatus ?? '')}</div>}
      </div>
      <div className="m-bill-cards">
        <div className="m-bill-card"><span className="m-bill-v">{credits(c?.balance)}</span><span className="m-bill-l">Available</span></div>
        <div className="m-bill-card"><span className="m-bill-v">{credits(c?.allowance ?? c?.grants)}</span><span className="m-bill-l">Allowance</span></div>
        <div className="m-bill-card"><span className="m-bill-v">{credits(c?.purchases)}</span><span className="m-bill-l">Purchased</span></div>
      </div>
      <button className="m-field-btn" onClick={portal}>Manage billing &amp; payment</button>
    </>
  );
}

function UsageTray() {
  const [d, setD] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { let on = true; glyphh().usage.mine().then((u: Record<string, unknown>) => { if (on) setD(u); }).catch(() => { if (on) setD({}); }); return () => { on = false; }; }, []);
  if (!d) return <div className="m-set-loading">Loading…</div>;
  const bs = (d.bySource as Record<string, number>) || {};
  return (
    <>
      <div className="m-bill-cards">
        <div className="m-bill-card"><span className="m-bill-v">{credits(d.credits as number)}</span><span className="m-bill-l">Credits used</span></div>
        <div className="m-bill-card"><span className="m-bill-v">{credits(d.creditsSaved as number)}</span><span className="m-bill-l">Saved</span></div>
      </div>
      <div className="m-set-label">By source</div>
      <div className="m-sel-group">
        <div className="m-sel-row"><span className="m-sel-row-label">Runtime</span><span className="m-sel-row-val">{credits(bs.fly)}</span></div>
        <div className="m-sel-row"><span className="m-sel-row-label">Connectors</span><span className="m-sel-row-val">{credits(bs.pipedream)}</span></div>
        <div className="m-sel-row"><span className="m-sel-row-label">Model providers</span><span className="m-sel-row-val">{credits(bs.provider)}</span></div>
      </div>
    </>
  );
}

function ConnectionsTray() {
  type Conn = { id: string; appSlug: string; appName: string; label: string | null; healthy: boolean };
  type App = { id: string; name: string; icon: string | null };
  type Tool = { key: string; name: string; description?: string };
  const [view, setView] = useState<'list' | 'catalog' | 'detail'>('list');
  const [conns, setConns] = useState<Conn[] | null>(null);
  const [apps, setApps] = useState<App[] | null>(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [del, setDel] = useState<Conn | null>(null);
  const [connecting, setConnecting] = useState<{ app: App; url: string } | null>(null);
  // Detail (edit) tray state.
  const [sel, setSel] = useState<Conn | null>(null);
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [allowed, setAllowed] = useState<Set<string>>(new Set());

  const refresh = async () => { try { setConns(await glyphh().connections.personalList()); } catch { setConns([]); } };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (view !== 'catalog') return;
    let on = true; setApps(null);
    glyphh().connections.apps({ search: q.trim() || undefined, limit: 40 })
      .then((r: { apps: App[] }) => { if (on) setApps(r.apps || []); }).catch(() => { if (on) setApps([]); });
    return () => { on = false; };
  }, [view, q]);

  // While the connect tray is open, watch for the new account to land, then
  // close the tray + return to the list (also on tab focus, belt-and-braces).
  useEffect(() => {
    if (!connecting) return;
    const before = new Set((conns || []).map((c) => c.id));
    let alive = true, n = 0;
    const tick = async () => {
      if (!alive) return;
      n++;
      const list = await glyphh().connections.personalList().catch(() => null);
      if (list) { setConns(list); if (list.some((c) => !before.has(c.id))) { setConnecting(null); setView('list'); return; } }
      if (n < 90) setTimeout(() => void tick(), 2000);
    };
    const t = setTimeout(() => void tick(), 2000);
    const onFocus = () => void tick();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; clearTimeout(t); window.removeEventListener('focus', onFocus); };
  }, [connecting]);

  const startConnect = async (app: App) => {
    try {
      setErr('');
      const s = await glyphh().connections.personalConnect(app.id) as { url?: string; connectUrl?: string };
      const url = s?.url || s?.connectUrl;
      if (!url) { setErr('Could not start the connection.'); return; }
      setConnecting({ app, url });
    } catch { setErr('Could not start the connection.'); }
  };
  const disconnect = async (c: Conn) => {
    setDel(null);
    try { await glyphh().connections.personalDisconnect(c.id); setView('list'); setSel(null); void refresh(); } catch { setErr('Could not disconnect.'); }
  };

  // Open the edit tray: load the app's full tool catalog + this connection's
  // allowed cap (absent ⇒ all tools allowed).
  const openDetail = async (c: Conn) => {
    haptic(); setErr(''); setSel(c); setTools(null); setView('detail');
    try {
      const [t, caps] = await Promise.all([
        glyphh().connections.appTools(c.appSlug),
        glyphh().connections.personalConnectionTools(),
      ]);
      const list = (t?.tools || []) as Tool[];
      setTools(list);
      const cap = (caps as Record<string, string[]>)[c.appSlug];
      setAllowed(cap == null ? new Set(list.map((x) => x.name)) : new Set(cap));
    } catch { setTools([]); }
  };
  const toggleTool = (c: Conn, name: string) => {
    haptic();
    const next = new Set(allowed);
    if (next.has(name)) next.delete(name); else next.add(name);
    setAllowed(next);
    void glyphh().connections.setPersonalConnectionTools(c.appSlug, [...next]).catch(() => setErr('Could not update tools.'));
  };
  const rename = (c: Conn, label: string) => {
    const v = label.trim();
    if (!v || v === (c.label || c.appName)) return;
    void glyphh().connections.renamePersonalConnection(c.id, v).then(() => void refresh()).catch(() => setErr('Could not rename.'));
  };

  return (
    <>
      {view === 'catalog' ? (
        <>
          <button className="m-conn-back" onClick={() => { haptic(); setView('list'); setErr(''); }}><Icon name="back" /><span>Connections</span></button>
          <div className="m-sel-search"><Icon name="search" /><input className="m-conn-in" placeholder="Search apps" value={q} onChange={(e) => setQ(e.currentTarget.value)} /></div>
          {apps == null ? <div className="m-set-loading">Loading…</div> : (
            <div className="m-sel-group">
              {apps.map((a) => (
                <button key={a.id} className="m-opt" onClick={() => startConnect(a)}>
                  <span className="m-conn-ico">{a.icon ? <img src={a.icon} alt="" /> : (a.name || '?').charAt(0)}</span>
                  <span className="m-opt-text"><span className="m-opt-name">{a.name}</span></span>
                  <Icon name="plus" />
                </button>
              ))}
            </div>
          )}
          {err && <div className="m-field-err">{err}</div>}
        </>
      ) : view === 'detail' && sel ? (
        <>
          <button className="m-conn-back" onClick={() => { haptic(); setView('list'); setSel(null); setErr(''); }}><Icon name="back" /><span>Connections</span></button>
          <div className="m-conn-detail-head">
            <span className="m-conn-ico m-conn-ico-lg">{(sel.appName || '?').charAt(0)}</span>
            <div className="m-conn-detail-meta">
              <div className="m-conn-detail-name">{sel.label || sel.appName}</div>
              <div className={`m-conn-detail-status${sel.healthy === false ? ' bad' : ''}`}>{sel.healthy === false ? 'Reconnect needed' : 'Connected'}</div>
            </div>
          </div>
          <div className="m-set-label">Name</div>
          <div className="m-set-form">
            <input className="m-field-in" defaultValue={sel.label || sel.appName} placeholder={sel.appName} onBlur={(e) => rename(sel, e.currentTarget.value)} />
          </div>
          <div className="m-set-label">Tools your agent can use</div>
          {tools == null ? <div className="m-set-loading">Loading tools…</div>
            : tools.length === 0 ? <div className="m-conn-empty">This app publishes no tools yet.</div>
            : (
              <div className="m-sel-group">
                {tools.map((t) => (
                  <button key={t.key || t.name} className="m-opt" onClick={() => toggleTool(sel, t.name)}>
                    <span className="m-opt-text"><span className="m-opt-name">{t.name}</span>{t.description && <span className="m-opt-desc">{t.description}</span>}</span>
                    <span className="m-toolcheck" data-on={allowed.has(t.name) ? 'true' : 'false'}>{allowed.has(t.name) && <Icon name="tick" />}</span>
                  </button>
                ))}
              </div>
            )}
          <button className="m-field-btn m-field-danger" onClick={() => { haptic(); setDel(sel); }}>Disconnect</button>
          {err && <div className="m-field-err">{err}</div>}
        </>
      ) : (
        <>
          {conns == null ? <div className="m-set-loading">Loading…</div>
            : conns.length === 0 ? <div className="m-conn-empty">No connections yet. Add one to give your agent access to your apps.</div>
            : (
              <div className="m-sel-group">
                {conns.map((c) => (
                  <button key={c.id} className="m-opt" onClick={() => openDetail(c)}>
                    <span className="m-conn-ico">{(c.appName || '?').charAt(0)}</span>
                    <span className="m-opt-text"><span className="m-opt-name">{c.label || c.appName}</span><span className="m-opt-desc">{c.healthy === false ? 'Reconnect needed' : 'Connected'}</span></span>
                    <Icon name="chevron" />
                  </button>
                ))}
              </div>
            )}
          <button className="m-field-btn" onClick={() => { haptic(); setView('catalog'); }}>+ Add a connection</button>
          {err && <div className="m-field-err">{err}</div>}
        </>
      )}

      {/* Connect happens IN-APP as a tray (no popup): the Pipedream Connect page
          loads in an embedded frame; we detect the new account and close. */}
      {connecting && (
        <div className="m-connect-tray">
          <header className="m-connect-head">
            <button className="m-sheet-btn" aria-label="Cancel" onClick={() => { haptic(); setConnecting(null); void refresh(); }}><Icon name="close" /></button>
            <span className="m-sheet-title">Connect {connecting.app.name}</span>
            <span className="m-sheet-btn" aria-hidden="true" style={{ visibility: 'hidden' }} />
          </header>
          <iframe className="m-connect-frame" src={connecting.url} title={`Connect ${connecting.app.name}`} allow="clipboard-write" />
          <a className="m-connect-fallback" href={connecting.url} target="_blank" rel="noopener noreferrer">Trouble loading? Open in a browser tab</a>
        </div>
      )}

      {del && (
        <div className="m-confirm-overlay" role="dialog" aria-modal="true">
          <div className="m-confirm-scrim" onClick={() => setDel(null)} />
          <div className="m-confirm">
            <div className="m-confirm-title">Disconnect {del.label || del.appName}?</div>
            <div className="m-confirm-msg">Your agent loses access to its tools until you reconnect.</div>
            <div className="m-confirm-actions">
              <button className="m-confirm-btn" onClick={() => setDel(null)}>Cancel</button>
              <button className="m-confirm-btn m-confirm-danger" onClick={() => disconnect(del)}>Disconnect</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const THEMES: { id: string; name: string; desc?: string }[] = [
  { id: 'system', name: 'System', desc: 'Match your device' },
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
  { id: 'purple', name: 'Purple' },
  { id: 'aurora', name: 'Aurora' },
  { id: 'prism', name: 'Prism' },
  { id: 'github', name: 'GitHub' },
  { id: 'highvis', name: 'High contrast' },
  { id: 'claude', name: 'Claude' },
  { id: 'chatgpt', name: 'ChatGPT' },
  { id: 'gemini', name: 'Gemini' },
  { id: 'dracula', name: 'Dracula' },
  { id: 'nord', name: 'Nord' },
  { id: 'synthwave', name: 'Synthwave' },
  { id: 'matrix', name: 'Matrix' },
];
function AppearanceTray() {
  const [theme, setTheme] = useState(currentTheme);
  const pick = (t: string) => { haptic(); setTheme(t); applyTheme(t); };
  const sysResolved = (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  return (
    <div className="m-sel-group">
      {THEMES.map((o) => (
        <button key={o.id} className="m-opt" onClick={() => pick(o.id)}>
          <span className="m-theme-sw" data-theme={o.id === 'system' ? sysResolved : o.id} aria-hidden="true" />
          <span className="m-opt-text"><span className="m-opt-name">{o.name}</span>{o.desc && <span className="m-opt-desc">{o.desc}</span>}</span>
          {theme === o.id && <span className="m-opt-tick"><Icon name="tick" /></span>}
        </button>
      ))}
    </div>
  );
}

type SettingsSub = 'profile' | 'billing' | 'usage' | 'appearance' | 'connections';
function SettingsSheet({ open, onClose, user, onSignOut, onUserChanged }: { open: boolean; onClose: () => void; user: DisplayUser; onSignOut: () => void; onUserChanged: () => void }) {
  const [sub, setSub] = useState<SettingsSub>('profile');
  const [subOpen, setSubOpen] = useState(false);   // drives the track; sub persists during slide-back
  const [info, setInfo] = useState(false);
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => { setSubOpen(false); setInfo(false); }, 260);
    return () => clearTimeout(t);
  }, [open]);
  const openSub = (s: SettingsSub) => { haptic(); setSub(s); setSubOpen(true); };
  const title = sub === 'profile' ? 'Profile' : sub === 'billing' ? 'Billing' : sub === 'usage' ? 'Usage'
    : sub === 'connections' ? 'Connections' : 'Appearance';

  const legalRow = (href: string, label: string) => (
    <a className="m-info-row" href={href} target="_blank" rel="noopener noreferrer" onClick={() => setInfo(false)}>
      <Icon name="external" /><span>{label}</span>
    </a>
  );

  return (
    <div className="m-sheet-overlay" data-open={open ? 'true' : 'false'}>
      <div className="m-sheet-scrim" onClick={onClose} />
      <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="m-sheet-track" data-open={subOpen ? 'true' : 'false'}>
          {/* Panel A — the settings list. */}
          <section className="m-sheet-panel">
            <header className="m-sheet-head">
              <button className="m-sheet-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
              <span className="m-sheet-title">Settings</span>
              <button className="m-sheet-btn m-sheet-info" aria-label="About" onClick={() => { haptic(); setInfo((v) => !v); }}><Icon name="info" /></button>
            </header>
            <div className="m-sheet-scroll">
              <div className="m-set-email">{user.email}</div>
              {SETTINGS_GROUPS.map((g) => (
                <div key={g.label} className="m-set-section">
                  <div className="m-set-label">{g.label}</div>
                  <div className="m-set-group">
                    {g.rows.map((r) => (
                      <button key={r.label} className="m-set-row" onClick={() => openSub(r.sub)}>
                        <span className="m-set-ico"><Icon name={r.icon as IconName} /></span>
                        <span className="m-set-name">{r.label}</span>
                        {r.value && <span className="m-set-val">{r.value}</span>}
                        <Icon name="chevron" />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <button className="m-profile-signout" onClick={() => { haptic(); onSignOut(); }}>Sign out</button>
            </div>
          </section>

          {/* Panel B — the active sub-screen (Profile / Billing / Usage). */}
          <section className="m-sheet-panel">
            <header className="m-sheet-head">
              <button className="m-sheet-btn" aria-label="Back" onClick={() => { haptic(); setSubOpen(false); }}><Icon name="back" /></button>
              <span className="m-sheet-title">{title}</span>
              <span className="m-sheet-btn" aria-hidden="true" style={{ visibility: 'hidden' }} />
            </header>
            <div className="m-sheet-scroll">
              {sub === 'profile' && <ProfileTray user={user} onUpdated={onUserChanged} />}
              {sub === 'billing' && <BillingTray />}
              {sub === 'usage' && <UsageTray />}
              {sub === 'connections' && <ConnectionsTray />}
              {sub === 'appearance' && <AppearanceTray />}
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

function SelectorSheet({ open, section, onClose, loop, setLoop, perm, setPerm, roleModels, setRoleModels }: {
  open: boolean;
  section: 'loop' | 'models' | 'permission' | null;   // deep-link entry point
  onClose: () => void;
  loop: string; setLoop: (v: string) => void;
  perm: string; setPerm: (v: string) => void;
  roleModels: Record<string, string>; setRoleModels: (fn: (m: Record<string, string>) => Record<string, string>) => void;
}) {
  // The chosen loop's role slots (Planner/Builder/…) drive the Models tray.
  const roles = rolesForLoop(loop);
  const topModels = MODELS.slice(0, MODEL_TOP_N);      // shown per role
  const moreModels = MODELS.slice(MODEL_TOP_N);        // the rest → "More models"

  // Depth track: 0 = sections, 1 = a section tray, 2 = More models (per role).
  const [tray, setTray] = useState<'loop' | 'models' | 'permission'>('models');
  const [depth, setDepth] = useState(0);
  const [moreRole, setMoreRole] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});   // undefined → expanded

  // Open → jump straight to the requested section's tray. Close → reset once slid away.
  useEffect(() => {
    if (open) { if (section) { setTray(section); setDepth(1); } return; }
    const t = setTimeout(() => setDepth(0), 260);
    return () => clearTimeout(t);
  }, [open]);

  const nameOf = (arr: { id: string; name: string }[], id: string) => arr.find((x) => x.id === id)?.name ?? '';
  const modelName = (id: string) => nameOf(MODELS, id);
  const openTray = (t: 'loop' | 'models' | 'permission') => { haptic(); setTray(t); setDepth(1); };
  const trayTitle = tray === 'loop' ? 'Loop' : tray === 'models' ? 'Models' : 'Permission';
  const modelsSummary = roles.length === 1 ? modelName(roleModels[roles[0].id]) : `${roles.length} models`;
  const setRoleModel = (roleId: string, id: string) => { haptic(); setRoleModels((m) => ({ ...m, [roleId]: id })); };
  const toggleRole = (roleId: string) => { haptic(); setExpanded((e) => ({ ...e, [roleId]: !(e[roleId] ?? true) })); };
  const openMore = (roleId: string) => { haptic(); setMoreRole(roleId); setDepth(2); };
  const moreRoleName = nameOf(roles, moreRole);

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
                  <span className="m-sel-row-label">Loop</span><span className="m-sel-row-val">{nameOf(LOOPS, loop)}</span><Icon name="chevron" />
                </button>
                <button className="m-sel-row" onClick={() => openTray('models')}>
                  <span className="m-sel-row-label">Models</span><span className="m-sel-row-val">{modelsSummary}</span><Icon name="chevron" />
                </button>
                <button className="m-sel-row" onClick={() => openTray('permission')}>
                  <span className="m-sel-row-label">Permission</span><span className="m-sel-row-val">{nameOf(PERMISSIONS, perm)}</span><Icon name="chevron" />
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
                  {/* One collapsible section per loop role; each lists its top N,
                      then "More models" → the rest of the pool (panel 2). */}
                  {roles.map((r) => (
                    <div key={r.id} className="m-role" data-open={(expanded[r.id] ?? true) ? 'true' : 'false'}>
                      <button className="m-role-head" onClick={() => toggleRole(r.id)}>
                        <span className="m-role-name">{r.name}</span>
                        <span className="m-role-val">{modelName(roleModels[r.id])}</span>
                        <Icon name="caret" />
                      </button>
                      {(expanded[r.id] ?? true) && (
                        <div className="m-sel-group">
                          {topModels.map((m) => (
                            <button key={m.id} className="m-opt" onClick={() => setRoleModel(r.id, m.id)}>
                              <span className="m-opt-text"><span className="m-opt-name">{m.name}</span><span className="m-opt-desc">{m.desc}</span></span>
                              {roleModels[r.id] === m.id && <span className="m-opt-tick"><Icon name="tick" /></span>}
                            </button>
                          ))}
                          <button className="m-sel-row" onClick={() => openMore(r.id)}>
                            <span className="m-sel-row-label">More models</span><Icon name="chevron" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
              {tray === 'permission' && (
                <OptionList items={PERMISSIONS} selected={perm} onPick={(id) => { haptic(); setPerm(id); setDepth(0); }} />
              )}
            </div>
          </section>

          {/* Panel 2 — More models for a role: the pool minus that role's top N. */}
          <section className="m-sel-panel">
            <div className="m-sel-head">
              <button className="m-sheet-btn" aria-label="Back" onClick={() => { haptic(); setDepth(1); }}><Icon name="back" /></button>
              <span className="m-sel-title">{moreRoleName ? `${moreRoleName} · more` : 'More models'}</span>
            </div>
            <div className="m-sel-body">
              <div className="m-sel-search"><Icon name="search" /><span>Search all models</span></div>
              <OptionList items={moreModels} selected={roleModels[moreRole]} onPick={(id) => { setRoleModel(moreRole, id); setDepth(1); }} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/* ── Search overlay: the resting pill promotes to a focused input pinned above
   the keyboard (tracked via visualViewport). Slides up on open; the X slides it
   back down. Rendered at app root so position:fixed escapes the shell transform. */
function SearchOverlay({ open, inputRef, onClose }: {
  open: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onClose: () => void;
}) {
  useEffect(() => {
    const vv = window.visualViewport;
    const setKb = (px: number) => document.documentElement.style.setProperty('--m-kb', px + 'px');
    if (!open) { setKb(0); return; }
    const update = () => {
      if (!vv) return;
      setKb(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    };
    update();
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    return () => { vv?.removeEventListener('resize', update); vv?.removeEventListener('scroll', update); setKb(0); };
  }, [open]);

  return (
    <div className="m-search-overlay" data-open={open ? 'true' : 'false'}>
      <div className="m-search-scrim" onClick={onClose} />
      <div className="m-search-bar">
        <div className="m-search-field">
          <Icon name="search" />
          <input ref={inputRef} className="m-search-input" type="text" placeholder="Search"
            autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} enterKeyHint="search" />
        </div>
        <button className="m-search-x" aria-label="Close search" onClick={onClose}><Icon name="close" /></button>
      </div>
    </div>
  );
}

/* ── Login: the one never-themed surface. Magic link + Google, over the muse
   canvas. Redeems the ?token= callback on /m itself. ─────────────────────── */
function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const gRef = useRef<HTMLDivElement>(null);
  const clientId = typeof window !== 'undefined' ? (window as unknown as { __GLYPHH_GOOGLE_CLIENT_ID__?: string }).__GLYPHH_GOOGLE_CLIENT_ID__ : undefined;

  // Google Identity Services — renders its own button; the credential is an ID token.
  useEffect(() => {
    if (!clientId || !gRef.current) return;
    let cancelled = false;
    const mount = () => {
      const g = (window as unknown as { google?: any }).google;
      if (!g?.accounts?.id || cancelled || !gRef.current) return;
      g.accounts.id.initialize({
        client_id: clientId,
        callback: async (resp: { credential: string }) => {
          try { setBusy(true); setErr(''); await signInWithGoogle(resp.credential); await syncGating(); onSignedIn(); }
          catch { setErr('Google sign-in failed. Try the magic link.'); setBusy(false); }
        },
      });
      g.accounts.id.renderButton(gRef.current, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 300 });
    };
    if ((window as unknown as { google?: any }).google?.accounts?.id) { mount(); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true; s.onload = mount;
    document.head.appendChild(s);
    return () => { cancelled = true; };
  }, [clientId, onSignedIn]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) return;
    try { setBusy(true); setErr(''); await startEmailLink(addr, window.location.origin + '/m'); setSent(true); }
    catch { setErr('Could not send the link. Check the address and try again.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="m-login">
      <SplashFlow />
      <div className="m-login-card">
        <img className="m-login-logo" src="/brand/glyphh-logo-white.png" alt="Glyphh" />
        {sent ? (
          <div className="m-login-sent">
            <div className="m-login-title">Check your email</div>
            <p className="m-login-sub">We sent a sign-in link to <b>{email}</b>. Open it on this device to continue.</p>
            <button className="m-login-alt" onClick={() => { haptic(); setSent(false); }}>Use a different email</button>
          </div>
        ) : (
          <>
            <div className="m-login-title">Sign in to Glyphh</div>
            <form className="m-login-form" onSubmit={submit}>
              <input className="m-login-input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none"
                placeholder="you@work.com" value={email} onChange={(e) => setEmail((e.target as HTMLInputElement).value)} />
              <button className="m-login-primary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Email me a magic link'}</button>
            </form>
            {clientId && <div className="m-login-or"><span>or</span></div>}
            {clientId && <div className="m-login-google" ref={gRef} />}
            {err && <div className="m-login-err">{err}</div>}
          </>
        )}
        <div className="m-login-legal">
          By continuing you agree to our <a href={LEGAL.terms} target="_blank" rel="noopener noreferrer">Terms</a> &amp;{' '}
          <a href={LEGAL.privacy} target="_blank" rel="noopener noreferrer">Privacy</a>.
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
  const [authState, setAuthState] = useState<'checking' | 'in' | 'out'>('checking');
  const [user, setUser] = useState<DisplayUser>(() => toDisplayUser(cachedUser()));
  const [minSplash, setMinSplash] = useState(false);   // hold the splash for its full beat
  const [settings, setSettings] = useState(false);
  const [attach, setAttach] = useState(false);
  const [selectorAt, setSelectorAt] = useState<SelSection | null>(null);
  const [loop, setLoop] = useState('default');
  const [perm, setPerm] = useState('accept-edits');
  const [roleModels, setRoleModels] = useState<Record<string, string>>(() => seedRoleModels('default'));
  const [search, setSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Focus synchronously inside the tap so iOS raises the keyboard.
  const openSearch = () => { haptic(); searchInputRef.current?.focus(); setSearch(true); };
  const closeSearch = () => { haptic(); searchInputRef.current?.blur(); setSearch(false); };
  const comp: CompProps = {
    onPlus: () => { haptic(); setAttach(true); },
    onOpenSelector: (s) => { haptic(); setSelectorAt(s); },
    permLabel: PERMISSIONS.find((p) => p.id === perm)?.name ?? 'Accept edits',
    modelSummary: modelSummaryText(loop, roleModels),
    loopName: loopNameOf(loop),
  };

  // Hold the splash for its full beat regardless of how fast auth resolves.
  useEffect(() => {
    const t = setTimeout(() => setMinSplash(true), 2200);
    return () => clearTimeout(t);
  }, []);

  // Boot auth: redeem a magic-link/exchange callback if present, else check the
  // stored session; then who-am-I. The signed-out event flips us back to login.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = new URL(window.location.href);
        const token = url.searchParams.get('token');
        const code = url.searchParams.get('code');
        if (token || code) {
          if (token) await verifyEmailLink(token); else await exchangeCode(code as string);
          url.searchParams.delete('token'); url.searchParams.delete('code'); url.searchParams.delete('redirect');
          window.history.replaceState({}, '', url.pathname + url.search + url.hash);
        }
        const authed = token || code ? true : await isAuthenticated();
        if (!authed) { if (!cancelled) setAuthState('out'); return; }
        const u = await syncGating();
        if (cancelled) return;
        setUser(toDisplayUser(u));
        setAuthState(u ? 'in' : 'out');
      } catch { if (!cancelled) setAuthState('out'); }
    })();
    const onOut = () => { setAuthState('out'); setUser(toDisplayUser(null)); };
    window.addEventListener('glyphh:signed-out', onOut);
    return () => { cancelled = true; window.removeEventListener('glyphh:signed-out', onOut); };
  }, []);

  const onSignedIn = () => {
    setAuthState('checking');
    void syncGating().then((u) => { setUser(toDisplayUser(u)); setAuthState(u ? 'in' : 'out'); });
  };
  const onSignOut = () => { setSettings(false); void sdkSignOut(); };  // event flips to 'out'

  // Loop change → the role set changes; reseed each slot to its default model.
  useEffect(() => { setRoleModels(seedRoleModels(loop)); }, [loop]);

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

  const showSplash = !minSplash || authState === 'checking';

  return (
    <div className="m-app" data-drawer={drawer ? 'open' : 'closed'}>
      {/* Signed out → the login surface (once the splash beat is done). */}
      {authState === 'out' && !showSplash && <Login onSignedIn={onSignedIn} />}

      {/* Signed in → the app. */}
      {authState === 'in' && (
      <>
      <div className="m-shell">
        <Rail active={active} onSelect={selectSpace} onOpenRecent={openRecent} onAllChats={allChats} onAccount={account} onNewChat={newChat} user={user} />
        <main className="m-main">
          {screen === 'home' && (
            <div className="m-home">
              {/* Same transparent chats-style header + a centered loop / model dropdown. */}
              <div className="m-chats-fade m-chats-fade-top" />
              <header className="m-chats-head m-home-head">
                <button className="m-chats-icon" aria-label="Open menu" onClick={toggleDrawer}><Icon name="menu" /></button>
                <div className="m-home-center">
                  <button className="m-home-loop" onClick={() => comp.onOpenSelector('sections')}>
                    <span>{comp.loopName} / {comp.modelSummary}</span>
                    <Icon name="caret" />
                  </button>
                </div>
                <span className="m-home-head-spacer" aria-hidden="true" />
              </header>
              <Ghost />
              <Composer {...comp} />
            </div>
          )}
          {(screen === 'list' || screen === 'session') && (
            <div className="m-nav" data-screen={screen}>
              <div className="m-nav-track">
                <section className="m-nav-panel">
                  {active === 'code'
                    ? <CodeView onMenu={toggleDrawer} onOpen={openSession} onNewSession={newSession} onSearch={openSearch} />
                    : active === 'work'
                    ? <WorkView onMenu={toggleDrawer} onOpen={openSession} onNewTask={newSession} onSearch={openSearch} />
                    : <ChatsView title={NAV.find((n) => n.id === active)?.label ?? 'Chats'} onMenu={toggleDrawer} onOpen={openSession} onNewChat={newChat} onSearch={openSearch} />}
                </section>
                <section className="m-nav-panel">
                  {session && <SessionView session={session} onBack={backToList} comp={comp} />}
                </section>
              </div>
            </div>
          )}
          {/* Blurs the pushed-out content while the drawer is open; tap to close. */}
          <div className="m-scrim" onClick={() => setDrawer(false)} />
        </main>
      </div>
      <SettingsSheet open={settings} onClose={() => { haptic(); setSettings(false); }} user={user} onSignOut={onSignOut}
        onUserChanged={() => { void syncGating().then((u) => setUser(toDisplayUser(u))); }} />
      <AttachMenu open={attach} onClose={() => { haptic(); setAttach(false); }} />
      <SelectorSheet
        open={selectorAt !== null}
        section={selectorAt === 'sections' ? null : selectorAt}
        onClose={() => { haptic(); setSelectorAt(null); }}
        loop={loop} setLoop={setLoop}
        perm={perm} setPerm={setPerm}
        roleModels={roleModels} setRoleModels={setRoleModels}
      />
      <SearchOverlay open={search} inputRef={searchInputRef} onClose={closeSearch} />
      </>
      )}

      {/* Splash sits on top until the beat is done and auth has resolved. */}
      {showSplash && (
        <div className="m-splash">
          <SplashFlow />
          <img className="m-splash-logo m-splash-logo-black" src="/brand/glyphh-logo-black.png" alt="Glyphh" />
          <img className="m-splash-logo m-splash-logo-white" src="/brand/glyphh-logo-white.png" alt="" />
        </div>
      )}
    </div>
  );
}

const el = document.getElementById('glyphh-mobile-root');
if (el) createRoot(el).render(<App />);
