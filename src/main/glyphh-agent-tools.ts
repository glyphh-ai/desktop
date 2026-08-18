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
import { openAppByRef, openBrowserAt, openGPointPanel, openGDocPanel, openGSheetPanel, openDesignPanel, openMediaPanel, openLayoutByName, listOpenAppWindows } from "./app-resolver";
import { gsheetFileName, saveWorkbook } from "./office-sheets";
import { recalcWorkbook, colLetter, parseA1, type Workbook, type Worksheet, type SheetColumn, type SheetCell, type ChartSpec, type CondFormat, type NamedRange, type DataValidation, type CellStyle } from "../shared/sheets-engine";
import { randomUUID } from "node:crypto";
import { listGPoints, readGPoint, writeGPoint, deleteGPoint, gpointFileName, buildDeckDocument, slideSpans, removeSlideAt, replaceSlideAt, insertSlideAt, setSlideHiddenAt, setDeckTitle } from "./gpoints";
import { renderDeck, renderSection, validateDeck, validateSlideSpec, layoutCatalog, themeCatalog, type SlideSpec, type RenderOptions } from "@glyphh/sdk/slides";
import { gdocFileName as docsFileName } from "./office-docs";
import { docThemeCss, docStyleFromDesign, writeDocStyle, DOC_THEMES } from "../shared/doc-styles";
import { currentLoop, resolveRoles } from "./loop-selections";
import { dispatchRelayMethod } from "./relay-client";
import { getAccountInfo, AUTH_SERVER, getAuthToken, ensureFreshToken } from "./auth";

/** ONE MEMORY PLANE: Ada lives on the regional stator, reached through the
 *  server's proxy (/api/stator/*). The desktop's local sqlite Ada store is
 *  dead doctrine (2026-08-02 "Ada cloud-only") — these tools rode it anyway
 *  until 2026-08-13, which is why memory written on one surface never
 *  recalled on another. */
