/**
 * cloud-source.ts — a CLOUD session's source, as pure rules shared by every
 * web surface (his report, 2026-10-05: "from here, not in mobile, how does
 * the user pick a new cloud env or connect github? It looks like the chip is
 * removed in web"). The phone (web/src/mobile.tsx) and the desktop-width
 * agent window (help/cloud-chips.ts) paint the SAME two chips above the
 * composer — an ENVIRONMENT chip and a REPO chip — from these functions;
 * neither keeps a second copy.
 *
 *   · the cloud source record (`cloud-repo` + the picks + `environmentId`),
 *     and the send gate (GitHub linked + one repo — his rule, 2026-10-05);
 *   · the chip labels, the repositories list (toggle, grouping, search) and
 *     the base-branch pick;
 *   · the NAMED ENVIRONMENTS (his direction, 2026-10-05: personal
 *     environments): the network words, the .env reading, the form check;
 *   · the GitHub return landing (`?github=pending&link=…`) and the words a
 *     failed completion earns.
 *
 * Nothing here touches the DOM or the network. The locus rule itself (fixed
 * at birth, desktop where one is attached else the cloud) is session-locus.ts.
 */
import { type Locus } from "./session-locus.js";

/** A repository as the SDK lists it (contract/git.ts Repo): `account` is the
 *  installation account it listed through — the member's own login or an org
 *  of theirs (2026-10-05: the list spans every installation they reach). */
export interface RepoRow { id: string; fullName: string; private: boolean; defaultBranch: string; url?: string; account?: string; installationId?: string }

/** One installation the member reaches (contract/git.ts GitInstallation). */
export interface GitInstallationRow { id: string; account: string; type: "User" | "Organization"; url: string }

/** One picked repo + the base branch it checks out on. */
export interface RepoPick { repo: string; branch: string }

/** A branch as the base-branch list shows it. */
export interface BranchRow { name: string; default: boolean }

/** The built-in environment: not a record, the absent pick. */
export const DEFAULT_ENVIRONMENT_ID = "default";
export const DEFAULT_ENVIRONMENT_NAME = "Default";

/**
 * The cloud session's source, as the thread record stores it VERBATIM (the
 * server's `source` is jsonb). `kind`/`repo` are the web's own Source shape
 * (code-source-chip.ts) so remote-run.ts reads it unchanged: `repo` is the
 * FIRST pick — the worker checks out ONE repo today (rrotor harness
 * config.ts `repo`); the whole selection rides in `repos` so multi-repo can
 * follow without a record change. `environmentId` is the member's named
 * environment the session runs in ("default" = the built-in one).
 */
export interface CloudSource { kind: "cloud-repo"; repo: string; branch: string; repos: RepoPick[]; environmentId: string }

/** The source a selection becomes: the first pick leads. Null with no pick —
 *  a cloud session is never born without a repo (his rule, 2026-10-05: "the
 *  connect GitHub is a hard limit to creating a web dev env"). */
export function cloudSource(picks: readonly RepoPick[], environmentId: string = DEFAULT_ENVIRONMENT_ID): CloudSource | null {
  const first = picks[0];
  if (!first) return null;
  return { kind: "cloud-repo", repo: first.repo, branch: first.branch, repos: picks.map((p) => ({ ...p })), environmentId: environmentId || DEFAULT_ENVIRONMENT_ID };
}

/** The source the chips write for a selection: the cloud-repo record when a
 *  repo is picked, else the bare cloud workspace carrying the environment
 *  pick — so clearing the last repo keeps the environment, and the send
 *  gate (cloudSendBlock) is what refuses the turn. */
export function sourceForPicks(picks: readonly RepoPick[], environmentId: string = DEFAULT_ENVIRONMENT_ID): CloudSource | { kind: "cloud-new"; environmentId: string } {
  return cloudSource(picks, environmentId) ?? { kind: "cloud-new", environmentId: environmentId || DEFAULT_ENVIRONMENT_ID };
}

