/**
 * bundle-shape.ts — the RULES about a bundle's shape, with no I/O.
 *
 * Every folder in the library is a skill and its manifest says which kind it
 * is. Three of those rules kept breaking in ways nobody could see (his
 * reports, 2026-09-17): an installed app that appeared on no page, a required
 * connection that rendered as nothing, and a deleted app whose tile stayed on
 * the echo wall. Each was one small decision buried in a big module, so they
 * live here instead: pure functions, covered by test/main/bundle-shape.test.ts,
 * imported by main (skills-fs, glyphh-app-host) and by the renderer.
 */

import path from "path";

export type BundleKind = "skill" | "app" | "task" | "plugin";

/** Where the user finds each kind, for an agent's answer. */
export const WHERE_TO_SEE: Record<BundleKind, string> = {
  skill: "Settings → Build → Skills (type Skill)",
  app: "Settings → Build → Skills (type App) and the Apps work panel",
  task: "Settings → Build → Skills (type Task); put it on a clock with schedule_save",
  plugin: "Settings → Build → Plugins",
};

// ── a connection dependency ────────────────────────────────────────────

/** A manifest's connection dependency: an app slug and who it acts as. */
export interface ConnDep { app: string; as?: string }

/**
 * A manifest in the wild carries either `["gmail"]` or
 * `[{ app: "gmail", as: "member" }]`. A bare string used to throw mid-render,
 * which left the Connections pane empty under a count of two. Normalize, and
 * drop anything with no app slug.
 */
export function normalizeConnDeps(raw: ReadonlyArray<ConnDep | string> | undefined | null): ConnDep[] {
  return (raw ?? [])
    .map((d) => (typeof d === "string" ? { app: d } : d))
    .filter((d): d is ConnDep => !!d && typeof d.app === "string" && !!d.app.trim())
    .map((d) => ({ app: d.app.trim().toLowerCase(), ...(d.as === "org" ? { as: "org" } : { as: "member" }) }));
}

// ── an installed app's library card ────────────────────────────────────

export interface AppCardInput {
  slug: string;
  name: string;
  description: string;
  /** Where the runnable payload actually sits, for the reader. */
  bundleDir: string;
  entry: string;
  connectors: string[];
  tools: Array<{ name: string; description?: string }>;
  /** An icon.svg already beside the card, or one the bundle ships. */
  hasIcon?: boolean;
}

/** Frontmatter key marking a card we generated, so a rewrite never eats the
 *  user's own words. */
export const GENERATED_MARK = "glyphh-bundle";

/** The manifest an installed app's card carries. */
export function appCardManifest(card: AppCardInput): Record<string, unknown> {
  return {
    name: card.slug,
    kind: "glyphh-app",
    bundle: card.bundleDir,
    entry: card.entry,
    tools: card.tools.map((t) => t.name),
    dependencies: { connections: normalizeConnDeps(card.connectors) },
    ...(card.hasIcon ? { icon: "icon.svg" } : {}),
  };
}

/** The SKILL.md an installed app's card carries: what it is, which tools it
 *  answers to, and which accounts it needs. This is what a CLI agent reads. */
export function appCardSkillMd(card: AppCardInput): string {
  const tools = card.tools.length
    ? card.tools.map((t) => `- \`${t.name}\`${t.description ? ` — ${t.description}` : ""}`).join("\n")
    : "- This app declares no tools. Open it and the user works it by hand.";
  const connections = normalizeConnDeps(card.connectors);
  const conns = connections.length
    ? connections.map((c) => `- \`${c.app}\` — required; the user connects it on Settings → Customize → Connections.`).join("\n")
    : "- None. It needs no connected account.";
  const oneLine = (card.description || `The ${card.name} app.`).replace(/\s+/g, " ").trim();
  return [
    "---",
    `name: ${card.slug}`,
    `description: ${oneLine}`,
    "type: app",
    `generated: ${GENERATED_MARK}`,
    "---",
    "",
    `# ${card.name}`,
    "",
    "A Glyphh app installed from a bundle. Its face opens in the Apps work panel,",
    "and the agent drives it through the tools below.",
    "",
    "## Tools",
    "",
    tools,
    "",
    "## Connections",
    "",
    conns,
    "",
    "## Notes",
    "",
    `The runnable bundle lives at \`${card.bundleDir}\`. Reinstalling the app rewrites`,
    "this file; delete the `generated:` line to keep your own text.",
    "",
  ].join("\n");
}

