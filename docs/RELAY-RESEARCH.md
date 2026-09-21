# Relay research — what existed, what survives, what it takes to wire it back

> Research, 2026-09-21. The question: bring back the relay so (a) the mobile
> web reaches THIS desktop's local Glyphh loop through the server with no cloud
> sessions, and (b) Claude Desktop reaches the bridge over real https (its
> gateway and issuer refuse plain-http loopback). Sources: the server repo's
> history, the app repo's history, the SDK and CLI as they ship today, and the
> memory notes from the attach / relay / run-stream work of July–August 2026.

## 1. The short answer

The relay was never lost; it was cut in "the purge" (2026-09-09/10) and both
halves are recoverable from one ref each:

| Half | Where it is | Ref |
| --- | --- | --- |
| Server: attach plane, run relay, Redis fabric, run-stream broker, tests | yo/server history (the old Express server) | `37a9c840b9` (`git show 37a9c840b9:src/domains/attach/…`) |
| Desktop: attach client, capability handlers, the remote-run executor, frame translator + test | yo/app history | `083114d4` (`git show 083114d4:src/main/attach-*.ts`) |
| Mobile web bundle + serve + mobile shell | yo/app history | `083114d4:web/…` (30 files) |
| Local Glyphh loop integration (rrotor harness pod) | yo/app history | `609d6acd:src/main/glyphh-harness-run.ts` |

What still ships today, untouched: the whole client side of the wire in the
SDK (`startAttachHost`, `AttachClient.run` with answer/stop/permission,
`RunStreamClient` with cursor resume, `client.run({target:"desktop"|"cloud"})`),
the CLI's machine host, the desktop's capability registry and its modules
(fs, pty, panels, RPA, the local MCP server), the renderer's `remote-run.ts`
transport, and rrotor itself with `ensureLocalHarnessPod`.

What is genuinely missing: the server routes (the server is now the LiteLLM
Python fork; the old domain is Express), about 250 lines of desktop glue that
exist verbatim in git, and two small SDK additions.

## 2. What existed (the shape)

**Outbound only.** The machine dials `wss://<server>/ws/attach` with the
member's own bearer (`Authorization` header; `?token=` for browsers). Nothing
dials into a personal machine; that inbound relay was deleted in July for
exactly that reason and is not coming back.

**Frames.** `{t:"hello", app, version, name, capabilities}` on open;
server→machine `{t:"req", id, method, params}`; machine→server
`{t:"res", id, ok, result|error}`; machine→server unsolicited
`{t:"push", channel, data}`; `ping`/`pong`. Correlation by `id`, 60 s
deadline, 30 s server heartbeat.

**Registry.** Per user, in process: `Map<userId, Set<Machine>>`. Dispatch is
capability-aware and most-recent-wins, with a deliberate fallback to the
newest machine when the advertised list is stale (a pre-refusal once made web
panel input die silently while frames flowed).

**REST + SSE on top.** `GET /api/attach/status`, `POST /api/attach/dispatch`
(self only), `POST /api/attach/run` (SSE of the turn), `/run/answer`,
`/run/stop`, `/run/permission`. No machine attached is always a clean 409/412,
never a 500. A dropped SSE never kills the run; stop is explicit.

**Run relay.** The machine pushes `run:<runId>` frames; the server writes them
to the held SSE response and, when Redis is up, tees every frame into a Redis
Stream (`run:<runId>`, MAXLEN 10k, 1 h TTL) with an active-run pointer per
thread, so any surface can replay from a cursor. That is the run-stream
broker: `GET /api/threads/:id/active-run`, `POST /api/run-stream/:runId`.

**Fabric.** Redis pub/sub made N server instances one: presence hash per user,
instance liveness with a 45 s TTL, a command channel per instance, a reply
channel per request, a push fan-out channel. Without `REDIS_URL` every fabric
call no-ops and the build behaves single-instance. Four hard-won fixes ride
in it and must not be re-derived: bound the presence lookup so a sick Redis
cannot hang a dispatch a local socket could serve; never pre-refuse on a
stale capability list; clear the active-run pointer on every terminal path
including dispatch failure; subscribe on Redis `ready`, not at construction.

**The machine-side executor.** `attach-run.ts` registered `agent.run`,
`agent.frames`, `agent.answer`, `agent.stop`, `agent.permission`. It ran the
turn through a fake `WebContents` sink: whatever engine emitted
`glyphh-agent:*` events got them translated by the pure `toWireFrame()` and
pushed up the socket, with a per-run ring for replay. The relaying client's
permission, model and loop overrode the desktop's. The engine behind it was
the rrotor harness pod (`glyphh-harness-run.ts`), but the sink contract is the
renderer's, so today's `glyphh-cli-bridge.ts` (the `claude` subprocess) fits
it unchanged.

