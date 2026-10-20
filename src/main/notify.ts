/**
 * notify.ts — the desktop's door for a notification (his order, 2026-10-05).
 *
 * An app's notification comes down the attach link as the server's
 * `notify.show` (attach.notify_user, with the row's id) and is handed to the
 * workbench (the one home.html, never an agent panel), where the member's
 * `notifications` pref decides — show, ask, drop (renderer/help/notify.ts).
 * What the renderer decides to show comes back here as `notify:show`: the OS
 * notification, a click fronting the app.
 */

import { ipcMain, Notification } from "electron";
import { homeShellWebContents, sendToHomeShell } from "./broadcast.js";
import { getMainWindowRef } from "./main-window-ref.js";

export type NotifySource = "cloud";

export interface AppNotification {
  id?: string;
  app: string;
  title: string;
  body: string;
  source: NotifySource;
  slug?: string;
}

const TITLE_MAX = 120;
const BODY_MAX = 500;

/** The server's notify.show as one shape. */
export function appNotification(source: NotifySource, fields: Record<string, unknown>, fallbackTitle = "Glyphh"): AppNotification {
  const id = typeof fields.id === "string" && fields.id ? fields.id : undefined;
  const slug = typeof fields.slug === "string" && fields.slug ? fields.slug : undefined;
  return {
    ...(id ? { id } : {}),
    app: String(fields.app || fallbackTitle).slice(0, TITLE_MAX),
    title: String(fields.title || fields.app || fallbackTitle).slice(0, TITLE_MAX),
    body: String(fields.body || "").slice(0, BODY_MAX),
    source,
    ...(slug ? { slug } : {}),
  };
}

/** Hand it to the workbench; false when no workbench is up to meet it. */
export function handToWorkbench(n: AppNotification): { shown: boolean } {
  if (!homeShellWebContents().length) return { shown: false };
  sendToHomeShell("notify:incoming", n);
  return { shown: true };
}

/** The OS notification. A click fronts Glyphh. */
export function showOsNotification(n: AppNotification): { shown: boolean } {
  if (!Notification.isSupported()) return { shown: false };
  const note = new Notification({ title: n.title.slice(0, TITLE_MAX), body: n.body.slice(0, BODY_MAX) });
  note.on("click", () => {
    const win = getMainWindowRef();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  note.show();
  return { shown: true };
}

/** What the attach link may call: the server's notify.show for this member. */
export function notifyAttachTable(): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    "notify.show": async (params) => handToWorkbench(appNotification("cloud", (params ?? {}) as Record<string, unknown>)),
  };
}

export function registerNotifyIpc(): void {
  ipcMain.handle("notify:show", (_e, n: AppNotification) => showOsNotification(n));
  ipcMain.handle("notify:prepare", () => Notification.isSupported());
}
