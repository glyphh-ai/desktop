---
name: build-glyphh-app
description: Author a Glyphh app, a Next.js static-export project with a manifest, a server-side worker (Postgres, pgvector, Neo4j, connectors, cron, notifications) and tools that land in the agent's toolbox, then install it as a versioned release with app_install { dir }. Use when a developer or user wants to build, change, deploy or roll back a Glyphh app (e.g. "make a Glyphh app that…", "build an app that tracks X and reminds me", "expose Y as a tool for my Glyphh").
---

# Build a Glyphh App

A **Glyphh app** is a Next.js project (static export) plus `manifest.json` and
an optional `worker.js`. It is built into a bundle (`manifest.json` + `ui/` +
`worker.js`), deployed as a **release** to the Glyphh app server, rendered as a
panel on the web and the desktop, and its **tools** show up in
`app_list_tools` / `app_call_tool` for the agent. The authoritative contract is
the SDK's `GLYPHH_APP_SPEC` (`@glyphh/sdk`); the validators are
`validateAppProject` (the folder) and `validateAppBundle` (the built bundle).

## What an app is for

**The app stores and finds; the AGENT thinks.** There is no model call inside
an app (`llm.*` and `agent.run` are gone). An app that needs something
written, summarized or classified declares tools for the parts only the server
can do (store it, find it, schedule it, send it) and the agent does the thinking,
then calls those tools with the result. Daily Brief is the pattern:
`collect_brief` pulls the raw material through connectors and stores it,
`save_brief` files what the agent wrote, `get_brief` and `search_brief` read it
back.

## Project layout

```
manifest.json     the contract (below)
package.json      next + react + react-dom; scripts.build = "next build"
next.config.mjs   EXACTLY: output 'export', trailingSlash true,
                  basePath from GLYPHH_APP_BASE, assetPrefix base || '.',
                  images { unoptimized: true }
app/              the Next.js app router (layout.js + page.js); pages/ also works
worker.js         optional: handlers behind the tools and cron
```

Start from the SDK template: `appTemplateFiles()` (or `sdk/templates/app-next`)
gives every file above with a one-page UI that lists the app's tools and
shares a table with the worker. Never author an `entry`; the export's
`index.html` is the entry. Never ship `node_modules`, `.next` or `out`.

### manifest.json

```json
{
  "manifestVersion": 3,
  "kind": "glyphh-app",
  "name": "Recall",
  "slug": "recall",
  "description": "Ask questions over your notes.",
  "capabilities": ["db.exec", "vector.upsert", "vector.search"],
  "connectors": [],
  "worker": "worker.js",
  "window": { "width": 720, "height": 560 },
  "tools": [
    { "name": "ingest", "description": "Index a document.", "handler": "ingest",
      "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] } },
    { "name": "ask", "description": "Find the notes that answer a question.", "handler": "ask",
      "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } }, "required": ["q"] } }
  ]
}
```

Rules: `slug` is lowercase `[a-z0-9_-]` and stable (it is the instance key and
the tool namespace). Each tool is backed by EXACTLY ONE of `handler` (a
function in the worker) or `capability` (a 1:1 passthrough). Every capability
the worker or a tool uses MUST be in `capabilities`; any `connector.*`
capability needs a non-empty `connectors` list (connection slugs such as
`gmail`, `google_calendar`, `slack`, `google_contacts`). Never expose
`agent.run` as a tool. Write `description` + `inputSchema` for an LLM deciding
whether to call the tool.

## The worker

`worker.js` runs sandboxed on the app server: no `fetch`, `require`, `import`,
`process`, no network. Its world is the `glyphh` object:

```js
async function call(m, a) { const r = await glyphh.call(m, a); if (!r.ok) throw new Error(r.error); return r.result; }

glyphh.handle("ingest", async ({ text }) => {
  await call("db.exec", { sql: "CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())" });
  const { rows } = await call("db.exec", { sql: "INSERT INTO notes (body) VALUES ($1) RETURNING id", params: [text] });
  await call("vector.upsert", { collection: "notes", items: [{ id: String(rows[0].id), text }] });
  return { id: rows[0].id };
});
glyphh.handle("ask", async ({ q }) => {
  const { matches } = await call("vector.search", { collection: "notes", query: q, k: 6 });
  return { matches };   // the AGENT reads these and answers
});
glyphh.handle("tick", async () => { /* a cron target: query, then notify.send */ });

(async () => {   // idempotent setup on every worker start
  await call("cron.schedule", { id: "tick", cron: "0 9 * * *", handler: "tick" });
})();
```

- `glyphh.handle(name, async (args) => result)`: register synchronously at the
  top level (10 s to be ready). Handlers back tool calls and cron firings and
  have 60 s each.
- `glyphh.call(capability, args)` resolves `{ ok: true, result }` or
  `{ ok: false, error }`; it never throws for a capability error.