**The web side.** `/ws/panel` let the browser subscribe to its own user's
pushes and send only an allow-list of methods: `panel.*` and the four
`pty.*`. Never the machine's full surface. The web bundle was a plain esbuild
script injected in front of the same `dist/renderer`, served by a
dependency-free `serve.mjs` that proxied `/api/*` to the server and `/rt/*`
to the local harness, so a phone on one tunnel was same-origin with both.

## 3. What survives and where

Shipping today, no work:

- SDK `runtime/attach.ts` (`startAttachHost`: dial, hello, `req`→handler→`res`,
  backoff to 30 s), `resources/attach.ts` (status, dispatch, fsList, `run` as
  SSE with the abort→`stopRun` safety net, answer, stop, permission),
  `resources/run-stream.ts` (activeRun, subscribe with Redis-id cursor,
  `attach(threadId)` loop), `client.run({target})`, `runtime/harness-pod.ts`
  (`ensureLocalHarnessPod`), `machine/index.ts`.
- CLI `machine-host.ts` (three `machine.*` handlers) and `harness.ts` (a
  working LOCAL-or-CLOUD pod consumer).
- Desktop `relay-client.ts` (the registry and a local push bus),
  `relay-handlers.ts`, `relay-fs.ts`, `relay-pty.ts`, `rpa.ts`, `panel-host.ts`,
  `local-mcp-server.ts`; renderer `remote-run.ts`, `relay-socket.ts`,
  `panel-stream.ts`, `remote-terminal.ts`; the four `attachStart/attachStop`
  call sites in `auth.ts` (the functions are stubs).
- rrotor with a built `dist/`, harness mode, `/ws` attach and `/runs/:id/frames`.
- The server already has FastAPI WebSocket support, a coordination Redis on
  every machine, and the member's OIDC provider.

Gaps found on the way (live bugs, not history):

- `local-mcp-server.ts` still dispatches `loops.run`, `skills.run`,
  `agents.run`, `scrape.page` but no handler registers them since the purge;
  those four MCP tools throw `unknown method`. `relay-fs.ts` claims
  `fs.list/gitInfo/mkdir` are registered by attach-handlers; they are not.
- The SDK's `startAttachHost` has no `{t:"push"}` sender and no `refreshHello`,
  so it can answer requests but cannot stream a run back, and it can re-open
  the hello-before-handlers race the desktop client had fixed.
- `credits` frames: the contract says `{usd}`, the CLI reads `creditsMicro`,
  the old desktop translator emitted `creditsMicro`. Pick one.
- The desktop's run-stream observer lands on `agent-stubs` today, so a
  desktop cannot watch a run started elsewhere. Web can.

## 4. What it takes: mobile web → server → this machine's loop

No cloud sessions. The machine is the runtime; the server is the relay.

**Server (the whole build is here, a port not a design):**

1. `/ws/attach` as a FastAPI WebSocket route in the glyphh overlay:
   authenticate the bearer with `console.resolve` (the same four credential
   shapes), keep the per-user registry in process, heartbeat, correlate
   `req`/`res`, route `push` by channel.
2. `GET /api/attach/status`, `POST /api/attach/dispatch` (self only).
3. `POST /api/attach/run` as a StreamingResponse of SSE frames, plus
   `/run/answer`, `/run/stop`, `/run/permission`; the run relay that bridges
   `run:<id>` pushes to the held response and clears the pointer on terminal.
4. Placement across the two Fly machines. Two honest options: port the Redis
   fabric (presence + command bus + reply channel, the four fixes above), or
   record the Fly machine id per attached member and answer requests for a
   member attached elsewhere with `fly-replay: instance=<id>`, which keeps the
   stream on the machine that owns the socket with no bus at all. Replay is
   less code; the fabric is proven. Start with replay, keep the fabric port
   as the fallback if replay misbehaves on streamed responses.
5. The run-stream broker only when a second surface must watch a live run.
   v1 does not need it; `POST /api/attach/run` streams directly.
6. `/ws/panel` only when remote panels or a remote terminal on the phone are
   wanted. Not needed for turns.
7. Governance: the old `relay_enabled` org flag and per-device `relay_devices`
   opt-in were Postgres-bound. Re-model as an org switch on `glyphh_org` if
   per-device consent is wanted; otherwise the member's own session is the
   consent, as it is for the bridge.

**Desktop:**

8. An attach host: `startAttachHost` from the SDK with
   `handlers = Object.fromEntries(listRelayMethods().map(m => [m, p => dispatchRelayMethod(m, p)]))`,
   after adding `push(channel, data)` and `refreshHello()` to the SDK host.
