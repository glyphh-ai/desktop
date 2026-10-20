/**
 * artifact_publish + artifact_read (his direction, 2026-10-05: artifacts like
 * Claude's; his report the same day: an edit made a second artifact). Local
 * only since 2026-10-18: the host's store (LoopDeps.artifacts) keeps them. The
 * pure parts (the mime from the name, the extension a bare name takes), the
 * folder confinement and the size cap, what reaches the store, and the belt
 * both sit on in both spaces — and off it when the host keeps no artifacts.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_PUBLISH, ARTIFACT_PUBLISH_TOOL, ARTIFACT_READ, ARTIFACT_READ_CAP, ARTIFACT_READ_TOOL, ARTIFACT_SIZE_CAP, extensionFor, inferMime, isTextMime, nameWithExtension,
  runArtifactPublish, runArtifactRead, type ArtifactMeta, type LoopArtifacts, type PublishContext,
} from "../../src/loop/artifacts.js";
import { gate, toolKind } from "../../src/loop/core.js";
import { GlyphhLoop, type LoopEvent } from "../../src/loop/loop.js";

const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "gl-art-"));
  const folder = join(root, "project");
  const outside = join(root, "outside");
  mkdirSync(folder); mkdirSync(outside);
  writeFileSync(join(folder, "report.html"), "<h1>Q3</h1>");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  return { root, folder, outside };
};

type Publish = Parameters<LoopArtifacts["publish"]>[0];

/** A host store in memory, keyed by name like the app's (the id IS the name, so a rename moves it). */
function store(seed: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(seed).map(([k, v]) => [k, Buffer.from(v)]));
  const calls: Publish[] = [];
  const metaOf = (id: string): ArtifactMeta => ({ id, name: id, mime: inferMime(id), sizeBytes: files.get(id)!.length, updatedAt: "2026-10-18T10:00:00.000Z" });
  const artifacts: LoopArtifacts = {
    publish: async (input) => {
      calls.push({ ...input, bytes: Buffer.from(input.bytes) });
      if (input.id && !files.has(input.id)) throw new Error("that artifact is no longer here");
      let id = input.id ?? input.name!;
      if (input.id && input.name && input.name !== input.id) { files.delete(input.id); id = input.name; }
      files.set(id, input.bytes);
      return metaOf(id);
    },
    read: async (id) => {
      if (!files.has(id)) throw new Error("that artifact is no longer here");
      return { meta: metaOf(id), bytes: files.get(id)! };
    },
  };
  return { files, calls, artifacts };
}

const ctx = (over: Partial<PublishContext> & { workdir: string }): PublishContext => ({ hasFolder: true, artifacts: store().artifacts, ...over });
const text = (b: Uint8Array): string => Buffer.from(b).toString("utf8");

