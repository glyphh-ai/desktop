/**
 * web-errors.js — make blank screens LOUD on the web target.
 *
 * A thrown error in the render path used to white-out the page silently. On web
 * (__GLYPHH_WEB__) we install global `error` + `unhandledrejection` handlers that
 * surface the failure visibly — a dismissible overlay — and always `console.error`
 * with a clear tag, so a blank screen is never debugged blind again.
 *
 * The message-formatting + dedupe are pure (formatError / installErrorSurface takes
 * an injected sink) so they unit-test without a DOM.
 */

const TAG = '[glyphh-web]';

// Benign browser noise that must NOT surface as a "something went wrong" overlay.
// "ResizeObserver loop …" is a famously harmless message every app with a
// ResizeObserver emits when a callback nudges layout into the next frame — it
// breaks nothing. Add other known-harmless patterns here as they show up.
const BENIGN = [
  /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i,
];

/** True for known-harmless browser noise the overlay should ignore. */
export function isBenignError(msg) {
  return BENIGN.some((re) => re.test(msg || ''));
}

/** Normalize any thrown value / rejection reason to a printable string. */
export function formatError(err) {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  if (err.message) return String(err.message);
  try { return JSON.stringify(err); } catch { return String(err); }
}

/** Build (once) and return the error overlay element, appending it to `doc.body`. */
function ensureOverlay(doc) {
  let el = doc.getElementById('glyphh-web-error');
  if (el) return el;
  el = doc.createElement('div');
  el.id = 'glyphh-web-error';
  el.setAttribute('role', 'alert');
  el.style.cssText = [
    'position:fixed', 'inset:auto 12px 12px 12px', 'z-index:2147483647',
    'max-height:45vh', 'overflow:auto', 'padding:14px 16px',
    'background:#2a0f0f', 'color:#ffd9d9', 'border:1px solid #7a2222',
    'border-radius:10px', 'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
    'box-shadow:0 8px 30px rgba(0,0,0,.5)', 'white-space:pre-wrap',
    'padding-bottom:calc(14px + env(safe-area-inset-bottom, 0px))',
  ].join(';');
  const head = doc.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;font-weight:700;';
  const title = doc.createElement('span');
  title.textContent = 'Something went wrong';
  const close = doc.createElement('button');
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.style.cssText = 'background:none;border:none;color:#ffd9d9;font-size:18px;line-height:1;cursor:pointer;padding:0 4px;';
  close.addEventListener('click', () => el.remove());
  head.append(title, close);
  const body = doc.createElement('pre');
  body.id = 'glyphh-web-error-body';
  body.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;';
  el.append(head, body);
  (doc.body || doc.documentElement).appendChild(el);
  return el;
}

/**
 * Install the global error surface. Returns a `report(err, context?)` fn (also
 * called by the listeners) so callers can surface caught errors too. `sink` is the
 * DOM painter — defaults to the overlay; injectable/null for tests.
 * @param {{ win?: Window, doc?: Document, log?: Function, sink?: ((msg:string)=>void)|null }} [deps]
 */
export function installErrorSurface(deps = {}) {
  const win = deps.win || (typeof window !== 'undefined' ? window : null);
  const doc = deps.doc || (typeof document !== 'undefined' ? document : null);
  const log = deps.log || (typeof console !== 'undefined' ? console.error.bind(console) : () => {});
  const sink = deps.sink === undefined
    ? (msg) => { if (doc) { ensureOverlay(doc).querySelector('#glyphh-web-error-body').textContent = msg; } }
    : deps.sink;

  let last = '';
  const report = (err, context) => {
    const raw = formatError(err);
    if (isBenignError(raw)) return report; // benign browser noise (e.g. ResizeObserver loop) — never surface
    const msg = (context ? `${context}\n` : '') + raw;
    log(TAG, context || 'error:', err);
    if (msg === last) return report; // collapse a repeated identical error
    last = msg;
    try { if (sink) sink(msg); } catch { /* the surface must never itself throw */ }
    return report;
  };

  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('error', (e) => {
      // Ignore resource-load errors (img/script 404s) — only script exceptions carry
      // an `error`/`message` worth surfacing as a render failure.
      if (e && (e.error || e.message)) report(e.error || e.message, 'Uncaught error');
    });
    win.addEventListener('unhandledrejection', (e) => {
      report(e && ('reason' in e ? e.reason : e), 'Unhandled promise rejection');
    });
  }
  return report;
}
