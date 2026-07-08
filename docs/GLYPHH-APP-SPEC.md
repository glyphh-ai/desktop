# Glyphh App Spec

A **Glyphh app** is a portable, installable unit that (a) runs a small UI window
on the user's machine, (b) can run **headless logic** in a sandboxed worker, and
(c) can expose **MCP tools** that any consumer of the user's Glyphh relay
endpoint — Claude Desktop, Claude in Cowork, Cursor, a scheduled agent — can
discover and call. This is the marketplace unit: build an app, share the bundle,
install it, and its tools light up for the user's LLM tools automatically.

Apps are web apps with native-grade services: the host hands them a per-app
SQLite database, a cron scheduler, OS notifications, and machine capabilities
(Contacts, Messages) — all behind one capability-gated bridge.

This document is the contract. Version: **2.1**.
(v1 bundles — no `worker`, capability-only tools — remain valid and unchanged. The v2.1
listing fields in §2.1 are all OPTIONAL and additive — older bundles install unchanged.)

---

## 1. Anatomy

A Glyphh app ships as a `.glyphh` — a zip with the manifest and assets at the
root:

```
manifest.json      # required — the app contract (see §2)
index.html         # the app UI (the manifest `entry`)
worker.js          # optional — headless logic (the manifest `worker`, see §4)
…assets            # any CSS/JS/images the UI references (relative paths)
```

Install extracts it to `~/.glyphh/custom-apps/<slug>/` and creates a normal Glyphh
saved-app row, so the app appears on the Apps page, in the command overlay,
answers to `.dip <slug>`, and can sit in a layout — **installed like any other
app**. Re-importing the same slug **updates** the existing install (its worker
is restarted on the new code; its cron schedules survive).

---

## 2. Manifest (`manifest.json`)

```jsonc
{
  "manifestVersion": 2,
  "kind": "glyphh-app",           // required — marks this as a Glyphh app
  "name": "Keep in Touch",        // display name
  "slug": "keep-in-touch",        // stable id: [a-z0-9_-]; the .dip / tool key
  "entry": "index.html",          // UI entry, relative to the bundle root
  "worker": "worker.js",          // OPTIONAL headless entry (see §4)
  "description": "…",             // one-line tagline; shown in the card + listing
  "window": { "width": 500, "height": 680 },

  // ── Marketplace listing (all OPTIONAL; see §2.1). These travel WITH the
  //    bundle, so a published app is self-describing — no separate metadata
  //    step, and nothing extra to train a generator on.
  "version": "1.0.0",             // semver; the publisher bumps on update
  "icon": "📇",                   // an emoji, or a bundled image path ("icon.png")
  "category": "productivity",     // one marketplace category (see §2.1)
  "keywords": ["crm", "reminders"], // free-text search terms
  "about": "A personal CRM that nudges you to keep in touch.", // longer listing copy (markdown string, or a bundled .md path)

  // Host capabilities this app is allowed to use. The host enforces this list
  // PER-APP: an app can only ever reach a capability it declared here. See §5.
  "capabilities": ["db.exec", "cron.schedule", "notify.send", "connector.call"],
- `web.read {url}` — host-mediated readability fetch (clean text; public http(s) only, 12s, size-capped). `web.fetch {url}` — raw variant. SSRF-guarded; declare in `capabilities`.

  // Connections this app integrates (Pipedream app slugs) — OPTIONAL. The
  // connector.* capabilities are scoped to exactly this list. Connections are
  // user-level: the user connects Salesforce ONCE in Glyphh and every app
  // that declared it can use it. Apps never see tokens. See §5.
  "connectors": ["salesforce", "netsuite"],

  // MCP tools this app exposes to the relay (optional). Each is backed by
  // EXACTLY ONE of:
  //   capability — 1:1 passthrough to a host capability (v1 style)
  //   handler    — a named handler in the app's worker (v2; requires `worker`)
  "tools": [
    {
      "name": "due_today",
      "description": "People due for a check-in right now.",
      "handler": "due_today",
      "inputSchema": { "type": "object", "properties": {} }
    }
  ]
}
```

