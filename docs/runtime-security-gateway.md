# Glyphh Runtime Security Gateway — Plan

**Status:** In progress · **Owner:** Chris · **Started:** 2026‑07‑07
**Scope:** `glyphh-apps` (desktop runtime) + `yo-server` (cloud ingress)

Goal: make the Glyphh app runtime a hardened, sandboxed execution surface with a
real policy/gateway layer that (a) protects the runtime from `.glyphh` apps that
don't conform to the spec, (b) contains conforming‑but‑malicious apps, and (c)
rate‑limits / throttles / quotas public‑facing endpoints per visitor.

---

## 1. The core reframe: three boundaries, not one "gateway"

"Gateway" bundles three enforcement planes that live in different processes and
need different tools. Do **not** put a single gateway "inside the runtime."

| Plane | Lives in | Solves | Build vs buy |
|---|---|---|---|
| **1. Public ingress** | **yo‑server (cloud)** | rate‑limit / throttle / per‑visitor / quota / auth for `<slug>.glyphh.app` | **Build thin** on existing libs (`express-rate-limit` + Redis buckets already in repo); Cloudflare rules for the crude edge |
| **2. Capability PEP** | **desktop runtime** | non‑conforming apps + conforming‑but‑malicious apps | **Build** — no OSS API gateway brokers Electron IPC capabilities. Optional Cedar/OPA‑wasm for decision logic *only if* policy gets complex (defer) |
| **3. Sandbox integrity** | **desktop runtime (Chromium/OS)** | escape, egress, filesystem | **Config/build** — Electron `webPreferences` + CSP |

Why the public gateway is cloud‑side, not runtime‑side: `<slug>.glyphh.app` is
**always a reverse tunnel to the owner's online desktop**, never cloud hosting
(`yo-server/src/app-proxy-routes.ts:193`). The desktop is downstream of the relay
and cannot see the visitor, so per‑visitor limiting must happen in the cloud,
before load tunnels to someone's laptop.

---

## 2. Current state (from the security review)

### What's already solid (keep it)
- `runCapability` (`glyphh-app-host.ts:405`) is a genuine **single chokepoint**,
  fed by **trusted slugs** (grant‑sourced + install‑sanitized) — apps can't name
  another app's data or claim undeclared capabilities.
- Per‑app SQLite / vector / graph stores are **physically isolated** per slug
  (`~/.glyphh/app-data/<slug>/`). No cross‑app reach.
- Secrets are **host‑only**, never enter the renderer; connector tokens never
  leave the cloud.
- The **worker is locked down** (CSP `default-src 'none'; script-src 'self'`,
  `glyphh-app-worker.ts:72`) → zero network.
- No require‑graph / native‑module / arbitrary‑exec from app code. Filesystem is
  unreachable except user‑initiated in‑DOM upload (correct default).

### The holes (ranked)
- **H1 🔴 App UI window has ambient outbound network.** No CSP, no navigation
  guard on the app `BrowserWindow` (`glyphh-app-host.ts:307`). A **zero‑capability**
  app can `fetch()`/`WebSocket` its own DB/vector data to any host. → **P0.1**
- **H2 🔴 HTTP‑tunnel public apps (`kind:"http"`) have zero protection** — no rate
  limit, firewall, or quota; raw tunnel to the owner's local server (only a 10MB
  body cap). Bypasses the global limiter by design (`server.ts:80` before `:90`). → **P1.2**
- **H3 🟠 No per‑visitor identity on the public surface** — anonymous MCP callers
  share one `anon` guardrail bucket (`app-mcp.ts:260`); no per‑IP limit, no daily
  quota. Credits **off by default and fail open** (`billing-config.ts:44`). → **P1.1/P1.3/P1.4**
- **H4 🟠 `sandbox:true` not set** on app/worker windows (defense‑in‑depth vs
  renderer RCE); **host‑only secret classification is name‑pattern‑based**
  (`app-secrets.ts:143`) so a token under a non‑matching name leaks. → **P0.2 / P0.3**

### Structural facts that shape the fix
- **No global guardrail layer exists** — every guardrail is per‑app in
  `launchConfig`. Adding a global config is filling a real hole.
- **`action-gate.ts` is dead code** — an approval‑engine scaffold from the removed
  chat agent (zero call sites). Right *concept* for runtime consent; rebuild
  against the capability model. → **P3.1**
