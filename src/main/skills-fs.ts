/**
 * skills-fs — SKILLS ARE FOLDERS (his ruling, 2026-09-16): the Agent Skills
 * standard, one directory per skill with SKILL.md at its root and whatever
 * files it needs beside it. Nothing is converted or copied into a private
 * format. This module reads the folders the CLIs already load —
 *
 *   claude   ~/.claude/skills/<name>/
 *   codex    ~/.codex/skills/<name>/
 *   gemini   ~/.gemini/skills/<name>/
 *   glyphh   ~/.glyphh/<user>/skills/<name>/     (THE home: every skill lives here,
 *            linked into each CLI's directory; a CLI's own folder is adopted on sight)
 *
 * — and serves them to the Skills page: list, detail (frontmatter + body +
 * file tree), file read/write, enable/disable (a disabled skill is MOVED out
 * of the CLI's directory so the CLI stops loading it — a flag would lie),
 * reveal, delete, and install from the hub as a folder.
 */

import fs from "fs";
import path from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
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
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let value = kv[2].trim();
    // Block scalars (`>-`, `|`, `>`): the value is the indented lines that follow,
    // folded to one line for `>` and kept line-by-line for `|`.
    if (/^[>|][+-]?$/.test(value)) {
      const fold = value.startsWith(">");
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) block.push(lines[++i].trim());
      value = fold ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
    }
    fm[key] = value.replace(/^["']|["']$/g, "");
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

/** Is this path a link Glyphh planted (a symlink whose target sits in Glyphh's skills root)? */
function isGlyphhLink(p: string): boolean {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return false;
    const target = path.resolve(path.dirname(p), fs.readlinkSync(p));
    return target.startsWith(ROOTS.glyphh() + path.sep);
  } catch { return false; }
}

function listIn(root: string, source: SkillSource, enabled: boolean): SkillSummary[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
      .filter((e) => source === "glyphh" || !isGlyphhLink(path.join(root, e.name)))
      .map((e) => e.name);
  } catch { return []; }
  return names.map((n) => summarize(source, n, path.join(root, n), enabled)).filter((s): s is SkillSummary => !!s);
}

/** ONE home, every loop sees it: each enabled Glyphh skill is linked into every
 *  CLI skills directory on the box; links whose skill is gone are removed. A
 *  real folder of the same name in a CLI's directory is that CLI's own and is
 *  left alone. */
/** Two folders hold the same files? (names, sizes and bytes of every text file) */
function sameFolder(a: string, b: string): boolean {
  const fa = walk(a), fb = walk(b);
  if (fa.length !== fb.length || fa.some((f, i) => f.path !== fb[i].path || f.size !== fb[i].size)) return false;
  return fa.every((f) => { try { return fs.readFileSync(path.join(a, f.path)).equals(fs.readFileSync(path.join(b, f.path))); } catch { return false; } });
}

/** ADOPTION (his ruling, 2026-09-16): a skill a CLI holds as a real folder moves
 *  into Glyphh's home and a link takes its place, so Glyphh is the one copy and
 *  every CLI sees it. A same-named skill already home with different files
 *  lands as <name>-<cli>; an identical one is dropped for the link. Links a
 *  CLI planted itself (a plugin, a marketplace) are not ours and stay. */
function adoptAll(): void {
  const home = ROOTS.glyphh();
  for (const source of ["claude", "codex", "gemini"] as const) {
    const root = ROOTS[source]();
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const src = path.join(root, e.name);
      if (!fs.existsSync(path.join(src, "SKILL.md"))) continue;
      try {
        fs.mkdirSync(home, { recursive: true });
        let dest = path.join(home, e.name);
        if (fs.existsSync(dest)) {
          if (sameFolder(src, dest)) { fs.rmSync(src, { recursive: true, force: true }); fs.symlinkSync(dest, src, "dir"); continue; }
          dest = path.join(home, `${e.name}-${source}`);
          if (fs.existsSync(dest)) continue;
        }
        fs.renameSync(src, dest);
        fs.symlinkSync(dest, src, "dir");
      } catch (err) {
        console.warn(`[skills] adopting ${source}/${e.name} failed:`, err instanceof Error ? err.message : String(err));
      }
    }
  }
}

