/**
 * run-stream-ipc.ts — the DESKTOP's run-stream observer transport.
 *
 * Web exposes the browser SDK as window.glyphhSdk, so attachToActiveRun() can
 * consume the run-stream broker directly. The desktop renderer is IPC-only —
 * without this bridge the observer silently no-ops and the desktop never sees
 * runs executing on OTHER surfaces (web, mobile, cloud pods).
 *
 * The renderer supplies its own subscription token so pushed frames are
 * filterable from the very first event (no id-assignment race). Subscriptions
 * are torn down with their webContents.
 */

import { ipcMain } from "electron";
import { getClient } from "./glyphh-client";

interface Sub {
  stop: () => void;
}

const subs = new Map<string, Sub>();

export function registerRunStreamIpc(): void {
  ipcMain.handle("run-stream-attach", (event, threadId: unknown, token: unknown) => {
    if (typeof threadId !== "string" || !threadId) return { ok: false, error: "bad threadId" };
    if (typeof token !== "string" || !token) return { ok: false, error: "bad token" };
    if (subs.has(token)) return { ok: false, error: "token in use" };
    try {
      const handle = getClient().runStream.attach(threadId, { from: "0" });
      const wc = event.sender;
      const send = (channel: string, payload: unknown): void => {
        try { if (!wc.isDestroyed()) wc.send(channel, payload); } catch { /* window mid-teardown */ }
      };
      const offRun = handle.onRun((runId) => send("run-stream-run", { token, runId }));
      const offFrame = handle.on((frame) => send("run-stream-frame", { token, frame }));
      const sub: Sub = {
        stop: () => {
          try { offRun(); offFrame(); handle.stop(); } catch { /* already stopped */ }
          subs.delete(token);
        },
      };
      subs.set(token, sub);
      wc.once("destroyed", () => sub.stop());
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle("run-stream-stop", (_event, token: unknown) => {
    if (typeof token === "string") subs.get(token)?.stop();
    return { ok: true };
  });

  // Cross-surface STOP: abort an OBSERVED run by id (a cloud run watched from
  // this desktop — the observer holds no run handle, only the broker stream).
  ipcMain.handle("harness-stop-run", async (_event, runId: unknown) => {
    if (typeof runId !== "string" || !runId) return { ok: false };
    try { await getClient().harnessViaApi().stopRun(runId); return { ok: true }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
}
