/**
 * attach.ts — the cloud's REST view of the caller's attached desktop machine(s).
 *
 * The desktop opens an outbound WebSocket (/ws/attach) that the SDK does NOT
 * manage — that lives in the desktop main process. This client is the OTHER
 * side: status + dispatch, used by the platform UI and by the server-side agent
 * to drive the signed-in user's own machine. Self only; no attached machine →
 * dispatch rejects (E_FAILED_PRECONDITION).
 */

import type { AuthedHttp } from "../core/authed-http.js";

export interface AttachedMachine {
  /** Stable per-connection id — address ONE machine when several are attached. */
  id?: string;
  app: string;
  version: string;
  /** The machine's hostname — shown by pickers ("Chris's MacBook"). */
  name?: string;
  capabilities: string[];
  /** The folders this machine granted remote control (absolute paths). */
  folders?: string[];
  since: number;
}

export interface AttachStatus {
  /** False when the org admin turned remote control off (then nothing is attached). */
  allowed?: boolean;
  attached: boolean;
  machines: AttachedMachine[];
}

/** One entry in an attached machine's directory listing (`attach.fsList`). */
export interface FsEntry {
  /** Base name (no path). */
  name: string;
  /** Absolute path on the attached machine. */
  path: string;
  /** A directory the browser can descend into vs. a leaf file. */
  dir: boolean;
  /** True when the directory is itself a git working tree (a repo root). */
  git?: boolean;
}

/** The result of an `attach.fsList` walk: the listed directory + its children. */
export interface FsListing {
  /** The absolute path that was listed (the machine's root when none was asked for). */
  path: string;
  /** The parent path to walk back up to, or null at the machine root. */
  parent: string | null;
  entries: FsEntry[];
}

export class AttachClient {
  constructor(private readonly http: AuthedHttp) {}

  /** Is the caller's desktop attached right now, and what can it do. */
  status(): Promise<AttachStatus> {
    return this.http.get<AttachStatus>("/api/attach/status");
  }

  /** Run a method ON the caller's own machine and return its result. */
  async dispatch<T = unknown>(method: string, params?: Record<string, unknown>, opts: { machineId?: string } = {}): Promise<T> {
    const { result } = await this.http.post<{ result: T }>("/api/attach/dispatch", { method, params: params ?? {}, ...(opts.machineId ? { machineId: opts.machineId } : {}) });
    return result;
  }

  /**
   * Browse the attached machine's OWN filesystem (self only), for picking a
   * folder to run a LOCAL session in. Omit `path` to start at the root the
   * desktop chooses to expose. Thin typed wrapper over `dispatch('fs.list')`;
   * a machine whose desktop build predates the `fs.list` handler rejects the
   * dispatch — callers should surface that as an honest "needs a desktop
   * update" state rather than an error.
   */
  fsList(path?: string, opts: { machineId?: string } = {}): Promise<FsListing> {
    return this.dispatch<FsListing>("fs.list", path ? { path } : {}, opts);
  }

  /** Answer a parked approval/ask on a relayed run. */
  async answerRun(id: string, reply: { allow?: boolean; answers?: string[] }): Promise<void> {
    await this.http.post("/api/attach/run/answer", { id, ...reply });
  }

  /** Abort a relayed run. */
  async stopRun(runId: string): Promise<void> {
    await this.http.post("/api/attach/run/stop", { runId }).catch(() => { /* run may be done */ });
  }

  /** Change the permission mode of a relayed (on-machine) run mid-flight — the
   *  desktop pushes it to its local pod so the gate re-evaluates. Best-effort:
   *  a run that already finished 404s, which we swallow. */
  async setRunPermission(runId: string, permission: "ask" | "plan" | "acceptEdits" | "auto" | "bypass"): Promise<void> {
    await this.http.post("/api/attach/run/permission", { runId, permission }).catch(() => { /* run may be done */ });
  }

