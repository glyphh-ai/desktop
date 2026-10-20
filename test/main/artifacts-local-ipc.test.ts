/**
 * artifacts-local-ipc.test.ts — THE ARTIFACTS PANEL, LOCAL ONLY (2026-10-18):
 * the panel's channels (main/artifacts-ipc.ts) over the local folder
 * (artifacts-local.ts), the comment store beside it (artifact-comments.ts)
 * and the agent's store (loop-artifacts.ts). Real files over a temp root;
 * electron's ipcMain and the local account are mocked at their seams.
 */
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, state } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  state: { root: "" },
}));

vi.mock("electron", () => ({ ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => { handlers.set(ch, fn); } } }));
vi.mock("../../src/main/glyphh-app-services.js", () => ({ appDataDir: (slug: string) => join(state.root, "app-data", slug) }));
vi.mock("../../src/main/auth.js", () => ({
  LOCAL_USER_ID: "local",
  getAccountInfo: () => ({ firstName: "chris", lastName: "", avatarUrl: "" }),
}));

import { registerArtifactsIpc, rowOf } from "../../src/main/artifacts-ipc.js";
import * as local from "../../src/main/artifacts-local.js";
import * as comments from "../../src/main/artifact-comments.js";
import { loopArtifacts } from "../../src/main/loop-artifacts.js";

type Env<T> = { ok: true; data: T } | { ok: false; error: string };
const call = async <T>(ch: string, ...args: unknown[]): Promise<Env<T>> => (await handlers.get(ch)!({}, ...args)) as Env<T>;
const ok = <T>(r: Env<T>): T => { if (!r.ok) throw new Error(`expected ok, got: ${r.error}`); return r.data; };
const filesDir = (): string => join(state.root, "app-data", "artifacts", "files");
const commentsDir = (): string => join(state.root, "app-data", "artifacts", "comments");

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "glyphh-artifacts-"));
  handlers.clear();
  registerArtifactsIpc();
});

