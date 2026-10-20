/**
 * bridge-gate-scan.mjs — THE GATE GUARD's scanner (web/test/bridge-gate-guard.test.js).
 *
 * On web, `window.glyphh` is a Proxy: a name the contract (web/src/web-contract.js)
 * does not serve still answers with a function — a native one returns `undefined`
 * synchronously, every other one resolves `undefined`. So a renderer call site
 * that READS THE RESULT of an unshimmed name without a guard throws on web:
 * `(await window.glyphh.schedulesList()).ok` (help/schedules.js:182, 2026-10-04).
 *
 * This walks src/renderer for such sites. It is a REGEX scan, not a type-checker:
 *   · it catches the result-use shapes the crashes have taken —
 *       (await ….name(…)).prop        `….name(…).then(` on a NATIVE name
 *       const { a } = await ….name(   const r = await ….name(…) … r.prop (6 lines)
 *       ….name(…) inside Promise.all([…]) that is array-destructured
 *   · it matches by METHOD NAME alone (`.name(`), so an unrelated object with the
 *     same method name is a false positive (allowlist it with a reason), and a
 *     result read through a helper, a later line, or `.then((r) => r.ok)` on a
 *     non-native name is a miss. The page-level gates (web-surface.ts
 *     paintDesktopOnly / hostHas) are the real defence; this guard keeps new
 *     unguarded sites from landing unnoticed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyMethod } from '../../src/glyphh-core.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The method names preload.ts exposes on window.glyphh (its 2-space keys). */
export function preloadNames(src = fs.readFileSync(path.join(ROOT, 'src/renderer/preload.ts'), 'utf8')) {
  const start = src.indexOf('contextBridge.exposeInMainWorld("glyphh", {');
  const end = src.indexOf('contextBridge.exposeInMainWorld("wb", {');
  const body = src.slice(start, end > 0 ? end : undefined);
  return new Set([...body.matchAll(/^  ([A-Za-z0-9_]+)\s*(?::|\()/gm)].map((m) => m[1]));
}

/** The names web-contract.js's buildContract() returns (its 4-space keys). */
export function contractNames(src = fs.readFileSync(path.join(ROOT, 'web/src/web-contract.js'), 'utf8')) {
  const start = src.indexOf('export function buildContract(');
  const body = src.slice(start);
  return new Set([...body.matchAll(/^    ([A-Za-z0-9_]+)\s*(?::|\(|,)/gm)].map((m) => m[1]));
}

/** preload names the web contract does NOT serve. */
export function unshimmedNames() {
  const web = contractNames();
  return [...preloadNames()].filter((n) => !web.has(n)).sort();
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && e.name !== 'preload.ts') out.push(p);
  }
  return out;
}

/** Index of the `(` that opens the `(await` wrapping a call ending at `callEnd`, or -1. */
function awaitWrapStart(src, callStart) {
  // Walk back over balanced parens/brackets to find `(await ` directly enclosing the call.
  let i = callStart - 1;
  let depth = 0;
  while (i >= 0) {
    const c = src[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) {
        return /\(\s*await\s*$/.test(src.slice(Math.max(0, i - 12), i + 1)) ? i : -1;
      }
      depth--;
    } else if (depth === 0 && (c === ';' || c === '\n' && /^\s*(const|let|var|return|if|void)\b/.test(src.slice(i + 1, i + 12)))) return -1;
    i--;
  }
  return -1;
}

/**
 * Scan the renderer sources for unguarded result reads of unshimmed names.
 * @returns {Array<{ file: string, line: number, name: string, kind: string, text: string }>}
 */
export function scanRenderer(names = unshimmedNames(), root = path.join(ROOT, 'src/renderer')) {
  const hits = [];
  for (const file of walk(root)) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (const n of names) {
      const re = new RegExp('\\.' + n + '\\s*\\(', 'g');
      let m;
      while ((m = re.exec(src))) {
        let i = m.index + m[0].length, depth = 1;
        while (i < src.length && depth > 0) { const c = src[i]; if (c === '(') depth++; else if (c === ')') depth--; i++; }
        const after = src.slice(i, i + 40);
        const before = src.slice(Math.max(0, m.index - 160), m.index);
        const lineNo = src.slice(0, m.index).split('\n').length;
        let kind = '';
        if (awaitWrapStart(src, m.index) >= 0 && /^\)\s*[.\[](?!\.)/.test(after) && !/^\)\s*\?\./.test(after)) kind = '(await x()).prop';
        else if (/^\.then\s*\(/.test(after) && classifyMethod(n) === 'native') kind = 'native .then';
        else if (/const\s*\{[^}]*\}\s*=\s*await\s*[^;]*$/.test(before)) kind = 'destructure';
        else if (/(const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s*[^;]*$/.test(before)) {
          const v = before.match(/(const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s*[^;]*$/)[2];
          const rest = lines.slice(lineNo, lineNo + 6).join('\n');
          const deref = new RegExp('(^|[^\\w$?.])' + v.replace(/\$/g, '\\$') + '\\s*[.\\[](?!\\?)');
          const sameLine = lines[lineNo - 1].slice(lines[lineNo - 1].indexOf(n) + n.length);
          if (deref.test(rest) || deref.test(sameLine)) kind = 'const r = await; r.prop';
        }
        else if (/Promise\.all\(\s*\[[^\]]*$/.test(before) && /const\s*\[[^\]]*\]\s*=\s*await\s*Promise\.all\(\s*\[[^\]]*$/.test(src.slice(Math.max(0, m.index - 400), m.index))) kind = 'Promise.all';
        if (kind) hits.push({ file: path.relative(ROOT, file), line: lineNo, name: n, kind, text: lines[lineNo - 1].trim().slice(0, 120) });
      }
    }
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