/** The environment a stored source names; an older record (or none) is Default. */
export function environmentIdOf(source: object | null | undefined): string {
  const id = (source as { environmentId?: unknown } | null | undefined)?.environmentId;
  return typeof id === "string" && id ? id : DEFAULT_ENVIRONMENT_ID;
}

/** Why the composer cannot send a CLOUD session yet — '' when it can. The
 *  gate is GitHub itself: linked, and at least one repo picked. */
export function cloudSendBlock(connected: boolean, picks: readonly RepoPick[]): string {
  if (!connected) return "Connect GitHub to start a cloud session";
  if (!picks.length) return "Choose a repository";
  return "";
}

/** The same gate as the composer applies it: only an UNBORN cloud session on
 *  the WEB is gated (a born one already runs; a desktop session's gate is its
 *  folder; the desktop app never hits it). */
export function webCloudSendBlock(input: { surface: "web" | "desktop"; locus: Locus; born: boolean; connected: boolean; picks: readonly RepoPick[] }): string {
  if (input.surface !== "web" || input.locus !== "cloud" || input.born) return "";
  return cloudSendBlock(input.connected, input.picks);
}

/** The picks a stored source carries (an older record has only `repo`). */
export function picksOf(source: { kind?: string; repo?: string; branch?: string; repos?: unknown } | null | undefined): RepoPick[] {
  if (!source) return [];
  if (Array.isArray(source.repos)) {
    return (source.repos as Array<{ repo?: unknown; branch?: unknown }>)
      .filter((p) => typeof p?.repo === "string" && p.repo)
      .map((p) => ({ repo: String(p.repo), branch: typeof p.branch === "string" ? p.branch : "" }));
  }
  if (source.kind === "cloud-repo" && source.repo) return [{ repo: source.repo, branch: source.branch || "" }];
  return [];
}

/** Is this source kind a cloud one? (anything not local — the web's rule.) */
export function isCloudKind(kind: string | undefined | null): boolean {
  return kind === "cloud-repo" || kind === "cloud-new" || kind === "cloud-space";
}

// ── Labels ───────────────────────────────────────────────────────────────

const lastSeg = (p: string): string => p.split("/").filter(Boolean).pop() || p;

/** The compact place label — the web's `Cloud · <repo>` (code-source-chip.ts
 *  sourceLabel: the repo's last segment), "Cloud" for a fresh workspace. */
export function cloudLabel(source: { kind?: string; repo?: string; label?: string } | null | undefined): string {
  if (!source) return "Cloud";
  if (source.kind === "cloud-repo" && source.repo) return `Cloud · ${lastSeg(source.repo)}`;
  if (source.kind === "cloud-space") return `Cloud · ${source.label || "workspace"}`;
  return "Cloud";
}

/** The ENVIRONMENT chip: the picked cloud environment's name ("Default" when
 *  none, or the pick is gone); a desktop session names its machine. */
export function envChipLabel(locus: Locus, machineName?: string, environmentName?: string): string {
  return locus === "cloud" ? (environmentName || DEFAULT_ENVIRONMENT_NAME) : (machineName || "Desktop");
}

/** The REPO chip: "Connect GitHub" until the account is linked, "Choose
 *  repositories" with nothing picked, else "N repos · N branches" (one base
 *  branch per repo). */
export function repoChipLabel(picks: readonly RepoPick[], connected: boolean): string {
  if (!connected) return "Connect GitHub";
  const n = picks.length;
  if (!n) return "Choose repositories";
  return `${n} repo${n === 1 ? "" : "s"} · ${n} branch${n === 1 ? "" : "es"}`;
}

/** The folder chip beside a desktop environment: the folder's last segment. */
export function folderChipLabel(path: string): string {
  return path ? lastSeg(path) : "Choose folder";
}

