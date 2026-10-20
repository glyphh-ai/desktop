// Regenerate src/app-spec/template.ts from templates/app-next/ so the SDK
// ships the template as code (appTemplateFiles()) without reading the disk.
// A unit test asserts the two stay in sync. Run: npm run gen:app-template
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "templates", "app-next");
const OUT = join(ROOT, "src", "app-spec", "template.ts");

export function readTemplate(dir = SRC) {
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else files[relative(dir, abs).split("\\").join("/")] = readFileSync(abs, "utf8");
    }
  };
  walk(dir);
  return files;
}

export function render(files) {
  return [
    "/**",
    " * @license Proprietary — © Glyphh. All rights reserved.",
    " *",
    " * app-spec/template.ts — GENERATED from templates/app-next/ by",
    " * scripts/gen-app-template.mjs. Do not edit; edit the folder and regenerate.",
    " */",
    "",
    "/** The Next.js app template as { path: content }. */",
    `export const APP_TEMPLATE_FILES: Readonly<Record<string, string>> = ${JSON.stringify(files, null, 2)};`,
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(OUT, render(readTemplate()));
  console.log(`wrote ${relative(ROOT, OUT)} (${Object.keys(readTemplate()).length} files)`);
}
