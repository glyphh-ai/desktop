/**
 * skills-fs — SKILLS ARE FOLDERS (his ruling, 2026-09-16): the Agent Skills
 * standard, one directory per skill with SKILL.md at its root and whatever
 * files it needs beside it. Nothing is converted or copied into a private
 * format. This module reads the folders the CLIs already load —
 *
 *   claude   ~/.claude/skills/<name>/
 *   codex    ~/.codex/skills/<name>/
 *   gemini   ~/.gemini/skills/<name>/
 *   glyphh   ~/.glyphh/<user>/skills/<name>/     (what Glyphh installs)
 *
 * — and serves them to the Skills page: list, detail (frontmatter + body +
 * file tree), file read/write, enable/disable (a disabled skill is MOVED out
 * of the CLI's directory so the CLI stops loading it — a flag would lie),
 * reveal, delete, and install from the hub as a folder.
 */

import fs from "fs";
import path from "path";
import { homedir } from "os";
import { ipcMain, shell } from "electron";
import { userScopedPath } from "./app-paths.js";

export type SkillSource = "glyphh" | "claude" | "codex" | "gemini";

export interface SkillSummary {
  id: string;
  source: SkillSource;
  name: string;
  description: string;
  author: string;
  enabled: boolean;
  dir: string;
  fileCount: number;
  updatedAt: string;
}
export interface SkillFile { path: string; size: number }
export interface SkillDetail extends SkillSummary {
  frontmatter: Record<string, string>;
  body: string;
  files: SkillFile[];
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".DS_Store"]);

const ROOTS: Record<SkillSource, () => string> = {
  glyphh: () => userScopedPath("skills"),
  claude: () => path.join(homedir(), ".claude", "skills"),
  codex: () => path.join(homedir(), ".codex", "skills"),
  gemini: () => path.join(homedir(), ".gemini", "skills"),
};
const DISABLED_ROOT = (): string => userScopedPath("skills-disabled");

const idOf = (source: SkillSource, name: string): string => `${source}:${name}`;
function parseId(id: string): { source: SkillSource; name: string } {
  const cut = id.indexOf(":");
  const source = id.slice(0, cut) as SkillSource;
  const name = id.slice(cut + 1);
  if (!(source in ROOTS) || !name || name.includes("/") || name.includes("..")) throw new Error(`bad skill id: ${id}`);
  return { source, name };
}

/** Frontmatter is a flat YAML block between --- fences: `key: value` lines. */
export function parseSkillMd(text: string): { frontmatter: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { frontmatter: fm, body: text.slice(m[0].length) };
}

function walk(dir: string, rel = ""): SkillFile[] {
  let out: SkillFile[] = [];
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (SKIP_DIRS.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), r));
    else if (e.isFile()) {
      let size = 0;
      try { size = fs.statSync(path.join(dir, e.name)).size; } catch { /* unreadable */ }
      out.push({ path: r, size });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function summarize(source: SkillSource, name: string, dir: string, enabled: boolean): SkillSummary | null {
  const md = path.join(dir, "SKILL.md");
  let text = "";
  try { text = fs.readFileSync(md, "utf-8"); } catch { return null; }
  const { frontmatter } = parseSkillMd(text);
  let updatedAt = "";
  try { updatedAt = fs.statSync(md).mtime.toISOString(); } catch { /* fine */ }
  return {
    id: idOf(source, name), source, name: frontmatter.name || name, description: frontmatter.description || "",
    author: frontmatter.author || frontmatter.from || "", enabled, dir, fileCount: walk(dir).length, updatedAt,
  };
}

function listIn(root: string, source: SkillSource, enabled: boolean): SkillSummary[] {
  let names: string[] = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name); } catch { return []; }
  return names.map((n) => summarize(source, n, path.join(root, n), enabled)).filter((s): s is SkillSummary => !!s);
}

