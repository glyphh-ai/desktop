# THE-PIVOT-GITHUB — The Drop (panel app inside yo-client) on GitHub Projects

> **Scope:** this pivot lives **entirely inside the `yo://drop` panel app**
> within yo-client. The main Electron window's auth, primary surface, and
> the other panel apps (`yo://home`, `yo://terminal`, `yo://council`,
> `yo://browser`, `yo://monaco`, `yo://context`) are **untouched**. The
> Drop becomes a **GitHub-authenticated, GitHub-Projects-backed cypher
> surface**; everything else in yo-client stays as it is today.
>
> Modeled after how the council app is built: a self-contained panel
> registered through `panelManager.addPanel("yo://drop", dropHtml,
> dropPreload)`, with its own preload boundary, its own renderer module,
> and now its own scoped auth context.
>
> **Working procedure:** as each phase task is completed, flip its
> checkbox here in the same commit. This doc is the persistent task
> tracker — if a session drops, the next session resumes from the first
> unchecked box.
>
> **Companion docs:**
> - [`/yo/THE-PIVOT-GITHUB.md`](../../yo/THE-PIVOT-GITHUB.md) — TUI plan
>   and the canonical server-side phase list (9–16). Same server, same GH
>   App, same MCP contract.
> - `THE-DROP.md` (this repo) — the existing Drop UX baseline. Its
>   cypher-state mechanics (lobby/draft/workspace tied to yo-server's
>   `cyphers` table) are **superseded by this plan**; UI mechanics
>   (4-view layout, countdown timer, roster grid, activity feed) are
>   carried over verbatim.

---

## Build progress

| Phase | Title | Server prereq | Status |
|---|---|---|---|
| 1 | GH OAuth scoped to The Drop panel | server 9 + 10 ✅ | ✅ done (install prompt deferred to Phase 3) |
| 2 | The Drop's Browse + Your Cyphers read Projects | server 11 + 15 ✅ | 🟡 IPC + dropApi wired; Drop UI swap pending |
| 3 | Drop-a-Cypher wizard creates a real GitHub Project | server 11 ✅ | 🟡 pickers scaffolded; wizard rewrite pending |
| 4 | Lobby view = Project `Status = Lobby` | server 11 + 14 ✅ | ⬜ not started |
| 5 | Workspace view = Project board hydration | server 14 ✅ | 🟡 cypher-bus migration TODOs annotated |
| 6 | Jammer daemon: assignment → clone → Claude Code → PR | server 12 ⬜ + 13 ⬜ | 🟡 cypher-bus migration TODOs annotated |
| 7 | Reputation in The Drop UI (merged-PR count) | server 16 ⬜ | ⬜ not started |
| 8 | Org install flow + per-seat billing in Drop Preferences | server 16 ⬜ | ⬜ not started |

Legend: ⬜ not started · 🟡 in progress · ✅ done

The "server prereq" column points at phases in
[`/yo/THE-PIVOT-GITHUB.md`](../../yo/THE-PIVOT-GITHUB.md), which
inherits its 9-onward numbering from `/yo/THE-PLAN.md` (shipped
phases 0–8 of the peer-to-peer model). The Drop's phases are
numbered 1–8 from this doc's own perspective; cross-references go
through the prereq column.

---

## What this pivot does NOT change

- **The Electron app's primary auth.** Users still sign into yo-client
  via `platform.dotyo.dev/auth?flow=electron` → BrowserWindow → device
  code → JWT (`auth.ts`). That session backs everything *outside* The
  Drop.
- **Other panel apps.** Home, Terminal, Council, Monaco, Browser,
  Context all keep their current data sources. No IPC channel rename
  outside of `drop-preload`.
- **The local jammer loadout model.** A jammer is still a named local
  bundle (skills + model + system prompt + apps + avatar) under
  `~/.yo/agents/<id>/`. Nothing about the local agent runtime changes
  except the *trigger* for picking up work (Phase 6).
- **Path-gate / sandbox / `~/.yo/`.** Trust boundary stays; per-item
  workspaces become subdirectories under `~/.yo/workspaces/<project-slug>/`.
- **The other yo-server features** users already rely on (capabilities
  profile, subscriptions, heartbeat). Those are signed by the yo
  session JWT and continue working unchanged.

## What this pivot DOES change (inside The Drop only)

