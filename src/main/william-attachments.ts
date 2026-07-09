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
    title: mode === "folder" ? "Add folder — William can read it" : "Attach to William",
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

export interface VisionBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

/** Attached images as API vision blocks (base64), size- and count-capped.
 *  Oversize or unreadable images just stay path refs in the manifest. */
export function attachmentVisionBlocks(atts: AttachRef[]): VisionBlock[] {
  const blocks: VisionBlock[] = [];
  for (const a of atts) {
    if (a.kind !== "image" || blocks.length >= MAX_VISION_BLOCKS) continue;
    const media = IMAGE_EXT[extname(a.path).toLowerCase()];
    if (!media) continue;
    try {
      const buf = readFileSync(a.path);
      if (!buf.length || buf.length > MAX_VISION_BYTES) continue;
      blocks.push({ type: "image", source: { type: "base64", media_type: media, data: buf.toString("base64") } });
    } catch { /* unreadable — path ref still in the manifest */ }
  }
  return blocks;
}
