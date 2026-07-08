/**
 * William's app-build oracle — the emission parser + install-truth validator.
 *
 * KEEP IN SYNC with glyphh-william/src/gen/{system-prompt,emit-format,
 * validate}.ts (the training-side copies) and the install gates in
 * glyphh-app-host.ts. Electron-free by design so the exact compiled module
 * is testable outside the app. Connector grounding is injected: the caller
 * supplies live tool names per connected slug (better than a static
 * catalog — it IS the user's account).
 */

export type Bundle = Record<string, string>;

export const SYSTEM_PROMPT = `You are William, a code generator that builds Glyphh apps.

A Glyphh app is a portable ".glyphh" bundle: a manifest, a UI, and optional
headless worker logic that exposes tools. You output the bundle and NOTHING else.

## Output format — EXACT
Emit the bundle as fenced sections, in this order, with no prose before, between,
or after them:

=== manifest.json ===
{ ... }
=== worker.js ===
// ... (OMIT this whole section if the app declares no handler-backed tools)
=== index.html ===
<!doctype html> ...

## manifest.json
STRICT JSON only — no comments, no trailing commas, every key quoted.
Required: "manifestVersion": 2, "kind": "glyphh-app", "name", "slug"
(lowercase [a-z0-9_-], no leading underscore), "entry": "index.html",
"description" (one-line tagline).
Marketplace listing (include all): "version" (semver e.g. "1.0.0"), "icon" (an
emoji), "category" (one of productivity, communication, developer, data, crm,
finance, personal, fun, other), "keywords" (array), "about" (a short markdown
description).
Optional: "worker": "worker.js" (required IF any tool uses a handler),
"window": { "width", "height" }, "capabilities": [...], "connectors": [...]
(Pipedream app slugs), "tools": [...].

Each tool: { "name", "description", "handler" XOR "capability", "inputSchema" }
where inputSchema is a JSON Schema object. RULES:
- exactly ONE of "handler" (a worker function) or "capability" (a host call).
- every "capability" used by a tool must also appear in top-level "capabilities".
- any "connector.*" capability requires a non-empty "connectors" list.
- NEVER expose "agent.run" as a tool.

## Capabilities (the ONLY host calls that exist)
db.exec {sql,params?} · cron.schedule {id,cron,handler,args?} · cron.cancel · cron.list
· notify.send {title,body} · llm.embed · llm.chunk · llm.complete {prompt,system?}
· agent.run {prompt,...} · vector.upsert/search/delete · graph.cypher {query,params?}
· secrets.get {key} · secrets.list · connector.status · connector.tools · connector.call
{connector,tool,args?} · contacts.search · messages.send {to,body}.

When a "Connectors available to this app" section is provided with the request, use
ONLY those exact connector tool names and arg names in connector.call — never guess,
prefix, or abbreviate. The host injects the connected account; never put it in args.

## worker.js (headless, sandboxed)
SDK ONLY: glyphh.handle("name", async (args) => { ... return result }) registers a
tool/cron handler (its return value IS the tool result); await glyphh.call(cap, args)
→ { ok, result } | { ok:false, error }; glyphh.app.slug. Register handlers at the top
level. NO fetch, NO require/import, NO network, NO node — every side effect goes
through glyphh.call(). State lives in db.exec, not in memory.

## index.html (the UI — make it genuinely beautiful)
A single self-contained file. Talk to the host via window.glyphh.call(method, args).
No build step, no external network/CDN. Host libraries are available relatively:
<script src="../_libs/chart.js"></script> exposes window.Chart (Chart.js 4);
../_libs/three.js → window.THREE; ../_libs/flow.js → window.GlyphhFlow. Inline all
your own CSS/JS. Gate any connector UI on connector.status.

Emit only the bundle.`;

// ── Emission parsing (=== file === sections; fence-tolerant) ──────────────

const DELIM = /^===\s*(.+?)\s*===\s*$/;

function stripFence(s: string): string {
  const t = s.trim();
  const f = t.match(/^```[a-z0-9]*\n([\s\S]*?)\n```$/i);
  return (f ? f[1] : t).replace(/\s+$/, "") + "\n";
}

export function parseEmission(text: string): Bundle {
  let body = text.trim();
  const outer = body.match(/^```[a-z0-9]*\n([\s\S]*?)\n```$/i);
  if (outer) body = outer[1];
  const files: Bundle = {};
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => { if (current) files[current] = stripFence(buf.join("\n")); buf = []; };
  for (const line of body.split("\n")) {
    const m = line.match(DELIM);
    if (m) { flush(); current = m[1].trim(); continue; }
    if (current) buf.push(line);
  }
  flush();
  return files;
}

// ── Grounding block (training format, built from LIVE connector tools) ────

export interface LiveConnectorTool { name: string; description?: string; inputSchema?: Record<string, unknown> }