- **A second scoped auth lives inside The Drop.** "Continue with GitHub"
  is required to use The Drop. yo-server returns a yo session JWT
  enriched with `gh_user_id` + `gh_login` + `gh_avatar`; The Drop
  persists this separately from the main yo session.
- **Cyphers are GitHub Projects (v2).** `cypherCreate` becomes
  `projectCreate` (server-side proxy through the yo-cypher GH App).
  All Drop reads/writes use Project IDs, not yo-server cypher IDs.
- **Spawn = item assignment.** When a host (or the orchestrator via
  MCP) creates a Project item, yo-server's matchmaker assigns it. The
  jammer daemon picks up via the per-user assignments SSE stream.
- **Wrap = Project archive.** Open items close, the Project archives;
  the host doesn't merge in The Drop — they merge on github.com (we
  link out).
- **Reputation = merged-PR count + tournament wins.** Replaces the
  existing `agent_performance` write-back. The Drop reads from the new
  server endpoint; the legacy table goes read-only.

---

## Architecture (Drop-scoped)

Three pieces, only one of which is new code in yo-client:

```
                    ┌─────────────────────────────┐
                    │  yo-server (same instance)  │
                    │  + yo-cypher GitHub App     │
                    │  + matchmaker               │
                    └──────────────┬──────────────┘
                                   │
       ┌───────────────────────────┴────────────────────────────┐
       │                                                          │
┌──────▼────────┐                                       ┌─────────▼──────────┐
│  The Drop     │  yo-client main process               │  Jammer daemon     │
│  (panel app)  │  ────────────────────────────────►    │  (agent-runner.ts) │
│  drop.ts      │  IPC → drop-preload → yo-server REST  │  subscribes to     │
│  drop.html    │                                       │  /api/me/          │
│               │  GH OAuth happens IN THIS PANEL       │  assignments/      │
│               │  via a child BrowserWindow scoped     │  stream            │
│               │  to drop-session                      │                    │
└───────────────┘                                       └────────────────────┘
```

The Drop is a renderer + preload pair like council. Its sole expansion
is the GH OAuth flow: a child `BrowserWindow` opens `https://api.dotyo.dev/api/auth/github/start`,
the user authorizes on github.com, the redirect lands at the platform's
`/auth/callback?code=…`, The Drop's main-process owner intercepts the
code, exchanges it via yo-server, and persists the augmented session in
its own storage file (`~/.glyphh/.session.drop`).

**Why a separate session file?** Rotation independence and clean
revocation. A user can keep using yo-client while their GH binding is
stale — only Drop is gated on it. They can also sign out of GitHub
without nuking the main yo session.

---

## Concept mapping

| The Drop today | After the pivot |
|---|---|
| Main yo session backs all Drop reads/writes | Main yo session **plus** GH-bound session — both required to use The Drop |
| `cypherDiscover` IPC → `/api/cyphers/discover` | `projectDiscover` IPC → `/api/projects/discover` |
| `cyphersList` (Your Cyphers) | `projectsMine` |
| `cypherGet` (lobby/workspace hydration) | `projectGet({ ref, with: ['board','assignees','recent_events'] })` |
| `cypherCreate` + `cypherJoin (seed roster)` + `cypherPublish` | Single `projectCreate` (server creates Project + initial state) — no seed-roster step; matchmaker handles it |
| `cypherWrap` | `projectWrap` (archives Project + closes items) |
| `cypherEvents` polling (3s) | `/api/projects/:ref/events/stream` (SSE, webhook-backed) |
| `cypher_jammers` table → roster | Project assignees (real GH users) |
| `cypher_assignments` (draft) | Project items + their assignees |
| Wrap-time `agent_performance` write-back | Webhook-driven reputation (merged PRs / closed items) |
| 4-step "Drop a Cypher" wizard | New 4-step wizard: **Goal → Owner+Repo → Mode → Lobby** |
| Work-package step (git URL / blank) | Replaced by **linked-repo selection** in step 2 |
| Seed-roster step | Removed; matchmaker assigns automatically |
| yos balance widget in Drop header | **Removed** (already half-removed in `cypher-build`) |

---

## Phase plan (Drop-scoped)

### Phase 1 — GH OAuth scoped to The Drop panel (~2 days)

**Server prereq:** `/yo/THE-PIVOT-GITHUB.md` Phase 9 (App scaffolding) +
Phase 10 (OAuth callback that mints a yo session JWT enriched with GH
identity).

The Drop is the only place that needs the GH binding. Other panels stay
yo-only.

**Tasks:**

