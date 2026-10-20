# Build Plan — server + SDK in lockstep

Companion to [`architecture.md`](architecture.md) and the domain design
([`server/docs/domain-accounts-billing.md`](../../server/docs/domain-accounts-billing.md)).
Supersedes the earlier draft plan (2026-07-14).

## The prime directive

**The SDK is the primary client of the server.** Every capability the server has is a
typed SDK method, every SDK method is a CLI command, and the REPL can do **every
single thing**. The UIs that follow (platform, desktop, mobile, web) are **thin
wrappers** over the SDK — no client ever talks to the server directly.

```
server (control plane)  ⇄  @glyphh/sdk (ALL logic)  ⇄  CLI/REPL (100% coverage of the surface)
                                                        ⇄  platform / desktop / mobile / web (thin UI)
```

**Enforced, not aspirational:**
- A **CLI-parity test** fails the build if any public `Client` method lacks a CLI
  command (the surface is walked programmatically).
- **Coverage thresholds** fail-under in both repos (server ≥85% already wired; SDK
  gets the same).
- Every slice ships server tests (real Postgres) + SDK tests (deterministic unit +
  integration against the live server) + CLI commands + docs.

## Per-slice method (every slice, no exceptions)

1. **Contract** — request/response types in `@glyphh/sdk/contract` (pure types).
2. **Server** — migration → service → routes (thin files, one concern each).
3. **SDK** — typed methods over the http client.
4. **CLI** — commands in the `glyphh` CLI + REPL (auto-registered per domain).
5. **Tests** — server integration (real PG) + SDK unit + SDK↔server integration +
   CLI parity green.
6. **Verify + commit + push** — both repos; `npm run verify` green in each.

Code standards on every file: structured logging w/ redaction · try/catch/finally on
all I/O · no massive files (split routes/service/store) · concise, thin, idiomatic.

## Phase 0 — CLI foundation *(first, everything hangs off it)*

Grow the REPL into a real CLI: `glyphh <domain> <command> [args]` (bin) + interactive
REPL mode (same command table, history, banner). One **command registry** shared by
both; each domain module contributes its commands. Add the **parity test**. Config:
`--server`, stored profile (`~/.glyphh/config.json`), token store on disk (sealed).
Existing auth commands migrate into it.

## Phase 1 — Accounts: orgs, members, seats

- **Server:** org CRUD (name/slug/address/billing_address/billing_contact); invites
  (email+role+token, seat-reserving) → accept; member list/remove/role-change; seat
  enforcement. Personal org-of-one on signup.
- **SDK:** `org.get/update`, `members.list/invite/remove/setRole`, `invites.accept`.
- **CLI:** `glyphh org show|update`, `glyphh members list|invite|rm|role`.

## Phase 2 — Workspaces (governance)

- **Server:** workspaces table (ex-`org_roles`): `limit_providers/models/connections/
  apps/app_hosting` + `allowed_*` lists, `allow_custom_mcp`, `credits_cap`, rate
  limits; one base workspace per org; user→workspace assignment (single).
- **SDK:** `workspaces.list/create/update/delete/assign`.
- **CLI:** `glyphh ws …`. Effective-grants resolution tested hard (flag off=all, on=list).

## Phase 3 — Billing: plans, Stripe, credits

- **Server:** `plans` (Free $0/25 · Basic $40/2k · Pro $150/10k · Enterprise custom);
  Stripe checkout/portal/webhooks; seats=quantity; per-org **discounts in Stripe**;
  credit grants on renewal; enterprise custom-invoice path.
- **SDK:** `billing.plan/subscribe/portal/status`.
- **CLI:** `glyphh billing …`. Webhook reconciliation tested w/ stripe fixtures.

## Phase 4 — Catalog: providers, models, pricing *(Glyphh + org layers)*

- **Server:** platform catalog tables (providers, models — open-weight + proxied) +
  `super_admin` release + **credit pricing** (credits/sec fly+pipedream, credits/token
  per model — port rates from server-old); org enablement + BYOK keys (encrypted,
  write-only); workspace filtering already governs.
- **SDK:** `providers.*`, `models.*`, `admin.catalog.*`, `admin.pricing.*`.
- **CLI:** `glyphh providers|models …`, `glyphh admin catalog|pricing …`.

## Phase 5 — Connections (Pipedream, custom MCP)

- **Server:** port connection-service + connector-tools from server-old (org admin
  auths once → org-available; custom MCP install; write-only encrypted headers);
  workspace grant/filter.
- **SDK:** `connections.list/connect/remove`, `connections.installCustomMcp`.
- **CLI:** `glyphh connections …`.

## Phase 6 — Usage: ledger, audit, rollups *(the critical spine)*

- **Server:** append-only `usage_events` ledger (`source, user, workspace, org,
  session, quantity, credits, credits_saved, cost_usd, ref`); ingest endpoint
  (service-token authed, for runtime/hosted apps); rollup views user→ws→org;
  credit-cap enforcement; `super_admin` margin + month-close reconciliation.
- **SDK:** `usage.mine/workspace/org`, `admin.usage.reconcile`.
- **CLI:** `glyphh usage …`. **Reconciliation property test:** Σ user = Σ ws = Σ org.

## Phase 7 — Sessions & provisioning *(control plane meets the runtime)*

- **Server:** sessions table (locus remote|local|relay, rotor, repo+branch+path,
  workspace/user); `Provisioner` interface + `FlyProvisioner` (stator machine
  start/stop + session pods, reaper); GitHub App connection + scoped clone-token
  injection; metering hooks → Phase 6 ledger.
- **SDK:** `sessions.create/list/get/delete` → hands `{runtimeUrl, runtimeToken}` to
  the existing rotor transport; `github.connect/repos`.
- **CLI:** `glyphh sessions …`, `glyphh repos …`; REPL can create a remote session and
  stream a turn end-to-end.
- **openrotor (parallel):** `IntrospectionVerifier` → `/api/auth/introspect`; guard
  `/run`, `/runs/*`, `/ws`; `ROTOR_WORKSPACE`→`sandbox` rename.
- **SDK transport:** add `WsTransport` (SSE done); full suite runs under both.

## Phase 8 — Apps: marketplace + hosting

- **Server:** apps registry (manifest/spec validation — port `glyphh-app-spec`),
  marketplace publish/browse/install; hosting options (super_admin) + deploy-to-fly
  (`<slug>.glyphh.app`, metered) + lifecycle/reaper.
- **SDK:** `apps.browse/install/publish`, `hosting.deploy/status/destroy`.
- **CLI:** `glyphh apps …`, `glyphh deploy`.

## Phase 9 — Org libraries + personal libraries

- Rotors/skills/agents at org level (via membership); user personal: models,
  connections, rotors, apps, skills, agents, layouts, drips, message sessions.
- **SDK/CLI:** `rotors|skills|agents|layouts|drips …`.

## Phase 10 — Relay (drive-my-desktop) *(last; conscious opt-in)*

- **Server:** relay router (same-user, per-device opt-in, revocable); **SDK:**
  attach-serve (desktop registers + serves its local rotor over outbound WS) +
  client-side routing of a `relay` session; CLI: `glyphh relay enable|disable|status`.

## Then: the thin clients

Platform (web admin) → desktop → mobile — each consumes the SDK only, deleting its
bespoke API code (no-dead-code cutovers). By then the CLI has already proven every
flow the UIs need.

## Standing gates (every phase)

- `npm run verify` green in **both** repos before commit; commit + push per slice.
- CLI-parity test green (no SDK method without a command).
- Coverage thresholds enforced (fail-under) in both.
- Docs updated (SDK README command table; server README endpoints).
