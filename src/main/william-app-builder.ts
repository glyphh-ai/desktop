/**
 * William's app builder — the generate → validate → repair loop, live.
 *
 * The training target, wired: SYSTEM_PROMPT (the exact training prompt) +
 * the user's description (+ live connector grounding from their connected
 * accounts) → emission → oracle → on failure, the errors feed a repair
 * attempt (the ≥90% projected path from the eval); on success the bundle
 * zips and installs through the host's real install gate, and the app is
 * immediately openable/runnable.
 */

import { webContents } from "electron";
import AdmZip from "adm-zip";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getExplicitWorkingDirectory } from "./working-directory";
import {
  SYSTEM_PROMPT, parseEmission, validateBundle, buildGroundingBlock,
  type Bundle, type LiveConnectorTool,
} from "./william-app-oracle";
import { williamComplete } from "./william";
import { effortMaxTokens, williamEffort } from "./william-permissions";
import { installGlyphhAppBundle } from "./glyphh-app-host";
import { connectorTools } from "./glyphh-app-services";
import { serverGetAuthed } from "./auth";

function repairBudget(): number {
  switch (williamEffort()) {
    case "low": return 1;
    case "high": return 3;
    case "superfly": return 4;
    default: return 2;
  }
}

function say(text: string): void {
  for (const wc of webContents.getAllWebContents()) {
    try { if (!wc.isDestroyed()) wc.send("william:setup", { phase: "building", text }); } catch { /* gone */ }
  }
}

/** Show the generated UI in the workbench Preview rail as it evolves. */
function showPreview(html: string, label: string): void {
  for (const wc of webContents.getAllWebContents()) {
    try { if (!wc.isDestroyed()) wc.send("william:setup", { phase: "preview", html, label }); } catch { /* gone */ }
  }
}

/** Live grounding: every connected account's real tools (training format). */
async function liveGrounding(): Promise<{ block: string; lookup: (slug: string) => string[] | null }> {
  const bySlug: Record<string, LiveConnectorTool[]> = {};
  try {
    const r = await serverGetAuthed<{ connections?: Array<{ appSlug?: string }> }>("/api/connections");
    const slugs = [...new Set((r.connections || []).map((c) => String(c.appSlug || "")).filter(Boolean))].slice(0, 6);
    const scope = new Set(slugs);
    for (const slug of slugs) {
      try { bySlug[slug] = await connectorTools(scope, { connector: slug }); } catch { /* one connector down */ }
    }
  } catch { /* signed out — build ungrounded */ }
  return {
    block: buildGroundingBlock(bySlug),
    lookup: (slug) => (bySlug[slug] ? bySlug[slug].map((t) => t.name) : null),
  };
}

export interface BuildResult { slug: string; name: string; attempts: number; warnings: string[]; sourceDir?: string }

/** Zip a bundle and run it through the host's real install gate. */
async function packageAndInstall(bundle: Bundle): Promise<{ ok: boolean; name?: string; error?: string }> {
  const zip = new AdmZip();
  for (const [file, content] of Object.entries(bundle)) {
    zip.addFile(file, Buffer.from(content, "utf8"));
  }
  const tmp = path.join(os.tmpdir(), `william-build-${Date.now().toString(36)}.glyphh`);
  fs.writeFileSync(tmp, zip.toBuffer());
  try {
    return await installGlyphhAppBundle(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* tmp gone */ }
  }
}

/**
 * The iteration loop's return path: re-validate + re-install the app from
 * the WORKING FOLDER's source (the root by contract; a <slug>/ subfolder as
 * fallback). William edits files, calls update_app, and the installed app
 * catches up — then its tools reflect the edits.
 */
export async function updateAppFromWorkdir(
  lookup?: (slug: string) => string[] | null,
): Promise<{ slug: string; name: string; warnings: string[] }> {
  const wd = getExplicitWorkingDirectory();
  if (!wd) throw new Error("no working folder is set");
  // Root first (the contract), else the newest subfolder holding a manifest.
  let dir = wd;
  if (!fs.existsSync(path.join(dir, "manifest.json"))) {
    const sub = fs.readdirSync(wd)
      .map((n) => path.join(wd, n))
      .filter((p) => { try { return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "manifest.json")); } catch { return false; } })
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!sub) throw new Error("no manifest.json in the working folder — nothing to update");
    dir = sub;
  }
  const bundle: Bundle = {};
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f);
    try {
      if (fs.statSync(abs).isFile() && fs.statSync(abs).size < 512_000) bundle[f] = fs.readFileSync(abs, "utf8");
    } catch { /* unreadable — skip */ }
  }
  const v = validateBundle(bundle, lookup);
  if (!v.ok) throw new Error(`source fails validation: ${v.errors.join("; ")}`);
  const r = await packageAndInstall(bundle);
  if (!r.ok) throw new Error(r.error || "install failed");
  return { slug: v.manifest!.slug, name: r.name || v.manifest!.name, warnings: v.warnings };
}

