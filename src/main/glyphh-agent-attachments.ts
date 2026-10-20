/**
 * Composer attachments — what the user pastes, picks, or drops onto the
 * agent composer before a run.
 *
 * Three kinds ride the run payload as { kind, path, name } refs:
 *   image  — pasted screenshots land as PNGs in the user-scoped attachments
 *            dir; picked/dropped image files stay in place. On the frontier
 *            lane they become REAL vision blocks (base64) on the user turn;
 *            the router escalates automatically so the model can see them.
 *   file   — path reference; the loop reads it with read_file (attached
 *            paths gate as plain reads even outside the working folder).
 *   folder — path reference; list_dir / search_files / read_file work
 *            through it the same way.
 *
 * Nothing is copied into the project and nothing rides the chat store but
 * the refs — the bytes stay where the user put them.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { dialog } from "electron";
import { userScopedPath } from "./app-paths";

export interface AttachRef { kind: "image" | "file" | "folder"; path: string; name: string }

const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const MAX_VISION_BYTES = 5 * 1024 * 1024; // API block ceiling — bigger images ride as path refs only
const MAX_VISION_BLOCKS = 8;
const MAX_PASTE_BYTES = 12 * 1024 * 1024;

/** Stat + extension → attachment kind. Nonexistent paths drop silently
 *  (a stale drop shouldn't kill the send). */
export function classifyPaths(paths: string[]): AttachRef[] {
  const out: AttachRef[] = [];
  for (const p of paths) {
    if (!p) continue;
    try {
      const st = statSync(p);
      const kind: AttachRef["kind"] = st.isDirectory() ? "folder" : IMAGE_EXT[extname(p).toLowerCase()] ? "image" : "file";
      out.push({ kind, path: p, name: basename(p) });
    } catch { /* gone between drop and classify */ }
  }
  return out;
}

/** OS picker. "files" and "folder" narrow the dialog (the + menu offers
 *  them as separate actions); default allows both in one multi-select. */
export async function pickAttachments(mode?: "files" | "folder"): Promise<AttachRef[]> {
  const properties: Array<"openFile" | "openDirectory" | "multiSelections"> =
    mode === "files" ? ["openFile", "multiSelections"]
    : mode === "folder" ? ["openDirectory", "multiSelections"]
    : ["openFile", "openDirectory", "multiSelections"];
  const r = await dialog.showOpenDialog({
    title: mode === "folder" ? "Add folder — Glyphh can read it" : "Attach to Glyphh",
    buttonLabel: mode === "folder" ? "Add folder" : "Attach",
    properties,
  });
  return r.canceled ? [] : classifyPaths(r.filePaths);
}

/** Pasted image bytes → PNG in the user-scoped attachments dir. */
export function saveClipboardImage(bytes: ArrayBuffer): AttachRef {
  const buf = Buffer.from(bytes);
  if (!buf.length) throw new Error("empty image");
  if (buf.length > MAX_PASTE_BYTES) throw new Error("image too large (12MB cap)");
  const dir = userScopedPath("attachments");
  mkdirSync(dir, { recursive: true });
  const name = `paste-${Date.now().toString(36)}.png`;
  const path = join(dir, name);
  writeFileSync(path, buf);
  return { kind: "image", path, name };
}

/** Drop refs whose paths no longer exist (renderer chips can outlive files). */
export function validAttachments(atts: unknown): AttachRef[] {
  if (!Array.isArray(atts)) return [];
  const refs: AttachRef[] = [];
  for (const a of atts as Array<Record<string, unknown>>) {
    const path = String(a?.path || "");
    const kind = String(a?.kind || "");
    if (!path || !existsSync(path)) continue;
    if (kind !== "image" && kind !== "file" && kind !== "folder") continue;
    refs.push({ kind, path, name: String(a?.name || basename(path)) });
  }
  return refs;
}

