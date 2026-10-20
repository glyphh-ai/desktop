/**
 * house-store.ts — THE HOUSE APPS' ONE STORE (his order, 2026-10-06: "cloud
 * is first and every surface pulls from it").
 *
 * Design, Slides, Images, Video, Audio and Drive keep their records in the
 * member library (server member_library.py; db as truth, files on R2) and
 * nowhere else: no app-data folder on the Mac, no relay to a desktop. The
 * desktop's main process (main/house-store.ts) and the web (web/src/
 * house-store-web.js) both build this store over the SDK's
 * `client.memberLibrary` and the server's byte lane, and the renderer keeps
 * calling the same doors it always did (design*, gpoint*, media*, gdrive*).
 *
 *   design  id = `<stem>.json`     data { title, document, folderId }       files assets/<assetId>
 *   deck    id = `<stem>.html`     data { title, slides, sizeBytes, folderId }  files deck.html
 *   image / video / audio
 *           id = the file name     data { title, mime, sizeBytes, width, height, durationMs, meta, folderId }
 *                                  files <id>; the door's id is `<kind>/<id>` (what Drive and the panels carry)
 *   file    id = the file name     data { name, mime, sizeBytes, folderId }  files <id>   (a PDF export)
 *   folder  id = uuid              data { name, parentId }                   no files
 *
 * Drive is the view across all of them: the folders, and every record by its
 * folderId. Clocks: every write is a put at this writer's clock (epoch ms,
 * strictly increasing within a process); the server applies only a strictly
 * newer one and answers `applied: false` otherwise, which a door reports as
 * the STALE line. A delete is a tombstone at the same clock.
 *
 * Pure over `lib` (the SDK's member-library client), `bytes` (the byte lane)
 * and `sha256`: test/main/house-store.test.ts runs it over fakes.
 */

import { deckFileName, deckTitle, lockDeckSections, normalizeDeckHtml, slideCount, starterDeck } from "./deck-document.js";

export type HouseKind = "design" | "deck" | "image" | "video" | "audio" | "file" | "folder";
export type MediaKind = "image" | "video" | "audio";
export const MEDIA_KINDS: readonly MediaKind[] = ["image", "video", "audio"];

/** THE HOUSE APPS ARE REAL APPS (his law, 2026-10-06: "the apps themselves
 *  carry the skill for them and the tools each support"): six default apps on
 *  the hub, installed for every member as cloud INSTANCES by the server, each
 *  with its tools and SKILL.md. Nothing here synthesizes a row for them — the
 *  list is the instances, like any app (shared/app-instances.ts mergeAppRows).
 *  What IS theirs on every surface: the slug names the built-in work panel
 *  that shows the member's records of that kind, so an instance of one of
 *  these slugs opens that panel, never the instance's ui frame. The renderer
 *  keeps its own copy of this table (help/house-relay.ts — it never imports
 *  src/shared); test/main/house-relay.test.ts pins the two equal. */
export const HOUSE_VIEW_OF_APP: Readonly<Record<string, string>> = Object.freeze({
  design: "gdesign", slides: "gpoint", images: "gimage", video: "gvideo", audio: "gsound", drive: "gdrive",
});
/** The house panel an app slug names, or null for any other app. */
export const houseViewOfApp = (slug: unknown): string | null => HOUSE_VIEW_OF_APP[String(slug ?? "").toLowerCase()] ?? null;
/** The house app that owns each media kind. */
export const APP_OF_MEDIA: Readonly<Record<MediaKind, string>> = Object.freeze({ image: "images", video: "video", audio: "audio" });

/** What the media libraries hold, by extension. */
export const MEDIA_MIME: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
});

export const extOf = (name: string): string => { const i = name.lastIndexOf("."); return i > 0 && i < name.length - 1 ? name.slice(i).toLowerCase() : ""; };
export const mediaMimeOf = (name: string): string => MEDIA_MIME[extOf(name)] ?? "";
export function mediaKindOfMime(mime: string): MediaKind | null {
  return mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : null;
}