describe("the channels: the share channel is gone, the rest answer in envelopes", () => {
  it("registers exactly the panel's channels", () => {
    expect([...handlers.keys()].sort()).toEqual([
      "artifacts-comment-add", "artifacts-comment-delete", "artifacts-comment-patch", "artifacts-comments",
      "artifacts-content", "artifacts-delete", "artifacts-get", "artifacts-list", "artifacts-update",
    ]);
  });

  it("lists the folder as rows — no access, owner or link; newest first", async () => {
    local.create("old.md", "# old");
    const a = local.create("page.html", "<h1>hi</h1>");
    const rows = ok(await call<ReturnType<typeof rowOf>[]>("artifacts-list"));
    expect(rows.map((r) => r.name).sort()).toEqual(["old.md", "page.html"]);
    const page = rows.find((r) => r.id === a.id)!;
    expect(page).toEqual({ id: "page.html", name: "page.html", mime: "text/html", sizeBytes: 11, sessionId: null, createdAt: a.createdAt, updatedAt: a.createdAt });
    expect(ok(await call("artifacts-get", "page.html"))).toEqual(page);
  });

  it("the content comes back base64 with its mime; a missing or escaping id is an error, never a throw", async () => {
    local.write("chart.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(ok(await call("artifacts-content", "chart.png"))).toEqual({ base64: "iVBORw==", mime: "image/png" });
    expect(await call("artifacts-content", "nope.png")).toEqual({ ok: false, error: "that artifact is no longer here" });
    expect(await call("artifacts-get", "../secret")).toEqual({ ok: false, error: "that artifact is no longer here" });
  });

  it("an update renames only: the answer carries the new id, a bare name keeps the type, the same name is a no-op", async () => {
    local.create("draft.html", "<p>x</p>");
    const renamed = ok(await call<{ id: string; name: string }>("artifacts-update", "draft.html", { name: "Final" }));
    expect(renamed).toMatchObject({ id: "Final.html", name: "Final.html" });
    expect(readdirSync(filesDir())).toEqual(["Final.html"]);
    expect(ok(await call<{ id: string }>("artifacts-update", "Final.html", { name: "Final.html" })).id).toBe("Final.html");
    expect(ok(await call<{ id: string }>("artifacts-update", "Final.html", { access: "public" })).id).toBe("Final.html");
    expect(await call("artifacts-update", "Final.html", { name: "  " })).toEqual({ ok: false, error: "a name is required" });
  });

  it("a delete removes the file", async () => {
    local.create("gone.md", "x");
    expect(ok(await call("artifacts-delete", "gone.md"))).toEqual({});
    expect(local.list()).toEqual([]);
    expect(await call("artifacts-delete", "gone.md")).toEqual({ ok: false, error: "that artifact is no longer here" });
  });
});

describe("the comments: threads with replies, stored beside the files", () => {
  it("adds a thread with its region, signed by the local user; replies join it; Glyphh signs its own", async () => {
    local.create("page.html", "<h1>hi</h1>");
    const t = ok(await call<comments.ArtifactCommentThread>("artifacts-comment-add", "page.html", { text: " make the title bigger ", region: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } }));
    expect(t).toMatchObject({ text: "make the title bigger", region: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, resolved: false, replies: [], author: { id: "local", name: "chris", avatarUrl: null } });
    expect(t.id).toMatch(/^c_[0-9a-f]{16}$/);
    const reply = ok(await call<comments.ArtifactCommentThread>("artifacts-comment-add", "page.html", { text: "and bold", parentId: t.id, region: { x: 0, y: 0, w: 1, h: 1 } }));
    expect(reply.region).toBeNull();
    const agent = ok(await call<comments.ArtifactCommentThread>("artifacts-comment-add", "page.html", { text: "Done.", parentId: reply.id, agent: true }));
    expect(agent).toMatchObject({ agent: true, author: { id: "glyphh", name: "Glyphh" } });
    const threads = ok(await call<comments.ArtifactCommentThread[]>("artifacts-comments", "page.html"));
    expect(threads).toHaveLength(1);
    expect(threads[0]!.replies.map((r) => r.text)).toEqual(["and bold", "Done."]);
    // The comment file is outside the folder that IS the index.
    expect(readdirSync(commentsDir())).toEqual(["page.html.json"]);
    expect(local.list().map((a) => a.id)).toEqual(["page.html"]);
  });

  it("resolve answers the whole thread; deleting the opening line takes the replies with it", async () => {
    local.create("page.html", "x");
    const t = ok(await call<comments.ArtifactCommentThread>("artifacts-comment-add", "page.html", { text: "one" }));
    ok(await call("artifacts-comment-add", "page.html", { text: "two", parentId: t.id }));
    const resolved = ok(await call<comments.ArtifactCommentThread>("artifacts-comment-patch", "page.html", t.id, { resolved: true }));
    expect(resolved).toMatchObject({ id: t.id, resolved: true, replies: [{ text: "two" }] });
    expect(ok(await call("artifacts-comment-delete", "page.html", t.id))).toEqual({});
    expect(ok(await call("artifacts-comments", "page.html"))).toEqual([]);
    expect(existsSync(join(commentsDir(), "page.html.json"))).toBe(false);
    expect(await call("artifacts-comment-delete", "page.html", t.id)).toEqual({ ok: false, error: "that comment is no longer here" });
  });

  it("refuses an empty comment, a reply to nothing, a bad region, and an artifact that is gone", async () => {
    local.create("page.html", "x");
    expect(await call("artifacts-comment-add", "page.html", { text: "   " })).toEqual({ ok: false, error: "a comment needs text" });
    expect(await call("artifacts-comment-add", "page.html", { text: "x", parentId: "c_nope" })).toEqual({ ok: false, error: "that comment is no longer here" });
    expect(ok(await call<comments.ArtifactCommentThread>("artifacts-comment-add", "page.html", { text: "x", region: { x: 2, y: 0, w: 1, h: 1 } })).region).toBeNull();
    expect(await call("artifacts-comment-add", "page.html", { text: "x".repeat(comments.COMMENT_TEXT_MAX + 1) })).toMatchObject({ ok: false });
    expect(await call("artifacts-comments", "gone.html")).toEqual({ ok: false, error: "that artifact is no longer here" });
    expect(await call("artifacts-comment-patch", "page.html", "c_nope", { resolved: true })).toEqual({ ok: false, error: "that comment is no longer here" });
  });

  it("a rename moves the threads to the new id; a delete drops them; a new artifact under an old name starts clean", async () => {
    local.create("draft.html", "x");
    ok(await call("artifacts-comment-add", "draft.html", { text: "keep me" }));
    ok(await call("artifacts-update", "draft.html", { name: "final.html" }));
    expect(ok(await call<comments.ArtifactCommentThread[]>("artifacts-comments", "final.html")).map((c) => c.text)).toEqual(["keep me"]);
    expect(readdirSync(commentsDir())).toEqual(["final.html.json"]);
    ok(await call("artifacts-delete", "final.html"));
    expect(readdirSync(commentsDir())).toEqual([]);
    // A file deleted by hand leaves its comment file; the next artifact of that name must not inherit it.
    local.create("hand.md", "x");
    ok(await call("artifacts-comment-add", "hand.md", { text: "stale" }));
    local.remove("hand.md");
    writeFileSync(join(commentsDir(), "hand.md.json"), JSON.stringify([{ id: "c_1", parentId: null, author: { id: "local", name: "x", avatarUrl: null }, region: null, text: "stale", resolved: false, createdAt: "2026-10-01T00:00:00Z" }]));
    local.create("hand.md", "new");
    expect(ok(await call("artifacts-comments", "hand.md"))).toEqual([]);
  });

  it("a corrupt comment file reads as no comments rather than breaking the viewer", async () => {
    local.create("page.html", "x");
    writeFileSync(join(comments.commentsDir(), "page.html.json"), "{not json");
    expect(ok(await call("artifacts-comments", "page.html"))).toEqual([]);
  });
});

