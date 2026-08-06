/**
 * Browser error pages — what a Glyphh browser panel shows when a page does not
 * arrive.
 *
 * Chromium hands us two very different failures and the panel used to swallow
 * both into a blank rectangle:
 *   - a NET error (negative code): the request never completed, so there is no
 *     document at all;
 *   - an HTTP status (4xx/5xx): the server answered, just not with a page.
 * Either one resolves to a named kind here, with its own mascot, icon and
 * wording, so "can't reach it", "you're signed out" and "their server broke"
 * stop looking identical.
 *
 * The page renders inside the guest as a data: URL, which cannot see the host's
 * CSS variables — so the caller passes the resolved theme colours in and every
 * value is inlined.
 */

import { mascotSvg, type MascotKey } from "./help/mascots.js";

/** Theme colours, already resolved from the host document's custom properties. */
export interface ErrorPalette {
  bg: string;
  surface: string;
  border: string;
  text: string;
  dim: string;
  accent: string;
  danger: string;
  warning: string;
}

export interface BrowserErrorInfo {
  /** The address that failed — shown, and what "Try again" points at. */
  url: string;
  /** Chromium net error (negative) when the request itself failed. */
  errorCode?: number;
  /** Chromium's description, when it gave one. */
  description?: string;
  /** HTTP status when the server answered 4xx/5xx. */
  status?: number;
  statusText?: string;
}

type IconKey =
  | "notFound" | "locked" | "server" | "gateway" | "unavailable"
  | "clock" | "hourglass" | "offline" | "dns" | "plug"
  | "shield" | "frame" | "alert" | "desktop";

interface Kind {
  icon: IconKey;
  mascot: MascotKey;
  mascotName: string;
  title: string;
  detail: string;
  /** Their fault / transient (warning) vs broken (danger) — tints the badge. */
  tone: "warn" | "bad";
}

// ── Icons: 24×24 stroke glyphs, same family as the workbench chrome ──

const ICONS: Record<IconKey, string> = {
  notFound: `<circle cx="11" cy="11" r="7"/><line x1="16.2" y1="16.2" x2="21" y2="21"/><line x1="8.6" y1="11" x2="13.4" y2="11"/>`,
  locked: `<rect x="4" y="10.5" width="16" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/><line x1="12" y1="14.5" x2="12" y2="17"/>`,
  server: `<rect x="3" y="4" width="18" height="7" rx="1.6"/><rect x="3" y="14" width="18" height="7" rx="1.6"/><line x1="7" y1="7.5" x2="7.01" y2="7.5"/><line x1="7" y1="17.5" x2="7.01" y2="17.5"/><line x1="15" y1="17.5" x2="18" y2="17.5"/>`,
  gateway: `<path d="M9.5 14.5 5.7 18.3a3.8 3.8 0 0 1-5.4-5.4l2.4-2.4"/><path d="M14.5 9.5l3.8-3.8a3.8 3.8 0 0 1 5.4 5.4l-2.4 2.4"/><line x1="9" y1="15" x2="15" y2="9"/>`,
  unavailable: `<path d="M18.4 5.6a9 9 0 1 1-12.8 0"/><line x1="12" y1="2.5" x2="12" y2="11"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><polyline points="12 6.8 12 12 15.6 14"/>`,
  hourglass: `<path d="M7 3h10"/><path d="M7 21h10"/><path d="M8 3v3.6a4 4 0 0 0 1.5 3.1L12 12l-2.5 2.3A4 4 0 0 0 8 17.4V21"/><path d="M16 3v3.6a4 4 0 0 1-1.5 3.1L12 12l2.5 2.3a4 4 0 0 1 1.5 3.1V21"/>`,
  offline: `<path d="M2 8.8a17 17 0 0 1 6.2-3.4"/><path d="M15.4 5.3A17 17 0 0 1 22 8.8"/><path d="M5.5 12.5a12 12 0 0 1 3.2-2"/><path d="M15.2 10.4a12 12 0 0 1 3.3 2.1"/><path d="M9 16.2a6 6 0 0 1 5.9 0"/><line x1="12" y1="20" x2="12.01" y2="20"/><line x1="3" y1="3" x2="21" y2="21"/>`,
  // Kept deliberately sparse — meridians and latitudes both would silt up at
  // the 16px the badge renders it at.
  dns: `<circle cx="12" cy="12" r="9"/><path d="M3.2 12h17.6"/><path d="M12 3a14 14 0 0 1 0 18"/><line x1="4.5" y1="4.5" x2="19.5" y2="19.5"/>`,
  plug: `<path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z"/><path d="M12 17v5"/>`,
  shield: `<path d="M12 2.6 20 6v6c0 5-3.4 8.2-8 9.4C7.4 20.2 4 17 4 12V6z"/><line x1="12" y1="8.4" x2="12" y2="13"/><line x1="12" y1="16.2" x2="12.01" y2="16.2"/>`,
  frame: `<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="4" y1="20" x2="20" y2="4"/>`,
  alert: `<path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9.4" x2="12" y2="13.6"/><line x1="12" y1="17.2" x2="12.01" y2="17.2"/>`,
  desktop: `<rect x="2.5" y="4" width="19" height="12" rx="2"/><line x1="8.5" y1="20" x2="15.5" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/><line x1="3.5" y1="3" x2="20.5" y2="17"/>`,
};

