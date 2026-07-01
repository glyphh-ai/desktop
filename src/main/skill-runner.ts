/**
 * SkillRunner — executes SKILL.js for skills that opt into a deterministic
 * runner above the Claude Agent SDK. SKILL.md (claude's native descriptor)
 * is owned by SkillEngine; this module only fires when SKILL.js is present
 * alongside it.
 *
 * The ctx surface is intentionally narrow — it covers what the SDK doesn't:
 *   • orchestration (step, evaluate, ask, progress)
 *   • deterministic state (state Map, library read/write)
 *   • single-call SDK queries (ctx.claude — one-shot, returns string)
 *   • MCP tool calls by qualified name (ctx.tools.call)
 *   • file access scoped to the skill folder (ctx.file)
 *
 * Tool dispatch is string-based on purpose: ctx.tools.call("gmail.send", {...})
 * — no Proxy magic, types stay reliable, typos surface as runtime errors with
 * a clear message.
 *
 * Lifecycle hooks the runner invokes (all optional, all async-tolerant):
 *   • init(ctx)                 — setup, runs once before start
 *   • start(ctx)                — main entry; return value becomes the run output
 *   • exit(ctx, reason)         — cleanup, always runs (success | error | cancel)
 */

import fs from "fs";
import path from "path";
import vm from "vm";
import crypto from "crypto";

import { sdkComplete } from "./sdk-llm";
import { executeTool as executeAgentTool, listAllTools } from "./substrate/tools";
import type { McpManager } from "./mcp-manager";
import type {
  Skill,
  SkillRun,
  RunOpts,
  ProgressEvent,
  ProgressEventType,
} from "./skill-types";
import { SkillError } from "./skill-types";

// ── Public types ─────────────────────────────────────────

export interface RunnerDeps {
  mcpManager?: McpManager | null;
  libraryRead?: (name: string) => string | null;
  libraryWrite?: (name: string, content: string) => boolean;
  /** Reads a file from inside the skill folder by relative path (engine handles path-safety). */
  readSkillFile?: (skillName: string, relPath: string) => string | null;
}

export interface RunnerResult {
  output: unknown;
  error?: string;
  events: ProgressEvent[];
  logs: string[];
  durationMs: number;
}

// ── Sentinel for ctx.exit ────────────────────────────────

class EarlyExit {
  constructor(public value: unknown) {}
}

// ── Progress emitter ─────────────────────────────────────

function makeId(): string { return crypto.randomBytes(6).toString("hex"); }

interface Emitter {
  emit(e: ProgressEvent): void;
  events(): ProgressEvent[];
}

function makeEmitter(onProgress?: (e: ProgressEvent) => void): Emitter {
  const all: ProgressEvent[] = [];
  return {
    emit(e) { all.push(e); onProgress?.(e); },
    events() { return all; },
  };
}

function startEvent(em: Emitter, type: ProgressEventType, label: string, parentId?: string, metadata?: ProgressEvent["metadata"]): ProgressEvent {
  const ev: ProgressEvent = { id: makeId(), parentId, type, label, status: "running", startedAt: Date.now(), metadata };
  em.emit(ev);
  return ev;
}

function endEvent(em: Emitter, ev: ProgressEvent, status: "success" | "error", error?: string): void {
  ev.status = status;
  ev.endedAt = Date.now();
  if (error) ev.metadata = { ...(ev.metadata || {}), error };
  em.emit(ev);
}

// ── Module loading ───────────────────────────────────────

interface LoadedModule {
  init?: (ctx: unknown) => unknown | Promise<unknown>;
  start?: (ctx: unknown) => unknown | Promise<unknown>;
  exit?: (ctx: unknown, reason: string) => unknown | Promise<unknown>;
  schedule?: string;
}

function loadModule(jsPath: string): LoadedModule {
  const src = fs.readFileSync(jsPath, "utf-8");
  // Minimal ESM → CJS shim so authors can use either style.
  const transformed = src
    .replace(/export\s+async\s+function\s+(\w+)/g, "exports.$1 = async function $1")
    .replace(/export\s+function\s+(\w+)/g, "exports.$1 = function $1")
    .replace(/export\s+default\s+/g, "module.exports = ")
    .replace(/export\s+const\s+(\w+)\s*=/g, "exports.$1 =");

  const moduleObj = { exports: {} as LoadedModule };
  const sandbox: Record<string, unknown> = {
    module: moduleObj,
    exports: moduleObj.exports,
    console: { log: console.log.bind(console), error: console.error.bind(console), warn: console.warn.bind(console) },
    JSON, Math, Date, Object, Array, String, Number, Boolean, Promise, RegExp,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Error, TypeError, RangeError,
  };
  const context = vm.createContext(sandbox);
  new vm.Script(transformed, { filename: jsPath }).runInContext(context, { timeout: 5000 });
  const exported = moduleObj.exports || (sandbox.exports as LoadedModule);
  if (typeof exported === "function") return { start: exported as LoadedModule["start"] };
  return exported;
}

