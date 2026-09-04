/**
 * glyphh-harness-run.ts — a tool-bearing turn, run on the machine's LOCAL
 * HARNESS POD instead of in Electron's own process.
 *
 * ONE HARNESS EVERYWHERE. The same rrotor harness that serves cloud sessions
 * runs here on 127.0.0.1 (`ROTOR_MODE=harness`, introspection OFF → the pod
 * loopback-binds itself; that bind is the security boundary). The desktop
 * stops owning an agent loop and becomes what it should be: the machine, the
 * window, and the user's tool surface.
 *
 *   pod        `@glyphh/sdk/runtime` ensureLocalHarnessPod — the runtime
 *              supervisor's singleton lock / discovery record / detached spawn,
 *              with a harness-mode state home. One pod per MACHINE, shared with
 *              the CLI, deliberately outliving this app (it is a machine
 *              service, not an app subprocess).
 *   tools      the desktop's own surface, lent over loopback MCP
 *              (harness-mcp-bridge.ts) — the pod's `mcpServers` entry.
 *   models     the pod calls the Glyphh gateway directly with the USER's
 *              `gy_at_` access token as `runtimeToken`; metering lands on the
 *              user. No local interceptor is involved.
 *   frames     `glyphh.harness/v1` translates 1:1 onto the renderer's existing
 *              `glyphh-agent:*` IPC — the renderer needs zero changes.
 *   threads    no stator locally, so the pod records nothing; the renderer's
 *              thread-store LWW push stays the persistence path.
 *
 * NOT YET AT PARITY with the in-process path — see GLYPHH_LOCAL_ROTOR in
 * glyphh-agent.ts for the exact list that keeps this behind a flag.
 */

import { app, type WebContents } from "electron";
import { openAppByRef, openBrowserAt } from "./app-resolver";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureLocalHarnessPod } from "@glyphh/sdk/runtime";
import type { HarnessWireFrame } from "@glyphh/sdk";
import { getClient, SERVER_URL } from "./glyphh-client";
import { loadSessions, saveSessions } from "./glyphh-agent-context";
import { runModel, currentLoop, resolveRoles } from "./loop-selections";
import { glyphhMode, registerRemotePause } from "./glyphh-agent-permissions";
import { captureRun } from "./glyphh-agent-training";
import { glyphhToolDefs, connectorWireTools, type ConnectorWireDef } from "./glyphh-agent-tools";
import { selectConnectorTools } from "./tool-vectors";
import { turnNeedsTools } from "./turn-router";
import { attachmentImageRefs, type AttachRef } from "./glyphh-agent-attachments";
import { composeTurn, brandError, type ChatMessage } from "./glyphh-agent-prompt";
import { lendToolSurface, BRIDGE_TOOL_PREFIX, type LentSurface } from "./harness-mcp-bridge";
import { pushToAttach, isAttached } from "./attach-client";
import { toWireFrame } from "./attach-run-frames";

/** Strip the Agent SDK's MCP prefix so tool names read the way the in-process
 *  path emits them (`open_app`, not `mcp__desktop__open_app`). */
function bareToolName(name: string): string {
  return name.replace(/^mcp__[a-z0-9_-]+__/i, "");
}

// ── The pod ────────────────────────────────────────────────────────────────

/** A plain `node` on PATH. The dev pod must NOT be spawned with
 *  `process.execPath` — under Electron that is the Electron binary, which runs
 *  a script as an app (dock icon, Chromium runtime) rather than as Node. */
