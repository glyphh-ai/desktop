/**
 * args.ts — a tiny, dependency-free argv parser. Tokens starting with `--` are
 * flags (`--k v`, `--k=v`, or boolean `--k`); everything else is positional.
 */

export interface CliArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(tokens: string[]): CliArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.startsWith("--")) {
      positional.push(tok);
      continue;
    }
    const body = tok.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (i + 1 < tokens.length && !tokens[i + 1]!.startsWith("--")) {
      flags[body] = tokens[++i]!;
    } else {
      flags[body] = true;
    }
  }
  return { positional, flags };
}

export function flagStr(args: CliArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

/** A bare switch (`--live`). Present-without-a-value parses as `true`. */
export function flagBool(args: CliArgs, name: string): boolean {
  return args.flags[name] === true;
}
