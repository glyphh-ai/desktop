/**
 * mobile-cloud.ts — the phone's CLOUD lane, as pure rules (his direction,
 * 2026-10-05: a developer on their phone starts a Code session that runs on a
 * cloud worker with a GitHub repo checked out — the same front door and runner
 * the web uses, no environment setup: a "Default" environment plus a repo
 * grant is enough). NAMED ENVIRONMENTS (his direction, 2026-10-05: personal
 * environments) ride beside it: a member's own rows — a name, a network
 * policy, .env text kept encrypted on the server — picked per session and
 * sent as `environmentId`; "Default" is the absent one.
 *
 * THE RULES THEMSELVES LIVE IN THE RENDERER (help/cloud-source.ts — his
 * report, 2026-10-05: the desktop-width web agent window wears the same two
 * chips), re-exported here so the phone and its tests read them from one
 * place. What stays below is the phone's own: its sessions list.
 *
 * Nothing here touches the DOM or the network — mobile.tsx paints what these
 * functions decide, and the unit tests run them bare. The locus rule itself
 * (fixed at birth, desktop where one is attached else the cloud) is the web's
 * own, imported from session-locus.ts — never a second copy.
 */
import { defaultLocus, LOCUS_LOCKED_HINT, type Locus } from '../../src/renderer/help/session-locus';
import { cloudLabel, isCloudKind } from '../../src/renderer/help/cloud-source';

export type { Locus };
export { defaultLocus, LOCUS_LOCKED_HINT };
export {
  cloudSource, sourceForPicks, environmentIdOf, cloudSendBlock, picksOf, isCloudKind, cloudLabel, envChipLabel, repoChipLabel, folderChipLabel,
  NETWORK_OPTIONS, networkLabel, environmentName, environmentSubline, parseDotenv, environmentFormError, maskedDotenv, environmentSaveError,
  toggleRepo, setBranch, groupRepos, accountHeaders, manageRows, splitRepo, pendingLinkInUrl, stripPendingLink, gitCompleteError,
  DEFAULT_ENVIRONMENT_ID, DEFAULT_ENVIRONMENT_NAME, ENV_NAME_MAX, ENV_VARS_CAP, ENV_VARS_BYTES_CAP, MANAGE_FALLBACK_URL,
  type RepoRow, type RepoPick, type BranchRow, type CloudSource, type EnvironmentNetwork, type EnvironmentRow, type EnvironmentVarRow,
  type GitInstallationRow, type ManageRow,
} from '../../src/renderer/help/cloud-source';

const lastSeg = (p: string): string => p.split('/').filter(Boolean).pop() || p;

// ── The sessions list ────────────────────────────────────────────────────

/** A thread as the phone lists it, from either store. */
export interface ListedThread {
  id: string;
  title: string;
  mode?: string;
  source?: { kind?: string; path?: string; repo?: string; machineId?: string; machineName?: string; [k: string]: unknown } | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/**
 * ONE list from two stores: the desktop's threads (over the attach socket)
 * and the server's threads (`/api/harness/threads`), of which only the CLOUD
 * ones are taken — a desktop thread also syncs to the server, so it would
 * list twice otherwise. On an id collision the desktop's copy wins.
 */
export function mergeThreads<T extends ListedThread>(desktop: readonly T[], server: readonly T[]): T[] {
  const seen = new Set(desktop.map((t) => t.id));
  const cloud = server.filter((t) => isCloudKind(t.source?.kind) && !seen.has(t.id));
  return [...desktop, ...cloud];
}

/** The row's subline: where it runs — the folder's last segment on a desktop
 *  (else its age), `Cloud · <repo>` in the cloud. */
export function sessionSubline(input: { locus: Locus; path?: string; source?: { kind?: string; repo?: string } | null; age: string }): string {
  if (input.locus === 'cloud') return cloudLabel(input.source);
  return input.path ? lastSeg(input.path) : input.age;
}

/** The status mark at the row's left: idle, running, or waiting for you. */
export type SessionMark = 'idle' | 'running' | 'waiting';
export function sessionMark(activity: 'working' | 'waiting' | undefined): SessionMark {
  return activity === 'working' ? 'running' : activity === 'waiting' ? 'waiting' : 'idle';
}

/** The turn's user/assistant messages as the server thread store holds them
 *  (the app's CodeMsg shape, verbatim: role + text + at). */
export function toStoredMessages(msgs: ReadonlyArray<{ role: string; text: string }>): Array<{ role: string; text: string; at: number }> {
  const at = Date.now();
  return msgs.filter((m) => typeof m.text === 'string').map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text, at }));
}
