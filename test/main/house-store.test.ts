/**
 * house-store.test.ts — THE HOUSE APPS' ONE STORE (src/shared/house-store.ts;
 * his order, 2026-10-06: cloud is the one home). Over a fake member library
 * (the server's LWW rule) and a fake byte lane: every door answers the shape
 * the panels read, ids are the file names the Mac used, bytes ride as the
 * record's files, Drive is the view across every kind, and a stale write
 * says so.
 */
import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import {
  createHouseStore, serverLaneBytes, libraryIdOf, mediaRef, HOUSE_STALE_LINE, HOUSE_VIEW_OF_APP, houseViewOfApp,
  type HouseBytes, type HouseFile, type HouseItem, type HouseLib,
} from "../../src/shared/house-store";
import { slideCount } from "../../src/shared/deck-document";

const sha256 = async (b: Uint8Array): Promise<string> => createHash("sha256").update(b).digest("hex");
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const notFound = (): Error => Object.assign(new Error("not found"), { httpStatus: 404, code: "not_found" });

/** The server's member library, in memory, honouring the strictly-newer rule and tombstones. */
function fakeLib(): HouseLib & { rows: Map<string, HouseItem & { deletedAt: number | null }> } {
  const rows = new Map<string, HouseItem & { deletedAt: number | null }>();
  return {
    rows,
    async list(kind, opts) {
      // Newest first, as the server lists.
      const all = [...rows.entries()].filter(([k]) => k.startsWith(`${kind}:`)).map(([, r]) => r).sort((a, b) => b.updatedAt - a.updatedAt);
      if (opts?.since !== undefined) return all.map((r) => ({ id: r.id, updatedAt: r.updatedAt, data: r.data, deletedAt: r.deletedAt }));
      return all.filter((r) => r.deletedAt === null).map((r) => ({ id: r.id, updatedAt: r.updatedAt, data: r.data }));
    },
    async get(kind, id) {
      const r = rows.get(`${kind}:${id}`);
      if (!r || r.deletedAt !== null) throw notFound();
      return { id: r.id, updatedAt: r.updatedAt, data: r.data, files: r.files };
    },
    async put(kind, id, input) {
      const cur = rows.get(`${kind}:${id}`);
      const applied = !cur || input.updatedAt > cur.updatedAt;
      if (applied) rows.set(`${kind}:${id}`, { id, updatedAt: input.updatedAt, data: input.data, files: input.files ?? [], deletedAt: null });
      const r = rows.get(`${kind}:${id}`)!;
      return { applied, item: { id: r.id, updatedAt: r.updatedAt, data: r.data, files: r.files } };
    },
    async remove(kind, id, input = {}) {
      const cur = rows.get(`${kind}:${id}`);
      if (!cur || cur.deletedAt !== null) throw notFound();
      const at = input.updatedAt ?? Date.now();
      if (at <= cur.updatedAt) throw Object.assign(new Error("stale"), { httpStatus: 409 });
      rows.set(`${kind}:${id}`, { ...cur, updatedAt: at, deletedAt: at });
    },
    async files(kind, id, paths) {
      return { put: Object.fromEntries(paths.map((p) => [p, `https://r2/put/${kind}/${id}/${p}`])), get: Object.fromEntries(paths.map((p) => [p, `https://r2/get/${kind}/${id}/${p}`])) };
    },
  } as HouseLib & { rows: Map<string, HouseItem & { deletedAt: number | null }> };
}

function fakeBytes(): HouseBytes & { blobs: Map<string, { bytes: Uint8Array; mime: string }> } {
  const blobs = new Map<string, { bytes: Uint8Array; mime: string }>();
  return {
    blobs,
    async get(kind, id, path) { const b = blobs.get(`${kind}/${id}/${path}`); if (!b) throw new Error("that file is no longer in your library"); return b.bytes; },
    async put(kind, id, path, bytes, mime) { blobs.set(`${kind}/${id}/${path}`, { bytes, mime }); },
  };
}

