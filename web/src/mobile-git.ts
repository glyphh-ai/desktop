/**
 * mobile-git.ts — the phone's GitHub door, over the SDK's `git` resource
 * (the same calls the web's repo picker makes in code-source-chip.ts:
 * git.status → git.repos, git.connect → open the URL, poll git.status).
 *
 * Three calls go through the SDK's raw authenticated door (`client.http`,
 * its documented escape hatch) because the typed resource has no shape for
 * them yet (his direction, 2026-10-05; the server side is being built in
 * parallel):
 *   · connect carries `returnTo` — the page that started the flow, so the
 *     server's callback can send the phone back here;
 *   · complete — the callback no longer records the connection itself (the
 *     server lane's security review): it parks a PENDING link and sends the
 *     person back with `?github=pending&link=<nonce>`; the app finishes it
 *     with the member's own bearer (POST /api/git/connect/complete {link}),
 *     so only the member who started the link can complete it. With no
 *     link it completes this member's newest pending link (the return
 *     landed in another tab; status says `pending`);
 *   · the base-branch sheet lists GET /api/git/repos/{owner}/{name}/branches
 *     → [{ name, default }]; when that door is not there yet the repo's
 *     default branch is the one row.
 */
import { glyphh } from './glyphh-web.js';
import { gitCompleteError, pendingLinkInUrl, type BranchRow, type GitInstallationRow, type RepoRow } from './mobile-cloud';

interface GitStatus {
  connected: boolean;
  login?: string | null;
  /** A link was started and awaits this member's completion. */
  pending?: boolean;
  /** GitHub's settings page for the first installation. */
  installationUrl?: string;
  /** Every installation the member reaches, their own account first. */
  installations?: GitInstallationRow[];
}

/** The status as the sheet keeps it: the flags, and the manage doors. */
const shape = (s: Partial<GitStatus> | null | undefined): GitStatus => ({
  connected: !!s?.connected, login: s?.login ?? null, pending: !!s?.pending,
  ...(s?.installationUrl ? { installationUrl: s.installationUrl } : {}),
  ...(Array.isArray(s?.installations) ? { installations: s.installations } : {}),
});
interface GitDoor {
  status(): Promise<GitStatus>;
  complete?(link?: string): Promise<GitStatus>;
  repos(): Promise<RepoRow[]>;
  connect(): Promise<{ url: string; state?: string }>;
  disconnect(): Promise<void>;
}
interface RawDoor {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}
const git = (): GitDoor => (glyphh() as unknown as { git: GitDoor }).git;
const raw = (): RawDoor => (glyphh() as unknown as { http: RawDoor }).http;

export const mobileGit = {
  /** Linked, and as whom. A failed read is "not connected" (never a throw —
   *  the sheet shows the Connect row). */
  async status(): Promise<GitStatus> {
    try { return shape(await git().status()); }
    catch { return { connected: false, login: null }; }
  },

  /** Finish a parked link as THIS member. Throws the SDK's ApiError: 403 =
   *  another account started it, 404 = it expired (the sheet names both). */
  async complete(link?: string): Promise<GitStatus> {
    const g = git();
    const s = typeof g.complete === 'function'
      ? await g.complete(link)
      : await raw().post<GitStatus>('/api/git/connect/complete', link ? { link } : {});
    return shape(s);
  },

  /** The words for a failed completion — the shared rule (help/cloud-source.ts). */
  completeError(err: unknown): string { return gitCompleteError(err); },

  /** The return from GitHub: `?github=pending&link=<nonce>` on this page. */
  pendingLinkInUrl(search: string): string | null { return pendingLinkInUrl(search); },

  async repos(): Promise<RepoRow[]> {
    const list = await git().repos();
    return Array.isArray(list) ? list : [];
  },

  /** Begin linking: the URL to open (GitHub's consent / App install page).
   *  `returnTo` rides in the body for the callback's redirect. */
  async connect(returnTo: string): Promise<string> {
    const r = await raw().post<{ url?: string }>('/api/git/connect', returnTo ? { returnTo } : {});
    return r?.url || '';
  },

  async disconnect(): Promise<void> {
    await git().disconnect();
  },

  /** The repo's branches for the base-branch sheet; the default branch alone
   *  when the server has no branches door yet. */
  async branches(fullName: string, defaultBranch: string): Promise<BranchRow[]> {
    const [owner, name] = fullName.split('/');
    try {
      const rows = await raw().get<Array<{ name?: unknown; default?: unknown }>>(`/api/git/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`);
      const list = (Array.isArray(rows) ? rows : [])
        .filter((b) => typeof b?.name === 'string' && b.name)
        .map((b) => ({ name: String(b.name), default: !!b.default }));
      if (list.length) return list;
    } catch { /* no branches door yet — the default branch is the one row */ }
    return [{ name: defaultBranch, default: true }];
  },

  /** Poll status every 2 s until linked or the cap (3 min) — the web's
   *  connect flow, on the phone's clock. A `pending` answer (the return
   *  landed in another tab) is completed from here, linkless. Resolves
   *  whether it connected; a failed completion rejects with its words. */
  waitForConnection(opts: { everyMs?: number; capMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
    const every = opts.everyMs ?? 2000;
    const cap = opts.capMs ?? 180_000;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = async (): Promise<void> => {
        if (opts.signal?.aborted) { resolve(false); return; }
        let s = await mobileGit.status();
        if (!s.connected && s.pending) {
          try { s = await mobileGit.complete(); }
          catch (err) { reject(new Error(mobileGit.completeError(err))); return; }
        }
        if (s.connected) { resolve(true); return; }
        if (Date.now() - started >= cap) { resolve(false); return; }
        setTimeout(() => { void tick(); }, every);
      };
      setTimeout(() => { void tick(); }, every);
    });
  },
};
