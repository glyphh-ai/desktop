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

// Linux: can Chromium sandbox itself here? Either its setuid helper is set up (root-owned, setuid; the postinstall
// does that for a sudo install), or the kernel lets unprivileged processes make user namespaces. Ubuntu 24.04's
// AppArmor turns those off by default, and Electron then aborts at start with no window. Neither: run without the
// sandbox and say so, rather than not run at all.
function linuxSandboxUsable(electronPath) {
  const fs = require("node:fs");
  try {
    const helper = fs.statSync(path.join(path.dirname(electronPath), "chrome-sandbox"));
    if (helper.uid === 0 && (helper.mode & 0o4000)) return true;
  } catch { /* no helper */ }
  // Try it: make a user namespace the way Chromium will. util-linux's unshare is on every Ubuntu.
  const probe = require("node:child_process").spawnSync("unshare", ["--user", "--map-root-user", "true"], { stdio: "ignore", timeout: 5000 });
  if (probe.error === undefined) return probe.status === 0;
  const read = (file) => { try { return fs.readFileSync(file, "utf8").trim(); } catch { return null; } };
  if (read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1") return false;
  if (read("/proc/sys/kernel/unprivileged_userns_clone") === "0") return false;
  if (read("/proc/sys/user/max_user_namespaces") === "0") return false;
  return true;
}

if (args[0] === "desktop") {
  const { spawn } = require("node:child_process");
  let electron;
  try {
    electron = require("electron");
  } catch (err) {
    process.stderr.write(
      `glyphh: Electron is not installed in ${appDir}: npm skipped the install scripts that download it.\n` +
        "Reinstall with them allowed (with sudo if you installed it with sudo):\n" +
        "  npm install -g @glyphh-ai/desktop --allow-scripts=@glyphh-ai/desktop,better-sqlite3,node-pty,kuzu,ffmpeg-static,protobufjs\n",
    );
    process.exit(1);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const extra = [];
  if (process.platform === "linux" && !linuxSandboxUsable(electron)) {
    extra.push("--no-sandbox");
    process.stderr.write(
      "glyphh: this system blocks Chromium's sandbox (Ubuntu 24.04 restricts user namespaces), so the desktop app\n" +
        "runs without it. To keep the sandbox: sudo chown root:root " + path.join(path.dirname(electron), "chrome-sandbox") +
        " && sudo chmod 4755 " + path.join(path.dirname(electron), "chrome-sandbox") + "\n",
    );
  }
  const child = spawn(electron, [appDir, ...extra, ...args.slice(1)], { stdio: "inherit", env });
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
