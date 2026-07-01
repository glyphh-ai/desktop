// overlay-bridge.ts — supervises the native keytap helper (protocol v3) and routes
// the dot-commands it intercepts (anywhere in the OS) into the right destination.
// The UX is mostly INLINE: the helper shows a braille spinner at the caret while
// we work, and we reply telling it what to do.
//
// The helper (src/main/overlay/keytap.swift, compiled to dist/main/overlay/keytap)
// talks newline-delimited JSON over stdio:
//   helper -> us (stdout):  {"type":"run","trigger","query","x","y","app"}
//   us -> helper (stdin):   {"type":"result"|"ephemeral"|"done"|"panel"|"paste", …}
//
// Routing by trigger:
//   .dip / .drip  → focus main window, run through the command parser, then {done}.
//   .sup          → run through the command parser, paste a short confirmation that
//                   auto-deletes after ~2s ({ephemeral}).
//   .yo / .peace  → REMOVED along with the interactive chat agent (YoAgent). These
//                   triggers now no-op with {done}; they relied on a one-shot LLM
//                   call + slide-out chat panel (overlay-prompt.ts, also removed).
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";

let proc: ChildProcess | null = null;
let stopped = false;
let restarts = 0;
let runCommandFn: ((cmd: string) => Promise<string> | void) | null = null;
let focusMainFn: (() => void) | null = null;
// Which dot-commands the helper intercepts. Until the agent overlay is ready
// we ship with only ".drip" active (the global full-screen effect); the rest
// (.yo/.sup/.dip/.peace) stay off behind a flag.
let triggersEnv = ".drip";

export function startOverlay(
  runCommand: (cmd: string) => Promise<string> | void,
  focusMain: () => void,
  binPath: string,
  triggers: string,
): void {
  if (process.platform !== "darwin") return;
  if (!fs.existsSync(binPath)) {
    console.error("[overlay] helper binary missing (run npm run build:overlay):", binPath);
    return;
  }
  stopped = false;
  runCommandFn = runCommand;
  focusMainFn = focusMain;
  triggersEnv = triggers || ".drip";
  spawnHelper(binPath);
}

function spawnHelper(binPath: string): void {
  proc = spawn(binPath, [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, YO_OVERLAY_TRIGGERS: triggersEnv },
  });
  let buf = "";
  proc.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) void handleLine(line);
    }
  });
  proc.on("exit", (code) => {
    proc = null;
    if (stopped) return;
    // Crash-loop guard: back off and cap restarts.
    if (restarts++ < 5) {
      console.error(`[overlay] helper exited (${code}); restarting (${restarts})`);
      setTimeout(() => { if (!stopped) spawnHelper(binPath); }, 1000);
    } else {
      console.error("[overlay] helper keeps exiting; giving up.");
    }
  });
  proc.on("error", (err) => console.error("[overlay] helper spawn error:", err));
}

async function handleLine(line: string): Promise<void> {
  let msg: { type?: string; trigger?: string; query?: string; x?: number; y?: number; app?: string };
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "run") return;
  const trigger = msg.trigger || ".yo";
  const query = (msg.query || "").trim();

  try {
    // .dip → switch apps: bring yo to the front, run through the parser, clear spinner.
    if (trigger === ".dip") {
      focusMainFn?.();
      const cmd = `dip${query ? " " + query : ""}`;
      try { await runCommandFn?.(cmd); }
      catch (e) { console.error("[overlay] command failed:", e); }
      sendToHelper({ type: "done" });
      return;
    }
    // .drip → full-screen OS overlay over whatever app you're in: do NOT focus
    // yo (the effect floats over everything). The drip-manager plays full-screen
    // unless the in-app ".drip ." variant is used.
    if (trigger === ".drip") {
      const cmd = `drip${query ? " " + query : ""}`;
      try { await runCommandFn?.(cmd); }
      catch (e) { console.error("[overlay] command failed:", e); }
      sendToHelper({ type: "done" });
      return;
    }

    // .sup → capture, then paste a short inline confirmation that auto-deletes.
    if (trigger === ".sup") {
      let out = "";
      try { out = ((await runCommandFn?.(`sup${query ? " " + query : ""}`)) as string) || ""; }
      catch (e) { console.error("[overlay] sup failed:", e); }
      const text = (out && out.trim()) || "captured ✓";
      sendToHelper({ type: "ephemeral", text, ms: 2000 });
      return;
    }

    // .yo / .peace → the chat agent that powered these was removed. No-op.
    sendToHelper({ type: "done" });
  } catch (e) {
    console.error("[overlay] run handling failed:", e);
    sendToHelper({ type: "done" });
  }
}

// Send a control message to the helper's stdin (used inline + by the panel's Insert).
export function sendToHelper(obj: Record<string, unknown>): void {
  if (!proc?.stdin?.writable) return;
  proc.stdin.write(JSON.stringify(obj) + "\n");
}

export function stopOverlay(): void {
  stopped = true;
  proc?.kill();
  proc = null;
}