describe("artifact_publish — the pure parts", () => {
  it("infers the mime from the name's extension, octet-stream otherwise", () => {
    expect(inferMime("report.html")).toBe("text/html");
    expect(inferMime("Notes.MD")).toBe("text/markdown");
    expect(inferMime("data.csv")).toBe("text/csv");
    expect(inferMime("chart.svg")).toBe("image/svg+xml");
    expect(inferMime("deck.pdf")).toBe("application/pdf");
    expect(inferMime("mystery")).toBe("application/octet-stream");
    expect(inferMime("archive.tar.xyz")).toBe("application/octet-stream");
  });

  it("a name without an extension takes the file's, else the mime's; one with an extension keeps it", () => {
    expect(extensionFor("text/html")).toBe(".html");
    expect(extensionFor("text/plain; charset=utf-8")).toBe(".txt");
    expect(extensionFor("application/x-nothing")).toBe("");
    expect(nameWithExtension("Q3", "out/report.html", "text/markdown")).toBe("Q3.html");
    expect(nameWithExtension("Q3", null, "text/markdown")).toBe("Q3.md");
    expect(nameWithExtension("Q3", null, null)).toBe("Q3");
    expect(nameWithExtension("Q3.csv", "report.html", "text/html")).toBe("Q3.csv");
  });

  it("knows a text mime from a binary one", () => {
    expect(isTextMime("text/html; charset=utf-8")).toBe(true);
    expect(isTextMime("application/json")).toBe(true);
    expect(isTextMime("image/svg+xml")).toBe(true);
    expect(isTextMime("application/ld+json")).toBe(true);
    expect(isTextMime("image/png")).toBe(false);
    expect(isTextMime("application/pdf")).toBe(false);
  });

  it("publish is an edit (gated like write_file), read is a read", () => {
    expect(toolKind(ARTIFACT_PUBLISH)).toBe("edit");
    expect(gate("acceptEdits", toolKind(ARTIFACT_PUBLISH))).toBe("allow");
    expect(gate("ask", toolKind(ARTIFACT_PUBLISH))).toBe("ask");
    expect(gate("plan", toolKind(ARTIFACT_PUBLISH))).toBe("deny");
    expect(toolKind(ARTIFACT_READ)).toBe("read");
    expect(gate("plan", toolKind(ARTIFACT_READ))).toBe("allow");
    expect(gate("ask", toolKind(ARTIFACT_READ))).toBe("allow");
  });

  it("the specs the model sees: publish creates or updates in place, never a second one for an edit; nothing about sharing or links", () => {
    expect(ARTIFACT_PUBLISH_TOOL.name).toBe("artifact_publish");
    expect(ARTIFACT_PUBLISH_TOOL.description).toMatch(/publish, save, hand over/);
    expect(ARTIFACT_PUBLISH_TOOL.description).toMatch(/Never search for another publish/);
    expect(ARTIFACT_PUBLISH_TOOL.description).toMatch(/read it with artifact_read and publish the edited whole with its id/);
    expect(ARTIFACT_PUBLISH_TOOL.description).toMatch(/Never create a new artifact for an edit/);
    expect(ARTIFACT_PUBLISH_TOOL.input_schema.required).toEqual([]);
    expect(Object.keys(ARTIFACT_PUBLISH_TOOL.input_schema.properties).sort()).toEqual(["content", "id", "mime", "name", "path"]);
    expect(ARTIFACT_READ_TOOL.name).toBe("artifact_read");
    expect(ARTIFACT_READ_TOOL.description).toMatch(/artifact_publish and the same id; never create a new artifact for an edit/);
    expect(ARTIFACT_READ_TOOL.input_schema.required).toEqual(["id"]);
    expect(Object.keys(ARTIFACT_READ_TOOL.input_schema.properties)).toEqual(["id"]);
    for (const d of [ARTIFACT_PUBLISH_TOOL.description, ARTIFACT_READ_TOOL.description]) expect(d).not.toMatch(/share|link|access/i);
  });
});

