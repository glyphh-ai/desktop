/**
 * wb-pod.js — the CLOUD-SESSION implementation of window.wb, plus the locus
 * SELECTOR that decides which wb answers the workbench.
 *
 * A cloud session's turns execute in a rrotor harness pod; its files live in
 * the pod's per-session workspace (rrotor harness/fs-routes.ts — keyed
 * owner+threadId, the exact key runs execute under). This module drives the
 * Files / Diff / Monaco panels against that workspace over the SAME network
 * path turns ride: the SDK's front-door harness client (`harnessViaApi()` →
 * `<api>/api/harness/fs/*`), authenticated by the user's own session token.
 * No pod URL ever reaches the browser — the front door region-routes.
 *
 * NOTE (server dependency, honest state): the control-plane turn proxy
 * currently forwards only the run routes (server harness-proxy/routes.ts). The
 * `/fs/*` forwards are a server-side addition owned elsewhere; until they
 * land, every call here rejects cleanly and the panels render the designed
 * offline card (`webFsStatus` → "runtime-offline") — never fake data.
 *
 * WATCHING: the pod exposes cursor-polled change events (`/fs/events`); while
 * any panel subscribes, one ~2s poll loop maps them onto onFileChanged /
 * onGitChanged, and a session switch (scope change) re-roots via onCwdChanged.
 *
 * THE SELECTOR (createWbSelector): the CURRENT session's locus routes every
 * wb call — cloud session → this pod wb (scoped to that session's thread id);
 * machine-bound session or no session → the existing desktop relay wb
 * (wb-relay.js). The locus rides the session store's own write path: the
 * renderer's thread-store persists through web-contract.js's session cache,
 * which calls {@link noteSessionsSnapshot} on every load/save — no edit to
 * help/code.ts, no new renderer event; a switch fires
 * `glyphh:wb-locus-changed` and the selector re-binds live subscriptions and
 * announces the new root as a cwd change (the workbench already re-roots on
 * that signal).
 */

import { panelFsRoute } from '../../src/renderer/help/panel-fs-route.ts';

const noop = () => {};
const msg = (e) => (e instanceof Error ? e.message : String(e));

// ── The session locus (fed by web-contract.js's session-cache write path) ────

let locus = { chatId: '', cloud: false, local: false, scope: '', folder: '' };

/** The current session's locus: which chat is current, does it run in the
 *  cloud (same rule as code.ts: remote ⇔ source present and not "local"), is
 *  it BOUND TO A MACHINE (`local`: a local source — the web terminal then
 *  rides the desktop relay instead of the worker pty), and which FOLDER on
 *  that machine it works in (`folder`: the thread's workdir, else its local
 *  source's path — code.ts threadFolder) so the relay-backed panels root there. */
export const wbLocus = () => ({ ...locus });

/**
 * Feed a sessions snapshot (chats + currentId) into the locus. Called by
 * web-contract.js on every session-cache load/save — the one seam every
 * session switch, birth, and source-bind already flows through. Fires
 * `glyphh:wb-locus-changed` only on a real change.
 */
export function noteSessionsSnapshot(chats, currentId) {
  const id = String(currentId || '');
  const c = Array.isArray(chats) ? chats.find((x) => x && x.id === id) : null;
  // THE ONE RULE both surfaces share (src/renderer/help/panel-fs-route.ts):
  // a cloud source routes to the pod, scoped to the workspace key the run
  // threads on (a re-entered space's id, else the thread's); anything else is
  // the machine — here the attached desktop over the relay.
  const r = panelFsRoute({ surface: 'web', source: c ? c.source : null, chatId: id });
  const cloud = r.route === 'cloud';
  const local = !!(c && c.source && c.source.kind === 'local');
  const scope = cloud ? r.scope : '';
  const folder = !cloud && c ? String(c.workdir || (local && c.source.path) || '') : '';
  if (id === locus.chatId && cloud === locus.cloud && local === locus.local && scope === locus.scope && folder === locus.folder) return;
  locus = { chatId: id, cloud, local, scope, folder };
  try {
    window.dispatchEvent(new CustomEvent('glyphh:wb-locus-changed', { detail: { ...locus } }));
  } catch { /* bare test stubs — the selector reads wbLocus() lazily anyway */ }
}

// ── The pod wb ───────────────────────────────────────────────────────────────

