/**
 * artifact-rules.ts — THE ARTIFACTS PANEL'S RULES, pure (his order,
 * 2026-10-05: "on the web and desktop i want there to also be an artifacts
 * web panel… We should allow the comment and share feature… The comments
 * need a overlay draw effect with the comment allowing others to contribute
 * comments, then to send to glyphh for editing").
 *
 * Everything the panel decides without a DOM lives here so the list, the
 * viewer and the comment overlay read one answer and the tests pin it: what
 * an artifact IS (code / doc / image / file), newest-first grouped by month,
 * a drawn region as FRACTIONS of the page (so it survives a resize), and the
 * exact message "Send to Glyphh" puts in the composer. artifacts-panel.ts
 * paints exactly this, through `window.glyphh.artifacts*`.
 *
 * LOCAL ONLY (2026-10-18): artifacts are files on this machine with one
 * user, so there is no sharing, no access level, no owner and no
 * "Shared with you" — one list, everything in it the user's own.
 *
 * Unit-tested in test/main/artifact-rules.test.ts.
 */

/** One artifact row (main/artifacts-ipc.ts maps the local file to it). */
export interface ArtifactMeta {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  sessionId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommentRegion { x: number; y: number; w: number; h: number }
export interface CommentAuthor { id: string; name: string; avatarUrl?: string | null }
export interface ArtifactComment {
  id: string;
  author: CommentAuthor;
  region: CommentRegion | null;
  text: string;
  resolved: boolean;
  createdAt: string;
  replies: ArtifactComment[];
  /** Glyphh's own reply in the thread (posted back by this client). */
  agent?: boolean;
}

/** The list's type icon: a page or code, a document, an image, or a file. */
export type ArtifactKind = "code" | "doc" | "image" | "file";

const extOf = (name: string): string => (String(name || "").split(".").length > 1 ? String(name).split(".").pop()!.toLowerCase() : "");
const CODE_EXT = new Set(["html", "htm", "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "css", "py", "rb", "go", "rs", "java", "sh", "svg", "xml", "yaml", "yml", "toml", "sql", "c", "h", "cpp", "swift", "kt"]);
const DOC_EXT = new Set(["md", "markdown", "txt", "pdf", "doc", "docx", "rtf", "csv", "tsv"]);

export function artifactKind(a: Pick<ArtifactMeta, "mime" | "name">): ArtifactKind {
  const mime = String(a.mime || "").toLowerCase();
  const ext = extOf(a.name);
  if (mime.startsWith("image/")) return "image";
  if (mime === "text/html" || mime === "application/xhtml+xml" || mime === "image/svg+xml" || mime === "application/json" || mime === "application/javascript" || mime === "text/javascript" || mime === "text/css") return "code";
  if (mime === "text/markdown" || mime === "text/plain" || mime === "application/pdf" || mime.startsWith("text/")) return CODE_EXT.has(ext) ? "code" : "doc";
  if (CODE_EXT.has(ext)) return "code";
  if (DOC_EXT.has(ext)) return "doc";
  return "file";
}

/** How the viewer paints the bytes: a page runs in the sandboxed frame, an
 *  image is an <img>, markdown and text are read as text, anything else is a
 *  download line. */
export type ArtifactRender = "frame" | "image" | "text" | "download";
export function artifactRender(a: Pick<ArtifactMeta, "mime" | "name">): ArtifactRender {
  const mime = String(a.mime || "").toLowerCase();
  const ext = extOf(a.name);
  if (mime.startsWith("image/") && mime !== "image/svg+xml") return "image";
  if (mime === "text/html" || mime === "application/xhtml+xml" || mime === "image/svg+xml" || ext === "html" || ext === "htm") return "frame";
  if (mime === "application/pdf") return "frame";
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/javascript" || CODE_EXT.has(ext) || DOC_EXT.has(ext)) return "text";
  return "download";
}

/** The search box: name, type — case-insensitive, every word must hit. */
export function searchArtifacts(list: ReadonlyArray<ArtifactMeta>, query: string): ArtifactMeta[] {
  const words = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...list];
  return list.filter((a) => {
    const hay = `${a.name} ${a.mime} ${artifactKind(a)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const stamp = (iso: string): number => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
/** The row's clock: last edit, else creation. */
export const artifactTime = (a: Pick<ArtifactMeta, "updatedAt" | "createdAt">): number => stamp(a.updatedAt) || stamp(a.createdAt);

/** Newest first. */
export function sortNewest(list: ReadonlyArray<ArtifactMeta>): ArtifactMeta[] {
  return [...list].sort((a, b) => artifactTime(b) - artifactTime(a) || a.name.localeCompare(b.name));
}

export interface ArtifactGroup { key: string; label: string; items: ArtifactMeta[] }
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The month heading a row sits under: "August" this year, "August 2025" otherwise. */
export function monthLabel(ts: number, now: number = Date.now()): string {
  if (!ts) return "Undated";
  const d = new Date(ts);
  const y = d.getFullYear();
  return y === new Date(now).getFullYear() ? MONTHS[d.getMonth()] : `${MONTHS[d.getMonth()]} ${y}`;
}

/** Newest first, grouped by month (the screenshot's "August" / "June" heads). */
export function groupByMonth(list: ReadonlyArray<ArtifactMeta>, now: number = Date.now()): ArtifactGroup[] {
  const out: ArtifactGroup[] = [];
  for (const a of sortNewest(list)) {
    const ts = artifactTime(a);
    const d = new Date(ts);
    const key = ts ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` : "undated";
    let g = out[out.length - 1];
    if (!g || g.key !== key) { g = { key, label: monthLabel(ts, now), items: [] }; out.push(g); }
    g.items.push(a);
  }
  return out;
}

/** "Edited Aug 10" — the row's right-hand line. */
export function editedLabel(a: Pick<ArtifactMeta, "updatedAt" | "createdAt">, now: number = Date.now()): string {
  const ts = artifactTime(a);
  if (!ts) return "Edited —";
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const short = `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
  return `Edited ${sameYear ? short : `${short}, ${d.getFullYear()}`}`;
}

// ── THE DRAWN REGION: fractions of the frame, so it survives a resize ───────

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/** A drag from (x0,y0) to (x1,y1) in frame pixels over a w×h frame → the
 *  region as fractions, normalized (any corner first), clamped to the frame. */
export function regionFromDrag(x0: number, y0: number, x1: number, y1: number, w: number, h: number): CommentRegion {
  if (!(w > 0) || !(h > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  const l = clamp01(Math.min(x0, x1) / w), t = clamp01(Math.min(y0, y1) / h);
  const r = clamp01(Math.max(x0, x1) / w), b = clamp01(Math.max(y0, y1) / h);
  return { x: round4(l), y: round4(t), w: round4(r - l), h: round4(b - t) };
}

/** Back to pixels for the frame's current size. */
export function regionToRect(region: CommentRegion, w: number, h: number): { left: number; top: number; width: number; height: number } {
  return { left: region.x * w, top: region.y * h, width: region.w * w, height: region.h * h };
}

/** A drag too small to mean anything is a click, not a region. */
export const MIN_REGION_PX = 6;
export function regionIsReal(region: CommentRegion, w: number, h: number): boolean {
  return region.w * w >= MIN_REGION_PX && region.h * h >= MIN_REGION_PX;
}

/** Where the pin sits: the region's right edge, vertically centred (the
 *  screenshot); a comment with no region pins top-left. */
export function pinPoint(region: CommentRegion | null): { x: number; y: number } {
  if (!region) return { x: 0, y: 0 };
  return { x: round4(clamp01(region.x + region.w)), y: round4(clamp01(region.y + region.h / 2)) };
}

/** "(12%, 30%, 40%, 10%)" — the selected area, as the message names it. */
export function regionLabel(region: CommentRegion | null): string {
  if (!region) return "";
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  return `${pct(region.x)},${pct(region.y)},${pct(region.w)},${pct(region.h)}`;
}

// ── THE MESSAGES THE PANEL SENDS THE AGENT ──────────────────────────────────

/** "Send to Glyphh": the thread's text + region + the artifact into one edit
 *  request ("Edit the artifact <name>: in the selected area (<x%,y%,w%,h%>):
 *  <text>"); replies ride under the opening line. */
export function editPrompt(a: Pick<ArtifactMeta, "id" | "name">, region: CommentRegion | null, text: string, replies: ReadonlyArray<string> = []): string {
  const where = region ? ` in the selected area (${regionLabel(region)}):` : "";
  const body = String(text || "").trim();
  const more = replies.map((r) => String(r || "").trim()).filter(Boolean);
  const tail = more.length ? `\n${more.map((r) => `- ${r}`).join("\n")}` : "";
  return `Edit the artifact ${a.name}:${where} ${body}${tail}`;
}

/** "Start chat": the first context line of the session the viewer opens. */
export function startChatLine(a: Pick<ArtifactMeta, "id" | "name">): string {
  return `Working from the artifact ${a.name}`;
}

/** THE ARTIFACT ID IS HIDDEN CONTEXT (his order, 2026-10-05: "no need to put
 *  the id in the chat… can't that be part of the prompt but hidden from the
 *  user?"). The visible message names the artifact; this standing line rides
 *  in the turn's hidden preamble (code.ts steer) so the agent knows which
 *  record to read or update. '' when the session has no artifact in hand. */
export function artifactStandingLine(ref: { id: string; name: string } | null | undefined): string {
  if (!ref || !ref.id) return "";
  return `The artifact in hand is "${ref.name}" — artifact id ${ref.id}. Read it with artifact_read and apply edits IN PLACE with artifact_publish passing id=${ref.id}; never create a new artifact for an edit, and never show the id to the user.`;
}

/** The thread's whole text, opening line and replies, for the Send checkbox's preview. */
export function threadText(c: Pick<ArtifactComment, "text" | "replies">): string[] {
  return [c.text, ...(c.replies ?? []).map((r) => r.text)].map((t) => String(t || "").trim()).filter(Boolean);
}

/** "now" / "3m" / "2h" / "4d" / a date — the thread's time stamps. */
export function commentAge(iso: string, now: number = Date.now()): string {
  const ts = stamp(iso);
  if (!ts) return "";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(ts).toLocaleDateString();
}

/** The author's avatar fallback: an initial. */
export function initialOf(name: string): string {
  const t = String(name || "").trim();
  return t ? t[0].toUpperCase() : "?";
}

/** Open threads first (newest last, like a conversation); resolved after. */
export function orderThreads(list: ReadonlyArray<ArtifactComment>): ArtifactComment[] {
  const byTime = (a: ArtifactComment, b: ArtifactComment): number => stamp(a.createdAt) - stamp(b.createdAt);
  return [...list.filter((c) => !c.resolved).sort(byTime), ...list.filter((c) => c.resolved).sort(byTime)];
}

/** The pin's number: its place among the open threads, 1-based. */
export function pinNumbers(list: ReadonlyArray<ArtifactComment>): Map<string, number> {
  const out = new Map<string, number>();
  orderThreads(list).forEach((c, i) => out.set(c.id, i + 1));
  return out;
}