Rules:
- `slug` is unique per user. Re-install updates in place.
- A tool declares `capability` **xor** `handler` — exactly one. Tools with
  neither/both are dropped at parse; a `handler` tool without a manifest
  `worker` fails install.
- Every `tools[].capability` MUST appear in `capabilities`. Install rejects a
  tool whose capability wasn't declared.
- An app declaring an unknown capability fails to install.
- Declaring any `connector.*` capability requires a non-empty `connectors`
  list. An app may declare any number of connectors — multi-connection
  integration apps (Salesforce → NetSuite sync) are a first-class shape.
- `inputSchema` is a JSON Schema object. It's what the LLM sees and what the
  host validates args against before running. For capability tools the args
  pass through 1:1; for handler tools the args arrive as the handler's argument.

---

## 2.1 Marketplace listing (the publishable envelope)

A Glyphh app is meant to be **distributable** — hosted, shared, and one day listed in a
marketplace. To make that frictionless, **all descriptive listing data lives in the
manifest and travels with the bundle**: a generated app is self-describing and
publish-ready, so nothing extra needs to be authored — or trained into a generator — to
list it.

**Bundle-carried (in `manifest.json`) — everything *intrinsic* to the app:**

| field | listing role |
|-------|--------------|
| `name` | title |
| `description` | one-line tagline (card subtitle) |
| `about` | long description / readme (markdown string, or a bundled `.md` path) |
| `version` | semver, shown on the listing; the publisher bumps on update |
| `icon` | emoji (zero-asset default) or a bundled image path |
| `category` | one of: `productivity`, `communication`, `developer`, `data`, `crm`, `finance`, `personal`, `fun`, `other` |
| `keywords` | search terms |
| `capabilities` / `connectors` / `tools` | already declared — auto-populate the listing's "what it does / what it connects" sections |

**Publish-time envelope — everything *extrinsic*, added by the marketplace, NEVER in the
bundle:**

- **Publisher / author** — bound to the authenticated publishing user/org at publish time.
  (Never trust a bundle to name its own author.)
- **Pricing** — free / paid + price; a publisher decision, set at publish.
- **License** — SPDX id; the publisher confirms (a generator may *suggest* one).
- **Screenshots / preview** — real image assets: **auto-captured by Glyphh at publish** (it
  runs the app in a window — screenshot the entry) or author-provided. Not generated.
- **Trust & popularity** — verification / signing status, install count, ratings, reviews:
  server-assigned or server-derived.

**Design principle:** the **bundle carries what the app *is*** (a generator's job); the
**marketplace layers who publishes it, what it costs, and whether it's trusted** (a human +
server job) at publish. The marketplace record = `manifest` + this envelope.

---

## 3. Three faces: UI, worker, tools

An app has three independent surfaces. It can ship any combination (UI is the
install anchor and always required).

- **UI** (`entry`) — a window the *user* opens (Apps page, `.dip`, command
  overlay). The UI talks to the host through `window.glyphh.call(method, args)`,
  where `method` is a declared capability. This is the human path.

  The host publishes shared UI libraries to `~/.glyphh/custom-apps/_libs/`
  (refreshed each startup, versioned with Glyphh), so apps get rich
  visualization without vendoring or the network:

  ```html
  <script src="../_libs/chart.js"></script>  <!-- window.Chart   (Chart.js 4) -->
  <script src="../_libs/three.js"></script>  <!-- window.THREE   (three.js)   -->
  <script src="../_libs/flow.js"></script>   <!-- window.GlyphhFlow (React Flow) -->
  ```

  `GlyphhFlow.renderFlow(el, { nodes, edges, onChange, minimap })` is a
  vanilla facade over React Flow — node/edge canvases with drag, connect,
  and pan/zoom, no React knowledge required (`GlyphhFlow.React` /
  `GlyphhFlow.ReactFlow` are exported for custom node types). Slugs starting
  with `_` are reserved for host dirs like `_libs`.