// ── which row belongs to which folder ──────────────────────────────────

export interface AppRowShape {
  slug: string;
  kind?: string | null;
  nativeRef?: string | null;
  config?: { bundleDir?: string } | null;
}

/**
 * Is this saved-app row the one that bundle folder owns?
 *
 * A folder-built app carries `bundleDir`; an INSTALLED bundle never did, so
 * deleting a bundle typed app left its row behind and the app stayed on the
 * echo wall. Three ways to be the same app: the recorded bundle dir, an entry
 * file inside the folder, or the slug the folder is named — the last only for
 * a glyphh-app row, so a web or native row of the same name is never taken.
 */
export function rowOwnedByBundle(row: AppRowShape, dir: string): boolean {
  const here = path.resolve(dir);
  const recorded = row.config?.bundleDir;
  if (recorded && path.resolve(recorded) === here) return true;
  const ref = String(row.nativeRef || "");
  if (ref && path.resolve(ref).startsWith(here + path.sep)) return true;
  const isGlyphhApp = row.kind === "glyphh" || /\.html?$/i.test(ref);
  return isGlyphhApp && row.slug.toLowerCase() === path.basename(here).toLowerCase();
}

/**
 * The install folder an entry file belongs to: `<appsRoot>/<org>/<slug>` or
 * `<customRoot>/<slug>`. Null for anything outside both, so a folder the user
 * pointed us at is never removed with the app.
 */
export function payloadDirOf(nativeRef: string | null | undefined, appsRoot: string, customRoot: string): string | null {
  const ref = String(nativeRef || "").trim();
  if (!ref) return null;
  const full = path.resolve(ref);
  for (const [root, depth] of [[path.resolve(appsRoot), 2], [path.resolve(customRoot), 1]] as const) {
    if (!full.startsWith(root + path.sep)) continue;
    const rest = full.slice(root.length + 1).split(path.sep);
    if (rest.length <= depth) return null;
    if (rest.slice(0, depth).some((seg) => seg.startsWith("_") || seg === ".." || !seg)) return null;
    return path.join(root, ...rest.slice(0, depth));
  }
  return null;
}

// ── what an agent is allowed to author ─────────────────────────────────

/** Does this file set give an app a face? Without one it is not an app. */
export const hasAppFace = (paths: readonly string[]): boolean =>
  paths.some((rel) => /^(ui\/)?[\w.-]*\.html?$/i.test(rel));

/** A refusal that names the valid alternatives (his rule): an app with no
 *  face is a task when it runs headless, a skill when it is instructions. */
export const NO_FACE_ERROR =
  'an app needs a face: pass files with "ui/index.html" in them. Headless work is a task (type "task"); instructions an agent follows are a skill (type "skill")';

/** The file that makes a folder each kind. Shipping one inside another kind's
 *  files would retype the folder behind the user's back. */
export const MANIFEST_OF: Readonly<Record<string, BundleKind>> = {
  "app.json": "app",
  "task.json": "task",
  ".claude-plugin/plugin.json": "plugin",
};

/**
 * NO SMUGGLING THE SHAPE (his order, 2026-09-17): `type` is the only thing
 * that decides what a bundle is. A skill carrying app.json would land in the
 * apps home and be an app, which is the whole bug we are closing, so it is
 * refused with the type that would have done what was asked.
 */
export function checkNoForeignManifest(type: BundleKind, paths: readonly string[]): void {
  for (const rel of paths) {
    const kind = MANIFEST_OF[rel.toLowerCase()];
    if (kind && kind !== type) {
      throw new Error(`a ${type} cannot ship ${rel} — that file is what makes a folder ${kind === "app" ? "an" : "a"} ${kind}. Pass type:"${kind}" if that is what the user asked for`);
    }
  }
}

/**
 * A file path an agent may write into a bundle.
 *
 * Traversal, empty names and ABSOLUTE paths are refused rather than
 * reinterpreted: stripping the leading slash off "/etc/passwd" would quietly
 * file it inside the bundle, and silently turning a request into a different
 * one is exactly the class of bug this module exists to stop.
 */
export function checkBundlePath(rel: string): string {
  const clean = String(rel).trim().replace(/\\/g, "/");
  if (!clean || clean.startsWith("/") || /^[a-zA-Z]:/.test(clean) || clean.split("/").includes("..")) {
    throw new Error(`bad file path: ${rel} — bundle files take a relative path like "ui/index.html"`);
  }
  return clean;
}
