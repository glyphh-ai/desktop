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
import { registerBundleApp, unregisterBundleApp } from "./glyphh-app-host.js";

export type SkillSource = "glyphh" | "app" | "plugin" | "task" | "claude" | "codex" | "gemini";
/** The two homes: skills and APPS (a skill folder plus app.json — his ruling, 2026-09-16). */
export type HomeKind = "skill" | "app" | "plugin" | "task";
/** The tasks home: bundles the desktop runs itself (task-runner.ts). */
export const TASKS_HOME = (): string => userScopedPath("tasks");

/** WHAT A BUNDLE IS (his ruling, 2026-09-17): every folder here is a skill;
 *  the type says what KIND of skill it is. "This skill is an app", "this skill
 *  is a task". The type is what the folder can DO — the manifest beside
 *  SKILL.md — so it is read from the bundle, never guessed from where it
 *  lives. SKILL.md frontmatter may declare `type:` and that is honored only
 *  when no manifest is there yet (an agent naming its intent mid-build). */
export type BundleType = "skill" | "app" | "task" | "plugin";

export function bundleType(dir: string, declared?: string): BundleType {
  if (fs.existsSync(path.join(dir, "task.json"))) return "task";
  if (fs.existsSync(path.join(dir, "app.json"))) return "app";
  if (isPlugin(dir)) return "plugin";
  const d = (declared || "").trim().toLowerCase();
  return d === "app" || d === "task" || d === "plugin" ? d : "skill";
}

export interface SkillSummary {
  id: string;
  source: SkillSource;
  /** What kind of skill this is: a plain skill, an app, a task, a plugin. */
  type: BundleType;
  name: string;
  description: string;
  author: string;
  enabled: boolean;
  dir: string;
  fileCount: number;
  updatedAt: string;
  /** App and task bundles: the manifest's icon.svg markup. */
  icon?: string | null;
  /** An app that IS a built-in work panel names its view here ("gdesign"). */
  tool?: string | null;
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
  app: () => userScopedPath("apps"),
  plugin: () => userScopedPath("plugins"),
  task: () => TASKS_HOME(),
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

/** A plugin (Claude Code's format) carries .claude-plugin/plugin.json instead of a root SKILL.md. */
const PLUGIN_MANIFEST = path.join(".claude-plugin", "plugin.json");
const isPlugin = (dir: string): boolean => fs.existsSync(path.join(dir, PLUGIN_MANIFEST));
function pluginManifest(dir: string): { name?: string; description?: string; version?: string; author?: { name?: string } | string } {
  try { return JSON.parse(fs.readFileSync(path.join(dir, PLUGIN_MANIFEST), "utf-8")) as ReturnType<typeof pluginManifest>; } catch { return {}; }
}
/** The file that makes a folder a skill, an app, or a plugin. */
function markerOf(dir: string): string | null {
  if (fs.existsSync(path.join(dir, "SKILL.md"))) return path.join(dir, "SKILL.md");
  if (isPlugin(dir)) return path.join(dir, PLUGIN_MANIFEST);
  return null;
}

function summarize(source: SkillSource, name: string, dir: string, enabled: boolean): SkillSummary | null {
  const md = path.join(dir, "SKILL.md");
  let text = "";
  try { text = fs.readFileSync(md, "utf-8"); } catch { text = ""; }
  let frontmatter: Record<string, string> = text ? parseSkillMd(text).frontmatter : {};
  let marker = md;
  if (!text && isPlugin(dir)) {
    const m = pluginManifest(dir);
    frontmatter = { name: m.name || "", description: m.description || "", author: typeof m.author === "string" ? m.author : (m.author?.name || ""), version: m.version || "" };
    marker = path.join(dir, PLUGIN_MANIFEST);
  } else if (!text) return null;
  let updatedAt = "";
  try { updatedAt = fs.statSync(marker).mtime.toISOString(); } catch { /* fine */ }
  const type = bundleType(dir, frontmatter.type);
  const { icon, tool } = bundleMarks(dir, type);
  return {
    id: idOf(source, name), source, type, name: frontmatter.name || name, description: frontmatter.description || "",
    author: frontmatter.author || frontmatter.from || "", enabled, dir, fileCount: walk(dir).length, updatedAt,
    icon, tool,
  };
}

/** What an app or task manifest says about how it LOOKS and what it opens: the
 *  icon.svg it ships, and the built-in panel it is (an app with a `tool` wears
 *  that panel's mark when it ships no icon of its own). */
export function bundleMarks(dir: string, type: BundleType): { icon: string | null; tool: string | null } {
  if (type !== "app" && type !== "task") return { icon: null, tool: null };
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, `${type}.json`), "utf-8")) as { icon?: unknown; tool?: unknown };
    const tool = typeof m.tool === "string" && m.tool ? m.tool : null;
    if (typeof m.icon !== "string" || !m.icon.endsWith(".svg")) return { icon: null, tool };
    const svg = fs.readFileSync(safeJoin(dir, m.icon), "utf-8");
    return { icon: svg.includes("<svg") && svg.length < 64_000 ? svg : null, tool };
  } catch { return { icon: null, tool: null }; }
}

