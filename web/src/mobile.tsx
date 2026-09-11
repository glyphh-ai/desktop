// mobile.tsx — the Glyphh mobile PLATFORM surface (THE PURGE, phase 2).
//
// The agent chat, sessions, composer, voice, attach, connections, and app
// trays are gone with the cloud runtime — the mobile site LIVES only as the
// simple platform interface (owner's ruling): sign in, then account / license
// billing / organization / members / appearance / help, plus the super-admin
// Plans + Orgs console. Styling stays TOKENISED in mobile.css; login is the
// one surface a theme never overrides.

import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { useState, useEffect, useRef } from 'react';
import { SETTINGS_GROUPS, type SpaceId } from './mock';
import {
  glyphh, syncGating, isAuthenticated, signInWithGoogle, startEmailLink,
  verifyEmailLink, exchangeCode, signOut as sdkSignOut, cachedUser,
} from './glyphh-web.js';
import { installAutofillGuard } from '../../src/renderer/autofill-guard';

declare const __GLYPHH_VERSION__: string;

/** Password-manager / AutoFill suppression for non-credential fields. */
const NOFILL = { "data-1p-ignore": true, "data-lpignore": "true", "data-bwignore": true, "data-form-type": "other" } as const;

/** Whole credits for a MICRO value — the admin Plans tray still shows the
 *  legacy per-seat allowance column. */
function wholeCredits(v: number | null | undefined): string {
  const n = Math.floor((Number(v) || 0) / 1_000_000);
  return n.toLocaleString();
}

function applyTheme(t: string) {
  try { localStorage.setItem('yoTheme', t); } catch { /* */ }
  const resolved = t === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : t;
  document.documentElement.setAttribute('data-theme', resolved);
  syncThemeColor();
}
/* Keep Safari's UI (status bar + bottom toolbar) tinted to the live theme's page
   colour. Otherwise a stale/dark theme-color makes Safari paint a grey gradient
   over the page above its bottom bar. Reads the resolved --bg so every theme
   (not just light/dark) matches. */
function syncThemeColor() {
  try {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (!bg) return;
    let m = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
    m.setAttribute('content', bg);
  } catch { /* best effort */ }
}

function currentTheme(): string { try { return localStorage.getItem('yoTheme') || 'dark'; } catch { return 'dark'; } }


interface DisplayUser { name: string; email: string; initials: string; avatarUrl: string | null; role: string; tier: string; isPlatformAdmin: boolean; }
function toDisplayUser(u: { name?: string | null; email?: string | null; avatarUrl?: string | null; role?: string | null; tier?: string | null; isPlatformAdmin?: boolean | null } | null): DisplayUser {
  const name = (u?.name || u?.email || 'You').trim();
  const email = u?.email || '';
  const parts = name.split(/\s+/).filter(Boolean);
  const initials = (parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : (name[0] || 'U')).toUpperCase();
  return { name, email, initials, avatarUrl: u?.avatarUrl || null, role: u?.role || '', tier: u?.tier || '', isPlatformAdmin: !!u?.isPlatformAdmin };
}
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const deviceTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } };
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

const APP_VERSION = typeof __GLYPHH_VERSION__ !== 'undefined' ? __GLYPHH_VERSION__ : '';

// The real Glyphh legal pages that exist on the site (see web/app/*).
const LEGAL = {
  terms: 'https://glyphh.ai/terms',
  privacy: 'https://glyphh.ai/privacy',
  refund: 'https://glyphh.ai/refund',
  help: 'https://glyphh.ai',
};


type IconName = SpaceId | 'menu' | 'plus' | 'chevron' | 'filter' | 'search' | 'back' | 'dots' | 'send' | 'mic'
  | 'laptop' | 'monitor' | 'monitor-off' | 'cloud' | 'branch' | 'caret' | 'arrowdown'
  | 'circle' | 'progress' | 'check' | 'copy'
  | 'close' | 'info' | 'user' | 'dollar' | 'chart' | 'bell' | 'shield' | 'link'
  | 'sliders' | 'grid' | 'perms' | 'voice'
  | 'camera' | 'image' | 'filedoc' | 'tick' | 'external' | 'pin' | 'chats' | 'pencil' | 'trash'
  | 'swap' | 'loop' | 'contrast' | 'help' | 'key' | 'building' | 'users';

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
  arrowdown: <path d="M12 5v14M5 12l7 7 7-7" />,
  circle: <circle cx="12" cy="12" r="8" />,
  progress: <path d="M12 4a8 8 0 1 0 7.5 5.3" />,
  check: <><circle cx="12" cy="12" r="8" /><path d="M8.5 12l2.5 2.5 4.5-5" /></>,
  copy: <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
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
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.2 9.2a2.8 2.8 0 0 1 5.5.8c0 1.9-2.7 2-2.7 3.5" /><path d="M12 17h.01" /></>,
  key: <><circle cx="7.5" cy="15.5" r="4" /><path d="M10.3 12.7L20 3" /><path d="M16 7l3 3" /><path d="M13 10l2.5 2.5" /></>,
  building: <><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M10 21v-4h4v4" /></>,
  users: <><circle cx="9" cy="9" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M16 6.4a3 3 0 0 1 0 5.5M20.5 19a5.5 5.5 0 0 0-4-5.3" /></>,
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


