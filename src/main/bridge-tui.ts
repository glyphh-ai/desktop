/**
 * bridge-tui — BRIDGE MODE's terminal face (his order, 2026-09-21): a TUI that
 * runs INSIDE a workbench terminal panel under plain Node (ELECTRON_RUN_AS_NODE),
 * so it must never import electron. Claude Desktop rides this machine's bridge;
 * the turns the org routes to the member's own Claude login run in Claude Code
 * here, so it has to be installed and signed in. Finish closes the window and
 * the bridge keeps serving; under an org that forces Bridge Mode this IS the app.
 *
 * Main writes an input file (version, platform, the bridge url + forced) and
 * reads the output file this writes on Finish.
 * Usage: node bridge-tui.js <input.json> <output.json>
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import readline from "node:readline";

interface Input { version: string; platform: string; bridge: { url: string; forced: boolean } }
interface Output { done: true; bridge: true }

const [, , inPath, outPath] = process.argv;
const input: Input = (() => {
  try { return JSON.parse(fs.readFileSync(String(inPath), "utf-8")) as Input; }
  catch { return { version: "", platform: process.platform, bridge: { url: "", forced: false } }; }
})();
const isWin = input.platform === "win32" || process.platform === "win32";
const BRIDGE = input.bridge;

// ── theme: the desktop's purple on 256-safe grays ──
const E = "\u001b[";
const c = {
  reset: `${E}0m`, bold: `${E}1m`, dim: `${E}38;5;244m`, text: `${E}38;5;252m`, faint: `${E}38;5;240m`,
  accent: `${E}38;5;135m`, ok: `${E}38;5;78m`, warn: `${E}38;5;214m`, bad: `${E}38;5;203m`,
  invert: `${E}48;5;135m${E}38;5;255m`, hide: `${E}?25l`, show: `${E}?25h`, clear: `${E}2J${E}H`,
};
// The logo (brand/glyphh-logo-white.png) in quadrant cells, two pixels per column: mascot and wordmark as drawn.
const LOGO_WIDE: string[] = ["                 \u2584", "  \u2590\u2588\u2599\u2596       \u2597\u2584\u2588\u2588\u2588\u2598", "   \u259c\u2588\u2588\u259b  \u2584\u2584\u259f\u2588\u2588\u2588\u2588\u2588\u258c", "   \u259d\u2598\u2584\u2584\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588                     \u2588\u2580\u2580\u2588                         \u2590\u259b\u2580\u2580\u2588          \u2590\u259b\u2580\u2580\u2588", "   \u259f\u2588\u2588\u2588\u259b\u2580\u2580\u2597\u2584\u2584\u2596\u2580\u259c\u2588\u2599\u2596                   \u2588  \u2588                         \u2590\u258c  \u2588          \u2590\u258c  \u2588", "  \u2588\u2588\u2588\u2580\u2597\u2584\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2596\u259c\u2588\u2588\u2596      \u2597\u2584\u259b\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u259c\u2596\u2588  \u2588\u2597\u2588\u2580\u259c\u2599   \u2590\u259b\u2580\u259c\u2599\u259f\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2599\u2584 \u2590\u258c  \u259b\u2580\u2580\u2580\u2580\u2580\u2580\u259c\u2584\u2596 \u2590\u258c  \u259b\u2580\u2580\u2580\u2580\u2580\u2580\u2599\u2596", " \u2590\u2588\u2588\u2598\u2590\u2588\u2588\u2588\u2588\u2588   \u2588\u2588 \u2588\u2588\u2599     \u259f\u2580  \u2584\u2584\u2584\u2584\u2584\u2596 \u2590\u258c\u2588  \u2588\u2590\u258c  \u258c   \u2590\u258c  \u2588\u2588  \u2597\u2584\u2584\u2584\u2584\u2596 \u259d\u259c\u259f\u258c  \u2584\u2584\u2584\u2584\u2584\u2584\u2596  \u259c\u2596\u2590\u258c  \u2597\u2584\u2584\u2584\u2584\u2584  \u259c\u258c", " \u2590\u2588\u2588\u2584\u259d\u2580\u2588\u2588\u2588\u2588\u2588\u2584\u2588\u2588\u2580\u2597\u2588\u2588\u259b    \u2590\u258c  \u2588\u2598   \u2590\u258c \u2590\u258c\u2588  \u2588\u2590\u258c  \u258c   \u2590\u258c  \u2588\u2588  \u2590\u258c   \u2580\u2599  \u2588\u258c  \u2588     \u259c\u2596  \u2588\u2590\u258c  \u2588    \u259c\u258c  \u2588", "  \u259c\u2588\u2588\u2588\u2584\u2584\u2596\u2580\u2580\u2580\u2580\u2580\u2597\u259f\u2588\u2588\u259b\u2598    \u2590\u258c  \u2588\u2596   \u2590\u258c \u2590\u258c\u2588  \u2588\u2590\u258c \u259d\u2599   \u2590\u258c  \u2588\u2588  \u2590\u258c   \u2597\u259b  \u2588\u258c  \u2588     \u2590\u258c  \u2588\u2590\u258c  \u2588    \u2590\u258c  \u2588", "    \u259c\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u259b\u2580        \u259c\u2596  \u2580\u2580\u2580\u2580\u2580  \u2590\u258c\u2588  \u2588 \u2588\u2596 \u259d\u2580\u2580\u2580\u2580\u2598  \u2588\u2588  \u259d\u2580\u2580\u2580\u2580\u2580  \u259f\u259c\u258c  \u2588     \u2590\u258c  \u2588\u2590\u258c  \u2588    \u2590\u258c  \u2588", "    \u2588\u2588\u259b \u259d\u2580\u2580\u2588\u2588\u2588\u2588\u2599          \u2580\u2580\u2584\u2584\u2584\u2584\u2584\u2588\u258c \u2590\u258c\u2588\u2584\u2584\u2588  \u2580\u2599\u2584\u2584\u2584\u2584\u259f\u258c  \u2588\u2588  \u2597\u2584\u2584\u2584\u2584\u2584\u259f\u2580\u2598\u2590\u2599\u2584\u2584\u2588     \u2590\u2599\u2584\u2584\u2588\u2590\u2599\u2584\u2584\u2588    \u2590\u2599\u2584\u2584\u2588", "   \u2590\u2588\u2588       \u259c\u2588\u2588\u2584\u2584\u2584\u259b\u2598    \u2597\u259b\u2599\u2584\u2584\u2584\u2584\u2584\u259b  \u259f\u2598      \u2588\u2584\u2584\u2584\u2584\u2584\u259b\u2598 \u2590\u258c\u2588  \u2590\u258c", "  \u2597\u2588\u2588\u2599\u2584\u2584\u2584\u2584\u2584\u2584\u2584 \u2588\u2588\u2588\u259b\u2598      \u2590\u2599\u2584    \u2597\u2584\u2584\u259b\u2598      \u2590\u2599\u2584    \u2584\u2584\u259f\u2580 \u2588\u2584\u2584\u259f\u258c", "   \u2580\u2580\u2580\u2580\u2580                   \u259d\u2580\u2580\u2580\u2580\u2580\u2598           \u259d\u2580\u2580\u2580\u2580\u2580"];
const LOGO_NARROW: string[] = ["  \u2584        \u2597\u2584", "  \u2588\u2588\u2584  \u2597\u2584\u259f\u2588\u2588\u259b", "  \u259d\u259a\u2584\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u258c              \u2597\u2584\u2584\u2596                  \u2584\u2584\u2584       \u2597\u2584\u2584\u2584", " \u2597\u2588\u2588\u259b\u2580\u2584\u2584\u2584\u2584\u2596\u259c\u2588\u2596      \u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2590\u258c\u2590\u258c\u2584\u2584\u2596  \u2597\u2584\u2584\u2596\u2584\u2584\u2584\u2584\u2584\u2584\u2584  \u258c \u2588\u2584\u2584\u2584\u2584\u2584  \u2590\u258c \u2588\u2584\u2584\u2584\u2584\u2596", " \u2588\u2588\u2598\u259f\u2588\u2588\u2588\u2598\u259d\u2588\u258c\u259c\u2588    \u2584\u2580 \u2584\u2584\u2584\u2584 \u2590\u2590\u258c\u2590\u258c\u258c \u258c  \u2590\u2598 \u2588\u258c \u2597\u2584\u2584\u2584 \u2580\u2584\u258c  \u2584\u2584\u2584\u2584 \u2580\u2599\u2590\u258c \u2597\u2584\u2584\u2584 \u259d\u2599", " \u2588\u2588\u2584\u2580\u2580\u2588\u2588\u2588\u2588\u259b\u259a\u2588\u2588\u2598  \u2590\u258c \u2588   \u2588 \u2590\u2590\u258c\u2590\u258c\u258c \u258c  \u2590  \u2588\u258c \u2588  \u259d\u2599 \u259c\u258c \u2588   \u259d\u258c \u2590\u2590\u258c \u259b   \u2599 \u2590", "  \u2580\u2588\u2588\u2588\u2584\u2584\u2584\u2584\u259f\u2588\u2580\u2598   \u259d\u2599 \u259d\u2599\u2584\u2584\u2580 \u2590\u2590\u258c\u2590\u258c\u2599 \u2580\u2584\u2584\u259e  \u2588\u258c \u259c\u2584\u2584\u259f\u2598 \u2588\u258c \u2588    \u258c \u2590\u2590\u258c \u2588   \u2588 \u2590", "  \u2597\u2588\u259b \u2580\u2580\u259c\u2588\u2588\u2596      \u259d\u2580\u2597\u2584\u2584\u2584\u2584 \u2590\u2590\u2599\u259f\u258c\u259d\u259a\u2584\u2584\u2584\u2584  \u2588\u258c \u2584\u2584\u2584\u2584\u2584\u2580 \u2599\u2584\u259b    \u2599\u2584\u259f\u2590\u2599\u2584\u259b   \u2588\u2584\u259f\u2598", "  \u259f\u2588\u2598    \u259d\u2588\u2588\u259f\u259b\u2598   \u259f\u2580\u2580\u2580\u2580\u2580\u2598\u2584\u259b    \u2597\u259b\u2580\u2580\u2580\u2580 \u259f\u259c\u258c \u2588", "  \u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2598\u259d\u2580\u2598     \u259d\u2580\u2580\u2580\u2580\u2580\u2580      \u259d\u2580\u2580\u2580\u2580\u2580\u2580  \u2580\u2580\u2598"];

// ── the one CLI the bridge needs ──
const CLAUDE = {
  name: "Claude Code", bin: "claude",
  install: { mac: "npm install -g @anthropic-ai/claude-code", win: "npm install -g @anthropic-ai/claude-code" },
  login: "claude", note: "type /login inside, then /exit",
};
const shell = (): [string, string[]] => (isWin ? ["powershell.exe", ["-NoLogo", "-Command"]] : [process.env.SHELL || "/bin/zsh", ["-lc"]]);
function has(bin: string): boolean {
  const r = isWin ? spawnSync("where", [bin], { stdio: "ignore" }) : spawnSync("/bin/sh", ["-lc", `command -v ${bin}`], { stdio: "ignore" });
  return r.status === 0;
}
/** Claude Code signed in on this machine: its account record, its credential
 *  file, or its own word for it. Never throws; false is "not that we can see". */