function rig(startAt = 1_000) {
  const lib = fakeLib();
  const bytes = fakeBytes();
  // The wall clock ticks once per read, so every clock in a test is a known number.
  let t = startAt;
  let f = 0;
  const store = createHouseStore({ lib, bytes, sha256, now: () => ++t, uuid: () => `f-${++f}` });
  return { lib, bytes, store };
}

describe("ids are the file names the Mac used, made library-safe", () => {
  it("libraryIdOf keeps the extension and scrubs the rest to the server's id alphabet", () => {
    expect(libraryIdOf("Sunset beach.PNG")).toBe("Sunset-beach.png");
    expect(libraryIdOf("a/b/clip (1).mov")).toBe("clip-1.mov");
    expect(libraryIdOf("ünïcode.mp3")).toBe("n-code.mp3");
    expect(libraryIdOf("...")).toBe("untitled");
    expect(libraryIdOf(`${"x".repeat(200)}.wav`).length).toBeLessThanOrEqual(96);
  });

  it("a media door id is <kind>/<id>; anything else is outside the libraries", () => {
    expect(mediaRef("image/sunset.png")).toEqual({ kind: "image", id: "sunset.png" });
    for (const bad of ["sunset.png", "avatar/x.png", "image/", "image/../x", "", undefined]) expect(mediaRef(bad)).toBeNull();
  });

  it("the six house apps are APPS (instances), each naming the built-in panel its slug opens — never a synthesized row", () => {
    expect(Object.keys(HOUSE_VIEW_OF_APP).sort()).toEqual(["audio", "design", "drive", "images", "slides", "video"]);
    expect(houseViewOfApp("images")).toBe("gimage");
    expect(houseViewOfApp("Drive")).toBe("gdrive");
    for (const other of ["crm", "", null, undefined, "gimage"]) expect(houseViewOfApp(other)).toBeNull();
  });
});

describe("Design — the document is the record, its assets are its files", () => {
  it("write, list, read, delete — under <stem>.json like the Mac's folder", async () => {
    const { store, lib } = rig();
    expect(await store.designList()).toEqual({ ok: true, designs: [] });
    const w = await store.designWrite("Brand Kit", { name: "Brand", colors: { primary: "#000" } });
    expect(w).toEqual({ ok: true, file: "brand-kit.json", title: "Brand" });
    expect(lib.rows.get("design:brand-kit.json")?.data).toMatchObject({ title: "Brand", folderId: null });
    const list = await store.designList();
    expect(list.ok && list.designs.map((d) => [d.file, d.title, d.mtime])).toEqual([["brand-kit.json", "Brand", 1_001]]);
    const r = await store.designRead("brand-kit");
    expect(r).toEqual({ ok: true, title: "Brand", document: { name: "Brand", colors: { primary: "#000" } } });
    expect(await store.designRead("nope")).toEqual({ ok: false, error: "design not found" });
    expect(await store.designDelete("brand-kit.json")).toEqual({ ok: true });
    expect(await store.designList()).toEqual({ ok: true, designs: [] });
    expect(await store.designDelete("brand-kit.json")).toEqual({ ok: true }); // gone is gone, never an error
  });

  it("an asset's bytes land as assets/<id>, in the document and the manifest; its url is a data URL; a delete drops both", async () => {
    const { store, lib, bytes } = rig();
    await store.designWrite("acme", { name: "Acme" });
    const up = await store.designAssetUpload("acme", { id: "Logo Mark", kind: "logo", title: "Logo", contentType: "image/png", dataBase64: btoa("PNG!") });
    expect(up).toEqual({ ok: true, asset: { id: "logo-mark", kind: "logo", title: "Logo", contentType: "image/png", sizeBytes: 4 } });
    expect(bytes.blobs.get("design/acme.json/assets/logo-mark")).toEqual({ bytes: text("PNG!"), mime: "image/png" });
    const item = lib.rows.get("design:acme.json")!;
    expect((item.data as { document: { assets: unknown[] } }).document.assets).toEqual([up.ok && up.asset]);
    expect(item.files.map((f: HouseFile) => [f.path, f.size])).toEqual([["assets/logo-mark", 4]]);
    expect(await store.designAssetUrl("acme", "logo-mark")).toEqual({ ok: true, url: `data:image/png;base64,${btoa("PNG!")}` });
    expect(await store.designAssetUrl("acme", "missing")).toEqual({ ok: false, error: "asset not found" });
    // A document save keeps the manifest the assets wrote.
    await store.designWrite("acme", { name: "Acme 2", assets: [up.ok && up.asset] });
    expect(lib.rows.get("design:acme.json")!.files).toHaveLength(1);
    expect(await store.designAssetDelete("acme", "logo-mark")).toEqual({ ok: true });
    expect(lib.rows.get("design:acme.json")!.files).toEqual([]);
    expect((lib.rows.get("design:acme.json")!.data as { document: { assets: unknown[] } }).document.assets).toEqual([]);
  });
});

