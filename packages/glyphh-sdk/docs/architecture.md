# `@glyphh/sdk` — Architecture & Design Decisions

**Repo:** `glyphh-ai/sdk` · **Package:** `@glyphh/sdk` · **License:** proprietary ·
**Status:** v0.1 (unified auth + rotor transport)

This document is the durable record of the architectural decisions behind the SDK.
It supplements `openrotor/docs/sdk-spec.md`, which specifies only the *rotor
transport* half. The decisions below cover the half the spec left open: **server
auth integration, the mobile auth flow, and token/API-key management.**

---

## 1. Why this SDK exists

Four clients — mobile, desktop, CLI, web — each need the same session mechanics:
authenticate, hold a credential, refresh it, open a durable stream to a rotor
server, and decode a typed event stream. Today that logic is **re-implemented per
client** (the mobile app hand-rolls `api/client.ts` + `session.ts` + `auth.ts`).

`@glyphh/sdk` is the single implementation every client consumes. It is the
**bridge between two backends**:

```
                        @glyphh/sdk
        ┌──────────────────────┴───────────────────────┐
        │                                               │
   auth subsystem                               rotor transport
   (talks to yo-server:                    (talks to the rotor runtime:
    api.glyphh.ai)                          loopback OR *.fly.dev)
   login · refresh · session               turn · stream · reconnect · HITL
        │                                               │
        └──────── produces token: () => Promise<string> ┘
                  (opaque bearer, injected into transport)
```

- **server = the control plane**: identity, orgs, workspaces, sessions, API keys,
  BYOK provider keys, SSO/SCIM, billing, **usage metering**, and **runtime
  provisioning**. The source of truth. Everything durable lives here.
- **the rotor runtime = the data plane** (`openrotor serve`): executes rotors and
  streams `rotor.stream/v1`. A stateless, fungible, **per-session ephemeral** fly
  Machine; validates tokens by asking the control plane (introspection), never by
  holding secrets; meters usage back to the control plane.

## 1.1 The three planes & remote-session provisioning

```
        client ── uses ──▶ @glyphh/sdk ──┬── control (auth·billing·provision·usage) ──▶ server
                                            └── data (rotor.stream/v1) ──▶ runtime (fly Machine)
   server ── provisions (fly Machines) ──▶ runtime ── introspect + usage/meter ──▶ server
```

The SDK is the **one client to both planes** — control on the server, data on the
runtime — and hides the seam from consumers. `auth`, `usage`, and `billing` are
first-class in all three: the server is the authority + meter of record, the
runtime introspects + emits usage, the SDK carries the credential + surfaces both.

**Remote-session provisioning flow:**