/** The prompt-visible manifest of what was attached, with usage guidance. */
export function attachmentPromptBlock(atts: AttachRef[]): string {
  if (!atts.length) return "";
  const lines = atts.map((a) => `${a.kind}: ${a.path}`);
  return [
    "<attachments>",
    ...lines,
    "</attachments>",
    "(The user attached these. Files/folders: read them with read_file / list_dir / search_files — attached paths are readable even outside the working folder. Attached images are already visible to you on this turn.)",
  ].join("\n");
}

/** A WORK turn has no read tools, so an attached file has to arrive as CONTENT
 *  (his push-back, 2026-09-29: "shouldn't it still have the + button to add
 *  files and photos etc"). The text is inlined into the message, fenced and
 *  named, with the same caps a prompt can carry: a folder cannot be inlined and
 *  a binary would be noise, so both are named and skipped. Code sessions keep
 *  the path manifest instead — their read tools open the file themselves, which
 *  beats pouring a megabyte into every turn of the conversation. */
const MAX_INLINE_CHARS = 20_000;      // per file
const MAX_INLINE_TOTAL = 60_000;      // per turn
/** Extensions we will inline. A deliberate list: anything else is either
 *  binary or better left to a Code session's tools. */
const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".rst", ".log", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini",
  ".env", ".xml", ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh", ".bash", ".zsh", ".sql", ".graphql",
  ".vue", ".svelte", ".astro", ".diff", ".patch", ".conf", ".properties",
]);

export function attachmentInlineText(atts: AttachRef[]): string {
  const parts: string[] = [];
  const skipped: string[] = [];
  let budget = MAX_INLINE_TOTAL;
  for (const a of atts) {
    if (a.kind === "image") continue;               // rides as a vision block
    if (a.kind === "folder") { skipped.push(`${a.name} (a folder)`); continue; }
    if (!TEXT_EXT.has(extname(a.path).toLowerCase())) { skipped.push(`${a.name} (not a text file)`); continue; }
    if (budget <= 0) { skipped.push(`${a.name} (the turn was already full)`); continue; }
    try {
      const raw = readFileSync(a.path, "utf-8");
      const clipped = raw.length > MAX_INLINE_CHARS ? `${raw.slice(0, MAX_INLINE_CHARS)}\n… (truncated, ${raw.length} chars)` : raw;
      const take = clipped.slice(0, budget);
      budget -= take.length;
      parts.push(`<file name="${a.name}" path="${a.path}">\n${take}\n</file>`);
    } catch { skipped.push(`${a.name} (unreadable)`); }
  }
  if (!parts.length && !skipped.length) return "";
  const note = skipped.length
    ? `\n(Not included: ${skipped.join(", ")}. Start a Code session to work on files and folders directly.)`
    : "";
  return `${parts.length ? `<attachments>\n${parts.join("\n")}\n</attachments>` : "<attachments/>"}${note}`;
}

/** An attached image, decoded for the wire: the harness run body's `images`
 *  shape (`{mediaType, data}`, base64, no `data:` prefix). */
export interface ImageAttachment { mediaType: string; data: string }

/**
 * Attached images as base64 payloads, size- and count-capped. Oversize,
 * unreadable, or non-image attachments just stay path refs in the manifest —
 * the agent can still read them with read_file, it simply can't SEE them.
 *
 * The caps sit under the pod's own (8 images, ~7.5 MiB of base64 each), so a
 * turn this side accepts is never one the pod will reject.
 */
export function attachmentImageRefs(atts: AttachRef[]): ImageAttachment[] {
  const images: ImageAttachment[] = [];
  for (const a of atts) {
    if (a.kind !== "image" || images.length >= MAX_VISION_BLOCKS) continue;
    const mediaType = IMAGE_EXT[extname(a.path).toLowerCase()];
    if (!mediaType) continue;
    try {
      const buf = readFileSync(a.path);
      if (!buf.length || buf.length > MAX_VISION_BYTES) continue;
      images.push({ mediaType, data: buf.toString("base64") });
    } catch { /* unreadable — path ref still in the manifest */ }
  }
  return images;
}