- `glyphh.app.slug`, `console.log/warn/error` (the app server's log),
  `setTimeout/clearTimeout`.
- Keep it stateless: state lives in the database.

## Capabilities

| capability | args | notes |
|---|---|---|
| `db.exec` | `{ sql, params? }` | **Postgres**, the app's own schema. `$1, $2` params; ONE statement per call; unqualified table names; `CREATE TABLE IF NOT EXISTS` on first use; `SERIAL`, `TEXT`, `JSONB`, `TIMESTAMPTZ`, `now()`, `ON CONFLICT … DO UPDATE`. Returns `{ rows }` for a query, `{ rowCount }` otherwise. Refused: `CREATE/ALTER/DROP SCHEMA`, `SET search_path`, several statements. Not SQLite: no `?`, no `AUTOINCREMENT`, no `julianday`. |
| `vector.upsert` / `vector.search` / `vector.delete` | `{ collection, items: [{ id, text, metadata? }] }` / `{ collection, query, k?, filter? }` / `{ collection, ids }` | pgvector underneath; text is embedded with the org's embedding model. `search` returns `{ matches: [{ id, text, metadata, score }] }`. |
| `graph.cypher` | `{ query, params? }` | **Neo4j** Cypher over a property graph: `CREATE (n:Person {name: $name})`, `MERGE`, `MATCH (a:Person)-[:KNOWS*1..2]->(b) RETURN b`. No Kuzu DDL (no `CREATE NODE TABLE`). Labels and relationship types are the app's own; the server prefixes them per instance. Returns `{ rows }`. |
| `connector.status` / `connector.tools` / `connector.call` | `{}` / `{ connector? }` / `{ connector, tool, args }` | the member's connected accounts, scoped to the manifest's `connectors`. Gate the UI on `connector.status` and say "Connect X in Glyphh" instead of failing. `connector.tools` is the live truth for tool names. |
| `cron.schedule` / `cron.cancel` / `cron.list` | `{ id, cron, handler, args? }` / `{ id }` / `{}` | 5-field cron, an upsert (re-register on every start), at most 20 per instance; firings run as the instance's owner. |
| `notify.send` | `{ title, body }` | a notification to the member. |
| `secrets.get` / `secrets.list` | `{ key }` / `{}` | config vars the member sets on the app. Document the var name and check `secrets.list`. |
| `app.call` | `{ app, tool, args }` | another installed app's tool, through the framework. Never your own handlers: call those functions directly. |

Retired, refused at runtime: `llm.complete`, `llm.embed`, `llm.chunk`,
`agent.run`, `contacts.search`, `messages.send`, `web.fetch`, `web.read`.
Reach people through connectors (`gmail`, `slack`, `google_contacts`).

## The UI

The page reaches the host ONLY through the injected shim,
`window.glyphh.call(capability, args)` → `{ ok, result } | { ok: false, error }`,
as the signed-in member (`"ping"` answers `{ pong: true }`). Call it from
client components (`"use client"`) in effects and handlers, never during
render. The UI and the worker share the DATABASE, not business logic: the page
reads and writes with `db.exec`; the worker's handlers back the agent's tools.
No remote `<script>`/`<link>`/CDN and no fetch to other origins; everything is
bundled at build time. Build on the house dark tokens (`--bg #1a1a1c`,
`--panel #252528`, `--bg-2 #2e2e32`, `--line #3f3f46`, `--ink #f1f1f1`,
`--muted #c4c4c4`, `--dim #828282`, `--accent #af5fff`; headings JetBrains
Mono, text Geist) so the panel is indistinguishable from the host.

## Steps

1. **Scaffold** in the session's folder from the template; set `name`, `slug`,
   `description`, the capabilities and connectors the app really uses.
   Initialize git (`.gitignore`: `node_modules/`, `.next/`, `out/`, `.env`).
2. **Write the worker**: one handler per tool, Postgres SQL, idempotent schema
   creation on first use, cron registered in the startup IIFE.
3. **Write the page**: list what the worker stores, act through `db.exec` and
   the connectors, gate on `connector.status`.
4. **Build locally**: `npm install && npm run build`. Fix every error.
5. **Build and run**: `app_install { dir, kind?, note? }` — `dir` is the app's
   folder ON THE MACHINE (default: the session's folder). The runtime tars the
   source itself and the platform builds it as a JOB (`npm ci`, `next build`
   with the instance's base path, `worker.js` bundled and linted), records it
   as the next release and pins it. The answer carries `{ key, mode, release,
   job, log tail, tools, url }`; `release` is null while the job still builds —
   `app_build_status { job }` reads it. A failed build answers the log; fix and
   install again (the next release of the same instance). NEVER tar or base64 a
   folder yourself and never paste a bundle into a tool call: the path door is
   the only one that works. Never ship through a login or device-auth flow; the
   session is already authenticated.
6. **Verify**: `app_list_tools` shows the app and its tools; `app_call_tool
   { app, tool, args }` runs one headlessly; the panel renders at
   `/app-host/<key>/ui/`.
7. **Roll back** with `app_pin { app, n }` (`app_releases { app }` lists them).
   A folder that already holds `manifest.json` + its entry (a built bundle)
   goes through the same `app_install { dir }`, zipped as it is; `bundleBase64`
   is only for a small bundle (< 64 KB) handed over from outside.

## Reference apps (the server's defaults, `glyphh/default-apps/`)

- **`daily-brief`**: connectors + Postgres + vectors + cron. `collect_brief`
  stores raw mail and events, the agent writes, `save_brief` files it.
- **`keep-in-touch`**: a personal CRM. Postgres with a due query, a 9am
  cron → `notify.send`, check-ins through the `gmail` connector.
- **`messages`**: one tool over two connectors (`gmail`, `slack`) and a small
  page.

## Guardrails

- Keep `slug` stable: it is the instance key, the tool namespace and the
  schema; a new release keeps the data and the schedules.
- Don't request capabilities the app doesn't use; the manifest is the security
  contract the member reads.
- One statement per `db.exec`; `$n` params, never string-built SQL.
- Cron handlers run as the owner, unattended: keep them well under 60 s and
  make them idempotent.