/**
 * WHICH CHIPS the composer's source slot shows on the web (his report,
 * 2026-10-05), from the session's locus: in the cloud (or no session yet and
 * no desktop attached) the environment chip names the cloud environment and
 * the repo chip stands beside it; on an attached desktop the environment chip
 * names the machine and the repo chip steps aside (the folder chip beside it
 * is the existing locus picker). A BORN session's chips are read-only, and
 * say why (LOCUS_LOCKED_HINT) — its locus is fixed at birth.
 */
export function cloudChipsModel(input: {
  locus: Locus;
  born: boolean;
  machineName?: string;
  environmentName?: string;
  connected: boolean;
  picks: readonly RepoPick[];
  lockedHint: Record<Locus, string>;
}): { env: { label: string; locked: boolean; title: string }; repo: { shown: boolean; label: string; locked: boolean; title: string } } {
  const lock = input.born ? input.lockedHint[input.locus] : "";
  return {
    env: {
      label: envChipLabel(input.locus, input.machineName, input.environmentName),
      locked: input.born,
      title: lock || (input.locus === "cloud" ? "The cloud environment this session runs in" : "The desktop this session runs on"),
    },
    repo: {
      shown: input.locus === "cloud",
      label: repoChipLabel(input.picks, input.connected || (input.born && input.picks.length > 0)),
      locked: input.born,
      title: lock || "The GitHub repositories this cloud session checks out",
    },
  };
}

// ── Named environments (his direction, 2026-10-05: personal environments) ─

export type EnvironmentNetwork = "none" | "trusted" | "full";

/** The Network access dropdown, in the screenshot's order and words. */
export const NETWORK_OPTIONS: ReadonlyArray<{ id: EnvironmentNetwork; label: string }> = [
  { id: "none", label: "No network access" },
  { id: "trusted", label: "Trusted network access" },
  { id: "full", label: "Full network access" },
];
export function networkLabel(network: string | undefined): string {
  return NETWORK_OPTIONS.find((o) => o.id === network)?.label ?? NETWORK_OPTIONS[2].label;
}

/** A row as the SDK lists it (contract/environments.ts EnvironmentSummary). */
export interface EnvironmentRow { id: string; name: string; network: EnvironmentNetwork; varCount: number }
/** A variable as `environments.get` shows it: the key, a masked preview. */
export interface EnvironmentVarRow { key: string; preview: string }

/** The name of a picked environment among the member's rows — Default for
 *  the built-in one, and for a pick that no longer exists (deleted elsewhere). */
export function environmentName(id: string | undefined, rows: readonly EnvironmentRow[]): string {
  if (!id || id === DEFAULT_ENVIRONMENT_ID) return DEFAULT_ENVIRONMENT_NAME;
  return rows.find((r) => r.id === id)?.name ?? DEFAULT_ENVIRONMENT_NAME;
}

/** The row's subline: its policy, and how many variables it carries. */
export function environmentSubline(row: Pick<EnvironmentRow, "network" | "varCount">): string {
  const n = row.varCount;
  return `${networkLabel(row.network)} · ${n} variable${n === 1 ? "" : "s"}`;
}

export const ENV_NAME_MAX = 60;
export const ENV_VARS_CAP = 64;
export const ENV_VARS_BYTES_CAP = 32 * 1024;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The server's .env reading (environments.py parse_env), mirrored for a
 *  friendly error BEFORE the POST: blanks and `#` comments skipped, `export `
 *  tolerated, keys shell names, values may be quoted; a bad line is named by
 *  its number. The VALUES are not kept here — only the keys and the count. */
export function parseDotenv(text: string): { ok: true; keys: string[] } | { ok: false; line: number; error: string } {
  const keys: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let s = lines[i].trim();
    if (!s || s.startsWith("#")) continue;
    if (s.startsWith("export ")) s = s.slice(7).trimStart();
    const eq = s.indexOf("=");
    const key = (eq < 0 ? s : s.slice(0, eq)).trim();
    if (eq < 0 || !ENV_KEY_RE.test(key)) return { ok: false, line: i + 1, error: `Line ${i + 1}: expected KEY=VALUE with a key like API_KEY` };
    if (!keys.includes(key)) keys.push(key);
  }
  return { ok: true, keys };
}