export function buildGroundingBlock(toolsBySlug: Record<string, LiveConnectorTool[]>): string {
  const blocks: string[] = [];
  for (const [slug, tools] of Object.entries(toolsBySlug)) {
    if (!tools.length) continue;
    const lines = tools.slice(0, 40).map((t) => {
      const props = (t.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined);
      const req = new Set(props?.required ?? []);
      const args = Object.keys(props?.properties ?? {}).map((a) => (req.has(a) ? a : `${a}?`)).join(", ");
      const desc = (t.description || "").split("\n")[0].slice(0, 110);
      return `  - ${t.name}${desc ? ` — ${desc}` : ""}${args ? `  [args: ${args}]` : ""}`;
    });
    blocks.push(`### ${slug}\n${lines.join("\n")}`);
  }
  if (!blocks.length) return "";
  return [
    "## Connectors available to this app",
    "Call these with connector.call({ connector, tool, args }). Use these EXACT `tool` names and arg names verbatim — never invent, prefix, or abbreviate them. The connected account is injected by the host; never put it in args.",
    ...blocks,
  ].join("\n");
}

// ── The validator (install gates + stricter runtime checks) ───────────────

const KNOWN_CAPABILITIES = new Set([
  "contacts.search", "messages.send",
  "db.exec", "cron.schedule", "cron.cancel", "cron.list", "notify.send",
  "connector.status", "connector.tools", "connector.call",
  "llm.embed", "llm.chunk", "llm.complete", "agent.run",
  "vector.upsert", "vector.search", "vector.delete",
  "graph.cypher", "secrets.get", "secrets.list",
]);

