/**
 * notify-web.test.js — the web's door for a cloud app's notification
 * (web/src/notify-web.js): the `notify` push read into the workbench's shape,
 * one relay socket kept up with backoff, the browser's notification only once
 * granted (his order, 2026-10-05).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  notificationOf, browserNotificationsGranted, watchNotifications, showBrowserNotification, askBrowserNotificationPermission,
} from '../src/notify-web.js';

describe('notificationOf — the push as the workbench takes it', () => {
  it('reads the server frame and marks it cloud', () => {
    expect(notificationOf({ type: 'notify', id: 'n1', app: 'crm', title: 'Paid', body: 'ACME' }))
      .toEqual({ id: 'n1', app: 'crm', title: 'Paid', body: 'ACME', source: 'cloud' });
  });
  it('caps and fills', () => {
    const n = notificationOf({ type: 'notify', title: 't'.repeat(300), body: 'b'.repeat(900) });
    expect(n.title).toHaveLength(120);
    expect(n.body).toHaveLength(500);
    expect(n.app).toBe('An app');
    expect(n.id).toBeUndefined();
  });
  it('is null for anything else on the channel', () => {
    expect(notificationOf(null)).toBeNull();
    expect(notificationOf({ type: 'fs-changed' })).toBeNull();
    expect(notificationOf({ type: 'notify', title: '' })).toBeNull();
  });
});

class FakeSock {
  constructor() { this.pushes = []; this.closes = []; this.closed = false; }
  onPush(channel, cb) { this.pushes.push([channel, cb]); return () => {}; }
  onClose(cb) { this.closes.push(cb); }
  close() { this.closed = true; }
  push(channel, data) { for (const [c, cb] of this.pushes) if (c === channel) cb(channel, data); }
  drop() { for (const cb of this.closes) cb({ code: 1006, reason: '' }); }
}

function timers() {
  const queue = [];
  return {
    setTimeout: (fn, ms) => { const id = queue.length + 1; queue.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = queue.findIndex((q) => q.id === id); if (i >= 0) queue.splice(i, 1); },
    fire: () => { const q = queue.shift(); q?.fn(); return q?.ms; },
    pending: () => queue.length,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('watchNotifications — one socket, kept up', () => {
  it('dials with the token, hands notify pushes on, redials after a drop with backoff reset', async () => {
    const socks = [];
    const connect = vi.fn(async () => { const s = new FakeSock(); socks.push(s); return s; });
    const t = timers();
    const got = [];
    const stop = watchNotifications(async () => 'tok', (n) => got.push(n), connect, t);
    await tick();
    expect(connect).toHaveBeenCalledWith('tok');
    socks[0].push('notify', { type: 'notify', title: 'Hi', app: 'crm' });
    socks[0].push('notify', { type: 'other' });
    expect(got.map((n) => n.title)).toEqual(['Hi']);
    socks[0].drop();
    expect(t.pending()).toBe(1);
    expect(t.fire()).toBe(2000);
    await tick();
    expect(socks).toHaveLength(2);
    stop();
    expect(socks[1].closed).toBe(true);
  });

  it('signed out or refused: waits, doubling up to a minute, and stops cleanly', async () => {
    const t = timers();
    const connect = vi.fn(async () => { throw new Error('refused'); });
    const stop = watchNotifications(async () => null, () => {}, connect, t);
    await tick();
    expect(connect).not.toHaveBeenCalled();
    expect(t.fire()).toBe(2000);
    await tick();
    expect(t.fire()).toBe(4000);
    await tick();
    for (let i = 0; i < 10; i++) { t.fire(); await tick(); }
    expect(t.fire()).toBe(60000);
    await tick();
    stop();
    expect(t.pending()).toBe(0);
  });
});

describe('the browser notification', () => {
  class Note {
    static permission = 'granted';
    static made = [];
    constructor(title, opts) { this.title = title; this.opts = opts; Note.made.push(this); }
    close() { this.closed = true; }
  }
  it('is granted or not', () => {
    expect(browserNotificationsGranted('granted')).toBe(true);
    expect(browserNotificationsGranted('default')).toBe(false);
    expect(browserNotificationsGranted('denied')).toBe(false);
  });
  it('shows only once granted; a click fronts the tab', () => {
    const win = { Notification: Note, focus: vi.fn() };
    expect(showBrowserNotification({ title: 'Paid', body: 'ACME' }, win)).toEqual({ shown: true });
    expect(Note.made[0].title).toBe('Paid');
    expect(Note.made[0].opts).toEqual({ body: 'ACME' });
    Note.made[0].onclick();
    expect(win.focus).toHaveBeenCalled();
    expect(Note.made[0].closed).toBe(true);
    Note.permission = 'default';
    expect(showBrowserNotification({ title: 'x', body: '' }, win)).toEqual({ shown: false });
    expect(showBrowserNotification({ title: 'x', body: '' }, {})).toEqual({ shown: false });
    expect(showBrowserNotification({ title: 'x', body: '' }, null)).toEqual({ shown: false });
  });
  it('asks the browser once, never after a denial', async () => {
    const ask = vi.fn(async () => 'granted');
    const win = { Notification: { permission: 'default', requestPermission: ask } };
    expect(await askBrowserNotificationPermission(win)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    win.Notification.permission = 'granted';
    expect(await askBrowserNotificationPermission(win)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    win.Notification.permission = 'denied';
    expect(await askBrowserNotificationPermission(win)).toBe(false);
    expect(await askBrowserNotificationPermission({})).toBe(false);
  });
});
