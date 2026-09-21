# Bridge Mode — Claude Desktop → Glyphh bridge → gateway

> Claude Desktop points its gateway setting at a Glyphh bridge running on the
> user's machine. The bridge is what Claude Desktop signs in to; Glyphh is what
> the bridge signs the user in to. Behind the bridge every turn takes one of two
> lanes: the **gateway** (metered, any model the org allows) or the **account**
> (a headless `claude` session on the company's own Anthropic login). The lane
> is chosen per request from a routing table the org admin owns on the gateway.
> Claude Desktop never knows anything sits in the middle.
>
> Decided 2026-09-21; built the same day (see §13 for where the build departed from the plan).

## 0. Why

- A Claude Desktop user cannot pick where a model runs. The client has one
  gateway switch, one Anthropic model list, no per-model routing.
- The org wants to balance spend: burn the Anthropic seat the company already
  pays for on some work, send the rest to open-weights and cheaper models
  through the gateway, and see both in one place.
- The bridge is the only point on the machine both of those paths pass
  through. We already run one: the memory bridge is a loopback proxy every loop
  can point at (`app/src/main/memory-bridge.ts`), and the Agent panel already
  drives `claude` as a stream-json subprocess (`app/src/main/glyphh-cli-bridge.ts`).

## 1. The shape

```
Claude Desktop ──OIDC + Messages API──▶ Glyphh bridge (127.0.0.1)
                                          │
                     ┌────────────────────┼─────────────────────┐
                     ▼                    ▼                     ▼
             gateway lane           account lane           (later) direct lane
      LiteLLM gateway, member's   headless `claude` on      provider API with
      Glyphh token; budgets,      the company's Anthropic   the user's own key
      allow-list, pool wall,      login; Anthropic bills
      prompt caching, metering    the seat
```

The bridge is the app we already ship, started with a **Bridge Mode** flag on
the TUI: the terminal panel with the TUI and nothing else. The rest of the app
stays installed for the day the user opens it.

## 2. Trust chain

Order of trust is Glyphh first, then the bridge, then Claude Desktop.

1. **Bridge Mode starts.** The user signs in to Glyphh in the TUI the way they
   do today (device grant or magic link; an org with SSO lands on its own IdP).
   The bridge now holds a Glyphh session for one member.
2. **The bridge is an OpenID provider to Claude Desktop only.** It serves, on
   the loopback:
   - `GET /.well-known/openid-configuration`
   - `POST /oauth/register` (dynamic client registration, public clients)
   - `GET /oauth/authorize` — no login page of its own. If the bridge holds no
     Glyphh session it opens the Glyphh sign-in and comes back; otherwise it
     issues the code at once for the member it holds.
   - `POST /oauth/token` — PKCE S256, rotating refresh
   - `GET /oauth/jwks`, `GET /oauth/userinfo`
   This is the server's `glyphh_auth/oidc.py` shape, re-implemented locally
   with its own keypair. The bridge's tokens never leave the machine; they are
   only ever presented back to the bridge.
3. **Claude Desktop settings**, written once, by the user or by managed config:
   Gateway base URL and Issuer URL both the bridge (`http://127.0.0.1:<port>`),
   Client ID `claude-desktop`, Credential kind interactive sign-in, Bearer
   token access token, Scopes `openid profile email offline_access glyphh-gateway`.
   The Connect dialog's Claude Desktop card shows these values when the bridge
   is running, in place of the server's.
4. **Every request** from Claude Desktop arrives at the bridge as that member.
   On the gateway lane the bridge swaps the bearer for the member's Glyphh
   gateway credential (`gatewayCreds()` in `gateway-token.ts`), so the gateway
   resolves org, team and budget exactly as it does for a CLI today.

Revoking the member's sign-ins on the server (Connected Clients) must also cut
Claude Desktop off: the bridge checks its Glyphh session on each token refresh
and refuses to mint when the server says revoked.

**Checks before build:** whether Claude Desktop accepts plain-http loopback for
issuer and gateway URLs (OAuth allows it for native clients; the app may not),
and whether it re-reads the gateway setting without a restart. If https is
required, the bridge serves a certificate the app installs for its own listener
only. Nothing here touches Anthropic's own traffic.

## 3. The bridge listener

One HTTP server on the loopback, fixed port, up for the life of Bridge Mode.
Today the memory bridge listens on an ephemeral port behind the memory
preference and forwards only under `/fwd/<launch-secret>/<b64 upstream>/…`.
Bridge Mode adds to the same server:

| Route | Purpose |
| --- | --- |
| `/.well-known/openid-configuration`, `/oauth/*` | the local issuer (§2) |
| `POST /v1/messages` | the turn: lane decision, then forward or run |
| `GET /v1/models` | the org's model list, so Claude Desktop's picker matches the table |
| `/fwd/<secret>/…` | unchanged, the loops' seam |

The port is persisted so the URL in Claude Desktop does not change across
restarts; the launch secret stays for `/fwd` only. `/v1/*` authenticates with
the bridge's own bearer.

Memory inject and capture ride `/v1/messages` on both lanes for free: the
Anthropic-wire helpers in the memory bridge already do it for CLI traffic.

## 4. Routing table

Owned by the org admin on the gateway, read by the bridge, cached briefly.

```
GET /api/gateway/org-routing            → { rows: RoutingRow[], updatedAt }
PUT /api/gateway/org-routing            → org admin writes rows

RoutingRow {
  model:        string          // the name Claude Desktop asks for, or "*"
  lane:         "gateway" | "account"
  target?:      string          // gateway lane: the gateway model/alias to run
  permission?:  "read-only" | "plan" | "edits" | "auto"   // account lane
  chatOnly?:    boolean         // account lane: tools off (§6)
}
```

- First matching row wins; `*` is the default. No row means gateway lane on the
  requested name.
- Stored on `glyphh_org` (one jsonb column, `routing jsonb`), same as
  `memory_policy`; served and written by `routes.py` beside org settings;
  edited in the console under Router Settings for the org admin (the org's
  Router Settings page is theirs as of 2026-09-21).
- The bridge refetches on a 30s cache miss and on a `routing` change event
  from the run-stream broker, so a change lands on the next turn.

The strategy lives on the server. The bridge executes it.

## 5. Gateway lane

A plain forward, as the memory bridge does for loops today, with two changes:
the bearer is swapped for the member's gateway credential, and the model is
rewritten to the row's `target` when one is set. SSE passes through
unbuffered. Usage, stop reasons and errors are Anthropic's own as relayed by
LiteLLM. Budgets, the allow-list, the pool wall and per-org prompt caching all
apply on the server, unchanged.

## 6. Account lane

A headless `claude` session on the company's Anthropic login. This is Claude
Code's documented non-interactive mode, driven the way the app already drives
it: `composeHeadless()` in `cli-agents.ts` for the command, the stream-json
control channel in `glyphh-cli-bridge.ts` for permissions. The bridge never
touches the login; the binary carries it.

### 6.1 Conversation ↔ session

Claude Desktop sends the full transcript every turn. The bridge keeps a table
`conversation → { sessionId, parked?: Ask, updatedAt }`.

- **Identity.** A conversation is identified by the hash of its first user
  message plus the first assistant reply once one exists. A transcript whose
  prefix matches a known conversation continues it (`--resume <sessionId>`,
  last user message as the prompt). A transcript with no match starts a new
  session and stores the pair.
- **Edits and regenerations.** A transcript whose prefix matches but whose tail
  differs from what the session last saw forks: new session, seeded with the
  transcript as the prompt. Cheap, correct, rare.
- **Expiry.** A conversation idle for 24h is dropped from the table; the next
  message starts fresh.

### 6.2 Permission mode and working folder

From the routing row: `permission` maps to the CLI's `--permission-mode` through
the existing `PERM_FLAG`, default `read-only`. The working folder is the
Bridge Mode folder chosen in the TUI, default `~/.glyphh/bridge`. `chatOnly`
rows run with tools off entirely.

### 6.3 Stream-json → Messages SSE

The new adapter, and the core of the build. One turn:

| CLI event | Messages SSE |
| --- | --- |
| session start / first assistant delta | `message_start` (id, model as requested, empty usage) |
| assistant text delta | `content_block_start` (text, once) then `content_block_delta` |
| tool_use / tool_result | **not emitted** to Claude Desktop; shown in the TUI transcript |
| `control_request can_use_tool` (or any human step) | the ask protocol, §7 |
| `result` | `content_block_stop`, `message_delta` with `stop_reason: end_turn` and usage from the result's token counts, `message_stop` |
| error | `message_delta` with `stop_reason: end_turn` and the error as the last text block; never a hung stream |

Usage on the account lane is the CLI's own count of input and output tokens
for the turn, so Claude Desktop's meter reads true.

### 6.4 Usage event

Anthropic bills the account lane; the gateway sees nothing unless told. After
every account-lane turn the bridge posts:

```
POST /api/gateway/usage/bridge
{ conversation, model, lane: "account", inputTokens, outputTokens,
  cacheReadTokens, cacheWriteTokens, durationMs, at }
```

The server writes it as a spend-log row with zero cost and `lane=account` in
metadata, so Usage and the daily report show both lanes side by side, and the
org can see what the seat carried against what the gateway metered.

## 7. Asks: the turn ends on the question

The only path we build for anything that needs the user: a permission request,
an expired CLI login, a device-code sign-in, a URL to open, a choice.

1. **End the turn as text.** The bridge stops streaming, emits the ask as
   assistant text, and closes the turn with `stop_reason: end_turn`. The CLI
   session stays parked with the pending control request.
2. **The next message is the answer.** The bridge recognises the conversation
   by the parked ask in the last assistant message of the transcript. It reads
   the reply as **allow**, **deny**, or **always** (allow for the rest of the
   session), sends the `control_response`, and streams the rest of the original
   turn as the new reply.
3. **A reply that is not an answer** is a deny plus a fresh prompt: the CLI
   declines the tool, finishes what it can, and the new instruction runs as the
   next turn. Nothing gets stuck.
4. **One pending ask per conversation.** A second request while one is parked
   is answered with the same ask text, not a second parked session.
5. **Park timeout.** 15 minutes. After it the session is dropped and the next
   message is answered with one line saying so before it runs fresh.

Wording, fixed and unambiguous, so a plain reply parses:

```
Claude Code wants to run `<tool>`: <one-line summary>.
Reply **allow**, **deny**, or **always** (allow for the rest of this conversation).
```

Human steps that are not permissions end the turn the same way with the
instruction as text (the URL, the code, the choices), and the next message
resumes.

## 8. Claude Desktop's own tools

Claude Desktop's connectors and artifacts expect `tool_use` blocks back. On the
gateway lane they work: the model's tool calls are relayed as-is. On the
account lane the CLI runs its own tools and the bridge relays text, so those
connectors do not fire for that turn. The routing table is where the org admin
decides which names carry that trade, and the console says so beside the lane
picker.

## 9. The TUI in Bridge Mode

- A **Bridge** flag on the TUI (`glyphh --bridge`, and the desktop's Bridge Mode
  launch), which opens only the terminal panel with the TUI.
- The TUI shows: the bridge URL to paste into Claude Desktop, the signed-in
  member and org, the active lane per model from the routing table, and a live
  transcript of account-lane turns with their tool activity and asks.
- Sign-out in the TUI stops the listener and revokes the bridge's own tokens;
  Claude Desktop is asked to sign in again on its next turn.

## 10. What exists, what is new

**Exists:** the loopback proxy with unbuffered SSE forward and memory
inject/capture; the `claude` stream-json driver with the `can_use_tool`
control channel and `PERM_FLAG`; `composeHeadless()`; the member's gateway
credential; the server's OIDC issuer as the upstream sign-in; org settings
storage and the org admin's Router Settings page; the run-stream broker.

**New:** the local issuer (§2); fixed port and `/v1/*` routes (§3); the routing
table on the server and its console editor (§4); the conversation ↔ session
table (§6.1); the stream-json → Messages SSE adapter (§6.3); the usage event
and its spend-log row (§6.4); the ask protocol (§7); the Bridge flag and TUI
surface (§9).

## 11. Order of work

1. Local issuer + fixed port + `/v1/messages` on the gateway lane only. Claude
   Desktop signed in through Glyphh, every turn metered. This alone is the
   "sign in, no key" story with the bridge in the middle.
2. Routing table on the server and in the console.
3. Account lane: session table, SSE adapter, usage event, permission from the
   row, tools shown in the TUI.
4. The ask protocol.
5. Bridge flag and the TUI surface; the Connect dialog card follows the bridge.

## 12. Open questions

- Loopback http acceptance and settings reload in Claude Desktop (§2).
- Whether Claude Desktop calls `/v1/models`; if not, the picker stays
  Anthropic's names and other models are reached only through rows.
- Whether the account lane should honour Claude Desktop's system prompt as the
  CLI's `--append-system-prompt`, or ignore it. Default: append it.
- Codex as a second account lane is the same adapter with a different
  stream; not in this scope.

## 13. As built (2026-09-21)

Where the build departed from the plan above, and why.

- **Nothing on disk.** The desktop's zero-local-storage law applies to the
  bridge too. The issuer's keypair, Claude Desktop's codes and tokens, the
  registered clients and the conversation ↔ session table all live in
  process memory (`src/main/bridge/*`). A restart of the app means one
  browser hop for Claude Desktop (the member is still signed in to Glyphh) and
  a fresh CLI session seeded from the transcript. No persisted port: the
  listener is fixed at `127.0.0.1:4747` (`GLYPHH_BRIDGE_PORT` overrides).
- **The issuer's identity is the app's session.** `/oauth/authorize` does not
  redirect into a web sign-in. It renders a consent page naming the client and
  the signed-in member and issues the code on Allow; with nobody signed in it
  says to sign in to the Glyphh app first. Glyphh first, then the bridge.
- **Its own listener.** The bridge is a second loopback server beside the
  memory bridge, not new routes on it; the gateway lane forwards *through* the
  memory bridge's wrap so inject and capture apply. `/health` answers with CORS
  so the console's Connect dialog can find a running bridge and point Claude
  Desktop at it.
- **When it runs.** After sign-in, when the org forces it (plan gate
  `forceBridge`), when the member turned it on (server-side preference
  `bridgeModeEnabled`), or when the app was launched with `--bridge`. It stops
  on sign-out and revokes every token it minted.
- **Force Bridge Mode** (Organization settings, org admin): the desktop shows
  the bridge TUI over everything after sign-in, both switches on Settings →
  Bridge are on and locked, and the app runs in the background: closing the
  window hides it behind a tray; Quit is a real quit.
- **Routing changes** reach the bridge on a thirty-second cache, and at once
  when the org's gates move (the desktop's existing org poll). There is no
  broker channel; none was needed.
