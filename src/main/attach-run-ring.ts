/**
 * attach-run-ring — the per-run FRAME RING every Glyphh turn on this machine
 * writes, keyed by runId and tagged with its chat. Pure (no Electron), so it
 * is unit-tested in a plain node env (test/main/attach-run-ring.test.ts).
 *
 * Two writers: the relay sink (attach-run.ts, a turn the web or the phone
 * asked for) and the loop's own emit (glyphh-loop.ts, a turn a desktop panel
 * started). One reader: `agent.frames`, which a web page polls by runId once
 * it follows a run, or by THREAD to discover a run it did not start (his
 * report, 2026-10-08: "the remote session to the desktops are not streaming
 * when both ends are the glyphh agent" — a desktop-started turn had no ring,
 * and the web's watcher asked a broker the server never grew).
 *
 * A ring lives while the run does, then RING_TTL_AFTER_END_MS more so a page
 * that dropped its poll can still replay the end of the turn.
 */
import { toWireFrame } from "./attach-run-frames.js";

export type RingFrame = Record<string, unknown> & { seq: number; type?: string };
export type RingStatus = "running" | "done" | "error";
export interface RunRing { frames: RingFrame[]; status: RingStatus; chatId: string; seq: number; startedAt: number }

export const RING_CAP = 4000;
export const RING_TTL_AFTER_END_MS = 10 * 60_000;

const rings = new Map<string, RunRing>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** The run's ring, opened on first use. */
export function openRing(runId: string, chatId: string, now: number = Date.now()): RunRing {
  let r = rings.get(runId);
  if (!r) { r = { frames: [], status: "running", chatId, seq: 0, startedAt: now }; rings.set(runId, r); }
  return r;
}

export function ringOf(runId: string): RunRing | undefined { return rings.get(runId); }

/** Translate one `glyphh-agent:*` emit and keep it on the run's ring. A
 *  `done`/`error` closes the ring and starts its expiry. Returns the frame
 *  (null when the channel has no wire shape). */
export function recordFrame(runId: string, chatId: string, channel: string, data: Record<string, unknown>, now: number = Date.now()): RingFrame | null {
  const r = openRing(runId, chatId, now);
  const frame = toWireFrame(channel, { ...(data ?? {}), runId }, r.seq, runId, now) as RingFrame | null;
  if (!frame) return null;
  r.seq++;
  r.frames.push(frame);
  if (r.frames.length > RING_CAP) r.frames.splice(0, r.frames.length - RING_CAP);
  if (frame.type === "done" || frame.type === "error") {
    r.status = frame.type === "done" ? "done" : "error";
    const t = setTimeout(() => { rings.delete(runId); timers.delete(runId); }, RING_TTL_AFTER_END_MS);
    (t as { unref?: () => void }).unref?.();
    timers.set(runId, t);
  }
  return frame;
}

/** The frames after `from` (exclusive; -1 = everything). */
export function framesSince(runId: string, from: number): RingFrame[] {
  const r = rings.get(runId);
  return r ? r.frames.filter((f) => f.seq > from) : [];
}

/** The thread's newest run: a running one first, else the newest finished
 *  one still on its TTL. Null when the thread has no ring. */
export function ringForThread(chatId: string): { runId: string; ring: RunRing } | null {
  let best: { runId: string; ring: RunRing } | null = null;
  for (const [runId, ring] of rings) {
    if (ring.chatId !== chatId) continue;
    if (!best) { best = { runId, ring }; continue; }
    const bRun = best.ring.status === "running", rRun = ring.status === "running";
    if (rRun !== bRun ? rRun : ring.startedAt > best.ring.startedAt) best = { runId, ring };
  }
  return best;
}

/** Tests: start clean. */
export function clearRings(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear(); rings.clear();
}
