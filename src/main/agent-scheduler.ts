/**
 * agent-scheduler.ts — the piece that makes live agents REAL.
 *
 * Until now an agent's tasks were stored, armed server-side (/api/agents/live),
 * and executed by nothing: "first digest lands tomorrow at 8 AM" was a promise
 * with no machinery behind it. This is the machinery.
 *
 * A 30-second tick checks every LIVE agent's enabled tasks against a minimal
 * five-field cron matcher; a task whose expression matches the current minute
 * fires once (a fired-minute guard makes ticks idempotent). Bindings execute
 * through the SDK:
 *
 *   skill (code)   → runProgram in the SDK sandbox, capabilities from the
 *                    skill's manifest ∩ the agent's selections
 *   skill (prompt) → one tool-less gateway turn: the prompt is the system,
 *                    the task args are the ask
 *   loop           → runProgram on the loop's program + manifest
 *   app_command    → the installed app's headless tool surface
 *
 * Every firing reports back (agents.reportTaskRun) so lastRunAt/lastStatus/
 * lastError on the task tell the truth in the UI. Runs are UNATTENDED: no
 * `ask` host, so a program that pauses for a human fails fast with a clear
 * error instead of hanging a headless run.
 *
 * Scope (deliberate): runs while the desktop is open. The run-when-closed
 * daemon is the separate unattended-run setting still to come.
 */

import { getClient } from "./glyphh-client";
import { runProgram, type ProgramCapabilities, type RunResult } from "@glyphh/sdk/runtime";
import { createBrowserHost } from "./glyphh-browser-host";
import type { Agent, AgentTask, GuardrailsPolicy } from "@glyphh/sdk";
import { callAppTool } from "./glyphh-app-host";
import { connectorWireTools, resolveWireTool } from "./glyphh-agent-tools";

const TICK_MS = 30_000;
const LIVE_REFRESH_MS = 5 * 60_000;

interface LiveAgent extends Agent {
  tasks: AgentTask[];
}

let timer: NodeJS.Timeout | null = null;
let liveCache: LiveAgent[] = [];
let liveFetchedAt = 0;
/** Task id → the minute (epoch-minutes) it last fired: the idempotency guard. */
const firedAt = new Map<string, number>();
/** Task id → run start (ms). A slow run must not overlap itself, and the
 *  UI's run feed shows an in-flight row while one is going. */
const inFlight = new Map<string, number>();

// ── Cron (five fields: minute hour dom month dow) ───────────────────────────

/** Does one cron field match a value? Supports star, N, N-M, step (slash), commas. */
function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    const [range, step] = part.split("/");
    const stepN = step ? parseInt(step, 10) : 1;
    if (!stepN || stepN < 1) return false;
    if (range === "*" || range === "") return value % stepN === 0;
    if (range!.includes("-")) {
      const [lo, hi] = range!.split("-").map((n) => parseInt(n, 10));
      return value >= lo! && value <= hi! && (value - lo!) % stepN === 0;
    }
    const n = parseInt(range!, 10);
    return Number.isFinite(n) && value === n;
  });
}

/** Whether a five-field cron matches this moment (local time, like crontab). */
export function cronMatches(expr: string, at: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [min, hour, dom, month, dow] = fields;
  return (
    fieldMatches(min!, at.getMinutes()) &&
    fieldMatches(hour!, at.getHours()) &&
    fieldMatches(dom!, at.getDate()) &&
    fieldMatches(month!, at.getMonth() + 1) &&
    fieldMatches(dow!, at.getDay())
  );
}

// ── Bindings ────────────────────────────────────────────────────────────────

/** The model a headless turn runs on: the agent's loop resolution. */
async function agentModel(agent: Agent): Promise<string | null> {
  try {
    const roles = await getClient().loops.roles(agent.loopId ?? "default", agent.selections.roles ?? {});
    return roles[0]?.modelId ?? null;
  } catch {
    return null;
  }
}

/**
 * Run a loop/skill program with a per-run headless browser host, so program
 * code can use `ctx.browser()`. The `browser` capability is granted for the
 * user's OWN programs by default (governance: same as connections); pages are
 * torn down when the run ends, even on error. Everything else in `opts` passes
 * through unchanged.
 */
async function runProgramWithBrowser(
  client: ReturnType<typeof getClient>,
  opts: Parameters<typeof runProgram>[1],
): Promise<RunResult> {
  const { host, closeAll } = createBrowserHost();
  const capabilities: ProgramCapabilities = { ...opts.capabilities, browser: true };
  try {
    return await runProgram(client, { ...opts, capabilities }, { browser: host });
  } finally {
    closeAll();
  }
}

