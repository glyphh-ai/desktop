/**
 * home.ts — a throwaway home for the tests that read the desktop's data.
 * Imported FIRST by a test file, so HOME points at a temp folder before
 * app-paths resolves ~/.glyphh, and the real one is never read or written.
 * It holds one Anthropic provider with the four Claude chat models.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_HOME = mkdtempSync(join(tmpdir(), "glyphh-cli-home-"));
export const TEST_USER_DIR = join(TEST_HOME, ".glyphh", "users", "local");
process.env.HOME = TEST_HOME;
for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]) delete process.env[k];

export const CLAUDE = ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export const ids = (...models: string[]): string[] => models.map((m) => `anthropic::${m}`);

/** Write the providers file: one Anthropic provider (with `key`, or none) and the Claude models. */
export function writeProviders(key: string | null = "sk-ant-test"): void {
  mkdirSync(TEST_USER_DIR, { recursive: true });
  writeFileSync(join(TEST_USER_DIR, "providers.json"), JSON.stringify({
    providers: [{ id: "anthropic", kind: "anthropic", name: "Anthropic", ...(key ? { apiKey: key } : {}) }],
    models: CLAUDE.map((model) => ({ id: `anthropic::${model}`, provider: "anthropic", model, type: "chat" })),
    defaults: { chat: "anthropic::claude-opus-5-5" },
  }));
}

writeProviders();
