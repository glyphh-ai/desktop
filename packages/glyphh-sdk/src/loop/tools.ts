/**
 * loop/tools.ts — the Glyphh loop's BUILT-IN tools: files and the shell on this
 * machine, resolved against the turn's working folder. Every result is text,
 * capped, so a runaway `cat` never floods the model. The permission gate
 * (core.ts) decides whether a tool runs at all; this file only runs it.
 */

import { spawn } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { lineDiff, type FileDiff } from "./diff.js";
import { insideFolder, sandboxApplyFailed, shellLaunch } from "./sandbox.js";

export interface ToolDef { name: string; description: string; input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] } }

/**
 * WHAT A STEP DID, for the person watching (his order, 2026-09-29: "way more
 * robust viewing of the tool calls with the commands that are ran by the
 * agent… file changes… + adds green, - removes red"). The model gets `text`;
 * the host gets this — a real diff for a write or an edit, the command with its
 * own output and exit code for the shell — so it can draw the step instead of
 * paraphrasing it. Bounded like everything else here.
 */
export type ToolDetail =
  | ({ kind: "diff"; path: string; created: boolean } & FileDiff)
  | { kind: "command"; command: string; exitCode: number | null; stdout: string; stderr: string; truncated: boolean; ms: number }
  | { kind: "read"; path: string; lines: number; from?: number }
  | { kind: "list"; path: string; count: number }
  | { kind: "search"; pattern: string; path: string; matches: number };

export interface BuiltinResult { text: string; failed: boolean; detail?: ToolDetail }

const DETAIL_OUT_CAP = 20_000;

const TEXT_CAP = 200_000;
const OUT_CAP = 100_000;
const WALK_CAP = 2000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "target", ".venv", "__pycache__"]);

export const BUILTIN_TOOLS: ToolDef[] = [
  { name: "read_file", description: "Read a text file. Optional 1-based line offset and limit for long files.", input_schema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Create or overwrite a text file with the given content, creating folders as needed.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace old_string with new_string in a file. old_string must occur exactly once unless replace_all is true.", input_schema: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] } },
  { name: "list_dir", description: "List a folder's entries (name, kind).", input_schema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "glob", description: "Find files by glob pattern (** and * supported) under a folder.", input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } },
  { name: "grep", description: "Search file contents with a regular expression under a folder; returns file:line: text matches.", input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } }, required: ["pattern"] } },
  { name: "bash", description: "Run a shell command in the working folder and return its output and exit code. Default timeout 120 seconds. For anything that keeps running (a dev server, a watcher) pass background: true: it starts, its first seconds of output come back with its pid, and it keeps running after the turn (stop it with `kill -- -<pid>`).", input_schema: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "integer" }, background: { type: "boolean" } }, required: ["command"] } },
];

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
const num = (o: Record<string, unknown>, k: string): number | undefined => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : undefined);

/** BACKGROUND COMMANDS (his report, 2026-09-29: the agent ran `npm run dev`, which
 *  never exits, so the turn sat for the 120s timeout and the server was killed).
 *  They outlive the turn, never the process that started them. */
const BACKGROUND_SETTLE_MS = 5_000;
const background = new Set<ReturnType<typeof spawn>>();
let backgroundReaper = false;
function trackBackground(proc: ReturnType<typeof spawn>): void {
  background.add(proc);
  proc.on("close", () => background.delete(proc));
  if (backgroundReaper) return;
  backgroundReaper = true;
  // Each runs in its own process group, so the whole tree (npm → vite) goes.
  process.once("exit", () => { for (const p of background) { try { if (p.pid) process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } } });
}
const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);

/** A glob to a RegExp: ** crosses folders, * stays inside one, ? is one char. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? "";
    if (c === "*") {
      if (pattern[i + 1] === "*") { re += ".*"; i++; if (pattern[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

async function walk(root: string, out: string[], depth = 0): Promise<void> {
  if (out.length >= WALK_CAP || depth > 12) return;
  let entries: Dirent[] = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= WALK_CAP) return;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await walk(path.join(root, e.name), out, depth + 1); }
    else if (e.isFile()) out.push(path.join(root, e.name));
  }
}

const NUL = String.fromCharCode(0);

/** How the shell is launched. The default is the sandboxed one; only a HOST in
 *  code (a test harness) can swap it — there is no setting or variable a
 *  person or a model could flip to escape the folder. */
export type ShellLauncher = typeof shellLaunch;