async function runSkillTask(agent: Agent, task: AgentTask): Promise<string> {
  const client = getClient();
  const skill = await client.skills.get(task.target);
  const guardrails: GuardrailsPolicy | null = agent.guardrailsEffective;

  if (skill.code.trim()) {
    const result = await runProgramWithBrowser(client, {
      program: { slug: skill.slug, code: skill.code },
      capabilities: {
        roles: agent.selections.roles ?? {},
        skills: agent.selections.skills ?? [],
        connections: skill.manifest.requires ?? [],
        ...(skill.manifest.allowedTools?.length ? { allowedTools: skill.manifest.allowedTools } : {}),
      },
      input: task.args,
      guardrails,
    });
    if (result.error) throw new Error(result.error);
    return typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? "");
  }

  // Prompt-only skill: the prompt IS the program. A skill that declares
  // connections gets a REAL bounded tool loop — one tool-less turn cannot
  // read a mailbox, and the first digest run proved it: the model could only
  // NARRATE the gmail call it wanted to make.
  const model = skill.manifest.model ?? (await agentModel(agent));
  if (!model) throw new Error("no model available for this agent");
  const maxTokens = Math.min(guardrails?.maxOutputTokens ?? 8192, 8192);

  const requires = skill.manifest.requires ?? [];
  const allowed = skill.manifest.allowedTools ?? [];
  const wire = requires.length ? await connectorWireTools().catch(() => []) : [];
  const tools = wire
    .map((d) => ({ def: d, target: resolveWireTool(d.name) }))
    .filter((x): x is { def: typeof wire[number]; target: { slug: string; tool: string } } =>
      !!x.target && requires.includes(x.target.slug)
      // allowedTools may hold either form: qualified ("gmail.Find Emails")
      // or the wire name the agent authored ("gmail-find-email").
      && (!allowed.length || allowed.includes(`${x.target.slug}.${x.target.tool}`) || allowed.includes(x.def.name)))
    .map((x) => ({ name: x.def.name, description: x.def.description, input_schema: x.def.inputSchema }));

  let messages: Array<{ role: string; content: unknown }> = [{
    role: "user",
    content: Object.keys(task.args).length
      ? `Run this now. Arguments:\n${JSON.stringify(task.args, null, 2)}`
      : "Run this now.",
  }];

  for (let round = 0; round < 12; round++) {
    const turn = await client.gateway.turn({
      model, system: skill.prompt, maxTokens, messages,
      ...(tools.length ? { tools } : {}),
    });
    if (!turn.toolUses.length) return turn.text;

    messages = messages.concat([{ role: "assistant", content: turn.content }]);
    const results: Array<Record<string, unknown>> = [];
    for (const call of turn.toolUses) {
      const target = resolveWireTool(call.name);
      let content: string;
      try {
        if (!target) throw new Error(`unknown tool "${call.name}"`);
        const { result } = await client.connections.runTool({ slug: target.slug, tool: target.tool, props: call.input });
        content = typeof result.ret === "string" ? result.ret : JSON.stringify(result.ret ?? "");
      } catch (err) {
        // A failed tool is information the model can act on, not a crash.
        content = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: content.slice(0, 24_000) });
    }
    messages = messages.concat([{ role: "user", content: results }]);
  }
  throw new Error("stopped after 12 tool rounds without finishing");
}

async function runLoopTask(agent: Agent, task: AgentTask): Promise<string> {
  const client = getClient();
  const loop = await client.loops.get(task.target);
  const result = await runProgramWithBrowser(client, {
    program: { slug: loop.slug, code: loop.code },
    capabilities: {
      roles: agent.selections.roles ?? {},
      skills: loop.manifest.skills ?? [],
      connections: loop.manifest.connections ?? [],
      ...(loop.manifest.memory ? { memory: loop.manifest.memory } : {}),
    },
    input: task.args,
    guardrails: agent.guardrailsEffective,
  });
  if (result.error) throw new Error(result.error);
  return typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? "");
}

async function runAppCommandTask(task: AgentTask): Promise<string> {
  // The binding's target is the app slug; args carry the tool + its input.
  const tool = String(task.args.tool ?? task.args.command ?? "");
  if (!tool) throw new Error('an app_command task needs args.tool (e.g. {"tool":"scan","args":{...}})');
  const inner = (task.args.args ?? {}) as Record<string, unknown>;
  const out = await callAppTool(task.target, tool, inner);
  return typeof out === "string" ? out : JSON.stringify(out ?? "");
}

