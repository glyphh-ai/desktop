# THE-PIVOT-BYOK — yo without the proxy

> **Status: planning. Working procedure: as each phase task is completed,
> flip its checkbox here in the same commit. This doc is the persistent
> task tracker — if a session drops, the next session resumes from the
> first unchecked box.**
>
> **Sister doc to [`THE-PIVOT-GITHUB.md`](./THE-PIVOT-GITHUB.md).** That
> pivot moves cypher coordination to GitHub Projects. This pivot moves
> all inference local. **The two are independent and can ship in
> parallel** — together they reduce yo-server to a thin coordination
> layer that can't lose money on inference and can't see prompt
> content.

---

## Build progress

| Phase | Title | Status |
|---|---|---|
| 1 | BYOK Settings → Providers tab | ✅ done |
| 2 | Claude Code bootstrap (terminal launch on first run) | ✅ done |
| 3 | Provider adapters call providers directly (no proxy) | ✅ done |
| 4 | Cypher / agent runtime → Claude Code subprocess | ✅ done |
| 5 | Council BYOK | ✅ done |
| 6 | Delete the proxy (server + client) | ✅ done |
| 7 | Delete yos (balance, kitty, top-up, overage, ledger, settlement) | ✅ done |
| 8 | Subscription-only billing (already half-done; finish) | ✅ done |

Legend: ⬜ not started · 🟡 in progress · ✅ done

---

## The pivot in one paragraph

Today yo-server proxies every LLM call. It holds API keys for Claude,
OpenAI, Gemini, xAI, and Perplexity, and bills users via `yos` based on
token consumption. **This is the source of every margin headache,
top-up flow, overage tracker, ledger, kitty, settlement code path, and
~80% of the platform UI.** All of it disappears the moment we stop being
an inference middleman.

After this pivot:

- **Claude becomes a local Claude Code subprocess** — same model the
  /yo Python TUI already uses. Cyphers, agents, council members on the
  Anthropic provider, regular chat: everything that needs an "agent
  loop" spawns CC bound to the **user's own Claude Code subscription**.
  yo-server never sees a Claude prompt or response.
- **Other providers go BYOK.** Settings → Providers exposes a key field
  for OpenAI, Gemini, xAI, Perplexity, and the raw Anthropic API. yo-client's
  adapters call provider APIs directly from the Electron main process.
  Keys stay encrypted via `safeStorage` and never leave the user's
  machine.
- **Council survives unchanged** at the UX level. Members are still
  `(provider, model)` pairs; the only difference is each adapter pulls
  the user's local key instead of dialing the proxy.
- **yos goes away entirely.** No balance, no top-ups, no overage, no
  kitty, no settlement. Subscription is a flat **$20/mo Cypher tier**
  for the network/coordination/discovery/reputation surface. Inference
  cost is the user's problem — and they pay providers directly, no
  yo middleman taking a spread.

---

## Why this works (the new value prop)

The pre-pivot pitch was "we manage your AI bills." It's a brittle pitch
because:

1. We have to be cheaper than buying tokens directly, which forces tight
   margins.
2. Margin pressure forces complex tier math (yos/$, overage, top-ups) —
   most of `app/admin/pricing` is workarounds for this.
3. Holding provider keys creates a 24/7 ops burden (rotation, abuse,
   rate-limit defense, support tickets when a vendor goes down).
4. Users who already have an Anthropic Pro / OpenAI Plus subscription
   feel double-billed.

The post-pivot pitch is **"we coordinate; you bring the inference."**

1. Margins on the $20/mo tier become near-pure (no inference cost
   absorbed).
2. Pricing reduces to one slider: subscription on/off.
3. We never see prompts. Strong privacy story — auditable claim.
4. Users with existing AI subscriptions get full reuse. New users sign
   up for one provider (Claude Code) and yo works.
5. **Multi-provider cost transparency stays** because the model-rates
   table can keep listing $/1k-token costs as informational data in
   Council's member picker — "this debate cost you $0.42" via the
   user's own bills.

---

## Concept mapping

