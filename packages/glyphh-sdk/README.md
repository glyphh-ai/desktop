# @glyphh/sdk

The one client SDK every Glyphh client — **mobile, desktop, CLI, web, platform** —
uses to authenticate and talk to the control plane and the rotor runtime. Write the
session mechanics once; each client is a thin renderer on top.

- **Design & decisions:** [docs/architecture.md](docs/architecture.md)
- **Build roadmap:** [docs/build-plan.md](docs/build-plan.md)
- **The server it talks to:** [../server/README.md](../server/README.md) — how to run
  the Glyphh control plane locally (`docker compose up`). The SDK's integration
  tests and REPL expect it on `http://127.0.0.1:3001`.

> **Status:** the **auth subsystem** is live (magic link · native Google/Apple ·
> WorkOS org SSO · opaque sessions with single-use rotation). The rotor streaming
> transport (`session`/`turn`/reconnect) and the control-plane method surface land
> next — see the build plan.

---

## Install

```bash
npm install @glyphh/sdk
```

Zero runtime dependencies. Runs on Node, the browser, and React Native/Hermes on
web-standard `fetch` (injectable). Ships dual ESM/CJS with `.d.ts`.

## Quick start

```ts
import { createClient } from "@glyphh/sdk";

const glyphh = createClient({ url: "https://api.glyphh.ai" });

// — email magic link (no passwords) —
await glyphh.auth.startEmailLink("me@example.com");      // emails a deep link
// …app opens glyphh://auth/callback?token=… →
await glyphh.auth.verifyEmailLink(tokenFromDeepLink);    // → signed in

// — native social (token comes from the native Google/Apple SDK) —
await glyphh.auth.google(googleIdToken);
await glyphh.auth.apple(appleIdentityToken, { fullName });

// — organization SSO (WorkOS, browser handoff) —
const { authorizationUrl } = await glyphh.auth.startOrgSso({
  email: "user@acme.com",
  redirectUri: "glyphh://auth/callback",
});
// open authorizationUrl in a system browser → deep-links back with ?code= →
await glyphh.auth.exchange(codeFromCallback);

// — use the session —
const bearer = await glyphh.token();   // live access token, auto-refreshed
await glyphh.auth.signOut();           // revoke + clear
```

Every method returns the **same opaque session**, so the only thing that differs
between clients is which button was tapped.

## The client surface

| Member | Purpose |
|---|---|
| `auth.startEmailLink(email, { redirectUri?, machineId? })` | request a magic link |
| `auth.verifyEmailLink(token, machineId?)` | verify → session |
| `auth.google(idToken, machineId?)` / `auth.apple(identityToken, { fullName?, machineId? })` | native social sign-in |
| `auth.startOrgSso({ email? \| organizationId?, redirectUri, machineId? })` | → WorkOS `authorizationUrl` |
| `auth.exchange(code, machineId?)` | trade the one-time callback code for a session |
| `auth.signOut()` | revoke everywhere + clear locally |
| `token()` | a live bearer (auto-refreshes); throws if signed out |
| `refresh()` | force a rotation; `false` if signed out |
| `getSession()` | the current stored session, or `null` |

## Sessions & storage

The SDK owns the token **lifecycle**; the host owns storage **at rest**. Provide a
`TokenStore` to persist the session (default is in-memory):

```ts
import { createClient } from "@glyphh/sdk";
import { InMemoryTokenStore } from "@glyphh/sdk/storage/memory";

const glyphh = createClient({
  url,
  tokenStore: mySecureStore,        // implement TokenStore over Keychain/SecureStore/file
  onSignedOut: () => router.replace("/sign-in"),
});
```

- **Opaque, server-backed** access + refresh handles — no readable claims, revocable
  server-side.
- **Single-use rotation** with reuse detection: presenting a rotated refresh revokes
  the whole family (`onSignedOut` fires). The SDK handles single-flight refresh,
  proactive refresh, and 401 retry for you.
- **Headless / CI:** pass `apiKey: "yo_…"` instead of a session — `token()` returns it
  unchanged.
- **React Native / tests:** pass `fetch` to inject the platform's implementation.

See [docs/architecture.md](docs/architecture.md) for the full token model.

## The REPL

An interactive harness — a thin `@glyphh/sdk` consumer, so anything it can do,
your app can too:

```bash
npm run repl                                   # → http://127.0.0.1:3001
GLYPHH_SERVER_URL=https://api.glyphh.ai npm run repl
```

Up/down arrows navigate command history. Commands:

```
magic <email>     full magic-link sign-in (dev returns the token)
verify <token>    verify a magic token → session
google <idToken>  native Google sign-in     apple <idToken>  native Apple sign-in
org <email>       organization SSO → prints the authorization URL
exchange <code>   trade a one-time code for a session
token             print the current bearer (auto-refreshes)
refresh           force a refresh (watch it rotate)
introspect        call /api/auth/introspect on the current token
session · signout · health · url <newUrl> · help · quit
```

## Testing

```bash
npm run verify     # typecheck + lint + tests
npm test           # unit (deterministic, no server) + integration (vs a live server)
```

The **integration tests drive a real running control plane** (per the SDK spec —
no mocks for the transport). Start it first with
[`docker compose up`](../server/README.md), then `npm test`.
