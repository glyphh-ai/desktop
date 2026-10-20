/**
 * model-watch.ts — SERVER-SIDE MODEL CHANGES REACH EVERY SURFACE (his report,
 * 2026-09-29: "server side changes to the model list are not automatically
 * updating in the model list within the app. These should be automatic and
 * when the user opens the model list they should see the updates. Or any new
 * session should see them as well as the agents, the defaults in settings").
 *
 * What went stale, and why: main cached the list for a minute and nothing ever
 * invalidated it; the org's and team's DEFAULT model (and the gateway and
 * connections gates) were read once, at sign-in; and nothing told the other
 * open surfaces — a second agent panel, Settings → General, Build → Agents —
 * that anything had moved.
 *
 * Now one watcher re-reads both (the list and the defaults) on a slow clock,
 * whenever the app comes back to the front, and whenever any surface forces a
 * read (opening the picker). When the answer differs from the last one, every
 * renderer is told `models:changed` with the new list and default, and repaints
 * whatever it shows. One request pair per tick; no change, no broadcast.
 */

import { app } from "electron";
import { broadcast } from "./broadcast.js";
import { listLoopModels, onLoopModelsFetched, type LoopModelsResult } from "./loop-models.js";
import { orgModelState } from "./org-models.js";

const TICK_MS = 45_000;
const FOCUS_THROTTLE_MS = 8_000;

export interface ModelsChanged { models: LoopModelsResult; defaultModel: string; gatewayOn: boolean; connectionsOn: boolean; hasPlan: boolean }

let lastSig = "";
let lastFocus = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
let ticking = false;
let wired = false;
const mainListeners = new Set<(c: ModelsChanged) => void>();

/** Main-side subscribers (the loop re-lends its tools when the connections lane moves). */
export function onModelStateChanged(cb: (c: ModelsChanged) => void): void { mainListeners.add(cb); }

function signature(m: LoopModelsResult): string {
  return JSON.stringify({ ids: m.models.map((x) => `${x.id}|${x.name}|${x.providerSlug}`), ...orgModelState() });
}

/** Tell every surface if the list or the defaults moved. */
function announceIfChanged(m: LoopModelsResult): void {
  if (!m.ok) return;   // offline: the last answer stands, and so does every surface's
  const sig = signature(m);
  if (sig === lastSig) return;
  const first = lastSig === "";
  lastSig = sig;
  if (first) return;   // the first read after sign-in is the baseline, not a change
  const s = orgModelState();
  const payload: ModelsChanged = { models: m, defaultModel: s.defaultModel, gatewayOn: s.gatewayOn, connectionsOn: s.connectionsOn, hasPlan: s.hasPlan };
  console.warn("[models] changed — told every surface", JSON.stringify({ count: m.models.length, defaultModel: s.defaultModel, connectionsOn: s.connectionsOn }));
  broadcast("models:changed", payload);
  for (const cb of mainListeners) {
    try { cb(payload); } catch (err) { console.warn("[models] listener failed:", err instanceof Error ? err.message : err); }
  }
}

/** Re-read the list and the defaults and tell every surface if they moved —
 *  what Settings › Models calls after a save. */
export function refreshModelState(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    ticking = true;
    try {
      await listLoopModels(true);   // the fetch listener compares and announces
    } catch { /* offline — next tick */ } finally { ticking = false; }
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Started with the signed-in session, stopped with it. */
export function startModelWatch(): void {
  if (!wired) {
    wired = true;
    // A read a surface FORCED (the picker opening, a new session) re-reads the
    // defaults too, then everyone is told; a plain TTL refetch just compares.
    onLoopModelsFetched((m, forced) => {
      if (ticking || !forced) { announceIfChanged(m); return; }
      announceIfChanged(m);
    });
    app.on("browser-window-focus", () => {
      if (!timer || Date.now() - lastFocus < FOCUS_THROTTLE_MS) return;
      lastFocus = Date.now();
      void refreshModelState();
    });
  }
  if (timer) return;
  timer = setInterval(() => { void refreshModelState(); }, TICK_MS);
  void refreshModelState();
}

/** A different person may sign in next: their first read is a baseline, not a change. */
export function resetModelWatch(): void { lastSig = ""; }

export function stopModelWatch(): void {
  if (timer) { clearInterval(timer); timer = null; }
  resetModelWatch();
}