| Today | After the pivot |
|---|---|
| `proxy-client.ts` → `POST /api/llm/proxy` (SSE) | Adapters call provider SDKs directly from main process |
| Provider keys stored on yo-server (`provider_keys` table, encrypted) | Provider keys stored client-side in `~/.glyphh/.providers.json` (`safeStorage`) |
| `yos` balance, top-ups, overage, kitty, settlement | **Deleted.** Subscription only. |
| Cypher kitty pre-funding the work | **Deleted.** Hosts pay nothing to yo for cypher work; their jammers spend their own provider bills. |
| `cypher_kitty_ledger`, `kitty_balance`, settlement at wrap | **Deleted.** Reputation = merged-PR count (after THE-PIVOT-GITHUB) or `agent_performance` (today) — cost attribution disappears entirely. |
| `agent-runner.ts` calls proxy for Claude inference | `agent-runner.ts` spawns Claude Code subprocess (same pattern as /yo TUI) |
| Council member streams via `runProxyStream` | Each member's adapter uses BYOK directly |
| yo-platform `/admin/pricing` (yos tier admin, model rates, margins) | **Deleted** entirely except for an informational "Council provider costs" reference (Phase 7) |
| `/dashboard/billing` (yos packs, top-ups, overage settings) | Subscription status + cancel link only |
| Org-level yos balance + admin credit/debit | **Deleted.** Org pays per-seat subscription, that's it. |
| Heartbeat + tier polling via `auth.ts` | Unchanged — still polls subscription/tier (just no yos data in the response) |

---

## What stays the same

- **The Drop's UX** (Browse / Your Cyphers / Lobby / Workspace).
- **Council's UX** (chained / free-for-all / debate; chained turn
  rendering; member picker).
- **The cypher lifecycle** (host → lobby → live → wrap).
- **All other panel apps** (Home, Terminal, Browser, Monaco, Context).
- **Local agent loadouts** under `~/.yo/agents/<id>/` — skills, model,
  system prompt, avatar, memory.
- **yo-server's coordination role** — auth, discovery, matchmaking,
  reputation, subscription, heartbeat, capability registry.
- **Path-gate / sandbox / `~/.yo/`** trust boundary.

---

## What gets deleted (no compatibility window — there are no production
users to migrate)

**yo-server:**
- `src/routes/llm-routes.ts` (the `/api/llm/proxy` route + SSE infra)
- `src/services/llm-service.ts`, provider router, key resolver
- `src/services/provider-key-service.ts` + `provider_keys` table
- `src/routes/yos-routes.ts` (balance, ledger, packs, top-up, overage,
  rate-cards — most of this is already half-removed in `cypher-build`)
- `src/services/yos-service.ts`, `yos-ledger`, `yos-settlement`
- `src/services/cypher-kitty-service.ts` + `cypher_kitty_ledger` table
- Migrations 012, 016, 020, 025, 027 (yos schema). Rolled into a single
  `0XX_drop_yos.sql` cleanup migration rather than reverted, since
  there's no data to preserve.
- `model_rates` table: **kept** for informational cost-per-token display
  in Council's UI, but no longer drives billing.
- The settlement code path in `cypherWrap` (already best-effort; just
  remove the call).

**yo-client:**
- `src/main/provider-adapters/proxy-client.ts`
- `src/main/yo-interceptor.ts` (yos surface bits)
- All yos display components (balance widget, top-up CTA, overage
  warnings).
- `cypher-kitty-service` IPC bindings if any are surfaced in the renderer.

**yo-platform:**
- `app/admin/pricing/page.js` (yos tier admin) — already added the
  margin sandbox; whole page goes away in Phase 7 once we ship
  cost-transparency in Council instead.
- `app/admin/yos-credit-debit` flows (admin yos credit/debit actions
  for orgs).
- `app/dashboard/billing/page.js` reduces to subscription state +
  cancel + invoice list (delete top-up buttons + overage settings +
  yos balance display).

---

## Phase plan

### Phase 1 — BYOK Settings → Providers tab (~3 days)

Settings already exists in yo-client. Add a Providers tab.

- [ ] `src/renderer/help/settings.ts` (or wherever Settings lives — verify
      during scoping): add "Providers" tab.
- [ ] Per-provider row: Anthropic, OpenAI, Google AI (Gemini), xAI,
      Perplexity. Each row has:
  - input field for API key (paste-only; never displays the saved key,
    only "configured" / "not set")
  - status badge: `configured` (green) / `not set` (grey) / `invalid`
    (red, after a failed test)
  - "Test" button → fires a 1-token completion against the provider;
    updates the badge
  - "Remove" button → wipes the key
