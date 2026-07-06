# GH-Pivot session notes — 2026-05-08 → 2026-05-09

Branch: `gh-pivot` on both yo-client and yo-server.
Goal (5/8): scaffold THE-PIVOT-GITHUB end-to-end skeletons in one night.
Goal (5/9): make the server side actually run end-to-end.

This doc is the rolling regroup brief. Read it before opening the diffs.

---

## Status by phase (server)

| Phase | Title | Server | Notes |
|---|---|---|---|
|  9 | GH App config scaffold | ✅ env-driven | needs registration |
| 10 | /start + /callback + /exchange | ✅ live | requires GH_APP_* env |
| 11 | Projects schema + CRUD | ✅ live | gh_project_id null until GraphQL writer |
| 11 | Installations + repos proxy | ✅ live | `has_ci` always false (polish) |
| 12 | Heartbeat + assignments stream | ⬜ stubbed | matchmaker still TBD |
| 13 | Daemon helpers (TUI/Drop) | ⬜ | client-side, see THE-PIVOT-GITHUB |
| 14 | SSE board stream + webhook ingest | ✅ live | pg LISTEN/NOTIFY + HMAC |
| 15 | FTS-ranked discover | ✅ live | tsv index on projects |
| 16 | Reputation + per-seat Stripe | ⬜ | |

---

## What landed

### yo-server `gh-pivot` branch

- **Migration `035_users_github_identity.sql`**
  - `users.gh_user_id BIGINT` (unique partial index)
  - `users.gh_login TEXT` (lowered index for joins)
  - `users.gh_avatar TEXT`
  - `github_oauth_states` table (state → flow / return_to / bind_user_id /
    expires_at / consumed_at)

- **`src/services/gh-app-service.ts`**
  - Single source of truth for GH App config (App ID, PEM, webhook secret,
    OAuth client_id/secret/callback). Loaded from env, Heroku-safe `\n`
    handling on the PEM.
  - `getGhAppConfig() / isConfigured() / buildAuthorizeUrl(state, scopes)`

- **`src/routes/github-auth-routes.ts`**
  - `GET  /api/auth/github/start`     — **live** (mints state, returns URL)
  - `GET  /api/auth/github/callback`  — **live** (placeholder + postMessage
                                        for web flow; Electron intercepts)
  - `POST /api/auth/github/exchange`  — **501** + `EXCHANGE_RESPONSE_CONTRACT`

- **`src/routes/project-routes.ts`** (all 501 with response contracts)
  - `POST /api/projects`
  - `GET  /api/projects/mine`
  - `GET  /api/projects/discover`
  - `GET  /api/projects/:ref`
  - `GET  /api/projects/:ref/board`
  - `GET  /api/projects/:ref/events/stream`  (SSE — connects + emits `not-implemented` event)
  - `POST /api/projects/:ref/start`
  - `POST /api/projects/:ref/wrap`

- **`src/routes/installation-routes.ts`** (all 501)
  - `GET  /api/me/installations`
  - `GET  /api/me/installations/:owner/repos`
  - `POST /api/me/heartbeat`
  - `GET  /api/me/assignments/stream`  (SSE)

All registered in `server.ts`. TypeScript clean.

### yo-client `gh-pivot` branch

- **`src/main/drop-auth.ts`** (new)
  - `~/.glyphh/.session.drop` storage (encrypted via `safeStorage`)
  - `signInWithGitHub()` — hits `/api/auth/github/start`, opens child
    `BrowserWindow` on the partition `persist:drop-session`, intercepts the
    callback redirect (will-redirect/did-navigate), POSTs `{code,state}` to
    `/api/auth/github/exchange`, persists session, schedules refresh.
  - `getDropAuthStatus() / getDropAccessToken() / signOutDrop() / initDropAuth()`
  - Refresh stub points at `/api/auth/refresh` (existing yo path); will need
    a parallel GH-bound endpoint if we don't reuse.

- **`src/main/drop-api.ts`** (new)
  - `dropFetch<T>` wrapper that pulls Bearer from the Drop session.
  - Exports `dropApi` with: `projectsMine`, `projectDiscover`, `projectGet`,
    `projectBoard`, `projectCreate`, `projectStart`, `projectWrap`,
    `installationsList`, `reposForInstallation`, `heartbeat`.

- **`src/main/main.ts`**
  - Imports `initDropAuth`, `signInWithGitHub`, `signOutDrop`, `getDropAuthStatus`, `dropApi`.
  - Calls `initDropAuth()` next to `initAuth()` at boot.
  - New IPC handlers (block before `mcp-expose-get-tokens`):
    `drop-gh-status`, `drop-gh-sign-in`, `drop-gh-sign-out`, `projects-mine`,
    `projects-discover`, `project-get`, `project-board`, `project-create`,
    `project-start`, `project-wrap`, `installations-list`, `repos-for-installation`.
  - `dev-flags` IPC also returns `enableGhAuth: process.env.YO_ENABLE_GH_AUTH === "1"`.

