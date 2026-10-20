/**
 * registry.ts — the one command table shared by the `glyphh` bin and the REPL.
 * Each domain module contributes commands; the parity test walks the SDK surface
 * against `covered()` so no client method ships without a command.
 */

import type { CliArgs } from "./args.js";
import type { CliContext } from "./context.js";

export interface Command {
  /** Space-joined path, e.g. "auth login" or "me". */
  path: string;
  summary: string;
  usage?: string;
  /** SDK method paths this command exercises — the parity contract. */
  covers?: string[];
  run(ctx: CliContext, args: CliArgs): Promise<void>;
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  register(command: Command): void {
    if (this.commands.has(command.path)) throw new Error(`duplicate command: ${command.path}`);
    this.commands.set(command.path, command);
  }

  get(path: string): Command | undefined {
    return this.commands.get(path);
  }

  all(): Command[] {
    return [...this.commands.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Match the longest command path (up to 3 words) at the head of `tokens`. */
  match(tokens: string[]): { command: Command; rest: string[] } | undefined {
    for (let depth = Math.min(3, tokens.length); depth >= 1; depth--) {
      const command = this.commands.get(tokens.slice(0, depth).join(" "));
      if (command) return { command, rest: tokens.slice(depth) };
    }
    return undefined;
  }

  /** The set of SDK method paths covered by at least one command. */
  covered(): Set<string> {
    const set = new Set<string>();
    for (const command of this.commands.values()) for (const m of command.covers ?? []) set.add(m);
    return set;
  }
}