export async function runBuiltin(name: string, input: unknown, workdir: string, signal?: AbortSignal, launcher: ShellLauncher = shellLaunch): Promise<BuiltinResult> {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  // EVERY PATH STAYS IN THE SESSION'S FOLDER (sandbox.ts): resolved through
  // `..`, absolute paths and symlinks, and refused if it lands outside.
  const at = (p: string): Promise<string> => insideFolder(workdir, p);
  try {
    switch (name) {
      case "read_file": {
        const file = await at(str(o, "path"));
        const raw = await fs.readFile(file, "utf-8");
        const offset = num(o, "offset"); const limit = num(o, "limit");
        if (offset || limit) {
          const lines = raw.split("\n");
          const start = Math.max(0, (offset ?? 1) - 1);
          const slice = lines.slice(start, limit ? start + limit : undefined);
          return {
            text: cap(slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n"), TEXT_CAP), failed: false,
            detail: { kind: "read", path: file, lines: slice.length, from: start + 1 },
          };
        }
        return { text: cap(raw, TEXT_CAP), failed: false, detail: { kind: "read", path: file, lines: raw ? raw.split("\n").length : 0 } };
      }
      case "write_file": {
        const file = await at(str(o, "path"));
        const content = str(o, "content");
        // The file as it was, so the step shows a real diff — every line added
        // for a new file, only what changed for an overwrite.
        const before = await fs.readFile(file, "utf-8").catch(() => null);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content, "utf-8");
        return {
          text: `wrote ${file} (${content.length} chars)`, failed: false,
          detail: { kind: "diff", path: file, created: before === null, ...lineDiff(before ?? "", content) },
        };
      }
      case "edit_file": {
        const file = await at(str(o, "path"));
        const raw = await fs.readFile(file, "utf-8");
        const oldS = str(o, "old_string"); const newS = str(o, "new_string");
        const n = oldS ? raw.split(oldS).length - 1 : 0;
        if (!oldS || n === 0) return { text: `old_string not found in ${file}`, failed: true };
        if (n > 1 && o.replace_all !== true) return { text: `old_string occurs ${n} times in ${file}; pass replace_all or make it unique`, failed: true };
        const next = o.replace_all === true ? raw.split(oldS).join(newS) : raw.replace(oldS, () => newS);
        await fs.writeFile(file, next, "utf-8");
        return {
          text: `edited ${file} (${o.replace_all === true ? n : 1} replacement${(o.replace_all === true ? n : 1) === 1 ? "" : "s"})`, failed: false,
          detail: { kind: "diff", path: file, created: false, ...lineDiff(raw, next) },
        };
      }
      case "list_dir": {
        const dir = await at(str(o, "path"));
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return {
          text: entries.slice(0, 500).map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`).join("\n") || "(empty)", failed: false,
          detail: { kind: "list", path: dir, count: entries.length },
        };
      }
      case "glob": {
        const root = await at(str(o, "path"));
        const files: string[] = [];
        await walk(root, files);
        const re = globToRegExp(str(o, "pattern"));
        const hits = files.map((f) => path.relative(root, f)).filter((rel) => re.test(rel) || re.test(path.basename(rel)));
        return {
          text: hits.slice(0, 500).join("\n") || "(no matches)", failed: false,
          detail: { kind: "search", pattern: str(o, "pattern"), path: root, matches: hits.length },
        };
      }
      case "grep": {
        const root = await at(str(o, "path"));
        const re = new RegExp(str(o, "pattern"));
        const only = str(o, "glob") ? globToRegExp(str(o, "glob")) : null;
        const files: string[] = [];
        await walk(root, files);
        const out: string[] = [];
        for (const f of files) {
          if (out.length >= 200) break;
          const rel = path.relative(root, f);
          if (only && !(only.test(rel) || only.test(path.basename(rel)))) continue;
          let size = 0;
          try { size = (await fs.stat(f)).size; } catch { continue; }
          if (size > 1_000_000) continue;
          let raw: string;
          try { raw = await fs.readFile(f, "utf-8"); } catch { continue; }
          if (raw.includes(NUL)) continue;
          const lines = raw.split("\n");
          for (let i = 0; i < lines.length && out.length < 200; i++) { const line = lines[i] ?? ""; if (re.test(line)) out.push(`${rel}:${i + 1}: ${line.slice(0, 300)}`); }
        }
        return {
          text: out.join("\n") || "(no matches)", failed: false,
          detail: { kind: "search", pattern: str(o, "pattern"), path: root, matches: out.length },
        };
      }
      case "bash": {
        const cmd = str(o, "command");
        if (!cmd) return { text: "command is required", failed: true };
        const timeout = Math.min(Math.max(num(o, "timeout_ms") ?? 120_000, 1000), 600_000);
        const t0 = Date.now();
        // THE SHELL IS SANDBOXED TO THE FOLDER (sandbox.ts): on macOS it may
        // write only inside it (plus temp and package caches); it starts there
        // everywhere.
        const launch = launcher(process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash"), cmd, workdir);
        if (o.background === true) {
          return await new Promise((resolve) => {
            const proc = spawn(launch.file, launch.args, { cwd: workdir, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
            trackBackground(proc);
            let out = ""; let err = "";
            proc.stdout?.on("data", (b: Buffer) => { if (out.length < OUT_CAP) out += b.toString("utf-8"); });
            proc.stderr?.on("data", (b: Buffer) => { if (err.length < OUT_CAP) err += b.toString("utf-8"); });
            let settled = false;
            const settle = (code: number | null): void => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              const running = code === null && proc.exitCode === null;
              const blocked = launch.sandboxed && sandboxApplyFailed(err);
              const head = blocked ? "The shell sandbox could not be applied, so the command was not run."
                : running ? `Started in the background (pid ${proc.pid}); still running. Stop it with \`kill -- -${proc.pid}\`.`
                : `exited before it settled (exit ${code ?? "?"})`;
              resolve({
                text: [head, out && cap(out, OUT_CAP), err && `stderr:\n${cap(err, OUT_CAP)}`].filter(Boolean).join("\n"),
                failed: blocked || (!running && code !== 0),
                detail: { kind: "command", command: cmd, exitCode: running ? null : code, ms: Date.now() - t0, stdout: out.slice(0, DETAIL_OUT_CAP), stderr: err.slice(0, DETAIL_OUT_CAP), truncated: false },
              });
            };
            const timer = setTimeout(() => settle(null), BACKGROUND_SETTLE_MS);
            proc.on("close", (code) => settle(code ?? -1));
            proc.on("error", (e) => { err += e.message; settle(-1); });
          });
        }
        return await new Promise((resolve) => {
          const proc = spawn(launch.file, launch.args, { cwd: workdir, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
          let out = ""; let err = "";
          proc.stdout.on("data", (b: Buffer) => { if (out.length < OUT_CAP) out += b.toString("utf-8"); });
          proc.stderr.on("data", (b: Buffer) => { if (err.length < OUT_CAP) err += b.toString("utf-8"); });
          const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, timeout);
          const onAbort = () => { try { proc.kill("SIGTERM"); } catch { /* gone */ } };
          signal?.addEventListener("abort", onAbort, { once: true });
          proc.on("close", (code) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            // FAIL CLOSED: a sandbox that could not be applied means the
            // command did not run — and it must not run unconfined instead.
            if (launch.sandboxed && sandboxApplyFailed(err)) {
              resolve({
                text: "The shell sandbox could not be applied, so the command was not run. Nothing outside the session's folder was touched.", failed: true,
                detail: { kind: "command", command: cmd, exitCode: code, ms: Date.now() - t0, stdout: "", stderr: err.slice(0, DETAIL_OUT_CAP), truncated: false },
              });
              return;
            }
            const text = [out && cap(out, OUT_CAP), err && `stderr:\n${cap(err, OUT_CAP)}`, `exit ${code ?? "?"}`].filter(Boolean).join("\n");
            resolve({
              text, failed: code !== 0,
              detail: {
                kind: "command", command: cmd, exitCode: code, ms: Date.now() - t0,
                stdout: out.slice(0, DETAIL_OUT_CAP), stderr: err.slice(0, DETAIL_OUT_CAP),
                truncated: out.length > DETAIL_OUT_CAP || err.length > DETAIL_OUT_CAP || out.length >= OUT_CAP || err.length >= OUT_CAP,
              },
            });
          });
          proc.on("error", (e) => {
            clearTimeout(timer);
            resolve({ text: e.message, failed: true, detail: { kind: "command", command: cmd, exitCode: null, ms: Date.now() - t0, stdout: "", stderr: e.message, truncated: false } });
          });
        });
      }
      default:
        return { text: `unknown tool ${name}`, failed: true };
    }
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), failed: true };
  }
}