- [x] `drop.ts` boot: check for `~/.glyphh/.session.drop`. If missing or
      expired, render a centered "Continue with GitHub" landing card
      (same visual language as the rest of The Drop, locked to the
      single CTA + a "Why GitHub?" expandable explainer).
- [x] `drop-preload.ts`: expose `signInWithGitHub()` IPC. Main-process
      handler opens a child `BrowserWindow` to
      `${AUTH_SERVER}/api/auth/github/start?return=electron-drop`.
- [x] Main process: `drop-auth.ts` (new file alongside `auth.ts`).
      Watches the BrowserWindow for the redirect to
      `/auth/callback?code=…`, extracts the code, POSTs to
      `${AUTH_SERVER}/api/auth/github/exchange?flow=electron-drop`,
      receives `{ accessToken, refreshToken, expiresAt, gh_user_id,
      gh_login, gh_avatar }`, encrypts via `safeStorage`, writes to
      `~/.glyphh/.session.drop`. Schedules refresh.
- [x] Drop-only IPC client (`drop-api.ts`): wraps `net` requests with
      `Authorization: Bearer <drop-session-jwt>` instead of the main
      session. Imported only by `drop-preload`.
- [x] Render @login + GH avatar in the Drop's header (replacing today's
      yos balance slot). Click opens a small popover: "Signed into yo
      as `<email>` · GitHub `<@login>` · [Sign out of GitHub]".
- [x] Sign-out: clears `.session.drop`, returns to the landing card.
      Does **not** affect the main yo session.
- [ ] First-time users: after GH sign-in, prompt "Install the yo
      GitHub App on your account?" (same BrowserWindow flow). Without
      an installation, **hosting** is disabled but **joining** still
      works. Installation is one-time per account/org. *(deferred to Phase 3)*
- [x] Token refresh: same `scheduleRefresh()` pattern as the main
      `auth.ts`, but acting on `.session.drop`.

**Demo:** Open The Drop in a fresh client → "Continue with GitHub"
landing → browser auth → install yo App on personal account → header
shows `@<login>` + green install dot. Other panels (Home, Terminal,
Council) unaffected.

### Phase 2 — Browse + Your Cyphers read Projects (~2 days)

**Server prereq:** Phase 11 (`POST /api/projects`, `GET /api/projects/mine`)
+ Phase 15 (FTS-ranked `GET /api/projects/discover`).

The Drop's existing Browse + Your Cyphers rows already render row cards.
Swap their data source.

**Tasks:**

- [ ] `drop-preload.ts`: rename
      `cypherDiscover` → `projectDiscover`,
      `cyphersList` → `projectsMine`,
      `cypherGet` → `projectGet`,
      `cypherJammers` → `projectAssignees`.
      Keep cypher-prefixed IPC names callable for one PR's worth of
      dual-running, then delete.
- [ ] `drop.ts → renderBrowse()`: switch hero + live-cypher row + your
      cyphers row to the new endpoints. Result rows now carry
      `gh_owner` (`@user` or `@org`), `gh_project_url`, `linked_repos[]`,
      `mode` (`solo`/`tournament`/`pipeline`), `jammer_count`,
      `created_at`. Hero featured-cypher logic (highest `jammer_count`
      live cypher) unchanged.
- [ ] Each card grows a small "🐙 `@<owner>`" badge under the title.
      Click → `shell.openExternal(gh_project_url)`.
- [ ] Search input: pre-fill with the user's capability stack on focus
      (existing). Add a `🐙 my orgs only` toggle (default off → all
      public).
- [ ] Empty states copy: keep the noun "cypher" in user-facing text.
- [ ] Top Agents row: temporarily reads from the legacy
      `agent_performance` leaderboard until Phase 7 swaps it.

**Demo:** Browse renders real GitHub Projects with project owners +
linked repos. Click hero → opens project on github.com. Search "vector
db" returns FTS-ranked Projects.

### Phase 3 — Drop-a-Cypher wizard creates a real Project (~3 days)

**Server prereq:** Phase 11 (matchmaker v1, project creation, custom
fields). Drop Phase 1 (the user has at least one App installation to
target).

Today's wizard: **Goal → Work Package → Seed Roster → Lobby** (4 steps).
After the pivot: **Goal → Owner + Repo → Mode → Lobby** (4 steps,
slot-for-slot — same animation, same kbd shortcuts).

