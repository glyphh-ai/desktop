/**
 * cloud-source.test.ts — the cloud session's chips as pure rules, shared by
 * the phone and the desktop-width web agent window (his report, 2026-10-05:
 * "how does the user pick a new cloud env or connect github? It looks like
 * the chip is removed in web"), plus the composer's chip set (his report,
 * 2026-10-05: Work → Code → + New left the folder options hidden).
 */
import { describe, expect, it } from "vitest";
import {
  cloudSource, sourceForPicks, cloudSendBlock, webCloudSendBlock, picksOf, environmentIdOf, isCloudKind,
  cloudLabel, envChipLabel, repoChipLabel, folderChipLabel, cloudChipsModel, composerChipSet,
  NETWORK_OPTIONS, networkLabel, environmentName, environmentSubline, parseDotenv, environmentFormError, maskedDotenv, environmentSaveError,
  toggleRepo, setBranch, groupRepos, accountHeaders, manageRows, MANAGE_FALLBACK_URL, splitRepo, pendingLinkInUrl, stripPendingLink, gitCompleteError,
} from "../../src/renderer/help/cloud-source";
import { LOCUS_LOCKED_HINT } from "../../src/renderer/help/session-locus";

const api = { id: "1", fullName: "glyphh-ai/api", private: true, defaultBranch: "main" };
const server = { id: "2", fullName: "glyphh-ai/server", private: true, defaultBranch: "glyphh-main" };
const widgets = { id: "3", fullName: "acme/widgets", private: false, defaultBranch: "master" };
const two = [{ repo: "glyphh-ai/api", branch: "main" }, { repo: "glyphh-ai/server", branch: "glyphh-main" }];

describe("the cloud source", () => {
  it("is born from the picks — the first pick is the repo the worker checks out", () => {
    expect(cloudSource(two, "env_1")).toEqual({ kind: "cloud-repo", repo: "glyphh-ai/api", branch: "main", repos: two, environmentId: "env_1" });
    expect(cloudSource(two)).toMatchObject({ environmentId: "default" });
    expect(cloudSource([])).toBeNull();
  });
  it("keeps the environment pick while no repo is picked (sourceForPicks)", () => {
    expect(sourceForPicks([], "env_1")).toEqual({ kind: "cloud-new", environmentId: "env_1" });
    expect(sourceForPicks([two[0]], "env_1")).toMatchObject({ kind: "cloud-repo", repo: "glyphh-ai/api" });
    expect(environmentIdOf(sourceForPicks([], "env_1"))).toBe("env_1");
    expect(environmentIdOf({ kind: "cloud-space", space: "s" })).toBe("default");
    expect(environmentIdOf(null)).toBe("default");
  });
  it("reads the picks back from any record shape", () => {
    expect(picksOf({ kind: "cloud-repo", repo: "glyphh-ai/api", branch: "main", repos: two })).toEqual(two);
    expect(picksOf({ kind: "cloud-repo", repo: "glyphh-ai/api" })).toEqual([{ repo: "glyphh-ai/api", branch: "" }]);
    expect(picksOf({ kind: "local", path: "/x" })).toEqual([]);
    expect(isCloudKind("cloud-space")).toBe(true);
    expect(isCloudKind("local")).toBe(false);
  });
});

describe("the send gate", () => {
  it("is GitHub itself: linked, and one repo", () => {
    expect(cloudSendBlock(false, [])).toBe("Connect GitHub to start a cloud session");
    expect(cloudSendBlock(true, [])).toBe("Choose a repository");
    expect(cloudSendBlock(true, [two[0]])).toBe("");
  });
  it("applies only to an UNBORN cloud session on the web", () => {
    const base = { surface: "web" as const, locus: "cloud" as const, born: false, connected: false, picks: [] };
    expect(webCloudSendBlock(base)).toBe("Connect GitHub to start a cloud session");
    expect(webCloudSendBlock({ ...base, born: true })).toBe("");
    expect(webCloudSendBlock({ ...base, locus: "local" })).toBe("");
    expect(webCloudSendBlock({ ...base, surface: "desktop" })).toBe("");
    expect(webCloudSendBlock({ ...base, connected: true, picks: [two[0]] })).toBe("");
  });
});