describe("artifact_publish — running it", () => {
  it("reads a file from the folder and hands its bytes to the host's store; the answer names the artifact", async () => {
    const { folder } = fresh();
    const s = store();
    const r = await runArtifactPublish({ path: "report.html", name: "Q3 report.html" }, ctx({ workdir: folder, artifacts: s.artifacts }));
    expect(r.failed).toBe(false);
    expect(r.text.split("\n")[0]).toBe("Published Q3 report.html to the user's Artifacts");
    expect(JSON.parse(r.text.split("\n")[1]!)).toEqual({ id: "Q3 report.html", name: "Q3 report.html", mime: "text/html", sizeBytes: 11 });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.id).toBeNull();
    expect(s.calls[0]!.name).toBe("Q3 report.html");
    expect(text(s.calls[0]!.bytes)).toBe("<h1>Q3</h1>");
  });

  it("inline content goes in as UTF-8; a bare name takes the mime's extension", async () => {
    const { folder } = fresh();
    const s = store();
    const r = await runArtifactPublish({ content: "# hi ✓", name: "notes", mime: "text/markdown" }, ctx({ workdir: folder, artifacts: s.artifacts }));
    expect(r.failed).toBe(false);
    expect(s.calls[0]!.name).toBe("notes.md");
    expect(text(s.files.get("notes.md")!)).toBe("# hi ✓");
  });

  it("with an id it UPDATES in place: the store gets the id and no name, and the answer says Updated", async () => {
    const { folder } = fresh();
    const s = store({ "report.html": "<h1>Q3</h1>" });
    const r = await runArtifactPublish({ id: "report.html", content: "<h1>Q3 v2</h1>" }, ctx({ workdir: folder, artifacts: s.artifacts }));
    expect(r.failed).toBe(false);
    expect(r.text.split("\n")[0]).toBe("Updated report.html to the user's Artifacts");
    expect(s.calls[0]).toMatchObject({ id: "report.html", name: null });
    expect(text(s.files.get("report.html")!)).toBe("<h1>Q3 v2</h1>");
    expect(s.files.size).toBe(1);
  });

  it("an update with a new name renames, and the answer carries the id it has from then on", async () => {
    const { folder } = fresh();
    const s = store({ "report.html": "<h1>Q3</h1>" });
    const r = await runArtifactPublish({ id: "report.html", path: "report.html", name: "Q3 final" }, ctx({ workdir: folder, artifacts: s.artifacts }));
    expect(r.failed).toBe(false);
    expect(JSON.parse(r.text.split("\n")[1]!)).toMatchObject({ id: "Q3 final.html", name: "Q3 final.html" });
    expect([...s.files.keys()]).toEqual(["Q3 final.html"]);
  });

  it("an update the store refuses comes back in its words, and an update still needs a source", async () => {
    const { folder } = fresh();
    const s = store();
    expect(await runArtifactPublish({ id: "gone.html", content: "x" }, ctx({ workdir: folder, artifacts: s.artifacts })))
      .toEqual({ failed: true, text: "Updating gone.html failed: that artifact is no longer here" });
    expect(await runArtifactPublish({ id: "a1" }, ctx({ workdir: folder, artifacts: s.artifacts }))).toMatchObject({ failed: true, text: expect.stringMatching(/one of them/) });
    expect(s.calls).toHaveLength(1);
  });

  it("stays inside the folder: .., an absolute path and a symlink out are refused before the store is touched", async () => {
    const { folder, outside } = fresh();
    symlinkSync(outside, join(folder, "link"));
    const s = store();
    for (const p of ["../outside/secret.txt", join(outside, "secret.txt"), "link/secret.txt"]) {
      const r = await runArtifactPublish({ path: p, name: "s.txt" }, ctx({ workdir: folder, artifacts: s.artifacts }));
      expect(r.failed).toBe(true);
      expect(r.text).toMatch(/outside this session's folder/);
    }
    expect(s.calls).toEqual([]);
  });

  it("a Work turn has no folder to read from, so a path is refused and inline content is the way", async () => {
    const { folder } = fresh();
    const s = store();
    const byPath = await runArtifactPublish({ path: "report.html", name: "r.html" }, ctx({ workdir: folder, hasFolder: false, artifacts: s.artifacts }));
    expect(byPath).toMatchObject({ failed: true, text: expect.stringMatching(/no folder/) });
    const inline = await runArtifactPublish({ content: "<p>x</p>", name: "r.html" }, ctx({ workdir: folder, hasFolder: false, artifacts: s.artifacts }));
    expect(inline.failed).toBe(false);
    expect(s.calls).toHaveLength(1);
  });

  it("refuses a bad input in words: no name, both sources, neither, a folder, a missing file, over 25 MB", async () => {
    const { folder } = fresh();
    mkdirSync(join(folder, "dir"));
    writeFileSync(join(folder, "big.bin"), Buffer.alloc(ARTIFACT_SIZE_CAP + 1));
    const s = store();
    const c = ctx({ workdir: folder, artifacts: s.artifacts });
    expect(await runArtifactPublish({ path: "report.html" }, c)).toMatchObject({ failed: true, text: expect.stringMatching(/name is required/) });
    expect(await runArtifactPublish({ path: "report.html", name: "x".repeat(201) }, c)).toMatchObject({ failed: true, text: expect.stringMatching(/200 characters/) });
    expect(await runArtifactPublish({ path: "report.html", content: "x", name: "a.html" }, c)).toMatchObject({ failed: true, text: expect.stringMatching(/one of them/) });
    expect(await runArtifactPublish({ name: "a.html" }, c)).toMatchObject({ failed: true, text: expect.stringMatching(/one of them/) });
    expect(await runArtifactPublish({ path: "dir", name: "a.html" }, c)).toMatchObject({ failed: true, text: expect.stringMatching(/not a file/) });
    expect((await runArtifactPublish({ path: "nope.html", name: "a.html" }, c)).failed).toBe(true);
    expect(await runArtifactPublish({ path: "big.bin", name: "big.bin" }, c)).toMatchObject({ failed: true, text: expect.stringMatching(/25 MB at most/) });
    expect(await runArtifactPublish({ content: "x".repeat(ARTIFACT_SIZE_CAP + 1), name: "big.txt" }, c)).toMatchObject({ failed: true, text: expect.stringMatching(/25 MB at most/) });
    expect(s.calls).toEqual([]);
  });

  it("a host without a store says so", async () => {
    const { folder } = fresh();
    expect(await runArtifactPublish({ content: "x", name: "a.txt" }, ctx({ workdir: folder, artifacts: null }))).toEqual({ failed: true, text: "Artifacts are not kept on this host." });
  });
});

