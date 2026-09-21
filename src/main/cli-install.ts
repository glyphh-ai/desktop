/**
 * cli-install.ts — WHICH BINARY A LOOP NEEDS, and whether this machine has it.
 * The one table of install + sign-in commands for the loops' CLIs (the
 * installer TUI is gone, his order 2026-09-21: a missing CLI is a dialog at
 * open time, never a gate at sign-in). `missingCli` is what cli-agent-open
 * answers with so the renderer can say what to install instead of mounting a
 * terminal that prints "command not found".
 */

import { spawnSync } from "node:child_process";

export interface CliInstall {
  name: string;
  bin: string;
  install: { mac: string; win: string };
  login: string;
  note?: string;
}

export const CLI_INSTALL: Record<string, CliInstall> = {
  claude: { name: "Claude Code", bin: "claude", install: { mac: "npm install -g @anthropic-ai/claude-code", win: "npm install -g @anthropic-ai/claude-code" }, login: "claude", note: "type /login inside, then /exit" },
  codex: { name: "Codex", bin: "codex", install: { mac: "npm install -g @openai/codex", win: "npm install -g @openai/codex" }, login: "codex login" },
  gemini: { name: "Gemini", bin: "gemini", install: { mac: "npm install -g @google/gemini-cli", win: "npm install -g @google/gemini-cli" }, login: "gemini", note: "sign in on its first screen, then /quit" },
  copilot: { name: "Copilot", bin: "copilot", install: { mac: "npm install -g @github/copilot", win: "npm install -g @github/copilot" }, login: "copilot", note: "type /login inside, then /exit" },
  cursor: { name: "Cursor", bin: "cursor-agent", install: { mac: "curl https://cursor.com/install -fsS | bash", win: "powershell -c \"irm https://cursor.com/install | iex\"" }, login: "cursor-agent login" },
  // The Glyphh loop's own terminal: the SDK engine in a TUI, on the gateway.
  glyphh: { name: "Glyphh", bin: "glyphh", install: { mac: "npm install -g @glyphh-ai/cli", win: "npm install -g @glyphh-ai/cli" }, login: "glyphh", note: "sign in on its first screen, then /quit" },
};

/** The install line for this platform, "" for a CLI we do not know. */
export function installLine(cli: string, platform: NodeJS.Platform = process.platform): string {
  const t = CLI_INSTALL[cli] ?? Object.values(CLI_INSTALL).find((x) => x.name.toLowerCase() === cli.toLowerCase() || x.bin === cli);
  return t ? t.install[platform === "win32" ? "win" : "mac"] : "";
}

/** The first word of a command line, unquoted — the binary the shell resolves. */
export function binOf(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] ?? "";
  return first.replace(/^["']|["']$/g, "");
}

/** Is `bin` on the user's PATH? A LOGIN shell answers, since nvm/brew paths
 *  live in the profile, not in the app's own environment. Never throws. */
export function binOnPath(bin: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!bin) return false;
  try {
    if (platform === "win32") return spawnSync("where", [bin], { stdio: "ignore", timeout: 8000 }).status === 0;
    const quoted = `'${bin.replace(/'/g, "'\\''")}'`;
    return spawnSync(process.env.SHELL || "/bin/sh", ["-lc", `command -v ${quoted}`], { stdio: "ignore", timeout: 8000 }).status === 0;
  } catch {
    return false;
  }
}

/** What the renderer's dialog needs when a loop's binary is not installed. */
export interface MissingCli { cli: string; name: string; bin: string; install: string; login: string; note?: string }

/** Null when the loop's binary is on PATH; else what to install. */
export function missingCli(row: { cli: string; name: string; cmd: string }, platform: NodeJS.Platform = process.platform): MissingCli | null {
  const bin = binOf(row.cmd);
  if (!bin || binOnPath(bin, platform)) return null;
  const t = CLI_INSTALL[row.cli];
  return {
    cli: row.cli, name: t?.name ?? row.name, bin,
    install: t ? t.install[platform === "win32" ? "win" : "mac"] : "",
    login: t?.login ?? "",
    ...(t?.note ? { note: t.note } : {}),
  };
}