- **`src/renderer/drop-preload.ts`**
  - Extended `DropAPI` with `ghStatus`, `signInWithGitHub`, `signOutGitHub`,
    `projectsMine`, `projectDiscover`, `projectGet`, `projectBoard`,
    `projectCreate`, `projectStart`, `projectWrap`, `installationsList`,
    `reposForInstallation`. All routed through `ipcRenderer.invoke`.

- **`src/renderer/drop-gh-landing.ts`** (new)
  - `maybeRenderGhLanding(host)` — if `enableGhAuth && !signedIn`, takes
    over the panel with a "Continue with GitHub" card. On success fires
    `drop-gh-signed-in` `CustomEvent`.
  - Surfaces 501-stub errors clearly in the UI.

- **`src/renderer/drop-pickers.ts`** (new)
  - `OwnerOption` / `RepoOption` types.
  - `loadOwners() / loadRepos(ownerLogin)` — try IPC first, fall back to
    fixtures (`FIXTURE_OWNERS`, `FIXTURE_REPOS`) if 501/error.
  - `renderOwnerPicker(host, opts)` and `renderRepoPicker(host, opts)`.

- **`src/renderer/drop.ts`**
  - Inlined boot hook in `init()` that dynamically imports
    `./drop-gh-landing.js`, calls `maybeRenderGhLanding`, hides the rest of
    the Drop UI behind it when shown.

- **`src/renderer/drop.html`**
  - New CSS block at end of `<style>` for `.yo-gh-landing`,
    `.yo-gh-landing-card`, `.yo-gh-landing-btn`, `.yo-owner-picker`,
    `.yo-repo-picker`, etc.

- **`src/main/cypher-bus.ts`**
  - Header docblock now lists explicit Phase 5+6 migration mappings
    (postCypherEvent → `/api/projects/:ref/events/stream`,
    subscribeCypherAgent → `/api/me/assignments/stream`,
    `getCypherForWorkspace` → drop session's bound `project_id`,
    `dispatchInbound` → daemon in `agent-runner.ts` consuming the new SSE).

- **`tsconfig.json` + `src/renderer/tsconfig.json`**
  - New renderer files (`drop-gh-landing.ts`, `drop-pickers.ts`) added to
    renderer include and main exclude.

- **`docs/THE-PIVOT-GITHUB.md`**
  - Status table: Phases 1, 2, 3, 5, 6 flipped to 🟡 scaffold/IPC wired/
    pickers scaffolded/migration TODOs annotated.

Both branches: TypeScript clean. `npm run build` clean. Ready to push.

---

## 2026-05-09 server build — what landed

Three focused commits on `yo-server/gh-pivot` past the prior scaffold:

- **`6022b98`** — `/api/auth/github/exchange` real impl (Phase 10)
  Token swap → `/user` + `/user/emails` → `upsertGhUser` (4-case ladder:
  existing-link / bind / email-match / net-new) → mark state consumed →
  mint yo session JWT enriched with GH identity. Native fetch (no deps).
  user-service.ts grew `findByGhUserId` + `upsertGhUser`. UserRow type
  has gh_user_id / gh_login / gh_avatar.

- **`171663b`** — Projects API + SSE backbone (Phases 11 + 14 + 15)
  Migration 036 adds `projects`, `project_linked_repos`, `project_items`,
  `project_assignees`, `project_events` tables (FTS tsv on projects).
  `services/project-service.ts` (CRUD, slug gen, listMine, FTS discover,
  status transitions, append/list events). `routes/project-routes.ts`
  goes live for POST/GET/start/wrap and the SSE stream uses pg
  LISTEN/NOTIFY (channel `project:<id>`) for fan-out from the event log.

- **`df31e7c`** — Installations + webhook ingest (Phases 11 + 14)
  Migration 037 adds `github_user_tokens` (AES-256-GCM, key derived via
  HKDF from JWT_SECRET). `services/gh-token-service.ts` — store/refresh
  user-OAuth tokens. `/exchange` now persists tokens after step 4.
  `routes/installation-routes.ts` lights up GET /api/me/installations
  and /api/me/installations/:owner/repos as live proxies.
  `routes/github-webhook-routes.ts` (NEW): HMAC verification on
  X-Hub-Signature-256, routes pull_request / issues / issue_comment to
  project_events. server.ts mounts express.raw before json for /webhook.

End state: every HTTP entry point the Drop client calls is **live** as
soon as `GH_APP_*` env is set + the App is registered. The matchmaker
(Phase 12) is the only remaining server prereq for end-to-end work
distribution.

---

## What is still 501 / TODO before live

Now that the server side runs:

