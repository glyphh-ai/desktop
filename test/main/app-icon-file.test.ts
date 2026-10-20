/**
 * app-icon-file.test.ts — the icon an app tab carries off this machine (his
 * report, 2026-10-04: "app icons are not coming through on the app web").
 * A local icon file ≤ 24 KB rides the row as a data URL, cached per path +
 * mtime; a bigger one is left out; a URL tab carries the favicon URL the
 * desktop fetches, by the SAME host rule the web's /webicon proxy admits.
 * Real files in a temp folder; the row projection (org-apps.ts) over the
 * real apps store with its home pointed at that folder.
 */
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ICON_DATA_MAX_BYTES, FAVICON_HOST, appIconFileIn, faviconUrlFor, iconDataUrlForDirs, iconFileDataUrl, iconMimeOf, resetIconFileCache,
} from "../../src/main/app-icon-file.js";
import { FAVICON_HOST as WEB_FAVICON_HOST, faviconUrlForPage, isAllowedIconUrl } from "../../web/webicon.mjs";

const root = mkdtempSync(join(tmpdir(), "glyphh-app-icons-"));
vi.mock("../../src/main/app-paths.js", () => ({ userScopedPath: (...seg: string[]) => join(root, ...seg) }));
// THE TAB ROWS ARE THE LOCAL LIBRARY'S (member-library-local.ts): the test
// seeds its answer.
const TABS: Array<Record<string, unknown>> = [];
vi.mock("../../src/main/member-library-local.js", () => ({
  libraryRows: (kind: string) => (kind === "tab" ? TABS.map((r) => ({ id: String(r.slug), updatedAt: 1, data: r })) : []),
  libraryWrite: () => undefined,
  libraryDelete: () => undefined,
}));

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';
const dataUrl = (mime: string, body: string | Buffer) => `data:${mime};base64,${Buffer.from(body).toString("base64")}`;
let n = 0;
const fresh = (name: string): string => { const d = join(root, `case-${n++}`, name); mkdirSync(d, { recursive: true }); return d; };

beforeEach(() => resetIconFileCache());

describe("iconFileDataUrl — a local icon file as bytes", () => {
  it("reads an svg or png within the cap as a data URL of its type", () => {
    const d = fresh("ok");
    writeFileSync(join(d, "icon.svg"), SVG);
    expect(iconFileDataUrl(join(d, "icon.svg"))).toBe(dataUrl("image/svg+xml", SVG));
    const png = Buffer.alloc(ICON_DATA_MAX_BYTES, 7);
    writeFileSync(join(d, "icon.png"), png);
    expect(iconFileDataUrl(join(d, "icon.png"))).toBe(dataUrl("image/png", png));
    expect(ICON_DATA_MAX_BYTES).toBe(24 * 1024);
  });
  it("leaves out a file over the cap, an empty one, a non-image, a folder, and a missing path", () => {
    const d = fresh("no");
    writeFileSync(join(d, "big.png"), Buffer.alloc(ICON_DATA_MAX_BYTES + 1, 7));
    expect(iconFileDataUrl(join(d, "big.png"))).toBe("");
    writeFileSync(join(d, "empty.svg"), "");
    expect(iconFileDataUrl(join(d, "empty.svg"))).toBe("");
    writeFileSync(join(d, "icon.txt"), SVG);
    expect(iconFileDataUrl(join(d, "icon.txt"))).toBe("");
    expect(iconFileDataUrl(d)).toBe("");
    expect(iconFileDataUrl(join(d, "nope.svg"))).toBe("");
    expect(iconMimeOf("x.ICO")).toBe("image/x-icon");
    expect(iconMimeOf("x.exe")).toBe("");
  });
  it("answers from the cache while the file's mtime and size stand, and re-reads when they move", () => {
    const d = fresh("cache");
    const file = join(d, "icon.svg");
    // A whole-second mtime the file system reproduces exactly on restore.
    const T = 1_700_000_000;
    writeFileSync(file, SVG);
    utimesSync(file, T, T);
    const first = iconFileDataUrl(file);
    expect(first).toBe(dataUrl("image/svg+xml", SVG));
    // Same size, same mtime, different bytes: the cache answers.
    const swapped = SVG.replace("r=\"10\"", "r=\"11\"");
    writeFileSync(file, swapped);
    utimesSync(file, T, T);
    expect(statSync(file).mtimeMs).toBe(T * 1000);
    expect(iconFileDataUrl(file)).toBe(first);
    // A newer mtime: the new bytes.
    utimesSync(file, T + 5, T + 5);
    expect(iconFileDataUrl(file)).toBe(dataUrl("image/svg+xml", swapped));
    // A size change alone is enough too.
    writeFileSync(file, SVG + "<!-- -->");
    utimesSync(file, T + 5, T + 5);
    expect(iconFileDataUrl(file)).toBe(dataUrl("image/svg+xml", SVG + "<!-- -->"));
  });
});

