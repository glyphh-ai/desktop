/**
 * legacy-app-sweep.test.ts — THE LOCAL APP FOLDERS ARE DELETED, NO MIGRATION
 * (his word, 2026-10-05 / 2026-10-06: cloud is the one home). The rule
 * (localAppFolders) and the sweep over a temp apps home: what goes — every
 * app folder, house bundles included, and the payload roots — what stays, and
 * the once-per-user marker.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_SWEEP_MARKER, localAppFolders, payloadDirs, sweepLocalAppFolders, type SweepDeps } from "../../src/main/legacy-app-sweep.js";
import type { LocalAppRow } from "../../src/main/apps-store.js";

const glyphhRow = (nativeRef: string | null, config: Record<string, unknown> | null = null): { kind: "glyphh"; nativeRef: string | null; config: Record<string, unknown> | null } =>
  ({ kind: "glyphh", nativeRef, config });

describe("localAppFolders — the rule", () => {
  it("names every folder with a bundle manifest, house apps included", () => {
    expect(localAppFolders([
      { slug: "expense-desk", hasManifest: true, row: null },
      { slug: "images", hasManifest: true, row: glyphhRow("/x/apps/images/ui/index.html", { tool: "gimage" }) },
    ])).toEqual(["expense-desk", "images"]);
  });
  it("names a glyphh row whose entry is a file here and which names no instance", () => {
    expect(localAppFolders([{ slug: "zipped", hasManifest: false, row: glyphhRow("/x/custom-apps/zipped/index.html", { capabilities: [] }) }])).toEqual(["zipped"]);
  });
  it("keeps a glyphh row that names its instance — that app is in the cloud", () => {
    expect(localAppFolders([{ slug: "named", hasManifest: false, row: glyphhRow("/x/custom-apps/named/index.html", { instance: "named~u1" }) }])).toEqual([]);
    expect(localAppFolders([{ slug: "cloudy", hasManifest: false, row: glyphhRow(null, { instance: "cloudy" }) }])).toEqual([]);
  });
  it("keeps a web or native tab's row and a folder that is nothing of ours", () => {
    expect(localAppFolders([
      { slug: "crm", hasManifest: false, row: { kind: "web", nativeRef: null, config: null } },
      { slug: "vscode", hasManifest: false, row: { kind: "native", nativeRef: "/Applications/VS Code.app", config: null } },
      { slug: "parked", hasManifest: false, row: null },
    ])).toEqual([]);
  });
  it("answers each slug once, lower-cased, in order, and skips an empty one", () => {
    const e = { hasManifest: true, row: null };
    expect(localAppFolders([{ slug: "B", ...e }, { slug: "a", ...e }, { slug: "b", ...e }, { slug: " ", ...e }])).toEqual(["b", "a"]);
  });
});

describe("sweepLocalAppFolders — the first sign-in after the cut", () => {
  let home = "";
  let appsDir = "";
  let customRoot = "";
  let appsRoot = "";
  let marker = "";
  const logs: string[] = [];

  const row = (slug: string, over: Partial<LocalAppRow>): LocalAppRow => ({
    id: slug, kind: "web", slug, name: slug, prodUrl: null, nativeRef: null, config: null, description: "", access: "members", owned: true,
    latestVersion: null, version: "0.1.0", secretNames: [], requiredConnections: [], listing: null, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...over,
  });
  const write = (rel: string, body: string): void => {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const bundle = (slug: string, manifest: Record<string, unknown>): void => {
    write(`apps/${slug}/SKILL.md`, `---\nname: ${slug}\n---\n`);
    write(`apps/${slug}/app.json`, JSON.stringify(manifest));
    write(`apps/${slug}/ui/index.html`, "<h1>hi</h1>");
  };
  const tab = (slug: string, r: LocalAppRow): void => write(`apps/${slug}/tab.json`, JSON.stringify(r));
  const readRow = (slug: string): LocalAppRow | null => {
    try { return JSON.parse(fs.readFileSync(path.join(appsDir, slug, "tab.json"), "utf-8")) as LocalAppRow; } catch { return null; }
  };
  const deps = (): SweepDeps => ({ appsDir, payloadRoots: [appsRoot, customRoot], marker, readRow, log: (l) => logs.push(l) });
  const has = (rel: string): boolean => fs.existsSync(path.join(home, rel));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "local-sweep-"));
    appsDir = path.join(home, "apps");
    customRoot = path.join(home, "custom-apps");
    appsRoot = path.join(home, "org-apps");
    marker = path.join(home, LOCAL_SWEEP_MARKER);
    logs.length = 0;
    // Bundles in the apps home, whatever their manifest says — a house app too.
    bundle("pre-cloud", { name: "Pre Cloud", ui: "ui/index.html" });
    bundle("keeper", { name: "Keeper", data: "local" });
    bundle("images", { name: "Images", tool: "gimage" });
    // A .glyphh unzipped into custom-apps with a glyphh row pointing at it, and one in the org-scoped root.
    write("custom-apps/zipped/manifest.json", JSON.stringify({ manifestVersion: 2, kind: "glyphh-app", name: "Zipped", slug: "zipped", entry: "index.html" }));
    write("custom-apps/zipped/index.html", "<h1>z</h1>");
    write("custom-apps/_libs/chart.js", "");
    tab("zipped", row("zipped", { kind: "glyphh", nativeRef: path.join(customRoot, "zipped", "index.html"), config: { capabilities: [] } }));
    write("org-apps/org1/scoped/manifest.json", JSON.stringify({ kind: "glyphh-app", name: "Scoped", slug: "scoped", entry: "index.html" }));
    tab("scoped", row("scoped", { kind: "glyphh", nativeRef: path.join(appsRoot, "org1", "scoped", "index.html"), config: {} }));
    // An older layout's tab row under the org-scoped root: not a bundle, stays.
    write("org-apps/gmail/tab.json", JSON.stringify(row("gmail", { kind: "web", prodUrl: "https://mail" })));
    // A glyphh row whose payload is already gone.
    tab("row-only", row("row-only", { kind: "glyphh", nativeRef: path.join(customRoot, "row-only", "index.html"), config: {} }));
    // In the cloud: a glyphh row that names its instance (with or without an old entry).
    tab("named", row("named", { kind: "glyphh", nativeRef: path.join(customRoot, "named", "index.html"), config: { instance: "named~u1" } }));
    tab("cloudy", row("cloudy", { kind: "glyphh", nativeRef: null, config: { instance: "cloudy" } }));
    // Not app folders at all: a web tab's row, a native tab's row, a hidden folder, a link.
    tab("crm", row("crm", { kind: "web", prodUrl: "https://crm" }));
    tab("code", row("code", { kind: "native", nativeRef: "/Applications/VS Code.app" }));
    write("apps/.cache/x", "");
    fs.mkdirSync(path.join(home, "dev-build"), { recursive: true });
    fs.writeFileSync(path.join(home, "dev-build", "app.json"), "{}");
    fs.symlinkSync(path.join(home, "dev-build"), path.join(appsDir, "linked"), "dir");
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it("payloadDirs names the unzipped bundles under a root, one or two levels down, and the shared _libs", () => {
    expect(payloadDirs(customRoot).sort()).toEqual([path.join(customRoot, "_libs"), path.join(customRoot, "zipped")]);
    expect(payloadDirs(appsRoot)).toEqual([path.join(appsRoot, "org1", "scoped")]);
    expect(payloadDirs(path.join(home, "nowhere"))).toEqual([]);
  });

  it("removes every app folder (bundles, house ones, unzipped payloads and their rows, a row alone) — nothing else", () => {
    const r = sweepLocalAppFolders(deps());
    expect(r.swept.sort()).toEqual(["images", "keeper", "pre-cloud", "row-only", "scoped", "zipped"]);
    expect(r.payloads.sort()).toEqual([path.join(appsRoot, "org1", "scoped"), path.join(customRoot, "_libs"), path.join(customRoot, "zipped")].sort());
    expect(r.skipped).toBeUndefined();
    // The flat root is emptied and goes; the org-scoped root keeps the older row and stays.
    for (const gone of ["apps/pre-cloud", "apps/keeper", "apps/images", "apps/zipped", "apps/scoped", "apps/row-only", "custom-apps", "org-apps/org1"]) expect(has(gone), gone).toBe(false);
    for (const kept of ["apps/named/tab.json", "apps/cloudy/tab.json", "apps/crm/tab.json", "apps/code/tab.json", "apps/.cache", "apps/linked", "dev-build/app.json", "org-apps/gmail/tab.json"]) expect(has(kept), kept).toBe(true);
    expect(logs.join("\n")).toContain("removed 6 app folders from this machine");
    expect(logs.join("\n")).toContain("3 unzipped bundles");
    const written = JSON.parse(fs.readFileSync(marker, "utf-8")) as { swept: string[]; payloads: string[] };
    expect(written.swept.sort()).toEqual(r.swept);
    expect(written.payloads.sort()).toEqual(r.payloads);
  });

  it("runs once per user: the marker ends every later run before it reads anything", () => {
    sweepLocalAppFolders(deps());
    bundle("late", { name: "Late" });
    expect(sweepLocalAppFolders(deps())).toEqual({ swept: [], payloads: [], skipped: "done" });
    expect(has("apps/late")).toBe(true);
  });

  it("with no app folder on the machine, still marks the user done", () => {
    for (const slug of ["pre-cloud", "keeper", "images", "zipped", "scoped", "row-only"]) fs.rmSync(path.join(appsDir, slug), { recursive: true, force: true });
    fs.rmSync(customRoot, { recursive: true, force: true });
    fs.rmSync(appsRoot, { recursive: true, force: true });
    expect(sweepLocalAppFolders(deps())).toEqual({ swept: [], payloads: [] });
    expect(fs.existsSync(marker)).toBe(true);
    expect(logs.join("\n")).toContain("no app folders on this machine");
  });
});
