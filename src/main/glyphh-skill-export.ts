/**
 * glyphh-skill-export — generate a provider-tailored "skill" file that teaches
 * an external LLM (Claude, Gemini, OpenAI) how to drive the user's Glyphh
 * through the MCP relay: open apps/layouts, run installed apps' tools, call
 * connected accounts, and BUILD + DEPLOY new Glyphh apps.
 *
 * The BODY is the same everywhere (it's the same relay + tools); only the
 * wrapper differs per provider (Claude wants SKILL.md frontmatter; Gemini /
 * OpenAI want a plain system-instruction preamble).
 */

export type SkillProvider = "claude" | "gemini" | "openai";

const ENDPOINT = "https://api.glyphh.ai/mcp";

const BODY = `## What Glyphh is

Glyphh is the user's workspace on their own machine. Over this MCP connection you
drive it: open their apps and saved layouts as native OS windows, run the tools
their installed apps expose, call their 3,500+ connected accounts, and even
**build and deploy brand-new apps** onto their machine. Everything executes
locally — you send commands, Glyphh runs them and returns the result.

## Connect

Add Glyphh's MCP endpoint to your connectors/tools:

    ${ENDPOINT}

Use OAuth if your client supports it (approve the "Glyphh" connection). Otherwise
paste a token generated in Glyphh → Settings → MCP as a Bearer header.

## The tools

**Check the connection**
- \`relay_ping { message? }\` — round-trip smoke test; confirm the user's client is online before relying on other tools.

**Windows & layouts** (open things on the user's screen)
- \`panels_open { app }\` — open "browser", "terminal", or a saved-app slug in its own native window.
- \`panels_list\` — list open app windows (slug, name, url, title, focused).
- \`panels_switch { app }\` / \`panels_close { app }\` — focus / close a window.
- \`layouts_open { name, mode? }\` — open a saved layout. \`mode:"screen"\` tiles the whole display (one OS window per app); \`mode:"window"\` tiles inside one window.

**Installed app tools — the marketplace** (headless; no window needed)
- \`app_list_tools\` — discover the MCP tools the user's installed Glyphh apps expose: \`[{ app, name, tools: [{ name, description, inputSchema }] }]\`. Every user's apps differ — discover first, never assume.
- \`app_call_tool { app, tool, args }\` — run one headlessly (send a message, query a graph, search a vector store, create an event). \`args\` must match the tool's \`inputSchema\`.
- \`app_install { path }\` — install/update a \`.glyphh\` bundle already on the user's machine (absolute path — preferred). Also accepts \`{ url }\` to download, or \`{ bundleBase64 }\` for tiny bundles only.

**Connected accounts** (the 3,500-app catalog, via Pipedream)
- \`connector_list_tools\` — every tool the user's connected apps expose (Slack, GitHub, Notion, Gmail, Salesforce, …), with schemas.
- \`connector_call_tool { slug, name, args }\` — call one of them.

## Building a Glyphh app

A Glyphh app is a portable \`.glyphh\` bundle (a zip) that installs onto the
user's machine; its declared tools then light up for \`app_call_tool\` (and, if
published, at a public URL). When no existing tool does the job, **build one**:
author the bundle, then deploy it with \`app_install\`.

**Bundle layout** — files at the zip root:
- \`manifest.json\` (required — the app contract)
- \`index.html\` (the UI window; the manifest \`entry\`)
- \`worker.js\` (optional — headless logic; the manifest \`worker\`)
- any assets the UI references (relative paths)

**manifest.json**
\`\`\`json
{
  "manifestVersion": 2,
  "kind": "glyphh-app",
  "name": "Recall",
  "slug": "recall",
  "entry": "index.html",
  "worker": "worker.js",
  "description": "Ask questions over your notes.",
  "capabilities": ["llm.chunk", "vector.upsert", "vector.search", "graph.cypher", "llm.complete", "secrets.get"],
  "connectors": [],
  "tools": [
    { "name": "ingest", "description": "Index a document.", "handler": "ingest",
      "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] } },
    { "name": "ask", "description": "Answer from the indexed notes.", "handler": "ask",
      "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } }, "required": ["q"] } }
  ]
}
\`\`\`
Rules: each tool is backed by EXACTLY ONE of \`handler\` (a function in the worker)
or \`capability\` (a 1:1 passthrough to a host capability). Every capability your
worker/tools use MUST be listed in \`capabilities\` — the host enforces this
per-app allowlist. Any \`connector.*\` capability requires a non-empty
\`connectors\` list. Re-installing the same \`slug\` updates in place.

**The worker (headless logic)** — \`worker.js\` runs sandboxed with one SDK:
- \`glyphh.handle(name, async (args) => { ... })\` — register a handler (invoked for tool calls + cron firings). Register all handlers at the top level.
- \`glyphh.call(method, args)\` — use a declared capability; returns \`{ ok, result }\` or \`{ ok:false, error }\`.
Keep workers stateless (state lives in \`db.exec\`); handlers time out at 60s.

**Capabilities (what an app can do)** — declare each in \`capabilities\`:
- **Storage** — \`db.exec { sql, params? }\`: the app's own SQLite DB (one statement per call).
- **Vector DB** — \`vector.upsert { collection, items:[{ id, text?, vector?, metadata? }], model? }\`, \`vector.search { collection, query|vector, k?, filter? }\`, \`vector.delete\`. \`text\` is embedded automatically ON-DEVICE (no key). Helpers: \`llm.chunk { text, maxChars?, overlap? }\`, \`llm.embed { text|texts }\`. Typical RAG: chunk → \`vector.upsert\` → \`vector.search\`.
- **Knowledge graph** — \`graph.cypher { query, params? }\`: a real per-app **Kuzu** graph speaking full Cypher. Kuzu is schema-full, so the first calls are DDL, then queries: \`CREATE NODE TABLE Person(name STRING, PRIMARY KEY(name))\` → \`CREATE REL TABLE Knows(FROM Person TO Person)\` → \`MATCH (a:Person)-[:Knows*1..2]->(b) RETURN b.name\`. \`params\` are Cypher \`$\`-parameters.
- **Models (BYOK)** — \`llm.complete { prompt, system?, provider?, model? }\` (one-shot) and \`agent.run { prompt, tools?, maxTurns? }\` (agentic loop over the app's own tools). Providers: \`anthropic\` (default) / \`openai\` / \`google\`. The key is the app's Config Var \`<PROVIDER>_API_KEY\` (\`ANTHROPIC_API_KEY\` / \`OPENAI_API_KEY\` / \`GOOGLE_API_KEY\`) — the host injects it; app code never handles keys.
- **Connections** — \`connector.status\`, \`connector.tools\`, \`connector.call { connector, tool, args }\`, scoped to the manifest's \`connectors\` (Pipedream app slugs, e.g. \`slack\`, \`gmail\`, \`salesforce\`; browse pipedream.com/apps). Gate UI on \`connector.status\` — a well-behaved app shows "Connect X in Glyphh" instead of failing.
- **Scheduling** — \`cron.schedule { id, cron, handler, args? }\` (+ \`cron.cancel\`/\`cron.list\`): persisted 5-field cron firing a worker handler.
- **Notify** — \`notify.send { title, body }\`: an OS notification.
- **Config vars / secrets** — \`secrets.get { key }\`, \`secrets.list\`: per-app encrypted vars the user sets on the app's **Config Vars** tab (host-only; never shown after entry). This is how an app *requires* a key: declare \`secrets.get\`, document the var name, and tell the user to set it.

**Example — a RAG app with a knowledge graph** (\`worker.js\`):
\`\`\`js
glyphh.handle("ingest", async ({ text }) => {
  const { result: { chunks } } = await glyphh.call("llm.chunk", { text });
  await glyphh.call("vector.upsert", { collection: "notes",
    items: chunks.map((t, i) => ({ id: Date.now() + ":" + i, text: t })) });
  // (optionally extract entities and write them with graph.cypher)
  return { indexed: chunks.length };
});
glyphh.handle("ask", async ({ q }) => {
  const { result: { matches } } = await glyphh.call("vector.search", { collection: "notes", query: q, k: 6 });
  const context = matches.map(m => m.text).join("\\n---\\n");
  const key = (await glyphh.call("secrets.get", { key: "ANTHROPIC_API_KEY" })).result?.value;
  const { result } = await glyphh.call("llm.complete", {
    provider: "anthropic", prompt: "Answer using only this context:\\n" + context + "\\n\\nQ: " + q });
  return { answer: result.text };
});
\`\`\`

**Deploy** — install the bundle and its tools go live:
\`app_install { path: "/absolute/path/recall.glyphh" }\` → then \`app_list_tools\`
shows \`recall\`'s tools and \`app_call_tool { app:"recall", tool:"ask", args:{ q } }\`
runs them. Re-install to update (the worker restarts; cron schedules survive).

## Publishing — give an app a public URL

To put a hosted app on the internet at \`<slug>.glyphh.app\`, use the control-plane
tools directly (no UI needed):

1. \`create_app_entry { kind: "glyphh", slug, name }\` — register the app once.
2. \`build_app { slug, files: { "index.html": "…", … } }\` — send the app's source
   as a path→content map. It cuts a release, builds it, and (unless \`deploy:false\`)
   deploys it live, returning the \`url\` and the release \`status\` — a \`failed\`
   status carries the compiler error to fix.
3. \`deploy_app { slug }\` only RE-deploys an already-built release; it never builds.
   If \`get_app\` shows a release with no finished build, call \`build_app\`.

A deployed app lives at \`<slug>.glyphh.app\`. Who may open it is the app's
**access**, set on its Deploy tab (or \`apps edit --access\`): *members* (visitors
sign in with a Glyphh account) or *public* (anyone with the link). It is checked
at the edge on every request, before anything reaches the app.

An INSTALLED \`.glyphh\` bundle is the other shape: it runs on the user's own
machine and exposes the tools its manifest declares. Those are reachable through
\`app_list_tools\` / \`app_call_tool\` — the owner approves each tool, and the
per-app guardrails (input cap, rolling token + call budgets, concurrency) bound
every call.

Provider keys stay host-only: the model call runs on the user's machine and the
server never sees the key.

## How to work

1. **Discover first.** \`app_list_tools\` (+ \`panels_list\` / \`connector_list_tools\`) — every user's setup differs; never assume a tool exists.
2. **Prefer a declared tool.** \`app_call_tool\` / \`connector_call_tool\` are deterministic and headless — use them over anything manual.
3. **Chain.** Feed one tool's result into the next.
4. **Build when needed.** No tool for the job? Author a \`.glyphh\` (worker + capabilities), \`app_install\` it, then call its tools. Publish it if the user wants it on the web.

## Guardrails

- These tools act on the user's real machine and accounts. Confirm before anything destructive or outward-facing (sending messages, posting, deleting, publishing, making public).
- Provider/API keys are host-only — never ask the user to paste a key to you; they set \`<PROVIDER>_API_KEY\` on the app's Config Vars tab.
- If a call returns "yo-client isn't connected", the user's Glyphh app is closed or offline — ask them to open it.
`;

