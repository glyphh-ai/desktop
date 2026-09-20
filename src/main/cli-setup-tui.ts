/**
 * cli-setup-tui — the CLI Installer (his order, 2026-09-19), a terminal TUI
 * that runs INSIDE a workbench terminal panel under plain Node
 * (ELECTRON_RUN_AS_NODE), so it must never import electron.
 *
 *   a) which loops' CLIs are installed on this machine, and install the
 *      missing ones (mac / Windows);
 *   b) sign each CLI in, in place;
 *   c) pick the defaults: the loop, its model, and Glyphh (chat) or CLI mode.
 *
 * Main writes an input file (loops, models, defaults, version) and reads the
 * output file this writes on Finish; the preferences are applied there.
 * Usage: node cli-setup-tui.js <input.json> <output.json>
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import readline from "node:readline";

interface Loop { id: string; name: string; cli: string; model?: string }
interface Input {
  version: string; platform: string; loops: Loop[]; models: Array<{ id: string; name: string; provider?: string }>;
  defaults: { loop?: string; view?: string; model?: string };
  /** With the gateway on: the only CLIs the org allows (null = every CLI). */
  clis?: string[] | null;
  /** The org's CLI-mode switch: false = the loop's own terminal is off. */
  cliAllowed?: boolean;
  gateway?: boolean;
}
interface Output { done: boolean; loop?: string; model?: string; view?: "glyphh" | "cli" }

const [, , inPath, outPath] = process.argv;
const input: Input = (() => { try { return JSON.parse(fs.readFileSync(String(inPath), "utf-8")) as Input; } catch { return { version: "", platform: process.platform, loops: [], models: [], defaults: {} }; } })();
const isWin = input.platform === "win32" || process.platform === "win32";

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

// ── the CLIs ──
interface Cli { key: string; name: string; bin: string; install: { mac: string; win: string }; login: string; note?: string }
const ALL_CLIS: Cli[] = [
  { key: "claude", name: "Claude Code", bin: "claude", install: { mac: "npm install -g @anthropic-ai/claude-code", win: "npm install -g @anthropic-ai/claude-code" }, login: "claude", note: "type /login inside, then /exit" },
  { key: "codex", name: "Codex", bin: "codex", install: { mac: "npm install -g @openai/codex", win: "npm install -g @openai/codex" }, login: "codex login" },
  { key: "gemini", name: "Gemini", bin: "gemini", install: { mac: "npm install -g @google/gemini-cli", win: "npm install -g @google/gemini-cli" }, login: "gemini", note: "sign in on its first screen, then /quit" },
  { key: "copilot", name: "Copilot", bin: "copilot", install: { mac: "npm install -g @github/copilot", win: "npm install -g @github/copilot" }, login: "copilot", note: "type /login inside, then /exit" },
  { key: "cursor", name: "Cursor", bin: "cursor-agent", install: { mac: "curl https://cursor.com/install -fsS | bash", win: "powershell -c \"irm https://cursor.com/install | iex\"" }, login: "cursor-agent login" },
];
// The org decides what is offered (his order, 2026-09-20): with the gateway
// on only the loops it enabled; off, every CLI. An org that allows none still
// gets an honest screen and a way out.
const CLIS: Cli[] = Array.isArray(input.clis) ? ALL_CLIS.filter((c) => input.clis!.includes(c.key)) : ALL_CLIS;
const CLI_MODE_ALLOWED = input.cliAllowed !== false;
const shell = (): [string, string[]] => (isWin ? ["powershell.exe", ["-NoLogo", "-Command"]] : [process.env.SHELL || "/bin/zsh", ["-lc"]]);
function has(bin: string): boolean {
  const r = isWin ? spawnSync("where", [bin], { stdio: "ignore" }) : spawnSync("/bin/sh", ["-lc", `command -v ${bin}`], { stdio: "ignore" });
  return r.status === 0;
}
function version(bin: string): string {
  try {
    const [sh, args] = shell();
    const r = spawnSync(sh, [...args, `${bin} --version`], { encoding: "utf-8", timeout: 8000 });
    return String(r.stdout || "").trim().split("\n")[0].slice(0, 32);
  } catch { return ""; }
}