// ── Net errors: the codes a browser panel actually hits ──

const NET_NAMES: Record<number, string> = {
  [-2]: "ERR_FAILED",
  [-6]: "ERR_FILE_NOT_FOUND",
  [-7]: "ERR_TIMED_OUT",
  [-20]: "ERR_BLOCKED_BY_CLIENT",
  [-21]: "ERR_NETWORK_CHANGED",
  [-27]: "ERR_BLOCKED_BY_RESPONSE",
  [-100]: "ERR_CONNECTION_CLOSED",
  [-101]: "ERR_CONNECTION_RESET",
  [-102]: "ERR_CONNECTION_REFUSED",
  [-104]: "ERR_CONNECTION_FAILED",
  [-105]: "ERR_NAME_NOT_RESOLVED",
  [-106]: "ERR_INTERNET_DISCONNECTED",
  [-109]: "ERR_ADDRESS_UNREACHABLE",
  [-118]: "ERR_CONNECTION_TIMED_OUT",
  [-200]: "ERR_CERT_COMMON_NAME_INVALID",
  [-201]: "ERR_CERT_DATE_INVALID",
  [-202]: "ERR_CERT_AUTHORITY_INVALID",
  [-300]: "ERR_INVALID_URL",
  [-324]: "ERR_EMPTY_RESPONSE",
};

function netKind(code: number, host: string): Kind {
  switch (code) {
    case -105:
    case -300:
      return { icon: "dns", mascot: "post", mascotName: "Post", tone: "warn",
        title: "Can't find that site",
        detail: `Nothing answers to ${host}. Check the address for a typo, or the site may have moved.` };
    case -106:
    case -21:
      return { icon: "offline", mascot: "post", mascotName: "Post", tone: "warn",
        title: "You're offline",
        detail: "This machine has no route to the internet right now. Reconnect and try again." };
    case -102:
    case -104:
    case -109:
    case -100:
    case -101:
    case -324:
      return { icon: "plug", mascot: "post", mascotName: "Post", tone: "warn",
        title: "Connection refused",
        detail: `${host} is reachable but turned the connection away. If it's a dev server, check that it's running on that port.` };
    case -7:
    case -118:
      return { icon: "clock", mascot: "sage", mascotName: "Sage", tone: "warn",
        title: "Took too long",
        detail: `${host} accepted the connection but never finished replying.` };
    case -200:
    case -201:
    case -202:
      return { icon: "shield", mascot: "byte", mascotName: "Byte", tone: "bad",
        title: "Certificate problem",
        detail: `The HTTPS certificate ${host} presented isn't valid, so the connection was stopped before any page loaded.` };
    case -20:
    case -27:
      return { icon: "frame", mascot: "byte", mascotName: "Byte", tone: "warn",
        title: "Refuses to be embedded",
        detail: `${host} sends headers that forbid loading it inside another app. Open it in a real browser window instead.` };
    case -6:
      return { icon: "notFound", mascot: "scout", mascotName: "Scout", tone: "warn",
        title: "File not found",
        detail: "That path doesn't exist on this machine any more." };
    default:
      return { icon: "alert", mascot: "patch", mascotName: "Patch", tone: "bad",
        title: "The page didn't load",
        detail: `The request to ${host} failed before a page came back.` };
  }
}