function nodeOnPath(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const bin = join(dir, "node");
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

/**
 * The launch command for the local pod.
 *
 * `GLYPHH_LOCAL_ROTOR_CMD` always wins (the SDK reads it too). Otherwise, in a
 * DEV checkout, prefer the sibling rrotor build — `<repo>/rrotor/dist/cli.js`,
 * whose `serve -p <port>` entry dispatches on ROTOR_MODE — so a developer runs
 * the code they are editing. A packaged build falls through to the SDK's own
 * resolution (`$GLYPHH_ROTOR_BIN`, then `rrotor` on PATH).
 */
function localRotorCmd(): string | undefined {
  if (process.env.GLYPHH_LOCAL_ROTOR_CMD?.trim()) return undefined; // the SDK reads it
  if (app.isPackaged) return undefined;
  const repoBuild = join(app.getAppPath(), "..", "rrotor", "dist", "cli.js");
  if (!existsSync(repoBuild)) return undefined;
  const node = nodeOnPath();
  return node ? `${node} ${repoBuild}` : undefined;
}

/**
 * The VENDORED rotor — a packaged build's pod. CI places rrotor (dist +
 * pruned node_modules, no native deps: better-sqlite3 loads lazily and the
 * local pod runs the memory backend) under resources/rrotor, and we run it
 * with OUR OWN binary as node (ELECTRON_RUN_AS_NODE). Two hard-won details:
 *
 *  - `bin`/`preArgs` (structured), NOT the whitespace-split `cmd` string —
 *    process.execPath is ".../Glyphh Desktop.app/Contents/MacOS/Glyphh",
 *    and the space in "Glyphh Desktop" would split the command in half.
 *  - This exists because a packaged app's PATH is the GUI default
 *    (/usr/bin:/bin:...): `rrotor` on PATH can never resolve from the dock,
 *    which surfaced as a swallowed ENOENT + a 15s "did not become healthy".
 */
function vendoredRotor(): { bin: string; preArgs: string[]; env: Record<string, string> } | undefined {
  if (process.env.GLYPHH_LOCAL_ROTOR_CMD?.trim()) return undefined; // explicit override wins
  if (!app.isPackaged) return undefined;
  const vendored = join(process.resourcesPath, "rrotor", "dist", "cli.js");
  if (!existsSync(vendored)) return undefined;
  return { bin: process.execPath, preArgs: [vendored], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/**
 * The pod's URL, starting it if needed. `ensureLocalHarnessPod` is idempotent
 * and atomic across processes: a healthy discovery record attaches, otherwise
 * the mkdir lock elects one starter and everyone else waits for its record. A
 * pod that died since the last run fails its health check and is respawned —
 * liveness, port persistence and restart-if-dead all live in the supervisor.
 */
async function ensurePod(): Promise<string> {
  const cmd = localRotorCmd();
  const bundled = vendoredRotor();
  const pod = await ensureLocalHarnessPod({
    ...(bundled ?? {}),
    ...(cmd && !bundled ? { cmd } : {}),
    // Electron's boot is busy; a cold pod (node + SDK load) needs more than
    // the supervisor's 15s default on a first run.
    startTimeoutMs: 30_000,
  });
  return pod.url;
}

// ── Cloud pods ─────────────────────────────────────────────────────────────
//
// A session whose source is cloud runs on a PROVISIONED remote pod, from the
// desktop exactly as it does from the web: same SDK calls, same harness wire.
// The desktop is not limited to this machine — it drives cloud sessions too.

/** The renderer's workspace Source, as far as a run needs to read it. */
export interface RunSource { kind: string; repo?: string }

/** Where a run's pod lives. A cloud pod authenticates (its own runtime token);
 *  the local one runs auth-off on loopback. */
interface PodTarget { url: string; token?: string; cloud: boolean }

export const isCloudSource = (s?: RunSource): boolean => !!s && s.kind !== "local";

// ── Live-run registry (mid-run permission push) ─────────────────────────────
//
// A run's permission mode is a SNAPSHOT at start (`permission` below). When the
// user flips the mode chip mid-turn, we must push the change to the pod driving
// THIS run so its gate re-evaluates. The pod exposes it as POST
// /runs/:id/permission; the SDK's HarnessRun.setPermission() calls it. We keep
// each live run's handle here, keyed by the runId the renderer knows, so an IPC
// (desktop-local) or attach dispatch (a remote surface driving this machine) can
// reach it. Local runs pass the desktop's OWN runId; relayed runs pass the
// caller's minted runId — both key this map.
type PermMode = "ask" | "plan" | "acceptEdits" | "auto";
interface LiveHandle { setPermission(mode: PermMode): Promise<void>; inject(text: string): Promise<void> }
const liveRuns = new Map<string, LiveHandle>();

/** Push a new permission mode to a run in flight. No-op (returns false) when the
 *  run isn't live here — it may have finished, or never ran on this machine. */
export async function setRunPermission(runId: string, mode: PermMode): Promise<boolean> {
  const h = liveRuns.get(runId);
  if (!h) return false;
  try { await h.setPermission(mode); return true; }
  catch { return false; }
}

/** Add a USER message to a run in flight (the pod drains it at the next
 *  between-turn boundary). False when the run isn't live here or refuses
 *  input (settled / final turn already closing). */
export async function injectRunMessage(runId: string, text: string): Promise<boolean> {
  const h = liveRuns.get(runId);
  if (!h) return false;
  try { await h.inject(text); return true; }
  catch { return false; }
}

const PROVISION_TIMEOUT_MS = 90_000;
const PROVISION_POLL_MS = 1_500;

/** Persist a chat's pod binding. Re-read immediately before writing: the
 *  renderer owns this file too, and a run can outlive several of its saves. */
function bindRuntime(chatId: string, runtime: { sessionId: string; url: string; token: string }): void {
  try {
    const { chats, currentId } = loadSessions();
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) return;
    chat.runtime = runtime;
    saveSessions(chats, currentId);
  } catch (err) {
    // A binding that fails to persist costs a re-provision next launch, not
    // the run in flight — never fatal.
    console.warn("[harness] could not persist the runtime binding:", err instanceof Error ? err.message : String(err));
  }
}

/** The chat's cloud pod: its existing binding when it has one, else a freshly
 *  provisioned session polled to `ready`. */
async function ensureCloudPod(chatId: string, source: RunSource): Promise<PodTarget> {
  const bound = loadSessions().chats.find((c) => c.id === chatId)?.runtime;
  if (bound?.url && bound.token) return { url: bound.url, token: bound.token, cloud: true };

  const client = getClient();
  const { session, runtimeToken } = await client.sessions.create({
    // The user's selected agent loop — the same one a local run resolves its
    // model through.
    rotor: currentLoop(),
    locus: "remote",
    ...(source.kind === "cloud-repo" && source.repo ? { repo: source.repo } : { newProject: true }),
  });

  let live = session;
  const deadline = Date.now() + PROVISION_TIMEOUT_MS;
  while (live.status === "provisioning" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, PROVISION_POLL_MS));
    live = await client.sessions.get(session.id);
  }
  if (live.status !== "ready" || !live.runtimeUrl) {
    throw new Error(
      live.status === "provisioning"
        ? "the cloud runtime is still starting — try again in a moment"
        : `the cloud runtime could not start (${live.status})`,
    );
  }
  bindRuntime(chatId, { sessionId: live.id, url: live.runtimeUrl, token: runtimeToken });
  return { url: live.runtimeUrl, token: runtimeToken, cloud: true };
}

