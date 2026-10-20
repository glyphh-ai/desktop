/**
 * bundled-cli.ts — THE GLYPHH CLI THE APP CARRIES.
 *
 * `npm run build` bundles the terminal agent (cli/) into dist/cli/main.mjs
 * beside the app's own main process, against the same providers, store and
 * SDK. The Glyphh loop's terminal runs THAT file with the app's own binary as
 * Node (ELECTRON_RUN_AS_NODE), so the user installs nothing and the terminal
 * is always the same build as the panel. A checkout that has not built it
 * falls back to a `glyphh` on PATH.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";

/** The bundled CLI's entry, or null when this build does not carry one. */
export function bundledGlyphhCli(): string | null {
  const entry = path.join(app.getAppPath(), "dist", "cli", "main.mjs");
  return fs.existsSync(entry) ? entry : null;
}
