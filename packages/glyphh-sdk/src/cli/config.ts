/**
 * config.ts — the CLI's on-disk profile (`~/.glyphh/config.json`): which server to
 * talk to. Missing/corrupt files degrade to defaults rather than throwing.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliConfig {
  server: string;
}

const DEFAULTS: CliConfig = { server: "http://127.0.0.1:3001" };

export function configDir(): string {
  return process.env.GLYPHH_HOME ?? join(homedir(), ".glyphh");
}

export function loadConfig(): CliConfig {
  try {
    const raw = readFileSync(join(configDir(), "config.json"), "utf8");
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<CliConfig>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: CliConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
}
