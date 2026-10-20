/**
 * runtime/runner.ts — the ONE engine that executes loops and skills. Node-only
 * (`node:vm`), imported by the desktop's main process and the CLI, never a browser
 * bundle.
 *
 * A program is a mostly-deterministic state machine that decides when to read and
 * write memory, which skills to call in what order, and where an agent turn
 * belongs. It exports lifecycle functions and talks to the outside world ONLY
 * through `ctx`:
 *
 *   init(ctx)          optional setup, before start
 *   start(ctx)         the entry; its return value is the run's output
 *   exit(ctx, reason)  optional cleanup, always runs (success | error | cancel)
 *
 * TRUST MODEL. Programs are authored by the user or shared by their org_admin, so
 * the code is trusted; `node:vm` is a scoping boundary, not a security sandbox, and
 * nothing here would stop determined native escape. What IS enforced is the
 * CAPABILITY declaration: the manifest says which skills, connections, tools, apps,
 * and memory a program may reach, and every ctx surface checks it. That makes the
 * manifest load-bearing rather than decorative — a program cannot quietly grow new
 * reach, and a reviewer can read what it touches without reading its code.
 *
 * Model turns go out through `client.gateway` like every other model call — there
 * is no local inference and no second egress.
 */

import { createContext, Script } from "node:vm";
import type { Client } from "../client.js";
import type { GuardrailsPolicy } from "../contract/agents.js";

// ── progress ─────────────────────────────────────────────────────────────────

export type ProgressType = "step" | "agent" | "skill" | "tool" | "memory" | "app" | "ask" | "message" | "browser";
export type ProgressStatus = "running" | "success" | "error";

export interface ProgressEvent {
  id: string;
  parentId?: string | undefined;
  type: ProgressType;
  label: string;
  status: ProgressStatus;
  startedAt: number;
  endedAt?: number | undefined;
  error?: string | undefined;
}

// ── capabilities ─────────────────────────────────────────────────────────────

/**
 * What a program may touch, normalized from a loop or skill manifest (and, for an
 * agent, narrowed further by its selections). An ABSENT list means "none declared",
 * which denies — a program reaches only what it asked for.
 */
export interface ProgramCapabilities {
  /** Role name → catalog model id. `ctx.agent("planner", …)` resolves through this. */
  roles?: Record<string, string> | undefined;
  /** Skill slugs `ctx.skill()` may call. */
  skills?: string[] | undefined;
  /** Connection slugs `ctx.tools.call()` may reach. */
  connections?: string[] | undefined;
  /** Qualified tool names (`gmail.send`). When set, narrows within `connections`. */
  allowedTools?: string[] | undefined;
  /** App slugs `ctx.app()` may drive. */
  apps?: string[] | undefined;
  memory?: { read?: boolean | undefined; write?: boolean | undefined } | undefined;
  /** "rover": every agent()/turn() call hops to the NEXT bound model — never
   *  the same model twice in a row. The pool is the distinct role bindings. */
  rotation?: "rover" | undefined;
  /** Headless browser automation (`ctx.browser()`). The host provides it — the
   *  desktop drives off-screen pages; an unattended CLI daemon does too; a
   *  cloud runner has none. */
  browser?: boolean | undefined;
}

// ── host ─────────────────────────────────────────────────────────────────────

/**
 * The capabilities only a HOST can provide. The engine owns models, skills, and
 * connections (all SDK-native); memory, apps, and asking a human belong to whoever
 * is running — the desktop has all three, a headless CLI has none.
 */
export interface RunnerHost {
  memory?: {
    read(query: string): Promise<unknown>;
    write(fact: string): Promise<void>;
  };
  /** Drive an installed app: `appCommand("gmail", "compose", {...})`. */
  appCommand?(app: string, command: string, args: Record<string, unknown>): Promise<unknown>;
  /** Pause for a human. Absent = unattended, and `ctx.ask` throws. */
  ask?(question: string): Promise<string>;
  /** Headless browser automation: open a page, act on it (goto/click/type/
   *  read/screenshot), close it. Page ids are opaque handles the host owns. */
  browser?: {
    open(url?: string): Promise<{ pageId: string }>;
    act(pageId: string, action: string, params: Record<string, unknown>): Promise<unknown>;
    close(pageId: string): Promise<void>;
  };
  onProgress?(event: ProgressEvent): void;
}

