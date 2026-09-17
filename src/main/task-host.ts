/**
 * task-host.ts — the UTILITY PROCESS a Glyphh task runs in.
 *
 * The desktop is the runner, the program is the process (his ruling,
 * 2026-09-17): a task's script exports one function, run(ctx, input), and
 * returns the result. This host loads it, hands it the input and a ctx whose
 * every verb round-trips to main over the parent port (agents, connections,
 * app data, checkpoints, logs), and reports done or failed. Main never blocks
 * on a step, and killing this process is cancel.
 *
 * Durability is checkpoints, not steps: ctx.checkpoint(key, fn) asks main for
 * a journaled value first and only runs fn when there is none, so a resumed
 * run replays from the last checkpoint the program chose.
 */

import path from "path";
import { pathToFileURL } from "url";

interface StartMsg {
  type: "start";
  dir: string;
  program: string;
  input: unknown;
  slots: string[];
  connections: string[];
  repos: string[];
}
type HostCall = { type: "call"; id: number; kind: string; args: unknown[] };
type MainReply = { type: "reply"; id: number; ok: boolean; value?: unknown; error?: string };

const port = (process as unknown as { parentPort: { on: (ev: "message", fn: (e: { data: unknown }) => void) => void; postMessage: (m: unknown) => void } }).parentPort;

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function call(kind: string, ...args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    port.postMessage({ type: "call", id, kind, args } satisfies HostCall);
  });
}

const stringErr = (e: unknown): string => (e instanceof Error ? `${e.message}${e.stack ? `\n${e.stack.split("\n").slice(1, 4).join("\n")}` : ""}` : String(e));

function makeCtx(start: StartMsg): Record<string, unknown> {
  const agents: Record<string, { run: (prompt: string, opts?: { schema?: unknown; model?: string }) => Promise<unknown> }> = {};
  for (const slot of start.slots) {
    agents[slot] = { run: (prompt, opts) => call("agent", slot, prompt, opts ?? {}) };
  }
  const connections: Record<string, { call: (tool: string, args?: unknown) => Promise<unknown> }> = {};
  for (const app of start.connections) {
    connections[app] = { call: (tool, args) => call("connection", app, tool, args ?? {}) };
  }
  const data = (repo: string): { exec: (sql: string, params?: unknown) => Promise<unknown> } => ({
    exec: (sql, params) => call("data", repo, sql, params ?? []),
  });
  return {
    agents,
    connections,
    data,
    log: (message: unknown, detail?: unknown) => { void call("log", typeof message === "string" ? message : JSON.stringify(message), detail ?? null); },
    checkpoint: async (key: string, fn: () => unknown | Promise<unknown>): Promise<unknown> => {
      const have = (await call("checkpoint-get", key)) as { hit: boolean; value?: unknown };
      if (have.hit) return have.value;
      const value = await fn();
      await call("checkpoint-set", key, value ?? null);
      return value;
    },
    input: start.input,
    dir: start.dir,
  };
}

async function loadProgram(file: string): Promise<(ctx: unknown, input: unknown) => unknown> {
  // TS under commonjs rewrites import() to require(); a real dynamic import
  // is the only door for an ESM program, so it is built out of the compiler's sight.
  const dynamicImport = new Function("p", "return import(p)") as (p: string) => Promise<Record<string, unknown>>;
  let mod: Record<string, unknown>;
  try { mod = await dynamicImport(pathToFileURL(file).href); }
  catch (err) {
    if (!/\.cjs$|\.js$/.test(file)) throw err;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(file) as Record<string, unknown>;
  }
  const fn = (typeof mod.default === "function" ? mod.default : typeof mod.run === "function" ? mod.run : typeof mod === "function" ? mod : null) as ((ctx: unknown, input: unknown) => unknown) | null;
  if (!fn) throw new Error("the program exports no run(ctx, input) function (export default, exports.run, or module.exports)");
  return fn;
}

port.on("message", (e) => {
  const msg = e.data as StartMsg | MainReply;
  if (msg.type === "reply") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error || "call failed"));
    return;
  }
  if (msg.type !== "start") return;
  void (async () => {
    try {
      const file = path.resolve(msg.dir, msg.program);
      if (!file.startsWith(path.resolve(msg.dir) + path.sep)) throw new Error("the program reaches outside its bundle");
      const run = await loadProgram(file);
      const result = await run(makeCtx(msg), msg.input);
      port.postMessage({ type: "done", result: result === undefined ? null : result });
    } catch (err) {
      port.postMessage({ type: "failed", error: stringErr(err) });
    }
  })();
});
