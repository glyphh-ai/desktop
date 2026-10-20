/**
 * notify.ts — a notification meets the member's say (his order, 2026-10-05).
 *
 * The host hands every notification here through `window.glyphh.onNotify`:
 * on the desktop, main's notify.ts (a cloud app's `notify.show` down the
 * attach link, a local app's `notify.send` from this host); on the web, the
 * `notify` push on the relay socket (web/src/notify-web.js). One document
 * answers — the workbench, never a solo tool window.
 *
 *   pref "on"  → shown: the OS notification on the desktop (click focuses
 *                the app); on the web the in-app toast, and the browser's
 *                own notification once the member granted it.
 *   pref "ask" → a toast where the notification would have shown: "<App>
 *                wants to notify you", Allow, and "Don't ask me again".
 *                Allow turns the pref on and shows it; dismissed with the
 *                box checked turns the pref off. One ask at a time: what
 *                arrives meanwhile waits on that answer.
 *   pref "off" → nothing (the server keeps the row).
 */

import { toast, toastInfo, type ToastHandle } from "./toast.js";
import { onWeb } from "./web-surface.js";
import {
  NOTIFY_PREF, NOTIFY_PREF_CHANGED_EVENT, NOTIFY_PREF_DEFAULT, afterAsk, askLine, notifyAction, readNotifyPref,
  type AskAnswer, type IncomingNotification, type NotifyPref,
} from "./notify-pref.js";

interface NotifyHost {
  getPreference: (key: string, defaultVal?: unknown) => Promise<unknown>;
  setPreference: (key: string, value: unknown) => void;
  onNotify?: (cb: (n: IncomingNotification) => void) => () => void;
  notifyShow?: (n: IncomingNotification) => Promise<{ shown: boolean }>;
}

const host = (): NotifyHost => window.glyphh as unknown as NotifyHost;

async function currentPref(): Promise<NotifyPref> {
  try {
    return readNotifyPref(await host().getPreference(NOTIFY_PREF, NOTIFY_PREF_DEFAULT));
  } catch {
    return NOTIFY_PREF_DEFAULT;
  }
}

/** Write the pref and tell this document's settings control, if it is open. */
export function writeNotifyPref(pref: NotifyPref): void {
  host().setPreference(NOTIFY_PREF, pref);
  document.dispatchEvent(new CustomEvent(NOTIFY_PREF_CHANGED_EVENT, { detail: { pref } }));
}

/** Show it: the host's notification, and on the web the in-app line too. */
export async function showNotification(n: IncomingNotification): Promise<void> {
  if (onWeb()) toastInfo(n.title, n.body ? { detail: n.body } : {});
  try {
    await host().notifyShow?.(n);
  } catch { /* no OS/browser notification: the toast (web) already said it */ }
}

// ── the ask ─────────────────────────────────────────────────────────────────
let asking: ToastHandle | null = null;
const waiting: IncomingNotification[] = [];

function settle(answer: AskAnswer, first: IncomingNotification): void {
  const r = afterAsk(answer, asking?.checked() ?? false);
  asking = null;
  const held = waiting.splice(0);
  if (r.pref) writeNotifyPref(r.pref);
  if (!r.deliver) return;
  for (const n of [first, ...held]) void showNotification(n);
}

/** The toast that asks, where the notification would have shown. */
export function askToNotify(n: IncomingNotification): void {
  if (asking) {
    waiting.push(n);
    return;
  }
  asking = toast(askLine(n.app), {
    kind: "info",
    detail: n.title,
    timeoutMs: 0,
    check: { label: "Don't ask me again" },
    action: { label: "Allow", onPick: () => settle("allow", n) },
    onDismiss: () => settle("dismiss", n),
  });
}

/** A notification arrived: the decision table decides. */
export async function handleNotification(n: IncomingNotification): Promise<void> {
  switch (notifyAction(await currentPref())) {
    case "deliver": return showNotification(n);
    case "ask": return askToNotify(n);
    case "drop": return;
  }
}

/** Listen on the host's door. The workbench document only: a solo tool
 *  window is home.html too, and would show every notification twice. */
export function installNotifications(): void {
  if (/[?&]solo=/.test(location.search)) return;
  host().onNotify?.((n) => { void handleNotification(n); });
}