/** Org switcher (multi-org members only, 2026-09-02): re-pins this session's
 *  active org server-side and reloads. Single-org users never see it. */
function OrgSwitch() {
  const [orgs, setOrgs] = useState<Array<{ orgId: string; orgName: string; active: boolean }>>([]);
  useEffect(() => {
    const m = (window as unknown as { glyphhSdk?: { memberships?: { orgs?: () => Promise<Array<{ orgId: string; orgName: string; active: boolean }>> } } }).glyphhSdk?.memberships;
    m?.orgs?.().then((l) => setOrgs(l || [])).catch(() => { /* signed out — no switcher */ });
  }, []);
  if (orgs.length < 2) return null;
  return (
    <select
      className="m-org-switch"
      value={orgs.find((o) => o.active)?.orgId}
      onChange={(e) => {
        const m = (window as unknown as { glyphhSdk?: { memberships?: { setActiveOrg?: (id: string) => Promise<unknown> } } }).glyphhSdk?.memberships;
        m?.setActiveOrg?.(e.target.value).then(() => location.reload()).catch(() => { /* stays put on failure */ });
      }}
    >
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.orgName}</option>)}
    </select>
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
  const [s, setS] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let on = true;
    glyphh().billing.status().then((v: Record<string, unknown>) => { if (on) setS(v); }).catch(() => { if (on) setS({}); });
    return () => { on = false; };
  }, []);
  const portal = async () => { try { const r = await glyphh().billing.portal(); const url = (r as { url?: string })?.url || (r as unknown as string); if (url) window.open(url, '_blank', 'noopener'); } catch { /* */ } };
  if (!s) return <div className="m-set-loading">Loading…</div>;
  const tierRaw = (s.tier as string) || '';
  const tier = tierRaw ? tierRaw.charAt(0).toUpperCase() + tierRaw.slice(1) : '—';
  const licensed = s.billingStatus === 'active' || s.billingStatus === 'past_due';
  return (
    <>
      <div className="m-bill-plan">
        <div className="m-bill-tier">{tier}</div>
        <div className="m-bill-seats">{String(s.seats ?? '—')}/{String(s.maxSeats ?? '—')} seats · {licensed ? 'licensed' : 'no active license'}</div>
      </div>
      <div className="m-field-note">Your subscription is the Glyphh license — it activates the desktop app for everyone in your organization.</div>
      <button className="m-field-btn" onClick={portal}>Manage billing &amp; payment</button>
    </>
  );
}

/** An iOS-style toggle switch. `ind` = indeterminate (knob centered). */
function Switch({ on, ind, onClick }: { on: boolean; ind?: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button className="m-switch" data-on={on ? 'true' : 'false'} data-ind={ind ? 'true' : 'false'}
      role="switch" aria-checked={on} onClick={onClick}>
      <span className="m-switch-knob" />
    </button>
  );
}

/** App-icon cache, resolved by slug the way the desktop does — search the catalog
 *  for the app whose id === slug and take its icon URL. */
const _connIcon: Record<string, string | null> = {};
async function resolveConnIcon(slug: string): Promise<string | null> {
  if (slug in _connIcon) return _connIcon[slug];
  try {
    const { apps } = await glyphh().connections.apps({ search: slug, limit: 8 });
    _connIcon[slug] = (apps.find((a: { id: string; icon?: string | null }) => a.id === slug)?.icon) || null;
  } catch { _connIcon[slug] = null; }
  return _connIcon[slug];
}

/** Artifacts — the caller's saved files (same store the desktop gallery
    reads: glyphh().files). Tapping one fetches its short-lived downloadUrl
    (files.get) and opens it in a new tab — the browser's own viewers render
    pdf/images/text, exactly what the desktop viewers read from. */

