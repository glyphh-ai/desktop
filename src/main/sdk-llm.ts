/**
 * SDK LLM — all LLM calls funneled through the Claude Agent SDK.
 *
 * Provides sdkComplete() for one-shot completions (no tools, no streaming).
 * Exports resolveAgentSdkBinary() and makeSpawnOverride() so every sdk.query()
 * call site uses the same asar-safe spawn path.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { getShellPath } from "./shell-path";
import { promptLog } from "./prompt-log";

const dynamicImport = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<any>;

let _sdk: any = null;

async function ensureSDK(): Promise<any> {
  if (!_sdk) {
    _sdk = await dynamicImport("@anthropic-ai/claude-agent-sdk");
  }
  return _sdk;
}

export { ensureSDK };

let _cachedBinary: string | undefined | null = null;

export function resolveAgentSdkBinary(): string | undefined {
  if (_cachedBinary !== null) return _cachedBinary;

  const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const arch = process.arch;
  const pkgName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const binaryName = platform === "win32" ? "claude.exe" : "claude";

  let realFs: typeof fs;
  try { realFs = require("original-fs"); } catch { realFs = fs; }

  const asarIdx = __dirname.indexOf("app.asar");
  if (asarIdx !== -1) {
    const unpackedBase = path.join(__dirname.slice(0, asarIdx), "app.asar.unpacked", "node_modules");
    const candidates = [
      path.join(unpackedBase, pkgName, binaryName),
      path.join(unpackedBase, "@anthropic-ai", "claude-agent-sdk", "node_modules", pkgName, binaryName),
    ];
    for (const c of candidates) {
      if (realFs.existsSync(c)) {
        _cachedBinary = c;
        return c;
      }
    }
  }

  try {
    const dir = path.dirname(require.resolve(`${pkgName}/package.json`));
    const bin = path.join(dir, binaryName);
    if (!bin.includes(".asar") && realFs.existsSync(bin)) {
      _cachedBinary = bin;
      return bin;
    }
  } catch {}
  _cachedBinary = undefined;
  return undefined;
}

export function asarSafeQueryOptions(
  cwd?: string,
  onProcessExit?: (info: { code: number | null; signal: string | null; stderr: string }) => void,
): Record<string, any> {
  const sdkBinary = resolveAgentSdkBinary();
  const safeCwd = cwd || os.homedir();
  return {
    cwd: safeCwd,
    ...(sdkBinary ? { pathToClaudeCodeExecutable: sdkBinary } : {}),
    spawnClaudeCodeProcess: (opts: { command: string; args: string[]; cwd: string; env: Record<string, string>; signal: AbortSignal }) => {
      const { spawn } = require("child_process");
      let cmd = sdkBinary || opts.command;
      if (cmd.includes("app.asar" + path.sep) && !cmd.includes("app.asar.unpacked")) {
        cmd = cmd.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
      }
      const spawnCwd = opts.cwd?.includes?.(".asar") ? safeCwd : opts.cwd;
      console.log(`[sdk-llm] spawn: cmd=${cmd} cwd=${spawnCwd} args=${opts.args.join(" ")}`);
      const child = spawn(cmd, opts.args, {
        cwd: spawnCwd,
        stdio: ["pipe", "pipe", "pipe"],
        signal: opts.signal,
        env: opts.env,
        windowsHide: true,
      });
      let stderrBuf = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString(); });
      child.on("exit", (code: number | null, signal: string | null) => {
        if (code && code !== 0) console.error(`[sdk-llm] CC exited code=${code} signal=${signal} stderr=${stderrBuf.slice(0, 500)}`);
        onProcessExit?.({ code, signal, stderr: stderrBuf });
      });
      return { stdin: child.stdin, stdout: child.stdout, get killed() { return child.killed; }, get exitCode() { return child.exitCode; }, kill: child.kill.bind(child), on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child) };
    },
  };
}

export interface CompletionResult {
  text: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * One-shot completion via the Agent SDK. No tools, no streaming.
 */
export async function sdkComplete(opts: {
  system: string;
  prompt: string;
  model?: string;
}): Promise<CompletionResult> {
  const sdk = await ensureSDK();
  const shellPath = getShellPath();
  const startTs = Date.now();

  // The subprocess authenticates as the user's own Claude Code login
  // (~/.claude) — Glyphh holds no LLM keys and proxies nothing.
  const gen = sdk.query({
    prompt: opts.prompt,
    options: {
      model: opts.model || "claude-haiku-4-5-20251001",
      maxTurns: 1,
      ...asarSafeQueryOptions(),
      systemPrompt: opts.system,
      tools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      env: {
        ...process.env,
        PATH: shellPath,
        CLAUDE_AGENT_SDK_CLIENT_APP: "yosup/3.0.0",
      },
    },
  });

  let text = "";
  let usage: { input_tokens: number; output_tokens: number } | undefined;

  for await (const msg of gen) {
    switch (msg.type) {
      case "stream_event": {
        const event = msg.event;
        if (event?.type === "content_block_delta") {
          const delta = (event as any).delta;
          if (delta?.type === "text_delta" && delta.text) {
            text += delta.text;
          }
        }
        break;
      }
      case "result": {
        if (msg.usage) {
          usage = {
            input_tokens: msg.usage.input_tokens || 0,
            output_tokens: msg.usage.output_tokens || 0,
          };
        }
        break;
      }
    }
  }

  promptLog.record({
    id: `${startTs}-${Math.random().toString(36).slice(2, 8)}`,
    startTs,
    endTs: Date.now(),
    prompt: opts.prompt.slice(0, 2000),
    response: text.slice(0, 2000),
    inputTokens: usage?.input_tokens || 0,
    outputTokens: usage?.output_tokens || 0,
    model: opts.model || "claude-sonnet-4-6",
    provider: "anthropic",
    mode: "process",
    toolsUsed: [],
  });

  return { text, usage };
}
