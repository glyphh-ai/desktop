/**
 * glyphh-loop-tools.ts — the Glyphh loop's BUILT-IN tools: files and the shell
 * on this machine, resolved against the turn's working folder. Every result is
 * text, capped, so a runaway `cat` never floods the model. The permission gate
 * (glyphh-loop-core.ts) decides whether a tool runs at all; this file only runs it.
 */

import { spawn } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";

export interface ToolDef { name: string; description: string; input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] } }

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
  { name: "bash", description: "Run a shell command in the working folder and return its output and exit code. Default timeout 120 seconds.", input_schema: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "integer" } }, required: ["command"] } },
];

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
const num = (o: Record<string, unknown>, k: string): number | undefined => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : undefined);
const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);

/** A glob to a RegExp: ** crosses folders, * stays inside one, ? is one char. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
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

export async function runBuiltin(name: string, input: unknown, workdir: string, signal?: AbortSignal): Promise<{ text: string; failed: boolean }> {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const at = (p: string): string => path.resolve(workdir, p || ".");
  try {
    switch (name) {
      case "read_file": {
        const raw = await fs.readFile(at(str(o, "path")), "utf-8");
        const offset = num(o, "offset"); const limit = num(o, "limit");
        if (offset || limit) {
          const lines = raw.split("\n");
          const start = Math.max(0, (offset ?? 1) - 1);
          return { text: cap(lines.slice(start, limit ? start + limit : undefined).map((l, i) => `${start + i + 1}\t${l}`).join("\n"), TEXT_CAP), failed: false };
        }
        return { text: cap(raw, TEXT_CAP), failed: false };
      }
      case "write_file": {
        const file = at(str(o, "path"));
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, str(o, "content"), "utf-8");
        return { text: `wrote ${file} (${str(o, "content").length} chars)`, failed: false };
      }
      case "edit_file": {
        const file = at(str(o, "path"));
        const raw = await fs.readFile(file, "utf-8");
        const oldS = str(o, "old_string"); const newS = str(o, "new_string");
        const n = oldS ? raw.split(oldS).length - 1 : 0;
        if (!oldS || n === 0) return { text: `old_string not found in ${file}`, failed: true };
        if (n > 1 && o.replace_all !== true) return { text: `old_string occurs ${n} times in ${file}; pass replace_all or make it unique`, failed: true };
        await fs.writeFile(file, o.replace_all === true ? raw.split(oldS).join(newS) : raw.replace(oldS, () => newS), "utf-8");
        return { text: `edited ${file} (${o.replace_all === true ? n : 1} replacement${(o.replace_all === true ? n : 1) === 1 ? "" : "s"})`, failed: false };
      }
      case "list_dir": {
        const dir = at(str(o, "path"));
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return { text: entries.slice(0, 500).map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`).join("\n") || "(empty)", failed: false };
      }
      case "glob": {
        const root = at(str(o, "path"));
        const files: string[] = [];
        await walk(root, files);
        const re = globToRegExp(str(o, "pattern"));
        const hits = files.map((f) => path.relative(root, f)).filter((rel) => re.test(rel) || re.test(path.basename(rel)));
        return { text: hits.slice(0, 500).join("\n") || "(no matches)", failed: false };
      }
      case "grep": {
        const root = at(str(o, "path"));
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
          for (let i = 0; i < lines.length && out.length < 200; i++) if (re.test(lines[i])) out.push(`${rel}:${i + 1}: ${lines[i].slice(0, 300)}`);
        }
        return { text: out.join("\n") || "(no matches)", failed: false };
      }
      case "bash": {
        const cmd = str(o, "command");
        if (!cmd) return { text: "command is required", failed: true };
        const timeout = Math.min(Math.max(num(o, "timeout_ms") ?? 120_000, 1000), 600_000);
        return await new Promise((resolve) => {
          const proc = spawn(process.env.SHELL || "/bin/zsh", ["-lc", cmd], { cwd: workdir, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
          let out = ""; let err = "";
          proc.stdout.on("data", (b: Buffer) => { if (out.length < OUT_CAP) out += b.toString("utf-8"); });
          proc.stderr.on("data", (b: Buffer) => { if (err.length < OUT_CAP) err += b.toString("utf-8"); });
          const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, timeout);
          const onAbort = () => { try { proc.kill("SIGTERM"); } catch { /* gone */ } };
          signal?.addEventListener("abort", onAbort, { once: true });
          proc.on("close", (code) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            const text = [out && cap(out, OUT_CAP), err && `stderr:\n${cap(err, OUT_CAP)}`, `exit ${code ?? "?"}`].filter(Boolean).join("\n");
            resolve({ text, failed: code !== 0 });
          });
          proc.on("error", (e) => { clearTimeout(timer); resolve({ text: e.message, failed: true }); });
        });
      }
      default:
        return { text: `unknown tool ${name}`, failed: true };
    }
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), failed: true };
  }
}
