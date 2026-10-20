#!/usr/bin/env node
// The one `glyphh` command this package installs:
//
//   glyphh [flags…] [prompt…]   the Glyphh agent in this terminal (dist/cli/main.mjs)
//   glyphh desktop [args…]      the desktop app: this package's Electron app, run
//                               with the Electron binary it depends on
//
// Electron is only loaded for `desktop`, so the terminal agent starts without it.
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const appDir = path.join(__dirname, "..");
const args = process.argv.slice(2);

if (args[0] === "desktop") {
  const { spawn } = require("node:child_process");
  const electron = require("electron");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [appDir, ...args.slice(1)], { stdio: "inherit", env });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} else {
  // The terminal agent reads process.argv itself: the same [node, script, …args] shape.
  import(pathToFileURL(path.join(appDir, "dist", "cli", "main.mjs")).href).catch((err) => {
    process.stderr.write(`glyphh: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
