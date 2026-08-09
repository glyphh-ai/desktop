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
import { createPortal } from 'react-dom';
import { useState, useEffect, useRef } from 'react';
import { NAV, GHOST_QUOTES, SETTINGS_GROUPS,
  type SpaceId, type Recent, type Message } from './mock';
// Real auth + client — the same SDK wiring app-web uses (localStorage token store,
// gating cookies, refresh, signed-out event). We reuse it; we don't fork the client.
import {
  glyphh, syncGating, isAuthenticated, signInWithGoogle, startEmailLink,
  verifyEmailLink, exchangeCode, signOut as sdkSignOut, cachedUser,
} from './glyphh-web.js';
// Reuse the desktop's remote-turn engine verbatim (it's web-safe — only a type
// import). It reads the SDK off window.glyphhSdk (desktop shape) and drives the
// exact provision → poll-ready → harness.start streaming path. The renderer-only
// LOCAL path lives in code.ts, not here, so nothing desktop-specific is pulled in.
import { runRemoteTurn, ensureRuntime, answerPending,
  type RemoteChat, type RemotePermission, type RemoteApprovalRequest, type RemoteAskRequest } from '../../src/renderer/help/remote-run';
// The app's real working indicator — the tumbling wireframe cube + typed phrase.
// Pure DOM/Canvas, so we mount it verbatim (brand parity in the chat thread).
import { createGlyphhSpinner } from '../../src/renderer/glyphh-spinner';
// Real markdown + code blocks (copy/fold), tool-step group + diff badges. Own file
// (mobile.tsx is large); marked + dompurify are bundled — no CDN.
import { Markdown, copyText, ToolGroup, DiffBadge, type ToolStep } from './md';

// Point the reused engine at OUR authenticated client so provisioning + streaming
// share one session. (glyphh() is a lazily-built singleton — safe at module load.)
if (typeof window !== 'undefined') (window as unknown as { glyphhSdk?: unknown }).glyphhSdk = glyphh();

/** Per-thread runtime binding cache. "Committed" = the thread has a live runtime
 *  (url+token). Chats are cloud: the pod is provisioned once per thread, reused. */
const remoteChats = new Map<string, RemoteChat>();
function chatFor(id: string): RemoteChat {
  let c = remoteChats.get(id);
  if (!c) { c = { id, mode: 'chat' }; remoteChats.set(id, c); }
  return c;
}
function isCommitted(id: string): boolean {
  const r = remoteChats.get(id)?.runtime;
  return !!(r && r.url && r.token);
}

/* ── Honest runtime diagnostics (ported from app-web help/code.ts) — on a failed
   turn, name the STAGE + the exact control/runtime URLs + whether the runtime is
   reachable, so a 404 is a diagnosis, not a mystery. ─────────────────────────── */
