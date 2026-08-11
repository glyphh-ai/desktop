/**
 * wb-relay.js — the WEB implementation of window.wb (the Code workbench's
 * filesystem/git bridge). On desktop, preload.ts backs wb with local IPC; in a
 * browser there is no machine, so every read/write here reaches the user's
 * ATTACHED DESKTOP instead:
 *
 *   · calls  → `client.attach.dispatch(method, params)` (the server relays to
 *     the signed-in user's own machine — the same transport the web folder
 *     picker already rides for fs.list / fs.gitInfo / fs.mkdir). The machine
 *     side is relay-fs.ts (fs.cwd/listDir/read/write/gitDiff/search).
 *   · watch  → one /ws/panel socket (the socket the remote terminal uses)
 *     subscribed to a private channel; the desktop's debounced workdir watcher
 *     forwards {fs-changed|git-changed|cwd-changed} pushes on it, feeding
 *     onFileChanged / onGitChanged / onCwdChanged.
 *
 * Machine-only surface (native dialogs, Quick Look, local pty) stays an HONEST
 * no-op — pickCwd/pickFile/previewNative resolve null, mutations the relay
 * doesn't expose return { ok:false, error } so the UI says so instead of
 * pretending. Nothing here fakes data: every failure resolves to the same
 * error shapes preload.ts produces, which the panels already render.
 *
 * Failure → recovery is self-healing: while any on* subscriber exists the
 * watch pipeline retries on a timer and re-arms after socket drops or desktop
 * reattach (fs.watch is idempotent on the machine). No subscribers → no
 * socket.
 */

const noop = () => {};
const msg = (e) => (e instanceof Error ? e.message : String(e));

