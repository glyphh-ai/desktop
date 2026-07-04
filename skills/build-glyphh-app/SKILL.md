---
name: build-glyphh-app
description: Author a Glyphh app — a portable .glyphh bundle with a UI window, an optional headless worker (per-app SQLite, cron schedules, notifications), and/or MCP tools that surface on the user's Glyphh relay so any LLM can orchestrate them. Use when a developer or user wants to build, package, or deploy a Glyphh app (e.g. "make a Glyphh app that…", "build an app that tracks X and reminds me", "expose Y as a tool for my Glyphh"), or to expose a machine capability as an MCP tool for the user's Glyphh.
---

# Build a Glyphh App

A **Glyphh app** is a `.glyphh` bundle (a zip: `manifest.json` + `index.html` +
optional `worker.js` + assets) that installs like any other app AND can expose
**MCP tools** the user's LLM tools (Claude Desktop, Cowork, Cursor) discover and
call through the Glyphh relay. Full contract: `docs/GLYPHH-APP-SPEC.md` (v2).

## When to use

- The user wants a small UI to do a machine task (send a text, create an event).
- The user wants a **real app**: its own local database, scheduled background
  work, notifications — a habit tracker, a personal CRM, a watcher.
- The user wants any of that exposed as MCP **tools** so Claude can orchestrate
  it (`app_call_tool`), not just click it.

## What you can build on

Apps never touch the OS or a database engine directly. They call **host
capabilities** the host implements and gates per-app. Only declared
capabilities are reachable.

Services (cross-platform):

| capability      | args                           | returns                                      |
|-----------------|--------------------------------|----------------------------------------------|
| `db.exec`       | `{ sql, params? }`             | `{ rows }` or `{ changes, lastInsertRowid }` |
| `cron.schedule` | `{ id, cron, handler, args? }` | `{ scheduled, id }` (persisted upsert)       |
| `cron.cancel`   | `{ id }`                       | `{ cancelled }`                              |
| `cron.list`     | `{ }`                          | `[{ id, cron, handler }]`                    |
| `notify.send`   | `{ title, body }`              | `{ shown }` (click opens the app)            |