/** Design refs are bare names — strip any path, scrub, force `.json`. */
export function designFileName(name: unknown): string {
  const base = String(name ?? "").trim().split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.json$/i, "").replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
  if (!stem) throw new Error("a design needs a name");
  return `${stem}.json`;
}

/** A library id (the server's `^[A-Za-z0-9_.-]{1,96}$`) from any file name: the
 *  extension kept, the rest scrubbed. "Sunset beach.PNG" → "Sunset-beach.PNG". */
export function libraryIdOf(name: string): string {
  const ext = extOf(name);
  const stem = (ext ? name.slice(0, -ext.length) : name).split(/[\\/]/).pop() ?? "";
  const clean = stem.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, Math.max(1, 96 - ext.length)) || "untitled";
  return `${clean}${ext}`;
}

// ── records ──────────────────────────────────────────────────────────────────

export interface DesignAsset { id: string; kind: string; title: string; contentType: string; sizeBytes: number }
export interface DesignDocLike { name?: string; assets?: DesignAsset[] }
export interface DesignRecord { title: string; document: DesignDocLike; folderId: string | null }
export interface DeckRecord { title: string; slides: number; sizeBytes: number; folderId: string | null }
export interface MediaRecord {
  title: string; mime: string; sizeBytes: number;
  width: number | null; height: number | null; durationMs: number | null;
  meta: Record<string, unknown>; folderId: string | null;
}
export interface FileRecord { name: string; mime: string; sizeBytes: number; folderId: string | null }
export interface FolderRecord { name: string; parentId: string | null }

/** A media row as the panels and Drive read it (the shape media-local.ts gave, kept). */
export interface MediaAssetRow {
  id: string; kind: MediaKind; title: string; mime: string; sizeBytes: number;
  width: number | null; height: number | null; durationMs: number | null;
  status: "ready"; meta: Record<string, unknown>; updatedAt: string; folderId: string | null;
}
export interface DriveFolder { id: string; name: string; parentId: string | null }
export interface DriveEntry {
  kind: "slides" | "design" | "media" | "file";
  subkind?: MediaKind; mime?: string;
  ref: string; file: string; title: string;
  sizeBytes: number; folderId: string | null; updatedAt: string; slides?: number;
}

// ── the lanes ────────────────────────────────────────────────────────────────

export interface HouseFile { path: string; size: number; mtime: number; sha256: string }
export interface HouseRow<T = unknown> { id: string; updatedAt: number; data: T }
export interface HouseItem<T = unknown> extends HouseRow<T> { files: HouseFile[] }
/** A row as the server lists it: data on a live row; a tombstone (the `since` page) carries `deletedAt` and none. */
export interface HouseListed<T = unknown> { id: string; updatedAt: number; data?: T; deletedAt?: string | number | null }

/** The slice of `client.memberLibrary` the store uses. `kind` is a string
 *  here on purpose: the SDK's own union names these kinds since its
 *  house-store branch, and the client's methods satisfy this shape either way. */
export interface HouseLib {
  list<T = unknown>(kind: string, opts?: { since?: number }): Promise<HouseListed<T>[]>;
  get<T = unknown>(kind: string, id: string): Promise<HouseItem<T>>;
  put<T = unknown>(kind: string, id: string, input: { data: T; files?: HouseFile[]; updatedAt: number }): Promise<{ applied: boolean; item: HouseItem<T> }>;
  remove(kind: string, id: string, input?: { updatedAt?: number }): Promise<void>;
  files(kind: string, id: string, paths: string[]): Promise<{ put: Record<string, string>; get: Record<string, string> }>;
}

/** The bytes of an item's file, in and out. */
export interface HouseBytes {
  get(kind: HouseKind, id: string, path: string): Promise<Uint8Array>;
  put(kind: HouseKind, id: string, path: string, bytes: Uint8Array, mime: string): Promise<void>;
}

export interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array }): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
}

/**
 * THE BYTES GO THROUGH THE SERVER on both surfaces: `GET/PUT /api/library/v2/
 * <kind>/<id>/files/<path>` with the member's bearer, on their own prefix
 * (member_library.py item_file_get/put). A browser cannot reach the presigned
 * R2 URLs cross-origin, and this lane stores the file's own content type,
 * which the presigned GET a panel plays from then serves.
 */
