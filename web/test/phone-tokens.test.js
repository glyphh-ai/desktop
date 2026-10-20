import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The phone wears the desktop's tokens and buttons, VERBATIM (his report,
// 2026-10-05: "the web app for mobile isn't using the same button style etc
// as the web or app... it has purple themed buttons"). mobile.css cannot
// import styles.css, so it carries a copy — this guard fails the moment the
// copy drifts from src/renderer/styles.css, theme by theme, token by token.
const here = path.dirname(new URL(import.meta.url).pathname);
const mobile = fs.readFileSync(path.join(here, '..', 'mobile.css'), 'utf8');
const mobileTsx = fs.readFileSync(path.join(here, '..', 'src', 'mobile.tsx'), 'utf8');
const desktop = fs.readFileSync(path.join(here, '..', '..', 'src', 'renderer', 'styles.css'), 'utf8');

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** Top-level `selector { body }` rules of a stylesheet (at-rule bodies skipped). */
function rules(css) {
  const out = [];
  let depth = 0; let selStart = 0; let bodyStart = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') { if (depth === 0) bodyStart = i + 1; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0) { out.push({ selector: css.slice(selStart, bodyStart - 1).replace(/\s+/g, ' ').trim(), body: css.slice(bodyStart, i) }); selStart = i + 1; }
    }
  }
  return out;
}
/** `--token: value` pairs of a rule body (the last declaration wins, as in CSS). */
function tokens(body) {
  const m = {};
  for (const [, k, v] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) m[k] = v.trim();
  return m;
}
/** Every declaration of a rule body, sorted, so two bodies compare as sets. */
const decls = (body) => body.split(';').map((d) => d.replace(/\s+/g, ' ').trim()).filter(Boolean).sort();
const firstRule = (list, selector) => list.find((r) => r.selector === selector);
/** The desktop's rule whose selector list STARTS with the phone's (the phone's
 *  own classes ride the same selector, after the desktop's). */
const phoneRule = (list, head) => list.find((r) => r.selector === head || r.selector.startsWith(head + ','));

