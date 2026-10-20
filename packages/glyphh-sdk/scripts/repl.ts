/**
 * repl.ts — the interactive shell over the SAME command registry the `glyphh` bin
 * uses, so anything the REPL can do the CLI can do (and vice versa). A thin
 * @glyphh/sdk consumer — the SDK's proof.
 *
 *   npm run repl            (defaults to http://127.0.0.1:3001)
 *   GLYPHH_SERVER_URL=… npm run repl
 */

import * as readline from "node:readline";
import { pathToFileURL } from "node:url";
import { banner } from "./banner.js";
import { buildRegistry, buildContext, dispatch, helpText, type CommandRegistry, type CliContext } from "../src/cli/index.js";

/** Run the interactive loop against a registry + context. Shared by the bin. */
export async function startRepl(reg: CommandRegistry, ctx: CliContext): Promise<void> {
  ctx.print(banner(`glyphh client v0.1.0  ·  ${ctx.config.server}`));
  ctx.print(helpText(reg));
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
    prompt: "glyphh> ",
    historySize: 200,
  });
  rl.prompt();
  for await (const line of rl) {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] === "quit" || tokens[0] === "exit") break;
    if (tokens.length) await dispatch(reg, ctx, tokens);
    rl.prompt();
  }
}

// Standalone `npm run repl` (not when imported by the bin).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = process.env.GLYPHH_SERVER_URL;
  void startRepl(buildRegistry(), buildContext(server ? { server } : {}));
}
