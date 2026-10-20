/**
 * notify-web.js — the web's door for a cloud app's notification (his order,
 * 2026-10-05). The server fans a notification out to every open `/ws/panel`
 * socket of the member as a push on the `notify` channel (attach.notify_user),
 * so the tab keeps ONE such socket up for the life of the page — the same
 * envelope the streamed panel and the remote terminal ride (relay-socket.ts),
 * opened for nothing else. Signed out, or the socket refused: wait and dial
 * again, backoff-capped; a disconnect dials again the same way.
 *
 * What the workbench decides to show (renderer/help/notify.ts) comes back as
 * `notifyShow`: the browser's own notification, once the member granted it
 * (`notifyPrepare`, asked on the Settings control's click, the gesture a
 * browser wants).
 */

import { connectRelaySocket } from '../../src/renderer/relay-socket.ts';

const FIRST_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const TITLE_MAX = 120;
const BODY_MAX = 500;

/** The push's data as the workbench takes it; null for anything else on the channel. */
export function notificationOf(data) {
  if (!data || typeof data !== 'object' || data.type !== 'notify' || typeof data.title !== 'string' || !data.title) return null;
  return {
    ...(typeof data.id === 'string' && data.id ? { id: data.id } : {}),
    app: String(data.app || 'An app').slice(0, TITLE_MAX),
    title: data.title.slice(0, TITLE_MAX),
    body: String(data.body || '').slice(0, BODY_MAX),
    source: 'cloud',
  };
}

/** The browser's permission as the contract reads it: granted, or not. */
export const browserNotificationsGranted = (permission) => permission === 'granted';

/**
 * Keep a relay socket up and hand every `notify` push to `cb`. Returns the stop.
 * `token()` resolves the member's bearer (null signed out); `connect` is the
 * relay-socket client (injected for tests).
 */
// the window's timers, bound: a bare `setTimeout` in an object is called with
// that object as `this` and throws "Illegal invocation" in the browser
const WINDOW_TIMERS = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };

export function watchNotifications(token, cb, connect = connectRelaySocket, timers = WINDOW_TIMERS) {
  let stopped = false;
  let backoff = FIRST_BACKOFF_MS;
  let timer = null;
  let sock = null;

  const later = () => {
    if (stopped) return;
    timer = timers.setTimeout(() => { timer = null; void dial(); }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };

  const dial = async () => {
    if (stopped) return;
    let t = null;
    try { t = await token(); } catch { t = null; }
    if (!t) { later(); return; }
    try {
      sock = await connect(t);
    } catch {
      later();
      return;
    }
    if (stopped) { sock.close(); return; }
    backoff = FIRST_BACKOFF_MS;
    sock.onPush('notify', (_channel, data) => {
      const n = notificationOf(data);
      if (n) cb(n);
    });
    sock.onClose(() => { sock = null; later(); });
  };

  void dial();
  return () => {
    stopped = true;
    if (timer !== null) timers.clearTimeout(timer);
    sock?.close();
    sock = null;
  };
}

/** The browser's own notification, when granted; a click fronts the tab. */
export function showBrowserNotification(n, win = typeof window !== 'undefined' ? window : null) {
  const Note = win?.Notification;
  if (!Note || !browserNotificationsGranted(Note.permission)) return { shown: false };
  try {
    const note = new Note(n.title, n.body ? { body: n.body } : {});
    note.onclick = () => { try { win.focus(); } catch { /* a tab the browser will not front */ } note.close(); };
    return { shown: true };
  } catch {
    return { shown: false };
  }
}

/** Ask the browser, from the member's click. True once granted. */
export async function askBrowserNotificationPermission(win = typeof window !== 'undefined' ? window : null) {
  const Note = win?.Notification;
  if (!Note) return false;
  if (browserNotificationsGranted(Note.permission)) return true;
  if (Note.permission === 'denied') return false;
  try {
    return browserNotificationsGranted(await Note.requestPermission());
  } catch {
    return false;
  }
}