describe("Slides — the deck record, its deck.html as the one file, the structure lock on every save", () => {
  it("new makes a one-slide starter through the canonical shell; read gives the locked bytes back", async () => {
    const { store, bytes, lib } = rig();
    const n = await store.gpointNew("Q3 Review", "Q3 Review");
    expect(n).toEqual({ ok: true, file: "q3-review.html", title: "Q3 Review" });
    const stored = new TextDecoder().decode(bytes.blobs.get("deck/q3-review.html/deck.html")!.bytes);
    expect(stored).toContain('<title>Q3 Review</title>');
    expect(slideCount(stored)).toBe(1);
    const size = text(stored).byteLength;
    expect(lib.rows.get("deck:q3-review.html")?.data).toEqual({ title: "Q3 Review", slides: 1, sizeBytes: size, folderId: null });
    const list = await store.gpointList();
    expect(list.ok && list.decks).toEqual([{ file: "q3-review.html", title: "Q3 Review", slides: 1, mtime: 1_002, size }]);
    expect(await store.gpointRead("q3-review")).toEqual({ ok: true, content: stored });
    expect(await store.gpointRead("other")).toEqual({ ok: false, error: "that file is no longer in your library" });
  });

  it("write locks the sections (a rogue <script> never survives) and keeps the deck's folder", async () => {
    const { store, lib } = rig();
    await store.gpointNew("deck", "Deck");
    const f = await store.gdriveMkdir("Decks");
    await store.gdriveMove("slides", "deck.html", f.ok && f.folder.id);
    const html = `<!DOCTYPE html><html><head><title>Deck</title></head><body><div id="stage"><section class="slide" id="x"><script>alert(1)</script><p>one</p></section><section class="slide"><p>two</p></section></div></body></html>`;
    const w = await store.gpointWrite("deck", html);
    expect(w.ok && w.slides).toBe(2);
    expect(w.ok && w.html).not.toContain("<script>alert");
    expect(w.ok && w.html).toContain('<section class="slide on" id="s1">');
    expect(lib.rows.get("deck:deck.html")?.data).toMatchObject({ slides: 2, folderId: f.ok && f.folder.id });
    expect(await store.gpointDelete("deck")).toEqual({ ok: true });
    expect(await store.gpointList()).toEqual({ ok: true, decks: [] });
  });
});

