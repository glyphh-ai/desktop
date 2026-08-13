/**
 * Glyphh's tool surface — what the agent loop can DO.
 *
 * Workspace (working-folder scoped): list_dir, read_file, write_file,
 * search_files, run_command. Paths resolve inside the working folder;
 * anything escaping it escalates to a "dangerous" gate action.
 *
 * Workspace windows & apps: open_app / open_workspace (unified resolver —
 * everything lands in the workbench), list_windows / list_workspaces, plus
 * the RPA-class surface: app_list_tools / app_call_tool run installed
 * Glyphh apps' declared MCP tools headlessly. The user's connected
 * accounts (Slack, GitHub, …) ride as FIRST-CLASS tools — each governed
 * catalog entry becomes its own MCP tool with its real input schema
 * (connectorWireTools), so the model never guesses a slug or a tool name.
 * yo-server owns all auth (Pipedream) and metering. list_drips / run_drip
 * for celebrations. Deterministic beats pixel-driving throughout.
 *
 * Every execution passes gateGlyphhAction() first (mode model: ask /
 * plan / acceptEdits / auto / bypass) — a denial returns "DENIED: …" as
 * the tool result so the model can re-plan instead of crashing the loop.
 */

import { exec } from "child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { WebContents } from "electron";
import { gateGlyphhAction, askUserQuestions, requestInlineConnect, type GlyphhActionKind } from "./glyphh-agent-permissions";
import { getExplicitWorkingDirectory } from "./working-directory";
import { openAppByRef, openBrowserAt, openLayoutByName, listOpenAppWindows } from "./app-resolver";
import { currentLoop, resolveRoles } from "./loop-selections";
import { dispatchRelayMethod } from "./relay-client";
import { getAccountInfo } from "./auth";
import { SEMANTIC_TOOLS } from "./glyphh-agent-semantic";
import { getClient, appCache } from "./glyphh-client";
import { fetchServerLayouts } from "./layout-manager";
import { refreshConnectorCatalog, getConnectorCatalog, getCatalogAge, callConnectorTool } from "./connector-tools-client";
import { BUILTIN_EFFECTS, getDripManagerInstance } from "./drip-manager";
import { adaTellRaw, adaExecuteOp, adaRecall, adaHistory, type AdaOp } from "./ada/store";
import { indexConnectorTools } from "./ada/indexer";
import { indexToolVectors, rankConnectorTools } from "./tool-vectors";
import { updateAppFromWorkdir } from "./glyphh-app-builder";
import { APP_GITIGNORE } from "./glyphh-app-spec";
import { enrichFact } from "./ada/enricher";
import { listInstalledAppTools, callAppTool } from "./glyphh-app-host";

const OUTPUT_CAP = 8000;
const READ_CAP = 24000;

interface ToolDef {
  name: string;
  /** One line shown to the model in the system prompt. */
  doc: string;
  run: (args: Record<string, unknown>, signal?: AbortSignal, wc?: WebContents) => Promise<string>;
  /** Gate classification for a concrete call. */
  action: (args: Record<string, unknown>) => { kind: GlyphhActionKind; title: string; detail?: string };
}

const cap = (s: string, n = OUTPUT_CAP) => (s.length > n ? `${s.slice(0, n)}\n…(truncated, ${s.length} chars total)` : s);

/** Attachment content types by extension — the handful that matter for
 *  "email me the file"; anything else ships as octet-stream. */
const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", txt: "text/plain", md: "text/plain",
  csv: "text/csv", json: "application/json", zip: "application/zip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// ── Per-run working directory ────────────────────────────────────────────────
// Sessions are independent processes; each run executes its tools inside ITS
// OWN folder. The run's folder rides an AsyncLocalStorage context set by
// executeGlyphhTool (it survives every await in the tool chain, including
// run_role's nested packets), with the global pick as the fallback for
// callers outside a run (relay, loopback MCP).
const toolRunContext = new AsyncLocalStorage<{ workdir: string }>();

function workdir(): string {
  const wd = toolRunContext.getStore()?.workdir || getExplicitWorkingDirectory();
  if (!wd) throw new Error("no working folder is set — ask the user to pick one in the Code header");
  return wd;
}

/** Every live agent run on this machine, registered by the agent loop —
 *  the data behind list_active_agents and (soon) the swarm surface. */
export const activeAgentRuns = new Map<string, { runId: string; workdir: string; startedAt: number }>();

// Paths the user attached via composer chips — attaching is consent, so
// reads of these gate as plain reads even outside the working folder.
// Attach = consent, scoped to the run that carried it. Concurrent runs each
// hold their own whitelist; the effective set is the union of LIVE runs (a
// path the user attached anywhere is fair to read until that run ends).
const runAttachments = new Map<string, string[]>();
export function setRunAttachments(runId: string, paths: string[]): void {
  runAttachments.set(runId, paths.filter(Boolean));
}
export function clearRunAttachments(runId: string): void {
  runAttachments.delete(runId);
}
const isAttachedPath = (abs: string) =>
  [...runAttachments.values()].some((paths) => paths.some((p) => abs === p || abs.startsWith(p + sep)));

/** Resolve inside the working folder; escapes are flagged, not thrown —
 *  the gate decides (dangerous), so bypass mode can still allow them. */
function resolvePath(p: unknown): { abs: string; escapes: boolean } {
  const wd = workdir();
  const abs = resolve(wd, String(p ?? "."));
  return { abs, escapes: abs !== wd && !abs.startsWith(wd + sep) };
}

/** resolvePath for READ-shaped tools: attached paths never count as
 *  escapes (attach = consent to read). Writes keep the strict check. */
function resolveReadPath(p: unknown): { abs: string; escapes: boolean } {
  const r = resolvePath(p);
  return { abs: r.abs, escapes: r.escapes && !isAttachedPath(r.abs) };
}

/** Read-shaped tool names (find/get/list/…) gate as reads — summarizing an
 *  inbox shouldn't prompt when reading a file doesn't. Sends/creates/deletes
 *  stay network-gated. */
const READ_TOOL_RE = /(^|[-_.])(find|get|list|search|read|fetch|retrieve|lookup|history|show|download|count|query)([-_.]|$)/i;

// Each rule carries the WORDS the approval card shows — a bare "dangerous"
// chip told the user nothing about what they were approving. The /dev/ rule
// excludes /dev/null|stdout|stderr|tty: `2>/dev/null` is not a disk write,
// and that false positive was interrupting auto mode on harmless commands.
// Auth flows are here on purpose: an agent must never mint itself credentials
// — the session is already authenticated through the SDK.
const DANGEROUS_RULES: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-\w*[rf]\w*\s+)+/i, why: "recursive/forced delete" },
  { re: /\bsudo\b/i, why: "elevated privileges (sudo)" },
  { re: /\bshutdown\b|\breboot\b/i, why: "system shutdown/reboot" },
  { re: /\bmkfs\b|\bdiskutil\s+erase|\bdd\s+if=/i, why: "disk format/overwrite" },
  { re: /git\s+push\s+.*--force/i, why: "force push (rewrites remote history)" },
  { re: />\s*\/dev\/(?!null\b|stdout\b|stderr\b|tty\b)/i, why: "write to a device file" },
  { re: /\b(login|logout|signin)\b|device[-_ ]?(code|login|auth)/i, why: "authentication flow — agents must never sign in" },
];
const dangerReasons = (cmd: string): string[] =>
  DANGEROUS_RULES.filter((r) => r.re.test(cmd)).map((r) => r.why);

function runShell(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((res) => {
    exec(command, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, shell: "/bin/zsh", signal }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join("\n---stderr---\n").trim();
      if (err && !out) res(`exit ${err.code ?? "?"}: ${err.message}`);
      else if (err) res(cap(`${out}\n(exit ${err.code ?? "signal"})`));
      else res(cap(out || "(no output)"));
    });
  });
}

// ── First-class connector tools ────────────────────────────────────────────
// Every entry of the governed connector catalog (yo-server enforces role
// scope, auth, and metering) is exposed to the loop as its OWN MCP tool
// with its REAL input schema — no meta-tool, no guessed slugs, no two-step
// discovery dance. Wire names must fit the API tool-name grammar
// ([a-zA-Z0-9_-], ≤64 chars including the "mcp__glyphh__" prefix), so
// catalog names are sanitized/deduped/clamped; wireMap holds the reverse
// mapping the executor dispatches through.

const WIRE_MAX = 48; // 64 minus the mcp__glyphh__ prefix, with margin
const CATALOG_STALE_MS = 5 * 60_000;

const wireMap = new Map<string, { slug: string; tool: string }>();

const sanitizeWire = (s: string) =>
  s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, WIRE_MAX);

export interface ConnectorWireDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// The FULL wired catalog from the latest connectorWireTools() pass — the
// loop preselects a per-ask subset, but find_tools searches (and call_tool
// reaches, via wireMap) everything here.
let lastWireDefs: ConnectorWireDef[] = [];

