/**
 * context.ts — what every command receives: a configured Client, the config, and
 * output helpers. `buildContext` wires the Client to the on-disk session store so
 * the CLI and REPL share one authenticated session.
 */

import { join } from "node:path";
import { createClient, type Client } from "../client.js";
import { FileTokenStore } from "../storage/file.js";
import { loadConfig, configDir, type CliConfig } from "./config.js";

export interface CliContext {
  client: Client;
  config: CliConfig;
  print(msg: string): void;
  printJson(value: unknown): void;
}

export interface ContextOptions {
  server?: string | undefined;
  print?: (msg: string) => void;
}

export function buildContext(opts: ContextOptions = {}): CliContext {
  const config = loadConfig();
  if (opts.server) config.server = opts.server;
  const print = opts.print ?? ((msg: string) => process.stdout.write(msg + "\n"));
  const client = createClient({
    url: config.server,
    tokenStore: new FileTokenStore(join(configDir(), "session.json")),
  });
  return {
    client,
    config,
    print,
    printJson: (value) => print(JSON.stringify(value, null, 2)),
  };
}