  /**
   * Run a turn ON the caller's attached machine (not a cloud pod) and stream its
   * frames back. Same shape as the harness run handle so callers consume relay
   * and cloud runs identically: `.on(frame)` for the wire frames, `.done` for the
   * settled result, `.answer(id, reply)` for parked approvals/asks, `.stop()`.
   *
   * The server (POST /api/attach/run) forwards the run over the desktop's attach
   * socket; the desktop runs it locally and pushes HarnessWireFrames back, which
   * arrive here as Server-Sent Events.
   */
  run(
    params: { runId?: string; threadId?: string; prompt?: string; messages?: Array<{ role: string; text?: string; content?: string }>; mode?: "work" | "cowork" | "code"; workdir?: string; model?: string; loop?: string; permission?: "ask" | "plan" | "acceptEdits" | "auto" | "bypass"; images?: Array<{ mediaType: string; data: string }>; machineId?: string },
    opts: { signal?: AbortSignal } = {},
  ): RelayRunHandle {
    const runId = params.runId ?? `rl-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const listeners = new Set<(f: RelayFrame) => void>();
    let settle: (r: RelayResult) => void = () => {};
    let done = false;
    const donePromise = new Promise<RelayResult>((res) => { settle = res; });
    const finish = (r: RelayResult): void => { if (done) return; done = true; settle(r); };
    let text = "";

    // Stop must reach the MACHINE, not just close the local stream: aborting the
    // fetch relies on the server noticing the disconnect. Explicitly dispatch
    // agent.stop so the desktop aborts the run (and frees its pod slot) for sure.
    if (opts.signal) {
      if (opts.signal.aborted) void this.stopRun(runId);
      else opts.signal.addEventListener("abort", () => { void this.stopRun(runId); }, { once: true });
    }

    const pump = async (): Promise<void> => {
      let resp: Response;
      try {
        resp = await this.http.stream("/api/attach/run", { ...params, runId }, { headers: { Accept: "text/event-stream" }, ...(opts.signal ? { signal: opts.signal } : {}) });
      } catch (e) { finish({ runId, stopped: false, text, error: e instanceof Error ? e.message : String(e) }); return; }
      if (!resp.ok || !resp.body) { finish({ runId, stopped: false, text, error: `relay run failed (${resp.status})` }); return; }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data:")) continue;   // skip ": ok" comments
              const json = line.slice(5).trim();
              if (!json) continue;
              let frame: RelayFrame;
              try { frame = JSON.parse(json) as RelayFrame; } catch { continue; }
              if (frame.type === "delta") text += (frame as { delta?: string }).delta ?? "";
              for (const cb of listeners) { try { cb(frame); } catch { /* listener threw */ } }
              if (frame.type === "done") finish({ runId, stopped: !!(frame as { stopped?: boolean }).stopped, text });
              else if (frame.type === "error") { const err = (frame as { error?: string }).error; finish({ runId, stopped: false, text, ...(err ? { error: err } : {}) }); }
            }
          }
        }
      } catch (e) {
        finish({ runId, stopped: false, text, error: e instanceof Error ? e.message : String(e) });
        return;
      }
      finish({ runId, stopped: false, text }); // stream closed without a done frame
    };
    void pump();

    return {
      on: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      get done() { return donePromise; },
      answer: (id, reply) => this.answerRun(id, reply),
      stop: () => this.stopRun(runId),
      setPermission: (mode) => this.setRunPermission(runId, mode),
    };
  }
}

/** One streamed frame (a HarnessWireFrame; typed loosely at the transport edge). */
export type RelayFrame = { type: string; [k: string]: unknown };
export interface RelayResult { runId: string; stopped: boolean; text: string; error?: string }
export interface RelayRunHandle {
  on(cb: (frame: RelayFrame) => void): () => void;
  readonly done: Promise<RelayResult>;
  answer(id: string, reply: { allow?: boolean; answers?: string[] }): Promise<void>;
  stop(): Promise<void>;
  /** Change the run's permission mode mid-flight (POST /api/attach/run/permission). */
  setPermission(mode: "ask" | "plan" | "acceptEdits" | "auto" | "bypass"): Promise<void>;
}