/** Drop the FULL passing bundle (every emitted file, index.html included)
 *  at the WORKING FOLDER ROOT — the picked folder IS the app's home (Files
 *  rail shows exactly what shipped; iteration overwrites in place with git
 *  underneath). One guard: if the root already holds a DIFFERENT app's
 *  manifest.json (or a foreign one), nest to <slug>/ instead of clobbering.
 *  Best-effort git commit of the written files when the folder's a repo. */
function writeSourceToWorkdir(bundle: Bundle, slug: string): string | undefined {
  const wd = getExplicitWorkingDirectory();
  if (!wd) return undefined;
  try {
    let dir = wd;
    const existing = path.join(wd, "manifest.json");
    if (fs.existsSync(existing)) {
      let sameApp = false;
      try {
        const m = JSON.parse(fs.readFileSync(existing, "utf8"));
        sameApp = m?.kind === "glyphh-app" && String(m?.slug || "").toLowerCase() === slug;
      } catch { /* unparseable → foreign → nest */ }
      if (!sameApp) dir = path.join(wd, slug);
    }
    fs.mkdirSync(dir, { recursive: true });
    const written: string[] = [];
    for (const [file, content] of Object.entries(bundle)) {
      const abs = path.join(dir, file);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      written.push(path.relative(wd, abs));
    }
    try {
      execSync("git rev-parse --is-inside-work-tree", { cwd: wd, stdio: "ignore" });
      const pathsArg = written.map((p) => JSON.stringify(p)).join(" ");
      execSync(`git add ${pathsArg}`, { cwd: wd, stdio: "ignore" });
      execSync(`git commit -m ${JSON.stringify(`William: build ${slug}`)} -- ${pathsArg}`, { cwd: wd, stdio: "ignore" });
    } catch { /* not a repo / nothing changed — the source is still there */ }
    return dir;
  } catch {
    return undefined; // source copy is a convenience, never a build failure
  }
}

export async function buildGlyphhApp(description: string, signal?: AbortSignal): Promise<BuildResult> {
  const desc = description.trim();
  if (!desc) throw new Error("describe the app to build");
  say("Grounding connectors…");
  const { block, lookup } = await liveGrounding();
  const baseUser = block ? `${desc}\n\n${block}` : desc;

  const budget = repairBudget();
  let lastErrors: string[] = [];
  let lastEmission = "";
  // Live narration: the emission streams through us, so the meta line can
  // say what William is writing RIGHT NOW (manifest → worker → UI).
  const sectionLabel = (file: string): string =>
    file === "manifest.json" ? "shaping the manifest"
    : file === "worker.js" ? "wiring the worker"
    : file === "index.html" ? "designing the UI"
    : `writing ${file}`;

  for (let attempt = 1; attempt <= budget; attempt++) {
    if (signal?.aborted) { say(""); throw new Error("aborted"); }
    say(`Building app — pass ${attempt}/${budget}: thinking it through…`);
    const user = attempt === 1
      ? baseUser
      : `${baseUser}\n\nYour previous attempt failed validation:\n${lastErrors.map((e) => `- ${e}`).join("\n")}\n\nPrevious emission:\n${lastEmission.slice(0, 6000)}\n\nFix every error and re-emit the FULL corrected bundle.`;
    let streamed = "";
    let tokens = 0;
    let lastSay = 0;
    let label = "thinking it through";
    const raw = await williamComplete([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ], {
      temperature: 0.3,
      maxTokens: Math.max(4096, effortMaxTokens()),
      signal,
      onDelta: (d) => {
        streamed += d;
        tokens++;
        const now = Date.now();
        if (now - lastSay < 300) return;
        lastSay = now;
        const sections = [...streamed.matchAll(/^===\s*(.+?)\s*===\s*$/gm)];
        if (sections.length) label = sectionLabel(sections[sections.length - 1][1].trim());
        say(`Building app — pass ${attempt}/${budget}: ${label} · ${tokens.toLocaleString()} tokens`);
      },
    });
    lastEmission = raw;

    say(`Building app — pass ${attempt}/${budget}, validating…`);
    const bundle: Bundle = parseEmission(raw);
    if (bundle["index.html"]) showPreview(bundle["index.html"], `William build — pass ${attempt}`);
    const v = validateBundle(bundle, lookup);
    if (!v.ok) { lastErrors = v.errors; continue; }

    say("Installing…");
    const r = await packageAndInstall(bundle);
    if (!r.ok) { lastErrors = [r.error || "install failed"]; continue; }
    say("");
    if (bundle["index.html"]) showPreview(bundle["index.html"], `${r.name || v.manifest!.name} — installed ✓`);
    const sourceDir = writeSourceToWorkdir(bundle, v.manifest!.slug);
    return { slug: v.manifest!.slug, name: r.name || v.manifest!.name, attempts: attempt, warnings: v.warnings, sourceDir };
  }
  say("");
  throw new Error(`build failed after ${budget} pass${budget === 1 ? "" : "es"}: ${lastErrors.join("; ") || "no valid bundle emitted"}`);
}
