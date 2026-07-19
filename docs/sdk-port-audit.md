# glyphh-apps → @glyphh/client SDK port — server-call audit

> **Status 2026-07-19:** Foundation + bucket A landed. `@glyphh/client` wired in
> (file:../sdk), auth.ts ported to the SDK (device-flow sign-in only; password
> auth deleted), `server*Authed` reimplemented as shims over the new `client.http`
> escape hatch — every remaining legacy call already routes through the SDK
> transport. Typed-client swaps done for: connections/connectors/MCP (personal
> axis), marketplace→apps, drips/layouts/chats→library kinds, usage/billing/
> profile/guardrails/support, models.available. Remaining endpoint-string call
> sites (~29) are exactly the panel-apps/proxies/schedules/preferences set that
> needs new server+SDK surface (task 3) plus william-models/gateway (task 4).
> Renderer follow-up: the Connections page still speaks the one-list model —
> port to Personal + Shared tabs like the platform.

Date: 2026-07-19. Scope: every network call from the desktop app to the control
plane. Goal: all of them go through `@glyphh/client` (the SDK in `../sdk`).

## Current transport (all to be deleted)

All server traffic lives in `src/main/` — the renderer never calls the server
directly (it goes through IPC/preload). The transport is hand-rolled in
[auth.ts](../src/main/auth.ts) on Electron `net` (proxy-aware, 10s timeout,
401→refresh):

- `serverPost` (unauthed: login/refresh/device-exchange)
- `serverGetAuthed` / `serverPostAuthed` / `serverPatchAuthed` /
  `serverPutAuthed` / `serverDeleteAuthed` — **103 call sites across 20 files**
- one raw `fetch` to the gateway in [model-router.ts:643](../src/main/model-router.ts)
- MCP client to `https://api.glyphh.ai/mcp` in [glyphh-skill-export.ts](../src/main/glyphh-skill-export.ts)
- [server-cache.ts](../src/main/server-cache.ts) — 20s TTL memo over `serverGetAuthed`

Note: the SDK is fetch-based; Electron-main fetch does not use the OS proxy the
way `net.request` does. If proxy support must survive, pass an Electron-net
`fetch` shim via `ClientOptions.fetch`.

## Call-site inventory → SDK mapping

### A. Direct SDK equivalents (transport swap, same semantics)

| File | Old call | SDK |
|---|---|---|
| home-ipc.ts:56 | GET /api/billing/credits | `client.billing` credits |
| home-ipc.ts:63–64 | GET /api/usage, /api/usage/daily | `client.usage.summary()` / `.daily()` |
| home-ipc.ts:65, apps.ts | GET /api/panel-apps | `client.apps.deployed()` |
| settings-ipc.ts:96/109 | GET/PATCH /api/user/me | `client.profile.get()` / `.update()` |
| settings-ipc.ts:129 | PATCH /api/org/guardrails | `client.org` guardrails |
| main.ts:1793 | POST /api/support/ticket | `client.support` |
| connectors.ts:89 | GET /api/connectors/apps | `client.connections.catalog()` |
| connectors.ts:108/180/215 | connectors accounts/disconnect/connect | `client.connections.personalList()` / `.removePersonal()` / `.personalConnect()` |
| apps-ipc.ts:150–166 | /api/connections CRUD + tools | `client.connections.list()` / `.tools()` etc. |
| connector-tools-client.ts | connector tool list/run | `client.connections.resolvedTools()` / `.runTool()` |
| ada/indexer.ts:85, william.ts:410, william-tools.ts:498 | GET /api/connections | `client.connections.list()` |
| apps-ipc.ts:183–212, main.ts:1191 | /api/mcp-connections CRUD/tools/install | `client.connections.orgMcp*` / `.personalMcp*` (renamed on new server) |
| marketplace.ts:200/244/373 | /api/marketplace/apps → browse/install/detail | `client.apps.list()` / `.get()` / `.install()` (new path /api/apps) |
| drip-manager.ts:558–605 | /api/drips CRUD | `client.drips` (LibraryClient → /api/library/drip) |
| layout-manager.ts:323–384 | /api/layouts CRUD | `client.layouts` (→ /api/library/layout) |
| william-context.ts:175–229 | /api/me/chats CRUD | `client.messageSessions` (→ /api/library/message_session) |
| model-router.ts:859 | GET /api/me/provider-keys | `client.providers` (BYOK is org-scoped now — see D) |
| apps-ipc.ts:177/203 | icon URL `${AUTH_SERVER}/api/mcp-icons/:sha` | keep (asset URL; server route exists); base URL from SDK config |