const serverLine = async (res: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<string | null> => {
  try { const j = JSON.parse(new TextDecoder().decode(await res.arrayBuffer())) as { detail?: unknown }; return typeof j?.detail === "string" && j.detail ? j.detail : null; }
  catch { return null; }
};

export function serverLaneBytes(deps: { apiUrl: string; token: () => Promise<string | null>; fetchImpl: FetchLike }): HouseBytes {
  const base = deps.apiUrl.replace(/\/+$/, "");
  const url = (kind: string, id: string, path: string): string =>
    `${base}/api/library/v2/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = async (extra: Record<string, string> = {}): Promise<Record<string, string>> => {
    const t = await deps.token().catch(() => null);
    return t ? { authorization: `Bearer ${t}`, ...extra } : extra;
  };
  return {
    async get(kind, id, path) {
      const res = await deps.fetchImpl(url(kind, id, path), { method: "GET", headers: await headers() });
      if (!res.ok) throw new Error(res.status === 404 ? "that file is no longer in your library" : `download ${path}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async put(kind, id, path, bytes, mime) {
      const res = await deps.fetchImpl(url(kind, id, path), { method: "PUT", headers: await headers({ "content-type": mime || "application/octet-stream" }), body: bytes });
      // The cap is the server's and per kind (a video 2 GB, a skill 25 MB): its line names both.
      if (!res.ok) throw new Error(res.status === 400 ? await serverLine(res) ?? "that file is too large for the library" : `upload ${path}: HTTP ${res.status}`);
    },
  };
}

// ── small codecs (node and browser alike) ────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const dataUrl = (mime: string, bytes: Uint8Array): string => `data:${mime || "application/octet-stream"};base64,${bytesToBase64(bytes)}`;

// ── the store ────────────────────────────────────────────────────────────────

export interface HouseStoreDeps {
  lib: HouseLib;
  bytes: HouseBytes;
  sha256(bytes: Uint8Array): Promise<string>;
  now?: () => number;
  uuid?: () => string;
}

/** The one line a stale write answers: the server holds a strictly newer copy. */
export const HOUSE_STALE_LINE = "the server holds a newer copy — reload and try again";
/** A thumbnail is not worth a huge read. */
export const THUMB_BYTES_CAP = 64 * 1024 * 1024;

type Ok<T> = { ok: true } & T;
type Fail<E = Record<string, never>> = { ok: false; error: string } & E;
export type Answer<T, E = Record<string, never>> = Ok<T> | Fail<E>;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isNotFound = (err: unknown): boolean => {
  const e = err as { httpStatus?: unknown; code?: unknown; message?: unknown } | null;
  return e?.httpStatus === 404 || e?.code === "not_found" || e?.code === "E_NOT_FOUND" || /not found/i.test(String(e?.message ?? ""));
};
const iso = (ms: number): string => new Date(ms).toISOString();
const designTitle = (id: string, doc: DesignDocLike): string => (typeof doc.name === "string" && doc.name.trim()) || id.replace(/\.json$/i, "");
const scrubAssetId = (raw: unknown): string => String(raw ?? "asset").toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
const DRIVE_KIND_OF: Readonly<Record<string, HouseKind | "media">> = Object.freeze({ slides: "deck", design: "design", media: "media", file: "file" });

/** `<kind>/<id>` → the media kind and the library id, or null for anything outside the libraries. */
export function mediaRef(doorId: unknown): { kind: MediaKind; id: string } | null {
  const [kind, ...rest] = String(doorId ?? "").split("/");
  const id = rest.join("/");
  if (!id || !(MEDIA_KINDS as readonly string[]).includes(kind ?? "") || id.includes("/") || id === "." || id === "..") return null;
  return { kind: kind as MediaKind, id };
}