- **Worker** (`worker`) — the app's own logic running **headless** in a hidden,
  sandboxed window (no Node, no DOM anyone sees, strict CSP — no network, no
  eval). It registers named handlers; the host invokes them for tool calls and
  cron firings. This is what makes a Glyphh app a *real app* rather than a
  form over one capability. See §4.

- **Tools** (`tools[]`) — MCP tools the *LLM* discovers and calls through the
  relay, headless (no window needs to be open). This is the agent path.

All three run through the same per-app capability allowlist.

---

## 4. The worker (headless app logic)

The worker script runs in an isolated context with exactly this SDK:

```js
// register a named handler — invoked for tool calls and cron firings
glyphh.handle("due_today", async (args) => {
  const res = await glyphh.call("db.exec", { sql: "SELECT …" });
  if (!res.ok) throw new Error(res.error);
  return res.result.rows;          // ← becomes the tool result
});

// same capability bridge the UI gets
await glyphh.call(method, args);   // → { ok, result } | { ok:false, error }

glyphh.app.slug                    // the app's own slug (informational)
```

Lifecycle:
- **Lazy start** — the worker starts on its first invoke (tool call or cron
  firing) and stays up. It also warm-starts right after install so it can
  register its schedules immediately.
- **Top-level code runs before any invoke** — register all handlers
  synchronously at the top level; do async setup in an IIFE.
- **Crash = restart on next invoke.** Keep workers stateless; state belongs in
  `db.exec`.
- **Reinstall restarts the worker** on the new code. Cron schedules persist
  across reinstalls and Glyphh restarts (re-register idempotently at startup
  anyway — `cron.schedule` is an upsert).
- Handler invocations time out after 60s.

---

## 5. Capabilities (the host API)

Capabilities are implemented **in Glyphh**, never handed to app code — app code
only ever gets `glyphh.call(name, args)`. The host owns the implementation, the
OS permission prompts, and the security boundary.

### Services (cross-platform)

| capability      | args                                | returns                                  |
|-----------------|-------------------------------------|------------------------------------------|
| `db.exec`       | `{ sql, params? }`                  | `{ rows }` or `{ changes, lastInsertRowid }` |
| `cron.schedule` | `{ id, cron, handler, args? }`      | `{ scheduled: true, id }`                |
| `cron.cancel`   | `{ id }`                            | `{ cancelled }`                          |
| `cron.list`     | `{ }`                               | `[{ id, cron, handler, args? }]`         |
| `notify.send`   | `{ title, body }`                   | `{ shown }`                              |

- **`db.exec`** — the app's own SQLite database at
  `~/.glyphh/app-data/<slug>/data.sqlite` (WAL). One statement per call; `params`
  is an array (`?` placeholders) or an object (named). `SELECT`s return
  `{ rows }`; writes return `{ changes, lastInsertRowid }`.
  `ATTACH`/`DETACH`/`PRAGMA`/`VACUUM` are host-only. There is **no cross-app
  data surface** — an app can never name another app's database.
- **`cron.schedule`** — persisted (survives restarts) upsert keyed by `id`
  (per-app); fires the worker `handler` with `args`. Standard 5-field cron
  syntax. Max 20 schedules per app. Requires a manifest `worker`.
- **`notify.send`** — OS notification; clicking it opens the app's UI.

### AI & data services (cross-platform, on-device unless noted)