/** Refresh (if stale) and wire the connector catalog as first-class tool
 *  defs. Called at every agent-run start; rebuilds wireMap from scratch so
 *  a changed catalog (new connection, tightened role) takes effect on the
 *  very next run. Ada learns the fresh truth as a side effect. */
/** Resolve a wire tool name back to its connection + real tool name. */
export function resolveWireTool(name: string): { slug: string; tool: string } | null {
  return wireMap.get(name) ?? null;
}

export async function connectorWireTools(): Promise<ConnectorWireDef[]> {
  if (getCatalogAge() > CATALOG_STALE_MS) {
    try { await refreshConnectorCatalog(); } catch { /* offline — wire what we have */ }
  }
  // Deterministic order — the tool list is the FIRST block of the prompt
  // cache prefix, so order jitter between catalog refreshes would bust the
  // whole cache for no reason.
  const catalog = [...getConnectorCatalog()].sort((a, b) =>
    a.slug === b.slug ? a.name.localeCompare(b.name) : a.slug.localeCompare(b.slug));
  wireMap.clear();
  const builtin = new Set(TOOLS.map((t) => t.name));
  const slugs = new Set<string>();
  const defs: ConnectorWireDef[] = [];
  for (const t of catalog) {
    // Pipedream names are app-prefixed ("gmail-find-email") — prefer them
    // bare; any collision (cross-app duplicate, builtin shadow) gets the
    // slug prefix, and clamp collisions get a numeric suffix.
    let wire = sanitizeWire(t.name);
    if (!wire || builtin.has(wire) || wireMap.has(wire)) wire = sanitizeWire(`${t.slug}__${t.name}`);
    for (let n = 2; wireMap.has(wire) || builtin.has(wire); n++) {
      wire = `${sanitizeWire(t.name).slice(0, WIRE_MAX - 4)}-${n}`;
    }
    wireMap.set(wire, { slug: t.slug, tool: t.name });
    const schema = t.inputSchema && typeof t.inputSchema === "object" && Object.keys(t.inputSchema).length
      ? t.inputSchema
      : { type: "object", additionalProperties: true };
    // Download/export actions execute in the connector's REMOTE sandbox —
    // their "saved" file never lands on this machine and is gone when the
    // call returns. Say so in the description, or the model downloads a
    // file three times and then hunts the local /tmp for it.
    const sandboxNote = /download|export/i.test(t.name)
      ? " NOTE: runs in a remote sandbox — the file is NOT saved to this machine and does not persist past this call. To get the file onto this machine use fetch_connector_file; to email a file as a real attachment use send_email_with_attachment (never link-share a private file to work around this)."
      : "";
    defs.push({
      name: wire,
      description: `[${t.slug}] ${String(t.description || t.name).slice(0, 280)}${sandboxNote}`,
      inputSchema: schema,
    });
    slugs.add(t.slug);
  }
  for (const slug of slugs) {
    const tools = catalog.filter((t) => t.slug === slug).map((t) => ({ name: t.name, description: t.description }));
    try { indexConnectorTools(slug, tools); } catch { /* Ada not ready — she catches up on heartbeat */ }
  }
  lastWireDefs = defs;
  // Encode the catalog for per-ask tool selection (incremental — only new or
  // changed descriptions embed). Fire-and-forget: the first run after a
  // catalog change may select lexically while this catches up.
  void indexToolVectors(defs).catch(() => {});
  return defs;
}

/** Gate → call a wired connector tool through yo-server (which owns auth,
 *  role governance, and metering — a role change bites on the next call). */
async function executeConnectorWire(
  wc: WebContents,
  wired: { slug: string; tool: string },
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const action = {
    kind: (READ_TOOL_RE.test(wired.tool) ? "read" : "network") as GlyphhActionKind,
    title: `Call ${wired.slug} → ${wired.tool}`,
    detail: JSON.stringify(args, null, 1).slice(0, 500),
  };
  const gate = await gateGlyphhAction(wc, action);
  if (!gate.allowed) {
    return { result: `DENIED: ${gate.reason || "not allowed"}`, denied: true, title: action.title };
  }
  try {
    return { result: cap(await callConnectorTool(wired.slug, wired.tool, args)), denied: false, title: action.title };
  } catch (err) {
    return { result: `ERROR: ${err instanceof Error ? err.message : String(err)}`, denied: false, title: action.title };
  }
}