// ── HTTP statuses ──

function httpKind(status: number, host: string): Kind {
  switch (status) {
    case 401:
    case 407:
      return { icon: "locked", mascot: "tally", mascotName: "Tally", tone: "warn",
        title: "Sign-in required",
        detail: `${host} wants credentials before it will serve this page.` };
    case 403:
      return { icon: "locked", mascot: "tally", mascotName: "Tally", tone: "warn",
        title: "Forbidden",
        detail: "The server understood the request and refused it. This account may not have access." };
    case 404:
    case 410:
      return { icon: "notFound", mascot: "scout", mascotName: "Scout", tone: "warn",
        title: "Page not found",
        detail: `${host} has no page at this address. It may have moved or been deleted.` };
    case 408:
      return { icon: "clock", mascot: "sage", mascotName: "Sage", tone: "warn",
        title: "Request timed out",
        detail: "The server gave up waiting for the request to finish." };
    case 429:
      return { icon: "hourglass", mascot: "sage", mascotName: "Sage", tone: "warn",
        title: "Too many requests",
        detail: `${host} is rate-limiting this client. Wait a moment before retrying.` };
    case 502:
      return { icon: "gateway", mascot: "post", mascotName: "Post", tone: "bad",
        title: "Bad gateway",
        detail: "A proxy in front of the site got an invalid response from the server behind it." };
    case 503:
      return { icon: "unavailable", mascot: "patch", mascotName: "Patch", tone: "bad",
        title: "Service unavailable",
        detail: `${host} is down or overloaded. This is usually temporary.` };
    case 504:
      return { icon: "clock", mascot: "sage", mascotName: "Sage", tone: "bad",
        title: "Gateway timeout",
        detail: "A proxy in front of the site waited for the server behind it and gave up." };
    default:
      if (status >= 500) {
        return { icon: "server", mascot: "patch", mascotName: "Patch", tone: "bad",
          title: "Server error",
          detail: `${host} hit an error building this page. Nothing is wrong on this end.` };
      }
      return { icon: "alert", mascot: "scout", mascotName: "Scout", tone: "warn",
        title: "The server rejected that request",
        detail: `${host} answered, but not with a page.` };
  }
}

// ── Rendering ──

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Just the host, for wording — a full URL reads badly mid-sentence. */
function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url || "that address"; }
}

/** The status line under the title: "HTTP 404 · Not Found" or the net code. */
function codeLabel(info: BrowserErrorInfo): string {
  if (info.status) return `HTTP ${info.status}${info.statusText ? ` · ${info.statusText}` : ""}`;
  const code = info.errorCode ?? 0;
  return `${NET_NAMES[code] || info.description || "ERR_FAILED"} · ${code}`;
}

/** The big glyph beside the icon — the HTTP status, or the net code. */
function badgeText(info: BrowserErrorInfo): string {
  return info.status ? String(info.status) : String(info.errorCode ?? 0);
}

export function classifyBrowserError(info: BrowserErrorInfo): Kind {
  const host = hostOf(info.url);
  return info.status ? httpKind(info.status, host) : netKind(info.errorCode ?? 0, host);
}