describe("Images / Video / Audio — one record per file, the bytes as its file", () => {
  it("add files a library under a free, scrubbed id; list answers per kind; a legacy sub-kind answers empty", async () => {
    const { store, bytes } = rig();
    const a = await store.mediaAdd("image", "Sunset beach.png", text("png1"));
    expect(a).toEqual({ ok: true, id: "image/Sunset-beach.png", kind: "image", title: "Sunset-beach" });
    const b = await store.mediaAdd(undefined, "Sunset beach.png", text("png2"), "image/png");
    expect(b.ok && b.id).toBe("image/Sunset-beach-2.png");
    expect(bytes.blobs.get("image/Sunset-beach-2.png/Sunset-beach-2.png")).toEqual({ bytes: text("png2"), mime: "image/png" });
    expect(await store.mediaAdd("image", "notes.txt", text("x"))).toEqual({ ok: false, error: ".txt isn't a file this library can hold" });
    expect(await store.mediaAdd("audio", "clip.mp4", text("x"))).toMatchObject({ ok: false });
    await store.mediaAdd("video", "clip.mp4", text("mp4"));
    const images = await store.mediaList("image");
    expect(images.ok && images.assets.map((x) => x.id)).toEqual(["image/Sunset-beach-2.png", "image/Sunset-beach.png"]);
    expect(images.ok && images.assets[1]).toEqual({ id: "image/Sunset-beach.png", kind: "image", title: "Sunset-beach", mime: "image/png", sizeBytes: 4, width: null, height: null, durationMs: null, status: "ready", meta: {}, updatedAt: new Date(1_002).toISOString(), folderId: null });
    expect(await store.mediaList("avatar")).toEqual({ ok: true, assets: [] });
    const all = await store.mediaList();
    expect(all.ok && all.assets.map((x) => x.kind)).toEqual(["video", "image", "image"]);
    const q = await store.mediaList("image", "beach-2");
    expect(q.ok && q.assets.map((x) => x.id)).toEqual(["image/Sunset-beach-2.png"]);
  });

  it("url is the presigned GET off R2; thumb bytes and bytes are the file; delete tombstones", async () => {
    const { store } = rig();
    await store.mediaAdd("image", "a.png", text("png"));
    expect(await store.mediaUrl("image/a.png")).toEqual({ ok: true, url: "https://r2/get/image/a.png/a.png" });
    expect(await store.mediaThumbBytes("image/a.png")).toEqual({ ok: true, bytes: text("png"), mime: "image/png" });
    expect(await store.mediaBytes("image/a.png")).toEqual({ ok: true, bytes: text("png"), mime: "image/png", name: "a.png", title: "a" });
    expect(await store.mediaUrl("a.png")).toEqual({ ok: false, error: '"a.png" is not in a house library' });
    expect(await store.mediaUrl("image/zz.png")).toEqual({ ok: false, error: "that file not found" });
    expect(await store.mediaDelete("image/a.png")).toEqual({ ok: true });
    expect(await store.mediaList("image")).toEqual({ ok: true, assets: [] });
  });
});

describe("Drive — the folders, and the view across everything the house apps made", () => {
  it("lists every kind with its folder; mkdir, move (a media ref by its door id), rename, delete re-parents", async () => {
    const { store } = rig();
    await store.designWrite("brand", { name: "Brand" });
    await store.gpointNew("deck", "Deck");
    await store.mediaAdd("image", "a.png", text("png"));
    const pdf = await store.fileAdd("report.pdf", text("%PDF"), "application/pdf");
    expect(pdf).toEqual({ ok: true, id: "report.pdf" });
    const top = await store.gdriveMkdir("Work");
    const sub = await store.gdriveMkdir("Q3", top.ok && top.folder.id);
    expect(sub.ok && sub.folder).toEqual({ id: sub.ok && sub.folder.id, name: "Q3", parentId: top.ok && top.folder.id });
    expect(await store.gdriveMkdir("  ")).toEqual({ ok: false, error: "a folder needs a name" });
    expect(await store.gdriveMove("slides", "deck.html", sub.ok && sub.folder.id)).toEqual({ ok: true });
    expect(await store.gdriveMove("media", "image/a.png", sub.ok && sub.folder.id)).toEqual({ ok: true });
    expect(await store.gdriveMove("file", "report.pdf", top.ok && top.folder.id)).toEqual({ ok: true });
    expect(await store.gdriveMove("design", "brand.json", "no-such-folder")).toEqual({ ok: true }); // an unknown folder files at the root
    expect(await store.gdriveMove("docs", "x.md", null)).toEqual({ ok: false, error: 'unknown drive kind "docs"' });
    expect(await store.gdriveMove("media", "a.png", null)).toEqual({ ok: false, error: '"a.png" is not in a house library' });
    const l = await store.gdriveList();
    expect(l.ok && l.folders).toEqual([{ id: sub.ok && sub.folder.id, name: "Q3", parentId: top.ok && top.folder.id }, { id: top.ok && top.folder.id, name: "Work", parentId: null }]);
    expect(l.ok && l.files.map((f) => [f.kind, f.ref, f.folderId])).toEqual([
      ["design", "brand.json", null], ["file", "report.pdf", top.ok && top.folder.id], ["media", "image/a.png", sub.ok && sub.folder.id], ["slides", "deck.html", sub.ok && sub.folder.id],
    ]);
    expect(l.ok && l.files.find((f) => f.kind === "media")).toMatchObject({ subkind: "image", mime: "image/png", title: "a", sizeBytes: 3 });
    expect(l.ok && l.files.find((f) => f.kind === "slides")).toMatchObject({ slides: 1, title: "Deck" });
    expect(l.ok && l.files.find((f) => f.kind === "file")).toMatchObject({ mime: "application/pdf", title: "report.pdf" });
    const q = await store.gdriveList("q3");
    expect(q.ok && q.folders.map((f) => f.name)).toEqual(["Q3"]);
    expect(q.ok && q.files).toEqual([]);
    expect(await store.gdriveFolderRename(sub.ok && sub.folder.id, "Quarter 3")).toEqual({ ok: true, folder: { id: sub.ok && sub.folder.id, name: "Quarter 3", parentId: top.ok && top.folder.id } });
    // Delete Q3: the deck and the image it held move up to Work.
    expect(await store.gdriveFolderDelete(sub.ok && sub.folder.id)).toEqual({ ok: true });
    const after = await store.gdriveList();
    expect(after.ok && after.folders.map((f) => f.name)).toEqual(["Work"]);
    expect(after.ok && after.files.filter((f) => f.kind !== "design").every((f) => f.folderId === (top.ok && top.folder.id))).toBe(true);
    expect(await store.gdriveFolderDelete("never")).toEqual({ ok: true });
  });
});