describe("artifact_read — running it", () => {
  it("hands back { meta, text } for a text mime", async () => {
    const s = store({ "report.html": "<h1>Q3</h1>" });
    const r = await runArtifactRead({ id: "report.html" }, { artifacts: s.artifacts });
    expect(r.failed).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ meta: { id: "report.html", name: "report.html", mime: "text/html", sizeBytes: 11, updatedAt: "2026-10-18T10:00:00.000Z" }, text: "<h1>Q3</h1>" });
  });

  it("a binary artifact comes back as its meta and a note with size and type", async () => {
    const s = store({ "chart.png": "\x89PNG" });
    const r = await runArtifactRead({ id: "chart.png" }, { artifacts: s.artifacts });
    expect(r.failed).toBe(false);
    const out = JSON.parse(r.text) as { meta: ArtifactMeta; note: string; text?: string };
    expect(out.meta.mime).toBe("image/png");
    expect(out.text).toBeUndefined();
    expect(out.note).toBe(`chart.png is image/png, ${out.meta.sizeBytes} bytes: no text to show. Publish new bytes from a file to replace it.`);
  });

  it("cuts a text past the read cap and says so, so an update from it is known to be partial", async () => {
    const s = store({ "big.txt": "x".repeat(ARTIFACT_READ_CAP + 5) });
    const out = JSON.parse((await runArtifactRead({ id: "big.txt" }, { artifacts: s.artifacts })).text) as { text: string; truncated: boolean; note: string };
    expect(out.text).toHaveLength(ARTIFACT_READ_CAP);
    expect(out.truncated).toBe(true);
    expect(out.note).toMatch(/would lose the rest/);
  });

  it("refuses without an id or a store, and a missing artifact comes back in the store's words", async () => {
    const s = store();
    expect(await runArtifactRead({}, { artifacts: s.artifacts })).toMatchObject({ failed: true, text: expect.stringMatching(/id is required/) });
    expect(await runArtifactRead({ id: "a1" }, { artifacts: null })).toEqual({ failed: true, text: "Artifacts are not kept on this host." });
    expect(await runArtifactRead({ id: "a1" }, { artifacts: s.artifacts })).toEqual({ failed: true, text: "Reading artifact a1 failed: that artifact is no longer here" });
  });
});

