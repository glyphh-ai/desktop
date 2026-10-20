/**
 * contract/harness.ts — the `glyphh.harness/v1` wire contract: the frame
 * vocabulary a hosted HARNESS SESSION POD streams for one interactive run.
 * Mirrored VERBATIM from the pod (rrotor `src/harness/frames.ts` +
 * `config.ts`) — the frames are the renderer's vocabulary (desktop channel
 * `glyphh-agent:${frame.type}`), so a web bridge dispatches them unchanged.
 *
 *   delta     streamed answer text; append
 *   tool      a tool began / finished (denied/failed/preview on done)
 *   progress  live token accounting
 *   credits   running Pipedream spend in dollars (pod v1 never emits it; vocabulary kept)
 *   approval  PAUSES the run — answer { id, allow } to resume (or the pod's
 *             approval timeout denies)
 *   ask       PAUSES the run — answer { id, answers } (or the pod's ask
 *             timeout resolves empty and the agent re-plans)
 *   setup     reserved (desktop model download/build UI); pod v1 never emits
 *   permission the run's live permission mode changed mid-flight (advisory)
 *   done      terminal; stopped=true when aborted
 *   error     terminal; human-readable
 *
 * On the wire every frame is enveloped with a monotonic `seq` (the replay
 * cursor), the `runId` it belongs to, and an `at` timestamp — the durable
 * reconnect contract (replay `?from=<seq>` is exclusive).
 */

/** One question the agent puts to the user (the desktop's `ask_user` shape). */
export interface HarnessAskQuestion {
  question: string;
  options?: string[];
}

/** The action taxonomy the pod's approval gate classifies tools into. */
export type HarnessActionKind = "read" | "edit" | "command" | "network" | "dangerous";

/** Session modes: `chat` runs tool-less; `cowork`/`code` get the sandbox toolset. */
export type HarnessMode = "chat" | "cowork" | "code";

/** Permission modes, verbatim from the desktop harness. */
export type HarnessPermission = "ask" | "plan" | "acceptEdits" | "auto" | "bypass";

/** A harness event frame, pre-envelope. Shapes mirror the pod's emit sites. */
export type HarnessFrame =
  | { type: "delta"; delta: string }
  /** The agent asked to SHOW something and the watching surface renders it
   *  itself: `ref` is an app slug, `layout:<name>` (a saved workspace) or
   *  `settings:<page>`; `url` opens a page. A web run's window tools answer
   *  with this frame instead of relaying to a desktop (2026-10-06). */
  | { type: "open-app"; ref?: string; url?: string }
  | {
      type: "tool";
      phase: "start" | "done";
      name: string;
      thought?: string;
      title?: string;
      denied?: boolean;
      failed?: boolean;
      preview?: string;
    }
  | { type: "progress"; inTokens: number; outTokens: number }
  | { type: "credits"; usd: number }
  | { type: "approval"; id: string; kind: HarnessActionKind; title: string; detail: string }
  | { type: "ask"; id: string; questions: HarnessAskQuestion[] }
  | { type: "setup"; phase: string; [k: string]: unknown }
  /** The run's live permission mode changed mid-flight — advisory + non-terminal,
   *  so every surface observing the run re-renders its mode chip together. */
  | { type: "permission"; permission: HarnessPermission }
  | { type: "done"; stopped: boolean }
  | { type: "error"; error: string };

/** A frame as it rides the transport: enveloped with run identity + cursor. */
export type HarnessWireFrame = HarnessFrame & { seq: number; runId: string; at: number };

/** The pod's frame wire version (`POST /run` echoes it; major must match). */
export const HARNESS_WIRE_VERSION = "glyphh.harness/v1";

/** Terminal frame types — after one of these the run emits nothing further. */
export function isHarnessTerminal(frame: Pick<HarnessFrame, "type">): boolean {
  return frame.type === "done" || frame.type === "error";
}

/** True when a parsed wire message is an enveloped harness frame (vs a WS
 *  control message like `{type:"ready"}` — those carry no `seq`). */
export function isHarnessWireFrame(msg: unknown): msg is HarnessWireFrame {
  const m = msg as { seq?: unknown; type?: unknown } | null;
  return !!m && typeof m.seq === "number" && typeof m.type === "string";
}