function claudeSignedIn(): boolean {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  try { if (/"oauthAccount"\s*:\s*\{/.test(fs.readFileSync(`${home}/.claude.json`, "utf-8"))) return true; } catch { /* none */ }
  try { if (fs.existsSync(`${home}/.claude/.credentials.json`)) return true; } catch { /* none */ }
  try {
    const [sh, args] = shell();
    const r = spawnSync(sh, [...args, "claude auth status"], { encoding: "utf-8", timeout: 8000 });
    return r.status === 0 && /logged.?in|authenticated/i.test(`${r.stdout}${r.stderr}`) && !/not logged/i.test(`${r.stdout}${r.stderr}`);
  } catch { return false; }
}
function version(bin: string): string {
  try {
    const [sh, args] = shell();
    const r = spawnSync(sh, [...args, `${bin} --version`], { encoding: "utf-8", timeout: 8000 });
    return String(r.stdout || "").trim().split("\n")[0].slice(0, 32);
  } catch { return ""; }
}

// ── state ──
type Screen = "home" | "cli" | "finish";
let screen: Screen = "home";
let cursor = 0;
let installed = false;
let ver = "";
let signedIn = false;
let status = "";
let waitKey = false;
const refresh = (): void => {
  installed = has(CLAUDE.bin);
  ver = installed ? version(CLAUDE.bin) : "";
  signedIn = installed && claudeSignedIn();
};

// ── drawing ──
const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "").length));
function header(): string[] {
  const white = `${E}38;5;255m`;
  const logo = (process.stdout.columns || 100) >= 100 ? LOGO_WIDE : LOGO_NARROW;
  return [
    ...logo.map((l) => `  ${white}${l}${c.reset}`),
    "",
    `  ${c.dim}Bridge Mode${c.reset}  ${c.faint}v${input.version || "dev"} · Claude Desktop → ${c.reset}${c.text}${BRIDGE.url}${c.reset}${c.faint} → Glyphh${c.reset}`,
  ];
}
/** Home rows: Claude Code, then Finish. */
const ROWS = 2;
function draw(): void {
  const out: string[] = [c.clear, ...header(), ""];
  const key = (k: string, what: string): string => `${c.accent}${k}${c.reset} ${c.dim}${what}${c.reset}`;
  if (screen === "home") {
    out.push(`  ${c.bold}${c.text}Claude Desktop rides this machine's bridge${c.reset}`, "",
      `  ${c.dim}Point Claude Desktop's gateway and issuer at ${c.reset}${c.text}${BRIDGE.url}${c.reset}${c.dim}, client id ${c.reset}${c.text}claude-desktop${c.reset}${c.dim}, interactive sign-in.${c.reset}`,
      `  ${c.dim}Turns your organization routes to your own Claude login run in Claude Code here, so it has to be installed and signed in.${c.reset}`, "");
    const dot = installed ? `${c.ok}●${c.reset}` : `${c.faint}○${c.reset}`;
    const login = signedIn ? ` ${c.ok}signed in${c.reset}` : installed ? ` ${c.warn}not signed in${c.reset}` : "";
    const st = installed ? `${c.ok}installed${c.reset} ${c.faint}${ver}${c.reset}${login}` : `${c.warn}not installed${c.reset}`;
    out.push(`  ${cursor === 0 ? c.invert : ""} ${dot} ${pad(CLAUDE.name, 14)} ${pad(st, 44)} ${c.reset}`);
    out.push("");
    out.push(`  ${cursor === 1 ? c.invert : ""} ${c.accent}›${c.reset}${cursor === 1 ? c.invert : ""} ${pad("Finish", 50)} ${c.reset}`);
    out.push("", `  ${key("↑↓", "move")}  ${key("enter", "open")}  ${key("r", "re-check")}`,
      `  ${c.faint}Finish needs Claude Code installed and signed in. It closes this window; the bridge keeps running.${c.reset}`);
  } else if (screen === "cli") {
    out.push(`  ${c.bold}${c.text}${CLAUDE.name}${c.reset}  ${installed ? `${c.ok}installed${c.reset}` : `${c.warn}not installed${c.reset}`}`, "");
    const acts = [
      `${installed ? "Reinstall" : "Install"}  ${c.faint}${CLAUDE.install[isWin ? "win" : "mac"]}${c.reset}`,
      `Sign in  ${c.faint}${CLAUDE.login} — ${CLAUDE.note}${c.reset}`,
      "Back",
    ];
    acts.forEach((a, i) => out.push(`  ${i === cursor ? c.invert : ""} ${pad(a, 70)} ${c.reset}`));
    out.push("", `  ${key("enter", "run it here")}  ${key("esc", "back")}`);
  } else {
    out.push(`  ${c.ok}${c.bold}Done.${c.reset} ${c.text}The bridge keeps running in the background. This window closes.${c.reset}`, "", `  ${c.dim}Open Glyphh from the tray to come back here.${c.reset}`);
  }
  if (status) out.push("", `  ${c.dim}${status}${c.reset}`);
  process.stdout.write(out.join("\n") + "\n");
}