// ── state ──
type Screen = "home" | "cli" | "defaults" | "finish";
let screen: Screen = "home";
let cursor = 0;
let picked: Cli | null = null;
let installed = new Map<string, boolean>();
let versions = new Map<string, string>();
let status = "";
let loopIdx = Math.max(0, input.loops.findIndex((l) => l.id === input.defaults.loop));
let modelIdx = 0;
let viewIdx: 0 | 1 = input.defaults.view === "cli" && CLI_MODE_ALLOWED ? 1 : 0;
// A loop reaches one vendor: its model list is that vendor's (his report, 2026-09-20: Codex offered Anthropic's).
const LOOP_PROVIDER: Record<string, string> = { claude: "anthropic", codex: "openai", gemini: "google", copilot: "github", cursor: "cursor" };
const modelOptions = (): Array<{ id: string; name: string }> => {
  const provider = LOOP_PROVIDER[input.loops[loopIdx]?.cli || ""] || "";
  // Gateway on: the org's whole list runs on every loop (the router translates); off: the loop's own vendor.
  const mine = input.gateway ? input.models : input.models.filter((m) => !provider || (m.provider || "") === provider);
  return [{ id: "", name: "the loop's own default" }, ...mine];
};
const refresh = (): void => { installed = new Map(CLIS.map((x) => [x.key, has(x.bin)])); versions = new Map(CLIS.filter((x) => installed.get(x.key)).map((x) => [x.key, version(x.bin)])); };