export function createHouseStore(deps: HouseStoreDeps) {
  const { lib, bytes, sha256 } = deps;
  const wall = deps.now ?? (() => Date.now());
  const uuid = deps.uuid ?? (() => globalThis.crypto.randomUUID());
  // THE CLOCK: strictly increasing across this process's writes — a save and a
  // delete in the same millisecond must not collide on the server's strictly-newer rule.
  let last = 0;
  const now = (): number => { last = Math.max(wall(), last + 1); return last; };

  const answer = async <T, E>(empty: E, fn: () => Promise<T>): Promise<Answer<T, E>> => {
    try { return { ok: true, ...(await fn()) } as Ok<T>; }
    catch (err) { return { ok: false, error: errText(err), ...empty } as Fail<E>; }
  };
  /** The live rows of a kind — every one carries its data. */
  const live = async <T>(kind: HouseKind): Promise<HouseRow<T>[]> =>
    (await lib.list<T>(kind)).flatMap((r) => (r.data === undefined || r.deletedAt ? [] : [{ id: r.id, updatedAt: r.updatedAt, data: r.data }]));
  const tryGet = async <T>(kind: HouseKind, id: string): Promise<HouseItem<T> | null> => {
    try { return await lib.get<T>(kind, id); }
    catch (err) { if (isNotFound(err)) return null; throw err; }
  };
  const mustGet = async <T>(kind: HouseKind, id: string, what: string): Promise<HouseItem<T>> => {
    const item = await tryGet<T>(kind, id);
    if (!item) throw new Error(`${what} not found`);
    return item;
  };
  const putRecord = async <T>(kind: HouseKind, id: string, data: T, files: HouseFile[]): Promise<HouseItem<T>> => {
    const r = await lib.put<T>(kind, id, { data, files, updatedAt: now() });
    if (!r.applied) throw new Error(HOUSE_STALE_LINE);
    return r.item;
  };
  const removeRecord = async (kind: HouseKind, id: string): Promise<void> => {
    try { await lib.remove(kind, id, { updatedAt: now() }); }
    catch (err) { if (!isNotFound(err)) throw err; }
  };
  const fileEntry = async (path: string, data: Uint8Array): Promise<HouseFile> => ({ path, size: data.byteLength, mtime: now(), sha256: await sha256(data) });
  const withFile = (files: HouseFile[], entry: HouseFile): HouseFile[] => [...files.filter((f) => f.path !== entry.path), entry];
  const presignedGet = async (kind: HouseKind, id: string, path: string): Promise<string> => {
    const urls = await lib.files(kind, id, [path]);
    const url = urls.get[path];
    if (!url) throw new Error(`no url for ${path}`);
    return url;
  };
  const folderOrNull = async (folderId: unknown): Promise<string | null> => {
    const id = folderId ? String(folderId) : "";
    return id && (await tryGet<FolderRecord>("folder", id)) ? id : null;
  };
  /** A free id in a kind: the scrubbed name, then `name 2`, `name 3`, … like a Finder copy. */
  const freeId = async (kind: HouseKind, name: string): Promise<string> => {
    const want = libraryIdOf(name);
    const taken = new Set((await live(kind)).map((r) => r.id));
    if (!taken.has(want)) return want;
    const ext = extOf(want);
    const stem = ext ? want.slice(0, -ext.length) : want;
    for (let i = 2; ; i++) { const c = `${stem}-${i}${ext}`; if (!taken.has(c)) return c; }
  };

  // ── Design ──────────────────────────────────────────────────────────────
  const putDesign = async (id: string, document: DesignDocLike, folderId: string | null, files: HouseFile[]): Promise<{ file: string; title: string }> => {
    const title = designTitle(id, document);
    await putRecord<DesignRecord>("design", id, { title, document, folderId }, files);
    return { file: id, title };
  };
  const designList = () => answer({ designs: [] as Array<{ file: string; title: string; size: number; mtime: number }> }, async () => {
    const rows = await live<DesignRecord>("design");
    return { designs: rows.map((r) => ({ file: r.id, title: r.data.title, size: JSON.stringify(r.data.document ?? {}).length, mtime: r.updatedAt })).sort((a, b) => b.mtime - a.mtime) };
  });
  const designRead = (file: unknown) => answer({}, async () => {
    const d = await mustGet<DesignRecord>("design", designFileName(file), "design");
    return { title: d.data.title, document: d.data.document };
  });
  const designWrite = (file: unknown, document: unknown) => answer({}, async () => {
    const id = designFileName(file);
    const have = await tryGet<DesignRecord>("design", id);
    return putDesign(id, (document ?? {}) as DesignDocLike, have?.data.folderId ?? null, have?.files ?? []);
  });
  const designDelete = (file: unknown) => answer({}, async () => { await removeRecord("design", designFileName(file)); return {}; });
  const designAssetUpload = (file: unknown, input: unknown) => answer({}, async () => {
    const a = (input ?? {}) as { id?: string; kind?: string; title?: string; contentType?: string; dataBase64?: string };
    const id = designFileName(file);
    const have = await mustGet<DesignRecord>("design", id, "design");
    const data = base64ToBytes(String(a.dataBase64 ?? ""));
    const assetId = scrubAssetId(a.id ?? a.title);
    const entry: DesignAsset = { id: assetId, kind: String(a.kind ?? "image"), title: String(a.title ?? assetId), contentType: String(a.contentType ?? "application/octet-stream"), sizeBytes: data.byteLength };
    await bytes.put("design", id, `assets/${assetId}`, data, entry.contentType);
    const doc = have.data.document ?? {};
    doc.assets = [...(doc.assets ?? []).filter((x) => x.id !== assetId), entry];
    await putDesign(id, doc, have.data.folderId, withFile(have.files, await fileEntry(`assets/${assetId}`, data)));
    return { asset: entry };
  });
  const designAssetUrl = (file: unknown, assetId: unknown) => answer({}, async () => {
    const id = designFileName(file);
    const have = await mustGet<DesignRecord>("design", id, "design");
    const entry = (have.data.document.assets ?? []).find((x) => x.id === String(assetId));
    if (!entry) throw new Error("asset not found");
    return { url: dataUrl(entry.contentType, await bytes.get("design", id, `assets/${entry.id}`)) };
  });
  const designAssetDelete = (file: unknown, assetId: unknown) => answer({}, async () => {
    const id = designFileName(file);
    const have = await mustGet<DesignRecord>("design", id, "design");
    const doc = have.data.document ?? {};
    doc.assets = (doc.assets ?? []).filter((x) => x.id !== String(assetId));
    await putDesign(id, doc, have.data.folderId, have.files.filter((f) => f.path !== `assets/${String(assetId)}`));
    return {};
  });

  // ── Slides ──────────────────────────────────────────────────────────────
  const DECK_FILE = "deck.html";
  const putDeck = async (id: string, html: string, folderId: string | null): Promise<{ file: string; title: string; slides: number; html: string }> => {
    // Every save passes the STRUCTURE LOCK — agent, import or panel, no
    // exceptions — and heals any legacy shell defect (deck-document.ts).
    const stored = normalizeDeckHtml(lockDeckSections(html));
    const data = new TextEncoder().encode(stored);
    await bytes.put("deck", id, DECK_FILE, data, "text/html");
    const title = deckTitle(id, stored);
    const slides = slideCount(stored);
    await putRecord<DeckRecord>("deck", id, { title, slides, sizeBytes: data.byteLength, folderId }, [await fileEntry(DECK_FILE, data)]);
    return { file: id, title, slides, html: stored };
  };
  const gpointList = () => answer({ decks: [] as Array<{ file: string; title: string; slides: number; mtime: number; size: number }> }, async () => {
    const rows = await live<DeckRecord>("deck");
    return { decks: rows.map((r) => ({ file: r.id, title: r.data.title, slides: r.data.slides, mtime: r.updatedAt, size: r.data.sizeBytes })).sort((a, b) => b.mtime - a.mtime) };
  });
  const gpointRead = (file: unknown) => answer({}, async () => {
    const id = deckFileName(file);
    return { content: normalizeDeckHtml(new TextDecoder().decode(await bytes.get("deck", id, DECK_FILE))) };
  });
  const gpointWrite = (file: unknown, html: unknown) => answer({}, async () => {
    const id = deckFileName(file);
    const have = await tryGet<DeckRecord>("deck", id);
    const r = await putDeck(id, String(html ?? ""), have?.data.folderId ?? null);
    return { file: r.file, slides: r.slides, html: r.html };
  });
  const gpointNew = (name: unknown, title: unknown) => answer({}, async () => {
    const t = String(title ?? name ?? "Untitled").trim() || "Untitled";
    const r = await putDeck(deckFileName(name), starterDeck(t), null);
    return { file: r.file, title: t };
  });
  const gpointDelete = (file: unknown) => answer({}, async () => { await removeRecord("deck", deckFileName(file)); return {}; });

  // ── Images / Video / Audio ──────────────────────────────────────────────
  const assetRow = (kind: MediaKind, r: HouseRow<MediaRecord>): MediaAssetRow => ({
    id: `${kind}/${r.id}`, kind, title: r.data.title, mime: r.data.mime, sizeBytes: r.data.sizeBytes,
    width: r.data.width ?? null, height: r.data.height ?? null, durationMs: r.data.durationMs ?? null,
    status: "ready", meta: r.data.meta ?? {}, updatedAt: iso(r.updatedAt), folderId: r.data.folderId ?? null,
  });
  const listMedia = async (kinds: readonly MediaKind[], q?: string): Promise<MediaAssetRow[]> => {
    const needle = (q ?? "").trim().toLowerCase();
    const lists = await Promise.all(kinds.map(async (k) => (await live<MediaRecord>(k)).map((r) => assetRow(k, r))));
    return lists.flat().filter((a) => !needle || a.title.toLowerCase().includes(needle)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };
  const mediaList = (kind?: unknown, q?: unknown) => answer({ assets: [] as MediaAssetRow[] }, async () => {
    // A kind the libraries do not have ("avatar", "recording", "voice" are the
    // panels' legacy sub-kinds) answers EMPTY, never "every kind" twice.
    const k = kind ? String(kind) : "";
    if (k && !(MEDIA_KINDS as readonly string[]).includes(k)) return { assets: [] };
    return { assets: await listMedia(k ? [k as MediaKind] : MEDIA_KINDS, q ? String(q) : undefined) };
  });
  const mediaGet = async (doorId: unknown): Promise<{ kind: MediaKind; id: string; item: HouseItem<MediaRecord> }> => {
    const ref = mediaRef(doorId);
    if (!ref) throw new Error(`"${String(doorId)}" is not in a house library`);
    return { ...ref, item: await mustGet<MediaRecord>(ref.kind, ref.id, "that file") };
  };
  /** What the panel plays: a presigned GET straight off R2 (the server stored the file's own content type). */
  const mediaUrl = (doorId: unknown) => answer({}, async () => {
    const { kind, id } = await mediaGet(doorId);
    return { url: await presignedGet(kind, id, id) };
  });
  const mediaBytes = (doorId: unknown) => answer({}, async () => {
    const { kind, id, item } = await mediaGet(doorId);
    return { bytes: await bytes.get(kind, id, id), mime: item.data.mime, name: id, title: item.data.title };
  });
  const mediaThumbBytes = (doorId: unknown) => answer({}, async () => {
    const { kind, id, item } = await mediaGet(doorId);
    if (item.data.sizeBytes > THUMB_BYTES_CAP) throw new Error("too large for capture");
    return { bytes: await bytes.get(kind, id, id), mime: item.data.mime };
  });
  const mediaDelete = (doorId: unknown) => answer({}, async () => {
    const ref = mediaRef(doorId);
    if (!ref) throw new Error(`"${String(doorId)}" is not in a house library`);
    await removeRecord(ref.kind, ref.id);
    return {};
  });
  const putMedia = async (kind: MediaKind, id: string, data: Uint8Array, record: Partial<MediaRecord> & { mime: string }): Promise<MediaAssetRow> => {
    await bytes.put(kind, id, id, data, record.mime);
    const full: MediaRecord = {
      title: record.title ?? id.replace(/\.[^.]+$/, ""), mime: record.mime, sizeBytes: data.byteLength,
      width: record.width ?? null, height: record.height ?? null, durationMs: record.durationMs ?? null,
      meta: record.meta ?? {}, folderId: record.folderId ?? null,
    };
    const item = await putRecord<MediaRecord>(kind, id, full, [await fileEntry(id, data)]);
    return assetRow(kind, item);
  };
  /** Add a file to its library under a free id: never overwrites one already there. */
  const mediaAdd = (kind: unknown, name: unknown, data: Uint8Array, mime?: unknown, meta?: Record<string, unknown>) => answer({}, async () => {
    const m = String(mime || mediaMimeOf(String(name ?? "")));
    const k = mediaKindOfMime(m);
    if (!k || (kind && String(kind) !== k)) throw new Error(`${extOf(String(name ?? "")) || "that"} isn't a file this library can hold`);
    const id = await freeId(k, String(name ?? "untitled"));
    const row = await putMedia(k, id, data, { mime: m, ...(meta ? { meta } : {}) });
    return { id: row.id, kind: k, title: row.title };
  });

  // ── Drive ───────────────────────────────────────────────────────────────
  const listFolders = async (): Promise<DriveFolder[]> =>
    (await live<FolderRecord>("folder")).map((r) => ({ id: r.id, name: r.data.name, parentId: r.data.parentId ?? null }));
  const gdriveList = (q?: unknown) => answer({ folders: [] as DriveFolder[], files: [] as DriveEntry[] }, async () => {
    const [folders, decks, designs, media, loose] = await Promise.all([
      listFolders(), live<DeckRecord>("deck"), live<DesignRecord>("design"), listMedia(MEDIA_KINDS), live<FileRecord>("file"),
    ]);
    const files: DriveEntry[] = [
      ...decks.map((r): DriveEntry => ({ kind: "slides", ref: r.id, file: r.id, title: r.data.title, sizeBytes: r.data.sizeBytes, updatedAt: iso(r.updatedAt), slides: r.data.slides, folderId: r.data.folderId ?? null })),
      ...designs.map((r): DriveEntry => ({ kind: "design", ref: r.id, file: r.id, title: r.data.title, sizeBytes: JSON.stringify(r.data.document ?? {}).length, updatedAt: iso(r.updatedAt), folderId: r.data.folderId ?? null })),
      // The Drive panel knows ONE media kind, "media", with image/audio/video as
      // a subkind (wb-drive.ts DriveKind) — the panel picks its icon and app by it.
      ...media.map((m): DriveEntry => ({ kind: "media", subkind: m.kind, mime: m.mime, ref: m.id, file: m.id, title: m.title, sizeBytes: m.sizeBytes, updatedAt: m.updatedAt, folderId: m.folderId })),
      ...loose.map((r): DriveEntry => ({ kind: "file", mime: r.data.mime, ref: r.id, file: r.id, title: r.data.name, sizeBytes: r.data.sizeBytes, updatedAt: iso(r.updatedAt), folderId: r.data.folderId ?? null })),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const needle = q ? String(q).toLowerCase() : "";
    if (!needle) return { folders, files };
    return {
      folders: folders.filter((f) => f.name.toLowerCase().includes(needle)),
      files: files.filter((f) => f.title.toLowerCase().includes(needle) || f.file.toLowerCase().includes(needle)),
    };
  });
  const putFolder = async (id: string, name: string, parentId: string | null): Promise<DriveFolder> => {
    const clean = name.trim();
    if (!clean) throw new Error("a folder needs a name");
    await putRecord<FolderRecord>("folder", id, { name: clean, parentId }, []);
    return { id, name: clean, parentId };
  };
  const gdriveMkdir = (name: unknown, parentId?: unknown) => answer({}, async () => ({ folder: await putFolder(uuid(), String(name ?? ""), await folderOrNull(parentId)) }));
  /** Re-file one record: its data keeps everything but folderId, its files stay. */
  const refile = async (kind: HouseKind, id: string, folderId: string | null): Promise<void> => {
    const have = await mustGet<{ folderId?: string | null }>(kind, id, `${kind} ${id}`);
    await putRecord(kind, id, { ...have.data, folderId }, have.files);
  };
  const gdriveMove = (kind: unknown, ref: unknown, folderId: unknown) => answer({}, async () => {
    const k = DRIVE_KIND_OF[String(kind ?? "")];
    if (!k) throw new Error(`unknown drive kind "${String(kind)}"`);
    const target = await folderOrNull(folderId);
    if (k === "media") {
      const m = mediaRef(ref);
      if (!m) throw new Error(`"${String(ref)}" is not in a house library`);
      await refile(m.kind, m.id, target);
    } else {
      await refile(k, String(ref ?? ""), target);
    }
    return {};
  });
  const gdriveFolderRename = (id: unknown, name: unknown) => answer({}, async () => {
    const have = await mustGet<FolderRecord>("folder", String(id ?? ""), "folder");
    return { folder: await putFolder(String(id), String(name ?? ""), have.data.parentId ?? null) };
  });
  /** Delete a folder — child folders and the records filed in it re-parent to its parent. */
  const gdriveFolderDelete = (id: unknown) => answer({}, async () => {
    const fid = String(id ?? "");
    const have = await tryGet<FolderRecord>("folder", fid);
    if (!have) return {};
    const parent = have.data.parentId ?? null;
    await removeRecord("folder", fid);
    for (const f of await listFolders()) if (f.parentId === fid) await putFolder(f.id, f.name, parent);
    const kinds: HouseKind[] = ["deck", "design", "image", "video", "audio", "file"];
    for (const k of kinds) {
      for (const r of await live<{ folderId?: string | null }>(k)) if (r.data.folderId === fid) await refile(k, r.id, parent);
    }
    return {};
  });
  /** A loose file into Drive (a PDF export): one record, its bytes as the one file. */
  const fileAdd = (name: unknown, data: Uint8Array, mime: unknown, folderId?: unknown) => answer({}, async () => {
    const id = await freeId("file", String(name ?? "file"));
    const m = String(mime || "application/octet-stream");
    await bytes.put("file", id, id, data, m);
    await putRecord<FileRecord>("file", id, { name: id, mime: m, sizeBytes: data.byteLength, folderId: await folderOrNull(folderId) }, [await fileEntry(id, data)]);
    return { id };
  });

  return {
    designList, designRead, designWrite, designDelete, designAssetUpload, designAssetUrl, designAssetDelete,
    gpointList, gpointRead, gpointWrite, gpointNew, gpointDelete,
    mediaList, mediaUrl, mediaBytes, mediaThumbBytes, mediaDelete, mediaAdd,
    gdriveList, gdriveMkdir, gdriveMove, gdriveFolderRename, gdriveFolderDelete, fileAdd,
    /** THE MIGRATION's doors (main/house-migration.ts): every id the server
     *  holds for a kind, live or tombstoned (the `since: 0` page carries
     *  both), and a put per kind that lands a record under the id it had on
     *  the Mac, folder and all, bytes first — nothing renamed, nothing re-filed. */
    rows: async (kind: HouseKind): Promise<Array<{ id: string; deleted: boolean }>> =>
      (await lib.list(kind, { since: 0 })).map((r) => ({ id: r.id, deleted: r.deletedAt !== null && r.deletedAt !== undefined })),
    imports: {
      design: async (id: string, document: DesignDocLike, folderId: string | null, assets: Array<{ id: string; contentType: string; bytes: Uint8Array }>): Promise<void> => {
        const files: HouseFile[] = [];
        for (const a of assets) {
          await bytes.put("design", id, `assets/${a.id}`, a.bytes, a.contentType);
          files.push(await fileEntry(`assets/${a.id}`, a.bytes));
        }
        await putDesign(id, document, folderId, files);
      },
      deck: async (id: string, html: string, folderId: string | null): Promise<void> => { await putDeck(id, html, folderId); },
      media: async (kind: MediaKind, id: string, data: Uint8Array, mime: string, folderId: string | null): Promise<void> => { await putMedia(kind, id, data, { mime, folderId }); },
      folder: async (id: string, name: string, parentId: string | null): Promise<void> => { await putFolder(id, name, parentId); },
    },
  };
}

export type HouseStore = ReturnType<typeof createHouseStore>;