- **The account lane's env** sources the loop's env file and strips the
  gateway lines whatever the org's lane says (`accountLanePrefix`), so the
  turn runs on the CLI's own login with the memory bridge still in its path.
  `chatOnly` rows disallow the CLI's tools; `read-only` maps to plan mode.
- **The usage event** lands as a zero-cost `LiteLLM_SpendLogs` row on the
  member's own gateway key with `metadata.lane = "account"`.
- **The TUI** takes `--bridge` and names the bridge URL in its banner; the
  desktop opens it in a terminal overlay with `GLYPHH_BRIDGE_URL` set.
- **Still to check on a real machine:** Claude Desktop accepting a plain-http
  loopback issuer and gateway URL, whether it re-reads the setting without a
  restart, and whether it calls `/v1/models`. The HTTP-level test of the
  listener (`test/main/bridge/server.test.ts`) runs a scripted `claude`
  against the real server and cannot run in a sandbox that forbids loopback
  sockets; it runs in CI and on a developer machine.

## 14. Over the relay (2026-09-21, later the same day)

Claude Desktop refuses a plain-http loopback for its gateway and issuer, so
the front door moved to the server and the engine stayed on the machine
(RELAY-RESEARCH.md §5):

- **Issuer:** the server's own OpenID provider. **Gateway URL:** the server's
  `/bridge`. The Connect dialog's Claude Desktop card names both.
- **`POST /bridge/v1/messages`** (server, `glyphh_auth/attach.py`) resolves the
  member from the access token, gates on the plan, decides the lane from the
  org's routing table. Gateway lane: LiteLLM on the member's key, streamed
  through. Account lane: `bridge.turn` down the member's attach socket; the
  desktop's account-lane engine (`bridge/account-lane.ts`, shared with the
  local listener) runs the headless claude and pushes Messages SSE frames back
  on `run:<id>`; no desktop attached is a clear 412.
- **The attach plane** is back on the fork: `/ws/attach`, status, dispatch,
  `run` as SSE, presence in Redis with fly-replay placement, and the console's
  Connected Devices page. The desktop attaches on sign-in and runs `agent.run`
  on the CLI bridge for the web and the phone.
- **The local listener** (`127.0.0.1:4747`) stays as a development convenience
  and for clients that accept http; it is no longer what Claude Desktop is
  pointed at.