const FORBIDDEN_WORKER = /\bfetch\s*\(|\brequire\s*\(|\bimport\s+[\w{*'"]|\bnew\s+WebSocket|\bXMLHttpRequest\b|\bprocess\.(env|platform|exit|cwd)/;

interface ParsedManifest {
  name: string; slug: string; entry: string; worker?: string;
  capabilities: string[]; connectors: string[];
  tools: Array<{ name: string; capability?: string; handler?: string }>;
  [k: string]: unknown;
}

export interface ValidationResult { ok: boolean; errors: string[]; warnings: string[]; manifest: ParsedManifest | null }

function parseManifest(json: string): ParsedManifest | null {
  let m: any;
  try { m = JSON.parse(json); } catch { return null; }
  if (m?.kind !== "glyphh-app") return null;
  if (!m.name || !m.slug || !m.entry) return null;
  m.slug = String(m.slug).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (m.slug.startsWith("_")) return null;
  m.capabilities = Array.isArray(m.capabilities) ? m.capabilities.map(String) : [];
  m.connectors = Array.isArray(m.connectors)
    ? [...new Set(m.connectors.map((c: unknown) => String(c).trim().toLowerCase()).filter((c: string) => /^[a-z0-9_-]+$/.test(c)))]
    : [];
  m.worker = typeof m.worker === "string" && m.worker.trim() ? m.worker.trim() : undefined;
  m.tools = Array.isArray(m.tools)
    ? m.tools.filter((t: any) => t && typeof t.name === "string"
        && (typeof t.capability === "string") !== (typeof t.handler === "string"))
    : [];
  return m as ParsedManifest;
}

export function extractConnectorCalls(worker: string): Array<{ connector: string; tool: string }> {
  const out: Array<{ connector: string; tool: string }> = [];
  const re = /connector\.call/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(worker))) {
    const win = worker.slice(m.index, m.index + 500);
    const conn = win.match(/connector\s*:\s*["'`]([^"'`]+)["'`]/);
    const tool = win.match(/tool\s*:\s*["'`]([^"'`]+)["'`]/);
    if (conn && tool) out.push({ connector: conn[1], tool: tool[1] });
  }
  return out;
}


// ── Runtime-semantics checks (statically catchable classes found in real
//    William builds — keep-in-sync with glyphh-william validate.ts) ────────

/** glyphh.call targets must be host capabilities — a worker calling its own
 *  handlers through glyphh.call errors at runtime (call functions directly). */
export function checkCallTargets(worker: string): string[] {
  const errors: string[] = [];
  const handlers = new Set<string>();
  for (const m of worker.matchAll(/glyphh\.handle\(\s*["'`]([^"'`]+)["'`]/g)) handlers.add(m[1]);
  for (const m of worker.matchAll(/glyphh\.call\(\s*["'`]([^"'`]+)["'`]/g)) {
    const target = m[1];
    if (KNOWN_CAPABILITIES.has(target)) continue;
    if (handlers.has(target)) {
      errors.push(`glyphh.call("${target}") targets the worker's own handler — call the function directly; glyphh.call is for host capabilities only`);
    } else {
      errors.push(`glyphh.call("${target}") is not a capability. The COMPLETE capability list: db.exec, cron.schedule/cancel/list, notify.send, llm.embed/chunk/complete, agent.run, vector.upsert/search/delete, graph.cypher, secrets.get/list, connector.status/tools/call, contacts.search, messages.send. There is NO network/fetch/http capability — workers reach the outside ONLY through connector.call.`);
    }
  }
  return [...new Set(errors)];
}

/** cron.schedule expressions must be 5 space-separated fields — HH:MM-style
 *  strings never fire. Literals validate hard; template-built ones warn. */
const CRON_FIELD = /^(\*|[0-9*,/-]+)$/;
export function checkCronExpressions(worker: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!worker.includes("cron.schedule")) return { errors, warnings };
  // Scan EVERY cron-shaped string/template in the worker (the value usually
  // lands in a variable before the call, so call-site extraction misses).
  for (const m of worker.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
    const raw = m[2];
    const fields = raw.trim().split(/\s+/);
    const stars = fields.filter((f) => f === "*").length;
    if (fields.length < 4 || stars < 2) continue; // not cron-intended
    if (raw.includes("${")) {
      // The HH:MM smell: ONE placeholder in the minute slot then "* * * *".
      // (Legit templates use two: "${m} ${h} * * *".)
      if (/^\$\{[^}]*\}\s+\*\s+\*\s+\*\s+\*$/.test(raw.trim())) {
        warnings.push(`cron template "${raw.trim()}" puts one variable in the minute field — if it holds HH:MM the job never fires; split into minute and hour ("\${mm} \${hh} * * *")`);
      } else if (raw.includes(":") || fields.length !== 5) {
        warnings.push(`cron built from a template ("${raw.slice(0, 40)}") — must resolve to 5 space-separated fields (minute hour dom month dow), never HH:MM`);
      }
      continue;
    }
    if (fields.length !== 5 || raw.includes(":") || !fields.every((f) => CRON_FIELD.test(f))) {
      errors.push(`invalid cron expression "${raw}" — needs 5 fields (minute hour dom month dow), e.g. "0 8 * * *" for daily 8am`);
    }
  }
  return { errors, warnings };
}

/** `lookup(slug)` → live tool names for a connected slug, or null when
 *  unknown (grounding then warns instead of erroring). */
export function validateBundle(bundle: Bundle, lookup?: (slug: string) => string[] | null): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const manifestRaw = bundle["manifest.json"];
  if (!manifestRaw) return { ok: false, errors: ["no manifest.json in emission"], warnings, manifest: null };
  const m = parseManifest(manifestRaw);
  if (!m) return { ok: false, errors: ["manifest rejected (bad JSON, missing kind/name/slug/entry, or reserved _slug)"], warnings, manifest: null };

  const unknown = m.capabilities.filter((c) => !KNOWN_CAPABILITIES.has(c));
  if (unknown.length) errors.push(`unknown capabilities: ${unknown.join(", ")}`);

  const badTool = m.tools.find((t) => t.capability && !m.capabilities.includes(t.capability));
  if (badTool) errors.push(`tool "${badTool.name}" needs undeclared capability "${badTool.capability}"`);

  const handlerTool = m.tools.find((t) => t.handler);
  if (handlerTool && !m.worker) errors.push(`tool "${handlerTool.name}" uses a handler but no worker is declared`);

  if (m.capabilities.some((c) => c.startsWith("connector.")) && !m.connectors.length)
    errors.push("connector.* capabilities require a non-empty `connectors` list");

  const recursive = m.tools.find((t) => t.capability === "agent.run");
  if (recursive) errors.push(`tool "${recursive.name}" cannot expose agent.run as a tool`);

  if (m.worker && !bundle[m.worker]) errors.push(`worker "${m.worker}" declared but its code is missing`);
  const workerCode = m.worker ? bundle[m.worker] : undefined;
  if (workerCode && FORBIDDEN_WORKER.test(workerCode))
    errors.push("worker uses forbidden APIs (network/node)." + " Workers have NO network access BY DESIGN — there is no fetch/HTTP capability. For outside data use connector.call with a CONNECTED account's tools, llm.complete for knowledge/summarization, or redesign around data the host provides.");

  if (workerCode) {
    errors.push(...checkCallTargets(workerCode));
    const cron = checkCronExpressions(workerCode);
    errors.push(...cron.errors);
    warnings.push(...cron.warnings);
  }

  if (workerCode && lookup) {
    for (const { connector, tool } of extractConnectorCalls(workerCode)) {
      if (!m.connectors.includes(connector)) {
        errors.push(`connector.call uses "${connector}" but it's not in the manifest connectors list`);
        continue;
      }
      const names = lookup(connector);
      if (!names) { warnings.push(`no live catalog for "${connector}" — tool "${tool}" unverified`); continue; }
      if (!names.includes(tool))
        errors.push(`connector.call tool "${tool}" doesn't exist for "${connector}" (real ones e.g. ${names.slice(0, 3).join(", ")})`);
    }
  }

  if (!bundle[m.entry]) warnings.push(`entry "${m.entry}" absent`);
  return { ok: errors.length === 0, errors, warnings, manifest: m };
}