| capability         | args                                      | returns                          |
|--------------------|-------------------------------------------|----------------------------------|
| `llm.embed`        | `{ text \| texts, model? }`               | `{ model, dim, vectors }`        |
| `llm.chunk`        | `{ text, maxChars?, overlap? }`           | `{ chunks }`                     |
| `llm.complete`     | `{ prompt, system?, provider?, model? }`  | `{ text, usage? }`               |
| `agent.run`        | `{ prompt, system?, provider?, model?, tools?, maxTurns? }` | `{ text, turns, toolCalls, usage? }` |
| `vector.upsert`    | `{ collection, items, model? }`           | `{ upserted, collection }`       |
| `vector.search`    | `{ collection, query \| vector, k?, filter? }` | `{ matches: [{ id, score, text?, metadata? }] }` |
| `vector.delete`    | `{ collection, id? }`                     | `{ deleted }`                    |
| `graph.cypher`     | `{ query, params? }`                      | `{ rows }`                       |
| `secrets.get`      | `{ key }`                                 | `{ value }`                      |
| `secrets.list`     | `{ }`                                     | `[{ key, readable }]`            |

**LLM auth model — Glyphh has NO LLM, NO BYOK, NO agent of its own.**
Installed apps are the only agentic surface, and every model call runs on a
key that belongs to the app: the user sets `<PROVIDER>_API_KEY` on that
app's **Config Vars** tab (encrypted, write-only — see below) and the host
injects it per call. There is no global key store and Glyphh-level code
never calls a model.

- **`llm.complete`** — one-shot completion (no tools). Providers:
  `"anthropic"` (default) / `"openai"` / `"google"` via the official vendor
  SDKs (`@anthropic-ai/sdk`, `openai` Responses API, `@google/genai`).
- **`agent.run`** — a real agentic loop: the model gets the **app's own
  manifest tools** and drives them, multi-turn (default 6, max 12 turns; 32
  tool calls max). Every tool call re-validates against the app's declared
  tools. Same three providers.
  - A manifest tool may not itself be backed by `agent.run` (no recursion) —
    install rejects it.
  - **Key pickup:** the host reads the app's config var named
    `<PROVIDER>_API_KEY` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
    `GOOGLE_API_KEY`) — an agentic app needs zero key-handling code; it just
    documents which var to set. Missing key → a clear error naming the var.

### Config vars (per-app secrets)

Users set `KEY=value` pairs on the app's **Config Vars** tab (app → edit).
The value is **encrypted in the main process before it leaves the machine**
via Electron safeStorage — macOS Keychain on Mac, DPAPI on Windows (both
built-in, zero setup; encryption is bound to the OS user account) — and
stored on the server inside the app row. The server only ever sees
ciphertext, and the UI can never display a value again after creation (key
names + set-dates only; rotation is delete + re-add). Keys are env-var style
(`[A-Z0-9_]`, one line); values are blobs up to 32 KB. Config vars survive
app updates.

Apps read their own vars — and only their own — via the `secrets.get`
capability (declared in the manifest like any other):

```js
const { value } = await call("secrets.get", { key: "OPENAI_API_KEY" });
```

`secrets.list` returns key names plus `readable` (safeStorage is
machine-bound, so a var set on another machine exists but won't decrypt — the
user re-enters it here; apps should surface that state, not crash). This is
how an app *requires* keys from its user: declare `secrets.get`, document the
keys it expects, and gate features on their presence.

- **`llm.embed`** — local embeddings (ONNX via transformers.js; default model
  `Xenova/all-MiniLM-L6-v2`, 384-dim). The model downloads once to
  `~/.glyphh/models` on first use — expect the first call to take longer. Batch up
  to 64 texts. Fully on-device.
- **`vector.*`** — per-app vector store (`~/.glyphh/app-data/<slug>/vectors.sqlite`).
  `items: [{ id, text?, vector?, metadata? }]` — text is embedded
  automatically with the collection's model (pinned at creation). Search is
  exact cosine (normalized dot product); `filter` is exact-match on metadata
  keys. Typical pipeline: `llm.chunk` → `vector.upsert { items }` →
  `vector.search { query }`.