### B. Semantic migrations (endpoint gone; new model exists)

| Area | Old | New |
|---|---|---|
| **Auth** — auth.ts:466–531 | password register/verify-code/complete-profile/login/forgot-password, /api/auth/device-exchange, /api/session/refresh | `client.auth`: magic-link (`start`/`verifyEmailLink`), `google`/`apple`, device flow (`deviceLogin`/`approveDevice`), `exchange`; refresh is automatic via `RefreshManager` + `TokenStore`. Password auth does not exist on the new server. Login UI must be reworked (platform port already did this — reuse that flow). |
| **Heartbeat** — auth.ts:571 /api/heartbeat + cachedAccount /api/user/me | gone | `client.me()` + `client.billing.status()` + SDK auto-refresh/`onSignedOut` |
| **Panel-app writes** — apps-ipc.ts (25 sites), glyphh-app-host.ts:257/260, app-secrets.ts:79, connectors.ts:154 | POST/PATCH/DELETE /api/panel-apps + /:id/connection(s), /mcp, /commands | New server has **GET /api/panel-apps only**. Apps are now marketplace listings + installs (`client.apps.publish/install/uninstall/releases`). Per-app connection/command/mcp state must move to install metadata or library — needs a server design decision. |
| **William/local models** — william-models.ts:125/200 /api/william/models | gone | model governance: `client.models.available()` (effective set) + `client.rotorConfig` registry (local vs gateway transport) |
| **Gateway chat** — model-router.ts:643 fetch /api/gateway/v1/messages | keep endpoint | route through SDK: `client.token` for the bearer + `runtime/models` resolved binding (gateway url + auth), instead of hand-building headers |
| **MCP access policy** — home-ipc.ts:130 /api/mcp-connections/policy | gone | governance moved to workspace grants: `client.workspaces` effective grants / membership `EffectiveContext` |
| **me/credits** — home-ipc.ts:57 | gone | `client.usage.allocation()` (/api/me/allocation) |
| **Skill export MCP** — glyphh-skill-export.ts:14 hardcoded https://api.glyphh.ai/mcp | keep MCP, but | base URL from SDK config + bearer from `client.token` |

### C. No server counterpart — decide: add endpoint or keep local

| Area | Old | Note |
|---|---|---|
| App schedules — glyphh-app-services.ts:285–337 | /api/me/app-schedules CRUD | gone on new server; either a new `LibraryKind` / server domain, or keep in local drip/cron store |
| User preferences — stores/preferences-db.ts:118 | PUT /api/me/preferences | gone; nearest is PATCH /api/user/me (profile) — needs a prefs field server-side (memory: "user-scoped server config" wants this server-side) |
| User-scoped BYOK — settings-ipc.ts:19 | PUT /api/me/provider-keys/anthropic | new model is **org**-scoped BYOK (`client.providers`); either drop user-scoped BYOK or add it to server+SDK |
| App proxies — apps-ipc.ts:220–228 | /api/apps/:id/proxy, /api/apps/proxies | not on new server; likely superseded by hosting (`client.hosting`) — confirm then delete |

### D. Out of scope (not control-plane calls)

- william.ts / william-context.ts `baseUrl()` → local llama server (localhost) — stays raw fetch
- web-capability.ts — arbitrary web fetch tool
- PLATFORM_URL links (preload.ts:509–514, model-router.ts:704) — browser deep links, not API calls; source the URL from one config module

## Foundation work

1. Add `@glyphh/client` dep (file: link like platform) — remember to **build the SDK** after edits (dist symlink gotcha).
2. One `client.ts` module in main/: `createClient()` singleton with a file-backed `TokenStore` (port of current token persistence in auth.ts), `onSignedOut` → login gate IPC, optional Electron-net fetch shim for proxy support.
3. Port auth.ts to `client.auth` + delete `serverPost*`/`server*Authed` and `AUTH_SERVER` once the last caller is migrated (no dead code in cutovers).
4. server-cache.ts wraps SDK calls instead (generic memo over a thunk, not an endpoint string).
5. Renderer/preload: `serverUrl` exposure stays only for asset URLs; everything else via IPC as today.

## Suggested phasing

1. Foundation (client singleton + token store + auth flows) — unblocks everything.
2. Mechanical swaps (section A), file by file, deleting helpers as callers drain.
3. Semantic ports (section B) — panel-apps model is the big one.
4. Decisions in section C (server/SDK additions), then their ports.
5. Delete auth.ts transport + AUTH_SERVER; `grep -r "server.*Authed\|AUTH_SERVER"` must return nothing.