/**
 * Build + deploy a Glyphh app IN THE CLOUD POD — the remote-dev counterpart of
 * `deployAppFromWorkdir`. The pod runs `npm install && npm run build` in the SAME
 * workspace the session's turns use, then uploads + deploys via the control plane
 * (POST {runtimeUrl}/apps/deploy). So a user with no local machine can still ship —
 * and, since deploy/promote are server-side, push to production.
 */
export async function deployAppFromCloud(
  slug: string, chatId: string, source: RunSource, opts: { deploy?: boolean } = {},
): Promise<{ ok: boolean; result?: { version?: string; url?: string }; error?: string }> {
  const pod = await ensureCloudPod(chatId, source);
  // Key the pod's workspace to the SAME session its runs resolve (sessionId when
  // bound, else the client thread id) so the build sees the app's source.
  const sessionId = loadSessions().chats.find((c) => c.id === chatId)?.runtime?.sessionId;
  const res = await fetch(`${pod.url.replace(/\/+$/, "")}/apps/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${pod.token}`, "content-type": "application/json" },
    body: JSON.stringify({ slug, ...(sessionId ? { sessionId } : { threadId: chatId }), distDir: "dist", ...(opts.deploy === false ? { deploy: false } : {}) }),
  });
  const json = (await res.json().catch(() => null)) as
    | { ok?: boolean; result?: string; error?: string; stage?: string }
    | null;
  if (!res.ok || !json?.ok) {
    const detail = json?.error ? `${json.stage ? `${json.stage}: ` : ""}${json.error}` : `cloud deploy failed (${res.status})`;
    return { ok: false, error: detail };
  }
  // build_app's text result carries the slug/version/url — surface them like the
  // local path so the Releases tab shows the same "Built vX — live at …".
  let info: { version?: string; url?: string } = {};
  try {
    const p = JSON.parse(json.result ?? "") as Record<string, unknown>;
    info = {
      version: typeof p.version === "string" ? p.version : undefined,
      url: typeof p.url === "string" ? p.url : (typeof p.deployUrl === "string" ? p.deployUrl : undefined),
    };
  } catch { /* non-JSON text — no structured fields */ }
  return { ok: true, result: info };
}

