/**
 * SDK LLM — asar-safe spawn helpers for the Claude Agent SDK.
 *
 * Glyphh itself makes NO LLM calls (sdkComplete and every in-app agent
 * surface were deleted); these helpers remain for dev tooling that spawns
 * the agent SDK on the developer's own machine (code-index benchmarks).
 */

import fs from "fs";
import path from "path";
import os from "os";

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

// sdkComplete (one-shot completions through the agent SDK) was deleted with
// the rest of the in-app LLM surfaces — Glyphh makes no model calls of its
// own. Only the asar-safe spawn helpers above remain (used by the code-index
// benchmark, a dev tool that runs on the developer's own machine).