async function probeRuntime(url?: string): Promise<string> {
  if (!url) return '';
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/healthz`, { signal: ctl.signal });
      return res.ok ? 'runtime IS reachable from this browser (so it is auth/capacity, not the network)' : `runtime answered ${res.status} on /healthz`;
    } finally { clearTimeout(t); }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return /abort/i.test(msg) ? 'runtime did not answer within 4s (down or blocked)' : `this browser could not reach the runtime (${msg}) — a blocked cross-origin request or nothing listening`;
  }
}
function unavailMessage(stage: string, detail: string, runtimeUrl?: string, probe?: string): string {
  const why =
    stage === 'provision' || stage === 'provision-poll' ? "the cloud runtime couldn't be provisioned"
    : stage === 'not-ready' ? "the cloud runtime didn't come up in time"
    : stage === 'open' || stage === 'stream' ? 'the cloud runtime is unreachable from here'
    : 'the cloud runtime isn’t connected';
  const server = typeof window !== 'undefined' ? (window as unknown as { __GLYPHH_API_URL__?: string }).__GLYPHH_API_URL__ || '' : '';
  const where = [server && `control plane ${server}`, runtimeUrl && `runtime ${runtimeUrl}`].filter(Boolean).join(' · ');
  return `⚠️ Cloud runtime not connected — ${why} (at ${stage}).${where ? ` ${where}.` : ''}${probe ? ` Diagnosis: ${probe}.` : ''} (${detail})`;
}

/** Micro-credits (1 credit = 1e6) → a rounded whole-credit string. */
function credits(v: number | null | undefined): string {
  return v == null ? '—' : Math.round(v / 1e6).toLocaleString();
}
/** Values ALREADY in whole credits (e.g. /api/usage/mine, which converts server-side). */
function wholeCredits(v: number | null | undefined): string {
  return v == null ? '—' : Math.round(Number(v)).toLocaleString();
}

/** Persist + apply the theme live (same contract as mobile.html's pre-paint). */
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

/* ── Runtimes — the cloud runtime a session runs on. Selectable like models;
   NAM (shared) for now, upgraded/dedicated later. All orgs default to NAM. ── */
const RUNTIMES: { id: string; name: string; desc: string }[] = [
  { id: 'nam', name: 'NAM', desc: 'Shared runtime · North America' },
];
function currentRuntime(): string { try { return localStorage.getItem('yoRuntime') || 'nam'; } catch { return 'nam'; } }
function setRuntimePref(id: string) { try { localStorage.setItem('yoRuntime', id); } catch { /* */ } }

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

/** Long-press (touch hold) → fire `cb` after `ms`, with haptic. No-op if cb is
 *  undefined. Cancels on move/end so a scroll never triggers it. */
function useLongPress(cb?: () => void, ms = 440) {
  const timer = useRef<number | null>(null);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const start = () => { if (!cb) return; clear(); timer.current = window.setTimeout(() => { haptic(); cb(); }, ms); };
  return {
    onTouchStart: start,
    onTouchEnd: clear,
    onTouchMove: clear,
    onTouchCancel: clear,
    onContextMenu: (e: { preventDefault: () => void }) => { if (cb) e.preventDefault(); },
  };
}

/* ── Loops / models / permissions — real SDK data (glyphh().loops, .models).
   A loop declares role slots (Planner/Builder/…); each role carries its allowed
   model `choices` and the currently-resolved `modelId`. ────────────────────── */
interface LoopItem { id: string; slug: string; name: string; description?: string; builtIn?: boolean; }
interface ModelChoice { id: string; name: string; providerSlug?: string; }
interface RoleItem { name: string; label?: string; description?: string; modelId: string | null; choices: ModelChoice[]; }
const MODEL_TOP_N = 5;
/** Agent permission modes = the SDK's HarnessPermission set (the value sent per run). */
const PERMS: { id: string; name: string; desc: string }[] = [
  { id: 'ask',         name: 'Ask every time', desc: 'Approve each tool before it runs' },
  { id: 'plan',        name: 'Plan mode',      desc: 'Read-only — draft a plan, pause on edits' },
  { id: 'acceptEdits', name: 'Accept edits',   desc: 'Auto-approve edits; pause on risky actions' },
  { id: 'auto',        name: 'Auto',           desc: 'Run unattended; pause only on dangerous actions' },
  { id: 'bypass',      name: 'Full access',    desc: 'Run everything without asking' },
];
/** A model id may be provider-qualified ("anthropic::claude-opus-4-8"); show the tail. */
function shortModelId(id: string): string { const i = id.indexOf('::'); return i >= 0 ? id.slice(i + 2) : id; }
/** Default loop: the built-in 'default', else any built-in, else the first. */
function defaultLoopSlug(loops: LoopItem[]): string {
  return loops.find((l) => l.slug === 'default')?.slug ?? loops.find((l) => l.builtIn)?.slug ?? loops[0]?.slug ?? '';
}

/* ── Sessions (chat threads) — real SDK data (glyphh().sessions.threads()).
   One thread = one chat; its `mode` buckets it into Chat / Work / Code. ────── */
interface ThreadMeta { id: string; title: string; mode: string; createdAt: number; updatedAt: number; messageCount: number; }
interface ThreadMsg { role: string; text?: string; [k: string]: unknown; }

/** Relative "when" label from an epoch-ms timestamp (now / 2h / Yesterday / Aug 1). */
function rel(ms: number): string {
  if (!ms) return '';
  const secs = Math.max(0, (Date.now() - ms) / 1000);
  if (secs < 45) return 'now';
  const mins = secs / 60; if (mins < 60) return `${Math.floor(mins)}m`;
  const hrs = mins / 60; if (hrs < 24) return `${Math.floor(hrs)}h`;
  const days = hrs / 24;
  if (days < 2) return 'Yesterday';
  if (days < 7) return `${Math.floor(days)}d`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
/** SDK thread → the Recent shape the list rows + rail render. */
function threadToRecent(t: ThreadMeta): Recent { return { id: t.id, title: t.title?.trim() || 'New chat', when: rel(t.updatedAt) }; }
/** Newest-first threads of one mode, mapped for the list. */
function threadsFor(threads: ThreadMeta[] | null, mode: string): Recent[] {
  return (threads ?? []).filter((t) => t.mode === mode).sort((a, b) => b.updatedAt - a.updatedAt).map(threadToRecent);
}
/** Threads of a mode bucketed by recency (Work/Code are time-grouped lists). */
interface TimeGroup { label: string; items: Recent[]; }
function groupThreadsByTime(threads: ThreadMeta[] | null, mode: string): TimeGroup[] {
  const list = (threads ?? []).filter((t) => t.mode === mode).sort((a, b) => b.updatedAt - a.updatedAt);
  const now = Date.now();
  const bucket = (ms: number): string => {
    const days = (now - ms) / 86400000;
    if (days < 1) return 'Today';
    if (days < 7) return 'This week';
    if (days < 31) return 'This month';
    return 'Earlier';
  };
  const order: string[] = [];
  const by: Record<string, Recent[]> = {};
  for (const t of list) { const l = bucket(t.updatedAt); if (!by[l]) { by[l] = []; order.push(l); } by[l].push(threadToRecent(t)); }
  return order.map((label) => ({ label, items: by[label] }));
}
/** A thread's messages → the session view's {role, text}. assistant → 'glyphh'. */
function normalizeMsg(m: ThreadMsg, i: number): Message {
  return { id: `m${i}`, role: m.role === 'user' ? 'user' : 'glyphh', text: typeof m.text === 'string' ? m.text : '' };
}

/* ── Left rail: brand → spaces → recents ──────────────────────────────────── */
function Rail({ active, onSelect, onOpenRecent, recents, onAllChats, onAccount, onNewChat, user }: {
  active: SpaceId;
  onSelect: (id: SpaceId) => void;
  onOpenRecent: (r: Recent) => void;
  recents: Recent[];
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
          {recents.map((r) => (
            <button key={r.id} className="m-recent" onClick={() => onOpenRecent(r)}>
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
function Composer({ draft, setDraft, onSend, onStop, sending, connecting, onPlus, onOpenSelector, permLabel, loopName, modelSummary, mode, onDictate, attachments, onRemoveAttachment, onPasteFiles }: CompProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Auto-grow up to a cap; the box scrolls internally beyond that.
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; } }, [draft]);
  const voice = useVoice(onDictate);
  const canSend = (!!draft.trim() || attachments.length > 0) && !sending && !connecting;
  const submit = () => { if (canSend) onSend(); };
  const onMic = () => {
    // Web Speech where available; otherwise focus the field so the keyboard's own
    // dictation mic is one tap away (iOS).
    if (!voice.toggle()) { ref.current?.focus(); }
  };
  const onPaste = (e: { clipboardData: DataTransfer | null; preventDefault: () => void }) => {
    const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (imgs.length) { e.preventDefault(); onPasteFiles(imgs); }
  };
  return (
    <div className="m-composer">
      <div className="m-composer-box">
        {attachments.length > 0 && (
          <div className="m-attach-strip">
            {attachments.map((a) => (
              <div key={a.id} className="m-attach-chip">
                <img src={a.url} alt={a.name} />
                <button className="m-attach-x" aria-label="Remove" onClick={() => onRemoveAttachment(a.id)}><Icon name="close" /></button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ref} className="m-composer-input" rows={1} disabled={connecting}
          placeholder={connecting ? 'Connecting…' : 'Message Glyphh…'}
          value={draft} onChange={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          onPaste={onPaste}
          autoComplete="off" autoCorrect="on" autoCapitalize="sentences" enterKeyHint="send" />
        <div className="m-composer-tools">
          <button className="m-tool-btn" aria-label="Add" onClick={onPlus}><Icon name="plus" /></button>
          {mode === 'chat'
            ? <button className="m-tool-pill m-pill-cfg" onClick={() => onOpenSelector('sections')}><Icon name="swap" /><span>{loopName} / {modelSummary}</span></button>
            : <>
                <button className="m-tool-pill m-pill-cfg" onClick={() => onOpenSelector('permission')}><Icon name="shield" /><span>{permLabel}</span></button>
                {/* Loop/model chip beside permission — shown on tablet (phone keeps
                    the top dropdown / dots menu for it). */}
                <button className="m-tool-pill m-pill-cfg m-pill-loopmodel" onClick={() => onOpenSelector('sections')}><Icon name="swap" /><span>{loopName} / {modelSummary}</span></button>
              </>}
          <span className="m-composer-spacer" />
          <button className={`m-tool-mic${voice.listening ? ' m-mic-live' : ''}`} aria-label="Voice" onClick={onMic}><Icon name="mic" /></button>
          {sending
            ? <button className="m-composer-send m-composer-stop" aria-label="Stop" onClick={() => onStop?.()}><span className="m-stop-sq" aria-hidden="true" /></button>
            : <button className="m-composer-send" aria-label="Send" disabled={!canSend} onClick={submit}><Icon name="send" /></button>}
        </div>
      </div>
    </div>
  );
}

/* ── Brand working spinner — mounts the app's createGlyphhSpinner (canvas cube +
   typed phrase) into React, self-destroys on unmount. ─────────────────────── */
function GlyphhSpinner({ size = 40, phrases = true }: { size?: number; phrases?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const s = createGlyphhSpinner({ size, phrases });
    host.appendChild(s.el);
    return () => s.destroy();
  }, [size, phrases]);
  return <span ref={ref} className="m-gs-host" />;
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
function ChatsView({ title, sessions, loading, onMenu, onOpen, onNewChat, onSearch }: {
  title: string;
  sessions: Recent[];
  loading: boolean;
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
        {loading
          ? <div className="m-list-note">Loading…</div>
          : sessions.length === 0
          ? <div className="m-list-note">No chats yet — start a new one.</div>
          : sessions.map((s) => (
            <button key={s.id} className="m-chat-row" onClick={() => onOpen(s)}>
              <span className="m-chat-text">
                <span className="m-chat-title">{s.title}</span>
                <span className="m-chat-when">{s.when}</span>
              </span>
              <Icon name="chevron" />
            </button>
          ))}
      </div>
      <button className="m-fab btn btn-primary btn-lg" onClick={onNewChat}><Icon name="plus" /><span>New chat</span></button>
      <button className="m-search" onClick={onSearch}><Icon name="search" /><span>Search</span></button>
    </div>
  );
}

/* ── Code: attached Desktops strip + a Sessions list that distinguishes a
   session's runtime — running on a connected desktop, on a now-unreachable
   desktop, or in the cloud. ──────────────────────────────────────────────── */
/** An attached desktop/machine, from glyphh().attach.status(). */
interface AttachedMachine { id?: string; app: string; version?: string; name?: string; capabilities?: string[]; since?: number }

function CodeView({ desktops, sessions, loading, onMenu, onOpen, onOpenDesktop, onNewSession, onSearch }: {
  desktops: AttachedMachine[];
  sessions: Recent[];
  loading: boolean;
  onMenu: () => void;
  onOpen: (s: Recent) => void;
  onOpenDesktop: (d: AttachedMachine) => void;
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
          {desktops.length === 0
            ? <div className="m-list-note">No desktops connected</div>
            : desktops.map((d) => (
              <button key={d.id || d.name || d.app} className="m-desktop" data-status="connected" onClick={() => onOpenDesktop(d)}>
                <span className="m-desktop-icon"><Icon name="laptop" /><i className="m-desktop-badge" /></span>
                <span className="m-desktop-name">{d.name || d.app}</span>
                <span className="m-desktop-status">Connected</span>
              </button>
            ))}
        </div>

        <div className="m-code-sessions-head">
          <span className="m-code-label">Sessions</span>
        </div>
        <div className="m-code-list">
          {loading
            ? <div className="m-list-note">Loading…</div>
            : sessions.length === 0
            ? <div className="m-list-note">No sessions yet — start one.</div>
            : sessions.map((s) => (
              <button key={s.id} className="m-code-card" onClick={() => onOpen(s)}>
                <span className="m-code-thumb" data-kind="plain" />
                <span className="m-code-body">
                  <span className="m-code-top">
                    <span className="m-code-name">{s.title}</span>
                    <span className="m-code-when">{s.when}</span>
                  </span>
                  <span className="m-code-meta" data-where="cloud"><Icon name="cloud" /><span className="m-code-loc">Cloud</span></span>
                </span>
              </button>
            ))}
        </div>
      </div>
      <button className="m-fab btn btn-primary btn-lg" onClick={onNewSession}><Icon name="plus" /><span>New session</span></button>
      <button className="m-search" onClick={onSearch}><Icon name="search" /><span>Search</span></button>
    </div>
  );
}

/* ── Work: tasks grouped by time bucket, each a card with a status
   glyph, title, timestamp and an optional note. ─────────────────────────── */
function WorkView({ desktops, groups, loading, onMenu, onOpen, onOpenDesktop, onNewTask, onSearch }: {
  desktops: AttachedMachine[];
  groups: TimeGroup[];
  loading: boolean;
  onMenu: () => void;
  onOpen: (s: Recent) => void;
  onOpenDesktop: (d: AttachedMachine) => void;
  onNewTask: () => void;
  onSearch: () => void;
}) {
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
        {/* Desktops strip — same as Code: tap a machine to start a task on it. */}
        <div className="m-code-label">Desktops</div>
        <div className="m-desktops">
          {desktops.length === 0
            ? <div className="m-list-note">No desktops connected</div>
            : desktops.map((d) => (
              <button key={d.id || d.name || d.app} className="m-desktop" data-status="connected" onClick={() => onOpenDesktop(d)}>
                <span className="m-desktop-icon"><Icon name="laptop" /><i className="m-desktop-badge" /></span>
                <span className="m-desktop-name">{d.name || d.app}</span>
                <span className="m-desktop-status">Connected</span>
              </button>
            ))}
        </div>
        <div className="m-code-sessions-head"><span className="m-code-label">Tasks</span></div>
        {loading
          ? <div className="m-list-note">Loading…</div>
          : groups.length === 0
          ? <div className="m-list-note">No tasks yet — start one.</div>
          : groups.map((g) => (
            <div key={g.label} className="m-work-section">
              <div className="m-work-label">{g.label}</div>
              <div className="m-work-group">
                {g.items.map((t) => (
                  <button key={t.id} className="m-task" onClick={() => onOpen(t)}>
                    <span className="m-task-check" data-state="todo"><Icon name="circle" /></span>
                    <span className="m-task-body">
                      <span className="m-task-top">
                        <span className="m-task-title">{t.title}</span>
                        <span className="m-task-when">{t.when}</span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
      </div>
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
  draft: string;                    // composer input value (single active composer)
  setDraft: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;              // abort the in-flight turn
  sending: boolean;                 // a turn is in flight
  connecting: boolean;              // provisioning the runtime on open — input locked
  mode: 'chat' | 'cowork' | 'code'; // chat → loop/model chip; work/code → permission chip
  onDictate: (text: string) => void;                 // append dictated text to the draft
  attachments: AttachImage[];                        // pending image attachments (vision)
  onRemoveAttachment: (id: string) => void;
  onPasteFiles: (files: FileList | File[]) => void;  // paste-image / drop
}

/** A pending image attachment — base64 for the turn, dataURL for the chip. */
interface AttachImage { id: string; mediaType: string; data: string; url: string; name: string }

/** Web Speech dictation. Returns supported=false where the API is absent (e.g.
 *  iOS Safari — there the keyboard's own mic is the fallback). Appends only final
 *  results so nothing double-types. */
function useVoice(onText: (t: string) => void) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<{ stop: () => void } | null>(null);
  const SR = typeof window !== 'undefined'
    ? ((window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition
      || (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition)
    : undefined;
  const supported = !!SR;
  const toggle = (): boolean => {
    if (!supported) return false;
    if (recRef.current) { recRef.current.stop(); return true; }
    const rec = new (SR as new () => {
      lang: string; interimResults: boolean; continuous: boolean;
      onstart: () => void; onerror: () => void; onend: () => void;
      onresult: (e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void;
      start: () => void; stop: () => void;
    })();
    rec.lang = (navigator.language || 'en-US');
    rec.interimResults = true; rec.continuous = true;
    rec.onstart = () => setListening(true);
    rec.onerror = () => { setListening(false); recRef.current = null; };
    rec.onend = () => { setListening(false); recRef.current = null; };
    rec.onresult = (e) => {
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) final += r[0].transcript; }
      if (final.trim()) onText(final.trim());
    };
    recRef.current = rec as unknown as { stop: () => void };
    try { rec.start(); haptic(); } catch { recRef.current = null; }
    return true;
  };
  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* */ } }, []);
  return { listening, toggle, supported };
}

/* One assistant turn: the tool group (if any), the markdown answer, and a copy
   action that appears once the turn has settled. User turns stay plain text. */
function AgentMessage({ m, streaming, onOpenDetail, onLongPress }: { m: Message; streaming: boolean; onOpenDetail: (s: ToolStep) => void; onLongPress?: (m: Message) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { if (await copyText(m.text)) { haptic(); setCopied(true); setTimeout(() => setCopied(false), 1400); } };
  const press = useLongPress(() => onLongPress?.(m));
  return (
    <div className="m-msg m-msg-glyphh" {...press}>
      {m.steps && m.steps.length > 0 && <ToolGroup steps={m.steps as ToolStep[]} onOpenDetail={onOpenDetail} />}
      {/* While streaming, render PLAIN text — smooth, no per-token markdown re-lex
          or block re-creation. Swap to full Markdown the moment the turn settles. */}
      {m.text && (streaming ? <div className="m-stream">{m.text}</div> : <Markdown text={m.text} />)}
      {!streaming && m.text && (
        <div className="m-msg-foot">
          <button className="m-msg-copy" onClick={copy} aria-label="Copy message">
            {copied ? <><Icon name="check" /><span>Copied</span></> : <><Icon name="copy" /><span>Copy</span></>}
          </button>
          {m.meta && <span className="m-msg-usage">{usageLabel(m.meta)}</span>}
        </div>
      )}
    </div>
  );
}
/** "· 1,240 cr · 3.2s" style footer from a turn's usage meta. */
function usageLabel(meta: { creditsMicro?: number; ms?: number }): string {
  const parts: string[] = [];
  if (typeof meta.creditsMicro === 'number' && meta.creditsMicro > 0) {
    const cr = meta.creditsMicro / 1e6;
    parts.push(`${cr >= 10 ? Math.round(cr).toLocaleString() : cr.toFixed(2)} cr`);
  }
  if (typeof meta.ms === 'number') parts.push(meta.ms >= 1000 ? `${(meta.ms / 1000).toFixed(1)}s` : `${meta.ms}ms`);
  return parts.join(' · ');
}

/* A user turn — plain text, long-press for actions. */
function UserMessage({ m, onLongPress }: { m: Message; onLongPress: (m: Message) => void }) {
  const press = useLongPress(() => onLongPress(m));
  return (
    <div className="m-msg m-msg-user" {...press}>
      {m.images && m.images.length > 0 && (
        <div className="m-msg-imgs">{m.images.map((src, i) => <img key={i} src={src} alt="" />)}</div>
      )}
      {m.text && <span>{m.text}</span>}
    </div>
  );
}

/* Long-press action tray for a message: copy / quote / edit-resend / retry /
   share, in the selector-sheet idiom. */
function MsgActionSheet({ msg, onClose, onCopy, onQuote, onRetry, onEditResend }: {
  msg: Message | null; onClose: () => void;
  onCopy: (m: Message) => void; onQuote: (m: Message) => void;
  onRetry: () => void; onEditResend: (m: Message) => void;
}) {
  const canShare = typeof navigator !== 'undefined' && !!(navigator as Navigator & { share?: unknown }).share;
  const act = (fn: () => void) => { haptic(); fn(); onClose(); };
  const share = (m: Message) => { try { void (navigator as Navigator & { share?: (d: { text: string }) => Promise<void> }).share?.({ text: m.text }); } catch { /* */ } };
  return createPortal(
    <div className="m-sel-overlay" data-open={msg ? 'true' : 'false'}>
      <div className="m-sel-scrim" onClick={onClose} />
      <div className="m-sel m-sel-fit">
        <div className="m-sel-grip" />
        {msg && (
          <div className="m-sel-body">
            <button className="m-act-row" onClick={() => act(() => onCopy(msg))}><Icon name="copy" /><span>Copy</span></button>
            <button className="m-act-row" onClick={() => act(() => onQuote(msg))}><Icon name="chats" /><span>Quote in reply</span></button>
            {msg.role === 'user'
              ? <button className="m-act-row" onClick={() => act(() => onEditResend(msg))}><Icon name="pencil" /><span>Edit &amp; resend</span></button>
              : <button className="m-act-row" onClick={() => act(onRetry)}><Icon name="loop" /><span>Retry response</span></button>}
            {canShare && <button className="m-act-row" onClick={() => act(() => share(msg))}><Icon name="external" /><span>Share…</span></button>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* A single tool step's full detail, in the same bottom-tray (sheet) idiom as the
   loop/model selector — the "sub-task opens from a tray" behaviour. */
function ToolDetailTray({ step, onClose }: { step: ToolStep | null; onClose: () => void }) {
  return createPortal(
    <div className="m-sel-overlay" data-open={!!step ? 'true' : 'false'}>
      <div className="m-sel-scrim" onClick={onClose} />
      <div className="m-sel m-sel-fit">
        <div className="m-sel-grip" />
        {step && (
          <>
            <div className="m-sel-head"><span className="m-sel-title">{step.title || step.name}</span></div>
            <div className="m-sel-body">
              <div className="m-tray-kv"><span className="m-tray-k">Tool</span><span className="m-tray-v">{step.name}</span></div>
              <div className="m-tray-kv"><span className="m-tray-k">Status</span><span className={`m-tray-status m-tray-status-${step.status}`}>{step.status}</span></div>
              {step.diff && <div className="m-tray-kv"><span className="m-tray-k">Changes</span><DiffBadge diff={step.diff} /></div>}
              {step.thought && <div className="m-tray-block"><div className="m-tray-k">Thinking</div><div className="m-tray-thought">{step.thought}</div></div>}
              {step.error && <div className="m-tray-block"><div className="m-tray-k">Error</div><pre className="m-tray-err">{step.error}</pre></div>}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* Session-level changes rollup — every file-editing tool step across the run,
   with its diff badge; tap a row for the step detail. */
function ChangesTray({ open, changes, onClose, onPick }: { open: boolean; changes: ToolStep[]; onClose: () => void; onPick: (s: ToolStep) => void }) {
  return createPortal(
    <div className="m-sel-overlay" data-open={open ? 'true' : 'false'}>
      <div className="m-sel-scrim" onClick={onClose} />
      <div className="m-sel m-sel-fit">
        <div className="m-sel-grip" />
        <div className="m-sel-head"><span className="m-sel-title">Changes</span></div>
        <div className="m-sel-body">
          {changes.length === 0
            ? <div className="m-list-note">No file changes yet.</div>
            : changes.map((s, i) => (
              <button key={i} className="m-tool-row" data-status={s.status} onClick={() => { haptic(); onPick(s); }}>
                <span className="m-tool-glyph"><span className="m-tool-ok"><Icon name="filedoc" /></span></span>
                <span className="m-tool-name">{s.title || s.name}</span>
                {s.diff && <DiffBadge diff={s.diff} />}
                <span className="m-tool-more"><Icon name="chevron" /></span>
              </button>
            ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SessionView({ session, msgs, connecting, pinned, subtitle, onBack, onDelete, onTogglePin, onRetry, onEditResend, onQuote, comp }: { session: Recent; msgs: Message[] | null; connecting: boolean; pinned: boolean; subtitle?: { icon: IconName; text: string }; onBack: () => void; onDelete: () => void; onTogglePin: () => void; onRetry: () => void; onEditResend: (m: Message) => void; onQuote: (m: Message) => void; comp: CompProps }) {
  const [menu, setMenu] = useState(false);
  const [toolDetail, setToolDetail] = useState<ToolStep | null>(null);
  const [actionMsg, setActionMsg] = useState<Message | null>(null);
  const [confirm, setConfirm] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: Event) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, [menu]);
  const onScroll = () => { const el = scrollRef.current; if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80); };
  const scrollToBottom = (smooth: boolean) => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); };
  const [changesOpen, setChangesOpen] = useState(false);
  // Follow the stream when already at the bottom; leave the user alone if scrolled up.
  useEffect(() => { if (atBottom) scrollToBottom(false); }, [msgs, atBottom]);
  // Code/Work: roll up every file-editing tool step (those with a diff badge)
  // across the transcript into a session-level "Changes" view.
  const changes = comp.mode === 'chat' ? [] : (msgs ?? []).flatMap((m) => (m.steps ?? []) as ToolStep[]).filter((s) => !!s.diff);
  const changeTotals = changes.reduce((a, s) => { const mm = /\[\+(\d+)\s*-(\d+)\]/.exec(s.diff || ''); if (mm) { a.add += +mm[1]; a.del += +mm[2]; } return a; }, { add: 0, del: 0 });
  // The tool currently in flight (last running step) — names the working label.
  const runningTool = comp.sending
    ? (() => { const steps = (msgs ?? []).flatMap((m) => (m.steps ?? []) as ToolStep[]); for (let i = steps.length - 1; i >= 0; i--) if (steps[i].status === 'running') return steps[i].title || steps[i].name; return undefined; })()
    : undefined;

  return (
    <div className="m-sv">
      <header className="m-sv-head">
        <button className="m-chats-icon" aria-label="Back" onClick={onBack}><Icon name="back" /></button>
        <div className="m-sv-titles">
          <span className="m-sv-name">{session.title}</span>
          {subtitle && <span className="m-sv-sub"><Icon name={subtitle.icon} /><span>{subtitle.text}</span></span>}
        </div>
        {changes.length > 0 && (
          <button className="m-sv-changes" onClick={() => { haptic(); setChangesOpen(true); }}>
            <Icon name="branch" />
            <span className="m-diff-add">+{changeTotals.add}</span><span className="m-diff-del">−{changeTotals.del}</span>
          </button>
        )}
        <div className="m-sv-menu-wrap" ref={menuRef}>
          <button className="m-chats-icon" aria-label="Options" onClick={() => { haptic(); setMenu((v) => !v); }}><Icon name="dots" /></button>
          {menu && (
            <div className="m-sv-menu" role="menu">
              {/* Chat uses the composer chip for loop/model; Work/Code keep it here. */}
              {comp.mode !== 'chat' && (
                <>
                  <button className="m-sv-menu-row" onClick={() => { haptic(); setMenu(false); comp.onOpenSelector('sections'); }}>
                    <Icon name="swap" />
                    <span className="m-sv-menu-text"><span className="m-sv-menu-t">Change model</span><span className="m-sv-menu-s">{comp.modelSummary}</span></span>
                  </button>
                  <button className="m-sv-menu-row" onClick={() => { haptic(); setMenu(false); comp.onOpenSelector('sections'); }}>
                    <Icon name="loop" />
                    <span className="m-sv-menu-text"><span className="m-sv-menu-t">Change loop</span><span className="m-sv-menu-s">{comp.loopName}</span></span>
                  </button>
                  <div className="m-sv-menu-sep" />
                </>
              )}
              <button className="m-sv-menu-row" onClick={() => { haptic(); setMenu(false); /* rename (mock) */ }}>
                <Icon name="pencil" /><span>Rename</span>
              </button>
              <button className="m-sv-menu-row" onClick={() => { haptic(); setMenu(false); onTogglePin(); }}>
                <Icon name="pin" /><span>{pinned ? 'Unpin' : 'Pin'}</span>
              </button>
              <button className="m-sv-menu-row m-danger" onClick={() => { haptic(); setMenu(false); setConfirm(true); }}>
                <Icon name="trash" /><span>Delete</span>
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="m-sv-messages" ref={scrollRef} onScroll={onScroll}>
        {msgs === null
          ? <div className="m-list-note">Loading…</div>
          : (
            <>
              {msgs.map((m, i) => (
                m.role === 'user'
                  ? <UserMessage key={m.id} m={m} onLongPress={setActionMsg} />
                  : (m.text || (m.steps && m.steps.length > 0)) && <AgentMessage key={m.id} m={m} streaming={comp.sending && i === msgs.length - 1} onOpenDetail={setToolDetail} onLongPress={setActionMsg} />
              ))}
              {/* The branded spinner shows while a turn runs (streaming/tool-running).
                  The on-open "connecting" state is its own pill above the composer. */}
              {comp.sending && (
                <div className="m-working">
                  <GlyphhSpinner size={40} phrases={false} />
                  <span className="m-working-label">{runningTool ? `Running ${runningTool}…` : 'Working…'}</span>
                </div>
              )}
            </>
          )}
      </div>
      {/* Frosted bottom band — the transcript scrolls fuzzily under the composer. */}
      <div className="m-sv-fade" />
      {!atBottom && msgs && msgs.length > 0 && (
        <button className="m-scrolldown" aria-label="Scroll to latest" onClick={() => scrollToBottom(true)}><Icon name="arrowdown" /></button>
      )}
      {/* On-open connecting state — a small centered pill just above the composer,
          same spinner. The composer input/send are locked while it shows. */}
      {connecting && !comp.sending && (
        <div className="m-connecting">
          <GlyphhSpinner size={24} phrases={false} />
          <span>Connecting…</span>
        </div>
      )}
      <Composer {...comp} />

      {/* Tool detail tray — a step's full thought / title / diff / error. */}
      <ToolDetailTray step={toolDetail} onClose={() => setToolDetail(null)} />

      {/* Session-level changes rollup (Code/Work). */}
      <ChangesTray open={changesOpen} changes={changes} onClose={() => setChangesOpen(false)} onPick={(s) => { setChangesOpen(false); setToolDetail(s); }} />

      {/* Long-press message actions. */}
      <MsgActionSheet
        msg={actionMsg} onClose={() => setActionMsg(null)}
        onCopy={(m) => void copyText(m.text)}
        onQuote={onQuote} onRetry={onRetry} onEditResend={onEditResend}
      />

      {/* Delete confirmation (app modal, never a native confirm). */}
      {confirm && (
        <div className="m-confirm-overlay" role="dialog" aria-modal="true">
          <div className="m-confirm-scrim" onClick={() => setConfirm(false)} />
          <div className="m-confirm">
            <div className="m-confirm-title">Delete chat?</div>
            <div className="m-confirm-msg">“{session.title}” will be permanently deleted. This can’t be undone.</div>
            <div className="m-confirm-actions">
              <button className="m-confirm-btn" onClick={() => { haptic(); setConfirm(false); }}>Cancel</button>
              <button className="m-confirm-btn m-confirm-danger" onClick={() => { haptic(); setConfirm(false); onDelete(); }}>Delete</button>
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
        <div className="m-bill-card"><span className="m-bill-v">{wholeCredits(d.credits as number)}</span><span className="m-bill-l">Credits used</span></div>
        <div className="m-bill-card"><span className="m-bill-v">{wholeCredits(d.creditsSaved as number)}</span><span className="m-bill-l">Saved</span></div>
      </div>
      <div className="m-set-label">By source</div>
      <div className="m-sel-group">
        <div className="m-sel-row"><span className="m-sel-row-label">Runtime</span><span className="m-sel-row-val">{wholeCredits(bs.fly)}</span></div>
        <div className="m-sel-row"><span className="m-sel-row-label">Connectors</span><span className="m-sel-row-val">{wholeCredits(bs.pipedream)}</span></div>
        <div className="m-sel-row"><span className="m-sel-row-label">Model providers</span><span className="m-sel-row-val">{wholeCredits(bs.provider)}</span></div>
      </div>
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
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  // Detail (edit) tray state.
  const [sel, setSel] = useState<Conn | null>(null);
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [toolsOpen, setToolsOpen] = useState<Set<string>>(new Set());   // expanded tool rows

  const refresh = async () => { try { setConns(await glyphh().connections.personalList()); } catch { setConns([]); } };
  useEffect(() => { void refresh(); }, []);
  // Resolve real app icons for the connected accounts.
  useEffect(() => {
    if (!conns) return;
    const slugs = [...new Set(conns.map((c) => c.appSlug))].filter((s) => !(s in icons));
    if (!slugs.length) return;
    let alive = true;
    void Promise.all(slugs.map(async (s) => [s, await resolveConnIcon(s)] as const)).then((pairs) => {
      if (alive) setIcons((m) => { const n = { ...m }; for (const [s, i] of pairs) n[s] = i; return n; });
    });
    return () => { alive = false; };
  }, [conns]);   // eslint-disable-line
  const connIcon = (slug: string, name: string, lg?: boolean) => (
    <span className={lg ? 'm-conn-ico m-conn-ico-lg' : 'm-conn-ico'}>
      {icons[slug] ? <img src={icons[slug] as string} alt="" onError={() => setIcons((m) => ({ ...m, [slug]: null }))} /> : (name || '?').charAt(0)}
    </span>
  );
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
      if (list) { setConns(list); if (list.some((c: { id: string }) => !before.has(c.id))) { setConnecting(null); setView('list'); return; } }
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
  const toggleToolOpen = (id: string) => setToolsOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const openDetail = async (c: Conn) => {
    haptic(); setErr(''); setSel(c); setTools(null); setToolsOpen(new Set()); setView('detail');
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
  const writeTools = (c: Conn, next: Set<string>) => {
    setAllowed(next);
    void glyphh().connections.setPersonalConnectionTools(c.appSlug, [...next]).catch(() => setErr('Could not update tools.'));
  };
  const toggleTool = (c: Conn, name: string) => {
    haptic();
    const next = new Set(allowed);
    if (next.has(name)) next.delete(name); else next.add(name);
    writeTools(c, next);
  };
  const toggleAll = (c: Conn, all: boolean) => {
    haptic();
    writeTools(c, all ? new Set((tools || []).map((t) => t.name)) : new Set());
  };
  const rename = (c: Conn, label: string) => {
    const v = label.trim();
    if (!v || v === (c.label || c.appName)) return;
    void glyphh().connections.renamePersonalConnection(c.id, v).then(() => void refresh()).catch(() => setErr('Could not rename.'));
  };

  return (
    <>
      {/* Base: the connections list (the settings sub content). */}
      {conns == null ? <div className="m-set-loading">Loading…</div>
        : conns.length === 0 ? <div className="m-conn-empty">No connections yet. Add one to give your agent access to your apps.</div>
        : (
          <div className="m-sel-group">
            {conns.map((c) => (
              <button key={c.id} className="m-opt" onClick={() => openDetail(c)}>
                {connIcon(c.appSlug, c.appName)}
                <span className="m-opt-text"><span className="m-opt-name">{c.label || c.appName}</span><span className="m-opt-desc">{c.healthy === false ? 'Reconnect needed' : 'Connected'}</span></span>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
        )}
      <button className="m-field-btn" onClick={() => { haptic(); setView('catalog'); }}>+ Add a connection</button>
      {view === 'list' && err && <div className="m-field-err">{err}</div>}

      {/* Add-a-connection catalog — its own sliding tray (portaled so fixed
          positioning escapes the settings track's transform). */}
      {view === 'catalog' && createPortal(
        <div className="m-subtray-overlay">
          <div className="m-subtray-scrim" onClick={() => { haptic(); setView('list'); setErr(''); }} />
          <div className="m-subtray">
          <header className="m-subtray-head">
            <button className="m-sheet-btn" aria-label="Back" onClick={() => { haptic(); setView('list'); setErr(''); }}><Icon name="back" /></button>
            <span className="m-sheet-title">Add a connection</span>
            <span className="m-sheet-btn" aria-hidden="true" style={{ visibility: 'hidden' }} />
          </header>
          <div className="m-subtray-body">
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
          </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Connection detail (edit) — its own sliding tray (portaled). */}
      {view === 'detail' && sel && createPortal(
        <div className="m-subtray-overlay">
          <div className="m-subtray-scrim" onClick={() => { haptic(); setView('list'); setSel(null); setErr(''); }} />
          <div className="m-subtray">
          <header className="m-subtray-head">
            <button className="m-sheet-btn" aria-label="Back" onClick={() => { haptic(); setView('list'); setSel(null); setErr(''); }}><Icon name="back" /></button>
            <span className="m-sheet-title">{sel.label || sel.appName}</span>
            <span className="m-sheet-btn" aria-hidden="true" style={{ visibility: 'hidden' }} />
          </header>
          <div className="m-subtray-body">
            <div className="m-conn-detail-head">
              {connIcon(sel.appSlug, sel.appName, true)}
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
              : (() => {
                const allOn = tools.every((t) => allowed.has(t.name));
                const noneOn = tools.every((t) => !allowed.has(t.name));
                return (
                  <div className="m-sel-group">
                    <div className="m-tool m-tool-all">
                      <div className="m-tool-head" onClick={() => toggleAll(sel, !allOn)}>
                        <span className="m-tool-name">Select all</span>
                        <span className="m-tool-count">{allowed.size}/{tools.length}</span>
                        <Switch on={allOn} ind={!allOn && !noneOn} onClick={(e) => { e.stopPropagation(); toggleAll(sel, !allOn); }} />
                      </div>
                    </div>
                    {tools.map((t) => {
                      const id = t.key || t.name;
                      const open = toolsOpen.has(id);
                      return (
                        <div key={id} className="m-tool" data-open={open ? 'true' : 'false'}>
                          <div className="m-tool-head" onClick={() => (t.description ? toggleToolOpen(id) : toggleTool(sel, t.name))}>
                            <span className="m-tool-name">{t.name}</span>
                            {t.description && <span className="m-tool-caret"><Icon name="caret" /></span>}
                            <Switch on={allowed.has(t.name)} onClick={(e) => { e.stopPropagation(); toggleTool(sel, t.name); }} />
                          </div>
                          {open && t.description && <div className="m-tool-desc">{t.description}</div>}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            <button className="m-field-btn m-field-danger" onClick={() => { haptic(); setDel(sel); }}>Disconnect</button>
            {err && <div className="m-field-err">{err}</div>}
          </div>

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
          </div>
        </div>,
        document.body,
      )}

      {/* Connect happens IN-APP as a tray (no popup): the Pipedream Connect page
          loads in an embedded frame; we detect the new account and close. */}
      {connecting && createPortal(
        <div className="m-connect-tray">
          <header className="m-connect-head">
            <button className="m-sheet-btn" aria-label="Cancel" onClick={() => { haptic(); setConnecting(null); void refresh(); }}><Icon name="close" /></button>
            <span className="m-sheet-title">Connect {connecting.app.name}</span>
            <span className="m-sheet-btn" aria-hidden="true" style={{ visibility: 'hidden' }} />
          </header>
          <iframe className="m-connect-frame" src={connecting.url} title={`Connect ${connecting.app.name}`} allow="clipboard-write" />
          <a className="m-connect-fallback" href={connecting.url} target="_blank" rel="noopener noreferrer">Trouble loading? Open in a browser tab</a>
        </div>,
        document.body,
      )}
    </>
  );
}

/* Help & Support — the real SDK ticket system (list → new → thread + replies). */
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

/* A confirm dialog, portaled to body so it clears the sheet's transformed track. */
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

function GeneralTray() {
  const [prefs, setPrefs] = useState<Record<string, unknown> | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { glyphh().profile.prefs().then((p: Record<string, unknown>) => setPrefs(p)).catch(() => setPrefs({})); }, []);
  const save = (patch: Record<string, unknown>) => {
    glyphh().profile.setPrefs(patch).then((p: Record<string, unknown>) => { setPrefs(p); setSaved(true); setTimeout(() => setSaved(false), 1300); }).catch(() => {});
  };
  if (!prefs) return <div className="m-set-loading">Loading…</div>;
  return (
    <>
      <div className="m-set-label">Compaction guidance {saved && <span className="m-saved">Saved</span>}</div>
      <div className="m-set-form">
        <textarea className="m-field-in m-field-area" defaultValue={(prefs.glyphhCompactionPrompt as string) || ''} rows={5}
          placeholder="Extra instructions for the agent when it compacts a long conversation…"
          onBlur={(e) => save({ glyphhCompactionPrompt: e.currentTarget.value })} />
      </div>
      <div className="m-field-note">Handed to the agent whenever it compacts its context.</div>
    </>
  );
}

function ApiKeysTray() {
  type Key = { id: string; label: string; prefix: string; createdAt: string; expiresAt: string | null };
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [label, setLabel] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<Key | null>(null);
  const [err, setErr] = useState('');
  const refresh = () => glyphh().apiKeys.list().then((k: Key[]) => setKeys(k)).catch(() => setKeys([]));
  useEffect(() => { refresh(); }, []);
  const create = async () => {
    const l = label.trim(); if (!l) return;
    setBusy(true); setErr('');
    try { const r = await glyphh().apiKeys.create({ label: l }); setToken(r.token); setLabel(''); refresh(); }
    catch { setErr('Could not create the key.'); } finally { setBusy(false); }
  };
  const revoke = async (k: Key) => { setDel(null); try { await glyphh().apiKeys.revoke(k.id); refresh(); } catch { setErr('Could not revoke.'); } };
  const copy = () => { if (token) void navigator.clipboard?.writeText(token).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  return (
    <>
      {token && (
        <div className="m-key-new">
          <div className="m-key-new-t">Copy your key now — it won’t be shown again.</div>
          <code className="m-key-token">{token}</code>
          <button className="m-field-btn" onClick={copy}>{copied ? 'Copied' : 'Copy key'}</button>
        </div>
      )}
      <div className="m-set-label">New key</div>
      <div className="m-set-form">
        <input className="m-field-in" value={label} onChange={(e) => setLabel(e.currentTarget.value)} placeholder="Label (e.g. CI deploy)" />
        <button className="m-login-primary" disabled={busy || !label.trim()} onClick={create}>{busy ? 'Creating…' : 'Create key'}</button>
      </div>
      <div className="m-set-label">Your keys</div>
      {keys == null ? <div className="m-set-loading">Loading…</div>
        : keys.length === 0 ? <div className="m-conn-empty">No keys yet.</div>
        : (
          <div className="m-sel-group">
            {keys.map((k) => (
              <div key={k.id} className="m-opt">
                <span className="m-opt-text"><span className="m-opt-name">{k.label}</span><span className="m-opt-desc">{k.prefix} · {new Date(k.createdAt).toLocaleDateString()}</span></span>
                <button className="m-key-revoke" onClick={() => setDel(k)}>Revoke</button>
              </div>
            ))}
          </div>
        )}
      {err && <div className="m-field-err">{err}</div>}
      {del && <Confirm title={`Revoke “${del.label}”?`} message="Any client using this key immediately loses access." confirmLabel="Revoke" onCancel={() => setDel(null)} onConfirm={() => revoke(del)} />}
    </>
  );
}

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

function GuardrailsTray() {
  const [pol, setPol] = useState<Record<string, number> | null | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  useEffect(() => { glyphh().org.guardrails().then((g: { guardrails_policy: Record<string, number> | null }) => setPol(g.guardrails_policy)).catch(() => setPol(null)); }, []);
  const fields: [string, string][] = [
    ['maxInputTokens', 'Max input tokens'],
    ['maxOutputTokens', 'Max output tokens'],
    ['maxConcurrent', 'Max concurrent runs'],
    ['windowSeconds', 'Rate window (seconds)'],
    ['windowTokens', 'Tokens per window'],
    ['windowCalls', 'Calls per window'],
  ];
  const save = (key: string, val: string) => {
    const next: Record<string, number> = { ...(pol || {}) };
    const n = val.trim() === '' ? NaN : Number(val);
    if (Number.isNaN(n)) delete next[key]; else next[key] = n;
    const policy = Object.keys(next).length ? next : null;
    setPol(policy);
    glyphh().org.setGuardrails(policy).then((g: { guardrails_policy: Record<string, number> | null }) => { setPol(g.guardrails_policy); setSaved(true); setTimeout(() => setSaved(false), 1300); }).catch(() => {});
  };
  if (pol === undefined) return <div className="m-set-loading">Loading…</div>;
  return (
    <>
      <div className="m-set-label">Limits {saved && <span className="m-saved">Saved</span>}</div>
      <div className="m-set-form">
        {fields.map(([k, lbl]) => (
          <label className="m-field" key={k}><span className="m-field-l">{lbl}</span>
            <input className="m-field-in" type="number" inputMode="numeric" defaultValue={pol?.[k] ?? ''} placeholder="No limit" onBlur={(e) => save(k, e.currentTarget.value)} /></label>
        ))}
      </div>
      <div className="m-field-note">Blank means no limit. Applies to every member of your org.</div>
    </>
  );
}

function ModelsTray() {
  type Prov = { slug: string; name: string; enabledForOrg: boolean; hasByokKey: boolean };
  type OM = { id: string; name: string; providerSlug: string; supported: boolean };
  const [provs, setProvs] = useState<Prov[] | null>(null);
  const [models, setModels] = useState<OM[] | null>(null);
  const [q, setQ] = useState('');
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyVal, setKeyVal] = useState('');
  const [err, setErr] = useState('');
  const load = () => {
    glyphh().catalog.providers().then((p: Prov[]) => setProvs(p)).catch(() => setProvs([]));
    glyphh().orgModels.list().then((m: OM[]) => setModels(m)).catch(() => setModels([]));
  };
  useEffect(() => { load(); }, []);
  const toggleProvider = async (p: Prov) => {
    try { if (p.enabledForOrg) await glyphh().providers.disable(p.slug); else await glyphh().providers.enable(p.slug); load(); }
    catch { setErr('Could not update the provider.'); }
  };
  const saveKey = async (slug: string) => { try { await glyphh().providers.enable(slug, keyVal.trim()); setKeyFor(null); setKeyVal(''); load(); } catch { setErr('Could not save the key.'); } };
  const clearKey = (slug: string) => { void glyphh().providers.clearKey(slug).then(load).catch(() => setErr('Could not clear the key.')); };
  const toggleModel = async (m: OM) => {
    setModels((ms) => (ms || []).map((x) => (x.id === m.id ? { ...x, supported: !x.supported } : x)));
    try { await glyphh().orgModels.setSupported(m.id, !m.supported); } catch { setErr('Could not update the model.'); load(); }
  };
  const filtered = (models || []).filter((m) => !q.trim() || m.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <div className="m-set-label">Providers</div>
      {provs == null ? <div className="m-set-loading">Loading…</div> : (
        <div className="m-sel-group">
          {provs.map((p) => (
            <div key={p.slug} className="m-tool" data-open={keyFor === p.slug ? 'true' : 'false'}>
              <div className="m-tool-head" onClick={() => (p.enabledForOrg ? setKeyFor(keyFor === p.slug ? null : p.slug) : toggleProvider(p))}>
                <span className="m-tool-name">{p.name}{p.hasByokKey && <span className="m-chip m-chip-inline">Key</span>}</span>
                <Switch on={p.enabledForOrg} onClick={(e) => { e.stopPropagation(); toggleProvider(p); }} />
              </div>
              {keyFor === p.slug && (
                <div className="m-tool-desc">
                  <input className="m-field-in" type="password" placeholder="BYOK API key (optional)" value={keyVal} onChange={(e) => setKeyVal(e.currentTarget.value)} />
                  <div className="m-key-row">
                    <button className="m-field-btn" onClick={() => saveKey(p.slug)}>Save key</button>
                    {p.hasByokKey && <button className="m-key-revoke" onClick={() => clearKey(p.slug)}>Clear key</button>}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="m-set-label">Models</div>
      <div className="m-sel-search"><Icon name="search" /><input className="m-conn-in" placeholder="Search models" value={q} onChange={(e) => setQ(e.currentTarget.value)} /></div>
      {models == null ? <div className="m-set-loading">Loading…</div> : (
        <div className="m-sel-group">
          {filtered.map((m) => (
            <div key={m.id} className="m-tool">
              <div className="m-tool-head">
                <span className="m-opt-text"><span className="m-opt-name">{m.name}</span><span className="m-opt-desc">{m.providerSlug}</span></span>
                <Switch on={m.supported} onClick={(e) => { e.stopPropagation(); toggleModel(m); }} />
              </div>
            </div>
          ))}
        </div>
      )}
      {err && <div className="m-field-err">{err}</div>}
    </>
  );
}

function WorkspacesTray() {
  type WS = { id: string; name: string; isBase: boolean; creditsCap: number | null; capPeriodDays: number | null; rateLimitCalls: number | null; rateLimitWindowSeconds: number | null };
  const [list, setList] = useState<WS[] | null>(null);
  const [sel, setSel] = useState<WS | null>(null);
  const [newName, setNewName] = useState('');
  const [del, setDel] = useState<WS | null>(null);
  const [err, setErr] = useState('');
  const refresh = () => glyphh().workspaces.list().then((w: WS[]) => setList(w)).catch(() => setList([]));
  useEffect(() => { refresh(); }, []);
  const create = async () => { const n = newName.trim(); if (!n) return; try { await glyphh().workspaces.create({ name: n }); setNewName(''); refresh(); } catch { setErr('Could not create.'); } };
  const save = (ws: WS, patch: Record<string, unknown>) => { glyphh().workspaces.update(ws.id, patch).then((w: WS) => { setSel(w); refresh(); }).catch(() => setErr('Could not save.')); };
  const remove = async (ws: WS) => { setDel(null); try { await glyphh().workspaces.delete(ws.id); setSel(null); refresh(); } catch { setErr('Could not delete.'); } };
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  return (
    <>
      {list == null ? <div className="m-set-loading">Loading…</div> : (
        <div className="m-sel-group">
          {list.map((w) => (
            <button key={w.id} className="m-opt" onClick={() => { haptic(); setSel(w); }}>
              <span className="m-opt-text"><span className="m-opt-name">{w.name}{w.isBase && <span className="m-chip m-chip-inline">Base</span>}</span></span>
              <Icon name="chevron" />
            </button>
          ))}
        </div>
      )}
      <div className="m-set-form">
        <div className="m-key-row">
          <input className="m-field-in" style={{ flex: 1 }} value={newName} onChange={(e) => setNewName(e.currentTarget.value)} placeholder="New workspace name" />
          <button className="m-field-btn m-field-inline" disabled={!newName.trim()} onClick={create}>Create</button>
        </div>
      </div>
      {err && <div className="m-field-err">{err}</div>}

      {sel && createPortal(
        <div className="m-subtray-overlay">
          <div className="m-subtray-scrim" onClick={() => setSel(null)} />
          <div className="m-subtray">
            <header className="m-subtray-head">
              <button className="m-sheet-btn" aria-label="Back" onClick={() => setSel(null)}><Icon name="back" /></button>
              <span className="m-sheet-title">{sel.name}</span>
              <span className="m-sheet-btn" aria-hidden="true" style={{ visibility: 'hidden' }} />
            </header>
            <div className="m-subtray-body">
              <div className="m-set-label">Name</div>
              <div className="m-set-form">
                <input className="m-field-in" defaultValue={sel.name} disabled={sel.isBase} onBlur={(e) => save(sel, { name: e.currentTarget.value.trim() })} />
              </div>
              <div className="m-set-label">Credit cap</div>
              <div className="m-set-form">
                <label className="m-field"><span className="m-field-l">Credits</span>
                  <input className="m-field-in" type="number" inputMode="numeric" defaultValue={sel.creditsCap ?? ''} placeholder="No cap" onBlur={(e) => save(sel, { creditsCap: num(e.currentTarget.value) })} /></label>
                <label className="m-field"><span className="m-field-l">Period (days)</span>
                  <input className="m-field-in" type="number" inputMode="numeric" defaultValue={sel.capPeriodDays ?? ''} placeholder="30" onBlur={(e) => save(sel, { capPeriodDays: num(e.currentTarget.value) })} /></label>
              </div>
              <div className="m-set-label">Rate limit</div>
              <div className="m-set-form">
                <label className="m-field"><span className="m-field-l">Calls</span>
                  <input className="m-field-in" type="number" inputMode="numeric" defaultValue={sel.rateLimitCalls ?? ''} placeholder="No limit" onBlur={(e) => save(sel, { rateLimitCalls: num(e.currentTarget.value) })} /></label>
                <label className="m-field"><span className="m-field-l">Per (seconds)</span>
                  <input className="m-field-in" type="number" inputMode="numeric" defaultValue={sel.rateLimitWindowSeconds ?? ''} placeholder="60" onBlur={(e) => save(sel, { rateLimitWindowSeconds: num(e.currentTarget.value) })} /></label>
              </div>
              {!sel.isBase && <button className="m-field-btn m-field-danger" onClick={() => setDel(sel)}>Delete workspace</button>}
              {err && <div className="m-field-err">{err}</div>}
            </div>
            {del && <Confirm title={`Delete “${del.name}”?`} message="Members fall back to the base workspace." confirmLabel="Delete" onCancel={() => setDel(null)} onConfirm={() => remove(del)} />}
          </div>
        </div>,
        document.body,
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

/* Runtime picker — same selection UI as models/appearance. NAM for now. */
function RuntimeTray() {
  const [rt, setRt] = useState(currentRuntime);
  const pick = (id: string) => { haptic(); setRt(id); setRuntimePref(id); };
  return (
    <>
      <div className="m-sel-note">The cloud runtime your chats run on. Upgraded and dedicated runtimes are coming — every org runs on NAM for now.</div>
      <div className="m-sel-group">
        {RUNTIMES.map((o) => (
          <button key={o.id} className="m-opt" onClick={() => pick(o.id)}>
            <span className="m-opt-text"><span className="m-opt-name">{o.name}</span><span className="m-opt-desc">{o.desc}</span></span>
            {rt === o.id && <span className="m-opt-tick"><Icon name="tick" /></span>}
          </button>
        ))}
      </div>
    </>
  );
}

type SettingsSub = 'profile' | 'billing' | 'usage' | 'appearance' | 'connections' | 'help'
  | 'general' | 'apikeys' | 'runtime' | 'org' | 'members' | 'guardrails' | 'models' | 'workspaces';
const SUB_TITLE: Record<SettingsSub, string> = {
  profile: 'Profile', billing: 'Billing', usage: 'Usage', appearance: 'Appearance',
  connections: 'Connections', help: 'Help & Support', general: 'General', apikeys: 'API keys',
  runtime: 'Runtime', org: 'Organization', members: 'Members', guardrails: 'Guardrails', models: 'Models', workspaces: 'Workspaces',
};
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
  const isAdmin = user.role === 'org_admin' || user.role === 'super_admin';
  const title = SUB_TITLE[sub];

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
              {SETTINGS_GROUPS.map((g) => {
                const rows = g.rows.filter((r) => !r.admin || isAdmin);
                if (!rows.length) return null;
                return (
                  <div key={g.label} className="m-set-section">
                    <div className="m-set-label">{g.label}</div>
                    <div className="m-set-group">
                      {rows.map((r) => (
                        <button key={r.label} className="m-set-row" onClick={() => openSub(r.sub as SettingsSub)}>
                          <span className="m-set-ico"><Icon name={r.icon as IconName} /></span>
                          <span className="m-set-name">{r.label}</span>
                          {r.value && <span className="m-set-val">{r.value}</span>}
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
              {sub === 'general' && <GeneralTray />}
              {sub === 'runtime' && <RuntimeTray />}
              {sub === 'apikeys' && <ApiKeysTray />}
              {sub === 'org' && <OrganizationTray />}
              {sub === 'members' && <MembersTray />}
              {sub === 'guardrails' && <GuardrailsTray />}
              {sub === 'models' && <ModelsTray />}
              {sub === 'workspaces' && <WorkspacesTray />}
              {sub === 'connections' && <ConnectionsTray />}
              {sub === 'appearance' && <AppearanceTray />}
              {sub === 'help' && <HelpTray />}
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Attachment menu: a popover above the composer's + (camera / photo / file).
   Rendered at app root so it escapes the shell's transform. ──────────────── */
function AttachMenu({ open, onClose, onCamera, onPhoto }: { open: boolean; onClose: () => void; onCamera: () => void; onPhoto: () => void }) {
  const pick = (fn: () => void) => { haptic(); fn(); onClose(); };
  return (
    <div className="m-attach-overlay" data-open={open ? 'true' : 'false'}>
      <div className="m-attach-scrim" onClick={onClose} />
      <div className="m-attach-menu" role="menu">
        <button className="m-attach-row" onClick={() => pick(onCamera)}><Icon name="camera" /><span>Take Photo</span></button>
        <button className="m-attach-row" onClick={() => pick(onPhoto)}><Icon name="image" /><span>Photo Library</span></button>
      </div>
    </div>
  );
}

/* ── Loop & models selector: a bottom sheet with two sections — Loop / Models.
   Each row's chevron slides open that section's tray, which has a < back. Opened
   by the new-session dropdown and by a session's "Change model / loop". Permission
   lives in its own PermissionSheet (below), reached from the composer. ──────── */
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

function SelectorSheet({ open, section, onClose, loops, loop, setLoop, roles, roleSel, setRoleSel, models }: {
  open: boolean;
  section: 'loop' | 'models' | null;   // deep-link entry point
  onClose: () => void;
  loops: LoopItem[] | null;
  loop: string; setLoop: (v: string) => void;
  roles: RoleItem[] | null;
  roleSel: Record<string, string>; setRoleSel: (fn: (m: Record<string, string>) => Record<string, string>) => void;
  models: ModelChoice[];
}) {
  // Depth track: 0 = sections, 1 = a section tray, 2 = More models (per role).
  const [tray, setTray] = useState<'loop' | 'models'>('models');
  const [depth, setDepth] = useState(0);
  const [moreRole, setMoreRole] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});   // undefined → expanded

  // Open → jump straight to the requested section's tray. Close → reset once slid away.
  useEffect(() => {
    if (open) { if (section) { setTray(section); setDepth(1); } return; }
    const t = setTimeout(() => setDepth(0), 260);
    return () => clearTimeout(t);
  }, [open]);

  const roleList = roles ?? [];
  const choicesFor = (r: RoleItem) => (r.choices.length ? r.choices : models);   // fall back to the full pool
  const selectedFor = (r: RoleItem) => roleSel[r.name] ?? r.modelId ?? '';
  const modelName = (id: string) => {
    if (!id) return '';
    for (const r of roleList) { const c = r.choices.find((x) => x.id === id); if (c) return c.name; }
    return models.find((m) => m.id === id)?.name ?? shortModelId(id);
  };
  const loopName = (loops ?? []).find((l) => l.slug === loop)?.name ?? '';
  const openTray = (t: 'loop' | 'models') => { haptic(); setTray(t); setDepth(1); };
  const trayTitle = tray === 'loop' ? 'Loop' : 'Models';
  const modelsSummary = roleList.length === 1 ? modelName(selectedFor(roleList[0])) : roleList.length ? `${roleList.length} models` : '';
  const setRoleModel = (roleName: string, id: string) => { haptic(); setRoleSel((m) => ({ ...m, [roleName]: id })); };
  const toggleRole = (roleName: string) => { haptic(); setExpanded((e) => ({ ...e, [roleName]: !(e[roleName] ?? true) })); };
  const openMore = (roleName: string) => { haptic(); setMoreRole(roleName); setDepth(2); };
  const loopItems = (loops ?? []).map((l) => ({ id: l.slug, name: l.name, desc: l.description }));
  const moreRoleObj = roleList.find((r) => r.name === moreRole);
  const moreItems = moreRoleObj ? choicesFor(moreRoleObj).slice(MODEL_TOP_N).map((c) => ({ id: c.id, name: c.name, desc: c.providerSlug })) : [];

  return (
    <div className="m-sel-overlay" data-open={open ? 'true' : 'false'}>
      <div className="m-sel-scrim" onClick={onClose} />
      <div className="m-sel" role="dialog" aria-modal="true">
        <div className="m-sel-grip" />
        <div className="m-sel-track" data-depth={depth}>
          {/* Panel 0 — the two sections. */}
          <section className="m-sel-panel">
            <div className="m-sel-head">
              <button className="m-sheet-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
              <span className="m-sel-title">Loop &amp; models</span>
            </div>
            <div className="m-sel-body">
              <div className="m-sel-group">
                <button className="m-sel-row" onClick={() => openTray('loop')}>
                  <span className="m-sel-row-label">Loop</span><span className="m-sel-row-val">{loopName}</span><Icon name="chevron" />
                </button>
                <button className="m-sel-row" onClick={() => openTray('models')}>
                  <span className="m-sel-row-label">Models</span><span className="m-sel-row-val">{modelsSummary}</span><Icon name="chevron" />
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
                loops === null
                  ? <div className="m-list-note">Loading…</div>
                  : loopItems.length === 0
                  ? <div className="m-list-note">No loops available.</div>
                  : <OptionList items={loopItems} selected={loop} onPick={(id) => { haptic(); setLoop(id); setDepth(0); }} />
              )}
              {tray === 'models' && (
                roles === null
                  ? <div className="m-list-note">Loading…</div>
                  : (
                <>
                  {/* One collapsible section per loop role; each lists its top N
                      choices, then "More models" → the rest (panel 2). */}
                  {roleList.map((r) => {
                    const choices = choicesFor(r);
                    const top = choices.slice(0, MODEL_TOP_N);
                    const sel = selectedFor(r);
                    const openSec = expanded[r.name] ?? true;
                    return (
                      <div key={r.name} className="m-role" data-open={openSec ? 'true' : 'false'}>
                        <button className="m-role-head" onClick={() => toggleRole(r.name)}>
                          <span className="m-role-name">{r.label || r.name}</span>
                          <span className="m-role-val">{modelName(sel)}</span>
                          <Icon name="caret" />
                        </button>
                        {openSec && (
                          <div className="m-sel-group">
                            {top.length === 0 && <div className="m-list-note">No models available.</div>}
                            {top.map((m) => (
                              <button key={m.id} className="m-opt" onClick={() => setRoleModel(r.name, m.id)}>
                                <span className="m-opt-text"><span className="m-opt-name">{m.name}</span>{m.providerSlug && <span className="m-opt-desc">{m.providerSlug}</span>}</span>
                                {sel === m.id && <span className="m-opt-tick"><Icon name="tick" /></span>}
                              </button>
                            ))}
                            {choices.length > MODEL_TOP_N && (
                              <button className="m-sel-row" onClick={() => openMore(r.name)}>
                                <span className="m-sel-row-label">More models</span><Icon name="chevron" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
                  )
              )}
            </div>
          </section>

          {/* Panel 2 — More models for a role: that role's choices beyond the top N. */}
          <section className="m-sel-panel">
            <div className="m-sel-head">
              <button className="m-sheet-btn" aria-label="Back" onClick={() => { haptic(); setDepth(1); }}><Icon name="back" /></button>
              <span className="m-sel-title">{moreRoleObj ? `${moreRoleObj.label || moreRoleObj.name} · more` : 'More models'}</span>
            </div>
            <div className="m-sel-body">
              <OptionList items={moreItems} selected={moreRoleObj ? selectedFor(moreRoleObj) : ''} onPick={(id) => { if (moreRole) setRoleModel(moreRole, id); setDepth(1); }} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/* ── Permission selector: its own content-height bottom sheet (never nested in
   the loop/models sheet). Reached from the composer's shield pill. ─────────── */
function PermissionSheet({ open, onClose, perm, setPerm }: {
  open: boolean;
  onClose: () => void;
  perm: string; setPerm: (v: string) => void;
}) {
  return (
    <div className="m-sel-overlay" data-open={open ? 'true' : 'false'}>
      <div className="m-sel-scrim" onClick={onClose} />
      <div className="m-sel m-sel-fit" role="dialog" aria-modal="true">
        <div className="m-sel-grip" />
        <div className="m-sel-head">
          <button className="m-sheet-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
          <span className="m-sel-title">Permission</span>
        </div>
        <div className="m-sel-body">
          <div className="m-sel-note">How much can Glyphh do on its own before it checks with you?</div>
          <OptionList items={PERMS} selected={perm} onPick={(id) => { haptic(); setPerm(id); onClose(); }} />
        </div>
      </div>
    </div>
  );
}

/* ── Agent prompt: a parked approval (Allow/Deny) or the agent's questions.
   Portaled over everything; auto-dismisses at the runtime's decide deadline. ── */
type PendingPrompt = ({ t: 'approval' } & RemoteApprovalRequest) | ({ t: 'ask' } & RemoteAskRequest);
function AgentPrompt({ pending, onResolve }: {
  pending: PendingPrompt;
  onResolve: (reply: { allow?: boolean; answers?: string[] } | null) => void;
}) {
  const [answers, setAnswers] = useState<string[]>(() => pending.t === 'ask' ? pending.questions.map(() => '') : []);
  const [left, setLeft] = useState(() => Math.max(0, Math.round((pending.deadline - Date.now()) / 1000)));
  useEffect(() => {
    const iv = setInterval(() => {
      const s = Math.max(0, Math.round((pending.deadline - Date.now()) / 1000));
      setLeft(s);
      if (s <= 0) onResolve(null);   // the runtime decides on its own past the deadline
    }, 1000);
    return () => clearInterval(iv);
  }, [pending.deadline]);

  const body = pending.t === 'approval' ? (
    <>
      <div className="m-prompt-kind" data-kind={pending.kind}>{pending.kind}</div>
      <div className="m-prompt-title">{pending.title || 'Allow this action?'}</div>
      {pending.detail && <div className="m-prompt-detail">{pending.detail}</div>}
      <div className="m-prompt-actions">
        <button className="m-prompt-btn" onClick={() => { haptic(); onResolve({ allow: false }); }}>Deny</button>
        <button className="m-prompt-btn m-prompt-primary" onClick={() => { haptic(); onResolve({ allow: true }); }}>Allow</button>
      </div>
    </>
  ) : (
    <>
      <div className="m-prompt-title">Glyphh is asking</div>
      {pending.questions.map((q, i) => (
        <div key={i} className="m-prompt-q">
          <div className="m-prompt-qtext">{q.question}</div>
          {q.options && q.options.length ? (
            <div className="m-prompt-opts">
              {q.options.map((o) => (
                <button key={o} className="m-prompt-opt" data-on={answers[i] === o ? 'true' : 'false'}
                  onClick={() => { haptic(); setAnswers((a) => a.map((x, j) => (j === i ? o : x))); }}>{o}</button>
              ))}
            </div>
          ) : (
            <input className="m-prompt-input" value={answers[i]} placeholder="Type an answer…"
              onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? (e.target as HTMLInputElement).value : x)))} />
          )}
        </div>
      ))}
      <div className="m-prompt-actions">
        <button className="m-prompt-btn m-prompt-primary" disabled={answers.some((a) => !a.trim())}
          onClick={() => { haptic(); onResolve({ answers }); }}>Send</button>
      </div>
    </>
  );

  return createPortal(
    <div className="m-prompt-overlay" role="dialog" aria-modal="true">
      <div className="m-prompt-scrim" />
      <div className="m-prompt">
        <div className="m-prompt-grip" />
        {body}
        {left > 0 && <div className="m-prompt-timer">Auto-decides in {left}s</div>}
      </div>
    </div>,
    document.body,
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
      <div className="m-login-card">
        <img className="m-login-logo" src="/brand/glyphh-logo-white.png" alt="Glyphh" />
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
  const [attachImgs, setAttachImgs] = useState<AttachImage[]>([]);     // pending image attachments (vision)
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [threads, setThreads] = useState<ThreadMeta[] | null>(null);   // null = loading
  const [pins, setPins] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('yoPins') || '[]')); } catch { return new Set(); } });
  const [desktops, setDesktops] = useState<AttachedMachine[]>([]);   // attached machines (Code strip)
  const [msgs, setMsgs] = useState<Message[] | null>(null);            // active session's live transcript
  const [connecting, setConnecting] = useState(false);                 // provisioning/connecting a cloud runtime
  const [streaming, setStreaming] = useState(false);                   // a turn is in flight
  const streamAbortRef = useRef<AbortController | null>(null);          // aborts the in-flight turn (Stop)
  const renderPendRef = useRef(false);                                 // coalesces streaming re-renders to one per frame
  const [draft, setDraft] = useState('');                              // composer input
  const [pending, setPending] = useState<PendingPrompt | null>(null);  // parked approval/ask
  const convoRef = useRef<Message[]>([]);                              // source of truth for the transcript
  const [selectorAt, setSelectorAt] = useState<'sections' | 'loop' | 'models' | null>(null);
  const [permOpen, setPermOpen] = useState(false);
  const [loops, setLoops] = useState<LoopItem[] | null>(null);
  const [loop, setLoop] = useState<string>('');                        // selected loop slug
  const [roles, setRoles] = useState<RoleItem[] | null>(null);         // resolved roles for `loop`
  const [roleSel, setRoleSel] = useState<Record<string, string>>({});  // per-role model override
  const [models, setModels] = useState<ModelChoice[]>([]);             // available() pool (labels + fallback)
  // Permission mode persists — a refresh must NOT silently revert the user's
  // choice (e.g. Auto) back to the default and start prompting again.
  const [perm, setPermState] = useState(() => { try { return localStorage.getItem('yoPerm') || 'acceptEdits'; } catch { return 'acceptEdits'; } });
  const setPerm = (v: string) => { setPermState(v); try { localStorage.setItem('yoPerm', v); } catch { /* */ } };
  const [search, setSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Focus synchronously inside the tap so iOS raises the keyboard.
  const openSearch = () => { haptic(); searchInputRef.current?.focus(); setSearch(true); };
  const closeSearch = () => { haptic(); searchInputRef.current?.blur(); setSearch(false); };
  // Chip labels derive from the resolved roles + the selected loop.
  const roleList = roles ?? [];
  const effModel = (r: RoleItem) => roleSel[r.name] ?? r.modelId ?? '';
  const modelNameById = (id: string) => {
    if (!id) return '';
    for (const r of roleList) { const c = r.choices.find((x) => x.id === id); if (c) return c.name; }
    return models.find((m) => m.id === id)?.name ?? shortModelId(id);
  };
  const loopName = (loops ?? []).find((l) => l.slug === loop)?.name ?? '';
  const modelSummary = roleList.length
    ? (roleList.length > 1 ? `${modelNameById(effModel(roleList[0]))} +${roleList.length - 1}` : modelNameById(effModel(roleList[0])))
    : '';
  // ── Conversation transcript + streaming (chats run on a cloud pod) ──────────
  const renderConvo = () => setMsgs([...convoRef.current]);
  // Streaming can fire deltas faster than a frame; coalesce to one paint per rAF
  // so markdown re-lexing doesn't jank the scroll. Non-streaming callers use
  // renderConvo directly (immediate).
  const renderThrottled = () => {
    if (renderPendRef.current) return;
    renderPendRef.current = true;
    requestAnimationFrame(() => { renderPendRef.current = false; renderConvo(); });
  };
  // The current space decides the session mode (Chat / Work / Code toolset).
  const curMode: 'chat' | 'cowork' | 'code' = active === 'work' ? 'cowork' : active === 'code' ? 'code' : 'chat';

  /** Persist the live transcript back to the thread (LWW by updatedAt), then
   *  refresh the list so the chat surfaces with its new title/timestamp. */
  const persistThread = async (id: string) => {
    try {
      const messages = convoRef.current.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text }));
      const title = convoRef.current.find((m) => m.role === 'user')?.text?.slice(0, 60) || 'New chat';
      await glyphh().sessions.pushThread(id, { title, mode: curMode, messages, updatedAt: Date.now() });
      const t = await glyphh().sessions.threads();
      setThreads(Array.isArray(t) ? t : []);
    } catch { /* offline / not-ready — the transcript stays local for now */ }
  };

  /** Open a chat: load its transcript, and (chats are cloud) eagerly connect its
   *  runtime if it isn't committed yet — the connecting spinner rides that. */
  const loadSession = (s: Recent) => {
    convoRef.current = []; setMsgs(null);
    glyphh().sessions.thread(s.id)
      .then((t: { messages?: ThreadMsg[] }) => { convoRef.current = (t.messages ?? []).map(normalizeMsg); renderConvo(); })
      .catch(() => { convoRef.current = []; renderConvo(); });
    // Connect the runtime the moment the session opens (every mode) — so the turn
    // is instant and the user sees an honest "connecting" state up front instead
    // of a stall on their first submit.
    const chat = chatFor(s.id); chat.mode = curMode;
    if (!isCommitted(s.id)) {
      setConnecting(true);
      void ensureRuntime(chat, () => {}, { rotor: loop }).then(() => setConnecting(false)).catch(() => setConnecting(false));
    } else { setConnecting(false); }
  };

  /** Send the composer draft — minting the chat on the first message, then
   *  streaming the agent's reply into the transcript. */
  const sendPrompt = async (override?: string, opts?: { noUserBubble?: boolean }) => {
    const prompt = (override ?? draft).trim();
    // Images only ride a fresh composer send (not retry/edit-resend).
    const imgs = override === undefined ? attachImgs.map((a) => ({ mediaType: a.mediaType, data: a.data })) : [];
    const imgUrls = override === undefined ? attachImgs.map((a) => a.url) : [];
    if ((!prompt && imgs.length === 0) || streaming) return;
    haptic(); if (override === undefined) { setDraft(''); setAttachImgs([]); } setPending(null);
    let sess = session;
    if (!sess) {
      const id = 'c' + Date.now().toString(36);
      sess = { id, title: prompt.slice(0, 60), when: 'now' };
      setSession(sess); setScreen('session'); setDrawer(false);
      convoRef.current = [];
      setThreads((t) => [{ id, title: sess!.title, mode: curMode, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }, ...(t ?? [])]);
    }
    const asstId = 'a' + Date.now().toString(36);
    const userMsg: Message = { id: 'u' + Date.now().toString(36), role: 'user', text: prompt, ...(imgUrls.length ? { images: imgUrls } : {}) };
    const asstMsg: Message = { id: asstId, role: 'glyphh', text: '' };
    convoRef.current = [...convoRef.current, ...(opts?.noUserBubble ? [] : [userMsg]), asstMsg];
    renderConvo();
    const setAsst = (text: string) => { const m = convoRef.current.find((x) => x.id === asstId); if (m) { m.text = text; renderThrottled(); } };
    // Fold a tool frame into the assistant turn's steps: start pushes a running
    // row; done finalises the most recent running row of that name (✓/✕ + diff).
    const applyTool = (t: { name: string; phase: 'start' | 'done'; status: 'running' | 'ok' | 'denied' | 'failed'; thought?: string; title?: string; diff?: string; error?: string }) => {
      const m = convoRef.current.find((x) => x.id === asstId);
      if (!m) return;
      const steps = (m.steps ??= []);
      if (t.phase === 'start') {
        steps.push({ name: t.name, status: 'running', ...(t.thought ? { thought: t.thought } : {}) });
      } else {
        let idx = -1;
        for (let i = steps.length - 1; i >= 0; i--) { if (steps[i].name === t.name && steps[i].status === 'running') { idx = i; break; } }
        const target = idx >= 0 ? steps[idx] : (steps.push({ name: t.name, status: 'running' }), steps[steps.length - 1]);
        target.status = t.status;
        if (t.title) target.title = t.title;
        if (t.diff) target.diff = t.diff;
        if (t.error) target.error = t.error;
        if (t.thought && !target.thought) target.thought = t.thought;
      }
      setConnecting(false); renderThrottled();
    };
    setConnecting(!isCommitted(sess.id));
    setStreaming(true);
    const ac = new AbortController();
    streamAbortRef.current = ac;
    const turnStart = Date.now();
    let creditsMicro = 0;
    // Design (top-down): a chat turn rides the cloud rrotor carrying the LOOP
    // (rotor), the MODEL, and the PERMISSION mode. Chat is tool-less → one model
    // (the selected role's), the value the /run body's `model` field takes.
    const r0 = roleList[0];
    const model = r0 ? (roleSel[r0.name] ?? r0.modelId ?? '') : '';
    const chat = chatFor(sess.id); chat.mode = curMode;   // Chat / Work / Code toolset
    const outcome = await runRemoteTurn(
      chat, prompt, () => {},
      {
        onToken: () => setConnecting(false),
        onAnswer: (full) => { setConnecting(false); setAsst(full); },
        onStep: () => setConnecting(false),
        onTool: applyTool,
        onUsage: (u) => { if (typeof u.creditsMicro === 'number') creditsMicro = u.creditsMicro; },
        onApproval: (a) => { setConnecting(false); setPending({ t: 'approval', ...a }); },
        onAsk: (a) => { setConnecting(false); setPending({ t: 'ask', ...a }); },
        onDone: (full) => { setConnecting(false); setPending(null); if (full) setAsst(full); },
        onError: (detail) => { setConnecting(false); setPending(null); setAsst('⚠️ ' + detail); },
        onStopped: () => { setConnecting(false); setPending(null); },
      },
      { rotor: loop, ...(model ? { model } : {}), ...(imgs.length ? { images: imgs } : {}), permission: perm as RemotePermission, signal: ac.signal },
    );
    setStreaming(false); setConnecting(false);
    streamAbortRef.current = null;
    // Per-turn footer: credits the runtime metered + wall-clock. Only stamp a
    // real turn (not an unavailable outcome).
    const settled = convoRef.current.find((x) => x.id === asstId);
    if (settled && !(outcome && typeof outcome === 'object' && 'unavailable' in outcome)) {
      settled.meta = { ...(creditsMicro ? { creditsMicro } : {}), ms: Date.now() - turnStart };
    }
    // Honest diagnosis: an unavailable stage names WHERE + probes the runtime.
    if (outcome && typeof outcome === 'object' && 'unavailable' in outcome) {
      const o = outcome as { stage: string; detail: string };
      const url = chatFor(sess.id).runtime?.url;
      const probe = await probeRuntime(url);
      setAsst(unavailMessage(o.stage, o.detail, url, probe));
    }
    renderConvo();
    void persistThread(sess.id);
  };

  // Regenerate the last turn: drop everything after the last user message and
  // re-run it (no new user bubble).
  const regenerate = () => {
    if (streaming) return;
    const conv = convoRef.current;
    let i = conv.length - 1;
    while (i >= 0 && conv[i].role !== 'user') i--;
    if (i < 0) return;
    const userText = conv[i].text;
    convoRef.current = conv.slice(0, i + 1);
    renderConvo();
    void sendPrompt(userText, { noUserBubble: true });
  };
  // Edit & resend a user message: rewind the transcript to just before it and
  // drop its text into the composer to edit, then send.
  const editResend = (m: Message) => {
    const conv = convoRef.current;
    const idx = conv.findIndex((x) => x.id === m.id);
    if (idx < 0) return;
    convoRef.current = conv.slice(0, idx);
    renderConvo();
    setDraft(m.text);
  };
  // Quote a message into the composer as a Markdown blockquote.
  const quoteMsg = (m: Message) => {
    const q = m.text.split('\n').map((l) => `> ${l}`).join('\n');
    setDraft((d) => (d.trim() ? `${d}\n${q}\n\n` : `${q}\n\n`));
  };
  // Read chosen/pasted images into base64 vision attachments (pod caps: 8/turn,
  // ~7.5 MiB each, png/jpeg/gif/webp).
  const addImageFiles = (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => /^image\/(png|jpe?g|gif|webp)$/.test(f.type) && f.size <= 7.3 * 1024 * 1024);
    arr.forEach((f, i) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || '');
        const data = url.slice(url.indexOf(',') + 1);
        if (!data) return;
        setAttachImgs((cur) => cur.length >= 8 ? cur : [...cur, { id: `im-${Date.now().toString(36)}-${i}-${f.size}`, mediaType: f.type, data, url, name: f.name || 'image' }]);
      };
      reader.readAsDataURL(f);
    });
  };

  // Answer (or dismiss on deadline) a parked approval/ask via the answer seam.
  const resolvePending = (reply: { allow?: boolean; answers?: string[] } | null) => {
    setPending((p) => { if (p && reply) void answerPending(p.id, reply); return null; });
  };

  const comp: CompProps = {
    onPlus: () => { haptic(); setAttach(true); },
    onOpenSelector: (s) => { haptic(); if (s === 'permission') setPermOpen(true); else setSelectorAt(s); },
    permLabel: PERMS.find((p) => p.id === perm)?.name ?? 'Accept edits',
    modelSummary,
    loopName,
    draft, setDraft,
    onSend: () => { void sendPrompt(); },
    onStop: () => { haptic(); streamAbortRef.current?.abort(); },
    sending: streaming,
    connecting,
    mode: curMode,
    onDictate: (text) => setDraft((d) => (d.trim() ? `${d} ${text}` : text)),
    attachments: attachImgs,
    onRemoveAttachment: (id) => setAttachImgs((cur) => cur.filter((a) => a.id !== id)),
    onPasteFiles: addImageFiles,
  };

  // Code/Work header subtitle — WHERE the session runs (cloud / repo / desktop).
  const sessionSubtitle: { icon: IconName; text: string } | undefined = (() => {
    if (!session || curMode === 'chat') return undefined;
    const src = chatFor(session.id).source;
    if (src?.kind === 'cloud-repo' && src.repo) return { icon: 'cloud', text: `Cloud · ${src.repo.split('/').pop()}` };
    if (src?.kind === 'local') { const d = desktops.find((x) => x.id === src.machineId); return { icon: 'laptop', text: d?.name || d?.app || 'Local machine' }; }
    return { icon: 'cloud', text: 'Cloud' };
  })();

  // Hold the splash for its full beat regardless of how fast auth resolves.
  // Also tint Safari's chrome to the live theme (kills the grey bottom-bar band).
  useEffect(() => {
    syncThemeColor();
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

  // Load loops + available models once signed in; pick a default loop.
  useEffect(() => {
    if (authState !== 'in') return;
    let on = true;
    glyphh().loops.list()
      .then((r: { loops: LoopItem[] }) => { if (!on) return; const ls = r?.loops ?? []; setLoops(ls); setLoop((cur) => cur || defaultLoopSlug(ls)); })
      .catch(() => { if (on) setLoops([]); });
    glyphh().models.available()
      .then((m: ModelChoice[]) => { if (on) setModels(Array.isArray(m) ? m : []); })
      .catch(() => { if (on) setModels([]); });
    return () => { on = false; };
  }, [authState]);

  // Resolve the selected loop's role/model slots; reset overrides on switch.
  useEffect(() => {
    if (!loop) { setRoles(null); return; }
    let on = true;
    setRoles(null); setRoleSel({});
    glyphh().loops.roles(loop)
      .then((rs: RoleItem[]) => { if (on) setRoles(Array.isArray(rs) && rs.length ? rs : [{ name: 'agent', label: 'Agent', modelId: null, choices: [] }]); })
      .catch(() => { if (on) setRoles([{ name: 'agent', label: 'Agent', modelId: null, choices: [] }]); });
    return () => { on = false; };
  }, [loop]);

  // Load the user's chat threads once signed in (feeds the rail + chats list).
  useEffect(() => {
    if (authState !== 'in') return;
    let on = true;
    glyphh().sessions.threads()
      .then((t: ThreadMeta[]) => { if (on) setThreads(Array.isArray(t) ? t : []); })
      .catch(() => { if (on) setThreads([]); });
    // Attached desktops (Code strip) — a browser can LIST them via attach.status().
    glyphh().attach.status()
      .then((s: { machines?: AttachedMachine[] }) => { if (on) setDesktops(Array.isArray(s?.machines) ? s.machines : []); })
      .catch(() => { if (on) setDesktops([]); });
    return () => { on = false; };
  }, [authState]);
  const pinnedFirst = (arr: Recent[]) => [...arr].sort((a, b) => (pins.has(b.id) ? 1 : 0) - (pins.has(a.id) ? 1 : 0));
  const chatRecents = pinnedFirst(threadsFor(threads, 'chat'));
  const workGroups = groupThreadsByTime(threads, 'cowork');   // Work = cowork threads, time-grouped
  const codeRecents = threadsFor(threads, 'code');            // Code = code threads

  const toggleDrawer = () => { haptic(); setDrawer((d) => !d); };
  const selectSpace = (id: SpaceId) => { haptic(); setActive(id); setScreen('list'); setSession(null); setDrawer(false); };
  const openSession = (s: Recent) => { haptic(); setSession(s); setScreen('session'); setDrawer(false); loadSession(s); };
  const openRecent = (r: Recent) => openSession(r);
  const allChats = () => { haptic(); setScreen('list'); setDrawer(false); };
  const backToList = () => { haptic(); setScreen('list'); };
  const savePins = (s: Set<string>) => { setPins(new Set(s)); try { localStorage.setItem('yoPins', JSON.stringify([...s])); } catch { /* */ } };
  const togglePin = (id: string) => { const s = new Set(pins); if (s.has(id)) s.delete(id); else s.add(id); savePins(s); };
  const deleteSession = async (s: Recent) => {
    try { await glyphh().sessions.deleteThread(s.id); } catch { /* best effort */ }
    remoteChats.delete(s.id);
    setThreads((t) => (t ?? []).filter((x) => x.id !== s.id));
    if (pins.has(s.id)) { const p = new Set(pins); p.delete(s.id); savePins(p); }
    backToList();
  };
  const account = () => { haptic(); setSettings(true); };  /* leave the rail open behind the sheet */
  const clearConvo = () => { convoRef.current = []; setMsgs(null); setConnecting(false); setDraft(''); setPending(null); };
  const newChat = () => { haptic(); setActive('chat'); setScreen('home'); setSession(null); clearConvo(); setDrawer(false); };
  const newSession = () => { haptic(); setScreen('home'); setSession(null); clearConvo(); setDrawer(false); };
  /** Tap a connected desktop → start a new session BOUND to that machine.
   *  The source is `local` (machineId), threaded into the same runRemoteTurn
   *  provisioning app-web uses: cloud today (web-deferred), the attached box
   *  when the relay seam lands — mobile inherits it for free. */
  const startDesktopSession = (d: AttachedMachine) => {
    haptic();
    const id = 'c' + Date.now().toString(36);
    const chat = chatFor(id);
    chat.mode = curMode;
    chat.source = { kind: 'local', machineId: d.id, path: '' };
    setSession({ id, title: 'New session', when: 'now' });
    setScreen('session'); setDrawer(false); clearConvo();
  };

  // Remember where the user was (space / screen / open session) so a reload lands
  // them back there instead of resetting to the Chat home.
  useEffect(() => {
    if (authState !== 'in') return;
    try { localStorage.setItem('yoNav', JSON.stringify({ active, screen, session: session ? { id: session.id, title: session.title, when: session.when } : null })); } catch { /* */ }
  }, [authState, active, screen, session]);
  const restoredRef = useRef(false);
  useEffect(() => {
    if (authState !== 'in' || restoredRef.current) return;
    restoredRef.current = true;
    try {
      const nav = JSON.parse(localStorage.getItem('yoNav') || 'null') as { active?: SpaceId; screen?: string; session?: Recent | null } | null;
      if (!nav) return;
      if (nav.active) setActive(nav.active);
      if (nav.session && nav.screen === 'session') openSession(nav.session);
      else if (nav.screen === 'list') setScreen('list');
    } catch { /* */ }
  }, [authState]);

  const showSplash = !minSplash || authState === 'checking';

  return (
    <div className="m-app" data-drawer={drawer ? 'open' : 'closed'}>
      {/* Signed out → the login surface (once the splash beat is done). */}
      {authState === 'out' && !showSplash && <Login onSignedIn={onSignedIn} />}

      {/* Signed in → the app. */}
      {authState === 'in' && (
      <>
      <div className="m-shell">
        <Rail active={active} onSelect={selectSpace} onOpenRecent={openRecent} recents={chatRecents.slice(0, 12)} onAllChats={allChats} onAccount={account} onNewChat={newChat} user={user} />
        <main className="m-main">
          {screen === 'home' && (
            <div className="m-home">
              {/* Same transparent chats-style header + a centered loop / model dropdown. */}
              <div className="m-chats-fade m-chats-fade-top" />
              <header className="m-chats-head m-home-head">
                <button className="m-chats-icon" aria-label="Open menu" onClick={toggleDrawer}><Icon name="menu" /></button>
                <div className="m-home-center">
                  {/* Chat picks loop/model on the composer chip; Work/Code keep the top dropdown. */}
                  {active !== 'chat' && (
                    <button className="m-home-loop" onClick={() => comp.onOpenSelector('sections')}>
                      <span>{comp.loopName} / {comp.modelSummary}</span>
                      <Icon name="caret" />
                    </button>
                  )}
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
                    ? <CodeView desktops={desktops} sessions={codeRecents} loading={threads === null} onMenu={toggleDrawer} onOpen={openSession} onOpenDesktop={startDesktopSession} onNewSession={newSession} onSearch={openSearch} />
                    : active === 'work'
                    ? <WorkView desktops={desktops} groups={workGroups} loading={threads === null} onMenu={toggleDrawer} onOpen={openSession} onOpenDesktop={startDesktopSession} onNewTask={newSession} onSearch={openSearch} />
                    : <ChatsView title={NAV.find((n) => n.id === active)?.label ?? 'Chats'} sessions={chatRecents} loading={threads === null} onMenu={toggleDrawer} onOpen={openSession} onNewChat={newChat} onSearch={openSearch} />}
                </section>
                <section className="m-nav-panel">
                  {session && <SessionView session={session} msgs={msgs} connecting={connecting} pinned={pins.has(session.id)} subtitle={sessionSubtitle} onBack={backToList} onDelete={() => deleteSession(session)} onTogglePin={() => togglePin(session.id)} onRetry={regenerate} onEditResend={editResend} onQuote={quoteMsg} comp={comp} />}
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
      <AttachMenu open={attach} onClose={() => { haptic(); setAttach(false); }}
        onCamera={() => cameraInputRef.current?.click()} onPhoto={() => photoInputRef.current?.click()} />
      {/* Hidden pickers — camera capture vs the photo library. */}
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" hidden
        onChange={(e) => { const f = (e.target as HTMLInputElement).files; if (f) addImageFiles(f); (e.target as HTMLInputElement).value = ''; }} />
      <input ref={photoInputRef} type="file" accept="image/*" multiple hidden
        onChange={(e) => { const f = (e.target as HTMLInputElement).files; if (f) addImageFiles(f); (e.target as HTMLInputElement).value = ''; }} />
      <SelectorSheet
        open={selectorAt !== null}
        section={selectorAt === 'sections' ? null : selectorAt}
        onClose={() => { haptic(); setSelectorAt(null); }}
        loops={loops} loop={loop} setLoop={setLoop}
        roles={roles} roleSel={roleSel} setRoleSel={setRoleSel}
        models={models}
      />
      <PermissionSheet open={permOpen} onClose={() => { haptic(); setPermOpen(false); }} perm={perm} setPerm={setPerm} />
      <SearchOverlay open={search} inputRef={searchInputRef} onClose={closeSearch} />
      {pending && <AgentPrompt pending={pending} onResolve={resolvePending} />}
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