- **Step 1 (Goal):** unchanged. Title, goal, vibe chip, visibility chip,
  capability tag picker.
- **Step 2 (Owner + Repo):** new.
  - Owner picker: dropdown of accounts the user has installed yo on
    (personal `@<login>` always present + each installed org). Default
    = personal. If only one option, skip the picker and show
    "hosting on `@<login>`" as a static line.
  - Repo picker: optional multi-select of repos the App is installed
    on for the chosen owner. Skip = draft-only cypher (research,
    design, tournaments with comment submissions).
  - Persisted as `owner_kind` (user/org), `owner_login`, `linked_repos[]`.
- **Step 3 (Mode):** new. Three chips:
  - `solo` (default) — 1 jammer, standard work
  - `tournament` — N submitters, M winners; reveals slots/winners inputs
  - `pipeline` — sequential hand-off; reveals an ordered step-list editor
  - `ReviewMode` chip strip: `host` (default) / `first-passing-ci`.
    Latter only enabled if all linked repos have CI configured (server
    tells us in `reposForInstallation` response).
- **Step 4 (Lobby):** unchanged. 1m / 5m / 15m / 1h / Open until I start.
- **"Drop it":** POST `/api/projects` →
  `{ goal, owner_kind, owner_login, linked_repos, mode, slots, winners,
     review_mode, lobby_duration_seconds, capability }` →
  `{ project_url, slug, gh_project_id }`. On success, transition to
  Lobby view (existing handoff stays).

**Tasks:**

- [ ] `drop.ts`: rewrite the `drop-a-cypher` overlay flow. Reuse the
      step-card animation; swap step content.
- [ ] `<owner-picker>` + `<repo-picker>` widgets backed by new IPC
      `installationsList()` and `reposForInstallation(owner_login)`
      proxying yo-server.
- [ ] Mode chip strip with `tournament` / `pipeline` reveal panels.
- [ ] First-time host with no installation: deep-link to "Install yo
      App" before letting Step 2 complete.