1. **Register the yo-cypher GitHub App** (manual GH UI).
   - Set env on the server: `GH_APP_ID`, `GH_APP_PRIVATE_KEY` (PEM),
     `GH_APP_WEBHOOK_SECRET`, `GH_OAUTH_CLIENT_ID`, `GH_OAUTH_CLIENT_SECRET`,
     `GH_OAUTH_CALLBACK_URL` (must point to a public yo-server URL).
   - Configure webhook URL → `${YO_SERVER}/api/github/webhook`, subscribe
     to: `pull_request`, `issues`, `issue_comment`, `installation`,
     `installation_repositories`.
   - Run pending migrations on the target database (035, 036, 037).

2. **GraphQL writer to actually create the GitHub Project v2 on github.com**
   (Phase 11 polish). Right now `gh_project_id` / `gh_project_number` /
   `gh_project_url` stay null after `POST /api/projects` — the row in
   our DB is correct but no Project on github.com exists. Need:
   - Mint installation token via `POST /app/installations/:id/access_tokens`
     (signed JWT from the App's private key)
   - GraphQL `createProjectV2` mutation against the owner
   - Set custom fields (Status, Mode, Capability, Slots, Winners, ReviewMode)
   - PATCH our `projects` row with the resulting `id`/`number`/`url`

3. **Matchmaker (Phase 12).**
   `/api/me/heartbeat` records jammer presence + capability stack.
   `/api/me/assignments/stream` SSE delivers items. Needs:
   - `jammer_presence` table (user_id, loadout_id, capabilities, last_seen)
   - Rule: when an item is opened on a project's repo, find the closest
     capability match among presence rows that are joinable, post an
     assignment row, NOTIFY a per-user channel that the SSE handler
     subscribes to.

4. **Reputation + per-seat Stripe (Phase 16)** — covers `/api/users/:id/
   reputation` and `/api/leaderboard`. Reads merged-PR count + tournament
   wins. Per-seat billing is a re-shape of existing org billing.

5. **Jammer daemon hook in `agent-runner.ts`** (client Phase 6).
   Subscribe to `/api/me/assignments/stream` whenever `.session.drop`
   exists AND at least one local agent loadout has `joinable: true`. The
   IPC and `dropApi.heartbeat()` exist; the daemon code does not.

6. **Drop-a-Cypher wizard rewrite** (client Phase 3).
   The pickers live in `drop-pickers.ts` but the existing wizard in
   `drop.ts` (3000+ LOC) still uses the old steps. Rewrite once Phase 1
   sign-in is real.

---

## How to test what's already on `gh-pivot`

### Server

```sh
cd yo-server
git checkout gh-pivot
npm run build
PORT=3001 npm start
# In another shell:
curl http://localhost:3001/api/auth/github/start
# Returns 501 with detail "GitHub App not configured" (expected — no env).
# Set GH_APP_* vars and re-run; /start should mint a state and return URL.
curl -X POST -H "Authorization: Bearer <yo session JWT>" http://localhost:3001/api/projects
# Returns 501 with response contract.
```

### Client

```sh
cd yo-client
git checkout gh-pivot
YO_ENABLE_GH_AUTH=1 npm run dev
# Open The Drop panel: landing card should appear.
# Click "Continue with GitHub" → opens child window → server returns 501
# until env vars are set; UI surfaces the 501 message in the error slot.
```

To test pickers in isolation:

```js
// In Drop's DevTools console:
const { loadOwners, loadRepos } = await import("./drop-pickers.js");
console.log(await loadOwners());                // FIXTURE_OWNERS
console.log(await loadRepos("acme"));           // FIXTURE_REPOS["acme"]
```

To test cypher-bus migration audit: `grep "PIVOT-GITHUB MIGRATION" src/main/cypher-bus.ts` — the header docblock now spells out the deletion plan.

---

## What I'd do next session

1. **Register the GH App on github.com** + set the 6 `GH_*` env vars on
   yo-server. Run migrations 035 + 036 + 037 against the target DB.
2. **Smoke the live exchange** end-to-end: `YO_ENABLE_GH_AUTH=1` in the
   client, click "Continue with GitHub" → completes → `~/.glyphh/.session.drop`
   on disk → `dropApi.projectsMine()` returns 200 (empty).
3. **GraphQL Project v2 writer** — currently the highest-leverage TODO.
   Once it lands, `POST /api/projects` populates `gh_project_url` and the
   Drop UI can deep-link out.
4. **Rewire Browse / Your Cyphers** in `drop.ts` to call
   `dropApi.projectDiscover()` / `projectsMine()` instead of the cypher
   IPC. Mostly a data-source swap.
5. **Drop-a-Cypher wizard rewrite** using `drop-pickers.ts`.
6. **Matchmaker stub + heartbeat + assignments stream** so a single end-to-end
   demo from "Drop a Cypher" → assignment lands locally → daemon clones repo
   → Claude opens PR works on one machine.