/** A server-signed attachment the pod fetches once at run start. */
export interface HarnessAttachmentRef {
  name: string;
  url: string;
}

/** A prior turn replayed into the agent's context. */
export interface HarnessChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** One caller-lent HTTP MCP server (the pod allows max 4; plaintext http is
 *  loopback-only pod-side). */
export interface HarnessMcpServerRef {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

/** One inline image for a turn — base64, ridden to the model as a vision
 *  content block. The run body's `prompt` is text, so this is the only path a
 *  pasted screenshot reaches the model. Pod caps: 8 per turn, ~7.5 MiB each,
 *  media type one of image/png · image/jpeg · image/gif · image/webp. */
export interface HarnessImageRef {
  mediaType: string;
  /** Base64 payload — NO `data:` prefix. */
  data: string;
}

/** WHERE THE CALLER IS (surface-aware window tools, 2026-10-06): the surface
 *  the member is looking at when the run starts. The pod keeps it on the run
 *  and sends it to the gateway's /mcp as `x-glyphh-surface`; on the web the
 *  window tools (panels_open / layouts_open / settings_open) answer with an
 *  `open-app` frame the page acts on itself, and nothing is relayed to a
 *  desktop. Absent → the pod treats the run as a desktop/CLI one (today's relay). */
export type HarnessSurface = "web" | "desktop" | "cli";

/** The `POST /run` body (prompt required; the bearer defaults `runtimeToken`
 *  and the token's binding defaults `sessionId` — omit both normally). */
export interface HarnessRunBody {
  prompt: string;
  /** The caller's surface — see {@link HarnessSurface}. */
  surface?: HarnessSurface;
  /** THE DEVICES THIS SESSION MAY REACH (his order, 2026-10-07): the attached
   *  desktops the member added to the chat (the + menu's Devices), by machine
   *  id. The pod sends them to the gateway's /mcp as `x-glyphh-devices`, and
   *  the device tools (device_folders / device_list_dir / device_read_file /
   *  device_search / device_write_file) reach ONLY those machines, inside
   *  ONLY the folders each granted for remote control. Absent → no device tool answers. */
  devices?: string[];
  /** THE TURN'S OWN FOLDER ON THE MACHINE IT WAS BORN ON (his report,
   *  2026-10-07: a desktop Work session pointed at a local folder could not
   *  reach it). Machine id → absolute folders the device tools may reach for
   *  this turn, on top of what each machine granted for remote control. The
   *  pod sends it to the gateway's /mcp as `x-glyphh-folders`; the gateway
   *  honours it only for machines named in `devices`. */
  folders?: Record<string, string[]>;
  /** The CLIENT's thread id (`^[A-Za-z0-9_-]{1,64}$`) — scopes the recorded
   *  transcript; auth stays bound to the token's sessionId. */
  threadId?: string;
  mode?: HarnessMode;
  /** The session's GitHub repo (`owner/repo`) — a cloud workspace's source.
   *  The pod tells the agent and clones it into the workspace when absent. */
  repo?: string;
  /** The BASE BRANCH the pod checks out with {@link repo} (his direction,
   *  2026-10-05): a git ref name, 200 chars at most. Absent → the default. */
  branch?: string;
  /** The member's named cloud environment (contract/environments.ts). Read by
   *  the FRONT DOOR only: it injects the variables and network policy into the
   *  pod body server-side. Absent or "default" → the built-in Default. */
  environmentId?: string;
  sessionId?: string;
  model?: string;
  /** The session's LOOP slug — the program that shapes this turn
   *  (program-per-turn; server/docs/program-per-turn.md). P0: carried for
   *  attribution; the pod's envelope hooks consume it from P1 on. */
  loop?: string;
  /** The loop's PROGRAM SOURCE (P3, desktop parity). Honored ONLY by a LOCAL
   *  auth-off pod, which has no org store to read programs from — the desktop
   *  fetches the code and hands it over. An authed cloud pod DROPS it (org
   *  store is the only program truth there). */
  loopProgram?: string;
  system?: string;
  permission?: HarnessPermission;
  /** The turn's effort (the composer dial — low | medium | high | …), as the
   *  desktop's local run carries it. Absent → the runtime's default. */
  effort?: string;
  history?: HarnessChatTurn[];
  attachments?: HarnessAttachmentRef[];
  gatewayUrl?: string;
  /**
   * The control plane's origin, for the app tool surface the pod lends itself
   * (scaffold_app / create_app_entry / build_app / deploy_app / get_app /
   * list_apps).
   *
   * NORMALLY OMITTED: the pod derives it from `gatewayUrl`, which is always
   * `<control-plane-origin>/api/gateway`. Pass it only for a deployment that
   * splits the gateway from the control plane.
   */
  controlUrl?: string;
  /** The run's gateway credential. A provisioned cloud pod carries its own
   *  (`GLYPHH_RUNTIME_TOKEN`); a LOCAL auth-off pod has none, so the caller
   *  passes its control-plane access token here per run. The pod presents this
   *  same credential to the control plane's app tools, so one token both meters
   *  the turn and publishes what the turn builds. */
  runtimeToken?: string;
  /** Caller-lent HTTP MCP servers wired into the run's toolset (cowork/code). */
  mcpServers?: HarnessMcpServerRef[];
  /** Inline images for THIS turn, as vision blocks ahead of the prompt text. */
  images?: HarnessImageRef[];
  /**
   * The run's working directory — an ABSOLUTE host path the pod's own preset
   * tools (Bash/Read/Edit/Glob/Grep) anchor at.
   *
   * LOCAL PODS ONLY. A pod with auth enabled (i.e. any cloud/tenant pod) 400s
   * this field: only the loopback-bound auth-off pod running on the user's own
   * machine may be pointed at a host path. Validated pod-side (absolute,
   * exists, is a directory, realpath'd). Attachments deliberately do NOT
   * follow it — they stay in the pod's per-session sandbox so a run never
   * litters the user's folder.
   */
  workdir?: string;
  /** Relative folder inside the cloud workspace to run in. */
  subdir?: string;
  maxTurns?: number;
  /** The LOOP's memory policy for this turn: whether the turn rotates around the
   *  stator and how. Absent ⇒ the runtime default (recall + write on). This is how
   *  a loop hands "when memory is used and how" to the turn (docs/runtime-stator-split.md). */
  memory?: HarnessMemoryPolicy;
}

/** How a loop wants a turn to use memory. All optional; absent fields take the
 *  runtime default. */
export interface HarnessMemoryPolicy {
  /** Recall + inject before the loop. Default true. */
  recall?: boolean;
  /** Persist the exchange after the loop. Default true. */
  write?: boolean;
  /** Semantic-recall breadth. */
  topK?: number;
  /** Minimum cosine for a semantic hit. */
  threshold?: number;
  /** The fact-owning entity (default `user`). */
  entity?: string;
  /** The MEMORY ROTOR (opt-in, org-governed): when enabled, a cheap assembler model
   *  builds the worker's system prompt from recalled memory instead of raw-injecting
   *  it. The control plane sets this from the org's memory-rotor settings; clients
   *  stay blind. Absent/disabled ⇒ unchanged behavior. */
  rotor?: {
    enabled?: boolean;
    /** The org's chosen assembler model id (a supported catalog model). */
    model?: string;
    /** Cached standards/rules text (the shipped baseline / org rules). */
    standards?: string;
  };
}

/** The `POST /run` 200 ack. */
export interface HarnessRunAck {
  runId: string;
  sessionId: string;
  wire: string;
}

/** An answer to a parked `approval` (`allow`) or `ask` (`answers`) frame. */
export interface HarnessAnswer {
  allow?: boolean;
  answers?: string[];
}

/** The terminal result of a harness run. An `error` FRAME resolves here (the
 *  run finished, honestly, with an error) — only a transport-level failure
 *  (unreachable pod, reconnect exhausted, bad wire) rejects `done`. */
export interface HarnessRunResult {
  runId: string;
  /** True when the run was aborted (client stop or pod-side stop). */
  stopped: boolean;
  /** The full answer text (every `delta`, concatenated). */
  text: string;
  /** Present when the run terminated with an `error` frame. */
  error?: string;
}