describe("the clock and the server's rule", () => {
  it("a write the server holds a newer copy of answers the stale line, not a lie", async () => {
    const { store, lib } = rig();
    await store.designWrite("brand", { name: "Brand" });
    lib.rows.set("design:brand.json", { ...lib.rows.get("design:brand.json")!, updatedAt: 5_000 }); // the web wrote later
    expect(await store.designWrite("brand", { name: "Older" })).toEqual({ ok: false, error: HOUSE_STALE_LINE });
    expect((lib.rows.get("design:brand.json")!.data as { title: string }).title).toBe("Brand");
  });

  it("rows (the migration's door) names live and tombstoned ids alike", async () => {
    const { store } = rig();
    await store.designWrite("a", {});
    await store.designWrite("b", {});
    await store.designDelete("b");
    expect(await store.rows("design")).toEqual([{ id: "b.json", deleted: true }, { id: "a.json", deleted: false }]);
  });
});

describe("serverLaneBytes — the bytes through the server, on the member's own prefix", () => {
  it("GET and PUT /api/library/v2/<kind>/<id>/files/<path> with the bearer and the file's content type", async () => {
    const calls: Array<[string, { method?: string; headers?: Record<string, string>; body?: Uint8Array } | undefined]> = [];
    const lane = serverLaneBytes({
      apiUrl: "https://api.test/", token: async () => "tok",
      fetchImpl: async (url, init) => { calls.push([url, init]); const s = url.endsWith("/missing") ? 404 : url.includes("/big.mp4") ? 400 : 200; return { ok: s === 200, status: s, arrayBuffer: async () => (s === 400 ? text(JSON.stringify({ error: "bad-body", detail: "a video file is at most 2 GB" })) : text("hi")).buffer as ArrayBuffer }; },
    });
    expect(await lane.get("deck", "q3 review.html", "deck.html")).toEqual(text("hi"));
    expect(calls[0]).toEqual(["https://api.test/api/library/v2/deck/q3%20review.html/files/deck.html", { method: "GET", headers: { authorization: "Bearer tok" } }]);
    await lane.put("image", "a.png", "a.png", text("png"), "image/png");
    expect(calls[1]).toEqual(["https://api.test/api/library/v2/image/a.png/files/a.png", { method: "PUT", headers: { authorization: "Bearer tok", "content-type": "image/png" }, body: text("png") }]);
    await expect(lane.get("file", "x", "missing")).rejects.toThrow("that file is no longer in your library");
    await expect(lane.put("video", "big.mp4", "big.mp4", text("x"), "video/mp4")).rejects.toThrow("a video file is at most 2 GB");   // the server's per-kind cap line (2026-10-06)
  });
});
