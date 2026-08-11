/**
 * drip-web-runner.js — drip effects ON THE WEB SURFACE.
 *
 * The desktop renders a drip by loading a generated effect document into a
 * transparent Electron overlay window (drip-manager.ts). A browser tab has no
 * OS overlay, so this runner renders the SAME documents (shared generators in
 * src/shared/drip-effects.ts) inside a full-viewport, pointer-events:none,
 * sandboxed `<iframe srcdoc>` at a very high z-index — the docs carry their own
 * <script>, and `sandbox="allow-scripts"` runs them in an opaque origin with no
 * reach into the app.
 *
 * Lifecycle mirrors the desktop overlay:
 *   - a ONE-SHOT frame removes itself when the doc posts "__drip_close__"
 *     (the shared close signal; the Electron host listens to the console-message
 *     twin), with the same per-effect safety-timeout backstop;
 *   - a PERSISTENT (`-1`) frame stays until replaced (re-firing the same effect
 *     swaps in a fresh frame) or explicitly cleared — Esc clears all, as does a
 *     `stop` recipe;
 *   - multiple effects/counts stagger 1500ms apart, exactly like executeRaw.
 *
 * Top-level is DOM-free (module-scope state only) so importing this from the
 * tested web-contract surface never touches a document at load time.
 */
import { parseDripRecipe, buildOneShotHtml, buildLoopHtml, oneShotSafetyMs } from '../../src/shared/drip-effects';

// Above the app, below nothing we care about; matches "very high z-index".
const DRIP_Z = 2147483000;

/** effect name → live persistent iframe */
const persistentFrames = new Map();
/** one-shot frames awaiting their close signal: contentWindow → teardown() */
const oneShotFrames = new Map();

let listenersWired = false;

function wireListenersOnce() {
  if (listenersWired || typeof window === 'undefined') return;
  listenersWired = true;
  // The shared close signal: a sandboxed doc posts "__drip_close__" to its
  // parent when its run ends (see CLOSE_SIGNAL in drip-effects.ts).
  window.addEventListener('message', (ev) => {
    if (ev.data !== '__drip_close__') return;
    const teardown = ev.source ? oneShotFrames.get(ev.source) : null;
    if (teardown) teardown();
  });
  // Esc clears every persistent effect (the web twin of `.drip stop`).
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && persistentFrames.size) stopAllDrips();
  });
}

function makeFrame(html) {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts');
  f.setAttribute('aria-hidden', 'true');
  f.style.cssText = `position:fixed;inset:0;width:100%;height:100%;border:0;background:transparent;pointer-events:none;z-index:${DRIP_Z};color-scheme:normal;`;
  f.srcdoc = html;
  document.body.appendChild(f);
  return f;
}

function viewport() {
  return { w: Math.max(1, window.innerWidth), h: Math.max(1, window.innerHeight) };
}

function fireOneShot(effect, opacity) {
  wireListenersOnce();
  const { w, h } = viewport();
  let html = buildOneShotHtml(effect, w, h);
  if (opacity > 0) html = html.replace('<body>', `<body style="opacity:${opacity}">`);
  const frame = makeFrame(html);
  let done = false;
  const teardown = () => {
    if (done) return;
    done = true;
    if (frame.contentWindow) oneShotFrames.delete(frame.contentWindow);
    frame.remove();
  };
  // srcdoc's contentWindow exists once appended; key the close signal by it.
  if (frame.contentWindow) oneShotFrames.set(frame.contentWindow, teardown);
  // Backstop — same per-effect ceiling as the desktop overlay.
  setTimeout(teardown, oneShotSafetyMs(effect));
}

function firePersistent(effect, opacity) {
  wireListenersOnce();
  // Re-fire REPLACES: the old frame goes, a fresh one takes its place.
  const existing = persistentFrames.get(effect);
  if (existing) {
    existing.remove();
    persistentFrames.delete(effect);
  }
  const { w, h } = viewport();
  const frame = makeFrame(buildLoopHtml(effect, w, h, opacity));
  persistentFrames.set(effect, frame);
}

/** Clear every persistent effect (Esc / `stop`). */
export function stopAllDrips() {
  for (const frame of persistentFrames.values()) frame.remove();
  persistentFrames.clear();
}

/**
 * Execute a drip recipe (`[count] [-1 persistent] [0-1 opacity] [effect…]`) on
 * this page. Returns the same status strings as the desktop DripManager so the
 * command surfaces read identically.
 * @param {string} recipe
 * @returns {string}
 */
export function runDripRecipe(recipe) {
  const raw = String(recipe ?? '').trim();
  if (raw.toLowerCase() === 'stop') {
    stopAllDrips();
    return 'stopped all persistent effects';
  }
  const { count, opacity, effects } = parseDripRecipe(raw);

  if (count === -1) {
    const op = opacity > 0 ? opacity : 0.5;
    for (const effect of effects) firePersistent(effect, op);
    return `drip: ${effects.join(' + ')} constant`;
  }

  for (let i = 0; i < count; i++) {
    for (let j = 0; j < effects.length; j++) {
      const delay = (i * effects.length + j) * 1500;
      const eff = effects[j];
      const op = opacity > 0 ? opacity : -1;
      setTimeout(() => fireOneShot(eff, op), delay);
    }
  }

  return count > 1 ? `drip: ${effects.join(' + ')} x${count}` : `drip: ${effects.join(' + ')}`;
}