export function syncLinks(): void {
  adoptAll();
  const home = ROOTS.glyphh();
  let mine: string[] = [];
  try { mine = fs.readdirSync(home, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name); } catch { /* no skills yet */ }
  for (const source of ["claude", "codex", "gemini"] as const) {
    const root = ROOTS[source]();
    if (!fs.existsSync(path.dirname(root))) continue;
    try {
      fs.mkdirSync(root, { recursive: true });
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        const p = path.join(root, e.name);
        if (isGlyphhLink(p) && !fs.existsSync(path.join(p, "SKILL.md"))) fs.rmSync(p, { force: true });
      }
      for (const name of mine) {
        const dest = path.join(root, name);
        let st: fs.Stats | null = null;
        try { st = fs.lstatSync(dest); } catch { /* absent */ }
        if (st && !st.isSymbolicLink()) continue;
        if (st && isGlyphhLink(dest)) continue;
        if (st) fs.rmSync(dest, { force: true });
        fs.symlinkSync(path.join(home, name), dest, "dir");
      }
    } catch (err) {
      console.warn(`[skills] sync into ${source} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
}

export function listSkills(): SkillSummary[] {
  syncLinks();
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
  syncLinks();
  return summarize(source, name, dest, on)!;
}

export function deleteSkill(id: string): void {
  const { dir } = dirOf(id);
  fs.rmSync(dir, { recursive: true, force: true });
  syncLinks();
}

/** A CLI's own skill folder becomes a Glyphh skill: moved home, linked back. */
export function adoptSkill(id: string): SkillSummary {
  const { source, name, dir } = dirOf(id);
  if (source === "glyphh") throw new Error("already managed by Glyphh");
  const home = path.join(ROOTS.glyphh(), name);
  if (fs.existsSync(home)) throw new Error(`a Glyphh skill named "${name}" already exists`);
  fs.mkdirSync(ROOTS.glyphh(), { recursive: true });
  fs.renameSync(dir, home);
  syncLinks();
  return summarize("glyphh", name, home, true)!;
}

/** Replace a Glyphh skill's files with a folder the user picked (it must carry a SKILL.md). */
export function replaceSkill(id: string, fromDir: string): SkillSummary {
  const { source, name, dir } = dirOf(id);
  if (source !== "glyphh") throw new Error("only Glyphh-managed skills can be replaced here");
  if (!fs.existsSync(path.join(fromDir, "SKILL.md"))) throw new Error("that folder has no SKILL.md");
  for (const e of fs.readdirSync(dir)) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  fs.cpSync(fromDir, dir, { recursive: true, filter: (src) => !SKIP_DIRS.has(path.basename(src)) });
  return summarize("glyphh", name, dir, true)!;
}

/** The skill as a zip at a path the user chose (a folder copy where zip isn't native). */
export function exportSkill(id: string, to: string): void {
  const { dir } = dirOf(id);
  if (process.platform === "darwin" && to.endsWith(".zip")) {
    execFileSync("ditto", ["-c", "-k", "--keepParent", dir, to]);
    return;
  }
  fs.cpSync(dir, to.replace(/\.zip$/, ""), { recursive: true });
}

export function revealSkill(id: string): void {
  const { dir } = dirOf(id);
  shell.showItemInFolder(path.join(dir, "SKILL.md"));
}

/** Install a skill as a folder into Glyphh's own skills directory — from the
 *  hub's payload (SKILL.md text + optional files) — and link it into every
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
  syncLinks();
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

/** Import a skill from a .zip (Claude's export) or a folder into Glyphh's home. */
export function importSkill(picked: string): SkillSummary {
  let folder = picked;
  let tmp = "";
  if (/\.zip$/i.test(picked)) {
    if (process.platform !== "darwin") throw new Error("zip import needs macOS for now; unzip it and import the folder");
    tmp = fs.mkdtempSync(path.join(app.getPath("temp"), "skill-"));
    execFileSync("ditto", ["-x", "-k", picked, tmp]);
    folder = tmp;
  }
  const find = (dir: string, depth: number): string | null => {
    if (fs.existsSync(path.join(dir, "SKILL.md"))) return dir;
    if (depth === 0) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "__MACOSX") continue;
      const hit = find(path.join(dir, e.name), depth - 1);
      if (hit) return hit;
    }
    return null;
  };
  const src = find(folder, 2);
  if (!src) throw new Error("no SKILL.md inside that");
  const { frontmatter } = parseSkillMd(fs.readFileSync(path.join(src, "SKILL.md"), "utf-8"));
  const base = (frontmatter.name || path.basename(src === tmp ? picked.replace(/\.zip$/i, "") : src)).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "skill";
  let name = base;
  for (let i = 2; fs.existsSync(path.join(ROOTS.glyphh(), name)); i++) name = `${base}-${i}`;
  const dest = path.join(ROOTS.glyphh(), name);
  fs.mkdirSync(ROOTS.glyphh(), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter: (f) => !SKIP_DIRS.has(path.basename(f)) });
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  syncLinks();
  return summarize("glyphh", name, dest, true)!;
}

export function registerSkillsIpc(): void {
  ipcMain.handle("skills-home", () => { const d = ROOTS.glyphh(); fs.mkdirSync(d, { recursive: true }); return { ok: true, data: d }; });
  ipcMain.handle("skill-import", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const picked = await dialog.showOpenDialog(win ?? undefined as never, {
      title: "Import a skill", properties: ["openFile", "openDirectory"], filters: [{ name: "Skill (zip or folder)", extensions: ["zip"] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, data: null };
    try { return { ok: true, data: importSkill(picked.filePaths[0]) }; } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
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
  ipcMain.handle("skill-adopt", (_e, id: string) => env(() => adoptSkill(String(id))));
  ipcMain.handle("skill-replace", async (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const picked = await dialog.showOpenDialog(win ?? undefined as never, { title: "Replace with a skill folder", properties: ["openDirectory"] });
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, data: null };
    return env(() => replaceSkill(String(id), picked.filePaths[0]));
  });
  ipcMain.handle("skill-download", async (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { name } = getSkill(String(id));
    const picked = await dialog.showSaveDialog(win ?? undefined as never, { title: "Download skill", defaultPath: path.join(app.getPath("downloads"), `${name}.zip`), filters: [{ name: "Zip", extensions: ["zip"] }] });
    if (picked.canceled || !picked.filePath) return { ok: true, data: null };
    return env(() => { exportSkill(String(id), picked.filePath); return picked.filePath; });
  });
}