// ── The run ────────────────────────────────────────────────────────────────

/**
 * Run one tool-bearing turn on the local pod. Emits the SAME renderer events
 * the in-process path emits, on the same channels, with the same payloads —
 * this function is a drop-in for `sdkRun`.
 */
export async function harnessRun(
  wc: WebContents,
  runId: string,
  base: ChatMessage[],
  ctrl: AbortController,
  attachments: AttachRef[] = [],
  chatId = "",
  runWorkdir?: string,
  mode: "cowork" | "code" = "code",
  source?: RunSource,
  /** Permission mode from a RELAYING client (mobile/web driving this machine). When
   *  set it OVERRIDES the desktop's own mode — the run must honor the caller's choice
   *  (e.g. 'auto'). Absent for a desktop-local run → the local `glyphhMode()`. */
  permissionOverride?: "ask" | "plan" | "acceptEdits" | "auto",
  /** Publish this run's frames UP the attach socket (channel `run:<runId>`) so the
   *  run-stream broker captures them and ANOTHER surface (web/mobile) can watch this
   *  desktop-local turn live. The RELAY path (attach-run.ts) already publishes via its
   *  sink, so it leaves this false; the desktop-local IPC path sets it true. Best-effort:
   *  a closed socket just means nobody's watching elsewhere — the local run is untouched. */
  publishFrames = false,
  /** Model id from a RELAYING client (web/mobile driving this machine). When set
   *  it OVERRIDES the desktop's own loop model — the caller's picker wins. Absent
   *  for a desktop-local run → the local `runModel('default')` resolution. */
  modelOverride?: string,
  /** Agent LOOP (rotor) id from a RELAYING client. When set it OVERRIDES the
   *  desktop's own active loop (the `rotor` the pod runs). Absent → `currentLoop()`. */
  loopOverride?: string,
): Promise<void> {
  const cloud = isCloudSource(source);
  // Monotonic seq for the published wire frames (broker ordering rides Redis stream
  // ids, but the frame carries its own seq for parity with the relay ring).
  let pubSeq = 0;
  const emit = (channel: string, data: Record<string, unknown>): void => {
    try { if (!wc.isDestroyed()) wc.send(channel, { runId, ...data }); } catch { /* panel gone */ }
    // Tee to the broker for cross-surface observation. `threadId` on every frame lets
    // the server record this thread's active run once (broker setActiveRun), so a web
    // client can discover + attach to it.
    if (publishFrames && isAttached()) {
      try {
        const wf = toWireFrame(channel, { ...data }, pubSeq++, runId);
        if (wf) pushToAttach(`run:${runId}`, { ...wf, ...(chatId ? { threadId: chatId } : {}) });
      } catch { /* never let publishing perturb the run */ }
    }
  };

  let lent: LentSurface | null = null;
  const cancelPauses: Array<() => void> = [];
  let finalText = "";
  let runError = "";
  /** Tool starts — the run's work magnitude for the training capture. */
  let turnsUsed = 0;

  let runSessionMinted = false;
  try {
    // 1. The credential — RUN-SCOPED (his bug, 2026-08-25: a ~20-minute build
    //    outlived the caller's 15-minute access token, and the gateway started
    //    401ing mid-run: "Failed to authenticate"). The run gets its own
    //    session: same user, same org, no new privilege, a visible revocable
    //    device (`run:<id>`) that the finally block RELEASES — so the 12h TTL
    //    is a ceiling, never the lifetime. Falls back to the caller's token on
    //    an old server, which is exactly today's behaviour.
    let runtimeToken = await getClient().sessions.createRunSession(runId)
      .then((r) => r.accessToken)
      .catch(() => "");
    if (runtimeToken) runSessionMinted = true;
    else runtimeToken = (await getClient().token()) ?? "";
    if (!runtimeToken) throw new Error("sign in to run a turn — the local harness needs your access token to reach the gateway");

    // 2. The turn, assembled exactly as the in-process path assembles it —
    //    the path manifest in the text, the images as real vision blocks.
    const { system, lastUser, ask } = await composeTurn(base, chatId, attachments, runWorkdir);
    const images = attachmentImageRefs(attachments);

    // 3. The tool surface. Builtins for the mode; connectors as first-class
    //    tools with their real schemas (code mode pays for find_tools/call_tool
    //    instead of a catalog subset — the same trade the in-process path makes).
    //    A CLOUD pod works in its own sandbox and cannot reach this machine's
    //    loopback bridge, so it is lent nothing and brings its own tools.
    //
    //    PRE-ROUTER (turn-router.ts): the Chat/Work/Code spaces were collapsed,
    //    so `mode` is always 'code' and every turn — even a one-line chat —
    //    would otherwise dump the FULL builtin surface. The system, not the
    //    user, decides tool cost per turn: for an obviously-conversational turn
    //    we assemble a MINIMAL surface (no builtins, no connector subset) and
    //    keep only find_tools/call_tool lent as an escape hatch, so a
    //    mis-classified chat can still discover + call a tool mid-turn
    //    (progressive loading). Cloud is exempt here — the pod brings its own
    //    tools — and the same pre-router belongs in the pod's assembly as a
    //    follow-up (TODO(cloud) in turn-router.ts).
    const wantsTools = cloud ? true : await turnNeedsTools(lastUser, base).catch(() => true);

    // find_tools/call_tool are the progressive-loading escape hatch — always
    // present so a no-tools turn that turns out to need a tool can still reach
    // one. In the full-tools branch they ride along inside the builtins.
    const ESCAPE_HATCH = new Set(["find_tools", "call_tool"]);
    const fullDefs = cloud ? [] : glyphhToolDefs(mode);
    const defs = cloud || wantsTools ? fullDefs : fullDefs.filter((d) => ESCAPE_HATCH.has(d.name));

    // Wire the connector catalog even in the no-tools branch: it costs no
    // prompt tokens (it only populates the module-level wireMap/lastWireDefs
    // that back find_tools/call_tool), and without it the escape hatch would
    // search a stale/empty catalog. What we skip when tools are gated off is
    // the per-ask PRESELECT — those defs DO ride the prompt — so connDefs stays
    // empty and find_tools discovers the rest lazily if the model reaches for it.
    const connCatalog = cloud ? [] : await connectorWireTools().catch(() => [] as ConnectorWireDef[]);
    const connDefs = cloud || !wantsTools || mode === "code"
      ? []
      : await selectConnectorTools(ask, connCatalog).catch(() => connCatalog.slice(0, 24));

    // 4. Pod + bridge, in parallel — neither depends on the other.
    const knownTools = new Set([...defs.map((d) => d.name), ...connDefs.map((d) => d.name)]);
    const [target, surface] = await Promise.all([
      cloud
        ? ensureCloudPod(chatId, source as RunSource)
        : ensurePod().then((url): PodTarget => ({ url, cloud: false })),
      cloud ? Promise.resolve(null) : lendToolSurface({
        wc,
        signal: ctrl.signal,
        ...(runWorkdir ? { workdir: runWorkdir } : {}),
        ...(loopOverride ? { loop: loopOverride } : {}),
        defs,
        connDefs,
        // Lent-tool activity is reported HERE, in full fidelity (gate title,
        // denial, failure, preview) — the pod's own frames for the same calls
        // are suppressed below so the renderer sees each tool exactly once.
        onTool: (e) => emit("glyphh-agent:tool", e as unknown as Record<string, unknown>),
      }),
    ]);
    lent = surface;

    // 5. Start the run and translate its frames. The model is the user's pick,
    //    already constrained to what their workspace allows (loop-selections);
    //    an unresolved one lets the pod fall back to its own default.
    // A relaying client's model wins outright; else resolve via ITS loop (or the
    // desktop's own when no override), so the caller's loop pick drives the model.
    const model = modelOverride ?? await runModel("default", loopOverride).catch(() => null);
    // FAIL FAST when nothing can serve the turn (his bug, 2026-08-25: the app
    // "just spins"). Omitting the model lets the pod use its own default,
    // which is right when one exists — but when the caller's loop resolves
    // NO gateway-ready model, the pod's guess only reaches the gateway to be
    // refused, and the SDK's retry ladder turns a config error into minutes
    // of silence. Say it now, in the words the chat path already uses.
    if (!model) {
      const usable = await resolveRoles(loopOverride ?? currentLoop())
        .then((roles) => roles.some((r) => (r.choices ?? []).some((c) => c.gatewayReady !== false)))
        .catch(() => true);   // can't tell → let the pod try, as before
      if (!usable) {
        throw new Error("no model available — your workspace allows none, or the ones it allows have no key configured");
      }
    }
    const pod = getClient().harness({
      url: target.url,
      ...(target.token ? { token: async (): Promise<string> => target.token as string } : {}),
    });
    const run = pod.start({
      prompt: lastUser,
      system,
      // The CLIENT's chat id on both axes: `threadId` scopes the transcript,
      // `sessionId` keys the pod's per-session workspace + agent config home
      // (auth-off means no token binding to inherit one from).
      threadId: chatId || undefined,
      sessionId: chatId || undefined,
      mode,
      permission: permissionOverride ?? glyphhMode(),
      ...(model ? { model } : {}),
      // The SESSION'S REAL FOLDER as the run's cwd. A LOCAL (auth-off,
      // loopback) pod honours this and anchors its OWN preset tools —
      // Bash/Read/Edit/Glob/Grep — there; a cloud pod 400s the field, which is
      // exactly the boundary we want. Without it those tools worked inside the
      // pod's empty sandbox while the user's folder sat untouched.
      ...(!cloud && runWorkdir ? { workdir: runWorkdir } : {}),
      // Pasted screenshots as vision blocks ahead of the prompt text. Pod-side
      // caps (8 × ~7.5MiB) sit above the decoder's, so an accepted turn is
      // never one the pod rejects.
      ...(images.length ? { images } : {}),
      // The gateway is named on EVERY run, cloud included. A pod needs it for
      // two things now: model egress, and deriving the control plane's app
      // tool surface (scaffold_app/create_app_entry/build_app/deploy_app),
      // which it lends itself so a run can actually PUBLISH what it built.
      // Without it a cloud agent writes an app and has nowhere to put it.
      gatewayUrl: `${SERVER_URL}/api/gateway`,
      // The CREDENTIAL differs, and only the credential. A cloud pod already
      // holds its session's own `gy_rk_` (it arrives as this request's bearer
      // and the pod falls back to it), so handing it this machine's token
      // would re-attribute the turn to the wrong principal. A LOCAL pod runs
      // auth-off and has none, so it is passed the user's access token — which
      // the control plane resolves to the same person either way.
      ...(cloud ? {} : { runtimeToken }),
      // The desktop's own machine tools reach the pod over loopback, which a
      // cloud pod cannot use. App tools are NOT lent here by either surface —
      // the pod derives them from `gatewayUrl` above, so both get the same set.
      ...(surface ? { mcpServers: [{ name: surface.name, url: surface.url, headers: surface.headers }] } : {}),
      signal: ctrl.signal,
    });

    // Register the live handle so a mid-run permission-mode change (the user
    // flipping the mode chip on ANY surface) reaches THIS run's pod: the local
    // IPC path and the attach `agent.permission` dispatch both resolve by runId
    // here and call HarnessRun.setPermission → POST /runs/:id/permission.
    liveRuns.set(runId, { setPermission: (mode) => run.setPermission(mode), inject: (text) => run.inject(text) });

    // Publish the user's prompt as the run's FIRST frame so any surface observing this
    // run over the broker renders the turn's user message (assistant frames don't carry
    // it). Local display ignores the channel; the broker + relay sink forward it.
    emit("glyphh-agent:prompt", { text: ask });

    run.on((frame: HarnessWireFrame) => {
      switch (frame.type) {
        case "open-app" as never: {
          // The pod asked to SHOW something. This machine executes the run, so
          // it opens the panel here (RPA needs the desktop webview; a user at
          // the desktop sees it); a web/mobile surface watching the run's
          // stream renders its own view from the same frame.
          const f = frame as unknown as { ref?: string; url?: string };
          if (f.url) openBrowserAt(f.url);
          else if (f.ref) void openAppByRef(f.ref).catch(() => { /* unknown app — the tool result already told the model */ });
          return;
        }
        case "delta":
          finalText += frame.delta;
          emit("glyphh-agent:delta", { delta: frame.delta });
          return;
        case "tool": {
          // Our own lent tools already reported themselves (start AND done)
          // through the bridge, with the gate's title and denial state — which
          // the pod cannot see. Drop its echo.
          if (frame.name.startsWith(BRIDGE_TOOL_PREFIX)) return;
          // The wire carries no turn count (the pod keeps it internally), so
          // the training capture uses tool starts as its proxy for "how much
          // work did this run do" — honest as a magnitude, not as a turn count.
          if (frame.phase === "start") turnsUsed++;
          const { seq: _s, runId: _r, at: _a, type: _t, ...rest } = frame;
          emit("glyphh-agent:tool", { ...rest, name: bareToolName(frame.name) });
          return;
        }
        case "progress":
          emit("glyphh-agent:progress", { inTokens: frame.inTokens, outTokens: frame.outTokens });
          return;
        case "credits":
          emit("glyphh-agent:credits", { creditsMicro: frame.creditsMicro });
          return;
        case "approval": {
          // The pod gates its OWN sandbox tools; the desktop gates the lent
          // ones inside executeGlyphhTool. A lent tool falls into the pod's
          // unknown-tool bucket, whose card title IS the bare tool name — let
          // it through so the user sees ONE card (the desktop's), not two.
          if (knownTools.has(frame.title)) { void run.answer(frame.id, { allow: true }); return; }
          cancelPauses.push(registerRemotePause(frame.id, (reply) => void run.answer(frame.id, { allow: !!reply.allow })));
          emit("glyphh-agent:approval", { id: frame.id, kind: frame.kind, title: frame.title, detail: frame.detail });
          return;
        }
        case "ask":
          cancelPauses.push(registerRemotePause(frame.id, (reply) => void run.answer(frame.id, { answers: reply.answers ?? [] })));
          emit("glyphh-agent:ask", { id: frame.id, questions: frame.questions });
          return;
        case "setup": {
          const { seq: _s, runId: _r, at: _a, type: _t, ...rest } = frame;
          emit("glyphh-agent:setup", rest as Record<string, unknown>);
          return;
        }
        case "permission":
          // The pod echoes a mid-run mode change back on the stream — forward it
          // so the local renderer AND any surface observing this run (via the
          // broker tee in `emit`) re-render the mode chip together.
          emit("glyphh-agent:permission", { permission: (frame as { permission?: string }).permission });
          return;
        default:
          // done/error settle `run.done` — reported once, below.
          return;
      }
    });

    const result = await run.done;
    if (result.stopped || ctrl.signal.aborted) {
      emit("glyphh-agent:done", { stopped: true });
      captureRun({ kind: "agent", mode: glyphhMode(), turnsUsed, stopped: true, messages: base });
      return;
    }
    if (result.error) {
      runError = brandError(result.error);
      emit("glyphh-agent:error", { error: runError });
    } else {
      emit("glyphh-agent:done", { stopped: false });
    }
  } catch (err) {
    if (ctrl.signal.aborted) {
      emit("glyphh-agent:done", { stopped: true });
      captureRun({ kind: "agent", mode: glyphhMode(), turnsUsed, stopped: true, messages: base });
      return;
    }
    runError = brandError(err instanceof Error ? err.message : String(err));
    emit("glyphh-agent:error", { error: runError });
  } finally {
    liveRuns.delete(runId);
    for (const cancel of cancelPauses) cancel();
    lent?.release();
    // The run's own session dies WITH the run — a credential that outlives its
    // reason to exist is the only real cost of minting one.
    if (runSessionMinted) {
      void getClient().sessions.releaseRunSession(runId).catch(() => { /* expires on its own */ });
    }
  }

  // The flywheel: transcript + outcome are next-era training data.
  captureRun({
    kind: "agent",
    mode: glyphhMode(),
    turnsUsed,
    final: finalText,
    ...(runError ? { error: runError } : {}),
    messages: [...base, { role: "assistant", content: finalText }],
  });
}