// create_app (the one-shot LLM builder) is retired — frontier agents build
// apps as real projects in the workspace and ship them with update_app.
const TOOLS: ToolDef[] = [
  // ── The semantic stack: per-app vector + knowledge-graph primitives the
  //    RAG and KG loops orchestrate (docs/semantic-stack.md). ──
  ...SEMANTIC_TOOLS.map((t): ToolDef => ({
    name: t.name,
    doc: t.doc,
    action: t.action,
    run: (args) => t.run(args),
  })),
  {
    name: "list_dir",
    doc: "list_dir(path?) — list a folder in the workspace (name, type, size)",
    action: (a) => {
      const { abs, escapes } = resolveReadPath(a.path);
      return escapes
        ? { kind: "dangerous" as const, title: `List ${abs}`, detail: `Outside your working folder — workspace tools are contained to ${workdir()}.` }
        : { kind: "read" as const, title: `List ${abs}` };
    },
    run: async (a) => {
      const { abs } = resolveReadPath(a.path);
      const rows = readdirSync(abs).slice(0, 400).map((n) => {
        try {
          const st = statSync(join(abs, n));
          return `${st.isDirectory() ? "d" : "-"} ${String(st.size).padStart(9)} ${n}`;
        } catch { return `?           ${n}`; }
      });
      return cap(rows.join("\n") || "(empty)");
    },
  },
  {
    name: "read_file",
    doc: "read_file(path) — read a file in the workspace (attached files too)",
    action: (a) => {
      const { abs, escapes } = resolveReadPath(a.path);
      return escapes
        ? { kind: "dangerous" as const, title: `Read ${abs}`, detail: `Outside your working folder — workspace tools are contained to ${workdir()}.` }
        : { kind: "read" as const, title: `Read ${abs}` };
    },
    run: async (a) => {
      const { abs } = resolveReadPath(a.path);
      return cap(readFileSync(abs, "utf8"), READ_CAP);
    },
  },
  {
    name: "write_file",
    doc: "write_file(path, content) — create or overwrite a file in the workspace",
    action: (a) => {
      const { abs, escapes } = resolvePath(a.path);
      const content = String(a.content ?? "");
      return {
        kind: escapes ? "dangerous" : "edit",
        title: `Write ${abs}`,
        detail: `${content.length} chars\n───\n${content.slice(0, 400)}${content.length > 400 ? "\n…" : ""}`,
      };
    },
    run: async (a) => {
      const { abs } = resolvePath(a.path);
      const content = String(a.content ?? "");
      // Line-count delta vs the prior file (if any) — the thread shows it as
      // "+N -M" next to the breadcrumb.
      let prevLines = 0;
      try { if (existsSync(abs)) prevLines = readFileSync(abs, "utf8").split("\n").length; } catch { /* new file */ }
      const nextLines = content ? content.split("\n").length : 0;
      const added = Math.max(0, nextLines - prevLines);
      const removed = Math.max(0, prevLines - nextLines);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return `wrote ${content.length} chars to ${abs} [+${added} -${removed}]`;
    },
  },
  {
    name: "search_files",
    doc: "search_files(pattern, path?) — grep the workspace (regex, case-insensitive)",
    action: (a) => {
      const { abs, escapes } = resolveReadPath(a.path);
      return escapes
        ? { kind: "dangerous" as const, title: `Search "${String(a.pattern ?? "")}" in ${abs}`, detail: `Outside your working folder — workspace tools are contained to ${workdir()}.` }
        : { kind: "read" as const, title: `Search "${String(a.pattern ?? "")}" in ${abs}` };
    },
    run: async (a) => {
      const { abs } = resolveReadPath(a.path);
      const pat = String(a.pattern ?? "").replace(/'/g, "'\\''");
      return runShell(`grep -rniI --exclude-dir=node_modules --exclude-dir=.git -m 5 '${pat}' . | head -80`, abs);
    },
  },
  {
    name: "semantic_search",
    doc: "semantic_search(query, k?) — meaning-based search over the indexed working folder. Finds code by INTENT (\"where do we validate cron ids\") and returns the exact file spans — use it FIRST on unfamiliar code, then read_file the spans it names. Sharper and far cheaper than grepping blind.",
    action: (a) => ({ kind: "read", title: `Semantic search "${String(a.query ?? "").slice(0, 60)}"` }),
    run: async (a) => {
      const query = String(a.query ?? "").trim();
      if (!query) return "ERROR: query is required";
      const root = workdir();
      const { semanticSearchWorkspace, refreshWorkspaceIndex, workspaceIndexSize } = await import("./workspace-index");
      if (!workspaceIndexSize(root)) await refreshWorkspaceIndex(root); // first touch — build it now
      const hits = await semanticSearchWorkspace(root, query, Math.max(1, Math.min(10, Number(a.k) || 5)));
      if (hits === null) return "semantic search unavailable (local runtime is down) — fall back to search_files";
      if (!hits.length) return "(no indexed matches — the folder may still be indexing; search_files works meanwhile)";
      return cap(hits.map((h) =>
        `${h.path}:${h.startLine}-${h.endLine} (${h.score.toFixed(2)})\n${h.text}`,
      ).join("\n\n---\n\n"));
    },
  },
  {
    name: "find_tools",
    doc: "find_tools(query, k?) — search ALL connected-account tools AND every desktop builtin (including ones not loaded for this session's space, e.g. rpa_*/scrape_page in a Code session) by meaning. When you need a tool that isn't wired, find it here, then run it with call_tool. Read-only.",
    action: (a) => ({ kind: "read", title: `Find tools "${String(a.query ?? "").slice(0, 60)}"` }),
    run: async (a) => {
      const query = String(a.query ?? "").trim();
      if (!query) return "ERROR: query is required";
      const k = Math.max(1, Math.min(20, Number(a.k) || 10));
      // The space packs exclude tools for PROMPT COST, not permission — the
      // hatch searches every builtin too, so a Code session can still lazily
      // reach rpa_*/scrape_page when a task genuinely needs them (each call
      // is gated on its own action, same as if it were preloaded).
      const builtinDefs: ConnectorWireDef[] = TOOLS
        .filter((t) => t.name !== "find_tools" && t.name !== "call_tool")
        .map((t) => ({ name: t.name, description: t.doc, inputSchema: {} }));
      const hits = (await rankConnectorTools(query, [...lastWireDefs, ...builtinDefs]))
        .filter((r) => r.score > 0).slice(0, k);
      if (!hits.length) return "(no connected-account or builtin tools match — the account may not be connected)";
      return cap(hits.map((r) => `${r.def.name} — ${r.def.description}`).join("\n"));
    },
  },
  {
    name: "fetch_connector_file",
    doc: "fetch_connector_file(app, url, filename) — download a FILE from a connected account onto THIS machine (saved under downloads/ in the working folder; returns the local path). 'app' is the connection slug (e.g. google_drive), 'url' the provider API url for the bytes — for Drive: https://www.googleapis.com/drive/v3/files/<id>?alt=media (add &supportsAllDrives=true for shared drives); for Docs/Sheets export use the /export endpoints. This is the ONLY way connector files reach local disk — connector download actions run in a remote sandbox and their files never land here.",
    action: (a) => ({ kind: "read", title: `Fetch file from ${String(a.app ?? "")}`, detail: String(a.url ?? "").slice(0, 300) }),
    run: async (a) => {
      const slug = String(a.app ?? "").trim().toLowerCase();
      const url = String(a.url ?? "").trim();
      const rawName = String(a.filename ?? "").trim();
      if (!slug || !url) return "ERROR: app and url are required";
      if (!rawName) return "ERROR: filename is required (what to save the file as)";
      // basename only — the tool decides the directory, not the model
      const fileName = basename(rawName).replace(/[^\w.\- ()]/g, "_");
      try {
        const out = await getClient().connections.fetchFile({ slug, url });
        const dir = join(workdir(), "downloads");
        mkdirSync(dir, { recursive: true });
        const dest = join(dir, fileName);
        writeFileSync(dest, Buffer.from(out.dataBase64, "base64"));
        return `saved ${out.bytes} bytes (${out.contentType || "unknown type"}) to ${dest}`;
      } catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  {
    name: "send_email_with_attachment",
    doc: "send_email_with_attachment(to, subject, body, file, cc?) — send an email from the user's connected Gmail with a LOCAL file as a REAL attachment (no link-sharing needed). 'file' is a path inside the working folder (e.g. one saved by fetch_connector_file). Use this instead of gmail-send-email whenever a local file must be attached — the connector's send runs in a remote sandbox and cannot see local files.",
    action: (a) => ({
      kind: "network",
      title: `Email ${String(a.to ?? "")} with ${String(a.file ?? "")}`,
      detail: `subject: ${String(a.subject ?? "").slice(0, 120)}`,
    }),
    run: async (a) => {
      const to = String(a.to ?? "").trim();
      const cc = String(a.cc ?? "").trim();
      const subject = String(a.subject ?? "").trim();
      const bodyText = String(a.body ?? "");
      const file = String(a.file ?? "").trim();
      if (!to || !subject || !file) return "ERROR: to, subject, and file are required";
      const abs = resolve(workdir(), file);
      // contained to the working folder, like every workspace file tool
      if (!abs.startsWith(workdir() + sep) && abs !== workdir()) return `ERROR: file must be inside the working folder (${workdir()})`;
      if (!existsSync(abs)) return `ERROR: no such file: ${abs}`;
      const bytes = readFileSync(abs);
      if (bytes.length > 20 * 1024 * 1024) return `ERROR: attachment is ${bytes.length} bytes — over the 20MB cap`;
      const name = basename(abs);
      const ctype = MIME_BY_EXT[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
      // RFC822 multipart, fully ASCII (headers + base64 lines) — text-safe for
      // the proxy-send body contract.
      const boundary = `glyphh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const b64 = bytes.toString("base64").replace(/(.{76})/g, "$1\r\n");
      const mime = [
        `To: ${to}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        `Subject: ${subject.replace(/[\r\n]/g, " ")}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "",
        bodyText,
        "",
        `--${boundary}`,
        `Content-Type: ${ctype}; name="${name}"`,
        `Content-Disposition: attachment; filename="${name}"`,
        "Content-Transfer-Encoding: base64",
        "",
        b64,
        `--${boundary}--`,
        "",
      ].join("\r\n");
      try {
        const out = await getClient().connections.proxySend({
          slug: "gmail",
          url: "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media",
          contentType: "message/rfc822",
          bodyBase64: Buffer.from(mime, "utf8").toString("base64"),
        });
        if (out.status >= 300) return `ERROR: Gmail send failed (${out.status}): ${Buffer.from(out.dataBase64, "base64").toString("utf8").slice(0, 400)}`;
        return `sent to ${to} with ${name} attached (${bytes.length} bytes)`;
      } catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  {
    name: "call_tool",
    doc: "call_tool(name, arguments?) — run a tool by its exact find_tools name: a connected-account tool, or a desktop builtin that isn't loaded for this session's space. arguments must match the tool's doc.",
    // Gate on the INNER tool, exactly like a directly-wired call — a builtin
    // delegates to its own action() so an rpa_click gates as an rpa_click,
    // and connector reads pass quietly while sends/creates/deletes prompt.
    action: (a) => {
      const inner = String(a.name ?? "");
      const wired = wireMap.get(inner);
      if (!wired) {
        const builtin = TOOLS.find((t) => t.name === inner && t.name !== "call_tool");
        if (builtin) return builtin.action((a.arguments ?? {}) as Record<string, unknown>);
      }
      return {
        kind: (wired && READ_TOOL_RE.test(wired.tool) ? "read" : "network") as GlyphhActionKind,
        title: wired ? `Call ${wired.slug} → ${wired.tool}` : `Call ${inner}`,
        detail: JSON.stringify(a.arguments ?? {}, null, 1).slice(0, 500),
      };
    },
    run: async (a) => {
      const inner = String(a.name ?? "");
      const wired = wireMap.get(inner);
      if (wired) return cap(await callConnectorTool(wired.slug, wired.tool, (a.arguments ?? {}) as Record<string, unknown>));
      const builtin = TOOLS.find((t) => t.name === inner && t.name !== "call_tool" && t.name !== "find_tools");
      if (builtin) return builtin.run((a.arguments ?? {}) as Record<string, unknown>);
      return `ERROR: unknown tool "${inner}" — use find_tools to get the exact name`;
    },
  },
  {
    name: "run_command",
    doc: "run_command(command) — run a shell command in the working folder (60s cap)",
    // (title carries the command so the thread's run card shows WHAT ran)
    action: (a) => {
      const cmd = String(a.command ?? "");
      const why = dangerReasons(cmd);
      // The detail leads with WHY it was flagged, then the command itself.
      return why.length
        ? { kind: "dangerous" as const, title: `Run: ${cmd.slice(0, 80)}`, detail: `Flagged: ${why.join("; ")}\n\n${cmd}` }
        : { kind: "command" as const, title: `Run: ${cmd.slice(0, 80)}`, detail: cmd };
    },
    run: async (a, signal) => runShell(String(a.command ?? ""), workdir(), signal),
  },
  {
    name: "update_app",
    doc: "update_app() — build-then-ship the app in the working folder: packages the compiled dist/ (Vite project) or the folder's files (legacy single-file app) and installs it. For a Vite project, run `npm run build` FIRST. Call after every change or tool calls run the OLD version",
    action: () => ({ kind: "edit", title: "Update app from source" }),
    run: async () => {
      // Declared-connector validation reads the governed catalog (fresh at
      // agent-run start via connectorWireTools; refresh here if stale).
      if (getCatalogAge() > CATALOG_STALE_MS) {
        try { await refreshConnectorCatalog(); } catch { /* offline — validate with what we have */ }
      }
      const lookup = (slug: string) => {
        const names = getConnectorCatalog().filter((t) => t.slug === slug).map((t) => t.name);
        return names.length ? names : null;
      };
      const r = await updateAppFromWorkdir(lookup);
      return `updated "${r.name}" (${r.slug}) from source${r.warnings.length ? ` — notes: ${r.warnings.slice(0, 3).join("; ")}` : ""}. Its tools now match the edited files.`;
    },
  },
  // NO `deploy_app` HERE, deliberately. Publishing belongs to the control
  // plane, and the pod now lends itself that surface (rrotor glyphh-apps.ts →
  // POST /api/runtime/mcp) on the desktop and in the cloud alike. A second,
  // desktop-only `deploy_app` that took no arguments and read the working
  // folder would put two tools of the same NAME and different SHAPES into one
  // toolset — precisely the desktop/cloud divergence that left a cloud agent
  // unable to publish at all. `deployAppFromWorkdir` still backs the Releases
  // tab's button (apps-ipc.ts); it is simply not an agent tool any more.
  {
    name: "git_init",
    doc: "git_init() — version-control the working folder: init the repo (if needed), write a .gitignore (node_modules/, dist/, .env), ensure a git identity, and make the first commit. Call this BEFORE building a new app.",
    action: () => ({ kind: "command", title: "Git init + first commit" }),
    run: async () => {
      const wd = workdir();
      // Idempotent — never clobbers an existing repo or a hand-written ignore.
      const already = (await runShell("git rev-parse --is-inside-work-tree 2>/dev/null", wd)).trim() === "true";
      if (!already) await runShell("git init -q", wd);
      const ignorePath = join(wd, ".gitignore");
      if (!existsSync(ignorePath)) writeFileSync(ignorePath, APP_GITIGNORE, "utf8");
      // Repo-local identity only when the machine has none — never overrides a
      // real global config the user set.
      const haveName = (await runShell("git config user.name 2>/dev/null", wd)).trim();
      if (!haveName) {
        await runShell("git config user.name 'Glyphh Agent' && git config user.email 'agent@glyphh.local'", wd);
      }
      if (already) return "repo already initialized — .gitignore ensured. Work on a branch (git_branch) and commit in small steps.";
      return runShell(`git add -A && git commit -q -m ${JSON.stringify("Initial commit")} && git log --oneline -n 1`, wd);
    },
  },
  {
    name: "git_status",
    doc: "git_status() — branch + changed files in the working folder",
    action: () => ({ kind: "read", title: "Git status" }),
    run: async () => runShell("git status --porcelain=v1 -b", workdir()),
  },
  {
    name: "git_branch",
    doc: "git_branch(name?) — with a name, create+switch to it (branch-first: never build on the default branch); without, list branches",
    action: (a) => ({ kind: a.name ? "command" : "read", title: a.name ? `Git branch ${String(a.name)}` : "Git branches" }),
    run: async (a) => {
      const wd = workdir();
      const raw = String(a.name ?? "").trim();
      if (!raw) return runShell("git branch -vv", wd);
      // Slugify to a safe ref (no spaces/quotes/control chars).
      const name = raw.replace(/[^a-zA-Z0-9._/-]+/g, "-").replace(/^[-/]+|[-/]+$/g, "").slice(0, 80);
      if (!name) return "ERROR: branch name has no usable characters";
      // Switch if it exists, else create — either way end up ON the branch.
      return runShell(`git switch ${JSON.stringify(name)} 2>/dev/null || git switch -c ${JSON.stringify(name)}`, wd);
    },
  },
  {
    name: "git_diff",
    doc: "git_diff(path?, staged?) — unified diff of working-tree (or staged) changes",
    action: (a) => ({ kind: "read", title: `Git diff${a.path ? ` ${String(a.path)}` : ""}` }),
    run: async (a) => {
      const p = String(a.path ?? "").replace(/'/g, "");
      return runShell(`git diff ${a.staged ? "--staged " : ""}${p ? `-- '${p}'` : ""} | head -400`, workdir());
    },
  },
  {
    name: "git_log",
    doc: "git_log(n?) — recent commits (oneline)",
    action: () => ({ kind: "read", title: "Git log" }),
    run: async (a) => runShell(`git log --oneline -n ${Math.max(1, Math.min(50, Number(a.n) || 10))}`, workdir()),
  },
  {
    name: "git_commit",
    doc: "git_commit(message, paths?) — stage (given paths, or everything tracked+new) and commit. Build artifacts (node_modules/, dist/) are ignored via .gitignore — run git_init first so they never get staged.",
    action: (a) => ({ kind: "command", title: "Git commit", detail: String(a.message ?? "") }),
    run: async (a) => {
      const wd = workdir();
      const msg = String(a.message ?? "").trim();
      if (!msg) return "ERROR: commit message is required";
      const isRepo = (await runShell("git rev-parse --is-inside-work-tree 2>/dev/null", wd)).trim() === "true";
      if (!isRepo) return "ERROR: not a git repository — call git_init() first (it sets up the repo + .gitignore).";
      // Guard: an `add -A` with no .gitignore would stage node_modules/dist.
      // Refuse rather than poison history — git_init writes the ignore file.
      if (!Array.isArray(a.paths) && !existsSync(join(wd, ".gitignore"))) {
        return "ERROR: no .gitignore — call git_init() first so node_modules/ and dist/ aren't committed (or pass explicit paths).";
      }
      const paths = Array.isArray(a.paths) ? (a.paths as unknown[]).map((p) => `'${String(p).replace(/'/g, "")}'`).join(" ") : "";
      return runShell(`git add ${paths || "-A"} && git commit -m ${JSON.stringify(msg)}`, wd);
    },
  },
  {
    name: "open_app",
    doc: "open_app(name) — open an INSTALLED app from the user's library (or 'terminal') as a panel beside this conversation. To show something you built or deployed, use open_browser(url) instead — the user wants the browser surface for previews, not the raw app panel.",
    action: (a) => ({ kind: "command", title: `Open app "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const r = await openAppByRef(String(a.name ?? ""));
      return `opened ${r.name} (${r.slug})`;
    },
  },
  {
    name: "open_browser",
    doc: "open_browser(url) — open the tabbed Browser panel at a URL beside this conversation (address bar, tabs, DevTools). THE way to show a built or deployed app: after build_app publishes it, open the returned <slug>.glyphh.app URL here. Falls back: if the page needs a login the embedded browser doesn't have (a non-public app), open the installed app with open_app instead.",
    action: (a) => ({ kind: "command", title: `Open browser at ${String(a.url ?? "")}` }),
    run: async (a) => {
      const url = String(a.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) return "ERROR: url must start with http:// or https://";
      openBrowserAt(url);
      return `opened the Browser panel at ${url}`;
    },
  },
  {
    name: "list_windows",
    doc: "list_windows() — the app panels currently open beside this conversation",
    action: () => ({ kind: "read", title: "List open windows" }),
    run: async () => cap(JSON.stringify(await listOpenAppWindows(), null, 1)),
  },
  // ── RPA — drive an open app panel (the same handlers the attach socket and
  // loopback MCP expose, invoked here directly on-machine). ──
  {
    name: "rpa_read",
    doc: "rpa_read(app, selector?, as?) — read text (default) or html ('as':'html') from an open app panel; a CSS 'selector' or the whole page. 'app' is the panel slug from list_windows.",
    action: (a) => ({ kind: "read", title: `Read ${String(a.selector || "page")} in ${String(a.app ?? "")}` }),
    run: async (a) => cap(JSON.stringify(await dispatchRelayMethod("rpa.read", a), null, 1)),
  },
  {
    name: "rpa_click",
    doc: "rpa_click(app, selector?|x?,y?) — click inside an open app panel: a CSS 'selector' or absolute 'x'/'y' coords. Open the panel first with open_app.",
    action: (a) => ({ kind: "network", title: `Click ${String(a.selector || `${a.x},${a.y}`)} in ${String(a.app ?? "")}` }),
    run: async (a) => cap(JSON.stringify(await dispatchRelayMethod("rpa.click", a), null, 1)),
  },
  {
    name: "rpa_type",
    doc: "rpa_type(app, selector, text, submit?) — type into an element in an open app panel; set submit:true to submit its form.",
    action: (a) => ({ kind: "network", title: `Type into ${String(a.selector ?? "")} in ${String(a.app ?? "")}` }),
    run: async (a) => cap(JSON.stringify(await dispatchRelayMethod("rpa.type", a), null, 1)),
  },
  {
    name: "rpa_goto",
    doc: "rpa_goto(app, url) — navigate an open app panel to an http(s) URL.",
    action: (a) => ({ kind: "network", title: `Navigate ${String(a.app ?? "")} → ${String(a.url ?? "")}` }),
    run: async (a) => cap(JSON.stringify(await dispatchRelayMethod("rpa.goto", a), null, 1)),
  },
  {
    name: "scrape_page",
    doc: "scrape_page(url, wait?) — load an http(s) URL headlessly (no visible panel) and return its title, text, and html. 'wait' ms (≤15000) for JS-rendered pages.",
    action: (a) => ({ kind: "network", title: `Scrape ${String(a.url ?? "")}` }),
    run: async (a) => cap(JSON.stringify(await dispatchRelayMethod("scrape.page", a), null, 1)),
  },
  {
    name: "list_workspaces",
    doc: "list_workspaces() — the user's saved workspaces (open one with open_workspace)",
    action: () => ({ kind: "read", title: "List workspaces" }),
    run: async () => {
      const layouts = await fetchServerLayouts();
      return cap(layouts.map((l) => `${l.name}${l.cols && l.rows ? ` (${l.cols}×${l.rows})` : ""}`).join("\n") || "(none saved)");
    },
  },
  {
    name: "open_workspace",
    doc: "open_workspace(name) — open a saved workspace: its apps tile as panels beside this conversation",
    action: (a) => ({ kind: "command", title: `Open workspace "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const r = await openLayoutByName(String(a.name ?? ""));
      return `opened workspace ${r.layout} — apps: ${r.apps.join(", ")}`;
    },
  },
  {
    name: "save_workspace",
    doc: 'save_workspace(name, cols, rows, cells, loop?, modelSelections?, sessionMode?, folder?) — create or update a saved workspace. cells: [{panelId, col, row, colSpan?, rowSpan?, sticky?, config?}]. panelId = an app slug from the library, or a tool: id — tool:coding (the agent), tool:preview (Browser), tool:terminal, tool:files, tool:monaco (Editor), tool:diff, tool:plan. Per-cell config: Browser cells take {url}; Terminal cells take {cmd} (runs after the working folder is set). At most ONE cell sticky:true (where .dip/app opens land). sessionMode: "keep"|"new"|"last". folder: absolute path the workspace switches the agent to on open.',
    action: (a) => ({ kind: "edit", title: `Save workspace "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const name = String(a.name ?? "").trim();
      if (!name) return "ERROR: name is required";
      const cols = Math.max(1, Math.min(25, Number(a.cols) || 1));
      const rows = Math.max(1, Math.min(25, Number(a.rows) || 1));
      const rawCells = Array.isArray(a.cells) ? (a.cells as Array<Record<string, unknown>>) : [];
      if (!rawCells.length) return "ERROR: cells is required — at least one panel";
      const cells = rawCells.map((c) => {
        const cfg = (c.config ?? {}) as { url?: unknown; cmd?: unknown };
        const config: { url?: string; cmd?: string } = {};
        if (typeof cfg.url === "string" && cfg.url) config.url = cfg.url;
        if (typeof cfg.cmd === "string" && cfg.cmd) config.cmd = cfg.cmd;
        return {
          panelId: String(c.panelId ?? ""),
          col: Math.max(0, Number(c.col) || 0),
          row: Math.max(0, Number(c.row) || 0),
          colSpan: Math.max(1, Number(c.colSpan) || 1),
          rowSpan: Math.max(1, Number(c.rowSpan) || 1),
          ...(c.sticky ? { sticky: true } : {}),
          ...(Object.keys(config).length ? { config } : {}),
        };
      });
      if (cells.some((c) => !c.panelId)) return "ERROR: every cell needs a panelId";
      if (cells.filter((c) => c.sticky).length > 1) return "ERROR: at most one cell may be sticky";
      const client = getClient();
      const body: Record<string, unknown> = {
        name, cols, rows, cells,
        folderMode: "single",
        target: "glyphh",
        ...(typeof a.loop === "string" && a.loop ? { loop: a.loop } : {}),
        ...(a.modelSelections && typeof a.modelSelections === "object" ? { modelSelections: a.modelSelections } : {}),
        ...(a.sessionMode === "new" || a.sessionMode === "last" ? { sessionMode: a.sessionMode } : {}),
        ...(typeof a.folder === "string" && a.folder ? { folder: a.folder } : {}),
      };
      const existing = (await client.layouts.list()).find((it) => it.name.toLowerCase() === name.toLowerCase());
      const saved = await client.layouts.save({ name, data: body, ...(existing ? { id: existing.id } : {}) });
      appCache.invalidate("/api/layouts");
      return `saved ✓ workspace "${name}" (${cols}×${rows}, ${cells.length} panels)${existing ? " — updated" : ""}. Open it with open_workspace("${saved.name ?? name}").`;
    },
  },
  {
    name: "ask_user",
    doc: "ask_user(questions) — put real questions to the user and WAIT for answers. questions: [{question, options?: string[]}] (max 4 per call; options ≤ 5, short labels — the user can always type a custom answer instead). Use when a decision is genuinely the user's: ambiguous requirements, a fork in the design, destructive trade-offs. Returns the answers in order; an empty answer means the user skipped it.",
    action: (a) => {
      const qs = Array.isArray(a.questions) ? (a.questions as Array<{ question?: unknown }>) : [];
      const first = String(qs[0]?.question ?? "").slice(0, 80);
      return { kind: "read", title: qs.length > 1 ? `Ask: ${first} (+${qs.length - 1} more)` : `Ask: ${first}` };
    },
    run: async (a, _signal, wc) => {
      if (!wc) return "ERROR: no panel available to ask";
      const raw = Array.isArray(a.questions) ? (a.questions as Array<Record<string, unknown>>) : [];
      const questions = raw
        .map((q) => ({
          question: String(q.question ?? "").trim().slice(0, 500),
          options: Array.isArray(q.options)
            ? (q.options as unknown[]).map((o) => String(o).slice(0, 120)).filter(Boolean).slice(0, 5)
            : undefined,
        }))
        .filter((q) => q.question)
        .slice(0, 4);
      if (!questions.length) return "ERROR: questions is required — [{question, options?}]";
      const answers = await askUserQuestions(wc, questions);
      if (!answers.length) return "(the user did not answer — proceed with your best judgment and say what you assumed)";
      return questions.map((q, i) => `Q: ${q.question}\nA: ${answers[i] || "(skipped)"}`).join("\n\n");
    },
  },
  {
    name: "connect_account",
    doc: "connect_account(app) — the user needs an account that ISN'T connected yet (e.g. they asked to use X and list_connections shows nothing): looks <app> up in the connector catalog and shows a CONNECT card right in the chat; the user authorizes inline — never leaving the thread — and this returns once they're connected (or declined). After success the account's tools are reachable via find_tools/call_tool. Check list_connections first; never ask the user to visit the Connections page.",
    action: (a) => ({ kind: "read", title: `Offer to connect ${String(a.app ?? "")}` }),
    run: async (a, _signal, wc) => {
      if (!wc) return "ERROR: no panel available";
      const q = String(a.app ?? "").trim();
      if (!q) return "ERROR: app is required (e.g. 'slack', 'notion')";
      const needle = q.toLowerCase();
      // already connected? (both axes — see list_connections)
      const [org, personal] = await Promise.all([
        getClient().connections.list().catch(() => []),
        getClient().connections.personalList().catch(() => []),
      ]);
      const existing = [...org, ...personal].find((c) => {
        const cc = c as { slug?: string; name?: string; appSlug?: string };
        return [cc.slug, cc.name, cc.appSlug].some((v) => (v || "").toLowerCase().includes(needle));
      });
      if (existing) {
        const ex = existing as { slug?: string; name?: string };
        return `already connected: ${ex.name || ex.slug} — its tools are available via find_tools/call_tool.`;
      }
      // catalog lookup
      const { apps } = await getClient().connections.apps({ search: q, limit: 6 }).catch(() => ({ apps: [] as Array<{ id: string; name: string; icon: string | null }> }));
      const best = apps.find((x) => x.id.toLowerCase() === needle || x.name.toLowerCase() === needle)
        ?? apps.find((x) => x.name.toLowerCase().includes(needle) || x.id.toLowerCase().includes(needle))
        ?? apps[0];
      if (!best) return `no connector exists for "${q}" in the catalog.`;
      const res = await requestInlineConnect(wc, { appId: best.id, name: best.name, icon: best.icon });
      return res.connected
        ? `connected: ${best.name} (${best.id}). Its tools are now available — use find_tools to discover them, call_tool to run them.`
        : `the user did not complete the ${best.name} connection (${res.reason || "declined"}). Do not retry unprompted.`;
    },
  },
  {
    name: "list_connections",
    doc: "list_connections() — the user's connected accounts (Slack, GitHub, …)",
    action: () => ({ kind: "read", title: "List connections" }),
    run: async () => {
      // BOTH axes, or the answer lies: /api/connections is ORG-SHARED only —
      // a user whose six Google accounts are all PERSONAL heard "(no connected
      // accounts)" from this tool while everything was connected and healthy.
      const [org, personal] = await Promise.all([
        getClient().connections.list().catch(() => []),
        getClient().connections.personalList().catch(() => []),
      ]);
      // Connections are PER USER + PER ORG — the classic support ticket is a
      // user who connected an account in the browser as one identity and asks
      // the agent as another. Always say WHO was checked, so an empty list
      // reads as "wrong identity", never "production is broken".
      const acct = getAccountInfo();
      const who = acct ? `${acct.email}${acct.orgName ? ` in ${acct.orgName}` : ""}` : "the signed-in account";
      const rows = [
        ...personal.map((c) => `${c.appSlug || "?"} (${c.appName || c.label || "?"}) — personal`),
        ...org.map((c) => `${c.slug || "?"} (${c.name || "?"}) — org-shared${c.enabled ? "" : " — DISABLED"}`),
      ];
      if (!rows.length) {
        return `(no connected accounts for ${who} — connections are per account + per organization; connect from THIS app's Connections page, or switch to the account that holds them)`;
      }
      return cap(`Connected accounts for ${who}:\n${rows.join("\n")}`);
    },
  },
  {
    name: "list_active_agents",
    doc: "list_active_agents() — every coding/CLI agent alive on this machine right now: desktop sessions (title, folder, running or idle) and CLI agent instances (pid, folder). THE map of your peers — read it before dividing work across sessions or folders.",
    action: () => ({ kind: "read", title: "List active agents" }),
    run: async () => {
      const lines: string[] = [];
      // Desktop sessions — the store names them; the run registry marks live ones.
      try {
        const { loadSessions } = await import("./glyphh-agent-context");
        const { chats, currentId } = loadSessions();
        for (const chat of chats.slice(0, 30)) {
          const run = activeAgentRuns.get(chat.id);
          const state = run ? `RUNNING (${Math.round((Date.now() - run.startedAt) / 1000)}s, ${run.workdir})` : "idle";
          lines.push(`desktop session "${chat.title}" [${chat.id}]${chat.id === currentId ? " (current)" : ""} — ${state}`);
        }
      } catch { /* no session store yet */ }
      // CLI agents — each instance owns agent-config-cli/i-<pid>; a live pid = a live agent.
      try {
        const { join: pjoin } = await import("node:path");
        const { homedir } = await import("node:os");
        const base = pjoin(process.env.GLYPHH_HOME ?? pjoin(homedir(), ".glyphh"), "agent-config-cli");
        for (const d of readdirSync(base)) {
          const m = /^i-(\d+)$/.exec(d);
          if (!m) continue;
          const pid = Number(m[1]);
          try { process.kill(pid, 0); } catch { continue; }   // dead — sweep handles it
          let cwd = "";
          try {
            const sess = pjoin(base, d, "sessions");
            for (const f of readdirSync(sess)) {
              const j = JSON.parse(readFileSync(pjoin(sess, f), "utf8")) as { cwd?: string };
              if (j?.cwd) { cwd = j.cwd; break; }
            }
          } catch { /* no session file yet */ }
          lines.push(`cli agent pid ${pid}${cwd ? ` — ${cwd}` : ""} — RUNNING`);
        }
      } catch { /* no CLI instances */ }
      return cap(lines.join("\n") || "(no other agents are alive right now)");
    },
  },
  {
    name: "run_role",
    doc: "run_role(role, task, context?) — delegate a work packet to another role of the ACTIVE loop: it runs as a bounded tool-using sub-run on the model the USER bound to that role (your system prompt lists the active loop's roles). When the loop assigns a kind of work to another role — e.g. build/implementation packets to a 'builder' or 'worker' — route it here AUTOMATICALLY instead of doing it yourself; those bindings are why the user picked the loop. Tools inside the packet gate/approve exactly like your own.",
    action: (a) => ({
      kind: "command",
      title: `Delegate to ${String(a.role ?? "")} role`,
      detail: String(a.task ?? "").slice(0, 500),
    }),
    run: (a, signal, wc) =>
      runRolePacket(String(a.role ?? ""), String(a.task ?? ""), String(a.context ?? ""), signal, wc),
  },
  // ── The LIBRARY: loops, skills, agents — the objects /create-* authors. ────
  // Without these the create-skill/loop/agent prompts said "save through the
  // API" while the agent had no API tools at all — so it went spelunking
  // through the user's filesystem looking for a "source tree" that does not
  // exist. These objects live in the DB behind the SDK; these are the doors.
  {
    name: "loops_list",
    doc: "loops_list() — every loop (built-ins + the org's own): slug, name, description",
    action: () => ({ kind: "read", title: "List loops" }),
    run: async () => {
      const { loops } = await getClient().loops.list();
      return cap(JSON.stringify(loops.map((l) => ({ slug: l.slug, name: l.name, description: l.description, builtIn: l.builtIn })), null, 2));
    },
  },
  {
    name: "loops_get",
    doc: 'loops_get(slug) — one loop\'s full manifest + program source. loops_get("default") is the documented example to base new loops on',
    action: (a) => ({ kind: "read", title: `Read loop ${String(a.slug ?? "")}` }),
    run: async (a) => cap(JSON.stringify(await getClient().loops.get(String(a.slug ?? "default")), null, 2)),
  },
  {
    name: "loops_save",
    doc: 'loops_save(slug, name, description?, manifest?, code?) — create or update a loop. manifest: {roles:[{name,label,description}], skills:[], connections:[], memory:{read,write}}; code: the .js program (export async function start(ctx))',
    action: (a) => ({ kind: "edit", title: `Save loop ${String(a.slug ?? "")}` }),
    run: async (a) => {
      const client = getClient();
      const slug = String(a.slug ?? "");
      if (!slug) return "ERROR: slug is required";
      const input = {
        slug,
        name: String(a.name ?? slug),
        ...(a.description !== undefined ? { description: String(a.description) } : {}),
        ...(a.manifest !== undefined ? { manifest: a.manifest as Record<string, unknown> } : {}),
        ...(a.code !== undefined ? { code: String(a.code) } : {}),
      };
      const existing = await client.loops.get(slug).catch(() => null);
      const saved = existing && !existing.builtIn
        ? await client.loops.update(slug, input)
        : await client.loops.create(input);
      return cap(`saved ✓ loop "${saved.slug}" (${saved.name})`);
    },
  },
  {
    name: "skills_list",
    doc: "skills_list() — every skill (built-ins + the org's own): slug, name, description",
    action: () => ({ kind: "read", title: "List skills" }),
    run: async () => {
      const skills = await getClient().skills.list();
      return cap(JSON.stringify(skills.map((s) => ({ slug: s.slug, name: s.name, description: s.description, builtIn: s.builtIn ?? false })), null, 2));
    },
  },
  {
    name: "skills_get",
    doc: "skills_get(slug) — one skill's manifest, prompt, and program",
    action: (a) => ({ kind: "read", title: `Read skill ${String(a.slug ?? "")}` }),
    run: async (a) => cap(JSON.stringify(await getClient().skills.get(String(a.slug ?? "")), null, 2)),
  },
  {
    name: "skills_save",
    doc: 'skills_save(slug, name, description?, manifest?, prompt?, code?) — create or update a skill. manifest: {whenToUse, allowedTools:[], requires:[], schedule?, model?}; prompt: the markdown instruction body; code optional',
    action: (a) => ({ kind: "edit", title: `Save skill ${String(a.slug ?? "")}` }),
    run: async (a) => {
      const client = getClient();
      const slug = String(a.slug ?? "");
      if (!slug) return "ERROR: slug is required";
      const input = {
        slug,
        name: String(a.name ?? slug),
        ...(a.description !== undefined ? { description: String(a.description) } : {}),
        ...(a.manifest !== undefined ? { manifest: a.manifest as Record<string, unknown> } : {}),
        ...(a.prompt !== undefined ? { prompt: String(a.prompt) } : {}),
        ...(a.code !== undefined ? { code: String(a.code) } : {}),
      };
      const existing = await client.skills.get(slug).catch(() => null);
      const saved = existing && !(existing as { builtIn?: boolean }).builtIn
        ? await client.skills.update(slug, input)
        : await client.skills.create(input);
      return cap(`saved ✓ skill "${saved.slug}" (${saved.name})`);
    },
  },
  {
    name: "agents_list",
    doc: "agents_list() — the org's agents: slug, name, loop, live",
    action: () => ({ kind: "read", title: "List agents" }),
    run: async () => {
      const agents = await getClient().agents.list();
      return cap(JSON.stringify(agents.map((x) => ({ id: x.id, slug: x.slug, name: x.name, loopId: x.loopId, live: x.live })), null, 2));
    },
  },
  {
    name: "agents_save",
    doc: 'agents_save(slug, name, description?, loopSlug?, selections?, guardrails?, live?) — create or update a standing agent. selections: {roles:{roleName:modelId}, skills:[]} within the loop\'s offer; guardrails: upper bounds (maxOutputTokens, windowCalls, maxConcurrent)',
    action: (a) => ({ kind: "edit", title: `Save agent ${String(a.slug ?? "")}` }),
    run: async (a) => {
      const client = getClient();
      const slug = String(a.slug ?? "");
      if (!slug) return "ERROR: slug is required";
      let loopId: string | null = null;
      const loopSlug = a.loopSlug !== undefined ? String(a.loopSlug) : "";
      if (loopSlug && loopSlug !== "default") {
        const loop = await client.loops.get(loopSlug).catch(() => null);
        if (!loop) return `ERROR: no loop "${loopSlug}" — loops_list() shows what exists`;
        loopId = loop.builtIn ? null : loop.id;
      }
      const input = {
        slug,
        name: String(a.name ?? slug),
        ...(a.description !== undefined ? { description: String(a.description) } : {}),
        loopId,
        ...(a.selections !== undefined ? { selections: a.selections as Record<string, unknown> } : {}),
        ...(a.guardrails !== undefined ? { guardrails: a.guardrails as Record<string, unknown> } : {}),
        ...(a.live !== undefined ? { live: Boolean(a.live) } : {}),
      };
      const existing = (await client.agents.list()).find((x) => x.slug === slug);
      const saved = existing
        ? await client.agents.update(existing.id, input)
        : await client.agents.create(input);
      return cap(`saved ✓ agent "${saved.slug}" (${saved.name})${saved.live ? " — live" : ""}`);
    },
  },
  {
    name: "agent_task_add",
    doc: 'agent_task_add(agentSlug, name, kind, target, cron, args?) — bind a schedule to an agent. kind: "skill"|"loop"|"app_command"; target: the slug; cron: five fields ("0 8 * * *")',
    action: (a) => ({ kind: "edit", title: `Schedule task on ${String(a.agentSlug ?? "")}` }),
    run: async (a) => {
      const client = getClient();
      const agent = (await client.agents.list()).find((x) => x.slug === String(a.agentSlug ?? ""));
      if (!agent) return `ERROR: no agent "${String(a.agentSlug ?? "")}" — agents_list() shows what exists`;
      const task = await client.agents.addTask(agent.id, {
        name: String(a.name ?? "task"),
        kind: (a.kind === "loop" || a.kind === "app_command" ? a.kind : "skill"),
        target: String(a.target ?? ""),
        cron: String(a.cron ?? ""),
        args: (a.args ?? {}) as Record<string, unknown>,
      });
      return cap(`scheduled ✓ "${task.name}" — ${task.kind}:${task.target} @ ${task.cron}`);
    },
  },
  {
    name: "list_drips",
    doc: "list_drips() — available drip effects (fun visual overlays)",
    action: () => ({ kind: "read", title: "List drips" }),
    run: async () => {
      const customs = getDripManagerInstance()?.listCustoms() ?? [];
      return cap(`built-in: ${BUILTIN_EFFECTS.join(", ")}${customs.length ? `\ncustom: ${customs.map((c) => c.name).join(", ")}` : ""}`);
    },
  },
  {
    name: "run_drip",
    doc: "run_drip(effect?) — play a drip effect over the screen (celebration!)",
    action: (a) => ({ kind: "command", title: `Play drip${a.effect ? ` "${String(a.effect)}"` : ""}` }),
    run: async (a) => {
      const dm = getDripManagerInstance();
      if (!dm) return "ERROR: drips unavailable";
      const out = dm.execute(String(a.effect ?? "").trim().split(/\s+/).filter(Boolean));
      return out || "playing";
    },
  },
  {
    name: "ada_remember",
    doc: "ada_remember(fact, key?) — store a fact in Ada (schema-on-write memory; same key = new version)",
    action: (a) => ({ kind: "edit", title: "Remember fact", detail: String(a.fact ?? "").slice(0, 300) }),
    run: async (a) => {
      const fact = String(a.fact ?? "").trim();
      if (!fact) return "ERROR: fact is required";
      const facts = await enrichFact(fact);
      const r = adaTellRaw(fact, facts, { key: a.key ? String(a.key) : undefined, speaker: "glyphh" });
      return `remembered (${r.slots} slots${r.version ? `, v${r.version}` : ""})`;
    },
  },
  {
    name: "ada_ask",
    doc: "ada_ask(op) — exact query over Ada's facts. op ∈ {lookup(person,slot), prev(person,slot), count(conditions), count_not(slot,value), top(slot,k?), who(conditions), compare(slot,a,b)}; slots are layer.role (entity.kind, spatial.location, relational.object, …)",
    action: () => ({ kind: "read", title: "Ask Ada" }),
    run: async (a) => {
      // Models often send bare {person, slot} (or the args object itself) with
      // no `op` — infer the obvious lookup rather than failing the turn; only
      // a truly unusable call gets the corrective example back.
      const raw = (a.op ?? a) as Partial<AdaOp> & Record<string, unknown>;
      const op = raw && typeof raw === "object" && typeof raw.op === "string"
        ? raw
        : (raw?.person && raw?.slot ? { ...raw, op: "lookup" } : null);
      if (!op) {
        return "ERROR: ada_ask needs an op — e.g. {op:\"lookup\", person:\"chris\", slot:\"entity.kind\"}. Valid ops: lookup, prev, count, count_not, top, who, compare. For free-text questions use ada_recall(query) instead.";
      }
      try { return adaExecuteOp(op as AdaOp); }
      catch (err) { return `ERROR: ${err instanceof Error ? err.message : String(err)}`; }
    },
  },
  {
    name: "ada_recall",
    doc: "ada_recall(query, k?) — lexical recall of stored facts (exact prose back, scored)",
    action: (a) => ({ kind: "read", title: `Recall "${String(a.query ?? "").slice(0, 60)}"` }),
    run: async (a) => {
      const hits = adaRecall(String(a.query ?? ""), Math.max(1, Math.min(10, Number(a.k) || 5)));
      return cap(hits.map((h) => `${h.score.toFixed(2)} ${h.content}`).join("\n") || "(nothing recalled)");
    },
  },
  {
    name: "ada_history",
    doc: "ada_history(key) — the versioned chain of a keyed fact (v1, v2, …)",
    action: (a) => ({ kind: "read", title: `History of "${String(a.key ?? "")}"` }),
    run: async (a) => {
      const rows = adaHistory(String(a.key ?? ""));
      return cap(rows.map((r) => `v${r.version}: ${r.content}`).join("\n") || "(no versions)");
    },
  },
  {
    name: "app_list_tools",
    doc: "app_list_tools() — the MCP tools the user's installed Glyphh apps expose (call with app_call_tool)",
    action: () => ({ kind: "read", title: "List installed app tools" }),
    run: async () => cap(JSON.stringify(listInstalledAppTools(), null, 1)),
  },
  {
    name: "app_call_tool",
    doc: "app_call_tool(app, tool, arguments?) — run an installed Glyphh app's tool headlessly (send a message, create an event, …)",
    action: (a) => ({
      kind: READ_TOOL_RE.test(String(a.tool ?? "")) ? "read" : "command",
      title: `Run ${String(a.app ?? "?")} → ${String(a.tool ?? "?")}`,
      detail: JSON.stringify(a.arguments ?? {}, null, 1).slice(0, 500),
    }),
    run: async (a) => {
      const app = String(a.app ?? "");
      const tool = String(a.tool ?? "");
      // Oracle-style local validation: unknown tools die instantly WITH the
      // app's real list (same treatment connectors got).
      try {
        const apps = await listInstalledAppTools();
        const entry = apps.find((x) => x.app === app);
        if (entry) {
          const names = (entry.tools || []).map((t) => t.name);
          if (names.length && !names.includes(tool)) {
            return `ERROR: "${tool}" is not a ${app} tool. Available ${app} tools: ${names.join(", ")}. (If you just edited the app's source, call update_app() first — the installed app runs the last installed version.)`;
          }
        }
      } catch { /* listing unavailable — let the host answer */ }
      const out = await callAppTool(app, tool, (a.arguments as Record<string, unknown>) ?? {});
      return cap(typeof out === "string" ? out : JSON.stringify(out, null, 1));
    },
  },
];

/** Name + doc line per tool — the agent loop declares these over MCP (args
 *  ride as free-form objects described by the doc; the executor validates). */
export type AgentMode = "cowork" | "code";

/** Tools each MODE carries — the defs are un-squeezable per-turn prompt
 *  prefix, so a session only pays for its own space's pack:
 *  - CO-WORK: the connected-life set — connectors, browsing, apps/RPA,
 *    memory, documents. No dev toolchain.
 *  - CODE: the dev set — workspace files, terminal, git, deploy, preview.
 *    No RPA, no email/drip/layout extras — and NO pre-wired connector defs
 *    (find_tools/call_tool reach any connector lazily at two small defs). */
const CODE_EXCLUDED = new Set([
  "rpa_read", "rpa_click", "rpa_type", "rpa_goto", "scrape_page",
  "send_email_with_attachment",
  "list_workspaces", "open_workspace", "save_workspace",
  "list_drips", "run_drip",
  "app_list_tools", "app_call_tool",
]);
const COWORK_EXCLUDED = new Set([
  "run_command", "update_app",
  "git_init", "git_status", "git_branch", "git_diff", "git_log", "git_commit",
]);

export function glyphhToolDefs(mode: AgentMode = "cowork"): Array<{ name: string; doc: string }> {
  const excluded = mode === "code" ? CODE_EXCLUDED : COWORK_EXCLUDED;
  return TOOLS.filter((t) => !excluded.has(t.name)).map((t) => ({ name: t.name, doc: t.doc }));
}

export interface ToolOutcome { result: string; denied: boolean; title: string }

/**
 * The human title for one tool call WITHOUT executing or gating it — what a
 * breadcrumb producer shows while the tool is still running (`⚙ Run: <cmd>`),
 * so the row's key detail doesn't wait for the outcome. Same grammar the
 * outcome titles use (each tool's own `action()` classifier: "Run: <cmd>",
 * "Write /path", "Call slug → tool"). Null when the tool is unknown here.
 */
export function glyphhToolTitle(name: string, args: Record<string, unknown> = {}): string | null {
  const tool = TOOLS.find((t) => t.name === (RENAMED_TOOLS[name] ?? name));
  if (tool) {
    try { return tool.action(args).title || null; } catch { return null; }
  }
  const wired = wireMap.get(name);
  return wired ? `Call ${wired.slug} → ${wired.tool}` : null;
}

/** Gate → execute. Denials and failures come back as results the model can
 *  react to — the loop never throws on a tool. */
// ── run_role — delegate a work packet to another role of the ACTIVE loop ─────
// The interactive agent's own turns run on the loop's FIRST role; the other
// roles hold the models the user explicitly bound (builder=mistral, …). This
// runs a bounded tool-using sub-run on the delegated role's model, executing
// every tool through executeGlyphhTool so the SAME gate fires (approval cards,
// mode model) as for the outer loop's own calls.
const ROLE_RUN_ROUNDS = 16;
const ROLE_RESULT_CAP = 24_000;
// No recursion, and no interactive asks a delegated packet can't answer.
const ROLE_RUN_EXCLUDED = new Set(["run_role", "ask_user", "connect_account"]);

async function runRolePacket(
  role: string,
  task: string,
  context: string,
  signal: AbortSignal | undefined,
  wc: WebContents | undefined,
): Promise<string> {
  if (!role) return "ERROR: role is required";
  if (!task) return "ERROR: task is required";
  if (!wc) return "ERROR: this run has no session surface to gate tool calls against";
  const loop = currentLoop();
  const roles = await resolveRoles(loop).catch(() => []);
  const slot = roles.find((r) => r.name === role);
  if (!slot) {
    return `ERROR: loop "${loop}" has no role "${role}" — its roles: ${roles.map((r) => r.name).join(", ") || "(none)"}`;
  }
  if (!slot.modelId) return `ERROR: role "${role}" has no model bound — the user picks one in the composer's model chip`;

  // A packet's toolset is the BUILD core, not the whole surface: every tool
  // schema rides EVERY round's prompt, and ~50 schemas on mistral-large blew
  // per-minute token caps in one request. find_tools/call_tool keep the rest
  // of the surface reachable when a packet genuinely needs it.
  const PACKET_TOOLS = new Set([
    "list_dir", "read_file", "write_file", "search_files", "run_command",
    "semantic_search", "git_init", "git_status", "git_branch", "git_diff", "git_log", "git_commit",
    "update_app", "open_browser", "find_tools", "call_tool", "fetch_connector_file",
  ]);
  const tools = TOOLS.filter((t) => PACKET_TOOLS.has(t.name) && !ROLE_RUN_EXCLUDED.has(t.name)).map((t) => ({
    name: t.name,
    description: t.doc,
    input_schema: { type: "object" as const, additionalProperties: true },
  }));
  const system = [
    `You are the "${role}" role of the "${loop}" loop, executing ONE delegated work packet inside the user's Glyphh workspace.`,
    `Working folder: ${workdir()}`,
    context ? `Context from the delegating role:\n${context}` : "",
    "Complete the task with the tools, then reply with a concise report of what you did (files touched, commands run, outcomes). No preamble, no questions — decisions you can't make go in the report.",
  ].filter(Boolean).join("\n\n");

  const client = getClient();
  const packetModel = slot.modelId;   // narrowed above; closures don't carry the guard
  let messages: Array<{ role: string; content: unknown }> = [{ role: "user", content: task }];
  /** One rate-limit retry per round: provider caps are per-minute, so a
   *  single ~35s backoff usually clears them; a second hit reports out. */
  const turnWithBackoff = async (): Promise<Awaited<ReturnType<typeof client.gateway.turn>>> => {
    try {
      return await client.gateway.turn({ model: packetModel, system, maxTokens: 8192, messages, tools });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/rate.?limit|429/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 35_000));
      if (signal?.aborted) throw new Error("aborted");
      return client.gateway.turn({ model: packetModel, system, maxTokens: 8192, messages, tools });
    }
  };
  for (let round = 0; round < ROLE_RUN_ROUNDS; round++) {
    if (signal?.aborted) return "ERROR: aborted";
    let turn: Awaited<ReturnType<typeof client.gateway.turn>>;
    try {
      turn = await turnWithBackoff();
    } catch (err) {
      const full = err instanceof Error ? err.message : String(err);
      // The FULL upstream error, in the main log and the tool result — a
      // clipped "invalid_request_error" with no reason is undebuggable.
      console.warn(`[run_role] ${role} (${packetModel}) round ${round} failed:`, full);
      return `ERROR: ${role} turn on ${packetModel} failed: ${full.slice(0, 1200)}`;
    }
    if (!turn.toolUses.length) return cap(`[${role} · ${slot.modelId}]\n${turn.text}`);
    messages = messages.concat([{ role: "assistant", content: turn.content }]);
    const results: Array<Record<string, unknown>> = [];
    for (const call of turn.toolUses) {
      if (signal?.aborted) return "ERROR: aborted";
      const outcome = ROLE_RUN_EXCLUDED.has(call.name)
        ? { result: `ERROR: "${call.name}" is not available inside a delegated packet` }
        : await executeGlyphhTool(wc, { name: call.name, arguments: (call.input ?? {}) as Record<string, unknown> }, signal);
      results.push({ type: "tool_result", tool_use_id: call.id, content: String(outcome.result).slice(0, ROLE_RESULT_CAP) });
    }
    messages = messages.concat([{ role: "user", content: results }]);
  }
  return `ERROR: the ${role} packet stopped after ${ROLE_RUN_ROUNDS} tool rounds without finishing — split the task into smaller packets`;
}

/** Layouts became WORKSPACES (2026-08-13): recorded skills and old prompts may
 *  still call the layout-named tools — resolve them to the new names. */
const RENAMED_TOOLS: Record<string, string> = {
  list_layouts: "list_workspaces",
  open_layout: "open_workspace",
  save_layout: "save_workspace",
};

export async function executeGlyphhTool(
  wc: WebContents,
  call: { name: string; arguments?: Record<string, unknown> },
  signal?: AbortSignal,
  ctx?: { workdir?: string },
): Promise<ToolOutcome> {
  // A caller with a run context executes inside it; nested calls (run_role
  // packets) inherit the outer context through the ALS chain.
  if (ctx?.workdir) {
    const c = { workdir: ctx.workdir };
    return toolRunContext.run(c, () => executeGlyphhToolInner(wc, call, signal));
  }
  return executeGlyphhToolInner(wc, call, signal);
}

async function executeGlyphhToolInner(
  wc: WebContents,
  call: { name: string; arguments?: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  const callName = RENAMED_TOOLS[call.name] ?? call.name;
  const tool = TOOLS.find((t) => t.name === callName);
  if (!tool) {
    // Not a builtin — a wired connector tool dispatches through yo-server.
    const wired = wireMap.get(call.name);
    if (wired) return executeConnectorWire(wc, wired, call.arguments ?? {});
    const wires = [...wireMap.keys()];
    const available = [...TOOLS.map((t) => t.name), ...wires.slice(0, 40)].join(", ");
    return {
      result: `ERROR: unknown tool "${call.name}" — available: ${available}${wires.length > 40 ? ", …" : ""}`,
      denied: false,
      title: call.name,
    };
  }
  const args = call.arguments ?? {};
  let action;
  try {
    action = tool.action(args);
  } catch (err) {
    return { result: `ERROR: ${err instanceof Error ? err.message : String(err)}`, denied: false, title: call.name };
  }
  const gate = await gateGlyphhAction(wc, action);
  if (!gate.allowed) {
    return { result: `DENIED: ${gate.reason || "not allowed"}`, denied: true, title: action.title };
  }
  try {
    return { result: await tool.run(args, signal, wc), denied: false, title: action.title };
  } catch (err) {
    return { result: `ERROR: ${err instanceof Error ? err.message : String(err)}`, denied: false, title: action.title };
  }
}