1. client → SDK → **server**: start a remote session for project X.
2. server: checks **auth + entitlement + workspace governance + credits/billing**
   → **provisions a fly Machine** (region/size by tier) via a pluggable
   `Provisioner` (`FlyProvisioner` now; `K8sProvisioner` later) → injects env
   (introspection URL, session scope) → injects a **server-minted, scoped,
   short-lived git clone token** (from the user's connected GitHub) so the instance
   clones project data into its `sandbox`.
3. server → SDK: `{ runtimeUrl, runtimeToken, sessionId }` — `runtimeToken` is a
   **scoped, short-lived** handle minted for that instance.
4. SDK streams **directly** to the runtime; the runtime **introspects**
   `runtimeToken` against the server (same opaque+introspection model).
5. runtime **meters usage** and **pushes** it to the server → aggregation → billing.
6. server **reaps** the instance on session end/idle.

**Two provisioning tiers, both server-enforced (SDK exposes, server authorizes):**
- **super admin** → provisions/manages the *environment/fleet* (fly orgs/apps/
  regions, capacity, base image, global secrets, quotas): `client.admin.environments.*`.
- **user** → provisions a *session instance* within that environment, governed by
  workspace + entitlement: `client.sessions.provision()`.

## 1.2 Deployment topology — control plane stays on Heroku, data plane on Fly

The two planes deploy to **different hosts**, on purpose:

- **Control plane (server) → Heroku.** It is a single always-on service with DNS,
  TLS certs, and routing **already provisioned**. Re-homing it would redo working
  infra for near-zero gain — the control plane is not the cost driver. It is built
  host-agnostic (12-factor: `PORT`, `/healthz`, Docker *or* buildpack via
  `Procfile`), so it runs on Heroku unchanged; `DB_SSL=true` for Heroku Postgres.
- **Data plane (runtime) → Fly Machines.** The **elastic, cost-sensitive** part:
  per-session ephemeral machines, greenfield (no infra to redo). Fly issues a valid
  `*.fly.dev` cert per Machine automatically, so the SDK's direct data stream is
  TLS with zero cert work.

**Cross-provider is fine — every hop is bearer-over-TLS, no private networking
required:** SDK→control plane (Heroku domain/cert), SDK→runtime (`*.fly.dev`
cert), runtime→control plane introspection + usage push (Heroku HTTPS). Cost is
optimized where it scales (Fly Machines); stable infra stays where it is solved
(Heroku).

---

## 2. Token model — opaque, server-backed

### Decision

The client-held credential is a pair of **opaque, server-backed handles**:

| Credential | Lifetime | Properties |
|---|---|---|
| `access` | short (~15 min) | opaque; validated by server session lookup; instantly revocable; carries **no readable claims** |
| `refresh` | long (~7 day) | opaque; **single-use, rotating**; reuse → whole token family revoked |

### Why not stateless JWTs (the status quo)

The JWT pair is stateless *in theory only*: yo-server already performs a live
`users.findById` + `status` check on **every** authenticated request, so we pay a
DB hit per call regardless. We get the cost of statefulness with none of the
benefit. Opaque tokens turn that same lookup into **instant revocation** and stop
leaking `sub`/`email`/`org`/`role` claims to anyone who captures a token.

### The open-source constraint (decisive)

`openrotor` is **Apache-2.0**. A stateless-JWT model would force us either to ship
JWT verification + a signing/verification key into the open runtime, or to share
`JWT_SECRET` across services (letting two systems mint tokens). Both are
unacceptable. Opaque tokens + **introspection** keep the open runtime generic and
secret-free — it just asks yo-server "is this token good, and who is it?"

### What lives where

- **Server DB (source of truth):** session records (stored **hashed**, like
  `mcp_tokens`), refresh families, users, orgs, roles, API-key hashes, BYOK keys,
  device codes, SSO org links. Authoritative and revocable.
- **Client (minimum footprint):** only the opaque `access` + current `refresh`
  handle, in an OS-native secure enclave. Nothing sensitive is derivable from them.
  Logout wipes local state; server-side revocation kills them regardless.

---

## 2.1 Authentication methods (decided)

Grounded in how our clients actually sign in + how Anthropic's own apps do it
(native consumer social, WorkOS for enterprise). WorkOS User Management **cannot
ingest a native Apple/Google token** — social must be native+direct OR browser
PKCE. We chose native consumer social (keeps Face/Touch ID) + WorkOS for orgs.

| Method | Auth path | User store |
|---|---|---|
| **Google** | native SDK → `idToken` → server verifies via Google certs (aud/iss) | our DB (`google_sub`) |
| **Apple** | native SDK → `identityToken` (+name once) → server verifies via Apple keys | our DB (`apple_sub`) |
| **Email** | **magic link** (tokenized deep link, emailed) — **no passwords, ever** | our DB |
| **Organization (OAuth/SSO)** | **WorkOS** Organizations → browser PKCE (`getAuthorizationUrl` → code → `authenticateWithCode`), server holds `code_verifier` keyed by state | WorkOS user ↔ our org |

- **Every path converges to our opaque session tokens (§2)** — the SDK surface is
  uniform: `auth.google(idToken)`, `auth.apple(identityToken)`,
  `auth.startEmailLink(email)` / `auth.verifyEmailLink(token)`,
  `auth.startOrgSso({ org })` → all return the same `Session`.
- **Org OAuth is first-class from day one** on both server and SDK (WorkOS's core
  strength), not a bolt-on.
- Dropped vs `server-old`: bcrypt password store, OTP infra. Kept: native social
  verification, `machineId` device binding, WorkOS enterprise SSO/SCIM.

## 3. The three credential classes (do not conflate)

Conflating these is where a security model rots. The determining question for any
secret is **"who executes the call it authorizes?"** — the secret lives with that
executor and nowhere else.

| Class | Example | Lives where | Client holds it? |
|---|---|---|---|
| **Session** | opaque access/refresh (§2) | client secure enclave + server session record | yes (opaque, its own) |
| **API key (to us)** | `yo_…` mcp_token | server DB (SHA-256 hash) | raw shown **once**, then client keychain for headless |
| **Provider key (BYOK, to third parties)** | `sk-ant-…`, OpenAI, … | **server DB, encrypted at rest**, injected into the runtime at run time | **never** |
| **Git clone token** *(same class as provider key)* | GitHub clone cred | derived from `github_user_tokens`; server mints a **scoped, short-lived** token, injected into the instance | **never** |

Provider keys and git clone tokens are one class — *third-party secrets used by the
runtime: server-held, runtime-injected, never on the client.*

### 3.1 API keys (headless / service-to-service)

`yo_<base64url(32)>` tokens (`mcp_tokens`) — only the SHA-256 hash is stored
server-side; the raw value is shown once. For CI, CLI, and server-to-server use, a
client may present a `yo_` **EXTERNAL** key as a static Bearer instead of the
interactive session pair. Revocable server-side; scoped by a workspace (§ naming).
The SDK supports this via a static-credential provider.

### 3.2 Provider keys (BYOK — Anthropic/OpenAI/…)

**The client SDK is never in the LLM request path.** The client calls the rotor
runtime; the runtime calls the provider. So the provider key must live with the
runtime, never the client:

- **Hosted (remote runtime):** the key lives in the **server DB, encrypted at
  rest** (`org_provider_keys` / `user_provider_keys`), **write-only** from any
  client (set/rotate/delete; never read back), and **injected into the runtime
  execution context** server-side at run time. Never returned to any client.
- **Local/loopback (dot-yo / local gateway):** the runtime is on the user's
  machine, so that machine is both client and server. The key lives in a **local
  secure store** (OS keychain / sealed file) — because the *local runtime* holds
  it, not the SDK. Never plaintext.

**Invariant: the provider key belongs to the runtime; the SDK only ever
*administers* it.** The SDK surface is management-only —
`client.providerKeys.set/list/rotate/delete` — treating the value as opaque,
writing it over TLS, and listing *metadata* only (provider, last-4, createdAt);
the secret is never returned. Matches the existing `provider-key-service`
("never returned to clients") and the write-only-encrypted-headers connector
pattern.

---

## 4. Credential storage contract (SDK side)

The SDK **owns the token lifecycle**; the **OS owns secrets at rest**; the **server
owns authority**.

```ts
interface TokenStore {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}
```

- `InMemoryTokenStore` ships in core (default; tests; ephemeral).
- Real persistence comes from thin **platform adapters** shipped as *separate
  optional entry points* so the core stays dependency-free and RN/Node-agnostic:
  - `@glyphh/sdk/storage/secure-store` — Expo SecureStore (iOS Keychain / Android Keystore)
  - `@glyphh/sdk/storage/keychain` — desktop OS keychain
  - `@glyphh/sdk/storage/file` — sealed/encrypted file (CLI)
- At-rest encryption is delegated to hardware-backed secure enclaves. The refresh
  token is **never** stored in plaintext. A static `yo_` API key via env is
  acceptable only for CI/headless (revocable, scoped).

### The RefreshManager (centralizes what mobile hand-rolls)

- **Single-flight** refresh — concurrent callers share one in-flight refresh.
- **Proactive** refresh within a margin of expiry.
- **401 → refresh → retry-once**, then `signedOut` if unrecoverable.
- **Rotation-safe**: always persist the newly returned refresh handle.
- **Reuse detection**: a consumed refresh presented again revokes the family
  (server-enforced; SDK surfaces the `signedOut`).
- **Redaction**: token values never appear in logs. No telemetry by default.

---

## 5. Runtime auth enforcement (openrotor — coordinated workstream)

`openrotor` cannot ship wide open. It gains a pluggable verifier:

```ts
interface AuthVerifier {
  verify(bearer: string | undefined, ctx: RequestCtx): Promise<AuthResult>;
}
```

- `NoAuthVerifier` — loopback/dev default.
- `IntrospectionVerifier` — POSTs the bearer to a configured yo-server
  introspection URL; short-TTL positive cache; fail-closed on the protected paths.
- Wired into `server.ts` to guard `POST /run`, `/runs/:id/*`, and the `GET /ws`
  upgrade. **Loopback exempt** by config (`ROTOR_AUTH_MODE`,
  `ROTOR_AUTH_ALLOW_LOOPBACK`). 401 + `WWW-Authenticate` on failure.

This closes gap #1 in `sdk-spec.md` §10. openrotor stays Apache-2.0 and
secret-free; glyphh deploys it configured with the introspection verifier.

---

## 6. The greenfield product — new server co-built with the SDK

**No customers exist**, so this is a clean build, not a migration. The old server
is renamed `server-old/` (kept as a reference to port proven logic — social
verify, WorkOS, Stripe provisioning) and a fresh `server/` is built domain by
domain, with the **SDK's typed contract as the single source of truth**. The SDK
method surface + request/response types are defined first; the server exists to
satisfy them.

New-server auth domain delivers:

- `sessions` table: hashed access + refresh handles, `user_id`, `org_id`,
  `machine_id`, `family_id`, `rotated_from`, `expires_at`, `revoked_at`.
- Opaque handles issued from every auth surface (register/login/social/email/
  device-exchange).
- `POST /api/auth/introspect` — validate a bearer, return
  `{ active, sub, org, workspace, tier, exp }`; consumed by openrotor's verifier.
- Refresh-reuse detection on `POST /api/session/refresh`.

The rotor-transport half of the SDK targets **openrotor, which already exists**, so
it can be built on a parallel track and meet the server track at the rotor-session
domain.

## 6.1 Naming

- **`workspaces`** = the renamed governance unit formerly `org_roles` (governs
  allowed models/connections, rate limits, credits cap, base flag). Renamed
  consistently across the new server, SDK, and consumers.
- **`sandbox`** = the renamed runtime fs sandbox formerly `ROTOR_WORKSPACE` /
  "workspace" in openrotor — renamed to eliminate the collision with the
  governance `workspaces` concept.

---

## 7. Authorization boundary — the SDK authenticates, the server authorizes

Consumers of the SDK include the **platform admin** (`platform.glyphh.ai`) and
CLI/desktop admin tooling, which exercise privileged (`org_admin` / `super_admin`)
operations. The scoping of those operations is a **server concern, never the
SDK's.**

**Rule:** the SDK handles *authentication* (who you are: login, tokens, refresh).
yo-server handles *authorization* (what you may do). The SDK never makes an authz
**decision**; it may only **reflect** an authz **fact** the server told it.

**Why the SDK cannot be the gate.** SDK code runs on the user's device/browser,
fully under their control — any client-side role check is trivially bypassed
(edit the bundle, call the endpoint with curl). Enforcement must live where an
attacker can't reach it: yo-server, which already gates privileged routes by role
(`mcp-routes` org-admin, `sso-routes` org_admin + Enterprise tier, `org_roles`).
The **opaque-token model reinforces this**: role/tier/org come from server
introspection at call time, not from a client-held claim — a client cannot forge
elevation because there is nothing readable to edit.

**What the SDK does:**

1. **Typed admin methods** (`client.admin.mcpTokens.create()`,
   `client.org.ssoPortal()`, …) callable by anyone; the **server returns 403** if
   the caller lacks the role, surfaced as a typed `ForbiddenError extends AuthError`.
2. **Reflects role/claims for UX only** — `session.role`, `session.can(...)`
   derived from an authoritative `/me`/introspection response so the platform UI
   can show/hide admin panels. Documented as **advisory rendering, not security**.

**What the SDK must not do:** decide client-side whether to make a privileged
request based on role. That anti-pattern creates a false sense of control and
couples the client to authz rules that change server-side (tier upgrades, role
grants) without a client release.

**Packaging (organizational, not security):** the admin surface lives behind a
subpath — `@glyphh/sdk/admin` / a lazily-imported `client.admin` namespace — so
mobile/CLI never bundle admin code. The enforcement point is unchanged.

---

## 8. Enterprise hardening baseline (applies to every module)

- `try/catch/finally` around all I/O; no unhandled rejections; streams always
  closed in `finally`.
- Zero-dependency **structured logger** (ported from openrotor's `obs/logger`),
  with token/secret **redaction**. JSON or pretty; child bindings per run.
- Typed error hierarchy: `SdkError` → `ConnectError`, `AuthError`,
  `ProtocolError`, `UnsupportedError`; plus `RunError` (a run *outcome*, not
  thrown). Re-export the runtime `E_*` taxonomy so clients branch on codes with no
  runtime dependency.
- Exponential backoff with jitter, cap ~30 s, for reconnect and refresh retries.
- `AbortController` timeouts on every network call.
- **Complete test coverage** against a *real* `openrotor serve` (ephemeral port)
  plus a mock yo-server; coverage thresholds enforced in CI (`fail-under`).
- Proprietary license header on every file. No telemetry by default. Protocol
  version negotiated at runtime (`rotor.stream/vN`); major mismatch → `ProtocolError`.
