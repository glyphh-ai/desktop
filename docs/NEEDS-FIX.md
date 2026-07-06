# Needs-Fix Backlog

Known follow-ups that aren't blocking ship. Trim as items land.

## Remote control mode (yo agent panel)

The mode dropdown next to the perm dropdown is currently single-entry
("standard") because `.council` and `.code` were removed. Keep it — the
second slot is reserved for **remote** mode:

- `standard` — local input. User types in the side panel, yoAgent runs.
- `remote` — platform-driven input. The user starts a self-jammer cypher;
  the platform (dotyo.dev) posts events to it via voice transcript or web
  UI; the local cypher-runtime picks them up and dispatches to yoAgent;
  responses stream back to the platform via the same event channel.

What needs to land before this can ship:
- Replace cypher-runtime's 3-second poll loop with SSE/WebSocket — voice
  control with up to 3s of dead air per command is unusable.
- Permission UX in remote mode is more sensitive than local. The
  SDK-aligned `canUseTool` callback (see below) needs to either auto-deny
  destructive ops in remote mode, or surface approval prompts through the
  platform UI rather than the local desktop client.
- Platform side: voice-input UI + transport for posting events to the
  user's self-jammer cypher.
- Auth: the platform must only be able to post to the user's own remote
  session, not arbitrary cyphers. Re-use existing yo-server bearer auth.

## Cypher event stream — ~~replace polling with SSE~~ ✅ Phase 3.5 slice 1

`cypher-runtime.ts` polled `/api/cyphers/{id}/events` every 3s. Replaced
with SSE consumer against `GET /api/cyphers/:id/events/stream`. Sub-second
push, server-driven keepalives, auto-reconnect with `?since=<lastSeq>` +
`Last-Event-ID` for replay. The polled endpoint stays for compatibility.

## Cypher invite security — JWT-signed invite tokens

Today: invite-only cyphers are gated by visibility checks at the service
layer. `getCypher(id, viewer)` returns the cypher only if the viewer is
the owner OR is already in `cypher_jammers`. That's correct for
post-join protection but doesn't define **how someone gets into the
jammer list in the first place** for an invite-only cypher. The
`joinCypher` flow currently doesn't enforce an explicit invite check —
any authed user could potentially POST a join for an invite cypher
(needs verification — may already be locked down via visibility on the
read path).

Intended model: owner generates a signed invite JWT via
`POST /api/cyphers/:id/invites` with `{ invitee_user_id?, expires_at,
jti, role }` claims, signed with the cypher's secret (or a server-wide
HMAC key). Owner shares the link. Invitee redeems via
`POST /api/cyphers/:id/join { invite_token }` — server verifies signature,
checks `jti` not already used, checks `expires_at`, then adds them as a
jammer. Single-use by default; "multi-use" (e.g. team-wide invite link)
is a flag the owner can set.

This wants its own slice: schema (`cypher_invites` table for jti + revoke
list), routes (mint / list / revoke / redeem), client UI (owner copies
invite link from the cypher detail view; joiner pastes or follows link
and confirms join). Slot in after the SSE bus + cypher-workspace UI
rebuild.

## Cypher-workspace rename pass

The local multi-agent execution layer is currently called "code-workspace"
in the codebase (panel id, baseAppId branch, `type: "code"` on layouts,
preference keys like `codeWorkspaceLayout` / `codeWorkspaceCypher`). That
naming is from the `.code` command era. Rename to `cypher-workspace`
across the surface, with a one-time read-time migration shim for existing
persisted state:
- `~/.glyphh/workspaces/<slug>/layouts.json` entries with `type: "code"` →
  `type: "cypher"`
- preferences `codeWorkspaceLayout` → `cypherWorkspaceLayout`,
  `codeWorkspaceCypher` → `cypherWorkspaceCypher`
- panel id `"code-workspace"` → `"cypher-workspace"` (renderer asset
  paths follow)
- HTML files, build script entries in `package.json`

## SDK permissionMode wiring (in this PR's scope)

Tracked here for context: `yo-agent.ts` previously hardcoded
`permissionMode: "bypassPermissions"` and ran the SDK wide open while our
`action-gate.ts` did parallel UI gating. This PR aligns the perm enum to
SDK terms and pipes `this._mode` through to the SDK. Once the renderer
approval flow is fully wired into `canUseTool`, the parallel
`action-gate` + `approvalCallback` path can be retired.