export function createWbPod({ client, isAuthenticated, getScope = () => (locus.cloud ? (locus.scope || locus.chatId) : '') }) {
  let harness = null;
  const pod = () => {
    if (!harness) {
      if (typeof client?.harnessViaApi !== 'function') throw new Error('no cloud runtime transport');
      harness = client.harnessViaApi();
    }
    return harness;
  };
  const scoped = () => {
    const scope = getScope();
    if (!scope) throw new Error('no cloud session selected');
    return scope;
  };
  // The workspace root is deterministic per scope — cache after first sight so
  // getCwd doesn't re-fetch per panel paint. webFsStatus always probes live.
  const roots = new Map();
  const infoFor = async (scope) => {
    const info = await pod().fsInfo({ scope });
    if (info && typeof info.root === 'string' && info.root) roots.set(scope, info.root);
    return info || {};
  };
  const rootFor = async (scope) => roots.get(scope) ?? (await infoFor(scope)).root ?? '';

  // ── watch pipeline: one ~2s cursor poll while any panel subscribes ─────────
  const fileSubs = new Set();
  const gitSubs = new Set();
  const cwdSubs = new Set();
  let pollTimer = null;
  let polling = false;
  let cursor = -1;
  let watchScope = '';
  let lastCwd = null;

  const POLL_MS = 2000;
  const RETRY_MS = 6000;

  const anySubs = () => fileSubs.size + gitSubs.size + cwdSubs.size > 0;
  const emit = (subs, ...args) => {
    for (const cb of [...subs]) {
      try { cb(...args); } catch { /* subscriber's problem */ }
    }
  };

  function schedule(ms) {
    if (pollTimer || !anySubs()) return;
    pollTimer = setTimeout(() => { pollTimer = null; void poll(); }, ms);
  }

  async function poll() {
    if (!anySubs() || polling) return;
    polling = true;
    try {
      const scope = getScope();
      if (!scope) { schedule(RETRY_MS); return; } // no cloud session — idle until one arrives
      if (scope !== watchScope) { watchScope = scope; cursor = -1; } // session switch → fresh cursor
      const page = await pod().fsEvents({ from: cursor, scope });
      cursor = typeof page.seq === 'number' ? page.seq : cursor;
      if (typeof page.root === 'string' && page.root && page.root !== lastCwd) {
        lastCwd = page.root;
        roots.set(scope, page.root);
        emit(cwdSubs, page.root);
      }
      for (const ev of page.events || []) {
        if (ev.type === 'file-changed' && typeof ev.path === 'string') emit(fileSubs, ev.path);
        else if (ev.type === 'git-changed') emit(gitSubs);
      }
      schedule(POLL_MS);
    } catch {
      schedule(RETRY_MS); // pod asleep / fs forwards not live — keep trying quietly
    } finally {
      polling = false;
    }
  }

  function subscribe(subs, cb) {
    subs.add(cb);
    void poll();
    return () => {
      subs.delete(cb);
      if (!anySubs() && pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    };
  }

  // ── the wb surface (same contract + error shapes as preload/wb-relay) ──────
  const wb = {
    platform: 'web',

    // Machine-only dialogs/viewers — honest no-ops in a browser.
    pickCwd: async () => null,
    pickFile: async () => null,
    previewNative: async () => null,
    convertPreview: async () => ({ error: 'no-converter' }),

    getCwd: async () => {
      try {
        const cwd = await rootFor(scoped());
        if (cwd) lastCwd = cwd;
        return cwd;
      } catch { return ''; }
    },
    // The pod workspace is session-bound BY DESIGN — it IS the explicit folder.
    getCwdExplicit: async () => {
      try { return (await rootFor(scoped())) || null; } catch { return null; }
    },
    setCwd: async () => {
      try { return (await rootFor(scoped())) || ''; } catch { return ''; }
    },
    getCwdRecents: async () => [],

    gitInfo: async () => {
      try {
        const r = await infoFor(scoped());
        return { isRepo: !!r.isRepo, ...(r.branch ? { branch: r.branch } : {}) };
      } catch { return { isRepo: false }; }
    },
    listDir: async (dir) => {
      try { return await pod().fsList({ ...(dir ? { dir } : {}), scope: scoped() }); }
      catch (e) { return { entries: [], error: msg(e) }; }
    },
    searchFiles: async (_dir, query) => {
      try { return await pod().fsSearch({ query: String(query ?? ''), scope: scoped() }); }
      catch (e) { return { entries: [], error: msg(e) }; }
    },
    readFile: async (path) => {
      try { return await pod().fsRead({ path, scope: scoped() }); }
      catch (e) { return { content: '', error: msg(e) }; }
    },
    writeFile: async (path, content) => {
      try { return await pod().fsWrite({ path, content: typeof content === 'string' ? content : '', scope: scoped() }); }
      catch (e) { return { ok: false, error: msg(e) }; }
    },
    gitDiff: async () => {
      try { return await pod().fsDiff({ scope: scoped() }); }
      catch (e) { return { text: '', error: msg(e) }; }
    },
    // Not on the pod fs surface — the R2 lane compares the DESKTOP working
    // folder against the snapshot head; a cloud workspace has no local tree.
    r2Diff: async () => ({ status: null, text: '' }),
    // Not on the pod fs surface (yet) — say so, never pretend.
    mkdir: async () => ({ ok: false, error: 'Not available for cloud workspaces yet — create a file instead (folders appear with their first file).' }),
    deletePath: async () => ({ ok: false, error: 'Not available for cloud workspaces yet.' }),
    renamePath: async () => ({ ok: false, error: 'Not available for cloud workspaces yet.' }),

    onCwdChanged: (cb) => subscribe(cwdSubs, cb),
    onFileChanged: (cb) => subscribe(fileSubs, cb),
    onGitChanged: (cb) => subscribe(gitSubs, cb),

    /** Can the cloud-workspace transport answer right now? "runtime-offline"
     *  covers a sleeping/unreachable pod AND missing server fs forwards — the
     *  workbench renders its designed state card either way. */
    webFsStatus: async () => {
      try { if (!(await isAuthenticated())) return 'signed-out'; } catch { /* fall through to probe */ }
      const scope = getScope();
      if (!scope) return 'runtime-offline';
      try { await infoFor(scope); return 'ok'; }
      catch { return 'runtime-offline'; }
    },

    // Local pty bridge — cloud terminals are not this transport's problem.
    termSpawn: noop,
    termWrite: noop,
    termResize: noop,
    termKill: noop,
    termOnData: () => noop,
    termOnExit: () => noop,
  };

  // Same quiet-no-op contract as wb-relay: untouched wb call sites never throw.
  return new Proxy(wb, {
    get(t, prop) {
      if (prop === 'then') return undefined;
      if (prop in t) return t[prop];
      if (typeof prop === 'string' && prop.startsWith('on')) return () => noop;
      return async () => undefined;
    },
  });
}

// ── The selector: the current session's locus picks the transport ───────────

/**
 * One window.wb that routes by locus: cloud session → `pod`, everything else →
 * `relay` (the desktop attach transport — today's behavior, unchanged).
 * Live on* subscriptions are owned HERE and re-bound on a locus flip, then the
 * new transport's cwd is announced so the workbench re-roots its panels in
 * place (its existing onCwdChanged path).
 */
export function createWbSelector({ relay, pod, isCloud = () => locus.cloud, getRoot = () => locus.folder }) {
  const subs = { file: new Set(), git: new Set(), cwd: new Set() };
  const total = () => subs.file.size + subs.git.size + subs.cwd.size;
  let activeKind = isCloud() ? 'pod' : 'relay';
  let lastRoot = getRoot();
  const active = () => (activeKind === 'pod' ? pod : relay);
  let unbinds = [];

  const emit = (set, ...args) => {
    for (const cb of [...set]) {
      try { cb(...args); } catch { /* subscriber's problem */ }
    }
  };

  function bind() {
    const a = active();
    unbinds = [
      a.onFileChanged((p) => emit(subs.file, p)),
      a.onGitChanged(() => emit(subs.git)),
      a.onCwdChanged((c) => emit(subs.cwd, c)),
    ];
  }
  function unbind() {
    for (const u of unbinds) { try { u(); } catch { /* already gone */ } }
    unbinds = [];
  }

  function onLocusChanged() {
    const next = isCloud() ? 'pod' : 'relay';
    const root = getRoot();
    // A switch between two DESKTOP sessions in different folders re-roots the
    // same transport (his report, 2026-10-05: the panels must show the
    // session's files); a transport flip re-binds the live subscriptions.
    const rerooted = next === 'relay' && root !== lastRoot;
    lastRoot = root;
    if (next === activeKind && !rerooted) return;
    const flipped = next !== activeKind;
    activeKind = next;
    if (total() > 0) {
      if (flipped) { unbind(); bind(); }
      // Re-root the workbench onto the new transport's folder — its existing
      // cwd-changed path re-lists Files / re-fetches Diff in place.
      void active().getCwd().then((cwd) => { if (cwd) emit(subs.cwd, cwd); }).catch(() => {});
    }
  }
  try { window.addEventListener('glyphh:wb-locus-changed', onLocusChanged); }
  catch { /* bare test stubs */ }

  const subscribe = (set, cb) => {
    const wasIdle = total() === 0;
    set.add(cb);
    if (wasIdle) bind();
    return () => {
      set.delete(cb);
      if (total() === 0) unbind();
    };
  };

  const own = {
    onFileChanged: (cb) => subscribe(subs.file, cb),
    onGitChanged: (cb) => subscribe(subs.git, cb),
    onCwdChanged: (cb) => subscribe(subs.cwd, cb),
  };

  // Everything else routes to the ACTIVE transport at call time; both
  // transports already answer any name (their own Proxy fallbacks).
  return new Proxy(own, {
    get(t, prop) {
      if (prop === 'then') return undefined;
      if (prop in t) return t[prop];
      return active()[prop];
    },
  });
}
