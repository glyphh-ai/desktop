/**
 * dispatch.ts — resolve a token list to a command and run it. Errors are caught
 * and rendered (never a raw stack); returns a process exit code.
 */

import type { CommandRegistry } from "./registry.js";
import type { CliContext } from "./context.js";
import { parseArgs } from "./args.js";

export function helpText(reg: CommandRegistry): string {
  const rows = reg.all().map((c) => `  ${c.usage ?? c.path}`.padEnd(48) + c.summary);
  return `glyphh — commands\n${rows.join("\n")}\n`;
}

export async function dispatch(reg: CommandRegistry, ctx: CliContext, tokens: string[]): Promise<number> {
  if (tokens.length === 0 || tokens[0] === "help" || tokens[0] === "--help") {
    ctx.print(helpText(reg));
    return 0;
  }
  const matched = reg.match(tokens);
  if (!matched) {
    ctx.print(`unknown command: ${tokens.join(" ")} (try 'help')`);
    return 1;
  }
  try {
    await matched.command.run(ctx, parseArgs(matched.rest));
    return 0;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    ctx.print(`error${err.code ? ` [${err.code}]` : ""}: ${err.message ?? String(e)}`);
    return 1;
  }
}
