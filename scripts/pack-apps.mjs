// Pack each Glyphh app under apps/<name>/ into dist-apps/<name>.glyphh — a zip
// with manifest.json + assets at the root (installed via the Apps page Import
// button). Run: `node scripts/pack-apps.mjs`.

import { execFileSync } from "node:child_process";
import { readdirSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "apps");
const OUT = join(ROOT, "dist-apps");

if (!existsSync(SRC)) { console.log("no apps/ dir — nothing to pack"); process.exit(0); }
mkdirSync(OUT, { recursive: true });

for (const name of readdirSync(SRC)) {
  const dir = join(SRC, name);
  if (!statSync(dir).isDirectory()) continue;
  const manifest = join(dir, "manifest.json");
  if (!existsSync(manifest)) { console.log(`skip ${name} — no manifest.json`); continue; }
  const out = join(OUT, `${name}.glyphh`);
  rmSync(out, { force: true });
  const files = readdirSync(dir); // manifest + assets, flat
  // -j: junk paths so everything lands at the zip root
  execFileSync("zip", ["-q", "-j", out, ...files.map((f) => join(dir, f))]);
  console.log(`packed ${name}.glyphh (${files.length} files)`);
}