/**
 * A translucent wash of a colour. color-mix rather than an appended hex alpha
 * because the same markup renders with literal hex (guest pages) and with
 * `var(--token)` references (host overlays), and "var(--danger)1f" is nonsense.
 */
const tint = (color: string, pct: number): string => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

interface CardParts {
  kind: Kind;
  /** The pill beside the icon — a status, a net code, or a short word. */
  badge: string;
  /** Monospace footnote under everything. Omitted when empty. */
  footnote?: string;
  /** Monospace block naming what failed (a URL). Omitted when empty. */
  subject?: string;
  /** Retry affordance: a link (guest pages) or a button (host overlays). */
  action?: { label: string; href?: string; attrs?: string };
}

/**
 * The card itself, styled entirely inline so one markup builder serves both a
 * standalone guest document and a fragment injected into the host DOM — an
 * injected <style> block would leak into the whole app.
 */
function errorCard(parts: CardParts, p: ErrorPalette, scale: number): string {
  const { kind } = parts;
  const tone = kind.tone === "bad" ? p.danger : p.warning;
  const mascot = mascotSvg({ name: kind.mascotName, key: kind.mascot, color: p.accent });
  const px = (n: number): string => `${Math.round(n * scale)}px`;
  const action = parts.action;
  const actionStyle =
    `display:inline-block;padding:8px 18px;border:0;border-radius:8px;cursor:pointer;` +
    `background:${p.accent};color:#fff;font:600 13px inherit;text-decoration:none`;

  return (
    `<div style="width:100%;max-width:420px;margin:0 auto;text-align:center;color:${p.text};` +
    `font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif">` +
    `<div style="width:${px(96)};height:${px(96)};margin:0 auto 14px">${mascot}</div>` +
    `<div style="display:inline-flex;align-items:center;gap:8px;padding:5px 12px 5px 10px;` +
    `border:1px solid ${tint(tone, 38)};border-radius:999px;background:${tint(tone, 12)};` +
    `color:${tone};font-size:13px;font-weight:600;letter-spacing:.02em;margin-bottom:14px">` +
    `<svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:currentColor;fill:none;` +
    `stroke-width:2;stroke-linecap:round;stroke-linejoin:round">${ICONS[kind.icon]}</svg>` +
    `${esc(parts.badge)}</div>` +
    `<div style="margin:0 0 8px;font-size:19px;font-weight:600;letter-spacing:-.01em">${esc(kind.title)}</div>` +
    `<div style="margin:0 0 18px;color:${p.dim};font-size:13.5px">${esc(kind.detail)}</div>` +
    (parts.subject
      ? `<div style="margin:0 auto 18px;padding:8px 12px;border:1px solid ${p.border};border-radius:8px;` +
        `background:${p.surface};color:${p.dim};font-family:ui-monospace,'SF Mono','JetBrains Mono',monospace;` +
        `font-size:11.5px;overflow-wrap:anywhere;text-align:left">${esc(parts.subject)}</div>`
      : "") +
    (action
      ? action.href
        ? `<a href="${esc(action.href)}" style="${actionStyle}">${esc(action.label)}</a>`
        : `<button type="button" ${action.attrs || ""} style="${actionStyle}">${esc(action.label)}</button>`
      : "") +
    (parts.footnote
      ? `<div style="margin:16px 0 0;font-family:ui-monospace,'SF Mono',monospace;font-size:11px;` +
        `color:${p.dim};opacity:.72;letter-spacing:.02em">${esc(parts.footnote)}</div>`
      : "") +
    `</div>`
  );
}

/**
 * The error page as a data: URL, ready for `webview.src`. The mascot wears the
 * theme's accent so the page belongs to whatever theme is active; only the
 * status badge takes the warning/danger tint.
 */
