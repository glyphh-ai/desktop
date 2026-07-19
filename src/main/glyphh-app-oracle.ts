/**
 * Glyphh app install-truth validator — the manifest + worker checks the
 * legacy single-file install path runs before packaging. (The one-shot LLM
 * builder and its emission format are retired — apps are Vite projects built
 * by frontier agents now; see glyphh-app-spec.ts. This module keeps only the
 * validation the legacy update path still uses.) Electron-free by design so
 * the exact compiled module is testable outside the app.
 */

export type Bundle = Record<string, string>;

// ── The validator (install gates + stricter runtime checks) ───────────────

const KNOWN_CAPABILITIES = new Set([
  "contacts.search", "messages.send",
  "db.exec", "cron.schedule", "cron.cancel", "cron.list", "notify.send",
  "connector.status", "connector.tools", "connector.call",
  "llm.embed", "llm.chunk", "llm.complete", "agent.run",
  "vector.upsert", "vector.search", "vector.delete",
  "graph.cypher", "secrets.get", "secrets.list",
  "web.fetch", "web.read",
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
//    Glyphh builds — keep-in-sync with glyphh-glyphh validate.ts) ────────

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
      errors.push(`glyphh.call("${target}") is not a capability. The COMPLETE capability list: db.exec, cron.schedule/cancel/list, notify.send, llm.embed/chunk/complete, agent.run, vector.upsert/search/delete, graph.cypher, secrets.get/list, connector.status/tools/call, contacts.search, messages.send. For web content use web.read {url} (clean page text) or web.fetch {url} (raw) — declared in manifest capabilities. Workers never call fetch directly.`);
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
    errors.push("worker uses forbidden APIs (network/node)." + " Workers have NO direct network access — for web content use the web.read {url} capability (clean page text, host-mediated) or web.fetch {url} (raw), for account APIs use connector.call, for knowledge use llm.complete. Declare web.fetch/web.read in the manifest capabilities.");

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