/** One scripted model reply as SSE: text and/or one tool call. */
function reply(r: { text?: string; tool?: { id: string; name: string; input: unknown }; stop: "end_turn" | "tool_use" }): string {
  const ev = (e: string, d: unknown): string => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
  let out = ev("message_start", { type: "message_start", message: { usage: { input_tokens: 10 } } });
  let idx = 0;
  if (r.text) {
    out += ev("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
    out += ev("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: r.text } });
    out += ev("content_block_stop", { type: "content_block_stop", index: idx });
    idx++;
  }
  if (r.tool) {
    out += ev("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: r.tool.id, name: r.tool.name, input: {} } });
    out += ev("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(r.tool.input) } });
    out += ev("content_block_stop", { type: "content_block_stop", index: idx });
  }
  out += ev("message_delta", { type: "message_delta", delta: { stop_reason: r.stop }, usage: { output_tokens: 5 } });
  return out + ev("message_stop", { type: "message_stop" });
}

describe("artifact_publish — on the belt", () => {
  const plainShell = (sh: string, cmd: string) => ({ file: sh, args: ["-lc", cmd], sandboxed: false });

  function world(replies: string[]) {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchLike = async (url: string, init: RequestInit): Promise<Response> => {
      if (url.endsWith("/v1/messages")) {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(replies.shift() ?? "", { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    };
    return { bodies, fetchLike };
  }

  it("is offered in BOTH spaces when the host keeps artifacts, and a Code turn publishes a file from the folder into the store", async () => {
    const { folder } = fresh();
    const w = world([
      reply({ tool: { id: "t1", name: "artifact_publish", input: { path: "report.html", name: "report.html" } }, stop: "tool_use" }),
      reply({ text: "Published.", stop: "end_turn" }),
      reply({ text: "Hello.", stop: "end_turn" }),
    ]);
    const s = store();
    const loop = new GlyphhLoop({ shell: plainShell, gateway: async () => ({ baseUrl: "https://gw", token: "sk-member" }), fetch: w.fetchLike, artifacts: s.artifacts });
    const events: LoopEvent[] = [];
    await loop.run({ chatId: "code", text: "publish the report", model: "m", workdir: folder, space: "code", permission: "acceptEdits" }, (ev) => { events.push(ev); });
    const names = (w.bodies[0]!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("artifact_publish");
    expect(names).toContain("artifact_read");
    expect(names).toContain("bash");
    expect(s.calls).toHaveLength(1);
    expect(text(s.files.get("report.html")!)).toBe("<h1>Q3</h1>");
    const done = events.find((e) => e.type === "tool" && e.phase === "done") as { failed: boolean; preview: string };
    expect(done.failed).toBe(false);
    expect(done.preview).toContain("Published report.html to the user's Artifacts");
    const result = (w.bodies[1]!.messages as Array<{ content: unknown }>).at(-1)!.content as Array<{ is_error: boolean; content: string }>;
    expect(result[0]!.is_error).toBe(false);
    expect(result[0]!.content).toContain('"id":"report.html"');

    await loop.run({ chatId: "work", text: "hi", model: "m", space: "work" }, () => undefined);
    const work = (w.bodies[2]!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(work).toContain("artifact_publish");
    expect(work).toContain("artifact_read");
    expect(work).not.toContain("bash");
  });

  it("an edit in a Work turn: the model reads the artifact in hand, then publishes with its id, and nothing new is created", async () => {
    const w = world([
      reply({ tool: { id: "t1", name: "artifact_read", input: { id: "report.html" } }, stop: "tool_use" }),
      reply({ tool: { id: "t2", name: "artifact_publish", input: { id: "report.html", content: "<h1>Q3 revised</h1>" } }, stop: "tool_use" }),
      reply({ text: "Updated.", stop: "end_turn" }),
    ]);
    const s = store({ "report.html": "<h1>Q3</h1>" });
    const loop = new GlyphhLoop({ shell: plainShell, gateway: async () => ({ baseUrl: "https://gw", token: "sk-member" }), fetch: w.fetchLike, artifacts: s.artifacts });
    const events: LoopEvent[] = [];
    await loop.run({ chatId: "work", text: "fix the title of the report", model: "m", space: "work", permission: "acceptEdits" }, (ev) => { events.push(ev); });
    const read = (w.bodies[1]!.messages as Array<{ content: unknown }>).at(-1)!.content as Array<{ is_error: boolean; content: string }>;
    expect(read[0]!.is_error).toBe(false);
    expect(JSON.parse(read[0]!.content)).toMatchObject({ meta: { id: "report.html", name: "report.html" }, text: "<h1>Q3</h1>" });
    expect([...s.files.keys()]).toEqual(["report.html"]);
    expect(text(s.files.get("report.html")!)).toBe("<h1>Q3 revised</h1>");
    const done = events.filter((e) => e.type === "tool" && e.phase === "done") as Array<{ failed: boolean; preview: string }>;
    expect(done.map((d) => d.failed)).toEqual([false, false]);
    expect(done[1]!.preview).toContain("Updated report.html to the user's Artifacts");
  });

  it("a host that keeps no artifacts carries neither tool", async () => {
    const w = world([reply({ text: "Hello.", stop: "end_turn" })]);
    const loop = new GlyphhLoop({ shell: plainShell, gateway: async () => ({ baseUrl: "https://gw", token: "sk-member" }), fetch: w.fetchLike });
    await loop.run({ chatId: "work", text: "hi", model: "m", space: "work" }, () => undefined);
    const names = (w.bodies[0]!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain("artifact_publish");
    expect(names).not.toContain("artifact_read");
  });
});