- **`graph.cypher`** — a real knowledge graph: each app gets its own embedded
  **Kuzu** database (`~/.glyphh/app-data/<slug>/graph.kuzu`) speaking full Cypher —
  property graphs, MATCH patterns, variable-length paths (`-[:Owns*1..3]->`),
  shortest path, aggregations. Kuzu is schema-full; the app's first calls are
  DDL:
  ```
  graph.cypher { query: "CREATE NODE TABLE Account (name STRING, arr DOUBLE, PRIMARY KEY (name))" }
  graph.cypher { query: "CREATE REL TABLE Owns (FROM Account TO Account)" }
  graph.cypher { query: "MATCH (a:Account)-[:Owns*1..2]->(b) WHERE a.arr > $t RETURN b.name",
                 params: { t: 100000 } }
  ```
  `params` are Cypher `$`-parameters (prepared). Multi-statement strings run
  in order; the last statement's rows come back.

### Connections (the 3500-connector catalog)

| capability         | args                             | returns                                        |
|--------------------|----------------------------------|------------------------------------------------|
| `connector.status` | `{ }`                            | `[{ connector, connected, healthy }]`          |
| `connector.tools`  | `{ connector? }`                 | `[{ connector, name, description, inputSchema }]` |
| `connector.call`   | `{ connector, tool, args? }`     | `{ result }` (text)                            |

All three are scoped to the manifest's `connectors` list — an app can never
reach a connection it didn't declare, even if the user has it connected.
Auth is user-level and host-owned (Pipedream via yo-server): the app calls
tools by name; it never touches tokens, and connecting/disconnecting accounts
happens in Glyphh, not in apps.

- **`connector.status`** — what the app should render before doing work: for
  each declared connector, whether the user has connected an account. A
  well-behaved app shows a "Connect Salesforce in Glyphh" state instead of
  failing.
- **`connector.tools`** — the live tool catalog for the app's connectors
  (tools only appear for connected accounts).
- **`connector.call`** — invoke one tool. Calls to unconnected connectors fail
  with a clear error.

#### Finding connectors and their tools (for LLM authors)

The catalog is **Pipedream's app directory** — ~3,500 connectable apps.
`connectors` entries in the manifest are Pipedream app slugs:

- Browse apps + slugs: https://pipedream.com/apps (the slug is the URL path
  segment, e.g. `salesforce_rest_api`, `netsuite`, `slack`, `google_sheets`,
  `hubspot`, `stripe`).
- Tool names/args per app: https://mcp.pipedream.com — each app's MCP tool
  list is what `connector.call` invokes.

Static docs drift, so treat them as orientation and the live surface as
truth: at build time call the relay's `connector_list_tools` to see the
user's actual connected apps and tool schemas; inside the app, call
`connector.tools` (declared connectors only — tools appear once the user
connects the account) and gate UI on `connector.status`. If you're unsure of
a slug, resolve it against `connector.status` output before shipping the
manifest.

The canonical multi-connection pattern — a cron-driven pipeline (e.g.
Salesforce → NetSuite daily sync with churn scoring) — is a worker handler:

```js
glyphh.handle("nightly_sync", async () => {
  const sfdc = await call("connector.call", { connector: "salesforce",
    tool: "run-soql-query", args: { query: "SELECT …" } });
  // …transform, join against local state…
  await call("db.exec", { sql: "INSERT INTO accounts_snapshot …", params: […] });
  await call("connector.call", { connector: "netsuite", tool: "upsert-record", args: { … } });
  const risky = await call("db.exec", { sql: "SELECT name FROM churn_risk_view" });
  if (risky.rows.length) await call("notify.send", { title: "Churn risk",
    body: `${risky.rows.length} accounts need attention` });
});
// registered once: cron.schedule { id:"nightly", cron:"0 6 * * *", handler:"nightly_sync" }
```

### Machine capabilities (macOS; Windows backends are follow-on)

| capability          | args                         | returns                              |
|---------------------|------------------------------|--------------------------------------|
| `messages.send`     | `{ to, body }`               | `{ sent: true }`                     |
| `contacts.search`   | `{ query }`                  | `[{ name, value }]` (phone/email)    |

New capabilities are added to the host (not by apps) and documented here.

---