- [ ] `src/main/provider-keys.ts` (new) — reads/writes
      `~/.glyphh/.providers.json`, encrypted via `safeStorage`. Exposes
      `getKey(provider)`, `setKey(provider, key)`, `removeKey(provider)`,
      `listConfiguredProviders()`.
- [ ] IPC: `providerKey.set`, `providerKey.remove`, `providerKey.test`,
      `providerKey.list` (returns provider names + status, never
      returns the key value itself).
- [ ] Help copy: "Your keys live on this machine. yo never sees them."

**Demo:** Open Settings → Providers, paste an OpenAI key, click Test
→ badge flips to `configured`. Restart the app; key persists; status
unchanged.

### Phase 2 — Claude Code bootstrap (~2 days)

The /yo TUI already requires the user to have run `claude /login` and
have valid `~/.claude/.credentials.json`. yo-client adopts the same
contract.

- [ ] On first launch (or whenever CC creds are missing/expired), pop a
      modal: "Sign in to Claude Code." Two options:
  - "Open Claude Code in your terminal" (preferred for users who
    already have `claude` on PATH) → opens user's default terminal
    via `open` (mac) / `start cmd` (win) / `x-terminal-emulator`
    (linux) running `claude /login`. Polls
      `~/.claude/.credentials.json` every 2s for 5 min.
  - "Open in this window" → embedded `xterm` running `claude /login`
    inline (we already ship xterm via the Terminal panel; reuse).
- [ ] `src/main/cc-bootstrap.ts` (new) — detects `claude` on PATH,
      checks creds path, surfaces installer link if `claude` is
      missing.
