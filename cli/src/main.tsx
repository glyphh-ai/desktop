/**
 * main.tsx — `glyphh`: the Glyphh loop in your terminal, on the user's own
 * Anthropic key and the desktop's own local data (local.ts). Flags are what
 * the desktop passes when it opens this loop in a terminal card, and what a
 * person types:
 *
 *   glyphh [prompt…]                 an opening prompt (sent once the chat is up)
 *   --model <id>                     the model this session runs on
 *   --effort low|medium|high|xhigh|max   how hard the model thinks this session
 *   --permission default|acceptEdits|plan|bypass   the permission chip
 *   --resume <chatId> | --continue   open a conversation from the shared store
 *   --help | --version               print and exit
 *
 * bin/glyphh.js loads this bundle (dist/cli/main.mjs); `glyphh desktop` is
 * taken there and never reaches here.
 */

import { homedir } from "node:os";
import { createRequire } from "node:module";
import { render } from "ink";
import { Boot } from "./components/Boot.js";
import { HELP, parseFlags } from "./flags.js";
import { hasProviderKey } from "./local.js";
import { availableModels, isKnownModel } from "./models.js";
import { createFullscreenStdout } from "./render/fullscreen.js";
import { diag, logPath, trimLog } from "./diag.js";

// The package's own version: dist/cli/main.mjs (and cli/src/main.tsx) sit two
// folders under the package.json that ships with them (npm_package_version is
// only set under `npm run`, so an installed CLI would read "1.0.0").
const VERSION = String((createRequire(import.meta.url)("../../package.json") as { version?: string }).version ?? "0.0.0");

/** The working directory, with $HOME collapsed to `~`. */
function displayCwd(): string {
  const cwd = process.cwd();
  const home = homedir();
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/** THE SCREEN: the alternate buffer, full height, cursor hidden, the wheel's
 *  arrow translation off (↑/↓ are prompt history; pgup/pgdn scroll). Ink's
 *  frames go through the line-diff renderer (render/fullscreen.ts). */
function enterScreen(): void {
  process.stdout.write("\x1b[?1049h\x1b[?1007l\x1b[?25l\x1b[H\x1b[2J");
}
function leaveScreen(): void {
  process.stdout.write("\x1b[?25h\x1b[?1007h\x1b[?1049l");
}

function main(): void {
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);
  if (flags.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (flags.version) {
    process.stdout.write(`glyphh ${VERSION}\n`);
    return;
  }
  if (flags.model && !isKnownModel(flags.model)) {
    process.stderr.write(`glyphh: --model must be one of ${availableModels().map((m) => m.id).join(", ")} (got ${JSON.stringify(flags.model)})\n`);
    process.exitCode = 2;
    return;
  }
  trimLog();
  diag("boot", {
    version: VERSION, argv, cwd: process.cwd(), keyed: hasProviderKey(),
    tty: { out: !!process.stdout.isTTY, in: !!process.stdin.isTTY, rows: process.stdout.rows, cols: process.stdout.columns },
    desktop: { sessions: !!process.env.GLYPHH_APP_SESSIONS, mcp: !!process.env.GLYPHH_APP_MCP_URL },
  });
  enterScreen();
  let restored = false;
  const restore = () => {
    if (!restored) {
      restored = true;
      leaveScreen();
    }
  };
  process.on("exit", (code) => { diag("exit", { code }); restore(); });
  // A CRASH IS NEVER A BLANK SCREEN: leave the alternate buffer, say what broke
  // (on the terminal and in the log), and exit — the shell prompt comes back.
  const crash = (kind: string, err: unknown): void => {
    const e = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) };
    diag(kind, e);
    restore();
    process.stderr.write(`glyphh: ${e.message}\n  (details in ${logPath()})\n`);
    process.exit(1);
  };
  process.on("uncaughtException", (err) => crash("uncaughtException", err));
  process.on("unhandledRejection", (err) => crash("unhandledRejection", err));
  for (const sig of ["SIGHUP", "SIGTERM"] as const) process.on(sig, () => { diag("signal", { sig }); restore(); process.exit(0); });

  const { waitUntilExit } = render(
    <Boot
      version={VERSION}
      cwd={displayCwd()}
      {...(flags.model ? { initialModel: flags.model } : {})}
      {...(flags.effort ? { initialEffort: flags.effort } : {})}
      {...(flags.permission ? { initialMode: flags.permission } : {})}
      {...(flags.prompt ? { initialPrompt: flags.prompt } : {})}
      {...(flags.resume ? { resumeId: flags.resume } : {})}
      {...(flags.continueLast ? { continueLast: true } : {})}
      {...(flags.trust ? { trusted: true } : {})}
    />,
    { stdout: createFullscreenStdout(process.stdout, () => diag("first-frame")) },
  );
  diag("rendering");
  waitUntilExit()
    .then(restore)
    .catch((e) => {
      diag("render-error", { message: (e as Error).message, stack: (e as Error).stack });
      restore();
      process.stderr.write(`glyphh: ${(e as Error).message}\n  (details in ${logPath()})\n`);
      process.exit(1);
    });
}

main();
