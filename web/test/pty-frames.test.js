/**
 * pty-frames.test.js — the worker pty socket's JSON frame codec
 * (src/renderer/pty-frames.ts): the exact `glyphh.terminal/v2` frames the server speaks.
 */
import { describe, it, expect } from 'vitest';
import {
  encodePtyFrame, decodePtyFrame, dataFrame, resizeFrame, closeFrame, pingFrame, pongFrame,
  bytesToB64, b64ToBytes, ptyOpenBody, splitProgram, PTY_WIRE,
} from '../../src/renderer/pty-frames.ts';

describe('pty frames', () => {
  it('names the wire', () => { expect(PTY_WIRE).toBe('glyphh.terminal/v2'); });
  it('data rides as base64 bytes, resize/close/ping exactly', () => {
    expect(JSON.parse(dataFrame('ls\r'))).toEqual({ type: 'data', data: btoa('ls\r') });
    expect(JSON.parse(resizeFrame(120, 40))).toEqual({ type: 'resize', cols: 120, rows: 40 });
    expect(JSON.parse(closeFrame())).toEqual({ type: 'close' });
    expect(JSON.parse(pingFrame())).toEqual({ type: 'ping' });
    expect(JSON.parse(pongFrame())).toEqual({ type: 'pong' });
    expect(encodePtyFrame({ type: 'exit', code: 1 })).toBe('{"type":"exit","code":1}');
  });
  it('base64 round-trips bytes, UTF-8 included', () => {
    const bytes = new TextEncoder().encode('héllo ⣿');
    expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes);
    expect(new TextDecoder().decode(b64ToBytes(JSON.parse(dataFrame('é')).data))).toBe('é');
  });
  it('decodes every server frame', () => {
    expect(decodePtyFrame('{"type":"data","data":"aGk="}')).toEqual({ type: 'data', data: 'aGk=' });
    expect(decodePtyFrame({ type: 'resize', cols: '80', rows: 24 })).toEqual({ type: 'resize', cols: 80, rows: 24 });
    expect(decodePtyFrame('{"type":"close"}')).toEqual({ type: 'close' });
    expect(decodePtyFrame('{"type":"ping"}')).toEqual({ type: 'ping' });
    expect(decodePtyFrame('{"type":"pong"}')).toEqual({ type: 'pong' });
    expect(decodePtyFrame('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(decodePtyFrame('{"type":"exit","code":0}')).toEqual({ type: 'exit', code: 0 });
    expect(decodePtyFrame('{"type":"exit"}')).toEqual({ type: 'exit' });
    expect(decodePtyFrame('{"type":"error","error":"boom"}')).toEqual({ type: 'error', error: 'boom' });
    expect(decodePtyFrame('{"type":"error"}')).toEqual({ type: 'error', error: 'the worker reported an error' });
  });
  it('drops anything that is not a known frame (never throws)', () => {
    expect(decodePtyFrame('not json')).toBeNull();
    expect(decodePtyFrame('')).toBeNull();
    expect(decodePtyFrame(null)).toBeNull();
    expect(decodePtyFrame(42)).toBeNull();
    expect(decodePtyFrame({ type: 'frame', data: 'x' })).toBeNull();
    expect(decodePtyFrame({ type: 'data', data: 7 })).toBeNull();
    expect(decodePtyFrame({ type: 'resize', cols: 0, rows: 10 })).toBeNull();
    expect(decodePtyFrame({ type: 'resize', cols: 10 })).toBeNull();
  });
  it('the open body carries size, and only the optional fields that are set', () => {
    expect(ptyOpenBody({ cols: 80.7, rows: 24 })).toEqual({ cols: 80, rows: 24 });
    expect(ptyOpenBody({ cols: 0, rows: 0 })).toEqual({ cols: 1, rows: 1 });
    expect(ptyOpenBody({ cols: 100, rows: 30, cwd: 'src', command: 'claude', scope: 'c123' })).toEqual({ cols: 100, rows: 30, cwd: 'src', command: 'claude', scope: 'c123' });
    expect(ptyOpenBody({ cols: 100, rows: 30, cwd: '', command: '', scope: '' })).toEqual({ cols: 100, rows: 30 });
  });
  it('splitProgram: a bare program name rides the wire; a line with arguments is typed whole into the shell', () => {
    expect(splitProgram('claude')).toEqual({ program: 'claude', rest: '' });
    expect(splitProgram('cursor-agent')).toEqual({ program: 'cursor-agent', rest: '' });
    // Flags typed AFTER a started program land in its prompt — so they never are.
    expect(splitProgram("claude --resume 'abc'")).toEqual({ program: '', rest: "claude --resume 'abc'" });
    expect(splitProgram('codex -c check_for_update_on_startup=false')).toEqual({ program: '', rest: 'codex -c check_for_update_on_startup=false' });
    expect(splitProgram("cd 'src' && claude")).toEqual({ program: '', rest: "cd 'src' && claude" });
    expect(splitProgram('')).toEqual({ program: '', rest: '' });
  });
});