function HelpTray() {
  type Msg = { id: string; authorKind: 'user' | 'admin'; body: string; createdAt: string };
  type Ticket = { id: string; subject: string; status: string; updatedAt: string; lastMessage?: Msg | null; unread?: boolean };
  type Thread = Ticket & { messages: Msg[] };
  const [view, setView] = useState<'list' | 'new' | 'thread'>('list');
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [subject, setSubject] = useState('');
  const [msg, setMsg] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const refresh = async () => { try { setTickets(await glyphh().support.tickets()); } catch { setTickets([]); } };
  useEffect(() => { void refresh(); }, []);

  const openThread = async (id: string) => {
    haptic(); setErr(''); setThread(null); setView('thread');
    try {
      const t = await glyphh().support.thread(id) as Thread;
      setThread(t);
      void glyphh().support.markTicketRead(id).then(() => void refresh()).catch(() => {});
    } catch { setErr('Could not load this request.'); }
  };
  const submitNew = async () => {
    const s = subject.trim(), m = msg.trim();
    if (!s || !m) return;
    setBusy(true); setErr('');
    try {
      const t = await glyphh().support.createTicket({ subject: s, message: m }) as Thread;
      setSubject(''); setMsg(''); await refresh(); setThread(t); setView('thread');
    } catch { setErr('Could not submit. Try again.'); } finally { setBusy(false); }
  };
  const sendReply = async () => {
    if (!thread) return;
    const b = reply.trim(); if (!b) return;
    setBusy(true); setErr('');
    try { const t = await glyphh().support.reply(thread.id, b) as Thread; setThread(t); setReply(''); }
    catch { setErr('Could not send.'); } finally { setBusy(false); }
  };

  if (view === 'new') {
    return (
      <>
        <button className="m-conn-back" onClick={() => { haptic(); setView('list'); setErr(''); }}><Icon name="back" /><span>Help &amp; Support</span></button>
        <div className="m-set-form">
          <label className="m-field"><span className="m-field-l">Subject</span>
            <input className="m-field-in" value={subject} onChange={(e) => setSubject(e.currentTarget.value)} placeholder="What do you need help with?" /></label>
          <label className="m-field"><span className="m-field-l">Message</span>
            <textarea className="m-field-in m-field-area" value={msg} onChange={(e) => setMsg(e.currentTarget.value)} placeholder="Describe the issue…" rows={6} /></label>
        </div>
        <button className="m-login-primary m-help-submit" disabled={busy || !subject.trim() || !msg.trim()} onClick={submitNew}>{busy ? 'Sending…' : 'Submit request'}</button>
        {err && <div className="m-field-err">{err}</div>}
      </>
    );
  }
  if (view === 'thread') {
    return (
      <div className="m-help-thread">
        <button className="m-conn-back" onClick={() => { haptic(); setView('list'); setThread(null); }}><Icon name="back" /><span>Help &amp; Support</span></button>
        {!thread ? <div className="m-set-loading">Loading…</div> : (
          <>
            <div className="m-help-thread-head">
              <div className="m-help-thread-subject">{thread.subject}</div>
              <span className="m-help-status" data-s={thread.status}>{thread.status}</span>
            </div>
            <div className="m-help-msgs">
              {thread.messages.map((m) => (
                <div key={m.id} className={`m-msg ${m.authorKind === 'user' ? 'm-msg-user' : 'm-msg-glyphh'}`}>{m.body}</div>
              ))}
            </div>
            <div className="m-help-reply">
              <input className="m-field-in" value={reply} onChange={(e) => setReply(e.currentTarget.value)} placeholder="Reply…" onKeyDown={(e) => { if (e.key === 'Enter') void sendReply(); }} />
              <button className="m-help-send" aria-label="Send" disabled={busy || !reply.trim()} onClick={sendReply}><Icon name="send" /></button>
            </div>
            {err && <div className="m-field-err">{err}</div>}
          </>
        )}
      </div>
    );
  }
  return (
    <>
      <a className="m-field-btn m-help-docs" href={LEGAL.help} target="_blank" rel="noopener noreferrer"><Icon name="external" /><span>Browse the docs</span></a>
      <div className="m-set-label">Your requests</div>
      {tickets == null ? <div className="m-set-loading">Loading…</div>
        : tickets.length === 0 ? <div className="m-conn-empty">No requests yet. Open one and we’ll get back to you.</div>
        : (
          <div className="m-sel-group">
            {tickets.map((t) => (
              <button key={t.id} className="m-opt" onClick={() => openThread(t.id)}>
                <span className="m-opt-text">
                  <span className="m-opt-name">{t.subject}{t.unread && <span className="m-help-dot" />}</span>
                  {t.lastMessage && <span className="m-opt-desc">{t.lastMessage.body}</span>}
                </span>
                <span className="m-help-status" data-s={t.status}>{t.status}</span>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
        )}
      <button className="m-field-btn" onClick={() => { haptic(); setView('new'); setErr(''); }}>+ New request</button>
      {err && <div className="m-field-err">{err}</div>}
    </>
  );
}


function Confirm({ title, message, confirmLabel, onCancel, onConfirm }: { title: string; message: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  return createPortal(
    <div className="m-confirm-overlay" style={{ position: 'fixed' }} role="dialog" aria-modal="true">
      <div className="m-confirm-scrim" onClick={onCancel} />
      <div className="m-confirm">
        <div className="m-confirm-title">{title}</div>
        <div className="m-confirm-msg">{message}</div>
        <div className="m-confirm-actions">
          <button className="m-confirm-btn" onClick={onCancel}>Cancel</button>
          <button className="m-confirm-btn m-confirm-danger" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>, document.body);
}

/* Rename a chat: a single-field modal (no native prompt), mirroring Confirm. */

function OrganizationTray() {
  const [org, setOrg] = useState<Record<string, unknown> | null>(null);
  const [addr, setAddr] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const flash = () => { setSaved(true); setTimeout(() => setSaved(false), 1300); };
  useEffect(() => {
    glyphh().org.get().then((o: Record<string, unknown>) => { setOrg(o); setAddr((o.address as Record<string, string>) || {}); }).catch(() => setErr('Could not load your organization.'));
  }, []);
  const save = (patch: Record<string, unknown>) => { glyphh().org.update(patch).then((o: Record<string, unknown>) => { setOrg(o); flash(); }).catch(() => setErr('Could not save.')); };
  const saveAddr = () => save({ address: (addr.line1 || addr.city || addr.postalCode) ? addr : null });
  const af = (k: string, ph: string) => (
    <input className="m-field-in" value={addr[k] || ''} placeholder={ph} onChange={(e) => setAddr({ ...addr, [k]: e.currentTarget.value })} onBlur={saveAddr} />
  );
  if (!org) return err ? <div className="m-field-err">{err}</div> : <div className="m-set-loading">Loading…</div>;
  return (
    <>
      <div className="m-set-label">Organization {saved && <span className="m-saved">Saved</span>}</div>
      <div className="m-set-form">
        <label className="m-field"><span className="m-field-l">Name</span>
          <input className="m-field-in" defaultValue={org.name as string} onBlur={(e) => save({ name: e.currentTarget.value.trim() })} /></label>
      </div>
      <div className="m-bill-cards">
        <div className="m-bill-card"><span className="m-bill-v">{String(org.seatsUsed ?? '—')}/{String(org.maxSeats ?? '—')}</span><span className="m-bill-l">Seats</span></div>
        <div className="m-bill-card"><span className="m-bill-v">{cap(String(org.tier || '—'))}</span><span className="m-bill-l">Plan</span></div>
      </div>
      <div className="m-set-label">Address</div>
      <div className="m-set-form">
        {af('line1', 'Address line 1')}
        {af('line2', 'Line 2 (optional)')}
        {af('city', 'City')}
        {af('state', 'State / province')}
        {af('postalCode', 'Postal code')}
        {af('country', 'Country')}
      </div>
      {err && <div className="m-field-err">{err}</div>}
    </>
  );
}


function MembersTray() {
  type Member = { userId: string; email: string; name: string | null; role: string };
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('user');
  const [invite, setInvite] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<Member | null>(null);
  const [err, setErr] = useState('');
  const refresh = () => glyphh().members.list().then((m: Member[]) => setMembers(m)).catch(() => setMembers([]));
  useEffect(() => { refresh(); }, []);
  const doInvite = async () => {
    const e = email.trim(); if (!e) return;
    setBusy(true); setErr('');
    try { const r = await glyphh().members.invite(e, role); setInvite(r.acceptUrl || null); setEmail(''); refresh(); }
    catch { setErr('Could not send the invite.'); } finally { setBusy(false); }
  };
  const setMemberRole = (m: Member, r: string) => { void glyphh().members.setRole(m.userId, r).then(() => void refresh()).catch(() => setErr('Could not update role.')); };
  const remove = async (m: Member) => { setDel(null); try { await glyphh().members.remove(m.userId); refresh(); } catch { setErr('Could not remove.'); } };
  const isAdminRole = (r: string) => r === 'org_admin' || r === 'super_admin';
  return (
    <>
      <div className="m-set-label">Invite a teammate</div>
      <div className="m-set-form">
        <input className="m-field-in" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} placeholder="teammate@work.com" />
        <select className="m-field-in" value={role} onChange={(e) => setRole(e.currentTarget.value)}><option value="user">User</option><option value="admin">Admin</option></select>
        <button className="m-login-primary" disabled={busy || !email.trim()} onClick={doInvite}>{busy ? 'Inviting…' : 'Send invite'}</button>
      </div>
      {invite && <div className="m-key-new"><div className="m-key-new-t">Invite link — share it:</div><code className="m-key-token">{invite}</code></div>}
      <div className="m-set-label">Members</div>
      {members == null ? <div className="m-set-loading">Loading…</div>
        : (
          <div className="m-sel-group">
            {members.map((m) => (
              <div key={m.userId} className="m-opt">
                <span className="m-opt-text"><span className="m-opt-name">{m.name || m.email}</span><span className="m-opt-desc">{m.email}</span></span>
                {isAdminRole(m.role) ? <span className="m-chip">Owner</span> : (
                  <>
                    <select className="m-member-role" value={m.role} onChange={(e) => setMemberRole(m, e.currentTarget.value)}><option value="user">User</option><option value="admin">Admin</option></select>
                    <button className="m-key-revoke" onClick={() => setDel(m)}>Remove</button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      {err && <div className="m-field-err">{err}</div>}
      {del && <Confirm title={`Remove ${del.name || del.email}?`} message="They lose access to the workspace immediately." confirmLabel="Remove" onCancel={() => setDel(null)} onConfirm={() => remove(del)} />}
    </>
  );
}


function AppearanceTray() {
  const [theme, setTheme] = useState(currentTheme);
  const pick = (t: string) => { haptic(); setTheme(t); applyTheme(t); };
  const sysResolved = (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  // Escape hatch to the FULL desktop site (iPad + tablets). `/m` is a SEPARATE
  // bundle from the desktop shell — a CSS breakpoint can't switch it — so this
  // sets a persistent flag that tells the shell's touch-redirect (serve.mjs) to
  // stand down, then loads `/`. Only shown at tablet width so a phone can't
  // strand itself in a layout it can't use. Return path: visit the /m address.
  const tablet = typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
  const [desktopSite, setDesktopSite] = useState(() => { try { return localStorage.getItem('glyphh_force_desktop') === '1'; } catch { return false; } });
  const toggleDesktopSite = () => {
    haptic();
    const next = !desktopSite;
    setDesktopSite(next);
    try {
      if (next) { localStorage.setItem('glyphh_force_desktop', '1'); location.href = '/'; }
      else { localStorage.removeItem('glyphh_force_desktop'); }
    } catch { /* private mode — the toggle just no-ops */ }
  };
  return (
    <>
      <div className="m-sel-group">
        {THEMES.map((o) => (
          <button key={o.id} className="m-opt" onClick={() => pick(o.id)}>
            <span className="m-theme-sw" data-theme={o.id === 'system' ? sysResolved : o.id} aria-hidden="true" />
            <span className="m-opt-text"><span className="m-opt-name">{o.name}</span>{o.desc && <span className="m-opt-desc">{o.desc}</span>}</span>
            {theme === o.id && <span className="m-opt-tick"><Icon name="tick" /></span>}
          </button>
        ))}
      </div>
      {tablet && (
        <>
          <div className="m-set-label">Layout</div>
          <div className="m-sel-group">
            <div className="m-sel-row">
              <span className="m-opt-text"><span className="m-opt-name">Desktop site</span><span className="m-opt-desc">Use the full desktop layout on this iPad — return via the /m address.</span></span>
              <Switch on={desktopSite} onClick={toggleDesktopSite} />
            </div>
          </div>
        </>
      )}
    </>
  );
}


/* ── Platform admin (super_admin only): Plans + Orgs — the desktop Platform
   settings section, ported to mobile trays over /api/admin/*. ── */
type AdminApi = {
  plans: () => Promise<{ plans: Array<{ tier: string; display_name: string; monthly_usd_cents: number; included_credits: number; max_seats: number; active: boolean; org_id: string | null; org_name: string | null }> }>;
  orgs: (q?: { q?: string; limit?: number }) => Promise<{ orgs: Array<{ id: string; name: string; tier: string; billing_status: string; member_count: number }>; total: number }>;
  org: (id: string) => Promise<{ id: string; name: string; tier: string; billing_status: string; member_count: number; max_seats: number; members: Array<{ email: string; name: string | null; role: string }> }>;
  updateOrg: (id: string, patch: { tier?: string }) => Promise<unknown>;
};
const adminApi = (): AdminApi => (glyphh() as unknown as { admin: AdminApi }).admin;

function PlatformPlansTray() {
  const [plans, setPlans] = useState<Array<{ tier: string; display_name: string; monthly_usd_cents: number; included_credits: number; active: boolean; org_id: string | null; org_name: string | null }> | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let on = true;
    adminApi().plans().then((r) => { if (on) setPlans(r.plans); }).catch(() => { if (on) { setPlans([]); setErr('Could not load plans.'); } });
    return () => { on = false; };
  }, []);
  if (!plans) return err ? <div className="m-field-err">{err}</div> : <div className="m-set-loading">Loading…</div>;
  const money = (c: number): string => (c ? '$' + (c % 100 ? (c / 100).toFixed(2) : String(c / 100)) + '/seat' : 'Free');
  const global = plans.filter((p) => !p.org_id);
  const bespoke = plans.filter((p) => p.org_id);
  const row = (p: typeof plans[number]) => (
    <div key={p.tier + (p.org_id || '')} className="m-sel-row">
      <span className="m-sel-row-label">{p.display_name}{p.active ? '' : ' · inactive'}{p.org_name ? ' · ' + p.org_name : ''}</span>
      <span className="m-sel-row-val">{money(p.monthly_usd_cents)} · {wholeCredits(p.included_credits)} cr</span>
    </div>
  );
  return (
    <>
      <div className="m-set-label">Plans</div>
      <div className="m-sel-group">{global.map(row)}</div>
      {bespoke.length > 0 && (
        <>
          <div className="m-set-label">Bespoke (per-org)</div>
          <div className="m-sel-group">{bespoke.map(row)}</div>
        </>
      )}
      {err && <div className="m-field-err">{err}</div>}
    </>
  );
}


function PlatformOrgDetail({ id, onBack }: { id: string; onBack: () => void }) {
  type Detail = { name: string; tier: string; billing_status: string; member_count: number; max_seats: number; members: Array<{ email: string; name: string | null; role: string }> };
  const [d, setD] = useState<Detail | null>(null);
  const [tiers, setTiers] = useState<string[]>([]);
  const [saved, setSaved] = useState('');
  const [err, setErr] = useState('');
  const flash = (m: string) => { setSaved(m); setTimeout(() => setSaved(''), 1300); };
  const load = () => adminApi().org(id).then((o) => setD(o as Detail)).catch(() => setErr('Could not load this organization.'));
  useEffect(() => { load(); adminApi().plans().then((r) => setTiers(r.plans.filter((p) => !p.org_id).map((p) => p.tier))).catch(() => { /* selector falls back to current */ }); }, [id]);
  const setTier = (tier: string) => { setErr(''); adminApi().updateOrg(id, { tier }).then(() => { flash('Plan updated'); load(); }).catch(() => setErr('Could not update the plan.')); };
  if (!d) return err ? <div className="m-field-err">{err}</div> : <div className="m-set-loading">Loading…</div>;
  const options = tiers.length ? tiers : [d.tier];
  return (
    <>
      <button className="m-field-btn" onClick={() => { haptic(); onBack(); }}>← All organizations</button>
      <div className="m-set-label">{d.name} {saved && <span className="m-saved">{saved}</span>}</div>
      <div className="m-bill-cards">
        <div className="m-bill-card"><span className="m-bill-v">{d.member_count}/{d.max_seats || '—'}</span><span className="m-bill-l">Seats</span></div>
        <div className="m-bill-card"><span className="m-bill-v">{cap(d.billing_status)}</span><span className="m-bill-l">License</span></div>
      </div>
      <div className="m-set-label">Plan</div>
      <div className="m-sel-group">
        {options.map((t) => (
          <button key={t} className="m-sel-row" onClick={() => setTier(t)}>
            <span className="m-sel-row-label">{cap(t)}</span>
            {d.tier === t && <Icon name="check" />}
          </button>
        ))}
      </div>
      <div className="m-set-label">Members</div>
      <div className="m-sel-group">
        {d.members.map((m) => (
          <div key={m.email} className="m-sel-row"><span className="m-sel-row-label">{m.name || m.email}</span><span className="m-sel-row-val">{cap(m.role)}</span></div>
        ))}
      </div>
      {err && <div className="m-field-err">{err}</div>}
    </>
  );
}

function PlatformOrgsTray() {
  type Row = { id: string; name: string; tier: string; member_count: number };
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const search = (term: string) => { adminApi().orgs({ q: term, limit: 30 }).then((r) => setRows(r.orgs)).catch(() => { setRows([]); setErr('Could not load organizations.'); }); };
  useEffect(() => { const t = setTimeout(() => search(q.trim()), q ? 260 : 0); return () => clearTimeout(t); }, [q]);
  if (sel) return <PlatformOrgDetail id={sel} onBack={() => { setSel(null); search(q.trim()); }} />;
  return (
    <>
      <div className="m-sel-search"><Icon name="search" /><input className="m-conn-in" placeholder="Search organizations" value={q} onChange={(e) => setQ(e.currentTarget.value)} /></div>
      {!rows ? <div className="m-set-loading">Loading…</div> : !rows.length ? <div className="m-conn-empty">No organizations found.</div> : (
        <div className="m-sel-group">
          {rows.map((o) => (
            <button key={o.id} className="m-set-row" onClick={() => { haptic(); setSel(o.id); }}>
              <span className="m-set-name">{o.name}</span>
              <span className="m-set-val">{cap(o.tier || '—')} · {o.member_count} {o.member_count === 1 ? 'member' : 'members'}</span>
              <Icon name="chevron" />
            </button>
          ))}
        </div>
      )}
      {err && <div className="m-field-err">{err}</div>}
    </>
  );
}


type SettingsSub = 'profile' | 'billing' | 'appearance' | 'help' | 'org' | 'members'
  | 'padmin-plans' | 'padmin-orgs';
const SUB_TITLE: Record<SettingsSub, string> = {
  profile: 'Profile', billing: 'Billing', appearance: 'Appearance', help: 'Help & Support',
  org: 'Organization', members: 'Members',
  'padmin-plans': 'Plans', 'padmin-orgs': 'Organizations',
};

/** The settings surface — on the minimal platform this IS the app: rendered
 *  full-page once signed in (no sheet rise, no close). */
function SettingsPage({ user, onSignOut, onUserChanged }: { user: DisplayUser; onSignOut: () => void; onUserChanged: () => void }) {
  const [sub, setSub] = useState<SettingsSub>('profile');
  const [subOpen, setSubOpen] = useState(false);
  const [info, setInfo] = useState(false);
  const openSub = (s: SettingsSub) => { haptic(); setSub(s); setSubOpen(true); };
  const isSuper = user.isPlatformAdmin === true || user.role === 'super_admin';
  const isAdmin = user.role === 'org_admin' || isSuper;
  const title = SUB_TITLE[sub];

  const legalRow = (href: string, label: string) => (
    <a className="m-info-row" href={href} target="_blank" rel="noopener noreferrer" onClick={() => setInfo(false)}>
      <Icon name="external" /><span>{label}</span>
    </a>
  );

  return (
    <div className="m-sheet-overlay" data-open="true">
      <div className="m-sheet m-sheet-page" role="main" aria-label="Glyphh platform">
        <div className="m-sheet-track" data-open={subOpen ? 'true' : 'false'} data-snap="false">
          <section className="m-sheet-panel">
            <header className="m-sheet-head">
              <span className="m-sheet-btn" aria-hidden="true" style={{ visibility: 'hidden' }} />
              <span className="m-sheet-title">Glyphh</span>
              <button className="m-sheet-btn m-sheet-info" aria-label="About" onClick={() => { haptic(); setInfo((v) => !v); }}><Icon name="info" /></button>
            </header>
            <div className="m-sheet-scroll">
              <div className="m-set-email">{user.email}</div>
              <OrgSwitch />
              {SETTINGS_GROUPS.map((g) => {
                const rows = g.rows.filter((r) => (!r.admin || isAdmin) && (!r.super || isSuper));
                if (!rows.length) return null;
                return (
                  <div key={g.label} className="m-set-section">
                    <div className="m-set-label">{g.label}</div>
                    <div className="m-set-group">
                      {rows.map((r) => (
                        <button key={r.label} className="m-set-row" onClick={() => openSub(r.sub as SettingsSub)}>
                          <span className="m-set-ico"><Icon name={r.icon as IconName} /></span>
                          <span className="m-set-name">{r.label}</span>
                          <Icon name="chevron" />
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
              <button className="m-profile-signout" onClick={() => { haptic(); onSignOut(); }}>Sign out</button>
            </div>
          </section>

          <section className="m-sheet-panel">
            <header className="m-sheet-head">
              <button className="m-sheet-btn" aria-label="Back" onClick={() => { haptic(); setSubOpen(false); }}><Icon name="back" /></button>
              <span className="m-sheet-title">{title}</span>
              <span className="m-sheet-btn" aria-hidden="true" style={{ visibility: 'hidden' }} />
            </header>
            <div className="m-sheet-scroll">
              {sub === 'profile' && <ProfileTray user={user} onUpdated={onUserChanged} />}
              {sub === 'billing' && <BillingTray />}
              {sub === 'org' && <OrganizationTray />}
              {sub === 'members' && <MembersTray />}
              {sub === 'appearance' && <AppearanceTray />}
              {sub === 'padmin-plans' && <PlatformPlansTray />}
              {sub === 'padmin-orgs' && <PlatformOrgsTray />}
              {sub === 'help' && <HelpTray />}
            </div>
          </section>
        </div>

        {info && (
          <>
            <div className="m-info-scrim" onClick={() => setInfo(false)} />
            <div className="m-info-menu" role="menu">
              <div className="m-info-ver">Glyphh{APP_VERSION ? ` v${APP_VERSION}` : ''}</div>
              <div className="m-info-sep" />
              {legalRow(LEGAL.terms, 'Terms of Service')}
              {legalRow(LEGAL.privacy, 'Privacy Policy')}
              {legalRow(LEGAL.refund, 'Refund Policy')}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* Google's four-colour "G" mark — same paths as web-login.js googleG() (which
   matches platform's GoogleG), so the face reads identical to the regular login. */
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}


function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gBusy, setGBusy] = useState(false);  // Google exchange in flight — face shows "Connecting…"
  const [gDead, setGDead] = useState(false);  // GIS failed to load — drop the affordance (web-login fallback)
  const [err, setErr] = useState('');
  const [devUrl, setDevUrl] = useState('');   // dev servers w/o an emailer return the link
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
          try { setGBusy(true); setBusy(true); setErr(''); await signInWithGoogle(resp.credential); await syncGating(); onSignedIn(); }
          catch { setErr('Google sign-in failed. Try the magic link.'); setBusy(false); setGBusy(false); }
        },
      });
      // The real GIS button is the click target but sits INVISIBLE under our own
      // face (web-login.js renderGoogleButton pattern) — size it to the wrapper.
      g.accounts.id.renderButton(gRef.current, {
        type: 'standard', theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with',
        logo_alignment: 'center', width: Math.round(gRef.current.getBoundingClientRect().width) || 320,
      });
    };
    if ((window as unknown as { google?: any }).google?.accounts?.id) { mount(); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true; s.onload = mount;
    // GIS unreachable → drop the Google face (dead button otherwise), keep magic-link.
    s.onerror = () => { if (!cancelled) setGDead(true); };
    document.head.appendChild(s);
    return () => { cancelled = true; };
    // `sent` is a dep because leaving the sent state REMOUNTS the GIS container —
    // Google's button must be rendered into the fresh node or the face sits dead.
  }, [clientId, onSignedIn, sent]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) return;
    try {
      setBusy(true); setErr('');
      // A dev server with no emailer configured returns { sent:false, devUrl } —
      // surface it so local sign-in is self-service (no inbox, no console).
      const r = await startEmailLink(addr, window.location.origin + '/m') as { sent?: boolean; devUrl?: string } | undefined;
      setDevUrl(r && r.sent === false && r.devUrl ? r.devUrl : '');
      setSent(true);
    } catch { setErr('Could not send the link. Check the address and try again.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="m-login">
      <SplashFlow />
      {/* The wordmark rides the top-left like the regular login's .auth-shell-header. */}
      <header className="m-login-brand">
        <img className="m-login-logo" src="/brand/glyphh-logo-white.png" alt="Glyphh" />
      </header>
      <div className="m-login-card">
        {sent ? (
          <div className="m-login-sent">
            {devUrl ? (
              <>
                <div className="m-login-title">Dev sign-in</div>
                <p className="m-login-sub">This server has no emailer, so use the dev link for <b>{email}</b> (local only).</p>
                <a className="m-login-primary m-login-devlink" href={devUrl}>Continue as {email}</a>
              </>
            ) : (
              <>
                <div className="m-login-title">Check your email</div>
                <p className="m-login-sub">We sent a sign-in link to <b>{email}</b>. Open it on this device to continue.</p>
              </>
            )}
            <button className="m-login-alt" onClick={() => { haptic(); setSent(false); setDevUrl(''); }}>Use a different email</button>
          </div>
        ) : (
          <>
            <div className="m-login-title">Question Everything.</div>
            <div className="m-login-tagline">Every dream starts with a dreamer.</div>
            {clientId && !gDead && (
              /* Web-login's google-btn pattern: the real GIS button (click target)
                 sits under our own face, overlaid pointer-events:none — the user
                 sees the app's button, Google's captures the tap. */
              <div className="m-login-google">
                <div className="m-login-google-gis" ref={gRef} />
                <span className="m-login-google-face" aria-hidden="true">
                  <GoogleG />
                  <span>{gBusy ? 'Connecting…' : 'Continue with Google'}</span>
                </span>
              </div>
            )}
            {clientId && !gDead && <div className="m-login-or"><span>or</span></div>}
            <form className="m-login-form" onSubmit={submit}>
              <div className="m-login-field">
                <label className="m-login-label" htmlFor="m-login-email">Email</label>
                <input id="m-login-email" className="m-login-input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none"
                  placeholder="you@example.com" value={email} onChange={(e) => setEmail((e.target as HTMLInputElement).value)} />
              </div>
              <button className="m-login-primary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Continue with email'}</button>
            </form>
            {err && <div className="m-login-err">{err}</div>}
          </>
        )}
        <div className="m-login-legal">
          By continuing, you acknowledge Glyphh&rsquo;s{' '}
          <a href={LEGAL.privacy} target="_blank" rel="noopener noreferrer">Privacy Policy</a> and agree to
          receive occasional promotional emails and notifications.
        </div>
      </div>
    </div>
  );
}

/** A directory on the attached machine (from attach.fsList over the relay). */
interface FsEntry { name: string; path: string; dir: boolean; git?: boolean }
interface FsListing { path: string; parent: string | null; entries: FsEntry[] }

/* "Choose directory" — a bottom tray (slides up like the model selector) that
   browses the attached machine's folders over the relay (attach.fsList) and lets
   the user pick one or create a new folder under the current one, then start the
   session there. */

function App() {
  const [authState, setAuthState] = useState<'checking' | 'in' | 'out'>('checking');
  const [user, setUser] = useState<DisplayUser>(() => toDisplayUser(cachedUser()));
  const [minSplash, setMinSplash] = useState(false);

  useEffect(() => {
    applyTheme(currentTheme());
    syncThemeColor();
    const t = setTimeout(() => setMinSplash(true), 900);
    return () => clearTimeout(t);
  }, []);

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
  const onSignOut = () => { void sdkSignOut(); };  // signed-out event flips to 'out'
  const refreshUser = () => { void syncGating().then((u) => setUser(toDisplayUser(u))); };

  if (authState === 'checking' || !minSplash) {
    return (
      <div className="m-splash">
        <SplashFlow />
        <img className="m-splash-logo m-splash-logo-black" src="/brand/glyphh-logo-black.png" alt="Glyphh" />
        <img className="m-splash-logo m-splash-logo-white" src="/brand/glyphh-logo-white.png" alt="" />
      </div>
    );
  }
  if (authState === 'out') return <Login onSignedIn={onSignedIn} />;
  return <SettingsPage user={user} onSignOut={onSignOut} onUserChanged={refreshUser} />;
}

const el = document.getElementById('glyphh-mobile-root');
if (el) createRoot(el).render(<App />);

installAutofillGuard();