/** Why the form cannot be submitted — '' when it can. */
export function environmentFormError(form: { name: string; vars: string }): string {
  const name = form.name.trim();
  if (!name) return "Name the environment";
  if (name.length > ENV_NAME_MAX) return `Names are ${ENV_NAME_MAX} characters at most`;
  if (name.toLowerCase() === DEFAULT_ENVIRONMENT_NAME.toLowerCase()) return "Default is the built-in environment — pick another name";
  if (new TextEncoder().encode(form.vars).length > ENV_VARS_BYTES_CAP) return "Environment variables are 32 KB at most";
  const parsed = parseDotenv(form.vars);
  if (!parsed.ok) return parsed.error;
  if (parsed.keys.length > ENV_VARS_CAP) return `At most ${ENV_VARS_CAP} variables`;
  return "";
}

/** The textarea's text for an EDIT: the stored keys with their masked
 *  previews, one a line — what the member sees, never a value. Submitting
 *  it unchanged keeps the stored variables (the form sends `vars` only when
 *  the text was edited). */
export function maskedDotenv(vars: readonly EnvironmentVarRow[]): string {
  return vars.map((v) => `${v.key}=${v.preview}`).join("\n");
}

/** The words for a failed save: the SDK's ApiError carries the server's
 *  message (the bad line, the name clash) and the status. */
export function environmentSaveError(err: unknown): string {
  const status = (err as { httpStatus?: number } | null)?.httpStatus;
  const said = err instanceof Error ? err.message : "";
  if (status === 409) return said || "You already have an environment with that name";
  if (status === 404) return "This environment is gone — it was deleted elsewhere";
  return said || "The environment could not be saved.";
}

// ── The repositories list ────────────────────────────────────────────────

/** Toggle a repo in the selection; a fresh pick takes the repo's default
 *  branch as its base (the branch list changes it). Order of picking is kept
 *  — the FIRST pick is the one the worker checks out. */
export function toggleRepo(picks: readonly RepoPick[], repo: RepoRow): RepoPick[] {
  const had = picks.some((p) => p.repo === repo.fullName);
  return had ? picks.filter((p) => p.repo !== repo.fullName) : [...picks, { repo: repo.fullName, branch: repo.defaultBranch }];
}

export function setBranch(picks: readonly RepoPick[], repo: string, branch: string): RepoPick[] {
  return picks.map((p) => (p.repo === repo ? { ...p, branch } : p));
}

/** The account a row lists under: the installation's account, else the
 *  owner in `owner/name` (a row from before accounts rode on it). */
export const accountOf = (r: Pick<RepoRow, "fullName" | "account">): string => r.account || r.fullName.split("/")[0] || "";

/** The list grouped by ACCOUNT in the order the server lists them (the
 *  member's own account first, then their orgs — never re-sorted here),
 *  names alphabetical within a group; the search is a case-insensitive
 *  substring over `owner/name`, across every account. */
export function groupRepos(repos: readonly RepoRow[], query = ""): Array<{ account: string; repos: RepoRow[] }> {
  const q = query.trim().toLowerCase();
  const shown = q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : [...repos];
  const byAccount = new Map<string, RepoRow[]>();
  for (const r of shown) {
    const account = accountOf(r);
    const list = byAccount.get(account) ?? [];
    list.push(r);
    byAccount.set(account, list);
  }
  return [...byAccount.entries()].map(([account, list]) => ({ account, repos: list.sort((a, b) => a.fullName.localeCompare(b.fullName)) }));
}

/** Whether the list wears a small header per account: only when the member
 *  reaches more than one (his order, 2026-10-05: "timmetim", "glyphh-ai").
 *  Read over the WHOLE list, not the search's slice, so headers never flicker
 *  while typing. */
export function accountHeaders(repos: readonly RepoRow[]): boolean {
  return new Set(repos.map(accountOf)).size > 1;
}