describe("appIconFileIn — which file an app folder's icon is", () => {
  it("takes the manifest's icon when it names an image inside the folder", () => {
    const d = fresh("manifest");
    mkdirSync(join(d, "art"));
    writeFileSync(join(d, "art", "mark.png"), Buffer.from([1]));
    writeFileSync(join(d, "icon.svg"), SVG);
    writeFileSync(join(d, "app.json"), JSON.stringify({ name: "Shoes", icon: "art/mark.png" }));
    expect(appIconFileIn(d)).toBe(join(d, "art", "mark.png"));
  });
  it("falls to a bare icon.svg / icon.png when the manifest names none, escapes the folder, or is missing", () => {
    const d = fresh("bare");
    writeFileSync(join(d, "icon.png"), Buffer.from([1]));
    expect(appIconFileIn(d)).toBe(join(d, "icon.png"));
    writeFileSync(join(d, "icon.svg"), SVG);
    expect(appIconFileIn(d)).toBe(join(d, "icon.svg"));
    writeFileSync(join(d, "app.json"), JSON.stringify({ icon: "../../etc/passwd.png" }));
    expect(appIconFileIn(d)).toBe(join(d, "icon.svg"));
    writeFileSync(join(d, "app.json"), JSON.stringify({ icon: "missing.svg" }));
    expect(appIconFileIn(d)).toBe(join(d, "icon.svg"));
    writeFileSync(join(d, "app.json"), "not json");
    expect(appIconFileIn(d)).toBe(join(d, "icon.svg"));
    expect(appIconFileIn(fresh("none"))).toBe(null);
  });
  it("iconDataUrlForDirs takes the first folder with an icon within the cap, skipping blanks and repeats", () => {
    const big = fresh("big"); writeFileSync(join(big, "icon.png"), Buffer.alloc(ICON_DATA_MAX_BYTES + 1, 1));
    const ok = fresh("ok"); writeFileSync(join(ok, "icon.svg"), SVG);
    expect(iconDataUrlForDirs([null, undefined, big, big, ok])).toBe(dataUrl("image/svg+xml", SVG));
    expect(iconDataUrlForDirs([big, fresh("empty")])).toBe("");
  });
});

describe("faviconUrlFor — the favicon URL the desktop fetches, by the proxy's host rule", () => {
  it("is the same host rule as web/webicon.mjs, character for character", () => {
    expect(FAVICON_HOST.source).toBe(WEB_FAVICON_HOST.source);
    expect(FAVICON_HOST.flags).toBe(WEB_FAVICON_HOST.flags);
  });
  it("builds the URL the web proxy admits, and nothing for a URL it would not", () => {
    for (const u of [
      "https://www.reddit.com/r/all", "http://Monday.com/boards", "https://user:pw@slack.com:8443/x",
      "https://us02web.zoom.us/j/1", "yo://home", "file:///Users/me/index.html", "http://localhost:3000",
      "https://127.0.0.1", "not a url", "", null, undefined,
    ]) {
      const ours = faviconUrlFor(u);
      expect(ours, String(u)).toBe(faviconUrlForPage(u) ?? "");
      if (ours) expect(isAllowedIconUrl(ours), String(u)).toBe(true);
    }
    expect(faviconUrlFor("https://www.reddit.com/r/all")).toBe("https://www.google.com/s2/favicons?domain=www.reddit.com&sz=64");
    expect(faviconUrlFor("yo://home")).toBe("");
  });
});

