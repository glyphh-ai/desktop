/**
 * William's tool surface — what the agent loop can DO.
 *
 * Workspace (working-folder scoped): list_dir, read_file, write_file,
 * search_files, run_command. Paths resolve inside the working folder;
 * anything escaping it escalates to a "dangerous" gate action.
 *
 * Workspace windows & apps: open_app (any library app/builtin — lands in
 * the workspace like every other open path), list_windows, plus the
 * RPA-class surface: app_list_tools / app_call_tool run installed Glyphh
 * apps' declared MCP tools headlessly (deterministic — preferred over
 * pixel-driving).
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
import { getWorkingDirectory } from "./working-directory";
import { openAppByRef, listOpenAppWindows } from "./app-resolver";
import { listInstalledAppTools, callAppTool } from "./glyphh-app-host";

const OUTPUT_CAP = 8000;
const READ_CAP = 24000;

interface ToolDef {
  name: string;
  /** One line shown to the model in the system prompt. */
  doc: string;
  run: (args: Record<string, unknown>) => Promise<string>;
  /** Gate classification for a concrete call. */
  action: (args: Record<string, unknown>) => { kind: WilliamActionKind; title: string; detail?: string };
}

const cap = (s: string, n = OUTPUT_CAP) => (s.length > n ? `${s.slice(0, n)}\n…(truncated, ${s.length} chars total)` : s);

function workdir(): string {
  const wd = getWorkingDirectory();
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

const DANGEROUS_CMD = /\brm\s+(-\w*[rf]\w*\s+)+|\bsudo\b|\bshutdown\b|\breboot\b|\bmkfs\b|\bdiskutil\s+erase|git\s+push\s+.*--force|>\s*\/dev\/|\bdd\s+if=/i;

function runShell(command: string, cwd: string): Promise<string> {
  return new Promise((res) => {
    exec(command, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, shell: "/bin/zsh" }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join("\n---stderr---\n").trim();
      if (err && !out) res(`exit ${err.code ?? "?"}: ${err.message}`);
      else if (err) res(cap(`${out}\n(exit ${err.code ?? "signal"})`));
      else res(cap(out || "(no output)"));
    });
  });
}

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
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return `wrote ${content.length} chars to ${abs}`;
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
    action: (a) => {
      const cmd = String(a.command ?? "");
      return { kind: DANGEROUS_CMD.test(cmd) ? "dangerous" : "command", title: "Run command", detail: cmd };
    },
    run: async (a) => runShell(String(a.command ?? ""), workdir()),
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
    name: "app_list_tools",
    doc: "app_list_tools() — the MCP tools the user's installed Glyphh apps expose (call with app_call_tool)",
    action: () => ({ kind: "read", title: "List installed app tools" }),
    run: async () => cap(JSON.stringify(listInstalledAppTools(), null, 1)),
  },
  {
    name: "app_call_tool",
    doc: "app_call_tool(app, tool, arguments?) — run an installed Glyphh app's tool headlessly (send a message, create an event, …)",
    action: (a) => ({
      kind: "command",
      title: `Run ${String(a.app ?? "?")} → ${String(a.tool ?? "?")}`,
      detail: JSON.stringify(a.arguments ?? {}, null, 1).slice(0, 500),
    }),
    run: async (a) => {
      const out = await callAppTool(String(a.app ?? ""), String(a.tool ?? ""), (a.arguments as Record<string, unknown>) ?? {});
      return cap(typeof out === "string" ? out : JSON.stringify(out, null, 1));
    },
  },
];

/** Compact tool list for the agent system prompt. */
export function williamToolsPrompt(): string {
  return TOOLS.map((t) => `- ${t.doc}`).join("\n");
}

/** The constrained turn shape — llama.cpp grammar-enforces this, so every
 *  agent turn parses (the fine-tune's tag discipline can't drift out of it). */
export const TURN_SCHEMA = {
  type: "object",
  properties: {
    thought: { type: "string", description: "One short sentence: what you are doing and why" },
    action: {
      type: "object",
      properties: { name: { type: "string" }, arguments: { type: "object" } },
      required: ["name", "arguments"],
    },
    final: { type: "string", description: "The final answer to the user, when no more tools are needed" },
  },
  required: ["thought"],
} as const;

export interface ToolOutcome { result: string; denied: boolean; title: string }

/** Gate → execute. Denials and failures come back as results the model can
 *  react to — the loop never throws on a tool. */
export async function executeWilliamTool(
  wc: WebContents,
  call: { name: string; arguments?: Record<string, unknown> },
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
    return { result: await tool.run(args), denied: false, title: action.title };
  } catch (err) {
    return { result: `ERROR: ${err instanceof Error ? err.message : String(err)}`, denied: false, title: action.title };
  }
}
