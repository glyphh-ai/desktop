/**
 * loop/artifacts.ts — `artifact_publish` and `artifact_read`, the loop's
 * ARTIFACT tools (his direction, 2026-10-05: artifacts like Claude's). A page,
 * a report or a file the model made becomes one of the user's Artifacts: a
 * file from the session's folder (confined to it like every file tool) or
 * inline content. With an `id`, publish UPDATES that artifact in place (his
 * report, 2026-10-05: an edit made a second artifact, which was wrong), and
 * `artifact_read` hands the model the one in hand to edit.
 *
 * LOCAL ONLY (2026-10-18): there is no gateway to post to. The HOST keeps the
 * artifacts — LoopDeps.artifacts, the app's own store on this machine — and
 * these tools only read the input, confine and cap it, and hand the bytes
 * over. A host without a store carries neither tool.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { insideFolder } from "./sandbox.js";
import type { BuiltinResult, ToolDef } from "./tools.js";

export const ARTIFACT_PUBLISH = "artifact_publish";
export const ARTIFACT_READ = "artifact_read";
export const ARTIFACT_SIZE_CAP = 25 * 1024 * 1024;
/** What artifact_read hands back inline at most; past it the text is cut and says so. */
export const ARTIFACT_READ_CAP = 1024 * 1024;
const NAME_MAX = 200;

export const ARTIFACT_PUBLISH_TOOL: ToolDef = {
  name: ARTIFACT_PUBLISH,
  description: "Publish a page, report or file to the user's Artifacts, where they can open it and comment on it, or UPDATE one in place. "
    + "Use this whenever the user asks to publish, save, hand over or send them a page, report, document or file, and whenever you have made a page or a file they should keep: "
    + "pass the file's path (inside the working folder) or the content inline, and a name. "
    + "When an artifact is already in hand (the user is editing one, or one was published earlier in this conversation), read it with artifact_read and publish the edited whole with its id: "
    + "that replaces its content under the same id, keeping its comments; a new name renames it, and the result gives the id it has from then on. Never create a new artifact for an edit. "
    + "Never search for another publish or save tool: this is the one. "
    + "The type comes from the name's extension (a name without one takes the file's, or the mime's). Returns the artifact's id and name; tell the user it is in their Artifacts.",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The id of the artifact in hand, to update it in place. Omit to create a new one." },
      path: { type: "string", description: "A file in the working folder to publish (25 MB at most). Give path or content, not both." },
      content: { type: "string", description: "The text to publish inline (an HTML page, markdown, CSV...). On an update, the whole new content." },
      name: { type: "string", description: "The artifact's name with its extension, e.g. report.html. Required to create; on an update it renames, omit to keep the name." },
      mime: { type: "string", description: "The media type, used only to pick the extension of a name given without one." },
    },
    required: [],
  },
};

export const ARTIFACT_READ_TOOL: ToolDef = {
  name: ARTIFACT_READ,
  description: "Read one of the user's Artifacts: its record (id, name, mime, size) and its text. "
    + "Use it before editing an artifact in hand, then publish the edited whole with artifact_publish and the same id; never create a new artifact for an edit. "
    + "Text is returned for text, HTML, markdown, JSON, SVG and the like; for a binary file only its size and type come back.",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The artifact's id." },
    },
    required: ["id"],
  },
};

const MIMES: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json",
  md: "text/markdown", markdown: "text/markdown", txt: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values",
  xml: "application/xml", yaml: "application/yaml", yml: "application/yaml", svg: "image/svg+xml", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", zip: "application/zip",
  ts: "text/plain", py: "text/plain", sh: "text/plain", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav",
};

/** The media type the name's extension says, else octet-stream. */
export function inferMime(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIMES[ext] ?? "application/octet-stream";
}

const TEXT_MIMES = new Set(["application/json", "application/xml", "application/yaml", "application/javascript", "application/xhtml+xml", "image/svg+xml"]);

/** Whether artifact_read decodes the bytes as UTF-8 text: text/*, JSON, XML, YAML, SVG, HTML and markdown among them. */
export function isTextMime(mime: string): boolean {
  const type = mime.split(";")[0]!.trim().toLowerCase();
  return type.startsWith("text/") || TEXT_MIMES.has(type) || type.endsWith("+json") || type.endsWith("+xml");
}

/** The extension a media type implies ("" when none is known). */
export function extensionFor(mime: string): string {
  const type = mime.split(";")[0]!.trim().toLowerCase();
  const hit = Object.entries(MIMES).find(([, m]) => m === type);
  return hit ? `.${hit[0]}` : "";
}

/** The name the store gets: as given when it carries an extension, else the
 *  published file's extension, else the stated mime's. */
export function nameWithExtension(name: string, file: string | null, mime: string | null): string {
  if (path.extname(name)) return name;
  const ext = (file ? path.extname(file) : "") || (mime ? extensionFor(mime) : "");
  return `${name}${ext}`;
}

