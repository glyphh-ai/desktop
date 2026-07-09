/**
 * William's tool surface — what the agent loop can DO.
 *
 * Workspace (working-folder scoped): list_dir, read_file, write_file,
 * search_files, run_command. Paths resolve inside the working folder;
 * anything escaping it escalates to a "dangerous" gate action.
 *
 * Workspace windows & apps: open_app / open_layout (unified resolver —
 * everything lands in the workspace), list_windows / list_layouts, plus
 * the RPA-class surface: app_list_tools / app_call_tool run installed
 * Glyphh apps' declared MCP tools headlessly, and connection_tools /
 * connection_call reach the user's connected accounts (Slack, GitHub, …)
 * through yo-server's Pipedream auth. list_drips / run_drip for
 * celebrations. Deterministic beats pixel-driving throughout.
 *
 * Every execution passes gateWilliamAction() first (mode model: ask /
 * plan / acceptEdits / auto / bypass) — a denial returns "DENIED: …" as
 * the tool result so the model can re-plan instead of crashing the loop.
 */

import { exec } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { WebContents } from "electron";
import { gateWilliamAction, type WilliamActionKind } from "./william-permissions";
import { getExplicitWorkingDirectory } from "./working-directory";
import { openAppByRef, openLayoutByName, listOpenAppWindows } from "./app-resolver";
import { serverGetAuthed } from "./auth";
import { cachedServerGet } from "./server-cache";
import { connectorTools, connectorCall } from "./glyphh-app-services";
import { BUILTIN_EFFECTS, getDripManagerInstance } from "./drip-manager";
import { adaTellRaw, adaExecuteOp, adaRecall, adaHistory, type AdaOp } from "./ada/store";
import { indexConnectorTools } from "./ada/indexer";
import { updateAppFromWorkdir } from "./william-app-builder";
import { APP_GITIGNORE } from "./glyphh-app-spec";
import { enrichFact } from "./ada/enricher";
import { listInstalledAppTools, callAppTool } from "./glyphh-app-host";

const OUTPUT_CAP = 8000;
const READ_CAP = 24000;

interface ToolDef {
  name: string;
  /** One line shown to the model in the system prompt. */
  doc: string;
  run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
  /** Gate classification for a concrete call. */
  action: (args: Record<string, unknown>) => { kind: WilliamActionKind; title: string; detail?: string };
}

const cap = (s: string, n = OUTPUT_CAP) => (s.length > n ? `${s.slice(0, n)}\n…(truncated, ${s.length} chars total)` : s);

function workdir(): string {
  const wd = getExplicitWorkingDirectory();
  if (!wd) throw new Error("no working folder is set — ask the user to pick one in the Code header");
  return wd;
}

/** Resolve inside the working folder; escapes are flagged, not thrown —
 *  the gate decides (dangerous), so bypass mode can still allow them. */