describe("the two chips", () => {
  it("label the environment and the repos as the phone does", () => {
    expect(envChipLabel("cloud")).toBe("Default");
    expect(envChipLabel("cloud", "Chris's MacBook", "Prod")).toBe("Prod");
    expect(envChipLabel("local", "Chris's MacBook")).toBe("Chris's MacBook");
    expect(envChipLabel("local")).toBe("Desktop");
    expect(repoChipLabel([], false)).toBe("Connect GitHub");
    expect(repoChipLabel([], true)).toBe("Choose repositories");
    expect(repoChipLabel([two[0]], true)).toBe("1 repo · 1 branch");
    expect(repoChipLabel(two, true)).toBe("2 repos · 2 branches");
    expect(folderChipLabel("/Users/x/dev/yo")).toBe("yo");
    expect(cloudLabel({ kind: "cloud-repo", repo: "glyphh-ai/api" })).toBe("Cloud · api");
  });
  it("show the repo chip in the cloud only; a desktop session names its machine", () => {
    const cloud = cloudChipsModel({ locus: "cloud", born: false, environmentName: "Prod", connected: true, picks: two, lockedHint: LOCUS_LOCKED_HINT });
    expect(cloud.env).toMatchObject({ label: "Prod", locked: false });
    expect(cloud.repo).toMatchObject({ shown: true, label: "2 repos · 2 branches", locked: false });
    const desk = cloudChipsModel({ locus: "local", born: false, machineName: "Chris's MacBook", connected: false, picks: [], lockedHint: LOCUS_LOCKED_HINT });
    expect(desk.env.label).toBe("Chris's MacBook");
    expect(desk.repo.shown).toBe(false);
  });
  it("are read-only on a born session, and say why", () => {
    const born = cloudChipsModel({ locus: "cloud", born: true, connected: false, picks: two, lockedHint: LOCUS_LOCKED_HINT });
    expect(born.env).toMatchObject({ locked: true, title: LOCUS_LOCKED_HINT.cloud });
    expect(born.repo).toMatchObject({ locked: true, title: LOCUS_LOCKED_HINT.cloud, label: "2 repos · 2 branches" });
    const local = cloudChipsModel({ locus: "local", born: true, machineName: "M", connected: false, picks: [], lockedHint: LOCUS_LOCKED_HINT });
    expect(local.env.title).toBe(LOCUS_LOCKED_HINT.local);
  });
});

describe("the composer's chip set (his report, 2026-10-05: Work → Code → + New)", () => {
  it("the web's cloud pair, or the environment + folder on an attached desktop", () => {
    expect(composerChipSet({ surface: "web", locus: "cloud", attached: false })).toEqual({ environment: true, repo: true, folder: false });
    expect(composerChipSet({ surface: "web", locus: "local", attached: true })).toEqual({ environment: true, repo: false, folder: true });
    expect(composerChipSet({ surface: "web", locus: "local", attached: false })).toEqual({ environment: true, repo: false, folder: false });
  });
  it("keeps the desktop app's one folder chip", () => {
    expect(composerChipSet({ surface: "desktop", locus: "local", attached: true })).toEqual({ environment: false, repo: false, folder: true });
  });
});

describe("named environments", () => {
  it("names the network policies in the screenshot's words", () => {
    expect(NETWORK_OPTIONS.map((o) => o.label)).toEqual(["No network access", "Trusted network access", "Full network access"]);
    expect(networkLabel("none")).toBe("No network access");
    expect(networkLabel(undefined)).toBe("Full network access");
  });
  it("names a pick among the rows; a gone pick is Default", () => {
    const rows = [{ id: "e1", name: "Prod", network: "trusted" as const, varCount: 2 }];
    expect(environmentName("e1", rows)).toBe("Prod");
    expect(environmentName("gone", rows)).toBe("Default");
    expect(environmentName(undefined, rows)).toBe("Default");
    expect(environmentSubline(rows[0])).toBe("Trusted network access · 2 variables");
    expect(environmentSubline({ network: "full", varCount: 1 })).toBe("Full network access · 1 variable");
  });
  it("reads .env text like the server, naming a bad line", () => {
    expect(parseDotenv("# c\nexport A=1\nB=\"x y\"\n\nA=2")).toEqual({ ok: true, keys: ["A", "B"] });
    expect(parseDotenv("A=1\nnot a var")).toEqual({ ok: false, line: 2, error: "Line 2: expected KEY=VALUE with a key like API_KEY" });
    expect(parseDotenv("1A=1")).toMatchObject({ ok: false, line: 1 });
  });
  it("checks the form before the POST", () => {
    expect(environmentFormError({ name: "", vars: "" })).toBe("Name the environment");
    expect(environmentFormError({ name: "default", vars: "" })).toBe("Default is the built-in environment — pick another name");
    expect(environmentFormError({ name: "x".repeat(61), vars: "" })).toBe("Names are 60 characters at most");
    expect(environmentFormError({ name: "Prod", vars: "oops" })).toBe("Line 1: expected KEY=VALUE with a key like API_KEY");
    expect(environmentFormError({ name: "Prod", vars: Array.from({ length: 65 }, (_, i) => `K${i}=v`).join("\n") })).toBe("At most 64 variables");
    expect(environmentFormError({ name: "Prod", vars: "A=1" })).toBe("");
  });
  it("shows an edit as masked KEY=preview lines, and words a failed save by status", () => {
    expect(maskedDotenv([{ key: "API_KEY", preview: "hu•••••" }, { key: "B", preview: "•••••" }])).toBe("API_KEY=hu•••••\nB=•••••");
    expect(environmentSaveError(Object.assign(new Error("name taken"), { httpStatus: 409 }))).toBe("name taken");
    expect(environmentSaveError(Object.assign(new Error(""), { httpStatus: 409 }))).toBe("You already have an environment with that name");
    expect(environmentSaveError(Object.assign(new Error("x"), { httpStatus: 404 }))).toBe("This environment is gone — it was deleted elsewhere");
    expect(environmentSaveError(new Error("boom"))).toBe("boom");
    expect(environmentSaveError(null)).toBe("The environment could not be saved.");
  });
});

