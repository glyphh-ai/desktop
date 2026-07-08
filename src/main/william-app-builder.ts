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
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
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

export interface BuildResult { slug: string; name: string; attempts: number; warnings: string[] }

export async function buildGlyphhApp(description: string, signal?: AbortSignal): Promise<BuildResult> {
  const desc = description.trim();
  if (!desc) throw new Error("describe the app to build");
  say("Grounding connectors…");
  const { block, lookup } = await liveGrounding();
  const baseUser = block ? `${desc}\n\n${block}` : desc;

  const budget = repairBudget();
  let lastErrors: string[] = [];
  let lastEmission = "";
  for (let attempt = 1; attempt <= budget; attempt++) {
    say(`Building app — pass ${attempt}/${budget}, generating…`);
    const user = attempt === 1
      ? baseUser
      : `${baseUser}\n\nYour previous attempt failed validation:\n${lastErrors.map((e) => `- ${e}`).join("\n")}\n\nPrevious emission:\n${lastEmission.slice(0, 6000)}\n\nFix every error and re-emit the FULL corrected bundle.`;
    const raw = await williamComplete([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ], { temperature: 0.3, maxTokens: Math.max(4096, effortMaxTokens()), signal });
    lastEmission = raw;

    say(`Building app — pass ${attempt}/${budget}, validating…`);
    const bundle: Bundle = parseEmission(raw);
    if (bundle["index.html"]) showPreview(bundle["index.html"], `William build — pass ${attempt}`);
    const v = validateBundle(bundle, lookup);
    if (!v.ok) { lastErrors = v.errors; continue; }

    say("Installing…");
    const zip = new AdmZip();
    for (const [file, content] of Object.entries(bundle)) {
      zip.addFile(file, Buffer.from(content, "utf8"));
    }
    const tmp = path.join(os.tmpdir(), `william-build-${Date.now().toString(36)}.glyphh`);
    fs.writeFileSync(tmp, zip.toBuffer());
    try {
      const r = await installGlyphhAppBundle(tmp);
      if (!r.ok) { lastErrors = [r.error || "install failed"]; continue; }
      say("");
      if (bundle["index.html"]) showPreview(bundle["index.html"], `${r.name || v.manifest!.name} — installed ✓`);
      return { slug: v.manifest!.slug, name: r.name || v.manifest!.name, attempts: attempt, warnings: v.warnings };
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* tmp gone */ }
    }
  }
  say("");
  throw new Error(`build failed after ${budget} pass${budget === 1 ? "" : "es"}: ${lastErrors.join("; ") || "no valid bundle emitted"}`);
}
