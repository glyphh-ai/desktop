/**
 * commands/decide.ts — Jev decisions through GlyphhRouter. `decide` sends a
 * state + questions (JSON) and prints the answers; `route` picks one branch,
 * deterministically (highest probability, ties to the first branch listed,
 * --fallback under --min-confidence).
 */

import { flagStr } from "../args.js";
import type { CommandRegistry } from "../registry.js";

function json(text: string | undefined, what: string): unknown {
  if (text === undefined) throw new Error(`${what} is required`);
  try { return JSON.parse(text); } catch { return text; }
}

export function registerDecide(reg: CommandRegistry): void {
  reg.register({
    path: "decide",
    summary: "ask Jev questions about a state (through GlyphhRouter)",
    usage: "decide <state> --questions '<json>' [--model jev-latest]",
    covers: ["decide"],
    async run(ctx, args) {
      const questions = json(flagStr(args, "questions"), "--questions");
      if (!questions || typeof questions !== "object") throw new Error("--questions must be a JSON object of questions");
      const model = flagStr(args, "model");
      ctx.printJson(await ctx.client.decide({ state: json(args.positional.join(" ") || undefined, "<state>") as string, questions: questions as never, ...(model ? { model } : {}) }));
    },
  });
  reg.register({
    path: "route",
    summary: "route a state to one branch with Jev, deterministically",
    usage: "route <state> --branches a,b,c [--instructions <text>] [--min-confidence 0.7 --fallback <branch>]",
    covers: ["route"],
    async run(ctx, args) {
      const branches = (flagStr(args, "branches") ?? "").split(",").map((b) => b.trim()).filter(Boolean);
      const min = flagStr(args, "min-confidence");
      const fallback = flagStr(args, "fallback");
      const instructions = flagStr(args, "instructions");
      const model = flagStr(args, "model");
      ctx.printJson(await ctx.client.route(json(args.positional.join(" ") || undefined, "<state>") as string, branches, {
        ...(instructions ? { instructions } : {}),
        ...(min !== undefined ? { minConfidence: Number(min) } : {}),
        ...(fallback ? { fallback } : {}),
        ...(model ? { model } : {}),
      }));
    },
  });
}