describe("the repositories list", () => {
  it("toggles a pick with the repo's default branch; the branch step changes it", () => {
    const one = toggleRepo([], api);
    expect(one).toEqual([{ repo: "glyphh-ai/api", branch: "main" }]);
    expect(toggleRepo(one, server)).toEqual(two);
    expect(toggleRepo(two, api)).toEqual([two[1]]);
    expect(setBranch(two, "glyphh-ai/server", "release")).toEqual([two[0], { repo: "glyphh-ai/server", branch: "release" }]);
  });
  it("groups by account in the server's order (the member's own first), names alphabetical, searched by substring across every account", () => {
    expect(groupRepos([server, widgets, api]).map((g) => [g.account, g.repos.map((r) => r.fullName)])).toEqual([
      ["glyphh-ai", ["glyphh-ai/api", "glyphh-ai/server"]], ["acme", ["acme/widgets"]],
    ]);
    expect(groupRepos([server, widgets, api], "SERV").map((g) => g.repos.map((r) => r.fullName))).toEqual([["glyphh-ai/server"]]);
    // The installation account leads over the owner segment (a fork an org installation lists).
    const forked = { ...widgets, account: "timmetim" };
    expect(groupRepos([forked, api]).map((g) => g.account)).toEqual(["timmetim", "glyphh-ai"]);
    expect(groupRepos([forked, api], "widg").map((g) => [g.account, g.repos.length])).toEqual([["timmetim", 1]]);
    expect(splitRepo("glyphh-ai/api")).toEqual({ owner: "glyphh-ai", name: "api" });
    expect(splitRepo("bare")).toEqual({ owner: "", name: "bare" });
  });
  it("wears account headers only when the member reaches more than one account, judged over the whole list", () => {
    expect(accountHeaders([server, api])).toBe(false);
    expect(accountHeaders([])).toBe(false);
    expect(accountHeaders([server, widgets])).toBe(true);
    expect(accountHeaders([{ ...api, account: "timmetim" }, { ...server, account: "glyphh-ai" }])).toBe(true);
  });
  it("offers one manage row per installation when there are several, else the single row to the one page", () => {
    const mine = { id: "9002", account: "timmetim", type: "User" as const, url: "https://github.com/settings/installations/9002" };
    const org = { id: "9001", account: "glyphh-ai", type: "Organization" as const, url: "https://github.com/organizations/glyphh-ai/settings/installations/9001" };
    expect(manageRows({ installations: [mine, org] }).map((r) => [r.label, r.url])).toEqual([
      ["Manage timmetim repositories…", mine.url], ["Manage glyphh-ai repositories…", org.url],
    ]);
    expect(manageRows({ installations: [mine, org] })[1].hint).toMatch(/organization/);
    expect(manageRows({ installationUrl: org.url, installations: [org] })).toEqual([{ label: "Manage repository access…", hint: "Change which repositories the Glyphh app may reach, on GitHub", url: org.url }]);
    expect(manageRows({ installationUrl: org.url })[0].url).toBe(org.url);
    expect(manageRows({}).map((r) => r.url)).toEqual([MANAGE_FALLBACK_URL]);
    expect(manageRows(null)[0].url).toBe(MANAGE_FALLBACK_URL);
  });
});

describe("the GitHub return landing", () => {
  it("reads the pending link, strips it, and words a failed completion", () => {
    expect(pendingLinkInUrl("?github=pending&link=n0nce")).toBe("n0nce");
    expect(pendingLinkInUrl("?github=pending")).toBe("");
    expect(pendingLinkInUrl("?x=1")).toBeNull();
    expect(stripPendingLink("https://app.glyphh.ai/home?github=pending&link=n0nce&keep=1#t")).toBe("/home?keep=1#t");
    expect(gitCompleteError(Object.assign(new Error("x"), { httpStatus: 403 }))).toBe("This GitHub link was started by another account");
    expect(gitCompleteError(Object.assign(new Error("x"), { httpStatus: 404 }))).toBe("The GitHub link expired — connect again");
    expect(gitCompleteError(new Error("boom"))).toBe("boom");
    expect(gitCompleteError(undefined)).toBe("GitHub could not be linked.");
  });
});