// ── run ──────────────────────────────────────────────────────────────────────

export interface ProgramSource {
  /** For error messages and the vm filename. */
  slug: string;
  code: string;
}

export interface RunProgramOptions {
  program: ProgramSource;
  capabilities: ProgramCapabilities;
  /** Arguments the program reads as `ctx.input`. */
  input?: Record<string, unknown> | undefined;
  /** The RESOLVED policy (org ceiling ∧ agent). Enforced per call and per run. */
  guardrails?: GuardrailsPolicy | null | undefined;
  signal?: AbortSignal | undefined;
  /** Recursion depth for nested `ctx.skill()` calls. Internal. */
  depth?: number | undefined;
}

export interface RunUsage {
  /** Model calls made by this run (including nested skills). */
  calls: number;
  /** Output tokens billed, as reported by the gateway. */
  outputTokens: number;
}

export interface RunResult {
  output: unknown;
  error?: string | undefined;
  events: ProgressEvent[];
  logs: string[];
  durationMs: number;
  usage: RunUsage;
}

/** How deep `ctx.skill()` may nest before we call it a loop. */
const MAX_DEPTH = 5;
/** Wall-clock cap on the module's top-level evaluation (not its async work). */
const LOAD_TIMEOUT_MS = 5_000;

/** Thrown by `ctx.exit(value)` to unwind without treating it as a failure. */
class EarlyExit {
  constructor(readonly value: unknown) {}
}

/** A capability denial. Distinct from a program's own errors. */
export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

interface LoadedProgram {
  init?: ((ctx: unknown) => unknown | Promise<unknown>) | undefined;
  start?: ((ctx: unknown) => unknown | Promise<unknown>) | undefined;
  exit?: ((ctx: unknown, reason: string) => unknown | Promise<unknown>) | undefined;
}

/**
 * Evaluate a program's source and hand back its lifecycle exports.
 *
 * Authors write either ESM or CJS; a regex shim rewrites the common ESM export
 * forms rather than pulling in a parser. It handles `export [async] function`,
 * `export const`, and `export default` — the shapes a loop or skill actually uses.
 * Anything more exotic (re-exports, destructured exports) should be written CJS.
 */
function loadProgram(source: ProgramSource): LoadedProgram {
  const transformed = source.code
    .replace(/export\s+async\s+function\s+(\w+)/g, "exports.$1 = async function $1")
    .replace(/export\s+function\s+(\w+)/g, "exports.$1 = function $1")
    .replace(/export\s+default\s+/g, "module.exports = ")
    .replace(/export\s+const\s+(\w+)\s*=/g, "exports.$1 =");

  const moduleObj = { exports: {} as LoadedProgram };
  // Deliberately narrow globals: no require, no process, no fs, no fetch. Every
  // outside effect goes through ctx, which is where the capability checks live.
  const sandbox: Record<string, unknown> = {
    module: moduleObj,
    exports: moduleObj.exports,
    JSON, Math, Date, Object, Array, String, Number, Boolean, Promise, RegExp, Map, Set,
    Error, TypeError, RangeError,
    setTimeout, clearTimeout,
  };
  const context = createContext(sandbox);
  try {
    new Script(transformed, { filename: `${source.slug}.js` }).runInContext(context, { timeout: LOAD_TIMEOUT_MS });
  } catch (err) {
    throw new Error(`${source.slug}: program failed to load — ${err instanceof Error ? err.message : String(err)}`);
  }
  const exported = moduleObj.exports || (sandbox.exports as LoadedProgram);
  // A bare default export is treated as `start`, so the smallest useful program is
  // one function.
  if (typeof exported === "function") return { start: exported as LoadedProgram["start"] };
  return exported;
}

/** Strip a catalog id's `provider::` prefix — the gateway takes the bare id. */
function bareModel(id: string): string {
  const i = id.indexOf("::");
  return i === -1 ? id : id.slice(i + 2);
}