AI & data services. Glyphh itself has NO LLM, NO key store, NO agent — apps
are the only agentic surface, and every model call runs on the APP's key:
the user sets `<PROVIDER>_API_KEY` on the app's Config Vars tab and the host
injects it (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY`):

| capability | args | notes |
|---|---|---|
| `llm.embed` | `{ text \| texts, model? }` | local ONNX embeddings, 384-dim default, fully on-device |
| `llm.chunk` | `{ text, maxChars?, overlap? }` | prep text for embedding |
| `llm.complete` | `{ prompt, system?, provider?, model? }` | one-shot; providers anthropic (default) / openai / google, key from config vars |
| `agent.run` | `{ prompt, system?, provider?, tools?, maxTurns? }` | agentic loop over the APP'S OWN manifest tools; same providers/keys |
| `vector.upsert/search/delete` | `{ collection, … }` | per-app store; text auto-embeds; exact cosine + metadata filter |
| `graph.cypher` | `{ query, params? }` | per-app embedded Kuzu graph — real Cypher; schema-full (CREATE NODE/REL TABLE first) |
| `secrets.get` / `secrets.list` | `{ key }` / `{ }` | per-app config vars the USER sets on the app's Config Vars tab — encrypted, write-once, machine-bound. How an app requires keys: agent.run/llm.complete read `<PROVIDER>_API_KEY` automatically. Check `secrets.list` and render a "set ANTHROPIC_API_KEY in Config Vars" state when missing. |

RAG-in-an-app is: `llm.chunk` → `vector.upsert` → `vector.search { query, k }`
→ `llm.complete` with the top chunks in the prompt. An agentic app is:
declare good tools, then `agent.run { prompt: goal }` — the model drives the
app's own tools (never expose agent.run itself as a tool; install rejects it).

Connections (scoped to the manifest's `connectors` list — see below):

| capability         | args                         | returns                                        |
|--------------------|------------------------------|------------------------------------------------|
| `connector.status` | `{ }`                        | `[{ connector, connected, healthy }]`          |
| `connector.tools`  | `{ connector? }`             | `[{ connector, name, description, inputSchema }]` |
| `connector.call`   | `{ connector, tool, args? }` | `{ result }` (text)                            |

Machine capabilities (macOS): `contacts.search { query }`,
`messages.send { to, body }`.

`db.exec` is the app's OWN SQLite file (`~/yo/app-data/<slug>/data.sqlite`) —
one statement per call, `?` params. No ATTACH/PRAGMA/VACUUM. No cross-app data.

If the app needs a capability that doesn't exist yet, it must be added to the
host first (`src/main/glyphh-app-host.ts` `runCapability` + `KNOWN_CAPABILITIES`,
services in `src/main/glyphh-app-services.ts`) and documented in the spec —
apps can't invent capabilities.

## The three surfaces

1. **UI** (`entry: index.html`) — window the user opens. Talks to the host via
   `window.glyphh.call("<capability>", args)` → `{ ok, result } | { ok:false, error }`.
   Self-contained (inline CSS/JS), no external network unless needed.
   For rich visuals, host-provided libraries are available via relative
   script tags (no vendoring, no CDN):
   `<script src="../_libs/chart.js"></script>` → `window.Chart` (Chart.js 4);
   `../_libs/three.js` → `window.THREE`; `../_libs/flow.js` →
   `window.GlyphhFlow` — `GlyphhFlow.renderFlow(el, { nodes, edges, onChange })`
   gives a drag/connect/zoom node-canvas (React Flow) with zero React code.
2. **Worker** (`worker: worker.js`) — headless app logic in a sandboxed hidden
   context (no Node, no network, 60s per invoke). Registers handlers:
   `glyphh.handle("name", async (args) => result)`. Handlers back MCP tools and
   cron firings. Register handlers synchronously at top level; async setup in
   an IIFE. Keep it stateless — state lives in `db.exec`.
3. **Tools** (`tools[]`) — each backed by exactly ONE of `capability`
   (1:1 passthrough) or `handler` (runs in the worker; requires `worker`).
   Write `description` + `inputSchema` for an LLM deciding whether to call it.

## Steps

1. **Scaffold** under `apps/<name>/`: `manifest.json` with
   `manifestVersion: 2`, `kind: "glyphh-app"`, `name`, `slug` (`[a-z0-9_-]`),
   `entry`, optional `worker`, `capabilities`, optional `connectors`, `tools`,
   `window`. Every `tools[].capability` MUST be in `capabilities`;
   `tools[].handler` requires `worker`; any `connector.*` capability requires a
   non-empty `connectors` list (Pipedream app slugs, e.g.
   `["salesforce", "netsuite"]` — declare ALL the connections the app
   integrates; multi-connection pipeline apps are a first-class shape).
   Connections are user-level: the user connects each account once in Glyphh;
   the app is self-contained and never sees tokens. Have the UI check
   `connector.status` and render a "Connect X in Glyphh" state rather than
   failing on unconnected accounts.
   **Finding slugs/tools**: the catalog is Pipedream's app directory
   (~3,500 apps) — browse https://pipedream.com/apps for slugs and
   https://mcp.pipedream.com for each app's MCP tools. Docs drift; the live
   truth is the relay's `connector_list_tools` (what THIS user has connected,
   with exact tool schemas) and `connector.tools` inside the app. Verify a
   slug against `connector.status` before shipping the manifest.
2. **Worker pattern** (if the app has logic/schedules):
   ```js
   async function call(m, a) { const r = await glyphh.call(m, a); if (!r.ok) throw new Error(r.error); return r.result; }
   glyphh.handle("my_tool", async (args) => { /* db.exec, messages.send, … */ });
   glyphh.handle("tick", async () => { /* cron target: query, notify.send */ });
   (async () => {           // idempotent setup on every worker start
     await call("db.exec", { sql: "CREATE TABLE IF NOT EXISTS …" });
     await call("cron.schedule", { id: "tick", cron: "0 9 * * *", handler: "tick" });
   })();
   ```
   Schema creation must be idempotent and run from BOTH worker and UI (either
   may start first).
3. **Package**: `npm run pack:apps` → `dist-apps/<name>.glyphh`.
4. **Install / deploy**:
   - Locally: Apps page → Import → pick the `.glyphh`.
   - Remotely (Claude deploying for a user over MCP): base64 the bundle and call
     the `app_install` relay tool with `{ bundleBase64 }`. Install warm-starts
     the worker, so its cron schedules arm immediately.
5. **Verify**: `app_list_tools` shows the app + tools; `app_call_tool
   { app, tool, args }` runs them headlessly.

## Reference apps

- **`apps/keep-in-touch/`** — canonical v2: personal CRM. Per-app SQLite,
  daily cron → notification, Contacts autocomplete, Messages send, five
  handler-backed tools. Copy its shape for any "track things + remind me" app.
- **`apps/messages/`** — canonical v1: thin UI + capability-passthrough tool.

## Guardrails

- Keep `slug` stable — it's the `.dip` key, the tool namespace, and the data
  directory; re-install updates in place (data and schedules survive).
- Don't request capabilities the app doesn't use — the manifest is the security
  contract users read before installing.
- UI and tools should share logic by sharing the DATABASE, not by duplicating
  business rules in two scripts; keep derived state in SQL views/queries.
- Cron: re-register on every worker start (it's an upsert). Use handler names
  that read as verbs; cap runtime well under the 60s invoke timeout.
