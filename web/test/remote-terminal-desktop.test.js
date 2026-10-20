/**
 * remote-terminal-desktop.test.js — the WEB terminal's DESKTOP target
 * (src/renderer/remote-terminal.ts openDesktopPty): a LOCAL (desktop-relay)
 * session's CLI tile opens the user's own machine's shell over the panel
 * relay socket — `pty.open` → {ptyId}; output pushed on the ptyId channel;
 * `pty.input` / `pty.resize` fire-and-forget; `pty.close` on dispose. The
 * desktop admits exactly these through remote-control.ts's door (test/main/
 * remote-control.test.ts); the server allowlists them (REMOTE_METHODS).
 *
 * A fake WebSocket plays the server: it answers requests and lets the test
 * push frames; a fake window.glyphhSdk is the attach status + token.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

class FakeSocket {
  static OPEN = 1;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
    // Open on the next tick, like a real upgrade.
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
  }
  send(raw) {
    const f = JSON.parse(raw);
    this.sent.push(f);
    if (f.t === 'req' && f.method === 'pty.open') {
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ t: 'res', id: f.id, ok: true, result: { ptyId: 'pty-1' } }) }), 0);
    }
  }
  push(channel, data) { this.onmessage?.({ data: JSON.stringify({ t: 'push', channel, data }) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const flush = () => new Promise((r) => setTimeout(r, 5));

let attached = true;
beforeEach(() => {
  FakeSocket.instances = [];
  attached = true;
  globalThis.WebSocket = FakeSocket;
  globalThis.window = {
    __GLYPHH_API_URL__: 'https://api.test',
    glyphhSdk: { token: async () => 'tok', attach: { status: async () => ({ attached }) } },
  };
});

const { openRemotePty, RemotePtyError } = await import('../../src/renderer/remote-terminal.ts');

describe('the web terminal on the attached desktop', () => {
  it('opens the shell over the relay, streams pushed output, types input, resizes, closes', async () => {
    const out = [];
    const hooks = { onData: (b) => out.push(Buffer.from(b).toString('utf8')), onExit: vi.fn(), onDrop: vi.fn() };
    const h = await openRemotePty({ cols: 100, rows: 30, cwd: '/Users/me/code', target: 'desktop' }, hooks);
    const sock = FakeSocket.instances[0];
    expect(sock.url).toBe('wss://api.test/ws/panel?token=tok');
    expect(sock.sent[0]).toMatchObject({ t: 'req', method: 'pty.open', params: { cols: 100, rows: 30, cwd: '/Users/me/code' } });
    // No `command` on the relay wire: the desktop opens a plain shell and the
    // caller types the CLI's line after boot (startedCommand says so).
    expect(sock.sent[0].params.command).toBeUndefined();
    expect(h.startedCommand).toBe(false);

    sock.push('pty-1', { type: 'data', bytes: b64('$ ') });
    sock.push('other-pty', { type: 'data', bytes: b64('not mine') });
    expect(out).toEqual(['$ ']);

    h.write('claude --continue\r');
    h.resize(120, 40);
    expect(sock.sent.slice(1)).toEqual([
      expect.objectContaining({ method: 'pty.input', params: { ptyId: 'pty-1', data: 'claude --continue\r' } }),
      expect.objectContaining({ method: 'pty.resize', params: { ptyId: 'pty-1', cols: 120, rows: 40 } }),
    ]);

    h.dispose();
    expect(sock.sent.at(-1)).toMatchObject({ method: 'pty.close', params: { ptyId: 'pty-1' } });
    h.write('ignored'); // idempotent after dispose
    expect(sock.sent.at(-1).method).toBe('pty.close');
  });

  it('the far shell exiting ends the handle without a close on the wire', async () => {
    const hooks = { onData: vi.fn(), onExit: vi.fn(), onDrop: vi.fn() };
    const h = await openRemotePty({ cols: 80, rows: 24, target: 'desktop' }, hooks);
    const sock = FakeSocket.instances[0];
    sock.push('pty-1', { type: 'exit', code: 3 });
    expect(hooks.onExit).toHaveBeenCalledWith(3);
    h.dispose();
    expect(sock.sent.some((f) => f.method === 'pty.close')).toBe(false);
  });

  it('no folder of its own → the shell starts in the first folder the desktop granted (the server checks cwd)', async () => {
    globalThis.window.glyphhSdk.attach.status = async () => ({ attached: true, machines: [{ id: 'm1', folders: ['/Users/me/code', '/Users/me/notes'] }] });
    const hooks = { onData: vi.fn(), onExit: vi.fn(), onDrop: vi.fn() };
    const a = await openRemotePty({ cols: 80, rows: 24, target: 'desktop' }, hooks);
    expect(FakeSocket.instances[0].sent[0]).toMatchObject({ t: 'req', method: 'pty.open', params: { cols: 80, rows: 24, cwd: '/Users/me/code' } });
    // The session's own folder wins over the grant list.
    const b = await openRemotePty({ cols: 80, rows: 24, cwd: '/Users/me/notes/x', target: 'desktop' }, hooks);
    expect(FakeSocket.instances[0].sent.at(-1)).toMatchObject({ method: 'pty.open', params: { cwd: '/Users/me/notes/x' } });
    a.dispose(); b.dispose();   // release the shared socket for the next case
  });

  it('no desktop attached → the honest desktop-offline state, before any socket', async () => {
    attached = false;
    await expect(openRemotePty({ cols: 80, rows: 24, target: 'desktop' }, { onData() {}, onExit() {}, onDrop() {} }))
      .rejects.toMatchObject({ state: 'desktop-offline' });
    expect(FakeSocket.instances).toEqual([]);
  });

  it('signed out (no SDK handle) → signed-out', async () => {
    globalThis.window = {};
    const err = await openRemotePty({ cols: 80, rows: 24, target: 'desktop' }, { onData() {}, onExit() {}, onDrop() {} }).catch((e) => e);
    expect(err).toBeInstanceOf(RemotePtyError);
    expect(err.state).toBe('signed-out');
  });

  it('the relay socket dropping mid-session reports onDrop once', async () => {
    const hooks = { onData: vi.fn(), onExit: vi.fn(), onDrop: vi.fn() };
    await openRemotePty({ cols: 80, rows: 24, target: 'desktop' }, hooks);
    await flush();
    FakeSocket.instances[0].close();
    expect(hooks.onDrop).toHaveBeenCalledTimes(1);
  });
});