/** Is this path a link Glyphh planted (a symlink whose target sits in Glyphh's skills root)? */
function isGlyphhLink(p: string): boolean {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return false;
    const target = path.resolve(path.dirname(p), fs.readlinkSync(p));
    return target.startsWith(ROOTS.glyphh() + path.sep) || target.startsWith(ROOTS.app() + path.sep);
  } catch { return false; }
}
const isApp = (dir: string): boolean => fs.existsSync(path.join(dir, "app.json"));
const homeFor = (kind: HomeKind): string => (kind === "app" ? ROOTS.app() : kind === "plugin" ? ROOTS.plugin() : kind === "task" ? ROOTS.task() : ROOTS.glyphh());

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
        const target = isApp(src) ? ROOTS.app() : home;
        fs.mkdirSync(target, { recursive: true });
        let dest = path.join(target, e.name);
        if (fs.existsSync(dest)) {
          if (sameFolder(src, dest)) { fs.rmSync(src, { recursive: true, force: true }); fs.symlinkSync(dest, src, "dir"); continue; }
          dest = path.join(target, `${e.name}-${source}`);
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
  // Both homes link into every CLI: an app's SKILL.md is how agents drive it.
  const homes: Array<[string, string[]]> = [];
  for (const home of [ROOTS.glyphh(), ROOTS.app()]) {
    let names: string[] = [];
    try { names = fs.readdirSync(home, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name); } catch { /* none yet */ }
    homes.push([home, names]);
  }
  for (const source of ["claude", "codex", "gemini"] as const) {
    const root = ROOTS[source]();
    if (!fs.existsSync(path.dirname(root))) continue;
    try {
      fs.mkdirSync(root, { recursive: true });
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        const p = path.join(root, e.name);
        if (isGlyphhLink(p) && !fs.existsSync(path.join(p, "SKILL.md"))) fs.rmSync(p, { force: true });
      }
      for (const [home, names] of homes) for (const name of names) {
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
  syncPluginMarketplace();
}

/** The plugins home is a LOCAL MARKETPLACE for Claude Code: a marketplace.json
 *  naming every plugin folder, registered once (`claude plugin marketplace add`),
 *  each plugin installed from it at user scope. Best effort and quiet: no
 *  Claude on the machine simply leaves the plugins as folders. */
let marketplaceSynced = "";
function syncPluginMarketplace(): void {
  const home = ROOTS.plugin();
  let names: string[] = [];
  try { names = fs.readdirSync(home, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && isPlugin(path.join(home, e.name))).map((e) => e.name); } catch { return; }
  const plugins = names.map((n) => { const m = pluginManifest(path.join(home, n)); return { name: m.name || n, source: `./${n}`, description: m.description || "", version: m.version || "0.1.0" }; });
  const doc = JSON.stringify({ name: "glyphh", owner: { name: "Glyphh" }, plugins }, null, 2) + "\n";
  const key = doc;
  if (marketplaceSynced === key) return;
  marketplaceSynced = key;
  try {
    fs.mkdirSync(path.join(home, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude-plugin", "marketplace.json"), doc, "utf-8");
  } catch (err) { console.warn("[plugins] marketplace.json:", err instanceof Error ? err.message : String(err)); return; }
  if (!fs.existsSync(path.join(homedir(), ".claude"))) return;
  const run = (args: string[]): void => {
    try { execFileSync("claude", ["plugin", ...args], { stdio: "ignore", timeout: 20_000, env: { ...process.env, CLAUDE_CODE_NO_TELEMETRY: "1" } }); }
    catch { /* not installed, or already there */ }
  };
  const marker = path.join(home, ".claude-plugin", ".registered");
  if (!fs.existsSync(marker)) { run(["marketplace", "add", home, "--scope", "user"]); try { fs.writeFileSync(marker, new Date().toISOString()); } catch { /* fine */ } }
  for (const pl of plugins) run(["install", `${pl.name}@glyphh`, "--scope", "user"]);
}

/** The homes a kind reads from. A list of kinds unions them, which is how one
 *  page lists skills and apps together while both pages still exist. */
const SOURCES_FOR = (kind: HomeKind): SkillSource[] =>
  kind === "app" ? ["app"] : kind === "plugin" ? ["plugin"] : kind === "task" ? ["task"] : ["glyphh", "claude", "codex", "gemini"];

export function listSkills(kind: HomeKind | HomeKind[] = "skill"): SkillSummary[] {
  syncLinks();
  const out: SkillSummary[] = [];
  const sources = [...new Set((Array.isArray(kind) ? kind : [kind]).flatMap(SOURCES_FOR))];
  for (const source of sources) {
    out.push(...listIn(ROOTS[source](), source, true));
    out.push(...listIn(path.join(DISABLED_ROOT(), source), source, false));
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** A file as a data URL (screenshots on the Overview). */
export function readSkillImage(id: string, rel: string): string {
  const { dir } = dirOf(id);
  const full = safeJoin(dir, rel);
  const st = fs.statSync(full);
  if (st.size > 4 * 1024 * 1024) throw new Error("image is larger than 4 MB");
  const ext = path.extname(full).toLowerCase().replace(".", "");
  const mime = ext === "jpg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : `image/${ext || "png"}`;
  return `data:${mime};base64,${fs.readFileSync(full).toString("base64")}`;
}

function dirOf(id: string): { source: SkillSource; name: string; dir: string; enabled: boolean } {
  const { source, name } = parseId(id);
  const live = path.join(ROOTS[source](), name);
  if (markerOf(live)) return { source, name, dir: live, enabled: true };
  const parked = path.join(DISABLED_ROOT(), source, name);
  if (markerOf(parked)) return { source, name, dir: parked, enabled: false };
  throw new Error(`skill not found: ${id}`);
}

export function getSkill(id: string): SkillDetail {
  const { source, name, dir, enabled } = dirOf(id);
  const sum = summarize(source, name, dir, enabled);
  if (!sum) throw new Error(`skill has no SKILL.md: ${id}`);
  if (source === "plugin" && !fs.existsSync(path.join(dir, "SKILL.md"))) {
    let body = "";
    try { body = fs.readFileSync(path.join(dir, "README.md"), "utf-8"); } catch { body = ""; }
    const m = pluginManifest(dir);
    return { ...sum, frontmatter: { name: sum.name, description: sum.description, version: m.version || "" }, body, files: walk(dir) };
  }
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
  const type = bundleType(dir);
  const dest = on ? path.join(ROOTS[source](), name) : path.join(DISABLED_ROOT(), source, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(dir, dest);
  syncLinks();
  // An app's TAB follows the switch: turned off it leaves the rail and the
  // wall (its entry just moved out from under them), turned on it comes back.
  if (type === "app") {
    if (on) void registerBundleApp(dest).then((r) => { if (!r.ok) console.warn(`[skills] app "${name}" has no tab: ${r.error}`); });
    else void unregisterBundleApp(dir, { keepSecrets: true });
  }
  return summarize(source, name, dest, on)!;
}

/** The hub side of a delete (hub-ipc registers it): a folder that came from the
 *  catalog tells it so when it goes. Late-bound, since hub-ipc reads this file. */
let forgetInstall: ((id: string) => void) | null = null;
export function setInstallForgetter(fn: (id: string) => void): void { forgetInstall = fn; }

export function deleteSkill(id: string): void {
  const { dir } = dirOf(id);
  const type = bundleType(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  syncLinks();
  if (type === "app") void unregisterBundleApp(dir);
  forgetInstall?.(id);
}

/** Take named files out of a bundle, and any folder they emptied. An update
 *  uses it for what the new payload dropped; whatever the user added stays. */
export function removeSkillFiles(id: string, rels: string[]): void {
  const { dir } = dirOf(id);
  for (const rel of rels) {
    let full: string;
    try { full = safeJoin(dir, rel); } catch { continue; }
    fs.rmSync(full, { force: true });
    for (let d = path.dirname(full); d.startsWith(path.resolve(dir) + path.sep); d = path.dirname(d)) {
      try { if (fs.readdirSync(d).length) break; fs.rmdirSync(d); } catch { break; }
    }
  }
}

/** A CLI's own skill folder becomes a Glyphh skill: moved home, linked back. */
export function adoptSkill(id: string): SkillSummary {
  const { source, name, dir } = dirOf(id);
  if (source === "glyphh" || source === "app") throw new Error("already managed by Glyphh");
  const target: SkillSource = isApp(dir) ? "app" : "glyphh";
  const home = path.join(ROOTS[target](), name);
  if (fs.existsSync(home)) throw new Error(`a Glyphh ${target === "app" ? "app" : "skill"} named "${name}" already exists`);
  fs.mkdirSync(ROOTS[target](), { recursive: true });
  fs.renameSync(dir, home);
  syncLinks();
  return summarize(target, name, home, true)!;
}

/** Replace a Glyphh skill's files with a folder the user picked (it must carry a SKILL.md). */
export function replaceSkill(id: string, fromDir: string): SkillSummary {
  const { source, name, dir } = dirOf(id);
  if (source !== "glyphh" && source !== "app") throw new Error("only Glyphh-managed skills can be replaced here");
  if (!fs.existsSync(path.join(fromDir, "SKILL.md"))) throw new Error("that folder has no SKILL.md");
  for (const e of fs.readdirSync(dir)) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  fs.cpSync(fromDir, dir, { recursive: true, filter: (src) => !SKIP_DIRS.has(path.basename(src)) });
  return summarize(source, name, dir, true)!;
}

/** The skill as a zip at a path the user chose (a folder copy where zip isn't native). */
export function exportSkill(id: string, to: string): void {
  const { dir } = dirOf(id);
  if (process.platform === "darwin" && /\.(zip|glyphh)$/i.test(to)) {
    execFileSync("ditto", ["-c", "-k", "--keepParent", dir, to]);
    return;
  }
  fs.cpSync(dir, to.replace(/\.(zip|glyphh)$/i, ""), { recursive: true });
}

export function revealSkill(id: string): void {
  const { dir } = dirOf(id);
  shell.showItemInFolder(path.join(dir, "SKILL.md"));
}

/** Install a skill as a folder into Glyphh's own skills directory — from the
 *  hub's payload (SKILL.md text + optional files) — and link it into every
 *  CLI's directory the machine has, so every loop can use it. */
export function installSkill(name: string, files: Record<string, string>, kind: HomeKind = "skill"): SkillSummary {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`bad skill name: ${name}`);
  const plugin = kind === "plugin" || (!files["SKILL.md"] && !!files[".claude-plugin/plugin.json"]);
  if (!files["SKILL.md"] && !plugin) throw new Error("a skill needs a SKILL.md");
  if (plugin && !files[".claude-plugin/plugin.json"]) throw new Error("a plugin needs .claude-plugin/plugin.json");
  const source: SkillSource = plugin ? "plugin" : kind === "task" || files["task.json"] ? "task" : kind === "app" || files["app.json"] ? "app" : "glyphh";
  const dir = path.join(ROOTS[source](), name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const full = safeJoin(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    // A screenshot rides the hub as a data URL; it lands as the file it was.
    const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(text);
    if (m && /\.(png|jpe?g|gif|webp|svg)$/i.test(rel)) fs.writeFileSync(full, Buffer.from(m[2], "base64"));
    else fs.writeFileSync(full, text, "utf-8");
  }
  syncLinks();
  if (source === "app") void registerBundleApp(dir).then((r) => { if (!r.ok) console.warn(`[skills] app "${name}" has no tab: ${r.error}`); });
  return summarize(source, name, dir, true)!;
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
export function createSkill(rawName: string, kind: HomeKind = "skill"): SkillSummary {
  const name = rawName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!name) throw new Error("a skill needs a name");
  if (fs.existsSync(path.join(homeFor(kind), name))) throw new Error(`a ${kind} named "${name}" already exists`);
  const md = `---\nname: ${name}\ndescription: What this ${kind} is for, in one line — the agent reads this to decide when to use it.\n---\n\n# ${name}\n\nInstructions the agent follows when this ${kind} applies.\n`;
  if (kind === "skill") return installSkill(name, { "SKILL.md": md });
  if (kind === "plugin") {
    const pj = JSON.stringify({ name, description: `What this plugin is for, in one line.`, version: "0.1.0" }, null, 2) + "\n";
    const readme = `# ${name}\n\nA Claude Code plugin: skills/, commands/, agents/, hooks/ and .mcp.json travel together.\n`;
    return installSkill(name, { ".claude-plugin/plugin.json": pj, "README.md": readme, [`skills/${name}/SKILL.md`]: md }, "plugin");
  }
  if (kind === "task") {
    const tj = JSON.stringify({ name, program: "run.js", slots: { main: { label: "Main", description: "The agent this task runs through.", agent: null } }, schedule: null, dependencies: { connections: [] } }, null, 2) + "\n";
    const js = `// A Glyphh task: the desktop runs this program itself. Agents only where it slots them.\nmodule.exports = async function run(ctx, input) {\n  const turn = await ctx.checkpoint("turn", () => ctx.agents.main.run("Say what this task should do."));\n  return { output: turn.text };\n};\n`;
    return installSkill(name, { "SKILL.md": md, "task.json": tj, "run.js": js }, "task");
  }
  const manifest = JSON.stringify({ name, ui: "ui/index.html", tools: "tools/manifest.json", data: "data/schema.sql", dependencies: { connections: [] }, screenshots: [] }, null, 2) + "\n";
  const ui = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8" /><title>${name}</title></head>\n<body><h1>${name}</h1><p>The app's face. The agent drives it through the tools in tools/manifest.json.</p></body></html>\n`;
  return installSkill(name, { "SKILL.md": md, "app.json": manifest, "ui/index.html": ui, "tools/manifest.json": JSON.stringify({ tools: [] }, null, 2) + "\n" }, "app");
}

/** Import a skill from a .zip (Claude's export) or a folder into Glyphh's home. */
export function importSkill(picked: string, kind: HomeKind = "skill"): SkillSummary {
  let folder = picked;
  let tmp = "";
  if (/\.(zip|glyphh)$/i.test(picked)) {
    if (process.platform !== "darwin") throw new Error("zip import needs macOS for now; unzip it and import the folder");
    tmp = fs.mkdtempSync(path.join(app.getPath("temp"), "skill-"));
    execFileSync("ditto", ["-x", "-k", picked, tmp]);
    folder = tmp;
  }
  const find = (dir: string, depth: number): string | null => {
    if (kind === "plugin" ? isPlugin(dir) : fs.existsSync(path.join(dir, "SKILL.md"))) return dir;
    if (depth === 0) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "__MACOSX") continue;
      const hit = find(path.join(dir, e.name), depth - 1);
      if (hit) return hit;
    }
    return null;
  };
  const src = find(folder, 2);
  if (!src) throw new Error(kind === "plugin" ? "no .claude-plugin/plugin.json inside that" : "no SKILL.md inside that");
  const given = kind === "plugin" ? (pluginManifest(src).name || "") : parseSkillMd(fs.readFileSync(path.join(src, "SKILL.md"), "utf-8")).frontmatter.name;
  const base = (given || path.basename(src === tmp ? picked.replace(/\.(zip|glyphh)$/i, "") : src)).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || kind;
  const target: SkillSource = kind === "plugin" ? "plugin" : kind === "task" || fs.existsSync(path.join(src, "task.json")) ? "task" : kind === "app" || isApp(src) ? "app" : "glyphh";
  let name = base;
  for (let i = 2; fs.existsSync(path.join(ROOTS[target](), name)); i++) name = `${base}-${i}`;
  const dest = path.join(ROOTS[target](), name);
  fs.mkdirSync(ROOTS[target](), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter: (f) => !SKIP_DIRS.has(path.basename(f)) });
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  syncLinks();
  if (target === "app") void registerBundleApp(dest).then((r) => { if (!r.ok) console.warn(`[skills] app "${name}" has no tab: ${r.error}`); });
  return summarize(target, name, dest, true)!;
}

/** Bundles already in the apps home (adopted, or from before tabs) get their tab once per run. */
const tabbed = new Set<string>();
function tabBundles(): void {
  for (const s of listSkills("app")) {
    const { dir, enabled } = dirOf(s.id);
    if (!enabled || tabbed.has(dir)) continue;
    tabbed.add(dir);
    void registerBundleApp(dir).then((r) => { if (!r.ok) console.warn(`[skills] app "${s.name}" has no tab: ${r.error}`); });
  }
}

export function registerSkillsIpc(): void {
  tabBundles();
  const kindOf = (k: unknown): HomeKind => (k === "app" ? "app" : k === "plugin" ? "plugin" : k === "task" ? "task" : "skill");
  const kindsOf = (k: unknown): HomeKind[] => (Array.isArray(k) ? [...new Set(k.map(kindOf))] : [kindOf(k)]);
  ipcMain.handle("skills-home", (_e, kind?: string) => { const d = homeFor(kindOf(kind)); fs.mkdirSync(d, { recursive: true }); return { ok: true, data: d }; });
  ipcMain.handle("skill-import", async (e, kind?: string) => {
    const k = kindOf(kind);
    const win = BrowserWindow.fromWebContents(e.sender);
    const picked = await dialog.showOpenDialog(win ?? undefined as never, {
      title: k === "app" ? "Import an app" : k === "plugin" ? "Import a plugin" : k === "task" ? "Import a task" : "Import a skill", properties: ["openFile", "openDirectory"],
      // A picked bundle lands by WHAT IT IS (app.json/task.json inside), so the
      // skills picker takes .glyphh app exports too.
      filters: [{ name: k === "app" ? "App (.glyphh, zip or folder)" : k === "plugin" ? "Plugin (zip or folder)" : k === "task" ? "Task (zip or folder)" : "Skill or app (.glyphh, zip or folder)", extensions: k === "plugin" || k === "task" ? ["zip"] : ["glyphh", "zip"] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, data: null };
    try { return { ok: true, data: importSkill(picked.filePaths[0], k) }; } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("skill-image", (_e, id: string, rel: string) => { try { return { ok: true, data: readSkillImage(String(id), String(rel)) }; } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; } });
  ipcMain.handle("skill-create", (_e, name: string, kind?: string) => { try { return { ok: true, data: createSkill(String(name), kindOf(kind)) }; } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; } });
  const env = <T>(fn: () => T): { ok: boolean; data?: T; error?: string } => {
    try { return { ok: true, data: fn() }; } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  };
  ipcMain.handle("skills-list", (_e, kind?: string | string[]) => env(() => {
    const kinds = kindsOf(kind);
    if (kinds.includes("app")) tabBundles();
    return listSkills(kinds);
  }));
  ipcMain.handle("skill-tab", async (_e, id: string, opts?: { name?: string; slug?: string }) => {
    try {
      const { dir } = dirOf(String(id));
      // The TYPE opens the tab, not the home it sits in: an app is an app
      // wherever its app.json is (his ruling, 2026-09-17).
      if (bundleType(dir) !== "app") return { ok: false, error: "only an app opens as a tab" };
      const r = await registerBundleApp(dir, { name: opts?.name, slug: opts?.slug });
      return r.ok ? { ok: true, data: { slug: r.slug, name: r.name, tool: r.tool } } : { ok: false, error: r.error };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  });
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
    const isAppId = String(id).startsWith("app:");
    const picked = await dialog.showSaveDialog(win ?? undefined as never, { title: isAppId ? "Download app" : "Download skill", defaultPath: path.join(app.getPath("downloads"), `${name}.${isAppId ? "glyphh" : "zip"}`), filters: [{ name: isAppId ? "Glyphh app" : "Zip", extensions: [isAppId ? "glyphh" : "zip"] }] });
    if (picked.canceled || !picked.filePath) return { ok: true, data: null };
    return env(() => { exportSkill(String(id), picked.filePath); return picked.filePath; });
  });
}