async function fire(agent: LiveAgent, task: AgentTask): Promise<{ status: "ok" | "error"; error?: string }> {
  const key = task.id;
  if (inFlight.has(key)) return { status: "error", error: "this task is already running" };
  const startedAt = Date.now();
  inFlight.set(key, startedAt);
  try {
    let output: string;
    if (task.kind === "skill") output = await runSkillTask(agent, task);
    else if (task.kind === "loop") output = await runLoopTask(agent, task);
    else output = await runAppCommandTask(task);
    // The run's PRODUCT feeds the history — capped so a chatty run cannot
    // bloat the feed; the server caps again at 16k regardless.
    await getClient().agents.reportTaskRun(agent.id, task.id, {
      status: "ok", output: output.slice(0, 12_000), durationMs: Date.now() - startedAt,
    });
    console.log(`[agent-scheduler] "${agent.slug}/${task.name}" ok in ${Date.now() - startedAt}ms`);
    return { status: "ok" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[agent-scheduler] "${agent.slug}/${task.name}" failed:`, message);
    await getClient().agents.reportTaskRun(agent.id, task.id, {
      status: "error", error: message.slice(0, 2000), durationMs: Date.now() - startedAt,
    }).catch(() => { /* the outcome write is best-effort */ });
    return { status: "error", error: message };
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Fire one task RIGHT NOW — the Run button's door. Same execution and same
 * write-back as a scheduled firing, so the run lands in the task's feed;
 * the agent does not need to be live, because a human asked.
 */
/** When the task started running, or null if it is not in flight. */
export function taskRunningSince(taskId: string): number | null {
  return inFlight.get(taskId) ?? null;
}

/** Run a saved LOOP by slug, standalone (no agent) — for remote/attach runs.
 *  Capabilities default to the loop's own manifest; models resolve via the
 *  user's config. Returns the loop's output as text. */
export async function runLoopBySlug(slug: string, input: Record<string, unknown>): Promise<string> {
  const client = getClient();
  const loop = await client.loops.get(slug);
  const result = await runProgramWithBrowser(client, {
    program: { slug: loop.slug, code: loop.code },
    capabilities: {
      roles: {},
      skills: loop.manifest.skills ?? [],
      connections: loop.manifest.connections ?? [],
      ...(loop.manifest.memory ? { memory: loop.manifest.memory } : {}),
    },
    input,
  });
  if (result.error) throw new Error(result.error);
  return typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? "");
}

/** Run a saved SKILL by slug, standalone — for remote/attach runs. */
export async function runSkillBySlug(slug: string, input: Record<string, unknown>): Promise<string> {
  const client = getClient();
  const skill = await client.skills.get(slug);
  if (!skill.code.trim()) throw new Error(`skill "${slug}" has no program to run`);
  const result = await runProgramWithBrowser(client, {
    program: { slug: skill.slug, code: skill.code },
    capabilities: {
      roles: {},
      skills: [],
      connections: skill.manifest.requires ?? [],
      ...(skill.manifest.allowedTools?.length ? { allowedTools: skill.manifest.allowedTools } : {}),
    },
    input,
  });
  if (result.error) throw new Error(result.error);
  return typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? "");
}

export async function runTaskNow(agentId: string, taskId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = getClient();
    const agent = await client.agents.get(agentId);
    const task = (await client.agents.tasks(agentId)).find((x) => x.id === taskId);
    if (!task) return { ok: false, error: "task not found" };
    const result = await fire({ ...agent, tasks: [] }, task);
    return result.status === "ok" ? { ok: true } : { ok: false, error: result.error ?? "run failed" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── The tick ────────────────────────────────────────────────────────────────

async function refreshLive(): Promise<void> {
  try {
    liveCache = (await getClient().agents.live()) as LiveAgent[];
    liveFetchedAt = Date.now();
  } catch {
    // Signed out or offline — keep the last known set; an empty cache on a
    // fresh boot simply means nothing fires until sign-in.
  }
}

async function tick(): Promise<void> {
  if (Date.now() - liveFetchedAt > LIVE_REFRESH_MS) await refreshLive();
  const now = new Date();
  const minute = Math.floor(now.getTime() / 60_000);
  for (const agent of liveCache) {
    for (const task of agent.tasks) {
      if (!task.enabled) continue;
      if (firedAt.get(task.id) === minute) continue;
      if (!cronMatches(task.cron, now)) continue;
      firedAt.set(task.id, minute);
      void fire(agent, task);
    }
  }
}

/** Start the scheduler. Idempotent; runs for the app's lifetime. */
export function startAgentScheduler(): void {
  if (timer) return;
  void refreshLive();
  timer = setInterval(() => void tick(), TICK_MS);
  console.log("[agent-scheduler] started (30s tick; live agents refresh every 5m)");
}

export function stopAgentScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