function frontmatterClaude(): string {
  return `---
name: glyphh
description: Drive the user's Glyphh workspace over MCP — open their apps and saved layouts as native windows, run the tools their installed apps expose, call their 3,500+ connected accounts, and build + deploy new Glyphh apps (SQLite, on-device vector search, a Kuzu knowledge graph, cron, connectors, and BYOK models), then publish them to a public URL. Use when the user asks to open/arrange apps, act through a Glyphh app or connected account, automate something on their machine, or build/publish an app.
---

# Glyphh

`;
}

function preamble(provider: "gemini" | "openai"): string {
  const name = provider === "gemini" ? "Gemini" : "your assistant";
  return `# Glyphh skill

Paste this into ${name}'s custom instructions (${provider === "gemini" ? "a Gem's instructions" : "a Custom GPT's instructions or a system prompt"}) after connecting Glyphh's MCP endpoint. It teaches you to drive the user's Glyphh workspace.

`;
}

/** Build the skill file (name + content) for a provider. */
export function generateGlyphhSkill(provider: SkillProvider): { filename: string; content: string } {
  if (provider === "claude") {
    return { filename: "SKILL.md", content: frontmatterClaude() + BODY };
  }
  if (provider === "gemini") {
    return { filename: "glyphh-gemini-instructions.md", content: preamble("gemini") + BODY };
  }
  return { filename: "glyphh-openai-instructions.md", content: preamble("openai") + BODY };
}