describe("the row projection (org-apps.ts) — what panelApps.list and the desktop IPC carry", () => {
  it("adds iconDataUrl for an app with a local icon within the cap and faviconUrl for a URL tab, and nothing else changes", async () => {
    TABS.length = 0;
    const tab = (slug: string, row: Record<string, unknown>) => {
      TABS.push({
        id: slug, slug, name: slug, prodUrl: null, nativeRef: null, config: null, description: "", access: "members", owned: true,
        latestVersion: null, version: "", secretNames: [], requiredConnections: [], listing: null,
        createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...row,
      });
    };
    // A Glyphh app whose bundle folder is registered (config.bundleDir): app.json names icon.svg.
    const shoesDir = fresh("shoes");
    tab("shoes", { kind: "glyphh", nativeRef: join(shoesDir, "ui", "index.html"), config: { capabilities: [], bundleDir: shoesDir } });
    writeFileSync(join(shoesDir, "app.json"), JSON.stringify({ name: "Happy Shoes", icon: "icon.svg" }));
    writeFileSync(join(shoesDir, "icon.svg"), SVG);
    // A registered bundle elsewhere (config.bundleDir), icon.png at its root.
    const bundle = fresh("bundle");
    writeFileSync(join(bundle, "icon.png"), Buffer.from([9, 8, 7]));
    tab("webhome", { kind: "glyphh", nativeRef: join(bundle, "ui", "index.html"), config: { bundleDir: bundle } });
    // An installed .glyphh zip: icon.svg beside its entry, no bundleDir in config.
    const zipDir = fresh("zip");
    writeFileSync(join(zipDir, "icon.svg"), SVG);
    tab("installed", { kind: "glyphh", nativeRef: join(zipDir, "index.html"), config: {} });
    // A Glyphh app whose icon is over the cap: no iconDataUrl.
    const bigDir = fresh("big");
    tab("big", { kind: "glyphh", nativeRef: join(bigDir, "ui", "index.html"), config: { bundleDir: bigDir } });
    writeFileSync(join(bigDir, "icon.png"), Buffer.alloc(ICON_DATA_MAX_BYTES + 1, 1));
    // A URL tab, a native app, an internal URL.
    tab("reddit", { kind: "web", prodUrl: "https://www.reddit.com/" });
    tab("finder", { kind: "native", nativeRef: "/System/Library/CoreServices/Finder.app" });
    tab("home", { kind: "web", prodUrl: "yo://home" });

    const { fetchOrgApps } = await import("../../src/main/org-apps.js");
    const rows = await fetchOrgApps();
    const by = (slug: string) => rows.find((r) => r.slug === slug)!;
    expect(by("shoes").iconDataUrl).toBe(dataUrl("image/svg+xml", SVG));
    expect(by("webhome").iconDataUrl).toBe(dataUrl("image/png", Buffer.from([9, 8, 7])));
    expect(by("installed").iconDataUrl).toBe(dataUrl("image/svg+xml", SVG));
    expect("iconDataUrl" in by("big")).toBe(false);
    expect("faviconUrl" in by("big")).toBe(false);
    expect(by("reddit").faviconUrl).toBe("https://www.google.com/s2/favicons?domain=www.reddit.com&sz=64");
    expect("iconDataUrl" in by("reddit")).toBe(false);
    expect("iconDataUrl" in by("finder")).toBe(false);
    expect("faviconUrl" in by("finder")).toBe(false);
    expect("faviconUrl" in by("home")).toBe(false);
    // The rest of the row is the projection it always was.
    const KEYS = ["id", "orgId", "createdBy", "name", "slug", "system", "url", "isBrowser", "execPath", "appArchetype", "launchConfig", "access", "owned", "latestVersion", "version", "secretNames", "requiredConnections", "connectionIds", "iconUrl", "listing", "mcp", "commands", "createdAt", "updatedAt"];
    for (const r of rows) {
      const extra = Object.keys(r).filter((k) => !KEYS.includes(k));
      expect(extra.every((k) => k === "iconDataUrl" || k === "faviconUrl"), r.slug).toBe(true);
      for (const k of KEYS) expect(k in r, `${r.slug}.${k}`).toBe(true);
    }
    expect(by("reddit").url).toBe("https://www.reddit.com/");
    expect(by("shoes").appArchetype).toBe("glyphh-app");
    expect(by("shoes").iconUrl).toBe(null);
  });
});
