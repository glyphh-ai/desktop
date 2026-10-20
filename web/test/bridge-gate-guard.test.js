/**
 * bridge-gate-guard.test.js — THE GATE GUARD (his order, 2026-10-04, after the
 * schedules crash: `(await window.glyphh.schedulesList()).ok` on app.glyphh.ai).
 *
 * The web bridge answers EVERY name with a function (web/src/bridge.js); a
 * name web-contract.js does not serve resolves `undefined`, so a renderer
 * call site that reads the result without a guard throws on web. This test
 * walks src/renderer (helpers/bridge-gate-scan.mjs) for such sites and fails
 * when one appears that is not in the allowlist below — every entry there
 * names the GATE that keeps the site off the web path (a page-level
 * paintDesktopOnly, a hostHas-hidden control, a try/catch). A site whose gate
 * is removed must be re-justified here; a stale entry fails too, so the list
 * stays true.
 *
 * LIMITS (see the scanner's header): a regex scan matched by method NAME —
 * an unrelated object's same-named method is a false positive (allowlist it);
 * a result read later than six lines on, through a helper, or inside
 * `.then((r) => r.ok)` on a non-native name is a miss. The gates are the
 * defence; this is the tripwire.
 */
import { describe, it, expect } from 'vitest';
import { scanRenderer, unshimmedNames, contractNames, preloadNames } from './helpers/bridge-gate-scan.mjs';

/** file → { name → why it is safe on web } */
const ALLOWED = {
  'src/renderer/code-workbench.ts': {
    gitInfo: 'window.wb.gitInfo — the workbench bridge is REAL on web (wb-relay.js / wb-pod.js)',
    listDir: 'window.wb.listDir — the workbench bridge is REAL on web (wb-relay.js / wb-pod.js)',
  },
  'src/renderer/help/files.ts': {
    filesRename: 'the Rename row is offered only when hostHas("filesRename")',
  },
  'src/renderer/help/settings.ts': {
    localMcpSetEnabled: 'the local MCP section is hidden unless hostHas("localMcpSetEnabled") (f6d9e91f)',
    localMcpSetPort: 'the local MCP section is hidden unless hostHas("localMcpSetEnabled") (f6d9e91f)',
    localMcpTokensCreate: 'the local MCP section is hidden unless hostHas("localMcpSetEnabled") (f6d9e91f)',
  },
  'src/renderer/help/settings-connections.ts': {
    pipedreamAppEnable: 'the Pipedream card and its pd: rows exist only when hostHas("pipedreamConfigGet") (settings-connections.ts pdHosted) — never on web',
    pipedreamTools: 'the Pipedream card and its pd: rows exist only when hostHas("pipedreamConfigGet") (settings-connections.ts pdHosted) — never on web',
    pipedreamDisconnect: 'the Pipedream card and its pd: rows exist only when hostHas("pipedreamConfigGet") (settings-connections.ts pdHosted) — never on web',
    pipedreamConfigSet: 'the Pipedream card and its pd: rows exist only when hostHas("pipedreamConfigGet") (settings-connections.ts pdHosted) — never on web',
    pipedreamTest: 'the Pipedream card and its pd: rows exist only when hostHas("pipedreamConfigGet") (settings-connections.ts pdHosted) — never on web',
    pipedreamConfigClear: 'the Pipedream card and its pd: rows exist only when hostHas("pipedreamConfigGet") (settings-connections.ts pdHosted) — never on web',
    pipedreamApps: 'the Pipedream card and its pd: rows exist only when hostHas("pipedreamConfigGet") (settings-connections.ts pdHosted) — never on web',
    pipedreamCategories: 'the Pipedream card and its pd: rows exist only when hostHas("pipedreamConfigGet") (settings-connections.ts pdHosted) — never on web',
    pipedreamConnect: 'the Pipedream card and its pd: rows exist only when hostHas("pipedreamConfigGet") (settings-connections.ts pdHosted) — never on web',
  },
  'src/renderer/help/composer-plus.ts': {
    pipedreamAppEnable: 'called only for a pd: row, and those exist only when pipedreamAccounts answered ok — on web it resolves undefined, so there are none',
  },
  'src/renderer/onboarding.ts': {
    startDeviceLogin: "the desktop's device-login overlay; the web signs in through web/src/web-login.js",
  },
};

describe('the web bridge gate guard', () => {
  it('reads both contracts (preload.ts and web-contract.js)', () => {
    const p = preloadNames(), w = contractNames();
    // localMcpSetPort is the desktop's loopback MCP server — never served on web.
    expect(p.has('localMcpSetPort')).toBe(true);
    expect(w.has('localMcpSetPort')).toBe(false);
    expect(w.has('loopModels')).toBe(true);
    expect(w.has('wsStateLoad')).toBe(true);
    // Schedules and drips are member-library records since 2026-10-04: the
    // web lists and writes them; only the runs and "run now" are the desktop's.
    expect(w.has('schedulesList')).toBe(true);
    expect(w.has('scheduleSave')).toBe(true);
    expect(w.has('dripsList')).toBe(true);
    expect(w.has('dripsSave')).toBe(true);
    expect(w.has('dripsDelete')).toBe(true);
    expect(unshimmedNames()).toContain('localMcpSetPort');
    expect(unshimmedNames()).toContain('dripsRunning');     // what is on screen is the desktop's overlay
  });

  it('every unguarded result read of an unshimmed name is a known, gated site', () => {
    const hits = scanRenderer();
    const unexplained = hits.filter((h) => {
      const file = ALLOWED[h.file];
      return !file || !(file[h.name] || file.__page);
    });
    expect(unexplained.map((h) => `${h.file}:${h.line} ${h.name} [${h.kind}] ${h.text}`)).toEqual([]);
  });

  it('the allowlist carries no stale entries', () => {
    const hits = scanRenderer();
    const seen = new Set(hits.map((h) => `${h.file}#${h.name}`));
    const stale = [];
    for (const [file, names] of Object.entries(ALLOWED)) {
      for (const name of Object.keys(names)) {
        if (name === '__page') { if (!hits.some((h) => h.file === file)) stale.push(`${file} (page)`); continue; }
        if (!seen.has(`${file}#${name}`)) stale.push(`${file}#${name}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