function resolvePath(p: unknown): { abs: string; escapes: boolean } {
  const wd = workdir();
  const abs = resolve(wd, String(p ?? "."));
  return { abs, escapes: abs !== wd && !abs.startsWith(wd + sep) };
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

// Tool-name registry per connector — populated by connection_tools and by
// the first connection_call; lets the executor validate names LOCALLY so a
// guessed tool dies instantly with the real list (no server round-trip).
const connectorNameCache = new Map<string, { names: string[]; at: number }>();
const NAME_CACHE_TTL = 10 * 60_000;

async function connectorToolNames(scope: Set<string>, connector: string): Promise<string[]> {
  const hit = connectorNameCache.get(connector);
  if (hit && Date.now() - hit.at < NAME_CACHE_TTL) return hit.names;
  // Ada FIRST — she's the catalog brain (boot + heartbeat sync keep her
  // current); instant, offline, exact. The live API is the fallback for a
  // connector she hasn't seen, and its fetch feeds her right back.
  try {
    const fromAda = adaExecuteOp({ op: "who", conditions: { "entity.kind": "tool", "relational.object": connector } });
    if (fromAda && fromAda !== "none") {
      const names = fromAda.split(", ").filter(Boolean);
      if (names.length) {
        connectorNameCache.set(connector, { names, at: Date.now() });
        return names;
      }
    }
  } catch { /* store not ready — fall through */ }
  const tools = await connectorTools(scope, { connector });
  const names = tools.map((t) => t.name);
  connectorNameCache.set(connector, { names, at: Date.now() });
  indexConnectorTools(connector, tools); // fresh truth → Ada, opportunistically
  return names;
}

/** The user's connected connector slugs — William acts as the user, so
 *  every connected account is in scope (the server still owns all auth). */
async function connectedSlugs(): Promise<Set<string>> {
  // /api/connections rows: { appSlug, appName, label, healthy, … }
  const r = await serverGetAuthed<{ connections?: Array<{ appSlug?: string }> }>("/api/connections");
  return new Set((r.connections || []).map((c) => String(c.appSlug || "")).filter(Boolean));
}

// create_app (the one-shot LLM builder) is retired — frontier agents build
// apps as real projects in the workspace and ship them with update_app.
const TOOLS: ToolDef[] = [
  {
    name: "list_dir",
    doc: "list_dir(path?) — list a folder in the workspace (name, type, size)",
    action: (a) => {
      const { abs, escapes } = resolvePath(a.path);
      return { kind: escapes ? "dangerous" : "read", title: `List ${abs}` };
    },
    run: async (a) => {
      const { abs } = resolvePath(a.path);
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
    doc: "read_file(path) — read a file in the workspace",
    action: (a) => {
      const { abs, escapes } = resolvePath(a.path);
      return { kind: escapes ? "dangerous" : "read", title: `Read ${abs}` };
    },
    run: async (a) => {
      const { abs } = resolvePath(a.path);
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
      const { abs, escapes } = resolvePath(a.path);
      return { kind: escapes ? "dangerous" : "read", title: `Search "${String(a.pattern ?? "")}" in ${abs}` };
    },
    run: async (a) => {
      const { abs } = resolvePath(a.path);
      const pat = String(a.pattern ?? "").replace(/'/g, "'\\''");
      return runShell(`grep -rniI --exclude-dir=node_modules --exclude-dir=.git -m 5 '${pat}' . | head -80`, abs);
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
      const scope = await connectedSlugs().catch(() => new Set<string>());
      const lookup = (slug: string) => {
        const hit = connectorNameCache.get(slug);
        return hit ? hit.names : null;
      };
      void scope; // scope warms via connection_tools; cache-based lookup here
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
    doc: "open_app(name) — open an app from the user's library (or 'browser'/'terminal') into the workspace",
    action: (a) => ({ kind: "command", title: `Open app "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const r = await openAppByRef(String(a.name ?? ""));
      return `opened ${r.name} (${r.slug})`;
    },
  },
  {
    name: "list_windows",
    doc: "list_windows() — the app windows currently open in the workspace",
    action: () => ({ kind: "read", title: "List open windows" }),
    run: async () => cap(JSON.stringify(await listOpenAppWindows(), null, 1)),
  },
  {
    name: "list_layouts",
    doc: "list_layouts() — the user's saved layouts (open one with open_layout)",
    action: () => ({ kind: "read", title: "List layouts" }),
    run: async () => {
      const layouts = await cachedServerGet<Array<{ name: string; cols?: number; rows?: number }>>("/api/layouts");
      return cap(layouts.map((l) => `${l.name}${l.cols && l.rows ? ` (${l.cols}×${l.rows})` : ""}`).join("\n") || "(none saved)");
    },
  },
  {
    name: "open_layout",
    doc: "open_layout(name) — open a saved layout: tiles its apps into the workspace",
    action: (a) => ({ kind: "command", title: `Open layout "${String(a.name ?? "")}"` }),
    run: async (a) => {
      const r = await openLayoutByName(String(a.name ?? ""));
      return `opened layout ${r.layout} — apps: ${r.apps.join(", ")}`;
    },
  },
  {
    name: "list_connections",
    doc: "list_connections() — the user's connected accounts (Slack, GitHub, …)",
    action: () => ({ kind: "read", title: "List connections" }),
    run: async () => {
      const r = await serverGetAuthed<{ connections?: Array<{ appSlug?: string; appName?: string; label?: string | null; healthy?: boolean }> }>("/api/connections");
      const rows = (r.connections || []).map((c) =>
        `${c.appSlug || "?"} (${c.appName || "?"})${c.label ? ` — ${c.label}` : ""}${c.healthy === false ? " — UNHEALTHY" : ""}`);
      return cap(rows.join("\n") || "(no connected accounts)");
    },
  },
  {
    name: "connection_tools",
    doc: "connection_tools(connector) — the EXACT tool names a connected account exposes (always call before connection_call)",
    action: (a) => ({ kind: "read", title: `List ${String(a.connector ?? "?")} tools` }),
    run: async (a) => {
      const connector = String(a.connector ?? "");
      const tools = await connectorTools(await connectedSlugs(), { connector });
      connectorNameCache.set(connector, { names: tools.map((t) => t.name), at: Date.now() });
      indexConnectorTools(connector, tools);
      return cap(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description })), null, 1));
    },
  },
  {
    name: "connection_call",
    doc: "connection_call(connector, tool, arguments?) — call a connected account's API tool. Tool names MUST come from connection_tools — never guess them",
    action: (a) => ({
      kind: READ_TOOL_RE.test(String(a.tool ?? "")) ? "read" : "network",
      title: `Call ${String(a.connector ?? "?")} → ${String(a.tool ?? "?")}`,
      detail: JSON.stringify(a.arguments ?? {}, null, 1).slice(0, 500),
    }),
    run: async (a) => {
      const connector = String(a.connector ?? "");
      const scope = await connectedSlugs();
      const tool = String(a.tool ?? "");
      // Validate the name locally first — a guessed tool never even leaves
      // the machine; the rejection carries the real names (oracle pattern).
      try {
        const names = await connectorToolNames(scope, connector);
        if (names.length && !names.includes(tool)) {
          const ci = names.find((n) => n.toLowerCase() === tool.toLowerCase());
          if (!ci) {
            return `ERROR: "${tool}" is not a ${connector} tool. Available ${connector} tools: ${names.slice(0, 20).join(", ")}`;
          }
        }
      } catch { /* listing unavailable — let the server answer */ }
      try {
        const r = await connectorCall(scope, {
          connector,
          tool,
          args: (a.arguments as Record<string, unknown>) ?? {},
        });
        return cap(r.result);
      } catch (err) {
        // Unknown-tool errors answer like the William oracle: reject WITH
        // the real names, so recovery is one turn instead of a guess loop.
        let msg = err instanceof Error ? err.message : String(err);
        if (/-32602|not found|unknown tool|invalid/i.test(msg)) {
          try {
            const names = await connectorToolNames(scope, connector);
            if (names.length) msg += `\nAvailable ${connector} tools: ${names.slice(0, 20).join(", ")}`;
          } catch { /* listing failed too — plain error stands */ }
        }
        throw new Error(msg);
      }
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
      const r = adaTellRaw(fact, facts, { key: a.key ? String(a.key) : undefined, speaker: "william" });
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
export function williamToolDefs(): Array<{ name: string; doc: string }> {
  return TOOLS.map((t) => ({ name: t.name, doc: t.doc }));
}

export interface ToolOutcome { result: string; denied: boolean; title: string }

/** Gate → execute. Denials and failures come back as results the model can
 *  react to — the loop never throws on a tool. */
export async function executeWilliamTool(
  wc: WebContents,
  call: { name: string; arguments?: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  const tool = TOOLS.find((t) => t.name === call.name);
  if (!tool) {
    return { result: `ERROR: unknown tool "${call.name}" — available: ${TOOLS.map((t) => t.name).join(", ")}`, denied: false, title: call.name };
  }
  const args = call.arguments ?? {};
  let action;
  try {
    action = tool.action(args);
  } catch (err) {
    return { result: `ERROR: ${err instanceof Error ? err.message : String(err)}`, denied: false, title: call.name };
  }
  const gate = await gateWilliamAction(wc, action);
  if (!gate.allowed) {
    return { result: `DENIED: ${gate.reason || "not allowed"}`, denied: true, title: action.title };
  }
  try {
    return { result: await tool.run(args, signal), denied: false, title: action.title };
  } catch (err) {
    return { result: `ERROR: ${err instanceof Error ? err.message : String(err)}`, denied: false, title: action.title };
  }
}