let seq = 0;
const nextId = () => `e${(seq++).toString(36)}`;

/**
 * Run one loop or skill program to completion.
 *
 * Resolves to a RunResult in both directions: a program that throws produces
 * `error` rather than rejecting, so a caller firing scheduled work never has to
 * wrap every call — the run is data, not an exception.
 */
export async function runProgram(
  client: Client,
  opts: RunProgramOptions,
  host: RunnerHost = {},
): Promise<RunResult> {
  const startedAt = Date.now();
  const events: ProgressEvent[] = [];
  const logs: string[] = [];
  const usage: RunUsage = { calls: 0, outputTokens: 0 };
  const depth = opts.depth ?? 0;
  const caps = opts.capabilities;
  const rails = opts.guardrails ?? null;

  function emit(type: ProgressType, label: string, parentId?: string): ProgressEvent {
    const event: ProgressEvent = { id: nextId(), parentId, type, label, status: "running", startedAt: Date.now() };
    events.push(event);
    try { host.onProgress?.(event); } catch { /* a listener must not break the run */ }
    return event;
  }
  function settle(event: ProgressEvent, error?: string): void {
    event.status = error ? "error" : "success";
    event.endedAt = Date.now();
    if (error) event.error = error;
    try { host.onProgress?.(event); } catch { /* as above */ }
  }

  function assertLive(): void {
    if (opts.signal?.aborted) throw new Error("cancelled");
  }

  /** Guardrails are upper bounds; the run stops rather than silently truncating. */
  function assertWithinBudget(): void {
    if (rails?.windowCalls !== undefined && usage.calls >= rails.windowCalls) {
      throw new CapabilityError(`guardrail: this run may make at most ${rails.windowCalls} model calls`);
    }
    if (rails?.windowTokens !== undefined && usage.outputTokens >= rails.windowTokens) {
      throw new CapabilityError(`guardrail: this run may produce at most ${rails.windowTokens} output tokens`);
    }
  }

  // ── ctx ────────────────────────────────────────────────────────────────────

  const state: Record<string, unknown> = {};
  let currentParent: string | undefined;

  // ── Rover rotation ────────────────────────────────────────────────────────
  // A rover loop hops models on EVERY model call: round-robin over the
  // distinct bound models, so the same model never answers twice in a row
  // (pool > 1). Memory/hot-prompt reassembles full context per call, which is
  // what makes the hop free.
  const roverPool = caps.rotation === "rover"
    ? Array.from(new Set(Object.values(caps.roles ?? {}).filter((m): m is string => !!m)))
    : null;
  let roverIdx = -1;
  function boundModel(role: string): string | undefined {
    if (roverPool && roverPool.length > 0) {
      roverIdx = (roverIdx + 1) % roverPool.length;
      return roverPool[roverIdx];
    }
    return caps.roles?.[role];
  }

  // The catalog answers what a role's model can hold; cached per run because a
  // loop asks repeatedly while deciding what to send.
  let availableCache: Awaited<ReturnType<Client["models"]["available"]>> | null = null;
  async function modelInfo(role: string) {
    const modelId = caps.roles?.[role];
    if (!modelId) return null;
    try {
      availableCache ??= await client.models.available();
    } catch {
      return null; // offline: the loop falls back to its own defaults
    }
    const bare = (id: string) => (id.includes("::") ? id.slice(id.indexOf("::") + 2) : id).toLowerCase();
    const hit = availableCache.find((m) => bare(m.id) === bare(modelId));
    return hit
      ? {
          id: hit.id,
          name: hit.name,
          contextWindow: hit.contextWindow,
          maxOutputTokens: hit.maxOutputTokens,
        }
      : null;
  }

  async function agent(role: string, prompt: string, o: { system?: string; maxTokens?: number } = {}): Promise<string> {
    assertLive();
    assertWithinBudget();
    const modelId = boundModel(role);
    if (!modelId) {
      const offered = Object.keys(caps.roles ?? {});
      throw new CapabilityError(
        `no model bound to role "${role}"${offered.length ? ` — this program declares: ${offered.join(", ")}` : ""}`,
      );
    }
    // The agent may ask for fewer tokens than the guardrail, never more.
    const cap = rails?.maxOutputTokens;
    const asked = o.maxTokens;
    const maxTokens = cap !== undefined && asked !== undefined ? Math.min(cap, asked) : (cap ?? asked);

    const event = emit("agent", `${role} → ${bareModel(modelId)}`, currentParent);
    try {
      const completion = await client.gateway.complete({
        model: modelId,
        messages: [
          ...(o.system ? [{ role: "system", content: o.system }] : []),
          { role: "user", content: prompt },
        ],
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });
      usage.calls += 1;
      usage.outputTokens += completion.usage?.completion_tokens ?? 0;
      settle(event);
      return completion.choices?.[0]?.message?.content ?? "";
    } catch (err) {
      settle(event, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * One TOOL-CAPABLE turn on a declared role — the primitive an agent loop is
   * built from.
   *
   * `agent()` returns a string and cannot carry a model's decision to call
   * something; this returns the whole turn, so the loop owns the iteration:
   * call, run the tools it asked for, append the results, call again. That is
   * what keeps a loop a state machine the author controls rather than an opaque
   * autonomous run.
   *
   * Tools are filtered to what the manifest declared, so a program cannot widen
   * its reach by handing the model a tool it never asked for.
   */
  async function turn(
    role: string,
    input: { messages: Array<{ role: string; content: unknown }>; system?: string; tools?: Array<{ name: string; description?: string; input_schema?: unknown }>; maxTokens?: number },
  ) {
    assertLive();
    assertWithinBudget();
    const modelId = boundModel(role);
    if (!modelId) {
      const offered = Object.keys(caps.roles ?? {});
      throw new CapabilityError(
        `no model bound to role "${role}"${offered.length ? ` — this program declares: ${offered.join(", ")}` : ""}`,
      );
    }
    const cap = rails?.maxOutputTokens;
    const asked = input.maxTokens;
    const maxTokens = cap !== undefined && asked !== undefined ? Math.min(cap, asked) : (cap ?? asked);

    // A tool the manifest never declared is dropped rather than offered: the model
    // cannot ask for what this program may not run.
    const allowed = (input.tools ?? []).filter((tool) => {
      const qualified = tool.name.includes(".") ? tool.name : null;
      if (!qualified) return true; // a local/loop-defined tool, gated when called
      const slug = qualified.slice(0, qualified.indexOf("."));
      if (!caps.connections?.includes(slug)) return false;
      return !caps.allowedTools || caps.allowedTools.includes(qualified);
    });

    const event = emit("agent", `${role} → ${bareModel(modelId)}`, currentParent);
    try {
      const result = await client.gateway.turn({
        model: modelId,
        messages: input.messages,
        ...(input.system ? { system: input.system } : {}),
        ...(allowed.length ? { tools: allowed } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });
      usage.calls += 1;
      usage.outputTokens += result.usage.outputTokens;
      settle(event);
      return result;
    } catch (err) {
      settle(event, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function callSkill(slug: string, args: Record<string, unknown> = {}): Promise<unknown> {
    assertLive();
    if (!caps.skills?.includes(slug)) {
      throw new CapabilityError(`this program does not declare the "${slug}" skill`);
    }
    if (depth >= MAX_DEPTH) {
      throw new CapabilityError(`skill nesting too deep (${MAX_DEPTH}) — "${slug}" was not run`);
    }
    const event = emit("skill", slug, currentParent);
    try {
      const skill = await client.skills.get(slug);
      // A prompt-only skill has no program: its prompt IS the work, so it runs as
      // one agent turn on the calling program's default role.
      if (!skill.code.trim()) {
        const role = Object.keys(caps.roles ?? {})[0];
        if (!role) throw new CapabilityError(`"${slug}" is prompt-only and this program binds no model role`);
        const out = await agent(role, `${skill.prompt}\n\nInput: ${JSON.stringify(args)}`);
        settle(event);
        return out;
      }
      const nested = await runProgram(
        client,
        {
          program: { slug: skill.slug, code: skill.code },
          // A nested skill inherits the caller's reach, narrowed by its own manifest:
          // it can never widen what the caller was allowed.
          capabilities: {
            roles: caps.roles,
            skills: (skill.manifest.requires ?? []).filter((s) => caps.skills?.includes(s)),
            connections: (skill.manifest.requires ?? []).filter((c) => caps.connections?.includes(c)),
            allowedTools: skill.manifest.allowedTools?.filter((t) => !caps.allowedTools || caps.allowedTools.includes(t)),
            apps: caps.apps,
            memory: caps.memory,
          },
          input: args,
          guardrails: rails,
          signal: opts.signal,
          depth: depth + 1,
        },
        host,
      );
      usage.calls += nested.usage.calls;
      usage.outputTokens += nested.usage.outputTokens;
      events.push(...nested.events);
      logs.push(...nested.logs);
      if (nested.error) throw new Error(nested.error);
      settle(event);
      return nested.output;
    } catch (err) {
      settle(event, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function callTool(qualified: string, args: Record<string, unknown> = {}): Promise<unknown> {
    assertLive();
    const dot = qualified.indexOf(".");
    if (dot <= 0) throw new CapabilityError(`tool must be qualified as "<connection>.<tool>" — got "${qualified}"`);
    const slug = qualified.slice(0, dot);
    const tool = qualified.slice(dot + 1);
    if (!caps.connections?.includes(slug)) {
      throw new CapabilityError(`this program does not declare the "${slug}" connection`);
    }
    if (caps.allowedTools && !caps.allowedTools.includes(qualified)) {
      throw new CapabilityError(`this program does not allow the tool "${qualified}"`);
    }
    const event = emit("tool", qualified, currentParent);
    try {
      const { result } = await client.connections.runTool({ slug, tool, props: args });
      settle(event);
      return result.ret;
    } catch (err) {
      settle(event, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  const ctx = {
    /** The arguments this run was given. */
    input: opts.input ?? {},
    /** Scratch state for the state machine. Plain object; lives for one run. */
    state,
    /** Model turn on a declared role — text in, text out. */
    agent,

    /** A tool-capable turn: the primitive an agent loop drives its own iteration
     *  with. Returns `{ text, toolUses, stopReason, usage, content }`. */
    turn,

    /**
     * What a role's model can hold — `{ id, name, contextWindow, maxOutputTokens }`,
     * or null when the role is unbound or the catalog has not recorded limits.
     *
     * This is how a loop adapts instead of failing: an agent framework's opening
     * system prompt alone can fill a small model, so a program that wants to run on
     * both introduces fewer tools, or defers them to later steps, when the window is
     * small. A null answer means "unknown" — carry on with your own defaults rather
     * than assuming the worst.
     */
    model: modelInfo,
    /** Call a declared skill. */
    skill: callSkill,
    tools: { call: callTool },

    memory: {
      async read(query: string): Promise<unknown> {
        assertLive();
        if (!caps.memory?.read) throw new CapabilityError("this program does not declare memory read access");
        if (!host.memory) throw new CapabilityError("memory is not available in this host");
        const event = emit("memory", `read: ${query}`, currentParent);
        try { const out = await host.memory.read(query); settle(event); return out; }
        catch (err) { settle(event, err instanceof Error ? err.message : String(err)); throw err; }
      },
      async write(fact: string): Promise<void> {
        assertLive();
        if (!caps.memory?.write) throw new CapabilityError("this program does not declare memory write access");
        if (!host.memory) throw new CapabilityError("memory is not available in this host");
        const event = emit("memory", `write: ${fact.slice(0, 60)}`, currentParent);
        try { await host.memory.write(fact); settle(event); }
        catch (err) { settle(event, err instanceof Error ? err.message : String(err)); throw err; }
      },
    },

    /** Drive a declared app: `ctx.app("gmail").run("compose", {...})`. */
    app(slug: string) {
      if (!caps.apps?.includes(slug)) throw new CapabilityError(`this program does not declare the "${slug}" app`);
      return {
        async run(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
          assertLive();
          if (!host.appCommand) throw new CapabilityError("apps are not available in this host");
          const event = emit("app", `${slug}.${command}`, currentParent);
          try { const out = await host.appCommand(slug, command, args); settle(event); return out; }
          catch (err) { settle(event, err instanceof Error ? err.message : String(err)); throw err; }
        },
      };
    },

    /** Open a headless browser page and drive it: `const p = await ctx.browser("https://…");
     *  await p.click("#login"); const text = await p.read(".dashboard"); await p.close();` */
    async browser(url?: string) {
      assertLive();
      if (!caps.browser) throw new CapabilityError("this program does not declare browser access");
      if (!host.browser) throw new CapabilityError("headless browser is not available in this host");
      const open = emit("browser", `open ${url ?? "blank"}`, currentParent);
      let pageId: string;
      try { ({ pageId } = await host.browser.open(url)); settle(open); }
      catch (err) { settle(open, err instanceof Error ? err.message : String(err)); throw err; }
      const act = async (action: string, params: Record<string, unknown> = {}): Promise<unknown> => {
        assertLive();
        const event = emit("browser", `${action} ${String(params.selector ?? params.url ?? "")}`.trim(), currentParent);
        try { const out = await host.browser!.act(pageId, action, params); settle(event); return out; }
        catch (err) { settle(event, err instanceof Error ? err.message : String(err)); throw err; }
      };
      return {
        goto: (u: string) => act("goto", { url: u }),
        click: (selector: string) => act("click", { selector }),
        type: (selector: string, text: string, opts?: { submit?: boolean }) => act("type", { selector, text, submit: opts?.submit === true }),
        read: (selector?: string, as?: "text" | "html") => act("read", { selector, as: as ?? "text" }),
        screenshot: () => act("screenshot", {}),
        close: async () => { assertLive(); try { await host.browser!.close(pageId); } catch { /* already gone */ } },
      };
    },

    /** Pause for a human. Throws when the host is unattended. */
    async ask(question: string): Promise<string> {
      assertLive();
      if (!host.ask) throw new CapabilityError("this run is unattended — ctx.ask is unavailable");
      const event = emit("ask", question, currentParent);
      try { const answer = await host.ask(question); settle(event); return answer; }
      catch (err) { settle(event, err instanceof Error ? err.message : String(err)); throw err; }
    },

    /** Group work under a labelled step — the unit progress is reported in. */
    async step<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
      assertLive();
      const event = emit("step", label, currentParent);
      const parent = currentParent;
      currentParent = event.id;
      try {
        const out = await fn();
        settle(event);
        return out;
      } catch (err) {
        settle(event, err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        currentParent = parent;
      }
    },

    progress(text: string): void {
      const event = emit("message", text, currentParent);
      settle(event);
    },

    log(...parts: unknown[]): void {
      logs.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
    },

    /** Finish early with a value — not an error. */
    exit(value?: unknown): never {
      throw new EarlyExit(value);
    },
  };

  // ── lifecycle ──────────────────────────────────────────────────────────────

  let output: unknown;
  let error: string | undefined;
  let reason: "success" | "error" | "cancel" = "success";
  let program: LoadedProgram;

  try {
    program = loadProgram(opts.program);
  } catch (err) {
    return {
      output: undefined,
      error: err instanceof Error ? err.message : String(err),
      events, logs, usage,
      durationMs: Date.now() - startedAt,
    };
  }

  if (typeof program.start !== "function") {
    return {
      output: undefined,
      error: `${opts.program.slug}: no start(ctx) export — a program must export start`,
      events, logs, usage,
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    if (typeof program.init === "function") await program.init(ctx);
    output = await program.start(ctx);
  } catch (err) {
    if (err instanceof EarlyExit) {
      output = err.value;
    } else {
      reason = opts.signal?.aborted ? "cancel" : "error";
      error = err instanceof Error ? err.message : String(err);
    }
  }

  // exit() always runs, and its own failure never masks the real outcome.
  if (typeof program.exit === "function") {
    try {
      await program.exit(ctx, reason);
    } catch (err) {
      logs.push(`exit() failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { output, error, events, logs, usage, durationMs: Date.now() - startedAt };
}
