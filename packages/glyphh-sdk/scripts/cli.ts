#!/usr/bin/env node
/**
 * cli.ts — the `glyphh` binary. `glyphh [--server URL] <command> [args]`. With no
 * command (or `repl`), drops into the interactive REPL.
 */

import { buildRegistry, buildContext, dispatch } from "../src/cli/index.js";
import { startRepl } from "./repl.js";

function extractServer(argv: string[]): { server?: string; rest: string[] } {
  const i = argv.indexOf("--server");
  const value = i !== -1 ? argv[i + 1] : undefined;
  if (value) return { server: value, rest: [...argv.slice(0, i), ...argv.slice(i + 2)] };
  return { rest: argv };
}

async function main(): Promise<void> {
  const { server, rest } = extractServer(process.argv.slice(2));
  const reg = buildRegistry();
  const ctx = buildContext(server ? { server } : {});

  if (rest.length === 0 || rest[0] === "repl") {
    await startRepl(reg, ctx);
    return;
  }
  process.exit(await dispatch(reg, ctx, rest));
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