describe("the agent's store (LoopDeps.artifacts)", () => {
  it("a publish without an id creates a file in the panel's folder", async () => {
    const meta = await loopArtifacts.publish({ id: null, name: "report.html", bytes: Buffer.from("<h1>Q3</h1>") });
    expect(meta).toMatchObject({ id: "report.html", name: "report.html", mime: "text/html", sizeBytes: 11 });
    expect(ok(await call<{ id: string }[]>("artifacts-list")).map((r) => r.id)).toEqual(["report.html"]);
    await expect(loopArtifacts.publish({ id: null, name: null, bytes: Buffer.from("x") })).rejects.toThrow(/needs a name/);
  });

  it("an update replaces the bytes in place, keeps its comments, and a new name moves them with it", async () => {
    await loopArtifacts.publish({ id: null, name: "report.html", bytes: Buffer.from("<h1>Q3</h1>") });
    ok(await call("artifacts-comment-add", "report.html", { text: "fix the title" }));
    const same = await loopArtifacts.publish({ id: "report.html", name: null, bytes: Buffer.from("<h1>Q3 v2</h1>") });
    expect(same.id).toBe("report.html");
    expect((await loopArtifacts.read("report.html")).bytes.toString()).toBe("<h1>Q3 v2</h1>");
    const renamed = await loopArtifacts.publish({ id: "report.html", name: "Q3 final", bytes: Buffer.from("<h1>Q3 v3</h1>") });
    expect(renamed).toMatchObject({ id: "Q3 final.html", name: "Q3 final.html" });
    expect(local.list().map((a) => a.id)).toEqual(["Q3 final.html"]);
    expect(ok(await call<comments.ArtifactCommentThread[]>("artifacts-comments", "Q3 final.html")).map((c) => c.text)).toEqual(["fix the title"]);
  });

  it("reading or updating one that is gone throws in the store's words", async () => {
    await expect(loopArtifacts.read("nope.md")).rejects.toThrow("that artifact is no longer here");
    await expect(loopArtifacts.publish({ id: "nope.md", name: null, bytes: Buffer.from("x") })).rejects.toThrow("that artifact is no longer here");
  });
});
