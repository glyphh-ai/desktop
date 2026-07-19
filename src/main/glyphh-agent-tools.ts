/**
 * Glyphh's tool surface — what the agent loop can DO.
 *
 * Workspace (working-folder scoped): list_dir, read_file, write_file,
 * search_files, run_command. Paths resolve inside the working folder;
 * anything escaping it escalates to a "dangerous" gate action.
 *
 * Workspace windows & apps: open_app / open_layout (unified resolver —
 * everything lands in the workspace), list_windows / list_layouts, plus
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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { WebContents } from "electron";
import { gateGlyphhAction, askUserQuestions, type GlyphhActionKind } from "./glyphh-agent-permissions";
import { getExplicitWorkingDirectory } from "./working-directory";
import { openAppByRef, openLayoutByName, listOpenAppWindows } from "./app-resolver";
import { getClient } from "./glyphh-client";
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

function workdir(): string {
  const wd = getExplicitWorkingDirectory();
  if (!wd) throw new Error("no working folder is set — ask the user to pick one in the Code header");
  return wd;
}

// Paths the user attached to the CURRENT run (composer chips) — attaching
// is consent, so reads of these gate as plain reads even when they live
// outside the working folder. Replaced wholesale at every run start.
let runAttachments: string[] = [];
export function setRunAttachments(paths: string[]): void {
  runAttachments = paths.filter(Boolean);
}
const isAttachedPath = (abs: string) =>
  runAttachments.some((p) => abs === p || abs.startsWith(p + sep));

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

const DANGEROUS_CMD = /\brm\s+(-\w*[rf]\w*\s+)+|\bsudo\b|\bshutdown\b|\breboot\b|\bmkfs\b|\bdiskutil\s+erase|git\s+push\s+.*--force|>\s*\/dev\/|\bdd\s+if=/i;

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
    defs.push({
      name: wire,
      description: `[${t.slug}] ${String(t.description || t.name).slice(0, 280)}`,
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
  {
    name: "list_dir",
    doc: "list_dir(path?) — list a folder in the workspace (name, type, size)",
    action: (a) => {
      const { abs, escapes } = resolveReadPath(a.path);
      return { kind: escapes ? "dangerous" : "read", title: `List ${abs}` };
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
      return { kind: escapes ? "dangerous" : "read", title: `Read ${abs}` };
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
      return { kind: escapes ? "dangerous" : "read", title: `Search "${String(a.pattern ?? "")}" in ${abs}` };
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
    doc: "find_tools(query, k?) — search ALL connected-account tools by meaning. Only the tools relevant to the original ask are preloaded, so when you need one that isn't wired (a different app, an unexpected follow-up), find it here, then run it with call_tool. Read-only.",
    action: (a) => ({ kind: "read", title: `Find tools "${String(a.query ?? "").slice(0, 60)}"` }),
    run: async (a) => {
      const query = String(a.query ?? "").trim();
      if (!query) return "ERROR: query is required";
      const k = Math.max(1, Math.min(20, Number(a.k) || 10));
      const hits = (await rankConnectorTools(query, lastWireDefs)).filter((r) => r.score > 0).slice(0, k);
      if (!hits.length) return "(no connected-account tools match — the account may not be connected)";
      return cap(hits.map((r) => `${r.def.name} — ${r.def.description}`).join("\n"));
    },
  },
  {
    name: "call_tool",
    doc: "call_tool(name, arguments?) — run a connected-account tool by its exact find_tools name, including tools not preloaded for this turn. arguments must match the tool's schema.",
    // Gate on the INNER tool, exactly like a directly-wired connector call —
    // reads pass quietly, sends/creates/deletes prompt per the mode model.
    action: (a) => {
      const inner = String(a.name ?? "");
      const wired = wireMap.get(inner);
      return {
        kind: (wired && READ_TOOL_RE.test(wired.tool) ? "read" : "network") as GlyphhActionKind,
        title: wired ? `Call ${wired.slug} → ${wired.tool}` : `Call ${inner}`,
        detail: JSON.stringify(a.arguments ?? {}, null, 1).slice(0, 500),
      };
    },
    run: async (a) => {
      const inner = String(a.name ?? "");
      const wired = wireMap.get(inner);
      if (!wired) return `ERROR: unknown tool "${inner}" — use find_tools to get the exact name`;
      return cap(await callConnectorTool(wired.slug, wired.tool, (a.arguments ?? {}) as Record<string, unknown>));
    },
  },
  {
    name: "run_command",
    doc: "run_command(command) — run a shell command in the working folder (60s cap)",
    // (title carries the command so the thread's run card shows WHAT ran)
    action: (a) => {
      const cmd = String(a.command ?? "");
      return { kind: DANGEROUS_CMD.test(cmd) ? "dangerous" : "command", title: `Run: ${cmd.slice(0, 80)}`, detail: cmd };
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
    doc: "open_app(name) — open an app from the user's library (or 'browser'/'terminal') as a panel beside this conversation",
    action: (a) => ({ kind: "command", title: `Open app "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const r = await openAppByRef(String(a.name ?? ""));
      return `opened ${r.name} (${r.slug})`;
    },
  },
  {
    name: "list_windows",
    doc: "list_windows() — the app panels currently open beside this conversation",
    action: () => ({ kind: "read", title: "List open windows" }),
    run: async () => cap(JSON.stringify(await listOpenAppWindows(), null, 1)),
  },
  {
    name: "list_layouts",
    doc: "list_layouts() — the user's saved layouts (open one with open_layout)",
    action: () => ({ kind: "read", title: "List layouts" }),
    run: async () => {
      const layouts = await fetchServerLayouts();
      return cap(layouts.map((l) => `${l.name}${l.cols && l.rows ? ` (${l.cols}×${l.rows})` : ""}`).join("\n") || "(none saved)");
    },
  },
  {
    name: "open_layout",
    doc: "open_layout(name) — open a saved layout: its apps tile as panels beside this conversation",
    action: (a) => ({ kind: "command", title: `Open layout "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const r = await openLayoutByName(String(a.name ?? ""));
      return `opened layout ${r.layout} — apps: ${r.apps.join(", ")}`;
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
    name: "list_connections",
    doc: "list_connections() — the user's connected accounts (Slack, GitHub, …)",
    action: () => ({ kind: "read", title: "List connections" }),
    run: async () => {
      const connections = await getClient().connections.list();
      const rows = connections.map((c) =>
        `${c.slug || "?"} (${c.name || "?"})${c.enabled ? "" : " — DISABLED"}`);
      return cap(rows.join("\n") || "(no connected accounts)");
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
      try { return adaExecuteOp((a.op ?? a) as AdaOp); }
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
export function glyphhToolDefs(): Array<{ name: string; doc: string }> {
  return TOOLS.map((t) => ({ name: t.name, doc: t.doc }));
}

export interface ToolOutcome { result: string; denied: boolean; title: string }

/** Gate → execute. Denials and failures come back as results the model can
 *  react to — the loop never throws on a tool. */
export async function executeGlyphhTool(
  wc: WebContents,
  call: { name: string; arguments?: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  const tool = TOOLS.find((t) => t.name === call.name);
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