9. Un-stub `attachStart`/`attachStop` in `auth.ts` (two lines; the call
   sites are right).
10. `attach-run.ts` and `attach-run-frames.ts` (+ its test) back verbatim
    from `083114d4`, with the sink pointed at the engine of the day.
11. The engine. Two choices:
    - **The CLI bridge.** `glyphh-cli-bridge.ts` already emits the exact
      `glyphh-agent:*` events the sink translates. Smallest change, matches
      the current "the CLI is the loop" ruling, and it is the same driver
      Bridge Mode's account lane uses. A remote turn then runs on the
      member's own Claude login.
    - **The rrotor harness pod.** Restore `glyphh-harness-run.ts` +
      `harness-mcp-bridge.ts` from `609d6acd`; `ensureLocalHarnessPod` and
      rrotor still exist and the CLI proves the path. This is "the local
      Glyphh loop" in the strict sense: deterministic RotorSpec runs on the
      machine, models through the gateway on the member's token.
    Both can sit behind the same `agent.run`; the request's `loop` field
    picks. Ship the CLI bridge first, add the harness as the second loop.
12. Re-register the folder-picker and directory handlers (`fs.list`,
    `fs.gitInfo`, `fs.mkdir`, `sessions.list/get`, `machine.appsList/appOpen`)
    from `083114d4:src/main/attach-handlers.ts`, which also fixes the four
    dangling MCP tools.
13. Background mode already exists again (Bridge Mode's tray). The attach
    socket rides it.

**Web/mobile:**

14. Restore `web/serve.mjs` and `web/src/{bridge,glyphh-web,glyphh-core,web-contract,web-boot,web-errors,wb-relay}.js`
    from `083114d4`; `mobile.tsx` and `mobile-panel.ts` if the phone-native
    shell is wanted. The `web/.env` still on disk is the local-stack config.
    The renderer's `remote-run.ts` already routes a local session's turn to
    `client.run({target:"desktop"})` and observes through `runStream`.

## 5. Claude Desktop on the same relay

Claude Desktop refuses plain-http loopback for its gateway and issuer. With
the relay back, the bridge moves its front door to the server and keeps its
engine on the machine:

- Issuer: the server's OIDC provider, already built and already accepted by
  Claude Desktop. The local issuer becomes a dev convenience.
- Gateway URL: a server route, `POST /bridge/v1/messages`, bearer = the
  server access token or the member key. The server decides the lane from the
  org's routing table (already on the server). Gateway lane: forward to
  LiteLLM on the member's key, no machine involved. Account lane: dispatch
  `bridge.turn` down the member's attach socket; the desktop runs the headless
  Claude session it already has (`bridge/claude-session.ts`, the SSE adapter,
  the ask protocol) and pushes Messages SSE frames back; the server streams
  them to Claude Desktop. No machine attached: a clear error message, never a
  hang. Usage for the account lane is reported by the desktop as today.
- Metering, routing and the plan gate all stay server-side; the desktop's
  `bridge-mode.ts` shrinks to the attach host plus the account-lane executor.

## 6. Order and size

1. Server attach plane on FastAPI: `/ws/attach`, registry, status, dispatch,
   `run` SSE + answer/stop/permission, fly-replay placement. The old tests
   (`test/domains/attach/*`, `test/e2e/horizontal.test.ts` at `37a9c840b9`)
   are the acceptance suite to port. Largest piece; two to three days.
2. SDK host: `push` + `refreshHello`. Small, with tests.
3. Desktop: attach host wired, `attach-run.ts` + frames back, engine = CLI
   bridge, handlers re-registered. One day, mostly restoration.
4. Claude Desktop through the server: `POST /bridge/v1/messages` + `bridge.turn`
   dispatch. One day; reuses everything built this week.
5. Mobile web restored and served, `target:"desktop"` turns verified on a
   phone. One day.
6. Later: the rrotor harness as the second loop, the run-stream broker for
   watching a run from a second surface, `/ws/panel` for remote panels.

## 7. Risks worth naming

- **Two Fly machines.** The socket and the request land on different boxes.
  Replay is the cheap answer; verify it with a streamed response before
  committing to it.
- **Python WebSocket under uvicorn with LiteLLM's middleware.** LiteLLM's
  own realtime routes prove WS works in this app; the attach route must sit
  outside LiteLLM's key auth (glyphh routes already do).
- **Sessions.** The old server keyed everything by `userId` from `gy_at_`
  tokens. The new server's `console.resolve` yields the same `user_id`; the
  bridge's server-side access tokens carry `sub`. Keep one identity.
- **Consent.** The inbound relay died for bypassing local permissions. The
  outbound attach keeps the machine's permission engine in the loop; the
  relaying client's permission mode overrides only within what the org's
  routing row allows.
