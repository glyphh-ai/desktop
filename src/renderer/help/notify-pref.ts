/**
 * notify-pref.ts — NOTIFICATIONS, the member's say (his order, 2026-10-05:
 * "a config that allows notifications for the user in app → settings general.
 * If not turned on the app should open a toast where they currently render
 * today, with a 'don't ask me again' checkbox. Then when enabled they need
 * to work.")
 *
 * One pref, shared by desktop and web, in the member's server prefs:
 *
 *   pref `notifications`: "on" | "off" | "ask"   (default "ask")
 *
 * A notification — a cloud app's over the attach link, a local app's from
 * this machine's host — meets the pref here: shown, asked about first, or
 * dropped (the row on the server stands either way). The table and the
 * "Don't ask me again" transition are pure (test/main/notify-pref.test.ts);
 * notify.ts paints the toast and shows the notification, settings.ts paints
 * the control.
 */

export const NOTIFY_PREF = "notifications";

export type NotifyPref = "on" | "off" | "ask";
export const NOTIFY_PREF_DEFAULT: NotifyPref = "ask";
export const NOTIFY_PREFS: readonly NotifyPref[] = ["ask", "on", "off"];

/** What the Settings → General control says for each value. */
export const NOTIFY_PREF_LABELS: Readonly<Record<NotifyPref, string>> = {
  ask: "Ask first",
  on: "On",
  off: "Off",
};

export type NotifySource = "cloud" | "local";
export type NotifyAction = "deliver" | "ask" | "drop";

/** A notification as the host hands it to the workbench: a cloud app's (over
 *  the attach link, with the server's row id) or a local app's (this host). */
export interface IncomingNotification {
  id?: string;
  app: string;
  title: string;
  body: string;
  source: NotifySource;
  /** A local app's slug: its OS notification opens the app when clicked. */
  slug?: string;
}

/** The DOM event the ask toast and the settings control talk over (one document). */
export const NOTIFY_PREF_CHANGED_EVENT = "glyphh:notifications-changed";

/** The stored value read back: anything but the three words is the default. */
export function readNotifyPref(v: unknown): NotifyPref {
  return v === "on" || v === "off" || v === "ask" ? v : NOTIFY_PREF_DEFAULT;
}

/** The decision table: on shows, off drops, ask asks — whoever sent it. */
export function notifyAction(pref: NotifyPref): NotifyAction {
  switch (pref) {
    case "on": return "deliver";
    case "off": return "drop";
    case "ask": return "ask";
  }
}

export type AskAnswer = "allow" | "dismiss";

/**
 * What an answer to the ask toast does. Allow turns notifications on and
 * shows this one; a dismissal with "Don't ask me again" checked turns them
 * off; a plain dismissal keeps asking (`pref` absent = nothing to write).
 */
export function afterAsk(answer: AskAnswer, dontAskAgain: boolean): { pref?: NotifyPref; deliver: boolean } {
  if (answer === "allow") return { pref: "on", deliver: true };
  return dontAskAgain ? { pref: "off", deliver: false } : { deliver: false };
}

/** The ask toast's line: who wants in. */
export function askLine(app: string): string {
  return `${app.trim() || "An app"} wants to notify you`;
}