const mob = rules(strip(mobile));
const desk = rules(strip(desktop));
const themeRules = mob.filter((r) => /\[data-theme=/.test(r.selector));

describe('the phone wears the desktop tokens', () => {
  it('wears the display face on every title — JetBrains Mono 700, the desktop\'s own rule (his order, 2026-10-07)', () => {
    expect(mobile).toMatch(/--font-display:\s*var\(--font-mono\)/);
    const face = rules(strip(mobile)).filter((r) => /font-family:\s*var\(--font-display\)\s*!important/.test(r.body));
    expect(face.length).toBeGreaterThanOrEqual(1);
    const sel = face.map((r) => r.selector).join(' ');
    for (const cls of ['h1', '.m-chats-title', '.m-prompt-title', '.m-sel-title', '.m-confirm-title', '.m-profile-name', '.m-login-title']) {
      expect(sel, `${cls} is not in the display-face rule`).toContain(cls);
    }
    expect(face.every((r) => /font-weight:\s*700\s*!important/.test(r.body))).toBe(true);
    const d = rules(strip(desktop)).find((r) => /font-family:\s*var\(--font-display\)\s*!important/.test(r.body));
    expect(d, 'the desktop has no display-face rule').toBeTruthy();
  });
  it('names styles.css as the source and says to change both together', () => {
    expect(mobile).toMatch(/src\/renderer\/styles\.css/);
    expect(mobile).toMatch(/Change a value there and here together/);
  });
  it('carries every theme id the Appearance picker can set, each as a [data-theme] block', () => {
    const list = /const THEMES[^=]*=\s*\[([\s\S]*?)\];/.exec(mobileTsx)[1];
    const ids = [...list.matchAll(/\{ id: '([\w-]+)'/g)].map((m) => m[1]).filter((id) => id !== 'system');
    expect(ids.length).toBeGreaterThanOrEqual(14);
    for (const id of ids) {
      expect(themeRules.some((r) => r.selector.includes(`[data-theme="${id}"]`)), `no block for theme "${id}"`).toBe(true);
    }
  });
  it('has every [data-theme] token block equal to the desktop\'s, token for token', () => {
    expect(themeRules.length).toBeGreaterThanOrEqual(14);
    for (const r of themeRules) {
      const d = firstRule(desk, r.selector);
      expect(d, `desktop has no block "${r.selector}"`).toBeTruthy();
      expect(tokens(r.body), `tokens drifted in "${r.selector}"`).toEqual(tokens(d.body));
    }
  });
  it('paints the accent the desktop paints — light and dark alike', () => {
    const light = tokens(firstRule(mob, ':root, [data-theme="light"]').body);
    const dark = tokens(firstRule(mob, '[data-theme="dark"], [data-theme="highvis"]').body);
    const dLight = tokens(firstRule(desk, ':root, [data-theme="light"]').body);
    const dDark = tokens(firstRule(desk, '[data-theme="dark"], [data-theme="highvis"]').body);
    for (const k of ['--accent', '--accent-hover', '--accent-fg', '--accent-text', '--grad-accent', '--selection', '--active-bg', '--code-inline', '--scrollbar-hover']) {
      expect(light[k], `light ${k}`).toBe(dLight[k]);
      expect(dark[k], `dark ${k}`).toBe(dDark[k]);
    }
  });
  it('keeps the fonts the desktop declares (headings on the display face)', () => {
    const root = tokens(firstRule(mob, ':root').body);
    const dRoot = tokens(firstRule(desk, ':root').body);
    expect(root['--font-sans']).toBe(dRoot['--font-sans']);
    expect(root['--font-mono']).toBe(dRoot['--font-mono']);
    expect(root['--font-display']).toBe('var(--font-mono)');
    expect(mobile).toMatch(/h1, h2, h3, h4,[\s\S]*?font-family: var\(--font-display\) !important/);
  });
});

describe('no copied purple survives outside the token blocks', () => {
  const banned = ['#8c3bf2', '#b066ff', '#af5fff', '#c084fc', '#7a2fe0', '#7c3aed', '#a855f7'];
  // Everything in mobile.css that is NOT a theme block or the :root line — the
  // theme blocks are the desktop's verbatim (the desktop's own High Vis accent
  // IS #b066ff / #8c3bf2), so a copied purple can only hide in a rule.
  const ruleCss = mob.filter((r) => !/\[data-theme=/.test(r.selector) && r.selector !== ':root').map((r) => `${r.selector}{${r.body}}`).join('\n');
  it.each(banned)('%s is not hard-coded in a mobile.css rule', (hex) => {
    expect(ruleCss.toLowerCase()).not.toContain(hex);
  });
  it.each(banned)('%s is not hard-coded in mobile.tsx', (hex) => {
    expect(mobileTsx.toLowerCase()).not.toContain(hex);
  });
  it('has no rule painting an accent-shaped purple of its own (rgba 140,59,242 / 176,102,255 / 175,95,255)', () => {
    expect(ruleCss).not.toMatch(/140,\s*59,\s*242|176,\s*102,\s*255|175,\s*95,\s*255/);
  });
});

describe('the phone\'s buttons are the desktop\'s .action-btn family', () => {
  it.each(['.action-btn', '.action-btn.secondary', '.action-btn.danger', '.action-btn.primary'])('%s carries the desktop\'s declarations', (sel) => {
    const d = firstRule(desk, sel);
    const m = phoneRule(mob, sel);
    expect(m, `phone has no ${sel}`).toBeTruthy();
    expect(decls(m.body)).toEqual(decls(d.body));
  });
  it.each(['.action-btn:hover:not(:disabled)', '.action-btn:disabled', '.action-btn.primary:hover:not(:disabled)', '.action-btn.primary:disabled', '.action-btn.danger:hover', '.action-btn.secondary:hover:not(:disabled)'])('%s carries the desktop\'s declarations', (sel) => {
    expect(decls(phoneRule(mob, sel).body)).toEqual(decls(firstRule(desk, sel).body));
  });
  it('paints the + New session pill, the sheet primaries and the login primaries as the standard primary', () => {
    expect(mobileTsx).toMatch(/className="m-fab action-btn primary lg"/);
    expect(mobileTsx).toMatch(/className="m-rail-new action-btn primary lg"/);
    expect(mobileTsx).not.toMatch(/\bbtn-primary\b/);
    const primary = phoneRule(mob, '.action-btn.primary').selector;
    for (const cls of ['.m-confirm-btn.m-confirm-go', '.m-login-primary', '.m-prompt-btn.m-prompt-primary']) expect(primary).toContain(cls);
    const danger = phoneRule(mob, '.action-btn.danger').selector;
    expect(danger).toContain('.m-confirm-btn.m-confirm-danger');
  });
});