/** An artifact's record, as the host's store answers it (the fields the model needs). */
export interface ArtifactMeta { id: string; name: string; mime: string; sizeBytes: number; updatedAt: string }

/** THE HOST'S STORE (LoopDeps.artifacts). The id is the store's own; a rename
 *  may change it, so publish answers the record under the id it has now. */
export interface LoopArtifacts {
  /** Create (id null) or replace in place (id set; a name renames it). */
  publish: (input: { id: string | null; name: string | null; bytes: Uint8Array }) => Promise<ArtifactMeta>;
  /** The record and its bytes; throws when there is no such artifact. */
  read: (id: string) => Promise<{ meta: ArtifactMeta; bytes: Uint8Array }>;
}

export interface PublishContext {
  workdir: string;
  /** A Code turn has a folder a path may name; a Work turn publishes inline content only. */
  hasFolder: boolean;
  artifacts: LoopArtifacts | null;
}

export type ReadContext = Pick<PublishContext, "artifacts">;

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");

/** The input, read: the name checked (required unless updating), exactly one source, the bytes within the cap and inside the folder. */
async function sourceOf(o: Record<string, unknown>, ctx: PublishContext): Promise<{ id: string | null; name: string | null; bytes: Uint8Array } | { error: string }> {
  const id = str(o, "id").trim() || null;
  const given = str(o, "name").replace(/\s+/g, " ").trim() || null;
  if (!id && !given) return { error: `name is required (1 to ${NAME_MAX} characters), with its extension; or give the id of the artifact to update` };
  if (given && given.length > NAME_MAX) return { error: `name is 1 to ${NAME_MAX} characters` };
  const file = str(o, "path");
  const inline = typeof o.content === "string" ? (o.content as string) : null;
  if ((file && inline !== null) || (!file && inline === null)) return { error: "give path (a file in the working folder) or content (inline text), one of them" };
  const name = given ? nameWithExtension(given, file || null, str(o, "mime") || null) : null;
  if (inline !== null) {
    if (Buffer.byteLength(inline, "utf8") > ARTIFACT_SIZE_CAP) return { error: "an artifact is 25 MB at most" };
    return { id, name, bytes: Buffer.from(inline, "utf8") };
  }
  if (!ctx.hasFolder) return { error: "this session has no folder: publish the content inline" };
  const target = await insideFolder(ctx.workdir, file);
  const stat = await fs.stat(target);
  if (!stat.isFile()) return { error: `${file} is not a file` };
  if (stat.size > ARTIFACT_SIZE_CAP) return { error: `${file} is ${Math.round(stat.size / (1024 * 1024))} MB; an artifact is 25 MB at most` };
  return { id, name, bytes: await fs.readFile(target) };
}

const NO_STORE = "Artifacts are not kept on this host.";

export async function runArtifactPublish(input: unknown, ctx: PublishContext): Promise<BuiltinResult> {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (!ctx.artifacts) return { text: NO_STORE, failed: true };
  try {
    const src = await sourceOf(o, ctx);
    if ("error" in src) return { text: src.error, failed: true };
    let meta: ArtifactMeta;
    try {
      meta = await ctx.artifacts.publish({ id: src.id, name: src.name, bytes: src.bytes });
    } catch (err) {
      return { text: `${src.id ? "Updating" : "Publishing"} ${src.name ?? src.id ?? ""} failed: ${err instanceof Error ? err.message : String(err)}`, failed: true };
    }
    const out = { id: meta.id, name: meta.name, mime: meta.mime, sizeBytes: meta.sizeBytes };
    return { text: `${src.id ? "Updated" : "Published"} ${meta.name} to the user's Artifacts\n${JSON.stringify(out)}`, failed: false };
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), failed: true };
  }
}

/** The record and, for a text-like mime, the content decoded as UTF-8; a binary one is described by size and type. */
export async function runArtifactRead(input: unknown, ctx: ReadContext): Promise<BuiltinResult> {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const id = str(o, "id").trim();
  if (!id) return { text: "id is required: the artifact to read", failed: true };
  if (!ctx.artifacts) return { text: NO_STORE, failed: true };
  try {
    const { meta, bytes } = await ctx.artifacts.read(id);
    if (!isTextMime(meta.mime)) {
      return { text: JSON.stringify({ meta, note: `${meta.name} is ${meta.mime}, ${meta.sizeBytes} bytes: no text to show. Publish new bytes from a file to replace it.` }), failed: false };
    }
    const raw = Buffer.from(bytes);
    const cut = raw.length > ARTIFACT_READ_CAP;
    const text = raw.subarray(0, ARTIFACT_READ_CAP).toString("utf8");
    return { text: JSON.stringify({ meta, text, ...(cut ? { truncated: true, note: `the first ${ARTIFACT_READ_CAP} of ${raw.length} bytes; an update from this text would lose the rest` } : {}) }), failed: false };
  } catch (err) {
    return { text: `Reading artifact ${id} failed: ${err instanceof Error ? err.message : String(err)}`, failed: true };
  }
}