- [ ] `src/main/cc-creds.ts` (new — port from /yo's `lib/cc_creds.py`)
      — reads CC creds locations on each platform.
- [ ] On every yo-client start: silent CC creds check. If missing, gate
      the agent-loop features (cyphers, yo-agent) with a "Sign in to
      Claude Code" CTA on each affected surface. Council's non-Claude
      providers still work without this.
- [ ] Install detection: if `claude` CLI not found anywhere, surface
      a one-liner in the modal: "Install Claude Code first" with a
      `Copy install command` button.

**Demo:** Fresh user runs yo-client → bootstrap modal → "Open in this
window" → embedded `claude /login` flow → user authorizes in browser
→ creds appear → modal closes. Cyphers + yo-agent now usable.

### Phase 3 — Provider adapters call providers directly (~3 days)

Refactor each provider-adapter to use the BYOK path; delete `proxy-client.ts`.

- [ ] Bundle SDKs: `@anthropic-ai/sdk`, `openai`, `@google/generative-ai`.
      xAI + Perplexity are OpenAI-compatible; reuse the openai SDK with
      a custom `baseURL`.
- [ ] `src/main/provider-adapters/claude-adapter.ts`: replace
      `runProxyStream` with `@anthropic-ai/sdk` streaming. Reads
      `getKey('anthropic')`. Throws `ProviderNotConfiguredError` if
      unset (existing error class — already handled in callers).
- [ ] `openai-adapter.ts`: same pattern, `openai` SDK.
- [ ] `gemini-adapter.ts`: `@google/generative-ai` SDK.
- [ ] `xai-adapter.ts`: openai SDK with `baseURL = "https://api.x.ai/v1"`.
- [ ] `perplexity-adapter.ts`: openai SDK with `baseURL =
      "https://api.perplexity.ai"`.
- [ ] Delete `provider-adapters/proxy-client.ts`.
- [ ] Delete the proxy-stream-error matchers + the SSE `usage` /
      `settlement_error` event handlers in council-session and
      anywhere else (they were proxy-specific; provider SDKs report
      usage directly).
- [ ] Bundle-size audit: confirm Electron bundle stays under our
      packaging budget. Provider SDKs aren't huge but four of them
      adds up; tree-shake aggressively.

**Demo:** Council debate runs with all five providers, no proxy
traffic. Network tab shows direct calls to api.anthropic.com,
api.openai.com, etc.

### Phase 4 — Cypher / agent runtime → Claude Code subprocess (~4 days)

Where today's `agent-runner.ts` calls `proxy-client` for Claude
inference, switch to spawning Claude Code subprocesses with
the user's local CC creds. Pattern is proven in /yo's `network.py`
(`yo_mcp_config()` + `claude_agent_sdk.ClaudeSDKClient`).

- [ ] Bundle `@anthropic-ai/claude-agent-sdk` (or its node equivalent —
      verify availability; if Node SDK ships behind the Python one,
      shell out to `claude` directly with stdin/stdout JSON mode as
      a fallback).
- [ ] `src/main/cc-agent-runtime.ts` (new) — spawn-and-stream wrapper.
      Inputs: `system_prompt`, `tools` (MCP server config), `messages`.
      Streams text + tool_use events back through an event emitter the
      existing renderers can consume.
- [ ] `src/main/agent-runner.ts`: replace claude-adapter calls with
      `cc-agent-runtime`. Other providers still use the now-BYOK
      adapters.
- [ ] `src/main/yo-agent.ts`: same swap.
- [ ] Cypher per-jammer runtime: same swap. Each jammer's loadout
      defines model + tools; runtime spawns CC with that config.
- [ ] Existing tool-use rendering in Workspace view: confirm it still
      parses CC's tool-use frames (different shape from proxy SSE).
      Likely needs a small adapter in `format-markdown.ts` /
      Workspace renderer.
- [ ] Update `claude-adapter.ts`: now serves only the **non-CC**
      Claude path (raw Anthropic API key for chat outside the agent
      loop, used by Council members on the Claude provider). Anthropic
      API ≠ Claude Code; we keep both paths, gated on which key the
      user has configured.

**Demo:** Drop a Cypher → host's "yo agent" turns are Claude Code on
their subscription; jammer that joins picks up via assignment, runs CC
locally, posts result. yo-server doesn't see a Claude prompt anywhere.

### Phase 5 — Council BYOK (~1 day)

- [ ] `council-session.ts`: replace `runProxyStream` with the Phase 3
      adapters. Each member resolves its provider+model + the user's
      local key.
- [ ] If a member's provider is unconfigured, member picker shows
      "configure key in Settings →" inline; Start button disabled
      until all selected members have keys.
- [ ] Per-turn cost display: optional read from `model_rates`
      informational table — show "this round cost ~$0.42 of your
      OpenAI billing" inline. Pure transparency; we don't bill it.
- [ ] Remove `council-event` IPC frames for `usage` / `settlement_error`
      (proxy-specific).

**Demo:** 3-member council debate (Sonnet + GPT-4 + Gemini). Each
turn's stream comes from the right provider; small cost line at the
bottom of each round.

### Phase 6 — Delete the proxy (~2 days)

**yo-server:**
- [ ] Delete `src/routes/llm-routes.ts`, `src/services/llm-service.ts`,
      provider routing, encrypted key store, all proxy-side SSE infra.
- [ ] Delete `src/services/provider-key-service.ts` + the
      `provider_keys` table (migration: drop table).
- [ ] Delete the admin "Provider Keys" tab on yo-platform.
- [ ] yo-server now lives in API + DB only; the SSE proxy port can be
      retired.

**yo-client:**
- [ ] Delete `src/main/provider-adapters/proxy-client.ts`.
- [ ] Delete proxy-related IPC channels.
- [ ] Search-and-destroy any callers of `runProxyStream`.

**Demo:** yo-server deploys with the proxy route 404'ing. Nothing in
yo-client should hit it; if anything does, that's a Phase 3/4/5
regression and gets caught.

### Phase 7 — Delete yos (~3 days)

**yo-server:**
- [ ] New cleanup migration `0XX_drop_yos.sql`: drops yos tables
      (`yos_balance`, `yos_ledger`, `yos_packs`, `yos_overage`,
      `yos_auto_topup`, `cypher_kitty_ledger`, `model_rates` keeps —
      informational only).
- [ ] Delete `yos-routes.ts`, `yos-service.ts`, `yos-ledger.ts`,
      `yos-settlement.ts`, `cypher-kitty-service.ts`.
- [ ] Delete the settlement call in `cypherWrap`.
- [ ] Update `/api/auth/me` to remove `yos_balance` field.
- [ ] Update `/api/admin/users` to remove yos columns.

**yo-client:**
- [ ] Delete the yos balance widget anywhere it's surfaced (header,
      Drop, dashboard hooks).