async function statorCall(path: "recall" | "write" | "browse" | "forget", body: Record<string, unknown>): Promise<string> {
  await ensureFreshToken();
  const token = getAuthToken();
  if (!token) return "ERROR: signed out — cloud memory needs a session";
  const res = await fetch(`${AUTH_SERVER}/api/stator/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) return `ERROR: memory ${path} failed (${res.status}) ${text.slice(0, 200)}`;
  return text;
}

import { SEMANTIC_TOOLS } from "./glyphh-agent-semantic";
import { getClient, appCache } from "./glyphh-client";
import { designFileName, extractSiteDesign, imagePalette } from "./design";
import { uploadMediaFile, mediaFileUrl } from "./media-panel";
import { genImageAsset, genLook } from "./music-panel";
import type { DesignSystem } from "@glyphh/sdk";
import { fetchServerLayouts } from "./layout-manager";
import { refreshConnectorCatalog, getConnectorCatalog, getCatalogAge, callConnectorTool } from "./connector-tools-client";
import { BUILTIN_EFFECTS, getDripManagerInstance } from "./drip-manager";
import { indexToolVectors, rankConnectorTools, enrichToolVectors, noteToolUsed } from "./tool-vectors";
import { updateAppFromWorkdir } from "./glyphh-app-builder";
import { APP_GITIGNORE } from "./glyphh-app-spec";
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

/** Resolve a media-library asset id to an inline data URI so a deck stays
 *  self-contained. Images/avatars only; a miss or non-image drops to a themed
 *  surface (the layout renders a placeholder rather than a broken link). */
async function slideMediaDataUri(id: string): Promise<string | null> {
  try {
    const meta = await getClient().media.get(id).catch(() => null);
    if (meta && !["image", "avatar"].includes(String(meta.kind))) return null;
    const buf = await getClient().media.bytes(id);
    const mime = meta?.mime || "image/png";
    return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
  } catch { return null; }
}

/** Render options for the slides engine: the org media resolver, plus the org
 *  design system overlaid on the chosen theme when a `design` name is given. */
async function slideRenderOptions(theme?: unknown, design?: unknown): Promise<RenderOptions> {
  const opts: RenderOptions = { resolveMedia: slideMediaDataUri };
  if (theme != null && String(theme).trim()) opts.theme = String(theme).trim();
  const d = design == null ? "" : String(design).trim();
  if (d) opts.designCss = await getClient().designs.css(designFileName(d)).catch(() => undefined);
  return opts;
}

/** Coerce a tool arg into a SlideSpec[] — accepts an array or a JSON string
 *  (models sometimes stringify structured params). */
function asSlideSpecs(v: unknown): SlideSpec[] | null {
  let val = v;
  if (typeof val === "string") { try { val = JSON.parse(val); } catch { return null; } }
  return Array.isArray(val) ? (val as SlideSpec[]) : null;
}

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
  // (The per-slug indexConnectorTools mirror died with the local Ada store —
  // cloud memory is the one plane, and indexToolVectors below already encodes
  // the catalog for per-ask selection.)
  lastWireDefs = defs;
  // Encode the catalog for per-ask tool selection (incremental — only new or
  // changed descriptions embed). Fire-and-forget: the first run after a
  // catalog change may select lexically while this catches up.
  // Index first (embeds raw descriptions), then the back-path enrichment pass
  // rewrites thin ones as retrieval paragraphs and re-embeds. Both best-effort.
  void indexToolVectors(defs).then(() => enrichToolVectors(defs)).catch(() => {});
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
  // Work panels are built in — refuse an entry mutation on their slugs before
  // anything reaches the server, gate or no gate.
  if (targetsBuiltinWorkpanel(wired.tool, args)) {
    return { result: WORKPANEL_REFUSAL, denied: false, title: action.title };
  }
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

// ── Built-in work panels — agent-proof ──────────────────────────────────────
// The ten work panels (Office / Design / Memory / Media) are Apps-page
// fixtures, not org apps. NO agent path may create, reshape, or remove an app
// entry under their slugs — the refusal fires BEFORE any client call, on every
// seam that can reach the entries API: wired connector tools, the call_tool
// hatch, and the workdir install path (glyphh-app-builder.ts guards that one
// at the manifest, where the slug first exists). apps-ipc.ts carries the same
// set for the renderer's CRUD.
const BUILTIN_WORKPANELS = new Set(["gpoint", "gdoc", "gsheet", "gdrive", "gdesign", "gmemory", "gimage", "gvideo", "gsound", "gband"]);
const WORKPANEL_REFUSAL = "ERROR: work panels are built in — they cannot be altered or removed";

/** True when a tool call would mutate an app ENTRY under a built-in work-panel
 *  slug. Matches the entry-mutation names however they're wired
 *  (create_app_entry, update_app_entry, delete_app_entry, remove_app,
 *  slug-prefixed variants) and reads the slug from the usual argument names. */
function targetsBuiltinWorkpanel(toolName: string, args: Record<string, unknown>): boolean {
  if (!/(^|_)(create|update|delete|remove)_app(_entry)?($|_)/i.test(toolName)) return false;
  const slug = String(args.slug ?? args.app ?? args.id ?? args.name ?? "").trim().toLowerCase();
  return BUILTIN_WORKPANELS.has(slug);
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
    doc: "find_tools(query, k?) — search ALL connected-account tools AND every desktop builtin (including ones not loaded for this session's space, e.g. rpa_*/scrape_page in a Code session) by meaning. Phrase the TASK, not a keyword — 'get a signed PDF back from the customer' beats 'pdf'. Families you can find tools in: connectors (email, calendar, CRM, payments, files, social, …) · office (slides/docs/sheets/drive) · design systems · dev (files, git, terminal, apps, deploy) · browser/rpa · memory · workspace. When you need a tool that isn't wired, find it here, then run it with call_tool. Read-only.",
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
      // The enriched paragraph when one exists — it carries the when-to-use
      // language the raw catalog description usually lacks.
      return cap(hits.map((r) => `${r.def.name} — ${r.blurb ?? r.def.description}`).join("\n"));
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
      const args = (a.arguments ?? {}) as Record<string, unknown>;
      // Work panels are built in — an entry mutation on their slugs is refused
      // here too, so the hatch is no way around the wired-tool guard.
      if (targetsBuiltinWorkpanel(inner, args)) return WORKPANEL_REFUSAL;
      const wired = wireMap.get(inner);
      if (wired) {
        if (targetsBuiltinWorkpanel(wired.tool, args)) return WORKPANEL_REFUSAL;
        noteToolUsed(inner);
        return cap(await callConnectorTool(wired.slug, wired.tool, args));
      }
      const builtin = TOOLS.find((t) => t.name === inner && t.name !== "call_tool" && t.name !== "find_tools");
      if (builtin) return builtin.run(args);
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
    doc: "update_app() — build-then-ship the app in the working folder: packages the compiled dist/ (Vite project) or the folder's files (legacy single-file app) and installs it. For a Vite project, run `npm run build` FIRST. Call after every change or tool calls run the OLD version. WORKBENCH APPS: when the user asks for a 'workbench app' — a panel that lives inside their agent workbench with no public URL — build it like any Glyphh app but register it server-side with create_app_entry (kind glyphh, config {workbench:true}, via find_tools/call_tool) and build_app; declare its MCP tools + capabilities in the manifest so the harness can call them. Workbench apps are members-only by force, show under Apps, install into Workspace slots, and render chromeless (no address bar). Keep them inside the capability sandbox — the same guards as every app: declared capabilities only, no remote assets, no agent.run tool.",
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
    doc: "open_app(name) — open an INSTALLED app from the user's library (or 'terminal') as a panel beside this conversation. To show something you built or deployed, use open_browser(url) instead — EXCEPT workbench apps (config workbench:true), which have no URL by design and are previewed with open_app itself.",
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
  // ── Glyphh Office · SLIDES: org-shared, agent-authored HTML decks (R2 via
  //    the SDK). The Slides panel is read-only (library → reader → presenter);
  //    THESE tools are the write surface. create_slides/update_slides ride the
  //    CANONICAL SHELL (buildDeckDocument): the tool owns the stage/scaling/
  //    nav/progress harness — the agent authors ONLY slide content. Spec:
  //    docs/glyphh-slides-spec.md. ──
  {
    name: "list_slides",
    doc: "list_slides() — the org's Slides library (Glyphh Office decks): file, title, slide count",
    action: () => ({ kind: "read", title: "List slide decks" }),
    run: async () => {
      const decks = await listGPoints();
      if (!decks.length) return "(no slide decks yet — create_slides builds one)";
      return cap(JSON.stringify(decks.map(({ file, title, slides }) => ({ file, title, slides })), null, 1));
    },
  },
  {
    name: "read_slides",
    doc: "read_slides(name, raw?) — a deck's READABLE TEXT, per slide (the default — the raw document is mostly font bytes and will blow your context). Pass raw:true ONLY when you need exact HTML for update_slides surgery.",
    action: (a) => ({ kind: "read", title: `Read deck "${String(a.name ?? "")}"${a.raw ? " (raw)" : ""}` }),
    run: async (a) => {
      if (a.raw) return cap(await readGPoint(a.name), READ_CAP);
      const t = await getClient().officeSlides.text(gpointFileName(a.name));
      return cap(`${t.title} — ${t.slides} slides\n\n${t.text}`, READ_CAP);
    },
  },
  {
    name: "list_slide_layouts",
    doc: "list_slide_layouts() — the controlled slide LAYOUTS you slot content into (title, bullets, two-column, image-left/right, quote, big-stat, cards, comparison, timeline, agenda, chart, code, full-bleed-image, team, closing, …). Each entry gives its required fields and a copyable sample. ALWAYS pick a layout + fill its fields rather than authoring HTML.",
    action: () => ({ kind: "read", title: "List slide layouts" }),
    run: async () => cap(JSON.stringify(layoutCatalog(), null, 1), READ_CAP),
  },
  {
    name: "list_slide_themes",
    doc: "list_slide_themes() — the deck THEMES (midnight, paper, mono, editorial, neon, corporate, warm, ocean). Pass one as create_slides(theme). Or pass a design-system name as create_slides(design) to match the org's brand + docs exactly (list_designs / read_design).",
    action: () => ({ kind: "read", title: "List slide themes" }),
    run: async () => cap(JSON.stringify(themeCatalog(), null, 1), READ_CAP),
  },
  {
    name: "create_slides",
    doc: 'create_slides(name, title, slides, theme?, design?) — create or overwrite a Glyphh Slides deck by SLOTTING CONTENT INTO CONTROLLED LAYOUTS. `slides` is an array of typed specs, one per slide: [{layout, …fields}] (see list_slide_layouts for each layout\'s fields + samples). Pick a theme (list_slide_themes) or a design-system name to match the org brand. Reference media-library images by asset id (list_media). The tool renders professional, design-consistent HTML — you never write HTML/CSS. (Escape hatch: pass slides_html — raw <section class="slide"> blocks — only when no layout fits.)',
    action: (a) => ({
      kind: "edit",
      title: `Create deck "${String(a.name ?? "")}"`,
      detail: a.slides ? `${asSlideSpecs(a.slides)?.length ?? 0} slides` : `${String(a.slides_html ?? a.html ?? "").length} chars`,
    }),
    run: async (a) => {
      const title = String(a.title ?? a.name ?? "Deck");
      // Primary path: typed layout specs → the engine renders + themes them.
      if (a.slides !== undefined || a.slides_html === undefined) {
        const specs = asSlideSpecs(a.slides);
        if (!specs) return "ERROR: `slides` must be an array of {layout, …} specs — list_slide_layouts shows the shapes";
        const v = validateDeck(specs);
        if (!v.ok) return `ERROR: ${v.errors.slice(0, 6).join("; ")}`;
        const opts = await slideRenderOptions(a.theme, a.design);
        const sections = await renderDeck(specs, opts);
        const r = await writeGPoint(a.name, buildDeckDocument(title, sections));
        return `created ${r.path} (${r.slides} slide${r.slides === 1 ? "" : "s"}) — it's in the org's Slides panel on every surface; open_slides("${r.file}") jumps straight to it`;
      }
      // Escape hatch: raw slide sections.
      const raw = String(a.slides_html ?? "");
      if (/<html[\s>]/i.test(raw)) return "ERROR: slides_html must be slide SECTIONS only — the shell is the tool's, not yours";
      const doc = buildDeckDocument(title, raw);
      if (!/<section[^>]*class="[^"]*\bslide\b/i.test(doc)) return 'ERROR: not a slide deck — it needs <section class="slide"> pages';
      const r = await writeGPoint(a.name, doc);
      return `created ${r.path} (${r.slides} slide${r.slides === 1 ? "" : "s"}) — open_slides("${r.file}") jumps to it`;
    },
  },
  {
    name: "update_slides",
    doc: 'update_slides(name, …ops) — surgical deck edits, 1-BASED slide indexes. Ops (any combination, applied in this order): title="…" renames; replace_slide={index, spec} swaps one slide (spec is a {layout, …} content spec — same as create_slides — or {html} for raw); insert_slide={index?, spec} inserts BEFORE index (omit index to append); remove_slide=index deletes; hide_slide=index / unhide_slide=index toggle the presenter-skip flag. theme?/design? re-theme a replaced/inserted slide to match the deck.',
    action: (a) => ({
      kind: "edit",
      title: `Update deck "${String(a.name ?? "")}"`,
      detail: Object.keys(a).filter((k) => k !== "name").join(", "),
    }),
    run: async (a) => {
      let doc = await readGPoint(a.name);
      const before = slideSpans(doc).length;
      const idx = (v: unknown): number => Math.trunc(Number(v)) - 1;
      const opts = await slideRenderOptions(a.theme, a.design);
      // A slide op value is either {spec:{layout,…}} / a bare {layout,…}, or {html}.
      const section = async (v: unknown): Promise<string> => {
        const o = (v ?? {}) as Record<string, unknown>;
        const raw = o.html ?? (o.spec as { html?: unknown } | undefined)?.html;
        if (raw !== undefined) {
          const h = String(raw ?? "");
          if (!/<section[^>]*class="[^"]*\bslide\b/i.test(h)) throw new Error('raw slide html must be a <section class="slide"> block');
          return h;
        }
        const spec = (o.spec ?? o) as SlideSpec;
        const val = validateSlideSpec(spec);
        if (!val.ok) throw new Error(val.errors[0] ?? "invalid slide spec");
        return renderSection(spec, opts);
      };
      if (a.title !== undefined) doc = setDeckTitle(doc, String(a.title));
      if (a.replace_slide !== undefined) {
        const r = a.replace_slide as { index?: unknown };
        doc = replaceSlideAt(doc, idx(r.index), await section(a.replace_slide));
      }
      if (a.insert_slide !== undefined) {
        const ins = a.insert_slide as { index?: unknown };
        doc = insertSlideAt(doc, ins.index === undefined ? Number.MAX_SAFE_INTEGER : idx(ins.index), await section(a.insert_slide));
      }
      if (a.remove_slide !== undefined) {
        if (before <= 1) return "ERROR: a deck needs at least one slide — delete_slides removes the whole deck";
        doc = removeSlideAt(doc, idx(a.remove_slide));
      }
      if (a.hide_slide !== undefined) doc = setSlideHiddenAt(doc, idx(a.hide_slide), true);
      if (a.unhide_slide !== undefined) doc = setSlideHiddenAt(doc, idx(a.unhide_slide), false);
      const r = await writeGPoint(a.name, doc);
      return `updated ${r.file} — now ${r.slides} slide${r.slides === 1 ? "" : "s"}`;
    },
  },
  {
    name: "delete_slides",
    doc: "delete_slides(name) — permanently delete a deck from the org library",
    action: (a) => ({ kind: "dangerous", title: `Delete deck "${String(a.name ?? "")}"` }),
    run: async (a) => {
      await deleteGPoint(a.name);
      return `deleted ${gpointFileName(a.name)}`;
    },
  },
  {
    name: "open_slides",
    doc: "open_slides(name?) — open the Slides panel beside this conversation; with a deck name it opens straight into that deck's reader",
    action: (a) => ({ kind: "command", title: a.name ? `Open deck "${String(a.name)}"` : "Open the Slides panel" }),
    run: async (a) => {
      if (!a.name) { openGPointPanel(); return "opened the Slides panel"; }
      const file = gpointFileName(a.name);
      const html = await readGPoint(file).catch(() => null);
      if (html === null) {
        const decks = await listGPoints();
        return `ERROR: no deck "${file}" — available: ${decks.map((d) => d.file).join(", ") || "(none)"}`;
      }
      const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || undefined;
      openGPointPanel(file, title);
      return `opened ${file} in the Slides panel`;
    },
  },
  // ── Glyphh Office · DOCS: org-shared markdown documents rendered as paper.
  //    Direct writes draft; suggest_docs is the REVIEWED path (the user
  //    approves in the panel). Spec: docs/glyphh-slides-spec.md sibling. ──
  {
    name: "list_docs",
    doc: "list_docs() — the org's Docs library: file, title, folderId",
    action: () => ({ kind: "read", title: "List documents" }),
    run: async () => {
      const docs = await getClient().officeDocs.list();
      if (!docs.length) return "(no documents yet — create_docs writes one; list_doc_templates has starting points)";
      return cap(JSON.stringify(docs.map(({ file, title, folderId }) => ({ file, title, folderId })), null, 1));
    },
  },
  {
    name: "read_docs",
    doc: "read_docs(name) — a document's markdown source",
    action: (a) => ({ kind: "read", title: `Read document "${String(a.name ?? "")}"` }),
    run: async (a) => cap((await getClient().officeDocs.get(docsFileName(a.name))).markdown, READ_CAP),
  },
  {
    name: "create_docs",
    doc: "create_docs(name, markdown) — create or overwrite a document. Markdown only; the first `# H1` is the document's title; h1-h3 headings become its table of contents. Rich blocks are supported: fenced callouts `:::note …\\n:::` (also tip/warning/info), two-up `:::columns …\\n+++\\n…\\n:::`, plus tables/lists/quotes/code. Style the paper with set_doc_style (theme or org design system); build structure with insert_doc_block. Start from list_doc_templates when one fits.",
    action: (a) => ({ kind: "edit", title: `Create document "${String(a.name ?? "")}"`, detail: `${String(a.markdown ?? "").length} chars` }),
    run: async (a) => {
      const mdErr = rejectDocHtml(String(a.markdown ?? ""));
      if (mdErr) return mdErr;
      const md = String(a.markdown ?? "");
      if (!md.trim()) return "ERROR: markdown is required";
      const meta = await getClient().officeDocs.put(docsFileName(a.name), md);
      return `created ${meta.file} ("${meta.title}") — it's in the org's Docs panel on every surface; open_docs("${meta.file}") opens it`;
    },
  },
  {
    name: "update_docs",
    doc: "update_docs(name, markdown) — overwrite a document you are actively drafting. For a document the user considers DONE, use suggest_docs instead so they review the change.",
    action: (a) => ({ kind: "edit", title: `Update document "${String(a.name ?? "")}"`, detail: `${String(a.markdown ?? "").length} chars` }),
    run: async (a) => {
      const mdErr = rejectDocHtml(String(a.markdown ?? ""));
      if (mdErr) return mdErr;
      const md = String(a.markdown ?? "");
      if (!md.trim()) return "ERROR: markdown is required";
      const meta = await getClient().officeDocs.put(docsFileName(a.name), md);
      return `updated ${meta.file} ("${meta.title}")`;
    },
  },
  {
    name: "suggest_docs",
    doc: 'suggest_docs(name, after, before?, section?, note?) — propose a REVIEWED edit: replace the exact `before` text with `after` (omit before to append). The user sees a review card in the Docs panel and approves or rejects; approval applies it. Always include a short note saying why.',
    action: (a) => ({ kind: "edit", title: `Suggest edit to "${String(a.name ?? "")}"`, detail: String(a.note ?? "").slice(0, 200) }),
    run: async (a) => {
      const mdErr = rejectDocHtml(String(a.after ?? ""));
      if (mdErr) return mdErr;
      const sug = await getClient().officeDocs.suggest(docsFileName(a.name), {
        afterMd: String(a.after ?? ""),
        beforeMd: String(a.before ?? ""),
        section: String(a.section ?? ""),
        note: String(a.note ?? ""),
        authorKind: "agent",
      });
      return `suggestion ${sug.id} is pending — the user reviews it in the Docs panel (approve applies it)`;
    },
  },
  {
    name: "delete_docs",
    doc: "delete_docs(name) — permanently delete a document from the org library",
    action: (a) => ({ kind: "dangerous", title: `Delete document "${String(a.name ?? "")}"` }),
    run: async (a) => {
      await getClient().officeDocs.delete(docsFileName(a.name));
      return `deleted ${docsFileName(a.name)}`;
    },
  },
  {
    name: "open_docs",
    doc: "open_docs(name?) — open the Docs panel beside this conversation; with a document name it opens straight into that document",
    action: (a) => ({ kind: "command", title: a.name ? `Open document "${String(a.name)}"` : "Open the Docs panel" }),
    run: async (a) => {
      if (!a.name) { openGDocPanel(); return "opened the Docs panel"; }
      const file = docsFileName(a.name);
      const doc = await getClient().officeDocs.get(file).catch(() => null);
      if (!doc) {
        const docs = await getClient().officeDocs.list();
        return `ERROR: no document "${file}" — available: ${docs.map((d) => d.file).join(", ") || "(none)"}`;
      }
      openGDocPanel(file, doc.title);
      return `opened ${file} in the Docs panel`;
    },
  },
  {
    name: "set_doc_style",
    doc: `set_doc_style(name, theme?, design?) — style a document's paper. theme is one of ${Object.keys(DOC_THEMES).join(", ")} (fonts + accent). Or pass a design-system name to match the org brand (and its decks) exactly — list_designs / read_design. Applies instantly in the Docs panel.`,
    action: (a) => ({ kind: "edit", title: `Style document "${String(a.name ?? "")}"`, detail: String(a.design ?? a.theme ?? "") }),
    run: async (a) => {
      const doc = await getClient().officeDocs.get(docsFileName(a.name)).catch(() => null);
      if (!doc) return `ERROR: no document "${docsFileName(a.name)}"`;
      let vars = "";
      const design = a.design == null ? "" : String(a.design).trim();
      if (design) {
        const css = await getClient().designs.css(designFileName(design)).catch(() => "");
        vars = docStyleFromDesign(css);
        if (!vars) return `ERROR: couldn't read design "${design}"`;
      } else {
        vars = docThemeCss(a.theme ? String(a.theme) : undefined);
      }
      const meta = await getClient().officeDocs.put(docsFileName(a.name), writeDocStyle(doc.markdown, vars));
      return `styled ${meta.file} (${design ? `design ${design}` : `theme ${a.theme ?? "classic"}`})`;
    },
  },
  {
    name: "insert_doc_block",
    doc: 'insert_doc_block(name, block, after_section?) — append a STRUCTURED block to a document (or after the named heading). block is one of: {type:"heading", level?, text}, {type:"paragraph", text}, {type:"bullets", items:[…]}, {type:"numbered", items:[…]}, {type:"table", headers:[…], rows:[[…]]}, {type:"callout", style?:"note|tip|warning|info", title?, text}, {type:"columns", left, right}, {type:"quote", text}, {type:"code", language?, code}, {type:"divider"}. Renders to markdown — the app owns the paper.',
    action: (a) => ({ kind: "edit", title: `Add a block to "${String(a.name ?? "")}"`, detail: String((a.block as { type?: unknown })?.type ?? "") }),
    run: async (a) => {
      const doc = await getClient().officeDocs.get(docsFileName(a.name)).catch(() => null);
      if (!doc) return `ERROR: no document "${docsFileName(a.name)}"`;
      const md = renderDocBlock(a.block);
      if (md.startsWith("ERROR")) return md;
      let full = doc.markdown;
      const after = a.after_section == null ? "" : String(a.after_section).trim();
      if (after) {
        // insert just before the NEXT heading after the named section (or append)
        const re = new RegExp(`(^#{1,3}\\s+${after.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}[^\\n]*\\n)`, "im");
        const m = re.exec(full);
        if (m) {
          const from = m.index + m[0].length;
          const next = full.slice(from).search(/\n#{1,3}\s/);
          const at = next < 0 ? full.length : from + next;
          full = `${full.slice(0, at)}\n\n${md}\n${full.slice(at)}`;
        } else full = `${full.trimEnd()}\n\n${md}\n`;
      } else full = `${full.trimEnd()}\n\n${md}\n`;
      const meta = await getClient().officeDocs.put(docsFileName(a.name), full);
      return `added a ${String((a.block as { type?: unknown })?.type ?? "block")} to ${meta.file}`;
    },
  },
  {
    name: "list_doc_templates",
    doc: "list_doc_templates() — the org's document templates (resume, bill of sale, …): slug, name, category, and the markdown with {{placeholders}} to fill",
    action: () => ({ kind: "read", title: "List document templates" }),
    run: async () => cap(JSON.stringify(await getClient().officeDocs.templates(), null, 1)),
  },
  // ── Glyphh DRIVE: folders + pointers over every Office file. ──
  {
    name: "drive_list",
    doc: "drive_list(query?) — folders + every Office file pointer (slides AND docs); query searches names/titles",
    action: (a) => ({ kind: "read", title: a.query ? `Search Drive "${String(a.query)}"` : "List Drive" }),
    run: async (a) => cap(JSON.stringify(await getClient().officeDrive.list(a.query ? String(a.query) : undefined), null, 1)),
  },
  {
    name: "drive_mkdir",
    doc: "drive_mkdir(name, parent_id?) — create a Drive folder",
    action: (a) => ({ kind: "edit", title: `Create folder "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const folder = await getClient().officeDrive.createFolder(String(a.name ?? ""), a.parent_id ? String(a.parent_id) : null);
      return `created folder "${folder.name}" (${folder.id})`;
    },
  },
  // ── Glyphh Office · SHEETS: JSON workbooks; the SHARED engine recalcs every
  //    write, so formula cells always land with fresh materialized values.
  //    Engine v3: dependency-ordered recalc (any order), cross-sheet refs,
  //    named ranges, lookups + dates + text. ──
  {
    name: "list_sheets",
    doc: "list_sheets() — the org's workbooks: file, title, sheet + row counts",
    action: () => ({ kind: "read", title: "List workbooks" }),
    run: async () => {
      const sheets = await getClient().officeSheets.list();
      if (!sheets.length) return "(no workbooks yet — create_sheets builds one)";
      return cap(JSON.stringify(sheets.map(({ file, title, sheets: n, totalRows }) => ({ file, title, sheets: n, totalRows })), null, 1));
    },
  },
  {
    name: "read_sheets",
    doc: "read_sheets(name, raw?) — a workbook's READABLE TEXT (headers + sample rows; the default). raw:true returns the full JSON workbook for surgical edits.",
    action: (a) => ({ kind: "read", title: `Read workbook "${String(a.name ?? "")}"${a.raw ? " (raw)" : ""}` }),
    run: async (a) => {
      if (a.raw) {
        const s = await getClient().officeSheets.get(gsheetFileName(a.name));
        return cap(JSON.stringify(s.workbook, null, 1), READ_CAP);
      }
      const t = await getClient().officeSheets.text(gsheetFileName(a.name));
      return cap(`${t.title} — ${t.sheets} sheet${t.sheets === 1 ? "" : "s"}, ${t.totalRows} rows\n\n${t.text}`, READ_CAP);
    },
  },
  {
    name: "create_sheets",
    doc: 'create_sheets(name, title, columns, rows?) — create or overwrite a workbook. columns: ["Name", …] or [{name, type?: "text"|"number"|"date"|"currency", ai_prompt?}]; rows: array of cell arrays — a cell is a value, or {f: "=…"} for a formula. Engine v3 recalcs in DEPENDENCY ORDER (a formula may reference a cell defined later or on another sheet — no "totals last" rule; circular refs show #CIRC!). Supports: arithmetic + & (concat), parens, A1 refs & ranges (B2:B9), cross-sheet refs (Sheet2!A1), named ranges, "string" literals, comparisons; functions SUM AVG COUNT COUNTA MEDIAN PRODUCT SUMIF COUNTIF AVERAGEIF ROUND/UP/DOWN ABS SQRT POWER MOD IF IFERROR AND OR NOT CONCAT UPPER LOWER TRIM LEN LEFT RIGHT MID SUBSTITUTE TEXT REGEXMATCH/EXTRACT/REPLACE TODAY DATE YEAR MONTH DAY DATEDIF VLOOKUP HLOOKUP INDEX MATCH FILTER UNIQUE SORT. Charts: add_chart. Styling: set_cell_style / add_conditional_format. Named ranges: add_named_range. AI columns: set ai_prompt, materialize with fill_column.',
    action: (a) => ({ kind: "edit", title: `Create workbook "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const cols = (Array.isArray(a.columns) ? a.columns : []).map((c): SheetColumn =>
        typeof c === "string" ? { name: c } : {
          name: String((c as { name?: unknown }).name ?? ""),
          ...((c as { type?: SheetColumn["type"] }).type ? { type: (c as { type?: SheetColumn["type"] }).type } : {}),
          ...((c as { ai_prompt?: unknown }).ai_prompt ? { aiPrompt: String((c as { ai_prompt?: unknown }).ai_prompt) } : {}),
        });
      if (!cols.length || cols.some((c) => !c.name)) return "ERROR: columns are required (names)";
      const rows = (Array.isArray(a.rows) ? a.rows : []) as SheetCell[][];
      const r = await saveWorkbook(a.name, String(a.title ?? a.name ?? "Untitled"), { sheets: [{ name: "Sheet1", columns: cols, rows }] });
      return `created ${r.file} ("${r.title}", ${r.totalRows} rows) — open_sheets("${r.file}") opens it`;
    },
  },
  {
    name: "update_sheets",
    doc: 'update_sheets(name, …ops) — surgical workbook edits (sheet? names the worksheet, default first). Ops in order: title="…"; set_cell={cell:"B3", value?|formula?}; add_rows={rows}; add_column={name, type?, ai_prompt?}; remove_column={column} (name or letter); sort={by, desc?} (column name or letter). The engine recalcs on save.',
    action: (a) => ({ kind: "edit", title: `Update workbook "${String(a.name ?? "")}"`, detail: Object.keys(a).filter((k) => k !== "name" && k !== "sheet").join(", ") }),
    run: async (a) => {
      const s = await getClient().officeSheets.get(gsheetFileName(a.name));
      const wb = s.workbook as Workbook;
      const sheetName = a.sheet ? String(a.sheet) : undefined;
      const sheet: Worksheet | undefined = sheetName ? wb.sheets.find((x) => x.name === sheetName) : wb.sheets[0];
      if (!sheet) return `ERROR: no worksheet ${sheetName ?? "(first)"} — sheets: ${wb.sheets.map((x) => x.name).join(", ")}`;
      const colIndex = (ref: unknown): number => {
        const t = String(ref ?? "").trim();
        const byName = sheet.columns.findIndex((c) => c.name.toLowerCase() === t.toLowerCase());
        if (byName >= 0) return byName;
        const a1 = parseA1(`${t}1`);
        return a1 ? a1.col : -1;
      };
      let title = String(s.title);
      if (a.title !== undefined) title = String(a.title);
      if (a.set_cell !== undefined) {
        const sc = a.set_cell as { cell?: unknown; value?: unknown; formula?: unknown };
        const rc = parseA1(String(sc.cell ?? ""));
        if (!rc) return 'ERROR: set_cell needs cell like "B3"';
        while (sheet.rows.length <= rc.row) sheet.rows.push(sheet.columns.map(() => null));
        const row = sheet.rows[rc.row]!;
        while (row.length <= rc.col) row.push(null);
        row[rc.col] = sc.formula !== undefined ? { f: String(sc.formula) } : ((sc.value ?? null) as SheetCell);
      }
      if (a.add_rows !== undefined) {
        const rows = ((a.add_rows as { rows?: unknown }).rows ?? a.add_rows) as SheetCell[][];
        if (!Array.isArray(rows)) return "ERROR: add_rows takes {rows: [[…], …]}";
        for (const r of rows) sheet.rows.push(r as SheetCell[]);
      }
      if (a.add_column !== undefined) {
        const c = a.add_column as { name?: unknown; type?: SheetColumn["type"]; ai_prompt?: unknown };
        if (!c.name) return "ERROR: add_column needs a name";
        sheet.columns.push({ name: String(c.name), ...(c.type ? { type: c.type } : {}), ...(c.ai_prompt ? { aiPrompt: String(c.ai_prompt) } : {}) });
        for (const row of sheet.rows) row.push(null);
      }
      if (a.remove_column !== undefined) {
        const i = colIndex((a.remove_column as { column?: unknown }).column ?? a.remove_column);
        if (i < 0 || i >= sheet.columns.length) return "ERROR: remove_column — no such column";
        sheet.columns.splice(i, 1);
        for (const row of sheet.rows) row.splice(i, 1);
      }
      if (a.sort !== undefined) {
        const so = a.sort as { by?: unknown; desc?: unknown };
        const i = colIndex(so.by);
        if (i < 0) return "ERROR: sort — no such column";
        const val = (row: SheetCell[]): string | number => {
          const c = row[i];
          const v = c !== null && typeof c === "object" ? (c.v ?? "") : (c ?? "");
          return typeof v === "number" ? v : String(v).toLowerCase();
        };
        sheet.rows.sort((x, y) => {
          const vx = val(x), vy = val(y);
          const cmp = typeof vx === "number" && typeof vy === "number" ? vx - vy : String(vx).localeCompare(String(vy));
          return so.desc ? -cmp : cmp;
        });
      }
      const r = await saveWorkbook(a.name, title, wb);
      return `updated ${r.file} — ${r.totalRows} rows`;
    },
  },
  {
    name: "fill_column",
    doc: 'fill_column(name, column, values, sheet?) — MATERIALIZE a column (the AI-column write path): values is an array aligned to the rows (row 1 first). Compute the values yourself from the column\'s ai_prompt over each row, then write them here — nothing evaluates prompts at render time.',
    action: (a) => ({ kind: "edit", title: `Fill "${String(a.column ?? "")}" in ${String(a.name ?? "")}`, detail: `${Array.isArray(a.values) ? a.values.length : 0} values` }),
    run: async (a) => {
      const s = await getClient().officeSheets.get(gsheetFileName(a.name));
      const wb = s.workbook as Workbook;
      const sheet = a.sheet ? wb.sheets.find((x) => x.name === String(a.sheet)) : wb.sheets[0];
      if (!sheet) return "ERROR: no such worksheet";
      const i = sheet.columns.findIndex((c) => c.name.toLowerCase() === String(a.column ?? "").toLowerCase());
      if (i < 0) return `ERROR: no column "${String(a.column)}" — columns: ${sheet.columns.map((c) => c.name).join(", ")}`;
      const values = Array.isArray(a.values) ? (a.values as Array<string | number | null>) : null;
      if (!values) return "ERROR: values must be an array";
      values.forEach((v, r) => {
        if (r >= sheet.rows.length) return;
        const row = sheet.rows[r]!;
        while (row.length <= i) row.push(null);
        row[i] = v;
      });
      const r = await saveWorkbook(a.name, s.title, wb);
      return `filled ${Math.min(values.length, sheet.rows.length)} values into "${sheet.columns[i]!.name}" (${r.file})`;
    },
  },
  {
    name: "add_chart",
    doc: 'add_chart(name, chart, sheet?) — add a chart to a workbook. chart = {type: bar|line|area|pie|scatter|combo, title?, categories?: "A2:A13" (x labels), series: [{name?, values: "B2:B13", type?, color?}], stacked?, legend?}. The chart is stored on the sheet and rendered (SVG) in the panel + exports. Returns its id.',
    action: (a) => ({ kind: "edit", title: `Add chart to "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const s = await getClient().officeSheets.get(gsheetFileName(a.name));
      const wb = s.workbook as Workbook;
      const sheet = a.sheet ? wb.sheets.find((x) => x.name === String(a.sheet)) : wb.sheets[0];
      if (!sheet) return "ERROR: no such worksheet";
      const c = (a.chart ?? a) as Record<string, unknown>;
      const rawSeries = Array.isArray(c.series) ? c.series : [];
      if (!rawSeries.length) return 'ERROR: add_chart needs series: [{values:"B2:B13"}]';
      const chart: ChartSpec = {
        id: `chart_${randomUUID().slice(0, 8)}`,
        type: (["bar", "line", "area", "pie", "scatter", "combo"].includes(String(c.type)) ? c.type : "bar") as ChartSpec["type"],
        ...(c.title ? { title: String(c.title) } : {}),
        ...(c.categories ? { categoriesRef: String(c.categories) } : {}),
        series: rawSeries.map((r) => {
          const o = (r ?? {}) as Record<string, unknown>;
          return { valuesRef: String(o.values ?? o.valuesRef ?? ""), ...(o.name ? { name: String(o.name) } : {}), ...(o.type ? { type: o.type as ChartSpec["type"] } : {}), ...(o.color ? { color: String(o.color) } : {}) };
        }).filter((x) => x.valuesRef),
        ...(c.stacked ? { stacked: true } : {}),
        ...(c.legend === false ? { legend: false } : {}),
      };
      if (!chart.series.length) return 'ERROR: each series needs a values range like "B2:B13"';
      (sheet.charts ??= []).push(chart);
      const r = await saveWorkbook(a.name, s.title, wb);
      return `added ${chart.type} chart ${chart.id} to ${r.file}`;
    },
  },
  {
    name: "update_chart",
    doc: "update_chart(name, chart_id, patch, sheet?) — merge patch into a chart (same fields as add_chart), or pass remove:true to delete it.",
    action: (a) => ({ kind: "edit", title: `Update chart in "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const s = await getClient().officeSheets.get(gsheetFileName(a.name));
      const wb = s.workbook as Workbook;
      const sheet = a.sheet ? wb.sheets.find((x) => x.name === String(a.sheet)) : wb.sheets[0];
      if (!sheet?.charts) return "ERROR: no charts on that sheet";
      const id = String(a.chart_id ?? "");
      const idx = sheet.charts.findIndex((c) => c.id === id);
      if (idx < 0) return `ERROR: no chart "${id}" — ids: ${sheet.charts.map((c) => c.id).join(", ")}`;
      if (a.remove) { sheet.charts.splice(idx, 1); await saveWorkbook(a.name, s.title, wb); return `removed chart ${id}`; }
      const p = (a.patch ?? {}) as Partial<ChartSpec>;
      sheet.charts[idx] = { ...sheet.charts[idx]!, ...p, id };
      await saveWorkbook(a.name, s.title, wb);
      return `updated chart ${id}`;
    },
  },
  {
    name: "add_conditional_format",
    doc: 'add_conditional_format(name, range, kind, sheet?, …) — paint a range by rule. kind: "colorScale" (scale:{min,mid?,max} hex), "dataBar" (bar:{color}), "cellRule"/"textRule" (op: gt|lt|gte|lte|eq|neq|between|contains|startsWith|endsWith + value[,value2] + style:{fill,color,bold}), "iconSet" (iconSet: arrows|traffic|flags, thresholds:[…]).',
    action: (a) => ({ kind: "edit", title: `Format ${String(a.range ?? "")} in "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const s = await getClient().officeSheets.get(gsheetFileName(a.name));
      const wb = s.workbook as Workbook;
      const sheet = a.sheet ? wb.sheets.find((x) => x.name === String(a.sheet)) : wb.sheets[0];
      if (!sheet) return "ERROR: no such worksheet";
      const range = String(a.range ?? "");
      if (!/^[A-Z]+\d+(:[A-Z]+\d+)?$/i.test(range)) return 'ERROR: range like "B2:B100"';
      const rule = {
        id: `cf_${randomUUID().slice(0, 8)}`, range,
        kind: (["colorScale", "dataBar", "cellRule", "textRule", "iconSet"].includes(String(a.kind)) ? a.kind : "cellRule") as CondFormat["kind"],
        ...(a.scale ? { scale: a.scale as CondFormat["scale"] } : {}),
        ...(a.bar ? { bar: a.bar as CondFormat["bar"] } : {}),
        ...(a.op ? { op: a.op as CondFormat["op"] } : {}),
        ...(a.value !== undefined ? { value: a.value as string | number } : {}),
        ...(a.value2 !== undefined ? { value2: a.value2 as string | number } : {}),
        ...(a.style ? { style: a.style as CellStyle } : {}),
        ...(a.iconSet ? { iconSet: a.iconSet as CondFormat["iconSet"] } : {}),
        ...(Array.isArray(a.thresholds) ? { thresholds: a.thresholds as number[] } : {}),
      };
      (sheet.condFormats ??= []).push(rule);
      const r = await saveWorkbook(a.name, s.title, wb);
      return `added ${rule.kind} on ${range} (${r.file})`;
    },
  },
  {
    name: "set_cell_style",
    doc: 'set_cell_style(name, range, style, sheet?) — style a cell or range. style = {bold?, italic?, underline?, color?(hex text), fill?(hex bg), align?(left|center|right), numberFormat?("#,##0.00"|"0%"|"$#,##0"|"yyyy-mm-dd")}. Applies to every cell in the range.',
    action: (a) => ({ kind: "edit", title: `Style ${String(a.range ?? "")} in "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const s = await getClient().officeSheets.get(gsheetFileName(a.name));
      const wb = s.workbook as Workbook;
      const sheet = a.sheet ? wb.sheets.find((x) => x.name === String(a.sheet)) : wb.sheets[0];
      if (!sheet) return "ERROR: no such worksheet";
      const style = (a.style ?? {}) as CellStyle;
      const range = String(a.range ?? "");
      const [ca, cb] = range.split(":");
      const ra = parseA1(ca ?? ""), rb = parseA1(cb ?? ca ?? "");
      if (!ra || !rb) return 'ERROR: range like "B2" or "B2:D10"';
      sheet.styles ??= {};
      let n = 0;
      for (let r = Math.min(ra.row, rb.row); r <= Math.max(ra.row, rb.row); r++)
        for (let c = Math.min(ra.col, rb.col); c <= Math.max(ra.col, rb.col); c++) {
          const key = `${colLetter(c)}${r + 1}`;
          sheet.styles[key] = { ...sheet.styles[key], ...style };
          n++;
        }
      const rr = await saveWorkbook(a.name, s.title, wb);
      return `styled ${n} cell${n === 1 ? "" : "s"} in ${rr.file}`;
    },
  },
  {
    name: "add_named_range",
    doc: 'add_named_range(name, range_name, range, sheet?) — define a workbook-scoped named range (e.g. range_name="revenue", range="B2:B13") usable in formulas: =SUM(revenue). range_name must be a bare identifier (letters/digits/_).',
    action: (a) => ({ kind: "edit", title: `Name range "${String(a.range_name ?? "")}" in "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const s = await getClient().officeSheets.get(gsheetFileName(a.name));
      const wb = s.workbook as Workbook;
      const sheet = a.sheet ? wb.sheets.find((x) => x.name === String(a.sheet)) : wb.sheets[0];
      if (!sheet) return "ERROR: no such worksheet";
      const rn = String(a.range_name ?? "");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rn)) return "ERROR: range_name must be a bare identifier (no spaces/A1)";
      const range = String(a.range ?? "");
      if (!/^[A-Z]+\d+(:[A-Z]+\d+)?$/i.test(range)) return 'ERROR: range like "B2:B13"';
      const nr: NamedRange = { name: rn, sheet: sheet.name, range: range.toUpperCase() };
      wb.namedRanges = [...(wb.namedRanges ?? []).filter((x) => x.name.toLowerCase() !== rn.toLowerCase()), nr];
      const r = await saveWorkbook(a.name, s.title, wb);
      return `named ${rn} → ${sheet.name}!${nr.range} (${r.file})`;
    },
  },
  {
    name: "add_data_validation",
    doc: 'add_data_validation(name, range, rule, sheet?) — constrain a range. rule = {kind:"list", source:["A","B"]} for a dropdown, {kind:"listRange", ref:"F1:F9"}, {kind:"number", op:"between", value, value2}, {kind:"date", …}, {kind:"textLen", op, value}, or {kind:"custom", formula:"=…"}.',
    action: (a) => ({ kind: "edit", title: `Validate ${String(a.range ?? "")} in "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const s = await getClient().officeSheets.get(gsheetFileName(a.name));
      const wb = s.workbook as Workbook;
      const sheet = a.sheet ? wb.sheets.find((x) => x.name === String(a.sheet)) : wb.sheets[0];
      if (!sheet) return "ERROR: no such worksheet";
      const range = String(a.range ?? "");
      const rule = a.rule as DataValidation["rule"] | undefined;
      if (!range || !rule || typeof rule.kind !== "string") return "ERROR: pass range + rule{kind,…}";
      (sheet.validations ??= []).push({ id: `dv_${randomUUID().slice(0, 8)}`, range, rule, ...(a.strict ? { strict: true } : {}) });
      const r = await saveWorkbook(a.name, s.title, wb);
      return `added ${rule.kind} validation on ${range} (${r.file})`;
    },
  },
  {
    name: "manage_sheets",
    doc: 'manage_sheets(name, op) — multi-sheet tab ops. op is ONE of: {add:{name, columns?}}, {rename:{from, to}}, {delete:"Sheet2"}, {reorder:["Sheet1","Sheet2"]}, {freeze:{sheet?, rows?, cols?}}.',
    action: (a) => ({ kind: "edit", title: `Manage sheets in "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const s = await getClient().officeSheets.get(gsheetFileName(a.name));
      const wb = s.workbook as Workbook;
      const op = (a.op ?? a) as Record<string, unknown>;
      if (op.add) {
        const o = op.add as { name?: unknown; columns?: unknown };
        const cols = Array.isArray(o.columns) ? o.columns.map((c) => ({ name: String(c) })) : [{ name: "A" }, { name: "B" }, { name: "C" }];
        wb.sheets.push({ name: String(o.name ?? `Sheet${wb.sheets.length + 1}`), columns: cols, rows: [] });
      } else if (op.rename) {
        const o = op.rename as { from?: unknown; to?: unknown };
        const sh = wb.sheets.find((x) => x.name === String(o.from));
        if (!sh) return `ERROR: no sheet "${String(o.from)}"`;
        sh.name = String(o.to);
      } else if (op.delete) {
        if (wb.sheets.length <= 1) return "ERROR: a workbook needs at least one sheet";
        const i = wb.sheets.findIndex((x) => x.name === String(op.delete));
        if (i < 0) return `ERROR: no sheet "${String(op.delete)}"`;
        wb.sheets.splice(i, 1);
      } else if (Array.isArray(op.reorder)) {
        const order = op.reorder.map(String);
        wb.sheets.sort((x, y) => order.indexOf(x.name) - order.indexOf(y.name));
      } else if (op.freeze) {
        const o = op.freeze as { sheet?: unknown; rows?: unknown; cols?: unknown };
        const sh = o.sheet ? wb.sheets.find((x) => x.name === String(o.sheet)) : wb.sheets[0];
        if (!sh) return "ERROR: no such worksheet";
        sh.frozen = { ...(o.rows !== undefined ? { rows: Number(o.rows) } : {}), ...(o.cols !== undefined ? { cols: Number(o.cols) } : {}) };
      } else return "ERROR: op must be one of add/rename/delete/reorder/freeze";
      const r = await saveWorkbook(a.name, s.title, wb);
      return `sheets: ${wb.sheets.map((x) => x.name).join(", ")} (${r.file})`;
    },
  },
  {
    name: "delete_sheets",
    doc: "delete_sheets(name) — permanently delete a workbook from the org library",
    action: (a) => ({ kind: "dangerous", title: `Delete workbook "${String(a.name ?? "")}"` }),
    run: async (a) => {
      await getClient().officeSheets.delete(gsheetFileName(a.name));
      return `deleted ${gsheetFileName(a.name)}`;
    },
  },
  {
    name: "open_sheets",
    doc: "open_sheets(name?) — open the Sheets panel beside this conversation; with a workbook name it opens straight into it",
    action: (a) => ({ kind: "command", title: a.name ? `Open workbook "${String(a.name)}"` : "Open the Sheets panel" }),
    run: async (a) => {
      if (!a.name) { openGSheetPanel(); return "opened the Sheets panel"; }
      const file = gsheetFileName(a.name);
      const s = await getClient().officeSheets.get(file).catch(() => null);
      if (!s) {
        const sheets = await getClient().officeSheets.list();
        return `ERROR: no workbook "${file}" — available: ${sheets.map((x) => x.file).join(", ") || "(none)"}`;
      }
      openGSheetPanel(file, s.title);
      return `opened ${file} in the Sheets panel`;
    },
  },
  // ── Glyphh DESIGN: org design systems — the brand kit (colors, fonts, type,
  //    styles, assets) Apps consume first and Slides second. Extraction tools
  //    return EVIDENCE (deterministic counts) for the model to judge; the
  //    document itself is authored with create_design/update_design. ──
  {
    name: "list_designs",
    doc: "list_designs() — the org's design systems (brand kits): file, title. Check this BEFORE building an app or deck — when the org has a system, using it is the default.",
    action: () => ({ kind: "read", title: "List design systems" }),
    run: async () => {
      const designs = await getClient().designs.list();
      if (!designs.length) return "(no design systems yet — create_design builds one)";
      return cap(JSON.stringify(designs.map(({ file, title }) => ({ file, title })), null, 1));
    },
  },
  {
    name: "read_design",
    doc: "read_design(name, raw?) — a design system's readable summary (colors, fonts, type, styles, tone, assets, provenance). raw:true returns the exact document JSON for update_design surgery.",
    action: (a) => ({ kind: "read", title: `Read design "${String(a.name ?? "")}"${a.raw ? " (raw)" : ""}` }),
    run: async (a) => {
      const file = designFileName(a.name);
      if (a.raw) {
        const d = await getClient().designs.get(file);
        return cap(JSON.stringify(d.document, null, 1), READ_CAP);
      }
      const t = await getClient().designs.text(file);
      return cap(`${t.title} (${t.file})\n\n${t.text}`, READ_CAP);
    },
  },
  {
    name: "design_css",
    doc: "design_css(name) — the system as a :root { --design-* } CSS block: colors, fonts, type scale, radius, shadow, gradient. Paste it into an app's stylesheet and map the app's own variables onto --design-primary, --design-font-display, etc.",
    action: (a) => ({ kind: "read", title: `Design CSS for "${String(a.name ?? "")}"` }),
    run: async (a) => cap(await getClient().designs.css(designFileName(a.name)), READ_CAP),
  },
  {
    name: "create_design",
    doc: 'create_design(name, document) — create or overwrite an org design system. document: {version: 1, name, colors: {primary, background, text (required, hex), accent?, surface?, muted?, palette?: [{name, hex, role?}]}, fonts: {display: {family, fallback?, weights?, source?: "system"|"google"|"custom"}, body: {…}, mono?: {…}}, type?: {baseSize, scale, headingWeight, letterSpacing}, styles?: {radius, borderWidth, shadow: "none"|"soft"|"medium"|"bold", density, gradient: {from, to, angle}}, brand?: {tagline, tone: […]}, sources?: [{type: "image"|"site"|"prompt", ref, note?, extractedAt}], imagery?: [{assetId, kind: "image"|"video", title, role?}] — ADOPT generated media into the system (generate_image an icon set, then reference the asset ids here with roles like "icon"/"hero"/"motion")}. Record where every choice CAME from in sources.',
    action: (a) => ({ kind: "edit", title: `Create design "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const doc = a.document as DesignSystem | undefined;
      if (!doc || typeof doc !== "object") return "ERROR: pass document — the design-system object (see the doc string)";
      const meta = await getClient().designs.put(designFileName(a.name), doc);
      return `created ${meta.file} ("${meta.title}") — it's in the org's Design panel on every surface; open_design("${meta.file}") opens the studio, design_css("${meta.file}") gives the consumable contract`;
    },
  },
  {
    name: "update_design",
    doc: "update_design(name, patch) — merge a partial document into a system: top-level sections (colors, fonts, type, styles, brand) merge field-by-field; palette/sources/tone REPLACE when present. Read raw first when unsure.",
    action: (a) => ({ kind: "edit", title: `Update design "${String(a.name ?? "")}"`, detail: Object.keys((a.patch as object) ?? {}).join(", ") }),
    run: async (a) => {
      const patch = a.patch as Record<string, unknown> | undefined;
      if (!patch || typeof patch !== "object") return "ERROR: pass patch — the partial document to merge";
      const file = designFileName(a.name);
      const current = await getClient().designs.get(file);
      const doc = current.document as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        const existing = doc[key];
        doc[key] = value && typeof value === "object" && !Array.isArray(value) && existing && typeof existing === "object" && !Array.isArray(existing)
          ? { ...existing, ...value }
          : value;
      }
      const meta = await getClient().designs.put(file, doc as unknown as DesignSystem);
      return `updated ${meta.file} ("${meta.title}")`;
    },
  },
  {
    name: "delete_design",
    doc: "delete_design(name) — permanently delete a design system (document + assets) from the org library",
    action: (a) => ({ kind: "dangerous", title: `Delete design "${String(a.name ?? "")}"` }),
    run: async (a) => {
      await getClient().designs.delete(designFileName(a.name));
      return `deleted ${String(a.name)}`;
    },
  },
  {
    name: "extract_site_design",
    doc: "extract_site_design(url) — fetch a page (+ its first stylesheets) and COUNT the colors, font families, radii, and Google Fonts it actually uses. Returns evidence ranked by frequency (neutrals flagged) — pick the true brand colors from it, then create_design.",
    action: (a) => ({ kind: "read", title: `Extract design from ${String(a.url ?? "")}` }),
    run: async (a) => cap(JSON.stringify(await extractSiteDesign(String(a.url ?? "")), null, 1), READ_CAP),
  },
  {
    name: "read_image_palette",
    doc: "read_image_palette(path) — the dominant colors of a local image (logo beats screenshot), quantized deterministically: [{hex, share%}]. Cross-check your own read of the image against it.",
    action: (a) => ({ kind: "read", title: `Palette of ${String(a.path ?? "")}` }),
    run: async (a) => cap(JSON.stringify(await imagePalette(String(a.path ?? "")), null, 1)),
  },
  {
    name: "generate_design_mockup",
    doc: "generate_design_mockup(name, prompt, title?, role?) — generate a MOCKUP image in a design system's own language: the system's palette, fonts, and tone are woven into the image prompt automatically, so describe only WHAT the mockup shows (landing hero, app screen, poster, packaging…). The result is a real media asset (visible in Images and on the Drive), adopted into the system's imagery, and placed on the design canvas as a draggable card. Charged in credits like any generation. role defaults to 'mockup'.",
    action: (a) => ({ kind: "edit", title: `Design mockup for "${String(a.name ?? "")}"`, detail: String(a.prompt ?? "").slice(0, 80) }),
    run: async (a) => {
      const prompt = String(a.prompt ?? "").trim();
      if (!prompt) return "ERROR: pass prompt — what the mockup shows";
      const file = designFileName(a.name);
      const current = await getClient().designs.get(file);
      const doc = current.document as unknown as {
        name?: string;
        colors?: { primary?: string; accent?: string; background?: string; surface?: string };
        fonts?: { display?: { family?: string }; body?: { family?: string } };
        brand?: { tagline?: string; tone?: string[] };
        imagery?: Array<{ assetId: string; kind: string; title: string; role?: string }>;
        canvas?: { items?: Record<string, { x: number; y: number; w?: number }> };
      };
      const c = doc.colors ?? {};
      const styleBits = [
        c.primary && `primary ${c.primary}`,
        c.accent && `accent ${c.accent}`,
        c.background && `background ${c.background}`,
        c.surface && `surfaces ${c.surface}`,
      ].filter(Boolean).join(", ");
      const fontBits = [doc.fonts?.display?.family, doc.fonts?.body?.family].filter(Boolean).join(" / ");
      const styled = [
        prompt,
        `High-fidelity brand mockup in the "${doc.name ?? String(a.name)}" design system`,
        styleBits && `strict palette: ${styleBits}`,
        fontBits && `typography in the style of ${fontBits}`,
        doc.brand?.tone?.length ? `tone: ${doc.brand.tone.join(", ")}` : "",
        "clean presentation shot, no watermarks, no lorem-ipsum walls",
      ].filter(Boolean).join(". ");
      const title = String(a.title ?? "").trim() || `${doc.name ?? String(a.name)} mockup`;
      const role = String(a.role ?? "").trim() || "mockup";
      const made = await genImageAsset(styled, title);
      // Adopt into the system + land on the canvas (same keying the panel uses).
      const n = (doc.imagery ?? []).length;
      doc.imagery = [...(doc.imagery ?? []), { assetId: made.id, kind: "image", title, role }];
      doc.canvas ??= {};
      doc.canvas.items ??= {};
      doc.canvas.items[`img:${made.id}`] = { x: (n % 2) * 620, y: 760 + Math.floor(n / 2) * 300, w: 560 };
      await getClient().designs.put(file, doc as unknown as DesignSystem);
      return `mockup generated (${made.credits} credits): asset ${made.id} ("${title}", role ${role}) — saved to the org media library (Images + Drive), adopted into ${file}, and placed on the design canvas; open_design("${file}") shows it`;
    },
  },
  // ── Glyphh IMAGE / VIDEO / SOUNDS: generation with ANY catalog media model,
  //    metered in credits (the job is the charge; failure charges nothing).
  //    Models ride the org's governed catalog — list_media_models shows what
  //    this org may spend on. Outputs land in the org media library. ──
  {
    name: "list_media_models",
    doc: "list_media_models() — the media models this org can generate with (id, modality image|video|speech|music|audio, rate unit). Pick from HERE; a model the org hasn't enabled will refuse.",
    action: () => ({ kind: "read", title: "List media models" }),
    run: async () => {
      const models = await getClient().models.available();
      const media = models.filter((m) => /image|video|speech|music|audio/.test(String((m as { modality?: string }).modality ?? "")));
      if (!media.length) return "(no media models enabled for this org — an admin enables them in the catalog)";
      return cap(JSON.stringify(media.map((m) => ({ id: m.id, modality: (m as { modality?: string }).modality })), null, 1));
    },
  },
  {
    name: "generate_image",
    doc: 'generate_image(prompt, model?, size?, title?) — generate an image (costs credits; charged only on success). model defaults to the org\'s first image model; size like "1024x1024"|"1536x1024". Returns the asset id + credits charged. open_image(id) shows it.',
    action: (a) => ({ kind: "network", title: `Generate image`, detail: String(a.prompt ?? "").slice(0, 200) }),
    run: (a) => generateMedia("image", a),
  },
  {
    name: "generate_video",
    doc: 'generate_video(prompt, model?, seconds?, size?, image_url?, title?) — generate a video clip (costs credits — video is the expensive one; say the cost). size "16:9"|"9:16"|"1:1"; image_url drives image-to-video where the model supports it. Minutes-long wait is normal.',
    action: (a) => ({ kind: "network", title: `Generate video`, detail: String(a.prompt ?? "").slice(0, 200) }),
    run: (a) => generateMedia("video", a),
  },
  {
    name: "generate_music",
    doc: "generate_music(prompt, seconds?, model?, title?) — generate a music track from a text brief (genre, mood, instrumentation, tempo). Costs credits by the minute.",
    action: (a) => ({ kind: "network", title: `Generate music`, detail: String(a.prompt ?? "").slice(0, 200) }),
    run: (a) => generateMedia("music", a),
  },
  {
    name: "generate_sound_effect",
    doc: "generate_sound_effect(prompt, seconds?, title?) — generate a sound effect ('glass shattering on a marble floor', max ~22s). Costs credits per generation.",
    action: (a) => ({ kind: "network", title: `Generate sound effect`, detail: String(a.prompt ?? "").slice(0, 200) }),
    run: (a) => generateMedia("audio", a),
  },
  {
    name: "speak",
    doc: "speak(text, voice?, model?, title?) — text-to-speech into the Sounds library (costs credits by characters). voice is a provider voice id; omit for the stock narrator.",
    action: (a) => ({ kind: "network", title: `Speak ${String(a.text ?? "").length} chars` }),
    run: (a) => generateMedia("speech", { ...a, prompt: a.text }),
  },
  {
    name: "upload_media",
    doc: "upload_media(path, title?, kind?) — upload a local file (image/video/audio) into the org media library (presigned to R2). Returns the asset id.",
    action: (a) => ({ kind: "read", title: `Upload ${String(a.path ?? "")}` }),
    run: async (a) => {
      const r = await uploadMediaFile(String(a.path ?? ""), {
        ...(a.title ? { title: String(a.title) } : {}),
        ...(a.kind ? { kind: a.kind as never } : {}),
      });
      return `uploaded ${r.id} ("${r.title}", ${r.kind}) — open_${r.kind === "image" ? "image" : r.kind === "video" ? "video" : "sounds"}("${r.id}") shows it`;
    },
  },
  {
    name: "list_media",
    doc: "list_media(kind?, q?) — the org media library (kind image|video|audio|voice|avatar|recording|script; q searches titles + prompts). Returns id, title, status, duration/size.",
    action: (a) => ({ kind: "read", title: `List media${a.kind ? ` (${String(a.kind)})` : ""}` }),
    run: async (a) => {
      const assets = await getClient().media.list(a.kind ? (String(a.kind) as never) : undefined, a.q ? String(a.q) : undefined);
      if (!assets.length) return "(no media yet — generate_* or upload_media adds some)";
      return cap(JSON.stringify(assets.slice(0, 60).map((x) => ({
        id: x.id, kind: x.kind, title: x.title, status: x.status,
        ...(x.durationMs ? { seconds: Math.round(x.durationMs / 1000) } : {}),
      })), null, 1));
    },
  },
  {
    name: "read_media",
    doc: "read_media(id) — one asset's full metadata (mime, dimensions, duration, generation prompt/model, cost trail).",
    action: (a) => ({ kind: "read", title: `Read media ${String(a.id ?? "")}` }),
    run: async (a) => cap(JSON.stringify(await getClient().media.get(String(a.id ?? "")), null, 1)),
  },
  {
    name: "open_image",
    doc: "open_image(id?) — open the Image panel; with an asset id it opens straight onto that image",
    action: (a) => ({ kind: "command", title: a.id ? "Open image" : "Open the Image panel" }),
    run: async (a) => { openMediaPanel("gimage", a.id ? String(a.id) : undefined); return "opened the Image panel"; },
  },
  {
    name: "open_video",
    doc: "open_video(id?) — open the Video panel; with an asset id it opens straight onto that clip",
    action: (a) => ({ kind: "command", title: a.id ? "Open video" : "Open the Video panel" }),
    run: async (a) => { openMediaPanel("gvideo", a.id ? String(a.id) : undefined); return "opened the Video panel"; },
  },
  {
    name: "open_sounds",
    doc: "open_sounds(id?) — open the Sounds panel (music, sound effects, speech); with an asset id it opens straight onto that track",
    action: (a) => ({ kind: "command", title: a.id ? "Open sound" : "Open the Sounds panel" }),
    run: async (a) => { openMediaPanel("gsound", a.id ? String(a.id) : undefined); return "opened the Sounds panel"; },
  },
  // ── MUSIC STUDIO: artists (a look + a voice + a style) and songs (lyrics +
  //    prompt + band + LINEAGE). Generation is generate_music; these tools own
  //    the DOCUMENTS the studio iterates on. ──
  {
    name: "list_artists",
    doc: "list_artists() — the org's artist profiles (id, name, style, voice/look state)",
    action: () => ({ kind: "read", title: "List artists" }),
    run: async () => {
      const artists = await getClient().music.artists();
      if (!artists.length) return "(no artists yet — create_artist builds one)";
      return cap(JSON.stringify(artists.map((a) => ({ id: a.id, name: a.name, style: a.style, voice: a.voiceAssetId ? "sample" : a.voiceId ? "synth" : "none", look: !!a.avatarAssetId })), null, 1));
    },
  },
  {
    name: "create_artist",
    doc: "create_artist(name, style?, voice_id?, avatar_asset_id?) — create a band member: a name, a style line ('gravel-voiced blues shouter'), optionally a provider voice id and a look (generate_image an avatar first, pass its asset id). Voice-from-recording rides the Artists tab (consent flow).",
    action: (a) => ({ kind: "edit", title: `Create artist "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const artist = await getClient().music.createArtist({
        name: String(a.name ?? "").trim(),
        ...(a.style ? { style: String(a.style) } : {}),
        ...(a.voice_id ? { voiceId: String(a.voice_id) } : {}),
        ...(a.avatar_asset_id ? { avatarAssetId: String(a.avatar_asset_id) } : {}),
      });
      return `created artist ${artist.id} ("${artist.name}")`;
    },
  },
  {
    name: "list_songs",
    doc: "list_songs() — the org's songs: id, title, band, whether it has audio, lineage parent",
    action: () => ({ kind: "read", title: "List songs" }),
    run: async () => {
      const songs = await getClient().music.songs();
      if (!songs.length) return "(no songs yet — create_song starts one)";
      return cap(JSON.stringify(songs.map((s) => ({ id: s.id, title: s.title, band: s.bandType, hasAudio: !!s.audioAssetId, parent: s.parentId })), null, 1));
    },
  },
  {
    name: "read_song",
    doc: "read_song(id) — one song in full: lyrics, prompt, band type, artists, instruments, audio asset, visuals, lineage",
    action: (a) => ({ kind: "read", title: `Read song ${String(a.id ?? "")}` }),
    run: async (a) => cap(JSON.stringify(await getClient().music.song(String(a.id ?? "")), null, 1), READ_CAP),
  },
  {
    name: "create_song",
    doc: 'create_song(title, lyrics?, prompt?, band_type?, artist_ids?, instruments?) — start a song document. instruments: [{instrument: "drums", tweak: "tight, dry"}]. Then regenerate_song makes the audio (metered).',
    action: (a) => ({ kind: "edit", title: `Create song "${String(a.title ?? "")}"` }),
    run: async (a) => {
      const song = await getClient().music.createSong({
        title: String(a.title ?? "Untitled"),
        ...(a.lyrics ? { lyrics: String(a.lyrics) } : {}),
        ...(a.prompt ? { prompt: String(a.prompt) } : {}),
        ...(a.band_type ? { bandType: String(a.band_type) } : {}),
        ...(Array.isArray(a.artist_ids) ? { artistIds: a.artist_ids.map(String) } : {}),
        ...(Array.isArray(a.instruments) ? { instruments: a.instruments as never } : {}),
      });
      return `created song ${song.id} ("${song.title}") — regenerate_song("${song.id}") makes the audio; open_song("${song.id}") opens the editor`;
    },
  },
  {
    name: "update_song",
    doc: "update_song(id, title?, lyrics?, prompt?, band_type?, artist_ids?, instruments?, visuals?) — evolve the document (the audio stays until regenerate_song)",
    action: (a) => ({ kind: "edit", title: `Update song ${String(a.id ?? "")}`, detail: Object.keys(a).filter((k) => k !== "id").join(", ") }),
    run: async (a) => {
      const song = await getClient().music.updateSong(String(a.id ?? ""), {
        ...(a.title ? { title: String(a.title) } : {}),
        ...(a.lyrics !== undefined ? { lyrics: String(a.lyrics) } : {}),
        ...(a.prompt !== undefined ? { prompt: String(a.prompt) } : {}),
        ...(a.band_type !== undefined ? { bandType: String(a.band_type) } : {}),
        ...(Array.isArray(a.artist_ids) ? { artistIds: a.artist_ids.map(String) } : {}),
        ...(Array.isArray(a.instruments) ? { instruments: a.instruments as never } : {}),
        ...(Array.isArray(a.visuals) ? { visuals: a.visuals.map(String) } : {}),
      });
      return `updated ${song.id} ("${song.title}")`;
    },
  },
  {
    name: "regenerate_song",
    doc: "regenerate_song(id, model?, seconds?) — SERVER-SIDE regenerate: composes the song's prompt + band + instruments + lyrics, creates the CHILD version immediately (title auto-numbered 'Base - NN'), runs the metered music model, attaches the take on success. Reports credits.",
    action: (a) => ({ kind: "network", title: `Regenerate song ${String(a.id ?? "")}` }),
    run: async (a) => {
      const started = await getClient().music.regenerateSong(String(a.id ?? ""), {
        ...(a.model ? { model: String(a.model) } : {}),
        ...(a.seconds !== undefined ? { seconds: Number(a.seconds) } : {}),
      });
      const job = await getClient().media.waitForJob(started.job.id);
      if (job.status === "failed") return `ERROR: generation failed — ${job.error ?? "unknown"} (nothing was charged; child ${started.song.id} has no take)`;
      return `regenerated — child song ${started.song.id} ("${started.song.title}"), ${job.creditsCharged.toFixed(2)} credits charged. open_song("${started.song.id}") opens the editor.`;
    },
  },
  {
    name: "open_band",
    doc: "open_band() — open the Glyphh Band app (Songs · Artists · Music Video)",
    action: () => ({ kind: "command", title: "Open Band" }),
    run: async () => { openMediaPanel("gband"); return "opened Band"; },
  },
  {
    name: "open_song",
    doc: "open_song(id) — open the Sounds panel straight into that song's editor page",
    action: () => ({ kind: "command", title: "Open song editor" }),
    run: async (a) => {
      openMediaPanel("gsound", undefined, String(a.id ?? ""));
      return "opened the song editor";
    },
  },
  {
    name: "create_band",
    doc: 'create_band(name, band_type, members, instruments?, song_prompt?, lyrics?) — BUILD THE WHOLE BAND in one call (heavily metered — say the cost after). members: [{name, description}] (≤4) — each gets TWO photoreal LOOKS, front AND back (4 images per member), saved to the Image library and onto the artist (meta.looks; look 1 active). instruments: [{instrument, tweak?}] (≤6) — each gets a generated look image. Then the song document is created wired to it all. Finish with open_song.',
    action: (a) => ({ kind: "network", title: `Create band "${String(a.name ?? "")}"`, detail: `${Array.isArray(a.members) ? a.members.length : 0} members` }),
    run: async (a) => {
      const bandType = String(a.band_type ?? "").trim();
      const members = (Array.isArray(a.members) ? a.members : []).slice(0, 4) as Array<{ name?: unknown; description?: unknown }>;
      if (!members.length) return "ERROR: members is required — [{name, description}]";
      const instruments = (Array.isArray(a.instruments) ? a.instruments : []).slice(0, 6) as Array<{ instrument?: unknown; tweak?: unknown }>;
      let credits = 0;
      const artistIds: string[] = [];
      const lines: string[] = [];
      for (const m of members) {
        const name = String(m.name ?? "").trim() || "member";
        const desc = String(m.description ?? "").trim();
        const look1 = await genLook(name, desc, bandType);
        const look2 = await genLook(name, `${desc} — an alternate second look, different outfit and hair`, bandType);
        credits += look1.credits + look2.credits;
        const artist = await getClient().music.createArtist({
          name, style: desc,
          avatarAssetId: look1.front,
          meta: { looks: [{ front: look1.front, back: look1.back }, { front: look2.front, back: look2.back }], activeLook: 0 },
        });
        artistIds.push(artist.id);
        lines.push(`${name}: artist ${artist.id}, 2 looks (front+back each)`);
      }
      const instRows: Array<{ instrument: string; tweak: string; lookAssetId?: string }> = [];
      for (const inst of instruments) {
        const kind = String(inst.instrument ?? "").trim() || "guitar";
        const tweak = String(inst.tweak ?? "").trim();
        const img = await genImageAsset(
          `Photorealistic product photograph of a ${kind}${tweak ? `, ${tweak}` : ""}, for a ${bandType || "rock"} band, dark stage backdrop, dramatic lighting`,
          `${kind} — look`,
        );
        credits += img.credits;
        instRows.push({ instrument: kind, tweak, lookAssetId: img.id });
        lines.push(`${kind}: look image ${img.id}`);
      }
      const song = await getClient().music.createSong({
        title: String(a.name ?? "Untitled"),
        bandType,
        artistIds,
        instruments: instRows,
        ...(a.song_prompt ? { prompt: String(a.song_prompt) } : {}),
        ...(a.lyrics ? { lyrics: String(a.lyrics) } : {}),
      });
      return cap(`band built — ${credits.toFixed(2)} credits total.\n${lines.join("\n")}\nsong ${song.id} ("${song.title}") — regenerate_song("${song.id}") makes the audio; open_song("${song.id}") opens the studio.`);
    },
  },
  {
    name: "generate_artist_look",
    doc: "generate_artist_look(artist_id, description?) — a fresh look for a band member: photoreal FRONT + BACK pair, saved to Images, appended to the artist's looks and made active. Metered (2 images).",
    action: (a) => ({ kind: "network", title: `New look for artist ${String(a.artist_id ?? "")}` }),
    run: async (a) => {
      const music = getClient().music;
      const artist = (await music.artists()).find((x) => x.id === String(a.artist_id ?? ""));
      if (!artist) return "ERROR: unknown artist — list_artists shows ids";
      const look = await genLook(artist.name, String(a.description ?? artist.style ?? ""), "");
      const looks = [...((artist.meta.looks as Array<{ front: string; back: string }> | undefined) ?? []), { front: look.front, back: look.back }];
      await music.updateArtist(artist.id, {
        avatarAssetId: look.front,
        meta: { ...artist.meta, looks, activeLook: looks.length - 1 },
      });
      return `new look ${looks.length} for ${artist.name} (front+back) — ${look.credits.toFixed(2)} credits. open_image("${look.front}") shows it.`;
    },
  },
  {
    name: "generate_instrument_look",
    doc: "generate_instrument_look(song_id, instrument, description?) — generate (or refresh) an instrument's look image on a song and save it to Images. Metered (1 image).",
    action: (a) => ({ kind: "network", title: `Instrument look: ${String(a.instrument ?? "")}` }),
    run: async (a) => {
      const music = getClient().music;
      const song = await music.song(String(a.song_id ?? ""));
      const kind = String(a.instrument ?? "").trim().toLowerCase();
      const row = song.instruments.find((i) => i.instrument.toLowerCase() === kind);
      if (!row) return `ERROR: song has no "${kind}" — its instruments: ${song.instruments.map((i) => i.instrument).join(", ") || "(none)"}`;
      const img = await genImageAsset(
        `Photorealistic product photograph of a ${row.instrument}${row.tweak ? `, ${row.tweak}` : ""}${a.description ? `, ${String(a.description)}` : ""}, for a ${song.bandType || "rock"} band, dark stage backdrop, dramatic lighting`,
        `${row.instrument} — look`,
      );
      row.lookAssetId = img.id;
      await music.updateSong(song.id, { instruments: song.instruments });
      return `${row.instrument} look regenerated — ${img.credits.toFixed(2)} credits. open_image("${img.id}") shows it.`;
    },
  },
  {
    name: "update_artist",
    doc: "update_artist(artist_id, name?, style?, voice_id?, avatar_asset_id?, active_look?) — evolve a band member; active_look (1-based) switches which look fronts the artist.",
    action: (a) => ({ kind: "edit", title: `Update artist ${String(a.artist_id ?? "")}` }),
    run: async (a) => {
      const music = getClient().music;
      const artist = (await music.artists()).find((x) => x.id === String(a.artist_id ?? ""));
      if (!artist) return "ERROR: unknown artist — list_artists shows ids";
      const patch: Record<string, unknown> = {};
      if (a.name) patch.name = String(a.name);
      if (a.style !== undefined) patch.style = String(a.style);
      if (a.voice_id !== undefined) patch.voiceId = a.voice_id ? String(a.voice_id) : null;
      if (a.avatar_asset_id) patch.avatarAssetId = String(a.avatar_asset_id);
      if (a.active_look !== undefined) {
        const looks = (artist.meta.looks as Array<{ front: string; back: string }> | undefined) ?? [];
        const idx = Math.trunc(Number(a.active_look)) - 1;
        if (idx < 0 || idx >= looks.length) return `ERROR: active_look must be 1-${looks.length}`;
        patch.meta = { ...artist.meta, activeLook: idx };
        patch.avatarAssetId = looks[idx]!.front;
      }
      const updated = await music.updateArtist(artist.id, patch as never);
      return `updated ${updated.name}`;
    },
  },
  {
    name: "open_design",
    doc: "open_design(name?) — open the Design panel beside this conversation; with a system name it opens straight into that studio",
    action: (a) => ({ kind: "command", title: a.name ? `Open design "${String(a.name)}"` : "Open the Design panel" }),
    run: async (a) => {
      if (!a.name) { openDesignPanel(); return "opened the Design panel"; }
      const file = designFileName(a.name);
      const d = await getClient().designs.get(file).catch(() => null);
      if (!d) {
        const designs = await getClient().designs.list();
        return `ERROR: no design "${file}" — available: ${designs.map((x) => x.file).join(", ") || "(none)"}`;
      }
      openDesignPanel(file, d.title);
      return `opened ${file} in the Design panel`;
    },
  },
  {
    name: "drive_move",
    doc: 'drive_move(kind, file, folder_id?) — file an Office document: kind "slides" or "docs", folder_id from drive_list (omit for the root)',
    action: (a) => ({ kind: "edit", title: `Move ${String(a.kind ?? "?")}/${String(a.file ?? "?")}` }),
    run: async (a) => {
      const kind = String(a.kind ?? "");
      if (kind !== "slides" && kind !== "docs" && kind !== "sheets") return 'ERROR: kind must be "slides", "docs" or "sheets"';
      await getClient().officeDrive.move(kind, String(a.file ?? ""), a.folder_id ? String(a.folder_id) : null);
      return `moved ${a.file} ${a.folder_id ? "into the folder" : "to the root"}`;
    },
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
    doc: 'save_workspace(name, cols, rows, cells, loop?, modelSelections?, sessionMode?, folder?) — create or update a saved workspace. cells: [{panelId, col, row, colSpan?, rowSpan?, sticky?, config?}]. panelId = an app slug from the library, or a tool: id — tool:coding (the agent), tool:preview (Browser), tool:terminal, tool:files, tool:monaco (Editor), tool:diff, tool:plan, tool:gpoint (Slides), tool:gdoc (Docs), tool:gsheet (Sheets), tool:gdrive (Drive), tool:gdesign (Design), tool:gmemory (Memory), tool:gimage (Image), tool:gvideo (Video), tool:gsound (Sounds), tool:gband (Band). Per-cell config: Browser cells take {url}; Terminal cells take {cmd} (runs after the working folder is set). At most ONE cell sticky:true (where .dip/app opens land). sessionMode: "keep"|"new"|"last". folder: absolute path the workspace switches the agent to on open.',
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
    doc: 'loops_save(slug, name, description?, manifest?, code?) — create or update a loop. manifest: {type?, roles:[{name,label,description}], skills:[], connections:[], memory:{read,write}}; code: the .js program (export async function start(ctx)). type "rover" = a ROVER loop: declare 2+ role slots and every model call HOPS to the next bound model, never the same twice in a row — memory defaults ON so the hot prompt carries full context across hops. Great for cross-checking, variety, and resilience.',
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
      // Cloud memory: absorbed by the stator's own enricher — the same plane
      // every surface recalls from.
      const out = await statorCall("write", { text: fact, mode: "absorb", speaker: "glyphh" });
      return out.startsWith("ERROR") ? out : "remembered (cloud memory)";
    },
  },
  {
    name: "ada_recall",
    doc: "ada_recall(query, k?) — lexical recall of stored facts (exact prose back, scored)",
    action: (a) => ({ kind: "read", title: `Recall "${String(a.query ?? "").slice(0, 60)}"` }),
    run: async (a) => {
      const out = await statorCall("recall", { query: String(a.query ?? ""), topK: Math.max(1, Math.min(10, Number(a.k) || 5)) });
      if (out.startsWith("ERROR")) return out;
      try {
        const parsed = JSON.parse(out) as { block?: string };
        return cap(parsed.block?.trim() || "(nothing recalled)");
      } catch { return cap(out); }
    },
  },
  {
    name: "ada_browse",
    doc: "ada_browse() — list the user's stored memory: current facts (entity · role · filler) + recent turns, so you can REVIEW it and prune junk. Pair with ada_forget to clean up. Read-only.",
    action: () => ({ kind: "read", title: "Browse memory" }),
    run: async () => {
      const out = await statorCall("browse", {});
      if (out.startsWith("ERROR")) return out;
      try {
        const j = JSON.parse(out) as { facts?: Array<{ entity?: string; role?: string; filler?: string; key?: string; is_current?: boolean }>; turns?: string[] };
        const facts = (j.facts ?? []).filter((f) => f.is_current !== false);
        const factLines = facts.slice(0, 80).map((f) => `• [fact] ${f.entity ?? ""} · ${f.role ?? ""} · ${(f.filler ?? "").slice(0, 140)}${f.key ? `  (key: ${f.key})` : ""}`);
        const turns = j.turns ?? [];
        const turnLines = turns.slice(0, 40).map((t) => `• [turn] ${String(t).slice(0, 180)}`);
        return cap([`FACTS (${facts.length} current):`, ...factLines, "", `TURNS (${turns.length}):`, ...turnLines].join("\n") || "(memory is empty)");
      } catch { return cap(out); }
    },
  },
  {
    name: "ada_forget",
    doc: "ada_forget(entity?, role?, filler?, key?, turnText?) — DELETE stored memory. Pass a FACT filter (any of entity/role/filler/key — at least one; matches ALL facts with those fields) to remove matching facts, and/or turnText to remove a turn by its EXACT text (every duplicate goes). Use after ada_browse to prune junk. Returns how many records were deleted. Irreversible.",
    action: (a) => ({ kind: "edit", title: "Forget memory", detail: JSON.stringify(a).slice(0, 200) }),
    run: async (a) => {
      const fact: Record<string, string> = {};
      for (const f of ["entity", "role", "filler", "key"] as const) { const v = String(a[f] ?? "").trim(); if (v) fact[f] = v; }
      const turnText = String(a.turnText ?? "").trim();
      if (!Object.keys(fact).length && !turnText) return "ERROR: pass a fact filter (entity/role/filler/key) or turnText to delete";
      const body: Record<string, unknown> = {};
      if (Object.keys(fact).length) body.fact = fact;
      if (turnText) body.turnText = turnText;
      const out = await statorCall("forget", body);
      if (out.startsWith("ERROR")) return out;
      try { const j = JSON.parse(out) as { deleted?: number }; return `forgot ${j.deleted ?? 0} memory record(s)`; }
      catch { return out; }
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

/** One metered generation: resolve a model of the modality (explicit or the
 *  org's first), run the job to a terminal state, answer with the asset id and
 *  the credits actually charged. Failure comes back as the provider's reason. */
async function generateMedia(
  modality: "image" | "video" | "speech" | "music" | "audio",
  a: Record<string, unknown>,
): Promise<string> {
  const prompt = String(a.prompt ?? "").trim();
  if (!prompt) return "ERROR: prompt is required";
  let model = a.model ? String(a.model) : "";
  if (!model) {
    const models = await getClient().models.available();
    const first = models.find((m) => String((m as { modality?: string }).modality ?? "") === modality);
    if (!first) return `ERROR: this org has no enabled ${modality} model — list_media_models shows what's available`;
    model = first.id;
  }
  const options: Record<string, unknown> = {};
  if (a.size) options.size = String(a.size);
  if (a.seconds !== undefined) options.seconds = Number(a.seconds);
  if (a.voice) options.voice = String(a.voice);
  if (a.image_url) options.imageUrl = String(a.image_url);
  const started = await getClient().media.generate({
    model, prompt,
    ...(a.title ? { title: String(a.title) } : {}),
    options,
  });
  const job = await getClient().media.waitForJob(started.job.id);
  if (job.status === "failed") return `ERROR: generation failed — ${job.error ?? "unknown"} (nothing was charged)`;
  const open = started.outputKind === "image" ? "open_image" : started.outputKind === "video" ? "open_video" : "open_sounds";
  return `generated ${job.assetId} with ${job.model} — ${job.creditsCharged.toFixed(2)} credits charged. ${open}("${job.assetId}") shows it in the panel.`;
}

/** Docs are MARKDOWN ONLY — structural HTML is how an agent breaks the paper.
 *  One narrow allowance: <br>. Everything else bounces with the reason. */
/** Render a structured doc block spec to markdown (the Docs write vocabulary). */
function renderDocBlock(raw: unknown): string {
  const b = (raw ?? {}) as Record<string, unknown>;
  const type = String(b.type ?? "").toLowerCase();
  const s = (v: unknown): string => String(v ?? "").trim();
  const items = (v: unknown): string[] => (Array.isArray(v) ? v.map(s).filter(Boolean) : []);
  switch (type) {
    case "heading": return `${"#".repeat(Math.min(3, Math.max(1, Number(b.level ?? 2))))} ${s(b.text)}`;
    case "paragraph": return s(b.text);
    case "bullets": return items(b.items).map((x) => `- ${x}`).join("\n") || "ERROR: bullets needs items[]";
    case "numbered": return items(b.items).map((x, i) => `${i + 1}. ${x}`).join("\n") || "ERROR: numbered needs items[]";
    case "quote": return s(b.text).split("\n").map((l) => `> ${l}`).join("\n");
    case "divider": return "---";
    case "code": return `\`\`\`${s(b.language)}\n${s(b.code)}\n\`\`\``;
    case "callout": { const st = ["note", "tip", "warning", "info"].includes(s(b.style)) ? s(b.style) : "note"; return `:::${st}${b.title ? ` ${s(b.title)}` : ""}\n${s(b.text)}\n:::`; }
    case "columns": return `:::columns\n${s(b.left)}\n+++\n${s(b.right)}\n:::`;
    case "table": {
      const headers = items(b.headers);
      const rows = Array.isArray(b.rows) ? b.rows : [];
      if (!headers.length) return "ERROR: table needs headers[]";
      const head = `| ${headers.join(" | ")} |`;
      const sep = `| ${headers.map(() => "---").join(" | ")} |`;
      const body = rows.map((r) => `| ${(Array.isArray(r) ? r : []).map(s).join(" | ")} |`).join("\n");
      return `${head}\n${sep}\n${body}`;
    }
    default: return `ERROR: unknown block type "${type}" — heading|paragraph|bullets|numbered|table|callout|columns|quote|code|divider`;
  }
}

function rejectDocHtml(md: string): string | null {
  const m = /<\s*(script|style|iframe|div|section|link|object|embed|html|body|img|span|table)\b/i.exec(md);
  return m ? `ERROR: documents are markdown ONLY — found <${m[1]}>. Use markdown headings/lists/tables; the app owns the paper.` : null;
}

/** Layouts became WORKSPACES (2026-08-13): recorded skills and old prompts may
 *  still call the layout-named tools — resolve them to the new names. */
const RENAMED_TOOLS: Record<string, string> = {
  list_layouts: "list_workspaces",
  open_layout: "open_workspace",
  save_layout: "save_workspace",
  // The gPoint era (2026-08-16, hours long) — recorded skills may still say it.
  list_gpoints: "list_slides",
  read_gpoint: "read_slides",
  create_gpoint: "create_slides",
  delete_gpoint: "delete_slides",
  open_gpoint: "open_slides",
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
    if (wired) {
      noteToolUsed(call.name);
      return executeConnectorWire(wc, wired, call.arguments ?? {});
    }
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