export function createWbRelay({ client, apiUrl, isAuthenticated }) {
  const dispatch = async (method, params) => {
    const d = client?.attach?.dispatch;
    if (!d) throw new Error('no attach transport');
    return d.call(client.attach, method, params || {});
  };

  // ── watch pipeline (push events from the desktop's workdir watcher) ────────
  const fileSubs = new Set();
  const gitSubs = new Set();
  const cwdSubs = new Set();
  const channel = 'fsw-' + Math.random().toString(36).slice(2, 10);
  let sock = null;
  let connecting = false;
  let retryTimer = null;
  let keepaliveTimer = null;
  let lastCwd = null;

  const anySubs = () => fileSubs.size + gitSubs.size + cwdSubs.size > 0;
  const emit = (subs, ...args) => {
    for (const cb of [...subs]) {
      try { cb(...args); } catch { /* subscriber's problem */ }
    }
  };

  function scheduleRetry() {
    if (retryTimer || !anySubs()) return;
    retryTimer = setTimeout(() => { retryTimer = null; void ensurePipeline(); }, 6000);
  }

  function openSocket() {
    return new Promise((resolve, reject) => {
      Promise.resolve(client.token()).then((token) => {
        if (!token) { reject(new Error('no token')); return; }
        const base = String(apiUrl || 'https://api.glyphh.ai').replace(/\/$/, '').replace(/^http/, 'ws');
        const ws = new WebSocket(`${base}/ws/panel?token=${encodeURIComponent(token)}`);
        sock = ws;
        ws.onopen = () => resolve();
        ws.onerror = () => { /* onclose follows */ };
        ws.onclose = () => {
          if (sock === ws) { sock = null; scheduleRetry(); }
          reject(new Error('relay socket closed')); // no-op if already resolved
        };
        ws.onmessage = (ev) => {
          let f;
          try { f = JSON.parse(String(ev.data)); } catch { return; }
          if (!f || f.t !== 'push' || f.channel !== channel || !f.data) return;
          const d = f.data;
          if (d.type === 'fs-changed' && typeof d.path === 'string') emit(fileSubs, d.path);
          else if (d.type === 'git-changed') emit(gitSubs);
          else if (d.type === 'cwd-changed' && typeof d.cwd === 'string') {
            if (d.cwd !== lastCwd) { lastCwd = d.cwd; emit(cwdSubs, d.cwd); }
          }
        };
      }).catch(reject);
    });
  }

  /**
   * Bring the watch pipeline up (attach check → push socket → fs.watch on the
   * machine). Idempotent + self-healing: safe to call repeatedly; failures
   * schedule a retry while subscribers exist. Also the 45s keepalive body —
   * fs.watch is re-dispatched so a desktop that detached and came back (its
   * watch table swept) starts forwarding again without a page reload.
   */
  async function ensurePipeline() {
    if (!anySubs() || connecting) return;
    connecting = true;
    try {
      const st = await client.attach.status();
      if (!st || !st.attached) throw new Error('desktop offline');
      if (!sock || sock.readyState > 1) await openSocket();
      const ack = await dispatch('fs.watch', { channel });
      if (ack && typeof ack.cwd === 'string' && ack.cwd && ack.cwd !== lastCwd) {
        lastCwd = ack.cwd;
        emit(cwdSubs, ack.cwd);
      }
      if (!keepaliveTimer) {
        keepaliveTimer = setInterval(() => { void ensurePipeline(); }, 45_000);
      }
    } catch {
      scheduleRetry();
    } finally {
      connecting = false;
    }
  }

  function teardownIfIdle() {
    if (anySubs()) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    dispatch('fs.unwatch', { channel }).catch(() => {});
    if (sock) { const s = sock; sock = null; try { s.close(); } catch { /* noop */ } }
  }

  function subscribe(subs, cb) {
    subs.add(cb);
    void ensurePipeline();
    return () => { subs.delete(cb); teardownIfIdle(); };
  }

  // ── the wb surface ─────────────────────────────────────────────────────────
  const wb = {
    platform: 'web',

    // Machine-only dialogs/viewers — honest no-ops in a browser.
    pickCwd: async () => null,
    pickFile: async () => null,
    previewNative: async () => null,
    convertPreview: async () => ({ error: 'no-converter' }),

    getCwd: async () => {
      try {
        const r = await dispatch('fs.cwd');
        const c = r && typeof r.cwd === 'string' ? r.cwd : '';
        if (c) lastCwd = c;
        return c;
      } catch { return ''; }
    },
    getCwdExplicit: async () => {
      try {
        const r = await dispatch('fs.cwd');
        return r && typeof r.explicit === 'string' ? r.explicit : null;
      } catch { return null; }
    },
    // The web can't move the desktop's working folder (that stays a decision
    // made AT the machine) — report the current one unchanged.
    setCwd: async () => {
      try { const r = await dispatch('fs.cwd'); return r && typeof r.cwd === 'string' ? r.cwd : ''; }
      catch { return ''; }
    },
    getCwdRecents: async () => [],

    gitInfo: async (root) => {
      try {
        const r = await dispatch('fs.gitInfo', { path: root });
        return { isRepo: !!(r && r.isRepo), ...(r && r.branch ? { branch: r.branch } : {}) };
      } catch { return { isRepo: false }; }
    },
    listDir: async (dir) => {
      try { return await dispatch('fs.listDir', { dir }); }
      catch (e) { return { entries: [], error: msg(e) }; }
    },
    searchFiles: async (dir, query) => {
      try { return await dispatch('fs.search', { dir, query }); }
      catch (e) { return { entries: [], error: msg(e) }; }
    },
    readFile: async (path) => {
      try { return await dispatch('fs.read', { path }); }
      catch (e) { return { content: '', error: msg(e) }; }
    },
    writeFile: async (path, content) => {
      try { return await dispatch('fs.write', { path, content }); }
      catch (e) { return { ok: false, error: msg(e) }; }
    },
    gitDiff: async (root) => {
      try { return await dispatch('fs.gitDiff', { root }); }
      catch (e) { return { text: '', error: msg(e) }; }
    },
    // Reuses the folder picker's existing machine method (parent + plain name).
    mkdir: async (dirPath) => {
      try {
        const p = String(dirPath || '');
        const i = p.lastIndexOf('/');
        const parent = i > 0 ? p.slice(0, i) : '';
        const name = i >= 0 ? p.slice(i + 1) : p;
        await dispatch('fs.mkdir', { ...(parent ? { path: parent } : {}), name });
        return { ok: true };
      } catch (e) { return { ok: false, error: msg(e) }; }
    },
    // Not exposed by the machine relay (yet) — say so, never pretend.
    deletePath: async () => ({ ok: false, error: 'Not available from the web yet — delete on your desktop.' }),
    renamePath: async () => ({ ok: false, error: 'Not available from the web yet — rename on your desktop.' }),

    onCwdChanged: (cb) => subscribe(cwdSubs, cb),
    onFileChanged: (cb) => subscribe(fileSubs, cb),
    onGitChanged: (cb) => subscribe(gitSubs, cb),

    /** Can the machine-fs transport answer right now? Drives the workbench's
     *  honest panel states (desktop-offline / signed-out) on web. */
    webFsStatus: async () => {
      try { if (!(await isAuthenticated())) return 'signed-out'; } catch { /* fall through to attach probe */ }
      if (!client?.attach?.dispatch) return 'signed-out';
      try {
        const st = await client.attach.status();
        return st && st.attached ? 'ok' : 'desktop-offline';
      } catch { return 'desktop-offline'; }
    },

    // Local pty bridge — web terminals ride remote-terminal.ts, never wb.
    termSpawn: noop,
    termWrite: noop,
    termResize: noop,
    termKill: noop,
    termOnData: () => noop,
    termOnExit: () => noop,
  };

  // Anything not implemented keeps the old quiet-no-op contract (on* returns
  // an unsubscribe) so an untouched wb call site can never throw on web.
  return new Proxy(wb, {
    get(t, prop) {
      if (prop === 'then') return undefined; // never a thenable
      if (prop in t) return t[prop];
      if (typeof prop === 'string' && prop.startsWith('on')) return () => noop;
      return async () => undefined;
    },
  });
}