- [ ] Delete top-up CTAs.
- [ ] Delete kitty pre-fund step from Drop-a-Cypher wizard (already
      gone in /yo's `/host`; mirror in The Drop).
- [ ] `auth.ts`: remove `yos_balance` from the heartbeat result type.

**yo-platform:**
- [ ] Delete `app/admin/pricing/page.js` entirely (margin sandbox
      included). Replace with a small "Provider cost reference" page
      that just shows `model_rates` for Council UI seed data — no
      editing.
- [ ] Delete `app/dashboard/billing/page.js`'s top-up + overage
      sections. Reduce to: current tier, status, invoice list, cancel.
- [ ] Delete `/admin/orgs/[id]/yos-credit-debit` flow.
- [ ] Strip yos columns from admin users + admin orgs tables.

**Demo:** No yos anywhere in the product. `/api/me` returns no
balance. Billing page shows "Cypher — $20/mo, active" and an invoices
list, nothing else.

### Phase 8 — Subscription-only billing (~1 day, mostly cleanup)

Most of this work landed when we removed yos from the cypher-build
branch. Finish line items:

- [ ] Stripe webhook handlers: keep `customer.subscription.*`, drop
      `invoice.payment_succeeded` yos-credit handler.
- [ ] Trial enforcement: 14-day trial gates cypher hosting + Council
      use. Joining + browsing remain free forever (lurker model).
- [ ] Per-seat for orgs (already specced in THE-PIVOT-GITHUB Phase 8 /
      Phase 16 server). Coordinate with that doc — same Stripe schema.

**Demo:** Fresh signup → 14-day Cypher trial → can host + run Council
→ trial ends → host disabled until subscribe.

---

## What we're NOT building in this pivot

- **A yo-managed key vault.** Keys live on each user's machine in
  `safeStorage`. No cloud sync, no sharing across devices. Users with
  multiple machines paste their keys on each. (Cross-device sync via
  yo would re-create the key-custody risk we're trying to escape.)
- **An "abstract over providers" SDK on the client.** Five small
  adapters is the entire surface area; we don't need a meta-SDK.
- **A "let yo proxy if you don't have a key" fallback.** That keeps
  the proxy alive defeating the point. If a user has no key for a
  provider, that provider is disabled in Council's picker. Period.
- **Migrating existing yos balances to subscription credit.** Per
  THE-PIVOT-GITHUB's resolved questions: there are no production users
  to migrate. Internal accounts get archived; new accounts start clean.
- **Cost analytics inside yo.** "How much did I spend on Anthropic last
  month?" → that's a question for the user's Anthropic dashboard, not
  ours. We can show *per-Council-round* informational cost from
  `model_rates` (Phase 5) but no aggregate.

---

## Cross-doc dependencies

- [`THE-PIVOT-GITHUB.md`](./THE-PIVOT-GITHUB.md) — independent. Run in
  parallel; either order works:
  - GitHub-pivot first → cypher coordination moves to Projects → most
    proxy traffic disappears naturally → BYOK pivot is mostly cleanup.
  - BYOK first → proxy gone → GitHub-pivot lands on a yo-server that
    only does coordination → matchmaker work has fewer moving parts.
- [`THE-DROP.md`](../THE-DROP.md) — kitty section becomes obsolete
  after Phase 7. Performance write-back unchanged.

---

## First step

**Phase 1** is the unblocker — without BYOK settings, every
subsequent phase that calls a provider directly has nowhere to read a
key from. It's also the lowest-risk: pure UI + safeStorage, no
runtime swap, no proxy deletion.

Parallel work that doesn't wait on Phase 1:

- Audit every `runProxyStream` callsite to know the exact blast radius
  for Phase 6.
- Spike the Claude Code subprocess wrapper (Phase 4 task) against /yo's
  pattern; verify the Node SDK / shell-out path works in Electron's
  main process before committing to it.
- Draft the cleanup migration `0XX_drop_yos.sql` against the current
  schema so Phase 7 is a paste-and-run.

---

*Last updated: 2026-05-06. Plan-only — iterate before build.*