- [ ] Cancel: drop any in-progress draft Project (don't orphan empty
      Projects on the user's account).
- [ ] Submit failure (e.g. user revoked App install mid-wizard):
      inline "Reinstall yo App" CTA, not a generic error.
- [ ] Telemetry: per-step time, mode-chosen distribution, ReviewMode
      distribution.

**Demo:** "Drop a Cypher" produces a real Project URL on the chosen
owner. Project board renders on github.com with custom fields populated
and (for `tournament`) `Slots = 3`, `Winners = 1`.

### Phase 4 — Lobby view = Project `Status = Lobby` (~2 days)

**Server prereq:** Phase 11 (Project `Status` field exists) + Phase 14
(`/api/projects/:ref/board` + `/api/projects/:ref/events/stream`).

Today's Lobby polls `cypherGet` + `cypherJammers` every 4s. After the
pivot it's webhook-backed.

**Tasks:**

- [ ] Replace the 4s poll with `projectGet({ ref, with: ['assignees',
      'status_field'] })` on mount + an EventSource on
      `/api/projects/:ref/events/stream` for live updates.
- [ ] Countdown timer (large mono clock, urgent pulse last 10s) reads
      `lobby_duration_seconds` from the response — unchanged widget.
      "Open" mode = no auto-start.
- [ ] Roster grid renders Project assignees (GH avatars + `@<login>` +
      capability tag). Identicon fallback retired since GH always has
      an avatar URL.
- [ ] Host actions: **Start now** → `POST /api/projects/:ref/start`
      (server flips `Status` to `Live` and runs first matchmaker round
      if items already exist). **Cancel cypher** → archives Project.
      **Leave** → removes self as collaborator.
- [ ] Host detection: compare `project.host_user_id` to current
      session's `user_id`. Non-hosts only see Leave + Spectate.
- [ ] Lobby → Workspace transition unchanged (lobby's poll/stream
      detects `Status = Live` and pushes the view).

**Demo:** Two clients on two machines watching the same Lobby. Host
clicks Start on machine A; machine B's view pushes to Workspace within
a second.

### Phase 5 — Workspace view = Project board hydration (~3 days)

**Server prereq:** Phase 14.

Today's Workspace shows Roster + Stage + Activity driven by
`cypherEvents` polling. After the pivot it hydrates the Project board.

- [ ] On mount: `projectGet({ ref, with: ['board','assignees',
      'recent_events'] })`. Open EventSource on
      `/api/projects/:ref/events/stream`.
- [ ] **Roster (left)** — Project assignees with avatar, `@<login>`,
      assigned-item count, activity dot (green pulse if
      `pr_opened`/`comment` within 30s). Click an assignee → filter
      Stage to their items.
- [ ] **Stage (center)** — focused assignee's open items as cards.
      Each card: title, capability, status, link to the GH item, plus
      live tool-call/text events from any local jammer working that
      item (the daemon emits these into `cypher_events`-equivalent
      stream — see Phase 6).
      For `tournament` mode, show all PRs side-by-side with a
      "Pick winner" radio (host-only) once review opens.
- [ ] **Activity feed (right)** — flat 100-row stream of webhook
      events. New kinds: `item_assigned`, `pr_opened`, `pr_merged`,
      `item_closed`, `comment` (issue comment).
- [ ] **Header runtime clock** — unchanged. **Wrap up** button → host
      action → confirm modal → archive Project + close open items.
- [ ] Remove the `cypher-bus.ts` subscription on this view.

**Demo:** Two Workspace windows on two machines watching the same
Project. Item assignment on one → reflects on the other in <1s. PR
merge → both render `✓ merged` on that item.

### Phase 6 — Jammer daemon: assignment → clone → CC → PR (~3 days)

**Server prereq:** Phase 12 (`/api/me/assignments/stream`, online-workers
heartbeat) + Phase 13 (daemon helpers shared with the TUI plan).

The local jammer daemon lives in **the main process, not inside The
Drop's renderer**. It's user-scoped, runs whenever yo-client is open,
and reacts to assignments regardless of whether The Drop panel is
focused. The Drop's GH-bound session token is what authenticates the
SSE subscription (the daemon reads it from `~/.glyphh/.session.drop`).

- [ ] `agent-runner.ts`: subscribe to `${AUTH_SERVER}/api/me/
      assignments/stream` on app start (only when `.session.drop`
      exists; idle otherwise). Each event: `{ project_id, item_id,
      item_body, capability, repo, mode, project_slug }`.
- [ ] Eligibility filter per loadout: only react if the item's
      `capability` is in this jammer loadout's stack and the loadout's
      `joinable: true` flag is set.
- [ ] Delete `cypher-bus.ts` SSE subscription one PR after the new
      stream is stable; keep both running for at least one session to
      compare.
- [ ] Workspace cloner: when assignment carries `repo`, clone (or
      fetch) into `~/.yo/workspaces/<project-slug>/<item-id>/`. Calls
      existing `work-package-runner` for setup steps.
- [ ] Feature branch: `yo/<project-slug>/<item-id>` from default
      branch.
- [ ] Launch Claude Code subprocess with item body + `ACCEPTANCE:` +
      `SCOPE:` blocks (composed by the bundled `dotyo-network` skill).
      Stream stdout into the project's `cypher_events`-equivalent
      stream (so The Drop's Workspace view's Stage column shows it
      live across machines).
- [ ] PR opener: when CC reports done, `git push -u origin <branch>` +
      open PR using the **user's own GH PAT** (read from
      `~/.config/gh/hosts.yml` `oauth_token`, or `GITHUB_TOKEN` env).
      yo never holds this credential.
- [ ] Post a comment on the source item linking the PR via yo-server's
      App.
- [ ] Draft-item handler (no `repo`): post the LLM result as an item
      comment instead of opening a PR.
- [ ] Heartbeat: `POST /api/me/heartbeat` every 30s while The Drop's
      session exists + at least one loadout is `joinable: true`.
- [ ] Concurrency cap: respect each loadout's `max_concurrent`; queue
      assignments past the cap and post a "queued by `@<login>`'s
      `<loadout>`" comment so the host knows.
- [ ] Failure modes:
  - Empty diff → comment + decline (server marks assignment declined,
    matchmaker re-routes).
  - Timeout → comment with elapsed + decline.
  - Crash → re-throw; next assignment recovers.
- [ ] No `gh` CLI / `GITHUB_TOKEN` set: emit a one-time toast in The
      Drop's header — "to open PRs, run `gh auth login`" — and skip
      assignment until set.

**Demo:** End-to-end. Host runs Drop-a-Cypher (with `linked_repos =
[acme/api]`, `mode = solo`). MCP `spawn` from any orchestrator (TUI or
another Drop) creates an item. Matchmaker assigns it to a matched
jammer running in *this* Electron app. The Drop's Workspace view shows
the agent's tool calls live. PR appears in `acme/api`. Host merges →
reputation tick.

