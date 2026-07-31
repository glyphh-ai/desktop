/**
 * Harness stub preload — fakes the ENTIRE window.yo / window.wb IPC surface
 * so dist/renderer/home.html boots the real renderer against deterministic
 * data, no main process behind it.
 *
 * Everything unknown resolves null (on* handlers return an unsubscribe), so
 * new bridge methods never crash the harness. Specific fakes below cover the
 * data the tests assert on. `window.__stub` is the test control surface:
 * captured calls, pref store, and an emitter for glyphh-agent run events.
 */

const listeners = new Map();   // channel → Set<cb>
const prefs = new Map();
const calls = { glyphhRun: [], setPreference: [], execCommand: [] };
let runSeq = 0;

const APPS = [
  { id: "glyphh", slug: "glyphh", name: "Glyphh", url: null, appArchetype: "glyphh-self", system: true },
  { id: "home", slug: "home", name: "Home", url: null, appArchetype: "glyphh-nav", system: true },
  { id: "settings", slug: "settings", name: "Settings", url: null, appArchetype: "glyphh-nav", system: true },
  { id: "connections", slug: "connections", name: "Connections", url: null, appArchetype: "glyphh-nav", system: true },
  { id: "gmail", slug: "gmail", name: "Gmail", url: "https://mail.google.com" },
  { id: "linear", slug: "linear", name: "Linear", url: "https://linear.app" },
  { id: "github", slug: "github", name: "GitHub", url: "https://github.com" },
];
const LAYOUTS = [
  {
    name: "Coding day", cols: 2, rows: 2, colWidths: [60, 40], rowHeights: [70, 30], sessionMode: "last",
    splits: [
      { panelId: "tool:coding", col: 0, row: 0, colSpan: 1, rowSpan: 2 },
      { panelId: "github", col: 1, row: 0, colSpan: 1, rowSpan: 1, sticky: true },
      { panelId: "linear", col: 1, row: 1, colSpan: 1, rowSpan: 1 },
    ],
  },
  {
    name: "Triple", cols: 3, rows: 2,
    splits: [
      { panelId: "tool:files", col: 0, row: 0, colSpan: 1, rowSpan: 1 },
      { panelId: "tool:diff", col: 0, row: 1, colSpan: 1, rowSpan: 1 },
      { panelId: "tool:editor", col: 1, row: 0, colSpan: 1, rowSpan: 1 },
      { panelId: "tool:terminal", col: 1, row: 1, colSpan: 1, rowSpan: 1 },
      { panelId: "gmail", col: 2, row: 0, colSpan: 1, rowSpan: 2 },
    ],
  },
];

/** Seedable session store — the RUNNER seeds via a ?chats= query param
 *  (read here, before any page script runs), so a fresh boot starts with
 *  exactly the records a spec wants. */
let sessionStore = { chats: [], currentId: "" };
try {
  const seeded = new URLSearchParams(location.search).get("chats");
  if (seeded) sessionStore = { chats: JSON.parse(seeded), currentId: "" };
} catch { /* unseeded boot */ }

function emit(channel, payload) {
  for (const cb of listeners.get(channel) ?? []) {
    try { cb(payload); } catch { /* test surface */ }
  }
}

const YO_OVERRIDES = {
  panelAppsList: () => Promise.resolve(APPS),
  layoutsList: () => Promise.resolve(LAYOUTS),
  recentsList: () => Promise.resolve([]),
  getPreference: (k, d) => Promise.resolve(prefs.has(k) ? prefs.get(k) : (d ?? null)),
  setPreference: (k, v) => { prefs.set(k, v); calls.setPreference.push([k, v]); return Promise.resolve(); },
  getTheme: () => Promise.resolve("dark"),
  platformUrl: "https://platform.test",
  glyphhSessionsLoad: () => Promise.resolve(JSON.parse(JSON.stringify(sessionStore))),
  // the renderer calls save(chatsArray, currentId)
  glyphhSessionsSave: (chats, currentId) => {
    sessionStore = JSON.parse(JSON.stringify({ chats: chats ?? [], currentId: currentId ?? "" }));
    return Promise.resolve();
  },
  glyphhRun: (p) => {
    calls.glyphhRun.push(JSON.parse(JSON.stringify(p)));
    const runId = `run-${++runSeq}`;
    return Promise.resolve({ runId });
  },
  glyphhStop: () => Promise.resolve(),
  glyphhContextUsage: () => Promise.resolve({ ratio: 0.2, foldAt: 0.8, tokens: 2000, budget: 10000, lanes: [] }),
  dashboardData: () => Promise.resolve({ name: "Harness", credits: 100, allowance: 0, spendCredits: 5, requests: 3, appsCount: 1, plan: "pro", orgCredits: true }),
  dripsBuiltinEffects: () => Promise.resolve(["fireworks", "rain"]),
  dripsList: () => Promise.resolve([{ name: "My Sparkle", recipe: "sparkle x3" }]),
  dripsPreview: () => Promise.resolve("ok"),
  execCommand: (c) => { calls.execCommand.push(c); return Promise.resolve(); },
  glyphhAppPreviewOpen: (slug) => Promise.resolve({ ok: true, fileUrl: "data:text/html,<h1>" + slug + "</h1>" }),
  rpaRegister: () => {}, rpaUnregister: () => {},
  railCollapseSet: () => Promise.resolve(),
  refreshAuth: () => Promise.resolve(),
  localMcpStatus: () => Promise.resolve({ running: false, port: 8123 }),
};

const WB_OVERRIDES = {
  getCwd: () => Promise.resolve("/tmp/harness"),
  getCwdExplicit: () => Promise.resolve("/tmp/harness"),
  getCwdRecents: () => Promise.resolve(["/tmp/harness"]),
  listDir: (d) => Promise.resolve({ entries: [{ name: "alpha.ts", path: (d || "") + "/alpha.ts", kind: "file" }] }),
  readFile: () => Promise.resolve({ content: "hello from harness" }),
  gitInfo: () => Promise.resolve({ isRepo: false }),
  pickCwd: () => Promise.resolve("/tmp/harness"),
  setCwd: () => Promise.resolve("/tmp/harness"),
};

function stub(overrides) {
  return new Proxy({}, {
    get(_t, k) {
      if (typeof k !== "string") return undefined;
      if (k in overrides) return overrides[k];
      if (k.startsWith("on")) {
        const channel = k;
        return (cb) => {
          if (!listeners.has(channel)) listeners.set(channel, new Set());
          listeners.get(channel).add(cb);
          return () => listeners.get(channel)?.delete(cb);
        };
      }
      return () => Promise.resolve(null);
    },
    has: () => true,
  });
}

window.yo = stub(YO_OVERRIDES);
window.wb = stub(WB_OVERRIDES);

window.addEventListener("error", (e) => { window.__lastErr = String(e.message); });
window.addEventListener("unhandledrejection", (e) => { window.__lastErr = "rejection: " + String(e.reason && e.reason.message || e.reason); });

window.__stub = {
  calls,
  prefs,
  seedChats(chats, currentId = "") { sessionStore = { chats, currentId }; },
  store: () => sessionStore,
  /** Fire a run event exactly as main would (channel = the preload's on* name). */
  agentDelta: (runId, delta) => emit("onGlyphhAgentDelta", { runId, delta }),
  agentDone: (runId, stopped = false) => emit("onGlyphhAgentDone", { runId, stopped }),
  agentError: (runId, error) => emit("onGlyphhAgentError", { runId, error }),
  lastRunId: () => `run-${runSeq}`,
};
