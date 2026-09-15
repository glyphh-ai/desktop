/**
 * web-errors.test.js — the LOUD error surface. formatError is pure; installErrorSurface
 * is exercised with an injected sink + a fake window so we can assert the global
 * `error` / `unhandledrejection` handlers report through it (no DOM needed).
 */
import { describe, it, expect, vi } from 'vitest';
import { formatError, installErrorSurface } from '../src/web-errors.js';

describe('formatError', () => {
  it('passes strings through', () => {
    expect(formatError('boom')).toBe('boom');
  });
  it('uses an Error stack (or name: message)', () => {
    const e = new Error('nope');
    expect(formatError(e)).toContain('nope');
  });
  it('falls back for objects and null', () => {
    expect(formatError({ message: 'x' })).toBe('x');
    expect(formatError({ a: 1 })).toBe('{"a":1}');
    expect(formatError(null)).toBe('Unknown error');
  });
});

describe('installErrorSurface', () => {
  function fakeWin() {
    const handlers = {};
    return {
      addEventListener: (type, fn) => { handlers[type] = fn; },
      emit: (type, ev) => handlers[type] && handlers[type](ev),
      handlers,
    };
  }

  it('registers error + unhandledrejection listeners and paints to the sink', () => {
    const win = fakeWin();
    const sink = vi.fn();
    const log = vi.fn();
    installErrorSurface({ win, doc: null, log, sink });
    expect(Object.keys(win.handlers).sort()).toEqual(['error', 'unhandledrejection']);

    win.emit('error', { error: new Error('render blew up'), message: 'render blew up' });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toContain('render blew up');
    expect(log).toHaveBeenCalled();

    win.emit('unhandledrejection', { reason: 'promise died' });
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1][0]).toContain('promise died');
  });

  it('ignores resource-load error events (no error/message)', () => {
    const win = fakeWin();
    const sink = vi.fn();
    installErrorSurface({ win, doc: null, log: () => {}, sink });
    win.emit('error', {}); // e.g. an <img> 404 — nothing to surface
    expect(sink).not.toHaveBeenCalled();
  });

  it('collapses a repeated identical error', () => {
    const win = fakeWin();
    const sink = vi.fn();
    const report = installErrorSurface({ win, doc: null, log: () => {}, sink });
    report('same');
    report('same');
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('a throwing sink never propagates out of report', () => {
    const win = fakeWin();
    const report = installErrorSurface({ win, doc: null, log: () => {}, sink: () => { throw new Error('sink broke'); } });
    expect(() => report('x')).not.toThrow();
  });
});