- **Multi‑tenant org model already exists.** `organizations` carries governance
  columns (`allowed_models`, `max_output_tokens`, credit limits). Auth is
  per‑user; all app config is **org‑scoped**. A global guardrails config should be
  **org‑scoped, cloning the `/api/org/models` pattern**. → **P2.1**
- A dormant global `guardrails` KV table + `GET /api/config/guardrails` exist with
  no writer/consumer (`config-routes.ts`) — alternative home if policy should be
  platform‑global rather than org‑scoped.

---

## 3. Target architecture

### Layered policy model (the "move guardrails out" part)
```
GUARDRAIL_FLOOR         platform hard-min, un-weakenable        (exists: app-mcp-service.ts:59)
  ⊂ org policy          admin default, in DB + Settings         (NEW — P2.1/P2.2)
     ⊂ per-app override  bounded by org policy                  (exists: launchConfig.guardrails)
```
- Move the **rate/quota tier** to org‑default‑with‑per‑app‑override.
- **Keep** capability *declaration* per‑app (it's the manifest contract).
- Enforce in **both** places: server `getAppMcpConfig` **and** a new client‑side
  PEP wrapping `runCapability` (today the desktop only enforces `maxOutputTokens`;
  rolling‑window caps are server‑only).

### Sandbox model (target)
- App UI window: strict CSP (local assets + inline OK, **all remote + `connect-src`
  blocked**), navigation/window‑open denied, `sandbox:true`.
- Worker: already locked down; add `sandbox:true`.
- Secrets: **default‑deny** exposure to app code (allowlist, not name denylist).
- Filesystem: stays unreachable; any future local‑file feature is a **gated
  capability** (`fs.read`/`fs.write`) with per‑path user consent — never ambient.

### Public ingress (target)
- One per‑visitor + per‑proxy limiter mounted **inside `appProxyMiddleware`**
  (`app-proxy-routes.ts:193`) covering **both** HTTP and MCP surfaces.
- Anonymous visitors keyed by IP / anon‑session so the shared `anon` bucket splits.
- Fail‑closed credits + daily quota for `public` apps.

---

## 4. Phased task plan

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

### Phase 0 — Sandbox integrity (desktop, do first)
- [x] **P0.1 — Lock down app UI egress.** Add a strict CSP for app `file://`
  pages (scoped `onHeadersReceived` on the app‑window session + preview session,
  matching only `file://…/custom-apps/…`) + `setWindowOpenHandler`/`will-navigate`
  deny on the standalone window.
  - Files: `glyphh-app-host.ts` (`openGlyphhApp`, `registerGlyphhAppHost`).
  - CSP: `default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' file:; style-src 'self' 'unsafe-inline' file:; img-src 'self' data: blob: file:; font-src 'self' data: file:; media-src 'self' data: blob: file:; worker-src 'self' blob: file:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`.
  - Accept: `window.glyphh.call` still works (IPC, not CSP‑governed); `../_libs/*`
    still load; a test `fetch('https://example.com')` from an app is blocked; the
    app can't `window.open()` a remote URL. Both type‑checks green.
- [x] **P0.2 — Enable `sandbox:true`** on the app UI window (`openGlyphhApp`) and
  the worker (`startWorker`). Verify both preloads are sandbox‑safe (only
  `contextBridge`/`ipcRenderer`).
  - Files: `glyphh-app-host.ts:312`, `glyphh-app-worker.ts:90`.
  - Accept: app + worker still boot; `glyphh.call`/`glyphh.handle` still work.
- [x] **P0.3 — Default‑deny config‑var exposure.** Invert `isHostOnlySecret` to an
  allowlist: a config var is app‑readable only if explicitly marked; add an
  "app‑readable" marker in the Config Vars UI; default false. *(Behavior change —
  confirm before shipping.)*
  - Files: `app-secrets.ts`, `apps-ipc.ts`, `renderer/help/apps.ts` (Config Vars tab).

### Phase 1 — Public ingress gateway (cloud)
- [x] **P1.1 — Per‑visitor + per‑proxy rate limiter** at `appProxyMiddleware`
  (covers HTTP + MCP). Reuse `express-rate-limit` + Redis (as `relay-rate-limit.ts`).
  - Files: `yo-server/src/app-proxy-routes.ts:144/193`, new limiter module.
- [x] **P1.2 — Extend controls to the HTTP‑tunnel path** (`kind:"http"`): rate
  limit + concurrency cap + rolling quota (today only a 10MB body cap).
  - Files: `yo-server/src/app-proxy-routes.ts:375` (`streamThrough`).
- [x] **P1.3 — Per‑visitor identity for anonymous callers.** Key limits by IP /
  anon‑session cookie; split the shared `anon` bucket (`app-mcp.ts:260`).
- [x] **P1.4 — Fail‑closed credits + daily quota for public apps.** Flip
  `COMPUTE_ENFORCE_CREDITS` posture for `public` apps; add a long‑horizon quota
  (today only 60s windows).
  - Files: `yo-server/src/billing-config.ts`, `app-mcp-service.ts`, `app-guardrails.ts`.

### Phase 2 — Policy plane + runtime PEP
- [x] **P2.1 — Org guardrails policy (DB + API).** Add `guardrails_policy JSONB` to
  `organizations`; `GET/PATCH /api/org/guardrails` (org_admin write, member read),
  cloning `/api/org/models`.
  - Files: `yo-server/src/migrations/*.sql`, `services/org-service.ts`, `routes/org-routes.ts`.
- [x] **P2.2 — Desktop Settings → Security panel** (org‑scoped, gated to
  org_admin), reusing the per‑app Guardrails field markup.
  - Files: `renderer/sections/settings.html`, `renderer/help/settings.ts`, `main/settings-ipc.ts`, `renderer/preload.ts`.
- [x] **P2.3 — Layer org policy into enforcement (server).** *(client PEP → P2.4)* Server: fold org policy between
  `GUARDRAIL_FLOOR` and per‑app in `getAppMcpConfig` (`app-mcp-service.ts:100`).
  Client: new PEP wrapping `runCapability` so the desktop enforces too.
- [ ] **P2.4 — Generalize rate/quota guardrails to all app surfaces** (not just
  MCP‑kind), so UI/worker/HTTP apps are covered by the same policy.

### Phase 3 — Consent + gated filesystem
- [ ] **P3.1 — Per‑app permission scopes (default‑on, opt‑out).** *Redesigned:*
  no runtime prompt — installing/exposing IS the consent. Two config‑time scopes
  per app, both default‑on: **local** (declared caps active when the owner runs
  it; per‑capability off‑switches) and **remote** (align the MCP UI to default‑on;
  server already exposes‑all when `mcpApproved` is null). Enforced by call source
  in `runCapability`/`callAppTool`. *(Mostly already the behavior — small deltas.)*
- [x] **P3.2 — Gated `fs.read`/`fs.write`/`fs.pick`, config‑time roots.** *(capability + enforcement; roots-revoke UI → P3.2b)* New
  fs capabilities, default‑on but **inert until the user picks allowed roots**
  (no default disk scope). `fs.pick` = OS dialog (interactive only) → records an
  allowed root; `fs.read`/`fs.write` = realpath‑under‑root + mode, system‑dir
  deny‑list, size caps; call‑source scoped. Roots revocable per app.

---

## 5. Open decisions
- **P0.3 default‑deny secrets**: behavior change for existing apps that read plain
  config vars. Ship with a migration/marker, or defer? (Recommend: marker + default
  false, warn on set.)
- **Policy scope**: org‑scoped (recommended, matches all app config) vs
  platform‑global (`config/guardrails` table). 
- **CSP strictness**: keep `'unsafe-eval'` in `script-src` for lib compatibility
  (three.js/flow.js) or drop it and test per‑lib?
- **Cedar/OPA**: adopt an embeddable policy engine for P2.3 decision logic, or
  hand‑write (recommend hand‑write; ~20 fixed capabilities).

### Phase 1 progress
- 2026‑07‑07: **P1.1 done** — new `yo-server/src/services/app-proxy-rate-limit.ts` (Redis fixed-window + in-proc fallback) wired into `handleProxy` right after `enforceAuth`, covering BOTH the `/mcp` and HTTP-tunnel surfaces at one chokepoint. Keys by user id, else client IP (CF-Connecting-IP → XFF → req.ip) — anonymous public callers get their own per-IP cap instead of a shared bucket. Two buckets: per-visitor + per-proxy aggregate (visitor-rejected hits don't consume proxy budget). Defaults 120/1200 per-min (http), 60/600 (mcp), env-overridable; returns 429 + `Retry-After`; fails **open** on Redis error (availability). tsc green; window + two-bucket + ordering unit-checked.

- 2026‑07‑07: **P1.2 done** — HTTP-tunnel abuse controls in `app-proxy-rate-limit.ts`, wired into `streamThrough`: per-proxy **concurrency cap** (default 20 active streams; Redis counter; released via `res.on("close")` so every exit path frees it), per-request **response-size ceiling** (default 256MB; aborts mid-stream via `controller.cancel()`), and a rolling per-window **egress-byte quota** (per-visitor 256MB/60s, per-proxy 2GB/60s; checked at start, accumulated at close). All env-overridable; 429/503 + Retry-After; fail-open. tsc green; all three controls unit-checked.

- 2026‑07‑07: **P1.3 done** — anonymous MCP callers now get a per-IP guardrail bucket instead of the shared `<slug>:anon` one. `handleProxy` threads its `visitorKey` (user id, else `ip:<addr>`) into `handleAppMcp` → guardrail `idKey`, so one anon visitor can't drain the shared token/call budget; aggregate anon load stays bounded by the per-proxy rate limiter + cost quotas (doc updated in `app-guardrails.ts`). tsc green.
- 2026‑07‑07: **P1.4 done — Phase 1 complete.** (a) New `creditsBlocked(orgId, isPublic)` in `credit-service.ts` — public/anonymous apps ALWAYS enforce credits and **fail closed** (deny on lookup error); authenticated apps keep the `COMPUTE_ENFORCE_CREDITS` flag + fail open. Both gates (HTTP `handleProxy`, MCP `runTool`) switched over; dead `getBalance`/`COMPUTE_ENFORCE_CREDITS` imports removed. (b) Daily per-proxy request quota (`rl:d:<slug>`, default 50k/24h, env-overridable) added to `checkAppProxyRateLimit`, covering both surfaces. tsc green; creditsBlocked truth-table + daily window unit-checked.

### Phase 2 progress
- 2026‑07‑07: **P2.1 done** — org-scoped guardrails policy plane. Migration `yo-server/src/migrations/002_org_guardrails_policy.sql` adds nullable `organizations.guardrails_policy JSONB`; `OrgGuardrailsPolicy` type + `OrgRow` field; `updateOrg` whitelists it (`::jsonb`); `GET/PATCH /api/org/guardrails` (org_admin write, member read) cloned from `/api/org/models`, with a validator (non-negative ints over the 6 known fields, unknown keys dropped, `null` clears). tsc green; validator unit-checked. **⚠ Action: run `npx tsx src/scripts/migrate.ts` (or the deploy migrate step) to apply.**

- 2026‑07‑07: **P2.2 done** — Settings → **Security** panel (desktop). New sub-nav item + panel mirroring the per-app Guardrails fields (6 numeric limits), gated to org_admin/super_admin (non-admins see a read-only note). Server-authoritative: loads via `org-guardrails-get`, saves via `org-guardrails-set` → `serverGetAuthed`/`serverPatchAuthed` on `/api/org/guardrails`. New IPC handlers (`settings-ipc.ts`), preload bridge + `Window.yo` types, controller wiring in `help/settings.ts`. tsc green (main+renderer).

- 2026‑07‑07: **P2.3 done (server enforcement)** — `getAppMcpConfig` folds the org guardrails policy into an app's effective guardrails via new exported `mergeGuardrails(perApp, org)`: FLOOR fills unset → per-app values → **org policy as a per-field ceiling** (a per-app value may be stricter but never exceed the org policy). One `findOrgById` per MCP-config resolve; no behaviour change until an admin sets a policy. tsc green; ceiling semantics unit-checked (7 cases). **Re-scope:** the "client-side PEP" half of P2.3 is folded into **P2.4** — org guardrails govern the public/relay MCP surface (enforced here, server-side); a desktop PEP is about the owner's own local capability calls, which is exactly P2.4's remit.

- 2026‑07‑07: **P2.2b done** — mirrored Security settings into **glyphh-platform** (`yo-platform`, Next.js). New admin-gated `Security` sub-page (`app/dashboard/settings/security/page.js`) editing the same `/api/org/guardrails` endpoint, cloned from the Organization governance page; added `security` to `SETTINGS_SUBS` (admin-only via new `ADMIN_ONLY_SUBS`) in `app/dashboard/layout.js`. Verified `lib/api` (get/patch), middleware routing (generic /dashboard auth, no per-route block), and nav gating. **Caveat:** platform builds via SWC (no standalone typecheck here) — confirm with `next build`/`next dev`.

### Phase 3 progress
- 2026‑07‑07: **P3 design settled** — no runtime consent modal. Permission is config-time: installing (local scope) or exposing (remote scope) IS the consent, both **default-on / opt-out**. Remote/automated callers can't ride interactive consent (separate scopes; there's no runtime prompt to ride). `fs.pick` reframed as *data selection*, not a permission gate.
- 2026‑07‑07: **P3.2 core done** — new `glyphh-app-fs.ts` broker + `fs.read`/`fs.write`/`fs.pick` in `KNOWN_CAPABILITIES` + `runCapability` (with `senderWc` threaded from the call handler for the interactive picker). Filesystem is **inert until the user grants a root** via `fs.pick` (OS dialog, interactive-only — worker/relay have no window). read/write resolve only under a granted root (**realpath defeats `..` + symlink escape**), never under a system deny-list (`~/.glyphh`, `~/.ssh`, `~/.aws`, keychains, browser profiles), 25 MB caps. Roots persist per-app device-locally (`~/.glyphh/app-fs-grants.json`). tsc green; **safety path unit-tested against a real filesystem incl. actual symlinks** (8 cases — traversal / symlink-escape / deny-list / mode / no-root all denied). Remaining: **P3.2b** roots-revoke UI (`listFsRoots`/`removeFsRoot` already exported).

### UI follow-ups
- 2026‑07‑07: **Apps detail consistency** — MCP and Guardrails tabs each got their own **Save** button (Public URL already had `proxy-save-btn`), persisting `mcpApproved`+`guardrails` via `panelAppsUpdate` merged into the app's `launchConfig` *without closing the detail* (with "Saved ✓" status). Added a **Test a tool** panel on the MCP tab (tool picker + JSON args + result) that invokes the app's tool through the local runtime via a new `glyphh-app:call-tool` IPC → `callAppTool`; shown for installed apps only (hidden for LLM apps, whose tools run against the model). tsc green (main+renderer).

## 6. Progress log
- 2026‑07‑07: Security review completed (4 parallel audits). Plan drafted. Starting P0.1/P0.2.
- 2026‑07‑07: **P0.1 done** — app UI CSP (`connect-src 'none'` + no remote loads) injected via scoped `onHeadersReceived` on the app-window (default) + preview (persist:yo) sessions for `file://…/custom-apps/…` mainFrames; `setWindowOpenHandler`/`will-navigate`/`will-redirect` deny on the standalone window (nav allowed only within the app's own bundle dir). `glyphh-app-host.ts`. tsc green; path-matching logic unit-checked (query/hash/percent-encoding/cross-app-escape).
- 2026‑07‑07: **P0.2 done** — `sandbox:true` on the app UI window and the worker window (both preloads verified sandbox-safe: only `contextBridge`/`ipcRenderer`). `glyphh-app-host.ts`, `glyphh-app-worker.ts`. tsc green.
- 2026‑07‑07: **P0.3 done — Phase 0 complete.** Config-var exposure is now default-deny. `secrets.get` returns a value only if the var is explicitly marked "Readable by app code" (new Config Vars checkbox); credential-shaped names (`isHostOnlySecret`) stay host-only regardless as a hard floor. New `isSecretAppReadable` allowlist + per-secret `appReadable` flag plumbed through IPC/preload/types/UI. **Migration:** existing plain config vars an app read via `secrets.get` are now denied until re-saved with the marker (the trusted runtime's key auto-pickup for llm.complete/agent.run is unaffected — it uses `secretValueFromRow` directly). Files: app-secrets.ts, glyphh-app-host.ts, apps-ipc.ts, preload.ts, renderer.ts, sections/apps.html, help/apps.ts. tsc green (main+renderer); classifier unit-checked.
