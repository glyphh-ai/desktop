/**
 * app-spec/scaffold.ts — THE STARTER (his order, 2026-10-07: "the contract
 * must be in hand on the first turn"). `glyphh_app_scaffold` on the desktop
 * and on the cloud worker writes what this makes: the Next.js template with
 * the manifest, the worker and the SKILL.md rewritten for the app the member
 * asked for — its name, slug, description, connections and tools, and the
 * member's REAL connected-account tool names for each connection — so the
 * agent edits a working app instead of guessing at one.
 */

import { APP_TEMPLATE_FILES } from "./template.js";

export interface ScaffoldTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments; an object with no properties when absent. */
  inputSchema?: Record<string, unknown>;
}

/** One connected account's tools, as the host read them (connector_tools / mcp_tool_search). */
export interface ScaffoldConnection {
  /** The connection slug the manifest names: gmail, slack, google_calendar … */
  app: string;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
}

export interface ScaffoldOptions {
  name: string;
  slug?: string;
  description?: string;
  /** Connection slugs the app works through; each becomes a `connector.*` reach. */
  connections?: string[];
  /** The tools the app exposes to the agent; each gets a worker handler. */
  tools?: ScaffoldTool[];
  /** The member's real tool names per connection, written into CONNECTIONS.md and the worker. */
  connectionTools?: ScaffoldConnection[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NAME_RE = /^[a-z][a-z0-9_]*$/;

/** A slug from a name: lowercase, [a-z0-9_-], no leading underscore. */
export function slugOf(name: string): string {
  const s = String(name || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|-+$/g, "").replace(/-{2,}/g, "-");
  return s || "app";
}

const identifier = (s: string): string => String(s || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "") || "run";

function normalizeTools(raw: ScaffoldTool[] | undefined): Array<Required<Pick<ScaffoldTool, "name">> & { description: string; inputSchema: Record<string, unknown> }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
  for (const t of raw ?? []) {
    const name = identifier(t?.name ?? "");
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    const schema = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} };
    out.push({ name, description: String(t.description || `The ${name} tool.`).trim(), inputSchema: schema });
  }
  if (!out.length) out.push({ name: "add_note", description: "File a short note. Returns the stored row.", inputSchema: { type: "object", properties: { text: { type: "string", description: "The note" } }, required: ["text"] } });
  return out;
}

const normalizeConnections = (raw: string[] | undefined): string[] =>
  [...new Set((raw ?? []).map((c) => String(c || "").trim().toLowerCase()).filter((c) => /^[a-z0-9_-]+$/.test(c)))];

/** Which argument names a schema declares, for the handler's destructuring. */
function argNames(schema: Record<string, unknown>): string[] {
  const props = schema.properties;
  return props && typeof props === "object" ? Object.keys(props as Record<string, unknown>).filter((k) => /^[a-z_][a-z0-9_]*$/i.test(k)) : [];
}

function workerSource(slug: string, tools: ReturnType<typeof normalizeTools>, connections: string[], connectionTools: ScaffoldConnection[]): string {
  const handlers = tools.map((t) => {
    const args = argNames(t.inputSchema);
    const sig = args.length ? `{ ${args.join(", ")} }` : "args";
    return `// ${t.description}
glyphh.handle("${t.name}", async (${sig}) => {
  await ensureSchema();
  // TODO: do the work with glyphh.call — db.exec / vector.* / graph.cypher / connector.call.
  const { rows } = await call("db.exec", {
    sql: "INSERT INTO events (tool, payload) VALUES ($1, $2) RETURNING id, tool, payload, created_at",
    params: ["${t.name}", JSON.stringify(${args.length ? `{ ${args.join(", ")} }` : "args ?? {}"})],
  });
  return rows[0];
});`;
  }).join("\n\n");
  const connectorNote = connections.length
    ? `\n// CONNECTED ACCOUNTS this app may call (manifest connectors: ${connections.join(", ")}):\n//   await call("connector.call", { connector: "<slug>", tool: "<tool>", args: { ... } })\n// The member's real tool names are in CONNECTIONS.md${connectionTools.length ? ":" : "."}\n` +
      connectionTools.map((c) => `//   ${c.app}: ${c.tools.slice(0, 8).map((t) => t.name).join(", ")}${c.tools.length > 8 ? ", …" : ""}`).join("\n") + (connectionTools.length ? "\n" : "")
    : "";
  return `// The server side of the ${slug} app. Sandboxed: no fetch/require/import/process —
// everything goes through glyphh.call(capability, args), which resolves
// { ok: true, result } or { ok: false, error } and never throws.
// The AGENT thinks; this app stores, finds and reaches accounts. No model call here.
${connectorNote}
async function call(method, args) {
  const res = await glyphh.call(method, args ?? {});
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

async function ensureSchema() {
  await call("db.exec", {
    sql: "CREATE TABLE IF NOT EXISTS events (id SERIAL PRIMARY KEY, tool TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  });
}

${handlers}
`;
}