// ── running a child in this same terminal ──
function runHere(cmd: string, why: string): void {
  process.stdin.setRawMode?.(false);
  process.stdout.write(`${c.show}${c.clear}${c.accent}▸ ${why}${c.reset}\n${c.dim}$ ${cmd}${c.reset}\n\n`);
  const [sh, args] = shell();
  const r = spawnSync(sh, [...args, cmd], { stdio: "inherit" });
  process.stdin.setRawMode?.(true);
  status = r.status === 0 ? `${why}: done` : `${why}: exit ${r.status ?? "?"}`;
  // A clean exit goes straight back to the menu; only a FAILED command keeps
  // its output up until a key, so the error can be read (his report, 2026-09-20).
  if (r.status === 0) { refresh(); return; }
  process.stdout.write(`\n${c.dim}(exit ${r.status ?? "?"}) press any key to continue${c.reset}`);
  waitKey = true;
}

function finish(): void {
  refresh();
  if (!installed) { status = "install Claude Code before finishing"; draw(); return; }
  if (!signedIn) { status = "sign in to Claude Code before finishing (Sign in, then /login inside, then /exit)"; draw(); return; }
  const outp: Output = { done: true, bridge: true };
  try { fs.writeFileSync(String(outPath), JSON.stringify(outp)); } catch { /* main will notice nothing landed */ }
  screen = "finish"; draw();
  process.stdout.write(c.show);
  setTimeout(() => process.exit(0), 1200);
}

