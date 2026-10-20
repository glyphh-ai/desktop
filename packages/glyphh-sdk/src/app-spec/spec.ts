/**
 * app-spec/spec.ts — the build spec handed to whatever is BUILDING a Glyphh
 * app: the desktop's own agent, Claude Code, a CI job, anything speaking the
 * SDK. One authoritative text, so every builder reads the same contract the
 * validator (validate.ts), the builder and the app server enforce.
 */

export const GLYPHH_APP_SPEC = `## Building a Glyphh app

A Glyphh app is a Next.js project (static export) plus a manifest and an
optional server-side worker. It is built into a bundle, deployed as a
versioned release, served by the Glyphh app server, and its TOOLS land in the
agent's toolbox (app_list_tools / app_call_tool). The app stores and finds; the
AGENT thinks — there is no model call inside an app.

### Project layout (the folder you build in)
- manifest.json     — the app contract (below)
- package.json      — next + react + react-dom; scripts.build = "next build"
- next.config.mjs   — EXACTLY this shape:
    const base = process.env.GLYPHH_APP_BASE ?? "";
    export default {
      output: "export", trailingSlash: true,
      basePath: base, assetPrefix: base || ".",
      images: { unoptimized: true },
    };
  (the builder sets GLYPHH_APP_BASE to the instance's /app-host/<key>/ui; a
  bundle built with no base loads its assets relative to ui/, root page only)
- app/              — the Next.js app router (app/layout.js + app/page.js); pages/ also works
- worker.js         — OPTIONAL server-side logic: handlers behind the manifest's tools and cron

Do NOT author an "entry": the export's index.html is always the entry. Do not
ship node_modules, .next or out — the builder makes them. Start from the SDK
template (appTemplateFiles(), sdk/templates/app-next).

### manifest.json
STRICT JSON. REQUIRED: "manifestVersion": 3, "kind": "glyphh-app", "name",
"slug" (lowercase [a-z0-9_-], no leading underscore), "description".
Optional: "capabilities": [...], "connectors": [...] (connection slugs such as
"gmail", "google_calendar", "slack"), "tools": [...], "worker": "worker.js",
"window": { "width", "height" }.
Each tool: { "name", "description", "handler" XOR "capability", "inputSchema" }.
Exactly one of handler|capability per tool. A handler needs the worker. Every
capability a tool names must be in the top-level capabilities list;
connector.* capabilities need a non-empty connectors list; NEVER expose
agent.run as a tool.

### The worker (worker.js)
Sandboxed: NO fetch / require / import / process / network / node. Its whole
world is the glyphh object:
- glyphh.handle("name", async (args) => result) — register a tool or cron
  handler, synchronously at the top level (10 s to be ready).
- await glyphh.call(capability, args) → { ok: true, result } | { ok: false, error }.
  It never throws for a capability error — check ok.
- glyphh.app.slug; console.log/warn/error (to the app server's log);
  setTimeout/clearTimeout. A handler has 60 s.
Keep it stateless: state lives in the database.

### Capabilities (declare each one in manifest capabilities)
- db.exec { sql, params? } — POSTGRES SQL in the app's own schema. $1, $2
  params; ONE statement per call; unqualified table names; create tables on
  first use with CREATE TABLE IF NOT EXISTS (SERIAL / jsonb / timestamptz /
  text). Returns { rows } for a query, { rowCount } otherwise. Refused:
  CREATE/ALTER/DROP SCHEMA, SET search_path, multiple statements.
- vector.upsert { collection, items: [{ id, text, metadata? }] },
  vector.search { collection, query, k?, filter? } → { matches: [{ id, text,
  metadata, score }] }, vector.delete { collection, ids } — pgvector underneath,
  embedded with the org's embedding model.
- graph.cypher { query, params? } — NEO4J Cypher over a property graph:
  CREATE (n:Person {name: $name}), MATCH (a:Person)-[:KNOWS*1..2]->(b) RETURN b,
  MERGE, variable-length paths. No Kuzu DDL (no CREATE NODE TABLE). Labels and
  relationship types are the app's own; the server prefixes them per instance.
  Returns { rows }.
- connector.status {} → [{ connector, connected, healthy }];
  connector.tools { connector? } → [{ connector, name, description, inputSchema }];
  connector.call { connector, tool, args } → the connected account's answer.
  Scoped to the manifest's connectors. Gate the UI on connector.status and say
  "Connect X in Glyphh" instead of failing.
- cron.schedule { id, cron, handler, args? } (5-field cron, an upsert — re-register
  on every worker start), cron.cancel { id }, cron.list {}. Firings run as the
  instance's owner. At most 20 per instance.
- notify.send { title, body } — a notification to the member.
- secrets.get { key }, secrets.list {} — config vars the member sets on the app.
- library.list/get/put/remove { kind, … } and library.fileGet/filePut — the
  member library's house kinds (image, video, audio, file, folder, design,
  deck) as the calling member: what Images, Drive, Design and Slides are
  built on. The app that owns a thing exposes the tools for it.
- images.generate { prompt, model?, size?, n? } — an image from the gateway
  as the member, base64 back; the Images app's generate_image files it.
- app.call { app, tool, args } — another installed app's tool, through the
  framework (never your own handlers: call those functions directly).
There is no llm.*, agent.run, contacts.search or messages.send: the agent
writes, summarizes and classifies, then calls your tools with the result;
people are reached through connectors (gmail, slack, …).

### The UI
The page reaches the host ONLY through the injected shim:
window.glyphh.call(capability, args) → { ok, result } | { ok: false, error }
(the same capabilities, as the signed-in member; "ping" answers { pong: true }).
The UI and the worker share the DATABASE, not business logic: the UI reads and
writes with db.exec; the worker's handlers back the agent's tools. Call the
shim from client components ("use client") in effects and handlers, never
during render. No remote <script>/<link>/CDN — everything is bundled at build
time; no fetch to other origins.

### Build → deploy
1. npm install && npm run build — Next.js exports out/.
2. Build and run with app_install { dir, kind?, note? } — THE ONE DOOR, BY PATH:
   dir is the app's folder (default: the session's folder). The runtime tars
   the source itself; the platform builds it as a JOB (npm ci, next build with
   the instance's base path, worker.js bundled with esbuild and linted), zips it
   as manifest.json + ui/ + worker.js, and records it as the next release n,
   pinned. The answer carries { key, mode, release (null while the job still
   builds), job, log tail, tools, url }; app_build_status { job } reads a job.
   NEVER tar, zip or base64 a folder yourself and never paste a bundle into a
   tool call. app_releases { app } lists releases; app_pin { app, n } rolls back.
   Start with glyphh_app_scaffold { name, slug?, connections?, tools? }: it
   writes this starter into the folder with the member's real connected-account
   tool names, and answers this spec.
Re-deploy after any change, or the instance runs the old release. Never ship
through a login or device-auth flow — the session is already authenticated.

### Version control
Initialize git before building (.gitignore: node_modules/, .next/, out/, .env).
Commit in small steps after green builds; never commit node_modules, .next or out.`;