function skillSource(name: string, slug: string, description: string, tools: ReturnType<typeof normalizeTools>, connections: string[]): string {
  const lines = tools.map((t) => `- \`${t.name}\` — ${t.description}`).join("\n");
  return `---
name: app-${slug}
description: ${description.split(/\r?\n/)[0] || `The ${name} app's tools.`} Use the ${name} app's tools for it.
---

# ${name}

${description}

Installed as the Glyphh app \`${slug}\`. Search for its tools first (\`find_tools\` / \`mcp_tool_search\`), then run one with
\`app_call_tool { app: "${slug}", tool, args }\`; \`args\` must match the tool's inputSchema.

## Tools

${lines}
${connections.length ? `\n## Accounts\n\nWorks through the member's connected accounts: ${connections.join(", ")}. Connect them on Settings → Connections before using the tools that need them.\n` : ""}`;
}

function connectionsDoc(connectionTools: ScaffoldConnection[], connections: string[]): string {
  const sections = connections.map((slug) => {
    const c = connectionTools.find((x) => x.app === slug);
    if (!c || !c.tools.length) return `## ${slug}\n\nNo tools read for this account yet — the member may not have connected it. Gate the UI on \`connector.status\` and say "Connect ${slug} in Glyphh".\n`;
    const rows = c.tools.map((t) => `- \`${t.name}\`${t.description ? ` — ${t.description}` : ""}${t.inputSchema ? `\n  \`\`\`json\n  ${JSON.stringify(t.inputSchema)}\n  \`\`\`` : ""}`).join("\n");
    return `## ${slug}\n\nThe member's REAL tool names (call with \`connector.call { connector: "${slug}", tool, args }\`):\n\n${rows}\n`;
  });
  return `# Connected accounts\n\nWhat this app may call through \`connector.call\`, as the member has it connected today. Use these names exactly; never invent one.\n\n${sections.join("\n")}`;
}

/** The starter's files, path → content. A fresh copy each call. */
export function scaffoldAppFiles(opts: ScaffoldOptions): Record<string, string> {
  const name = String(opts.name || "").trim() || "App";
  const slug = SLUG_RE.test(String(opts.slug || "")) ? String(opts.slug) : slugOf(opts.slug || name);
  const description = String(opts.description || "").trim() || `${name}, a Glyphh app.`;
  const tools = normalizeTools(opts.tools);
  const connections = normalizeConnections(opts.connections);
  const connectionTools = (opts.connectionTools ?? []).filter((c) => c && connections.includes(String(c.app || "").toLowerCase())).map((c) => ({ app: String(c.app).toLowerCase(), tools: (c.tools ?? []).filter((t) => t && t.name) }));
  const base = { ...APP_TEMPLATE_FILES };
  const manifest = {
    manifestVersion: 3,
    kind: "glyphh-app",
    name, slug, description,
    capabilities: ["db.exec", ...(connections.length ? ["connector.status", "connector.tools", "connector.call"] : [])],
    connectors: connections,
    worker: "worker.js",
    window: { width: 720, height: 560 },
    tools: tools.map((t) => ({ name: t.name, description: t.description, handler: t.name, inputSchema: t.inputSchema })),
  };
  const pkg = JSON.parse(base["package.json"] ?? "{}") as Record<string, unknown>;
  pkg.name = `glyphh-app-${slug}`;
  const layout = (base["app/layout.js"] ?? "").replace(/title: "[^"]*"/, `title: ${JSON.stringify(name)}`);
  return {
    ...base,
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    "app/layout.js": layout,
    "worker.js": workerSource(slug, tools, connections, connectionTools),
    "SKILL.md": skillSource(name, slug, description, tools, connections),
    ...(connections.length ? { "CONNECTIONS.md": connectionsDoc(connectionTools, connections) } : {}),
  };
}

/** What the agent does next, spelled out in the scaffold's answer. */
export const SCAFFOLD_NEXT = [
  "Edit worker.js: one glyphh.handle per manifest tool (the TODOs); the page in app/page.js talks to the host only through window.glyphh.call.",
  "Build and run: app_install { dir: \"<the app's folder>\" } — the one door, by path. The platform builds it as a job; app_build_status { job } reads it. Never tar, zip or base64 a folder yourself.",
  "Test: app_call_tool { app: \"<slug>\", tool, args }; the panel is at the answer's url.",
  "Share to publish is the member's move (Build › Apps › Publish). Say so; do not do it.",
] as const;