// ── drawing ──
const cols = (): number => process.stdout.columns || 100;
const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "").length));
function header(): string[] {
  const white = `${E}38;5;255m`;
  const logo = (process.stdout.columns || 100) >= 100 ? LOGO_WIDE : LOGO_NARROW;
  return [
    ...logo.map((l) => `  ${white}${l}${c.reset}`),
    "",
    `  ${c.dim}CLI Installer${c.reset}  ${c.faint}v${input.version || "dev"} · ${isWin ? "Windows" : "macOS"}${c.reset}`,
  ];
}
function line(s = ""): string { return s; }
function draw(): void {
  const out: string[] = [c.clear, ...header(), ""];
  const key = (k: string, what: string): string => `${c.accent}${k}${c.reset} ${c.dim}${what}${c.reset}`;
  if (screen === "home") {
    out.push(`  ${c.bold}${c.text}Loops on this machine${c.reset}${input.gateway ? `  ${c.faint}the loops your organization enabled${c.reset}` : ""}`, "");
    if (!CLIS.length) out.push(`  ${c.warn}Your organization has not enabled any loops yet. Ask an org admin, then run this again from Settings → CLI Installer.${c.reset}`, "");
    CLIS.forEach((x, i) => {
      const on = installed.get(x.key);
      const sel = i === cursor;
      const dot = on ? `${c.ok}●${c.reset}` : `${c.faint}○${c.reset}`;
      const st = on ? `${c.ok}installed${c.reset} ${c.faint}${versions.get(x.key) || ""}${c.reset}` : `${c.warn}not installed${c.reset}`;
      out.push(`  ${sel ? c.invert : ""} ${dot} ${pad(x.name, 14)} ${pad(st, 34)} ${c.reset}`);
    });
    out.push("");
    const extra = ["Set defaults (loop, model, mode)", "Finish"];
    extra.forEach((e, j) => { const sel = cursor === CLIS.length + j; out.push(`  ${sel ? c.invert : ""} ${c.accent}›${c.reset}${sel ? c.invert : ""} ${pad(e, 50)} ${c.reset}`); });
    out.push("", `  ${key("↑↓", "move")}  ${key("enter", "open")}  ${key("r", "re-check")}`, `  ${c.faint}Finish needs one working CLI.${c.reset}`);
  } else if (screen === "cli" && picked) {
    const on = installed.get(picked.key);
    out.push(`  ${c.bold}${c.text}${picked.name}${c.reset}  ${on ? `${c.ok}installed${c.reset}` : `${c.warn}not installed${c.reset}`}`, "");
    const acts = [
      on ? `Reinstall  ${c.faint}${picked.install[isWin ? "win" : "mac"]}${c.reset}` : `Install  ${c.faint}${picked.install[isWin ? "win" : "mac"]}${c.reset}`,
      `Sign in  ${c.faint}${picked.login}${picked.note ? ` — ${picked.note}` : ""}${c.reset}`,
      "Back",
    ];
    acts.forEach((a, i) => out.push(`  ${i === cursor ? c.invert : ""} ${pad(a, 70)} ${c.reset}`));
    out.push("", `  ${key("enter", "run it here")}  ${key("esc", "back")}`);
  } else if (screen === "defaults") {
    const loop = input.loops[loopIdx];
    const model = modelOptions()[modelIdx];
    const rows = [
      [`Loop`, loop ? `${loop.name} ${c.faint}(${loop.cli})${c.reset}` : `${c.faint}no loops yet${c.reset}`],
      [`Model`, model?.name ?? ""],
      [`Mode`, !CLI_MODE_ALLOWED ? `Glyphh — chat, with the loop underneath ${c.faint}(CLI mode is off for your organization)${c.reset}` : viewIdx === 0 ? "Glyphh — chat, with the loop underneath" : "CLI — the loop's own terminal"],
      ["Save", ""],
    ];
    out.push(`  ${c.bold}${c.text}Defaults${c.reset}  ${c.dim}what a new session starts with${c.reset}`, "");
    rows.forEach(([k, v], i) => out.push(`  ${i === cursor ? c.invert : ""} ${pad(k, 8)} ${pad(v, 60)} ${c.reset}`));
    out.push("", `  ${key("←→", "change")}  ${key("enter", "save")}  ${key("esc", "back")}`);
  } else if (screen === "finish") {
    out.push(`  ${c.ok}${c.bold}Done.${c.reset} ${c.text}Your loops are set. This panel can close.${c.reset}`, "", `  ${c.dim}Run this again any time from Settings → CLI Installer.${c.reset}`);
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
  // A clean exit goes straight back to the menu (his report, 2026-09-20: the
  // menu came back with the cursor "stuck" — the terminal's resize after the
  // install's output redrew the menu over the "press any key" prompt, so the
  // user's next key was eaten by the pause instead of moving the cursor).
  // Only a FAILED command keeps its output up until a key, so the error can
  // be read; the resize handler leaves that screen alone.
  if (r.status === 0) { refresh(); return; }
  process.stdout.write(`\n${c.dim}(exit ${r.status ?? "?"}) press any key to continue${c.reset}`);
  waitKey = true;
}
let waitKey = false;

function finish(): void {
  // THE ONLY WAY OUT IS A WORKING CLI (his order, 2026-09-20).
  // THE ONLY WAY OUT IS A WORKING CLI — unless the org offers none, which is the org's call, not the user's.
  if (CLIS.length && !CLIS.some((x) => installed.get(x.key))) { status = "install at least one CLI before finishing"; draw(); return; }
  const loop = input.loops[loopIdx];
  const model = modelOptions()[modelIdx];
  const outp: Output = { done: true, ...(loop ? { loop: loop.id } : {}), ...(model?.id ? { model: model.id } : {}), view: viewIdx === 1 ? "cli" : "glyphh" };
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
  if (k.ctrl && name === "c") { status = "finish when a CLI works; there is no other way out"; draw(); return; }
  if (screen === "home") {
    const n = CLIS.length + 2;
    if (name === "up") cursor = (cursor + n - 1) % n;
    else if (name === "down") cursor = (cursor + 1) % n;
    else if (name === "r") { refresh(); status = "re-checked"; }
    else if (name === "return") {
      if (cursor < CLIS.length) { picked = CLIS[cursor]; screen = "cli"; cursor = 0; }
      else if (cursor === CLIS.length) { screen = "defaults"; cursor = 0; }
      else finish();
    }
  } else if (screen === "cli" && picked) {
    if (name === "up") cursor = (cursor + 2) % 3;
    else if (name === "down") cursor = (cursor + 1) % 3;
    else if (name === "escape") { screen = "home"; cursor = CLIS.findIndex((x) => x.key === picked!.key); }
    else if (name === "return") {
      if (cursor === 0) {
        if (!isWin && !has("npm") && picked.install.mac.startsWith("npm")) { status = "npm is missing — install Node.js from nodejs.org first"; }
        else runHere(picked.install[isWin ? "win" : "mac"], `Installing ${picked.name}`);
      } else if (cursor === 1) {
        if (!installed.get(picked.key)) status = `${picked.name} is not installed yet`;
        else runHere(picked.login, `Signing in to ${picked.name}`);
      } else { screen = "home"; cursor = CLIS.findIndex((x) => x.key === picked!.key); }
    }
  } else if (screen === "defaults") {
    if (name === "up") cursor = (cursor + 3) % 4;
    else if (name === "down") cursor = (cursor + 1) % 4;
    else if (name === "escape") { screen = "home"; cursor = CLIS.length; }
    else if (name === "left" || name === "right") {
      const d = name === "left" ? -1 : 1;
      if (cursor === 0 && input.loops.length) { loopIdx = (loopIdx + input.loops.length + d) % input.loops.length; modelIdx = 0; }
      else if (cursor === 1) { const n = modelOptions().length; modelIdx = (modelIdx + n + d) % n; }
      else if (cursor === 2 && CLI_MODE_ALLOWED) viewIdx = viewIdx === 0 ? 1 : 0;
    } else if (name === "return") { if (cursor === 3) { screen = "home"; cursor = CLIS.length + 1; status = "defaults saved"; } else if (cursor === 2 && CLI_MODE_ALLOWED) viewIdx = viewIdx === 0 ? 1 : 0; }
  }
  draw();
}

if (!process.stdin.isTTY) {
  process.stdout.write("The CLI Installer needs a terminal. Open it from Settings → CLI Installer.\n");
  process.exit(0);
}
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on("keypress", onKey);
process.stdout.on("resize", () => { if (!waitKey) draw(); });
process.stdout.write(c.hide);
refresh();
draw();
