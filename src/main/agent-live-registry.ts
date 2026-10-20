/**
 * agent-live-registry.ts — WHICH CHATS HAVE A TURN RUNNING, app-wide.
 *
 * His report, 2026-09-26: before the purge "an agent could be running, open a
 * new one and the thread in the left rail would show that session running with
 * a blinking icon". That died when the agent moved onto the CLI bridge and each
 * agent panel became its own document — a run's events reach only the
 * webContents that started it, so no other surface could know.
 *
 * This is the one ledger. The loop marks a chat running at the start of a turn
 * and done at its end; `announce` carries the whole list to every renderer.
 * Pure (no Electron) so it is testable; agent-live.ts wires it.
 *
 * IT ALSO CARRIES THE STATE (his order, 2026-09-29): green working, yellow
 * waiting on the person, red the last turn failed, and nothing at all for a
 * thread that is idle. An ERRORED thread keeps its entry after the run ends —
 * that is the only way a row can still be red when nothing is running — and
 * the next turn on it replaces the entry.
 */

/** What a row shows: working (green), waiting on an approval (yellow), the
 *  last turn failed (red). A thread with no entry at all is idle (grey). */
export type LiveStatus = "working" | "waiting" | "error";

export interface LiveAgentRun {
  /** The Glyphh thread the turn runs on. */
  chatId: string;
  /** The CLI's own session id for that thread, when known — the rail lists
   *  Claude/Codex sessions by THIS id, the Glyphh loop's by the chat id. */
  cliSessionId: string | null;
  cli: string;
  runId: string;
  /** The webContents driving the run — the panel that hosts it. */
  senderId: number;
  startedAt: number;
  status: LiveStatus;
}

export interface AgentLiveRegistry {
  start(run: Omit<LiveAgentRun, "startedAt" | "status">): void;
  /** A later fact about a running chat (its session id, or its state). */
  update(chatId: string, patch: Partial<Pick<LiveAgentRun, "cliSessionId" | "runId" | "senderId" | "status">>): void;
  /** The turn ended. With a runId, a STALE done (an old process exiting after
   *  a respawn) never clears the newer turn; without one it always clears.
   *  A thread whose turn FAILED keeps its entry, marked error, so the row can
   *  still say so with nothing running. */
  done(chatId: string, runId?: string): void;
  isRunning(chatId: string): boolean;
  list(): LiveAgentRun[];
}

export function createAgentLiveRegistry(announce: (runs: LiveAgentRun[]) => void, now: () => number = () => Date.now()): AgentLiveRegistry {
  const runs = new Map<string, LiveAgentRun>();
  const list = (): LiveAgentRun[] => [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
  const tell = (): void => { try { announce(list()); } catch { /* a listener's failure never blocks the ledger */ } };
  return {
    start(run) {
      const prev = runs.get(run.chatId);
      // A NEW TURN CLEARS THE OLD VERDICT: an error entry is history the moment
      // the thread runs again, and startedAt is this turn's (a kept error
      // entry must not make the new run look hours old).
      runs.set(run.chatId, { ...run, status: "working", startedAt: prev?.status === "error" ? now() : prev?.startedAt ?? now() });
      tell();
    },
    update(chatId, patch) {
      const cur = runs.get(chatId);
      if (!cur) return;
      const next = { ...cur, ...patch };
      if (next.cliSessionId === cur.cliSessionId && next.runId === cur.runId && next.senderId === cur.senderId && next.status === cur.status) return;
      runs.set(chatId, next);
      tell();
    },
    done(chatId, runId) {
      const cur = runs.get(chatId);
      if (!cur) return;
      if (runId && cur.runId && runId !== cur.runId) return;
      // A FAILED TURN STAYS ON THE LEDGER, marked, until the thread runs again
      // (or the app restarts): red with nothing running is the whole point.
      if (cur.status === "error") { runs.set(chatId, { ...cur, status: "error" }); tell(); return; }
      runs.delete(chatId);
      tell();
    },
    isRunning: (chatId) => runs.get(chatId)?.status !== undefined && runs.get(chatId)?.status !== "error",
    list,
  };
}
