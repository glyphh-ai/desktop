/**
 * SkillEngine — server-authoritative skill storage and lifecycle execution.
 *
 * The SERVER (yo-server's saved_skills) is the source of truth — skills are
 * authored only by the assistant (via the skill-builder system skill), never
 * hand-written in the client. `refreshFromServer()` fetches every skill the
 * org's agent may invoke (GET /api/skills/tools) and MIRRORS it into
 * ~/.claude/skills/<name>/ as a local EXECUTION CACHE, so the deterministic
 * runner (skill-runner.ts) and scheduler (which read SKILL.js/SKILL.md off
 * disk) keep working unchanged:
 *   - SKILL.md    (required): YAML frontmatter + prompt body
 *   - SKILL.js    (optional): deterministic JS runner — see skill-runner.ts
 *   - Any other files (arbitrary artifacts, templates, examples)
 *
 * The cache is read-only from the user's perspective: writes/deletes/imports
 * are disabled (see skills-ipc.ts). Deleting a skill on the server prunes its
 * local folder on the next sync.
 *
 * Dispatch in runSkill():
 *   - SKILL.js present → runs through SkillRunner (ctx.tools.call, ctx.claude, lifecycle hooks)
 *   - SKILL.js missing → the skill has no deterministic implementation and fails clearly
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import yaml from "js-yaml";
import AdmZip from "adm-zip";

import { LLMConfig } from "./llm-config";
import { sdkComplete } from "./sdk-llm";
import { serverGetAuthed } from "./auth";
import type { McpManager } from "./mcp-manager";
import {
  Skill,
  SkillManifest,
  SkillSummary,
  SkillRun,
  ProgressEvent,
  RunOpts,
} from "./skill-types";
import { runSkillJs, readSkillJsSchedule, buildRunRecord, type RunnerDeps } from "./skill-runner";

const SKILL_MD = "SKILL.md";
const SKILL_JS = "SKILL.js";
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// ── Server sync types ────────────────────────────────────────
//
// The shape returned by yo-server's agent tool surface (GET /api/skills/tools
// and /tools/:id/files). Skills are keyed by UUID on the server; the local
// cache keys folders by (sanitized) name, so we keep a name→id map per sync.

interface ServerSkillSummary {
  id: string;
  name: string;
  description?: string;
  hasRunner: boolean;
  hasApp: boolean;
  isSystem: boolean;
  updatedAt: string;
}

// Legacy fallback prompt when a skill has neither runner nor body.
const DEFAULT_SKILL_PROMPT = `You are a context capture assistant.
Given the following session content (raw conversation between a user and an AI),
extract and organize the key information into clean markdown.

Include:
- Summary of what was discussed
- Key decisions made
- Action items or follow-ups
- Important code snippets or commands
- Any unresolved questions

Format as clean, readable markdown. Be concise.`;

export class SkillEngine {
  private skillsDir: string;
  private llmConfig: LLMConfig | null = null;
  private runHistory: Map<string, SkillRun[]> = new Map();
  private onChangeCallbacks: Array<() => void> = [];
  private onRunCompleteCb: ((run: SkillRun) => void) | null = null;
  private mcpManager: McpManager | null = null;
  private libraryDir: string;
  // Server-mirror bookkeeping — name→server UUID for the last sync, plus a
  // small debounce so rapid UI events don't hammer the API.
  private nameToId: Map<string, string> = new Map();
  // Names of hidden system skills (skill-builder, rpa-runner) — mirrored so the
  // agent can RUN them, but excluded from the user-facing browse lists.
  private systemNames: Set<string> = new Set();
  private lastSyncAt = 0;
  private syncing: Promise<void> | null = null;

  constructor() {
    this.skillsDir = path.join(os.homedir(), ".claude", "skills");
    this.libraryDir = path.join(os.homedir(), ".claude", "skill-library");
    fs.mkdirSync(this.skillsDir, { recursive: true });
    fs.mkdirSync(this.libraryDir, { recursive: true });
  }

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }
  getLLMConfig(): LLMConfig | null { return this.llmConfig; }
  getSkillsDir(): string { return this.skillsDir; }
  setMcpManager(m: McpManager | null): void { this.mcpManager = m; }
  hasRunner(name: string): boolean {
    const folder = this.skillFolder(name);
    return fs.existsSync(path.join(folder, SKILL_JS));
  }
  getSkillJsSchedule(name: string): string | null {
    const folder = this.skillFolder(name);
    return readSkillJsSchedule(path.join(folder, SKILL_JS));
  }

  onChange(cb: () => void): void { this.onChangeCallbacks.push(cb); }
  private emitChange(): void { for (const cb of this.onChangeCallbacks) try { cb(); } catch {} }

  /** Notified after every completed run (manual/scheduled) — main persists it. */
  onRunComplete(cb: (run: SkillRun) => void): void { this.onRunCompleteCb = cb; }

  // ── Path helpers ─────────────────────────────────────

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  }

  private skillFolder(name: string): string {
    return path.join(this.skillsDir, this.sanitizeName(name));
  }

  /** Validate a path stays within the skills directory (path traversal guard). */
  private safePath(base: string, rel: string): string | null {
    const joined = path.resolve(base, rel);
    const baseResolved = path.resolve(base);
    if (!joined.startsWith(baseResolved + path.sep) && joined !== baseResolved) return null;
    return joined;
  }

  // ── Frontmatter ──────────────────────────────────────

  parseFrontmatter(md: string): { manifest: SkillManifest; body: string } {
    const match = md.match(FRONTMATTER_RE);
    if (!match) return { manifest: { name: "" }, body: md };
    try {
      const parsed = yaml.load(match[1]) as SkillManifest;
      return { manifest: parsed || { name: "" }, body: match[2] };
    } catch {
      return { manifest: { name: "" }, body: md };
    }
  }

  serializeFrontmatter(manifest: SkillManifest, body: string): string {
    // Strip undefined/null entries for a clean file
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(manifest)) {
      if (v !== undefined && v !== null) clean[k] = v;
    }
    const fm = yaml.dump(clean, { noRefs: true, lineWidth: 0 });
    return `---\n${fm.trim()}\n---\n\n${body.trim()}\n`;
  }

  // ── Server sync (source of truth → local execution cache) ─────
  //
  // Skills are authored only by the assistant, server-side. This mirrors every
  // agent-available skill (system + org) into the local cache so the runner and
  // scheduler can execute them off disk. Non-fatal on failure (offline / not
  // yet authenticated): the existing cache is left in place.

  /** Resolve a skill's server UUID from the last sync (null if unknown). */
  serverIdForName(name: string): string | null {
    return this.nameToId.get(this.sanitizeName(name)) ?? null;
  }

  /**
   * Fetch all agent-available skills from the server and mirror them into the
   * local execution cache. Debounced (3s) unless forced. Coalesces concurrent
   * callers onto one in-flight sync.
   */
  async refreshFromServer(opts: { force?: boolean } = {}): Promise<void> {
    if (this.syncing) return this.syncing;
    if (!opts.force && Date.now() - this.lastSyncAt < 3000) return;
    this.syncing = this.doSync()
      .catch((err) => { console.log("[skills] server sync skipped:", err instanceof Error ? err.message : err); })
      .finally(() => { this.syncing = null; this.lastSyncAt = Date.now(); });
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    const summaries = await serverGetAuthed<ServerSkillSummary[]>("/api/skills/tools");
    const seen = new Set<string>();
    const nextMap = new Map<string, string>();
    const nextSystem = new Set<string>();
    for (const s of summaries) {
      const name = this.sanitizeName(s.name);
      if (!name) continue;
      seen.add(name);
      nextMap.set(name, s.id);
      if (s.isSystem) nextSystem.add(name);
      try { await this.mirrorSkill(s); } catch (err) {
        console.log(`[skills] mirror "${name}" failed:`, err instanceof Error ? err.message : err);
      }
    }
    this.nameToId = nextMap;
    this.systemNames = nextSystem;
    // Deletions on the server propagate: drop local folders no longer present.
    for (const local of this.allSkillNames()) {
      if (!seen.has(local)) this.removeCacheFolder(local);
    }
    this.emitChange();
  }

  /** Mirror one server skill's files into its local cache folder, pruning any
   *  stale local files the server no longer has. */
  private async mirrorSkill(s: ServerSkillSummary): Promise<void> {
    const files = await serverGetAuthed<string[]>(`/api/skills/tools/${s.id}/files`).catch(() => [] as string[]);
    const folder = this.skillFolder(s.name);
    fs.mkdirSync(folder, { recursive: true });
    const wanted = new Set<string>();
    for (const rel of files) {
      const safe = this.safePath(folder, rel);
      if (!safe) continue;
      const encoded = rel.split("/").map(encodeURIComponent).join("/");
      const res = await serverGetAuthed<{ relPath: string; content: string }>(
        `/api/skills/tools/${s.id}/files/${encoded}`,
      ).catch(() => null);
      if (!res) continue;
      fs.mkdirSync(path.dirname(safe), { recursive: true });
      fs.writeFileSync(safe, res.content, "utf-8");
      wanted.add(path.resolve(safe));
    }
    // Prune local files that are no longer part of the server skill.
    for (const rel of this.listSkillFiles(s.name)) {
      const abs = path.resolve(folder, rel);
      if (!wanted.has(abs)) { try { fs.unlinkSync(abs); } catch {} }
    }
  }

  /** Remove a cached skill folder (server-driven prune only — no server call). */
  private removeCacheFolder(name: string): void {
    const folder = this.skillFolder(name);
    const resolved = path.resolve(folder);
    if (!resolved.startsWith(path.resolve(this.skillsDir) + path.sep)) return;
    fs.rmSync(folder, { recursive: true, force: true });
    this.runHistory.delete(name);
  }

  // ── CRUD ─────────────────────────────────────────────

  /** Every skill folder on disk, including hidden system skills. Internal only
   *  (cache pruning) — callers that browse should use listSkills(). */
  private allSkillNames(): string[] {
    if (!fs.existsSync(this.skillsDir)) return [];
    const names: string[] = [];
    for (const entry of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mdPath = path.join(this.skillsDir, entry.name, SKILL_MD);
      if (fs.existsSync(mdPath)) names.push(entry.name);
    }
    return names.sort();
  }

  /** User-visible skills — excludes hidden system skills (skill-builder,
   *  rpa-runner). getSkill()/runSkill() still resolve those by name so the
   *  agent can invoke them; they're just kept out of the browse lists. */
  listSkills(): string[] {
    return this.allSkillNames().filter((n) => !this.systemNames.has(n));
  }

  listSkillsDetailed(): SkillSummary[] {
    return this.listSkills().map((name) => {
      const s = this.getSkill(name);
      const folder = this.skillFolder(name);
      const hasRunner = fs.existsSync(path.join(folder, SKILL_JS));
      const hasApp = fs.existsSync(path.join(folder, "app", "index.html"));
      const jsSchedule = readSkillJsSchedule(path.join(folder, SKILL_JS));
      if (!s) return { name, scheduled: !!jsSchedule, scheduleExpr: jsSchedule ?? undefined, hasRunner, hasApp };
      const expr = jsSchedule || s.manifest.schedule;
      return {
        name,
        description: s.manifest.description,
        scheduled: !!expr,
        scheduleExpr: expr ?? undefined,
        hasRunner,
        hasApp,
        requires: s.manifest.requires,
        allowedTools: s.manifest["allowed-tools"],
      };
    });
  }

  getSkill(name: string): Skill | null {
    const folder = this.skillFolder(name);
    const mdPath = path.join(folder, SKILL_MD);
    if (!fs.existsSync(mdPath)) return null;
    const raw = fs.readFileSync(mdPath, "utf-8");
    const { manifest, body } = this.parseFrontmatter(raw);
    if (!manifest.name) manifest.name = name;
    return {
      name,
      manifest,
      prompt: body,
      folderPath: folder,
    };
  }

  /** Back-compat: returns the prompt body (markdown) of a skill, or null. */
  readSkill(name: string): string | null {
    const s = this.getSkill(name);
    return s ? s.prompt : null;
  }

  writeSkill(name: string, manifest: SkillManifest, prompt: string): boolean {
    name = this.sanitizeName(name);
    if (!name) return false;
    manifest.name = name;
    const folder = this.skillFolder(name);
    fs.mkdirSync(folder, { recursive: true });
    const mdPath = path.join(folder, SKILL_MD);
    const mdContent = this.serializeFrontmatter(manifest, prompt || "");
    fs.writeFileSync(mdPath, mdContent, "utf-8");
    this.emitChange();
    return true;
  }

  /** Legacy: createSkill(name, prompt) — creates with minimal manifest. */
  createSkill(name: string, prompt: string): void {
    this.writeSkill(name, { name, description: "" }, prompt);
  }

  /** Legacy: updateSkill(name, prompt) — updates prompt body only. */
  updateSkill(name: string, prompt: string): boolean {
    const existing = this.getSkill(name);
    if (!existing) return false;
    return this.writeSkill(name, existing.manifest, prompt);
  }

  deleteSkill(name: string): boolean {
    const folder = this.skillFolder(name);
    if (!fs.existsSync(folder)) return false;
    // Safety: verify folder is inside skillsDir
    const resolved = path.resolve(folder);
    if (!resolved.startsWith(path.resolve(this.skillsDir) + path.sep)) return false;
    fs.rmSync(folder, { recursive: true, force: true });
    this.runHistory.delete(name);
    this.emitChange();
    return true;
  }

  // ── File ops within a skill folder ──────────────────

  listSkillFiles(name: string): string[] {
    const folder = this.skillFolder(name);
    if (!fs.existsSync(folder)) return [];
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), relPath);
        } else {
          out.push(relPath);
        }
      }
    };
    walk(folder, "");
    return out.sort();
  }

  readSkillFile(name: string, relPath: string): string | null {
    const folder = this.skillFolder(name);
    const full = this.safePath(folder, relPath);
    if (!full || !fs.existsSync(full)) return null;
    return fs.readFileSync(full, "utf-8");
  }

  writeSkillFile(name: string, relPath: string, content: string): boolean {
    const folder = this.skillFolder(name);
    fs.mkdirSync(folder, { recursive: true });
    const full = this.safePath(folder, relPath);
    if (!full) return false;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    this.emitChange();
    return true;
  }

  deleteSkillFile(name: string, relPath: string): boolean {
    const folder = this.skillFolder(name);
    const full = this.safePath(folder, relPath);
    if (!full || !fs.existsSync(full)) return false;
    // Don't allow deleting SKILL.md (core file)
    if (path.basename(full) === SKILL_MD) return false;
    fs.unlinkSync(full);
    this.emitChange();
    return true;
  }

  // ── Export / Import (.yo bundles) ──────────────────────

  exportSkill(name: string): Buffer | null {
    const folder = this.skillFolder(name);
    if (!fs.existsSync(folder)) return null;
    const zip = new AdmZip();
    zip.addLocalFolder(folder, name);
    // Also bundle any required skills recursively
    const skill = this.getSkill(name);
    const bundled = new Set<string>([name]);
    const bundleReqs = (reqs: string[] | undefined) => {
      if (!reqs) return;
      for (const req of reqs) {
        if (bundled.has(req)) continue;
        const reqFolder = this.skillFolder(req);
        if (!fs.existsSync(reqFolder)) continue;
        zip.addLocalFolder(reqFolder, req);
        bundled.add(req);
        const sub = this.getSkill(req);
        if (sub) bundleReqs(sub.manifest.requires);
      }
    };
    bundleReqs(skill?.manifest.requires);
    return zip.toBuffer();
  }

  importSkill(zipBuffer: Buffer, opts: { overwrite?: boolean } = {}): { imported: string[]; skipped: string[] } {
    const zip = new AdmZip(zipBuffer);
    const imported: string[] = [];
    const skipped: string[] = [];
    // Group entries by top-level folder (skill name)
    const byFolder = new Map<string, AdmZip.IZipEntry[]>();
    for (const entry of zip.getEntries()) {
      const parts = entry.entryName.split("/");
      if (parts.length < 2) continue;
      const skillName = this.sanitizeName(parts[0]);
      if (!skillName) continue;
      const list = byFolder.get(skillName) ?? [];
      list.push(entry);
      byFolder.set(skillName, list);
    }
    for (const [skillName, entries] of byFolder) {
      const targetFolder = this.skillFolder(skillName);
      if (fs.existsSync(targetFolder) && !opts.overwrite) {
        skipped.push(skillName);
        continue;
      }
      fs.mkdirSync(targetFolder, { recursive: true });
      for (const entry of entries) {
        const relPath = entry.entryName.substring(skillName.length + 1);
        if (!relPath) continue;
        const safe = this.safePath(targetFolder, relPath);
        if (!safe) continue;
        if (entry.isDirectory) {
          fs.mkdirSync(safe, { recursive: true });
        } else {
          fs.mkdirSync(path.dirname(safe), { recursive: true });
          fs.writeFileSync(safe, entry.getData());
        }
      }
      imported.push(skillName);
    }
    if (imported.length) this.emitChange();
    return { imported, skipped };
  }

  // ── Run history ─────────────────────────────────────

  appendRun(run: SkillRun): void {
    const list = this.runHistory.get(run.skillName) ?? [];
    list.unshift(run);
    if (list.length > 10) list.length = 10;
    this.runHistory.set(run.skillName, list);
    try { this.onRunCompleteCb?.(run); } catch {}
  }

  getRunHistory(skillName: string): SkillRun[] {
    return this.runHistory.get(skillName) ?? [];
  }

  clearRunHistory(skillName?: string): void {
    if (skillName) this.runHistory.delete(skillName);
    else this.runHistory.clear();
  }

  // ── Top-level dispatch ─────────────────────────────────────────
  //
  // Single entry point used by the scheduler, IPC handlers, and ctx.skill()
  // chain calls (when we add them). If SKILL.js exists → runner; else falls
  // back to prompt-mode (the existing process() path the SDK migration left
  // in place).

  async runSkill(name: string, input: unknown, opts: RunOpts = {}): Promise<unknown> {
    const skill = this.getSkill(name);
    if (!skill) throw new Error(`Skill "${name}" not found`);

    const runId = crypto.randomBytes(6).toString("hex");
    const startedAt = Date.now();

    // SKILL.js path — runner owns the lifecycle, progress, errors
    if (this.hasRunner(name)) {
      const deps: RunnerDeps = {
        mcpManager: this.mcpManager,
        libraryRead: (libName) => this.libraryRead(libName),
        libraryWrite: (libName, content) => this.libraryWrite(libName, content),
        readSkillFile: (sk, rel) => this.readSkillFile(sk, rel),
      };
      const result = await runSkillJs(skill, input, deps, opts);
      this.appendRun(buildRunRecord(name, runId, startedAt, input, result, opts.trigger || "manual"));
      if (result.error) throw new Error(result.error);
      return result.output;
    }

    // SKILL.md prompt-mode (no .js runner) — skills must be deterministic to
    // run. This used to silently fall back to an internal LLM call (first via
    // the interactive agent, then via a plain completion); both are removed —
    // a skill with no deterministic implementation fails clearly instead.
    // (this.process()/callLLM() still exists and is used, deliberately, by
    // generatePrompt() — an AUTHORING-time helper, not a silent execution path.)
    let output: string | undefined;
    let error: string | undefined = `Skill "${name}" has no deterministic implementation (no SKILL.js runner) and cannot be run. Add a runner, or use skill authoring to build one.`;
    this.appendRun({
      id: runId,
      skillName: name,
      trigger: opts.trigger || "manual",
      startedAt,
      durationMs: Date.now() - startedAt,
      input,
      output,
      error,
      events: [],
      logs: [],
    });
    if (error) throw new Error(error);
    return output;
  }

  // ── Skill-library (artifacts shared across skills) ─────────────

  private libraryRead(name: string): string | null {
    const safe = this.safePath(this.libraryDir, name);
    if (!safe || !fs.existsSync(safe)) return null;
    try { return fs.readFileSync(safe, "utf-8"); } catch { return null; }
  }
  private libraryWrite(name: string, content: string): boolean {
    const safe = this.safePath(this.libraryDir, name);
    if (!safe) return false;
    try {
      fs.mkdirSync(path.dirname(safe), { recursive: true });
      fs.writeFileSync(safe, content, "utf-8");
      return true;
    } catch { return false; }
  }

  // ── Prompt-mode processing (fallback for skills without a runner) ──────

  async process(buffer: string, skillName?: string): Promise<string> {
    const skill = skillName ? this.getSkill(skillName) : null;
    const prompt = (skill?.prompt && skill.prompt.trim()) || DEFAULT_SKILL_PROMPT;

    return this.callLLM(prompt, buffer);
  }

  async processWithPrompt(content: string, prompt: string): Promise<string> {
    return this.callLLM(prompt, content);
  }

  async generatePrompt(name: string, description: string): Promise<string> {
    if (!this.llmConfig) return "";
    const system = "You are a skill prompt writer. Given a skill name and description, write a system prompt that an AI assistant should follow when processing content with this skill. Output ONLY the system prompt text, nothing else. Make it clear, specific, and actionable. Include an instruction to output plain text only (no markdown formatting) since output gets pasted into real apps.";
    try {
      const result = await sdkComplete({
        system,
        prompt: `Skill name: ${name}\nDescription: ${description}`,
        model: this.llmConfig.model,
      });
      return result.text;
    } catch { return ""; }
  }

  private async callLLM(systemPrompt: string, content: string): Promise<string> {
    try {
      const result = await sdkComplete({
        system: systemPrompt,
        prompt: `Here is the raw session content to process:\n\n${content}`,
        model: this.llmConfig?.model,
      });
      return result.text || content;
    } catch {
      return `---\nerror: LLM processing failed\ncaptured: ${new Date().toISOString()}\n---\n\n${content}`;
    }
  }

}

// Re-export types for callers
export { Skill, SkillManifest, SkillRun, ProgressEvent } from "./skill-types";