/** GitHub's generic installations page: the door when the status named none. */
export const MANAGE_FALLBACK_URL = "https://github.com/settings/installations";

/** A "Manage repository access…" row: where the member changes which
 *  repositories the Glyphh app may reach. */
export interface ManageRow { label: string; hint: string; url: string }

/** The manage rows for a status: ONE row per installation when the member
 *  reaches more than one (each to its own settings page — an org's lives
 *  under the org), else the single row as before, to the first installation's
 *  page (or the status's `installationUrl`, or GitHub's generic page). */
export function manageRows(status: { installationUrl?: string; installations?: readonly GitInstallationRow[] } | null | undefined): ManageRow[] {
  const list = status?.installations ?? [];
  if (list.length > 1) {
    return list.map((i) => ({
      label: `Manage ${i.account} repositories…`,
      hint: i.type === "Organization" ? "Change which repositories the Glyphh app may reach in this organization, on GitHub" : "Change which repositories the Glyphh app may reach on your account, on GitHub",
      url: i.url || MANAGE_FALLBACK_URL,
    }));
  }
  return [{ label: "Manage repository access…", hint: "Change which repositories the Glyphh app may reach, on GitHub", url: list[0]?.url || status?.installationUrl || MANAGE_FALLBACK_URL }];
}

export const splitRepo = (fullName: string): { owner: string; name: string } => {
  const i = fullName.indexOf("/");
  return i < 0 ? { owner: "", name: fullName } : { owner: fullName.slice(0, i), name: fullName.slice(i + 1) };
};

// ── The GitHub return landing ────────────────────────────────────────────

/** The return from GitHub lands on the page that started the link with
 *  `?github=pending&link=<nonce>` (contract/git.ts): the nonce, '' when the
 *  landing carries none (the app then completes this member's newest pending
 *  link), null when this is not a return at all. */
export function pendingLinkInUrl(search: string): string | null {
  const q = new URLSearchParams(search);
  return q.get("github") === "pending" ? (q.get("link") || "") : null;
}

/** The page's URL with the return's two parameters stripped — what the app
 *  writes back with history.replaceState once the link is completed, so a
 *  reload never completes it twice. */
export function stripPendingLink(href: string): string {
  const u = new URL(href);
  u.searchParams.delete("github");
  u.searchParams.delete("link");
  return u.pathname + u.search + u.hash;
}

/** The words for a failed completion, by the server's status: 403 = another
 *  account started it, 404 = it expired. */
export function gitCompleteError(err: unknown): string {
  const status = (err as { httpStatus?: number } | null)?.httpStatus;
  if (status === 403) return "This GitHub link was started by another account";
  if (status === 404) return "The GitHub link expired — connect again";
  return err instanceof Error && err.message ? err.message : "GitHub could not be linked.";
}

// ── The composer's chip set ──────────────────────────────────────────────

/**
 * WHICH CHIPS the composer's source row carries, from what the surface knows
 * (his report, 2026-10-05: "the tab at the top on web works perfectly for
 * 'work' … when you switch back to 'code' the folder options don't come back
 * when the user clicks new session"). ONE rule, re-applied on every paint —
 * never read once from the session that happened to be open:
 *   · a WORK session asks for no place: no chips at all;
 *   · the DESKTOP app's Code composer keeps its one folder chip;
 *   · the WEB's Code composer wears the environment chip always, the repo
 *     chip in the cloud, and the folder chip (the locus picker) on an
 *     ATTACHED desktop — a desktop that is not attached has no folder a
 *     turn could use (session-locus.ts defaultWebFolder).
 */
export function composerChipSet(input: { surface: "web" | "desktop"; locus: Locus; attached: boolean }): { environment: boolean; repo: boolean; folder: boolean } {
  if (input.surface === "desktop") return { environment: false, repo: false, folder: true };
  if (input.locus === "cloud") return { environment: true, repo: true, folder: false };
  return { environment: true, repo: false, folder: input.attached };
}