/** Read just the schedule field from SKILL.js without executing it. */
export function readSkillJsSchedule(jsPath: string): string | null {
  if (!fs.existsSync(jsPath)) return null;
  try {
    const mod = loadModule(jsPath);
    return typeof mod.schedule === "string" ? mod.schedule : null;
  } catch {
    return null;
  }
}

// ── Main entrypoint ──────────────────────────────────────

export async function runSkillJs(
  skill: Skill,
  input: unknown,
  deps: RunnerDeps,
  opts: RunOpts = {},
): Promise<RunnerResult> {
  const jsPath = path.join(skill.folderPath, "SKILL.js");
  if (!fs.existsSync(jsPath)) {
    throw new SkillError(`SKILL.js not found for "${skill.name}"`, "NO_RUNNER");
  }

  const em = makeEmitter(opts.onProgress);
  const startedAt = Date.now();
  const logs: string[] = [];
  const allowedTools = new Set(skill.manifest["allowed-tools"] ?? []);
  // Skills inherit EVERY tool the Glyphh agent has — its built-in workspace
  // tools (open_panel, scan_panel, grab_panel, …) need no allowed-tools entry.
  // Only external/connected MCP tools (Gmail, Pipedream apps, …) stay gated.
  const agentTools = new Set(listAllTools());

  const root = startEvent(
    em,
    opts.parentEventId ? "skill" : "step",
    opts.parentEventId ? `skill: ${skill.name}` : skill.name,
    opts.parentEventId,
    { skillName: skill.name },
  );

  let mod: LoadedModule;
  try {
    mod = loadModule(jsPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    endEvent(em, root, "error", `runner load failed: ${msg}`);
    return { output: undefined, error: msg, events: em.events(), logs, durationMs: Date.now() - startedAt };
  }

  // ── ctx ──
  const state = new Map<string, unknown>();
  const history: Array<{ kind: string; key: string; output: unknown; at: number }> = [];

  const ctx: Record<string, unknown> = {
    input,
    state,
    history,
    signal: opts.signal,
    config: skill.manifest,

    log: (...args: unknown[]) => {
      logs.push(args.map(a => typeof a === "string" ? a : safeStringify(a)).join(" "));
    },

    exit: (value: unknown) => { throw new EarlyExit(value); },

    progress: (text: string) => {
      const ev = startEvent(em, "message", text, root.id);
      endEvent(em, ev, "success");
    },

    /** ctx.claude(prompt, { system, model }) → string */
    claude: async (prompt: string, claudeOpts: { system?: string; model?: string } = {}) => {
      const ev = startEvent(em, "agent", `claude: ${claudeOpts.model || "sonnet-4-6"}`, root.id, { model: claudeOpts.model });
      try {
        const r = await sdkComplete({
          system: claudeOpts.system || "",
          prompt,
          model: claudeOpts.model,
        });
        history.push({ kind: "claude", key: prompt.slice(0, 80), output: r.text, at: Date.now() });
        endEvent(em, ev, "success");
        return r.text;
      } catch (err) {
        endEvent(em, ev, "error", err instanceof Error ? err.message : String(err));
        throw err;
      }
    },

    /** ctx.tools.call("gmail.send", { to, subject, body }) — qualified name = "<server>.<tool>". */
    tools: {
      call: async (qualified: string, args: Record<string, unknown> = {}) => {
        // The Glyphh agent's own tools are always available to skills. Accept
        // the bare name ("open_panel"), the dotted "yo.open_panel", or Claude's
        // flattened "mcp__glyphh__open_panel". Route them straight to the agent's
        // tool executor — no allowed-tools entry required.
        const bare = qualified.replace(/^mcp__glyphh__/, "").replace(/^yo\./, "");
        if (agentTools.has(bare)) {
          const ev = startEvent(em, "mcp", `yo: ${bare}`, root.id, { toolName: bare });
          try {
            const result = await executeAgentTool(bare, args);
            history.push({ kind: "tool", key: qualified, output: result, at: Date.now() });
            endEvent(em, ev, "success");
            return result;
          } catch (err) {
            endEvent(em, ev, "error", err instanceof Error ? err.message : String(err));
            throw err;
          }
        }

        // External / connected MCP tools (Gmail, Pipedream apps, …) still
        // require an allowed-tools grant and route through the MCP manager.
        if (!deps.mcpManager) throw new SkillError("MCP manager not wired into runner", "NO_MCP");
        if (allowedTools.size > 0 && !allowedTools.has(qualified)) {
          throw new SkillError(`Tool "${qualified}" not in allowed-tools for skill "${skill.name}"`, "TOOL_NOT_ALLOWED");
        }
        const dot = qualified.indexOf(".");
        if (dot < 1) throw new SkillError(`tools.call needs "<server>.<tool>", got "${qualified}"`, "BAD_TOOL_NAME");
        const serverId = qualified.slice(0, dot);
        const toolName = qualified.slice(dot + 1);
        const ev = startEvent(em, "mcp", `mcp: ${qualified}`, root.id, { toolName: qualified });
        try {
          // 60s ceiling so a hung MCP server can't spin a skill forever.
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new SkillError(`MCP call ${qualified} timed out after 60s`, "MCP_TIMEOUT")), 60_000);
          });
          const result = await Promise.race([
            deps.mcpManager.callToolDirect(serverId, toolName, args),
            timeout,
          ]);
          if (timer) clearTimeout(timer);
          history.push({ kind: "tool", key: qualified, output: result, at: Date.now() });
          endEvent(em, ev, "success");
          return result;
        } catch (err) {
          endEvent(em, ev, "error", err instanceof Error ? err.message : String(err));
          throw err;
        }
      },
    },

    /** ctx.step("label", async () => { ... }) — wraps a section in a progress event. */
    step: async (label: string, fn: () => unknown | Promise<unknown>) => {
      const ev = startEvent(em, "step", label, root.id);
      try {
        const result = await fn();
        endEvent(em, ev, "success");
        return result;
      } catch (err) {
        endEvent(em, ev, "error", err instanceof Error ? err.message : String(err));
        throw err;
      }
    },

    /** ctx.evaluate(value, question) — boolean check. Cheap LLM eval; returns { ok, reason? }. */
    evaluate: async (value: unknown, question: string) => {
      const ev = startEvent(em, "evaluate", `evaluate: ${question.slice(0, 60)}`, root.id);
      try {
        const prompt = `Answer with strict JSON only. Schema: {"ok": boolean, "reason": string}.\n\nQuestion: ${question}\n\nValue:\n${safeStringify(value)}`;
        const r = await sdkComplete({ system: "You evaluate values against a question and emit strict JSON. No prose.", prompt });
        const parsed = parseJsonLoose(r.text);
        const result = parsed && typeof parsed === "object" && "ok" in parsed
          ? { ok: !!(parsed as any).ok, reason: (parsed as any).reason as string | undefined }
          : { ok: false, reason: `unparsable: ${r.text.slice(0, 200)}` };
        endEvent(em, ev, "success");
        return result;
      } catch (err) {
        endEvent(em, ev, "error", err instanceof Error ? err.message : String(err));
        throw err;
      }
    },

    /** ctx.ask("...") — pause and ask the user via the host UI. */
    ask: async (question: string) => {
      if (!opts.onAskUser) throw new SkillError("ctx.ask has no UI to delegate to", "NO_UI");
      const ev = startEvent(em, "ask-user", `ask user: ${question.slice(0, 60)}`, root.id);
      try {
        const answer = await opts.onAskUser(question);
        endEvent(em, ev, "success");
        return answer;
      } catch (err) {
        endEvent(em, ev, "error", err instanceof Error ? err.message : String(err));
        throw err;
      }
    },

    /** Read a file from inside the skill folder. */
    file: (relPath: string) => deps.readSkillFile?.(skill.name, relPath) ?? null,

    /** Shared library: read/write artifacts that outlive a single run. */
    library: {
      read: (name: string) => deps.libraryRead?.(name) ?? null,
      write: (name: string, content: string) => deps.libraryWrite?.(name, content) ?? false,
    },
  };

  // ── Lifecycle ──
  let output: unknown = undefined;
  let errorMsg: string | undefined;
  let reason: "success" | "error" | "cancel" = "success";

  try {
    if (mod.init) await mod.init(ctx);
    if (opts.signal?.aborted) throw new SkillError("Aborted", "ABORTED");
    if (mod.start) {
      try {
        const r = await mod.start(ctx);
        if (r !== undefined) output = r;
      } catch (err) {
        if (err instanceof EarlyExit) {
          state.set("result", err.value);
          output = err.value;
        } else {
          throw err;
        }
      }
    }
    if (output === undefined) output = state.get("result");
    endEvent(em, root, "success");
  } catch (err) {
    reason = opts.signal?.aborted ? "cancel" : "error";
    errorMsg = err instanceof Error ? err.message : String(err);
    endEvent(em, root, "error", errorMsg);
  } finally {
    if (mod.exit) {
      try { await mod.exit(ctx, reason); }
      catch (e) { logs.push(`exit hook threw: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  return { output, error: errorMsg, events: em.events(), logs, durationMs: Date.now() - startedAt };
}

// ── Helpers ──────────────────────────────────────────────

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); }
  catch { return String(v); }
}

function parseJsonLoose(text: string): unknown {
  // Try direct, then look for the first {...} block.
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* */ } }
  return null;
}

/** Convenience builder for SkillRun records (engine appends to history). */
export function buildRunRecord(skillName: string, runId: string, startedAt: number, input: unknown, result: RunnerResult, trigger: SkillRun["trigger"]): SkillRun {
  return {
    id: runId,
    skillName,
    trigger,
    startedAt,
    durationMs: result.durationMs,
    input,
    output: result.output,
    error: result.error,
    events: result.events,
    logs: result.logs,
  };
}