// The terminal going away is the end: the shell's hangup, a kill, or stdin
// closing all exit, so a closed app never leaves this process behind.
for (const sig of ["SIGHUP", "SIGTERM"] as const) process.on(sig, () => { process.stdout.write(c.show); process.exit(0); });
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

// ── keys ──
function onKey(_: string, k: readline.Key): void {
  if (waitKey) { waitKey = false; refresh(); draw(); return; }
  const name = k.name || "";
  if (k.ctrl && name === "c") { status = BRIDGE.forced ? "finish when Claude Code is signed in; there is no other way out" : "finish, or close this panel with its ×"; draw(); return; }
  if (screen === "home") {
    if (name === "up") cursor = (cursor + ROWS - 1) % ROWS;
    else if (name === "down") cursor = (cursor + 1) % ROWS;
    else if (name === "r") { refresh(); status = "re-checked"; }
    else if (name === "return") { if (cursor === 0) { screen = "cli"; cursor = 0; } else finish(); }
  } else if (screen === "cli") {
    if (name === "up") cursor = (cursor + 2) % 3;
    else if (name === "down") cursor = (cursor + 1) % 3;
    else if (name === "escape") { screen = "home"; cursor = 0; }
    else if (name === "return") {
      if (cursor === 0) {
        if (!isWin && !has("npm")) status = "npm is missing — install Node.js from nodejs.org first";
        else runHere(CLAUDE.install[isWin ? "win" : "mac"], `Installing ${CLAUDE.name}`);
      } else if (cursor === 1) {
        if (!installed) status = `${CLAUDE.name} is not installed yet`;
        else runHere(CLAUDE.login, `Signing in to ${CLAUDE.name}`);
      } else { screen = "home"; cursor = 0; }
    }
  }
  draw();
}

if (!process.stdin.isTTY) {
  process.stdout.write("The bridge TUI needs a terminal. Open it from Settings → Bridge Mode.\n");
  process.exit(0);
}
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on("keypress", onKey);
process.stdout.on("resize", () => { if (!waitKey) draw(); });
process.stdout.write(c.hide);
refresh();
draw();