### Phase 7 — Reputation in The Drop UI (merged-PR count) (~2 days)

**Server prereq:** Phase 16 (reputation table + nightly job +
`/api/users/:id/reputation` endpoint).

- [ ] Replace `cypherPerformanceWriteback` IPC with a no-op
      (server-driven now). Delete its callers.
- [ ] **Your Agents** view in The Drop: each loadout card's stats
      panel reads from `GET /api/users/me/jammers/<id>/reputation` →
      `{ merged_prs, items_completed, avg_time_to_merge,
        tournament_wins, last_active }`.
- [ ] **Browse → Top Agents row**: pull from
      `GET /api/leaderboard?capability=...`. Existing render code
      stays; only the data source changes.
- [ ] **Project card hover** in Browse: show host's reputation summary
      ("12 merged · 3 tournament wins") under the owner badge.
- [ ] Legacy `agent_performance` table: read-only flag on the server.
      v2 cleanup removes the writes from `cypherWrap`.

**Demo:** A loadout that won three tournaments shows `tournament_wins:
3` on its profile card. Top Agents row ranks accurately.

### Phase 8 — Org install + per-seat billing in Drop Preferences (~2 days)

**Server prereq:** Phase 16 (per-seat Stripe).

This is **Drop-local Preferences** (gear icon in the Drop header), not
a yo-client-wide Preferences pane. Keeps the scope tight.

- [ ] **Drop → Preferences → Account:** show the bound GH identity +
      "Sign out of GitHub" button.
- [ ] **Drop → Preferences → Installations:** list of orgs/accounts
      the yo App is installed on, each with a member count + per-seat
      monthly cost summary. Click → opens that org's billing page on
      `platform.dotyo.dev` (server-rendered).
- [ ] **Drop → Preferences → Personal subscription:** for jammers
      without an org install — links to platform's billing.
- [ ] Remove yos balance widget completely from The Drop header.
- [ ] Help → Billing copy reflects per-seat-for-orgs / personal-sub
      model.

**Demo:** A solo user sees personal subscription status. A member of
an installed org sees "billed via @acme" with no top-up UI.

---

## What we're NOT building (Drop-specific)

- **GH OAuth in any panel other than The Drop.** The binding is scoped.
- **A second main-process token store.** Drop sessions live in
  `.session.drop`; the existing `~/.glyphh/.session` is untouched.
- **A merge button in The Drop.** Hosts merge on github.com. The
  Workspace view links out.
- **A diff viewer in The Drop.** Click the PR row → opens in browser.
- **Vendoring `octokit`.** All GitHub calls go through yo-server's App
  broker. The Drop never holds a GitHub installation token.
- **A per-org billing UI inside The Drop.** Click → opens platform's
  billing page. We don't reimplement Stripe surfaces.
- **A new IPC channel set for the main yo-client.** All new IPC lives
  on `drop-preload`. The other panels' preloads aren't touched.
- **Touching `auth.ts`.** It manages the main yo session and stays as
  is.

---

## Cross-doc dependencies

- [`/yo/THE-PIVOT-GITHUB.md`](../../yo/THE-PIVOT-GITHUB.md) — TUI plan
  + canonical server-side Phase 9–16 list. **Server work goes first**;
  client phases here are gated on each.
- `yo-server` (branch `github-pivot`) — endpoints + migrations.
- `THE-DROP.md` (this repo, root) — existing UX baseline. Carries over
  the 4-view layout + countdown timer + roster grid; supersedes its
  cypher-state mechanics with this plan once Phase 4/5 ship.

---

## First step

**Phase 1** is the unblocker on the Drop side. It depends on server
Phases 9 + 10 (App + GH OAuth callback), which are themselves the
unblockers on the server side.

**Parallel work that doesn't wait on the server:**

- Sketch the `<owner-picker>` + `<repo-picker>` Drop widgets against
  hardcoded fixtures so Phase 3 is just a data-source swap when the
  API arrives.
- Audit `cypher-bus.ts` callers in `agent-runner.ts` and Workspace
  view; map each to its Phase 6 / Phase 5 replacement.
- Render the "Continue with GitHub" landing card behind a feature
  flag (`enableGhAuth: false`) so the Drop can ship the UI ahead of
  the auth wire-up.

Each is a flippable checkbox here once it lands.

---

*Last updated: 2026-05-06. Plan-only — iterate before build.*