## 6. Discovery, invocation, deploy (the relay surface)

Everything an external LLM does goes through the user's single relay endpoint
(`https://api.glyphh.ai/mcp`, OAuth or token authed). Three generic MCP tools —
mirroring the existing `connector_list_tools` / `connector_call_tool` shape —
make **every installed app's tools discoverable and callable** without the
server registering per-user tools:

- **`app_list_tools`** → returns every installed app and its declared tools:
  `[{ app: slug, name, tools: [{ name, description, inputSchema }] }]`. This is
  how a consumer discovers what a specific user's Glyphh can do.

- **`app_call_tool { app, tool, args }`** → runs `<app>`'s `<tool>` headlessly
  on the user's machine and returns its result — a capability passthrough for
  capability tools, a worker-handler invocation for handler tools.

- **`app_install { name?, bundleBase64 }`** → installs a `.glyphh` bundle for the
  user (create/update the saved app + register its tools + warm-start its
  worker). This is how Claude **deploys** an app it built, so it can
  immediately use the app's tools.

Under the hood each forwards to the user's live yo-client over the relay
WebSocket (`apps.listTools` / `apps.callTool` / `apps.install`), through the
same online check every relay tool uses.

### Orchestration loop

```
1. app_list_tools                     → discover what this user can do
2. app_install { bundleBase64 }       → (optional) deploy a new app Claude built
3. app_call_tool { app, tool, args }  → run it; use the result in the next step
```

A Claude skill (in Cowork or Claude Code) chains these: discover → deploy →
orchestrate. Because discovery is dynamic and per-user, a skill written once
adapts to whatever apps a given user has installed.

---

## 7. Security model

- **Per-app capability allowlist.** The host grants a window / worker / tool
  exactly the capabilities its manifest declared — nothing else is reachable,
  even if the app's code asks. Enforced in the main process, not the sandbox.
- **Host-owned implementations.** Apps never get AppleScript, shell, file, or
  raw database-engine access. They get capability calls the host implements
  and can rate-limit, prompt for, or revoke.
- **Per-app isolation.** Data services are slug-scoped: your database, your
  schedules. No capability takes a path, a slug, or any cross-app reference.
- **Connections are user-level, access is app-scoped.** Accounts (OAuth) live
  in Glyphh and are shared across apps; each app reaches only the connectors
  its manifest declared, and never sees credentials.
- **Workers are sandboxed web content.** No Node, strict CSP (same-bundle
  scripts only, no network, no eval). Apps ship interpreted JS only — never
  native binaries. This is also what keeps marketplace distribution clean on
  macOS/Windows (Developer ID + notarization; direct distribution, not the
  Mac App Store).
- **OS permissions still apply.** `messages.send` still triggers macOS's
  Automation prompt for Messages the first time — the host doesn't bypass the OS.

---

## 8. Building an app

1. Author `manifest.json` + `index.html` (+ `worker.js`) under `apps/<name>/`.
2. `npm run pack:apps` → `dist-apps/<name>.glyphh`.
3. Install: Apps page → Import, **or** `app_install { bundleBase64 }` over MCP.

The **`build-glyphh-app` skill** (`skills/build-glyphh-app/`) walks an LLM
through authoring a spec-conformant app end to end.

**`apps/keep-in-touch/`** is the canonical v2 example — a personal CRM using
every surface: per-app SQLite, a daily cron nudge that raises a notification,
Contacts autocomplete, Messages send, and five handler-backed MCP tools
(`add_person`, `list_people`, `due_today`, `log_touch`, `send_checkin`).
**`apps/messages/`** remains the canonical v1 (capability-passthrough) example.

---

## 9. Versioning & compatibility

- `manifestVersion` gates the contract. This doc is v2; v1 bundles install and
  run unchanged.
- Unknown manifest fields are ignored (forward-compatible).
- A host that doesn't recognize a declared capability refuses to install the
  app rather than silently dropping it — better a clear failure than a partial
  install.