export function browserErrorPage(info: BrowserErrorInfo, p: ErrorPalette): string {
  const kind = classifyBrowserError(info);
  const card = errorCard({
    kind,
    badge: badgeText(info),
    subject: info.url || undefined,
    footnote: codeLabel(info),
    // Only http(s) can be retried by navigation — a file:// or blocked scheme
    // would just fail the same way.
    action: /^https?:\/\//i.test(info.url) ? { label: "Try again", href: info.url } : undefined,
  }, p, 1);

  const html =
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(kind.title)}</title>` +
    `<style>html,body{margin:0;height:100%}` +
    `body{display:flex;align-items:center;justify-content:center;padding:32px;` +
    `background:${p.bg};-webkit-font-smoothing:antialiased}` +
    `a:hover{filter:brightness(1.08)}</style></head>` +
    `<body>${card}</body></html>`;

  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

// ── Panel states: this machine, not the far end ─────────────────────────────
//
// A streamed panel runs the page in the user's OWN desktop session, so it has
// failure modes no HTTP status covers: the desktop isn't attached, the socket
// dropped, nobody is signed in. They used to render as two lines of grey text
// with no mascot and no way back — same family of problem, so the same card.

export type PanelStateKey = "desktop-offline" | "disconnected" | "signed-out" | "failed";

const PANEL_STATES: Record<PanelStateKey, { kind: Kind; badge: string }> = {
  "desktop-offline": {
    badge: "Offline",
    kind: {
      icon: "desktop", mascot: "post", mascotName: "Post", tone: "warn",
      title: "Desktop not connected",
      detail: "This app runs in your own browser session on your desktop. Open the Glyphh desktop app and sign in, then reopen this panel.",
    },
  },
  disconnected: {
    badge: "Dropped",
    kind: {
      icon: "plug", mascot: "post", mascotName: "Post", tone: "warn",
      title: "Desktop disconnected",
      detail: "The link to your desktop closed mid-session. It's still signed in — reconnecting usually picks straight back up.",
    },
  },
  "signed-out": {
    badge: "Sign in",
    kind: {
      icon: "locked", mascot: "tally", mascotName: "Tally", tone: "warn",
      title: "Sign in to view this panel",
      detail: "This panel streams from your own desktop session, so it needs an account before it can connect.",
    },
  },
  failed: {
    badge: "Error",
    kind: {
      icon: "alert", mascot: "patch", mascotName: "Patch", tone: "bad",
      title: "Couldn't open the panel",
      detail: "Your desktop is connected but refused to open this page.",
    },
  },
};

/**
 * Palette for a card injected into the HOST document, where the theme's custom
 * properties are live — no snapshot needed, and it re-themes with the app.
 */
export const CSS_VAR_PALETTE: ErrorPalette = {
  bg: "var(--bg, #101014)",
  surface: "var(--surface, #17171c)",
  border: "var(--border, #2a2a32)",
  text: "var(--text, #e6e6ea)",
  dim: "var(--text-3, #8a8a95)",
  accent: "var(--accent, #8c3bf2)",
  danger: "var(--danger, #ef4444)",
  warning: "var(--warning, #f59e0b)",
};

export interface PanelStateOpts {
  /** Extra line under the standard copy — e.g. the far side's own message. */
  detail?: string;
  /** Renders a retry button carrying these attributes (for a click handler). */
  retryAttrs?: string;
  /** Shrink the card for a small panel. 1 = the full-page size. */
  scale?: number;
}

/**
 * A panel state as an HTML FRAGMENT for the host document — not a data: URL.
 * The overlay it goes into already sits in the app's DOM, so colours stay as
 * `var(--token)` and follow a theme switch without a re-render.
 */
export function panelStateFragment(
  state: PanelStateKey,
  opts: PanelStateOpts = {},
  p: ErrorPalette = CSS_VAR_PALETTE,
): string {
  const base = PANEL_STATES[state];
  const kind = opts.detail ? { ...base.kind, detail: opts.detail } : base.kind;
  return errorCard({
    kind,
    badge: base.badge,
    action: opts.retryAttrs ? { label: "Try again", attrs: opts.retryAttrs } : undefined,
  }, p, opts.scale ?? 1);
}