export function listSkills(): SkillSummary[] {
  const out: SkillSummary[] = [];
  for (const source of Object.keys(ROOTS) as SkillSource[]) {
    out.push(...listIn(ROOTS[source](), source, true));
    out.push(...listIn(path.join(DISABLED_ROOT(), source), source, false));
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function dirOf(id: string): { source: SkillSource; name: string; dir: string; enabled: boolean } {
  const { source, name } = parseId(id);
  const live = path.join(ROOTS[source](), name);
  if (fs.existsSync(path.join(live, "SKILL.md"))) return { source, name, dir: live, enabled: true };
  const parked = path.join(DISABLED_ROOT(), source, name);
  if (fs.existsSync(path.join(parked, "SKILL.md"))) return { source, name, dir: parked, enabled: false };
  throw new Error(`skill not found: ${id}`);
}

export function getSkill(id: string): SkillDetail {
  const { source, name, dir, enabled } = dirOf(id);
  const sum = summarize(source, name, dir, enabled);
  if (!sum) throw new Error(`skill has no SKILL.md: ${id}`);
  const { frontmatter, body } = parseSkillMd(fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8"));
  return { ...sum, frontmatter, body, files: walk(dir) };
}

function safeJoin(dir: string, rel: string): string {
  const full = path.resolve(dir, rel);
  if (!full.startsWith(path.resolve(dir) + path.sep) && full !== path.resolve(dir)) throw new Error("path escapes the skill folder");
  return full;
}

export function readSkillFile(id: string, rel: string): { text: string; binary: boolean; size: number } {
  const { dir } = dirOf(id);
  const full = safeJoin(dir, rel);
  const size = fs.statSync(full).size;
  if (size > MAX_FILE_BYTES) return { text: "", binary: true, size };
  const buf = fs.readFileSync(full);
  const binary = buf.subarray(0, 4096).includes(0);
  return { text: binary ? "" : buf.toString("utf-8"), binary, size };
}

export function writeSkillFile(id: string, rel: string, text: string): void {
  const { dir } = dirOf(id);
  const full = safeJoin(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, "utf-8");
}

/** Disable = move the folder out of the CLI's directory; enable = move it back. */
export function setSkillEnabled(id: string, on: boolean): SkillSummary {
  const { source, name, dir, enabled } = dirOf(id);
  if (enabled === on) return summarize(source, name, dir, enabled)!;
  const dest = on ? path.join(ROOTS[source](), name) : path.join(DISABLED_ROOT(), source, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(dir, dest);
  return summarize(source, name, dest, on)!;
}

export function deleteSkill(id: string): void {
  const { dir } = dirOf(id);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function revealSkill(id: string): void {
  const { dir } = dirOf(id);
  shell.showItemInFolder(path.join(dir, "SKILL.md"));
}

/** Install a skill as a folder into Glyphh's own skills directory — from the
 *  hub's payload (SKILL.md text + optional files) — and mirror it into every
 *  CLI's directory the machine has, so every loop can use it. */
export function installSkill(name: string, files: Record<string, string>): SkillSummary {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`bad skill name: ${name}`);
  if (!files["SKILL.md"]) throw new Error("a skill needs a SKILL.md");
  const dir = path.join(ROOTS.glyphh(), name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const full = safeJoin(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, "utf-8");
  }
  for (const source of ["claude", "codex", "gemini"] as const) {
    const root = ROOTS[source]();
    if (!fs.existsSync(path.dirname(root))) continue; // that CLI isn't on this machine
    const dest = path.join(root, name);
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(dir, dest, { recursive: true });
    } catch (err) {
      console.warn(`[skills] mirror into ${source} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return summarize("glyphh", name, dir, true)!;
}

/** The hub payload shape today ({manifest, prompt, code}) as folder files. */
export function filesFromHubPayload(name: string, description: string, p: Record<string, unknown>): Record<string, string> {
  const files = (p.files && typeof p.files === "object" ? p.files : null) as Record<string, string> | null;
  if (files && typeof files["SKILL.md"] === "string") return files;
  const body = typeof p.prompt === "string" ? p.prompt : "";
  const fm = `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n`;
  const out: Record<string, string> = { "SKILL.md": fm + body };
  if (typeof p.code === "string" && p.code.trim()) out["scripts/program.js"] = p.code;
  return out;
}

/** A fresh skill folder from a template — the standard shape from the first byte. */
export function createSkill(rawName: string): SkillSummary {
  const name = rawName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!name) throw new Error("a skill needs a name");
  if (fs.existsSync(path.join(ROOTS.glyphh(), name))) throw new Error(`a skill named "${name}" already exists`);
  const md = `---\nname: ${name}\ndescription: What this skill is for, in one line — the agent reads this to decide when to use it.\n---\n\n# ${name}\n\nInstructions the agent follows when this skill applies.\n`;
  return installSkill(name, { "SKILL.md": md });
}

export function registerSkillsIpc(): void {
  ipcMain.handle("skill-create", (_e, name: string) => { try { return { ok: true, data: createSkill(String(name)) }; } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; } });
  const env = <T>(fn: () => T): { ok: boolean; data?: T; error?: string } => {
    try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  };
  ipcMain.handle("skills-list", () => env(() => listSkills()));
  ipcMain.handle("skill-get", (_e, id: string) => env(() => getSkill(String(id))));
  ipcMain.handle("skill-file-read", (_e, id: string, rel: string) => env(() => readSkillFile(String(id), String(rel))));
  ipcMain.handle("skill-file-write", (_e, id: string, rel: string, text: string) => env(() => { writeSkillFile(String(id), String(rel), String(text)); return true; }));
  ipcMain.handle("skill-set-enabled", (_e, id: string, on: boolean) => env(() => setSkillEnabled(String(id), !!on)));
  ipcMain.handle("skill-delete", (_e, id: string) => env(() => { deleteSkill(String(id)); return true; }));
  ipcMain.handle("skill-reveal", (_e, id: string) => env(() => { revealSkill(String(id)); return true; }));
}
