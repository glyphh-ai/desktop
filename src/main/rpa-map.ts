/**
 * rpa-map.ts — RPA ON A TAB, the machine side (his order, 2026-10-07).
 *
 * A tab's mapped commands and sequences live in its launch config (`rpa`,
 * shared/rpa.ts), on the member library row like the rest of the tab. This
 * module is what acts on them:
 *
 *   pick      the DOM picker (restored from April's dom-picker.ts): an overlay
 *             on the tab's live panel; the user hovers and clicks, the element
 *             comes back as a selector with what it is
 *   map       write a command (the page's Tabs tab, or the agent through a tool)
 *   run       one command on the tab's panel: open the panel if it is not up,
 *             wait for what it waits for, act, pause, verify
 *   sequence  the shortcut: steps over the commands, {{placeholders}} filled
 *
 * Every door is a relay handler on the shared registry (`rpa.commands`,
 * `rpa.map`, `rpa.unmap`, `rpa.pick`, `rpa.run`, `rpa.sequenceSave`,
 * `rpa.sequenceRemove`, `rpa.sequenceRun`), so the local MCP server, the Tabs
 * page and the loop's catalog all drive the same code, with the user watching
 * the panel the whole time.
 */
import { webContents, type WebContents } from "electron";
import { dispatchRelayMethod, registerRelayHandler } from "./relay-client.js";
import { panelIsLive } from "./rpa.js";
import { readRow, updateEntry } from "./apps-store.js";
import {
  normalizeCommand, normalizeSequence, rpaOf, substitute, withCommand, withSequence, withoutCommand, withoutSequence,
  type RpaCommand, type RpaConfig, type RpaSequence,
} from "../shared/rpa.js";

const PANEL_OPEN_WAIT_MS = 10_000;
const WAIT_FOR_MS = 10_000;
const PICK_WAIT_MS = 120_000;

const str = (params: unknown, key: string): string => {
  const v = (params as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v.trim() : "";
};
const slugOf = (params: unknown): string => {
  const s = str(params, "app") || str(params, "slug") || str(params, "tab");
  if (!s) throw new Error("rpa needs { app } — the tab's slug (panels_available lists them)");
  return s;
};
const q = (s: string): string => JSON.stringify(s);

// ── The stored mapping ───────────────────────────────────────────────────────

/** The tab's RPA config. A slug that is not a saved tab is an error. */
export function readTabRpa(slug: string): RpaConfig {
  const row = readRow(slug);
  if (!row) throw new Error(`no saved tab "${slug}" — panels_available lists the tabs; panels_add makes one`);
  return rpaOf(row.config);
}

async function writeTabRpa(slug: string, cfg: RpaConfig): Promise<RpaConfig> {
  const row = readRow(slug);
  if (!row) throw new Error(`no saved tab "${slug}"`);
  await updateEntry(slug, { config: { ...(row.config ?? {}), rpa: cfg } });
  return cfg;
}

export async function mapCommand(slug: string, input: unknown): Promise<RpaCommand> {
  const cmd = normalizeCommand(input);
  await writeTabRpa(slug, withCommand(readTabRpa(slug), cmd));
  return cmd;
}
export async function unmapCommand(slug: string, key: string): Promise<void> {
  const cfg = readTabRpa(slug);
  if (!(key in cfg.commands)) throw new Error(`"${key}" is not a mapped command of ${slug}`);
  await writeTabRpa(slug, withoutCommand(cfg, key));
}
export async function saveSequence(slug: string, input: unknown): Promise<RpaSequence> {
  const seq = normalizeSequence(input);
  await writeTabRpa(slug, withSequence(readTabRpa(slug), seq));
  return seq;
}
export async function removeSequence(slug: string, name: string): Promise<void> {
  const cfg = readTabRpa(slug);
  if (!(name in cfg.sequences)) throw new Error(`"${name}" is not a sequence of ${slug}`);
  await writeTabRpa(slug, withoutSequence(cfg, name));
}

// ── The panel ────────────────────────────────────────────────────────────────

/** The tab's panel, opened on screen if it is not up, and waited for. */
export async function ensurePanel(slug: string): Promise<void> {
  if (panelIsLive(slug)) return;
  await dispatchRelayMethod("panels.open", { app: slug });
  const until = Date.now() + PANEL_OPEN_WAIT_MS;
  while (!panelIsLive(slug)) {
    if (Date.now() > until) throw new Error(`${slug} did not open: no panel appeared within ${PANEL_OPEN_WAIT_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function liveContents(slug: string): Promise<WebContents> {
  await ensurePanel(slug);
  // rpa.read goes through the registry's target lookup; for scripts that need
  // the raw contents (the picker, the waits) resolve it the same way.
  const found = await dispatchRelayMethod("rpa.target", { app: slug }) as { id: number };
  const wc = webContents.fromId(found.id);
  if (!wc || wc.isDestroyed()) throw new Error(`panel not open: ${slug}`);
  return wc;
}

async function waitForSelector(wc: WebContents, selector: string, ms = WAIT_FOR_MS): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    const hit = await wc.executeJavaScript(`!!document.querySelector(${q(selector)})`).catch(() => false);
    if (hit) return;
    if (Date.now() > until) throw new Error(`waited ${ms / 1000}s and ${selector} never appeared`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ── The picker (April's dom-picker.ts, on a tab) ─────────────────────────────

export interface PickResult {
  selector: string; tag: string; text: string; id?: string; classes?: string; role?: string; ariaLabel?: string;
  isEditable: boolean; isClickable: boolean;
}

const PICKER_SCRIPT = `
new Promise(function(resolve) {
  var old = document.getElementById('__glyphh_pick__'); if (old) old.remove();
  var overlay = document.createElement('div');
  overlay.id = '__glyphh_pick__';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;';
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;border:2px solid #af5fff;background:rgba(175,95,255,0.10);border-radius:3px;box-shadow:0 0 12px rgba(175,95,255,0.35);display:none;';
  var label = document.createElement('div');
  label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#1a1a1c;color:#f1f1f1;font:12px ui-monospace,monospace;padding:4px 8px;border-radius:4px;border:1px solid #af5fff;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none;';
  var hint = document.createElement('div');
  hint.textContent = 'Click the element to map it · Esc cancels';
  hint.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:#1a1a1c;color:#f1f1f1;font:13px system-ui,sans-serif;padding:6px 12px;border-radius:999px;border:1px solid #af5fff;';
  document.body.appendChild(box); document.body.appendChild(label); document.body.appendChild(hint);
  var last = null;
  function under(e) { overlay.style.pointerEvents = 'none'; var el = document.elementFromPoint(e.clientX, e.clientY); overlay.style.pointerEvents = 'auto'; return el; }
  function unique(sel) { try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; } }
  function attrSel(el, name) { var v = el.getAttribute(name); if (!v) return null; var s = el.tagName.toLowerCase() + '[' + name + '="' + v.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"]'; return unique(s) ? s : null; }
  function buildSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    var a = attrSel(el, 'data-testid') || attrSel(el, 'data-test') || attrSel(el, 'name') || attrSel(el, 'aria-label') || attrSel(el, 'placeholder') || attrSel(el, 'title');
    if (a) return a;
    var parts = []; var cur = el;
    while (cur && cur !== document.body && parts.length < 6) {
      var tag = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      var cls = Array.prototype.slice.call(cur.classList, 0, 3).map(function(c) { return '.' + CSS.escape(c); }).join('');
      var seg = tag + cls;
      if (cur.parentElement) {
        var sib = Array.prototype.filter.call(cur.parentElement.children, function(s) { return s.tagName === cur.tagName; });
        if (sib.length > 1) seg += ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg); cur = cur.parentElement;
    }
    return parts.join(' > ');
  }
  function paint(el) {
    if (!el || el === overlay) { box.style.display = 'none'; label.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    box.style.display = 'block'; box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    var info = el.tagName.toLowerCase();
    if (el.id) info += '#' + el.id; else if (typeof el.className === 'string' && el.className) info += '.' + el.className.split(' ')[0];
    if (el.getAttribute('role')) info += ' [' + el.getAttribute('role') + ']';
    var t = (el.innerText || '').trim().slice(0, 40); if (t) info += ' “' + t + '”';
    label.textContent = info; label.style.display = 'block'; label.style.left = r.left + 'px'; label.style.top = Math.max(0, r.top - 28) + 'px';
  }
  function cleanup() { overlay.remove(); box.remove(); label.remove(); hint.remove(); document.removeEventListener('keydown', onKey, true); }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(); resolve(null); } }
  overlay.addEventListener('mousemove', function(e) { var el = under(e); if (el !== last) { last = el; paint(el); } });
  overlay.addEventListener('click', function(e) {
    e.preventDefault(); e.stopPropagation();
    var el = under(e); cleanup();
    if (!el) { resolve(null); return; }
    var tag = el.tagName.toLowerCase(); var role = el.getAttribute('role');
    resolve({
      selector: buildSelector(el), tag: tag,
      text: (el.innerText || el.textContent || '').trim().slice(0, 100),
      id: el.id || undefined,
      classes: (typeof el.className === 'string' ? el.className : '') || undefined,
      role: role || undefined, ariaLabel: el.getAttribute('aria-label') || undefined,
      isEditable: el.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select',
      isClickable: tag === 'button' || tag === 'a' || role === 'button' || role === 'link' || tag === 'summary' || !!el.onclick
    });
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
})`;

/** Put the picker on the tab's panel; the element the user clicks, or null on Esc. */
export async function pickOnTab(slug: string): Promise<PickResult | null> {
  const wc = await liveContents(slug);
  wc.focus();
  const picked = await Promise.race([
    wc.executeJavaScript(PICKER_SCRIPT) as Promise<PickResult | null>,
    new Promise<null>((res) => setTimeout(() => res(null), PICK_WAIT_MS)),
  ]);
  if (!picked) await wc.executeJavaScript("(function(){var o=document.getElementById('__glyphh_pick__');if(o)o.remove();})()").catch(() => undefined);
  return picked;
}

// ── Running ──────────────────────────────────────────────────────────────────

export interface RunResult {
  app: string; command: string; action: string; ok: true;
  /** What a read returned, what goto landed on, what a custom script returned. */
  result?: unknown;
  verified?: string;
}

/** One mapped command on the tab's panel, the user watching. */
export async function runCommand(slug: string, key: string, value?: string): Promise<RunResult> {
  const cfg = readTabRpa(slug);
  const cmd = cfg.commands[key];
  if (!cmd) throw new Error(`"${key}" is not a mapped command of ${slug}: ${Object.keys(cfg.commands).join(", ") || "none mapped yet (rpa_pick + rpa_map)"}`);
  const wc = await liveContents(slug);
  const args = { value: value ?? "" };
  if (cmd.waitFor) await waitForSelector(wc, substitute(cmd.waitFor, args));
  const selector = cmd.selector ? substitute(cmd.selector, args) : "";
  let result: unknown;
  const guideWhy = cmd.guide?.recover ? ` If it fails: ${cmd.guide.recover}` : "";
  try {
    switch (cmd.action) {
      case "click":
        await dispatchRelayMethod("rpa.click", { app: slug, selector });
        break;
      case "type":
        await dispatchRelayMethod("rpa.type", { app: slug, selector, text: substitute(cmd.text ?? "{{value}}", args) });
        break;
      case "read":
      case "readHtml":
        result = (await dispatchRelayMethod("rpa.read", { app: slug, selector, as: cmd.action === "readHtml" ? "html" : "text" }) as { value: string }).value;
        break;
      case "goto":
        result = (await dispatchRelayMethod("rpa.goto", { app: slug, url: substitute(cmd.url ?? "{{value}}", args) }) as { url: string }).url;
        break;
      case "custom":
        result = await wc.executeJavaScript(`(async () => { const VALUE = ${q(args.value)}; ${cmd.script} })()`);
        break;
    }
  } catch (err) {
    throw new Error(`${slug} ${key} (${cmd.action}) failed: ${err instanceof Error ? err.message : String(err)}.${guideWhy}`);
  }
  if (cmd.guide?.delay) await new Promise((r) => setTimeout(r, cmd.guide!.delay));
  let verified: string | undefined;
  if (cmd.guide?.verify) {
    try { await waitForSelector(wc, substitute(cmd.guide.verify, args), Math.max(2000, cmd.guide.delay ?? 0) + 3000); verified = cmd.guide.verify; }
    catch (err) { throw new Error(`${slug} ${key} ran but did not verify: ${err instanceof Error ? err.message : String(err)}.${guideWhy}`); }
  }
  return { app: slug, command: key, action: cmd.action, ok: true, ...(result !== undefined ? { result } : {}), ...(verified ? { verified } : {}) };
}

export interface SequenceResult { app: string; sequence: string; ok: true; steps: Array<{ command: string; result?: unknown }> }

/** A sequence, step by step; a failing step stops it and names where. */
export async function runSequence(slug: string, name: string, args: Record<string, unknown> = {}): Promise<SequenceResult> {
  const cfg = readTabRpa(slug);
  const seq = cfg.sequences[name];
  if (!seq) throw new Error(`"${name}" is not a sequence of ${slug}: ${Object.keys(cfg.sequences).join(", ") || "none saved yet (rpa_sequence_save)"}`);
  const wc = await liveContents(slug);
  const steps: SequenceResult["steps"] = [];
  const scope: Record<string, unknown> = { ...args };
  for (let i = 0; i < seq.steps.length; i++) {
    const st = seq.steps[i]!;
    try {
      if (st.waitFor) await waitForSelector(wc, substitute(st.waitFor, scope));
      const r = await runCommand(slug, st.command, st.value !== undefined ? substitute(st.value, scope) : undefined);
      // A read's result is in scope for the steps after it: {{<command>}}.
      if (r.result !== undefined) scope[st.command] = r.result;
      steps.push({ command: st.command, ...(r.result !== undefined ? { result: r.result } : {}) });
    } catch (err) {
      throw new Error(`sequence ${name} stopped at step ${i + 1} (${st.command}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { app: slug, sequence: name, ok: true, steps };
}

// ── The doors ────────────────────────────────────────────────────────────────

export function installRpaMapHandlers(): void {
  registerRelayHandler("rpa.commands", async (params) => {
    const slug = slugOf(params);
    const cfg = readTabRpa(slug);
    return { app: slug, live: panelIsLive(slug), commands: Object.values(cfg.commands), sequences: Object.values(cfg.sequences) };
  });
  registerRelayHandler("rpa.map", async (params) => {
    const slug = slugOf(params);
    const p = (params ?? {}) as Record<string, unknown>;
    const body = p.command && typeof p.command === "object" ? p.command : p;
    return { app: slug, mapped: await mapCommand(slug, body) };
  });
  registerRelayHandler("rpa.unmap", async (params) => {
    const slug = slugOf(params);
    const key = str(params, "key") || str(params, "command");
    await unmapCommand(slug, key);
    return { app: slug, unmapped: key };
  });
  registerRelayHandler("rpa.pick", async (params) => {
    const slug = slugOf(params);
    const picked = await pickOnTab(slug);
    return picked ? { app: slug, picked } : { app: slug, picked: null, cancelled: true };
  });
  registerRelayHandler("rpa.run", async (params) => {
    const slug = slugOf(params);
    const key = str(params, "command") || str(params, "key");
    if (!key) throw new Error("rpa.run needs { app, command }");
    const v = (params as Record<string, unknown>).value;
    return runCommand(slug, key, v === undefined || v === null ? undefined : String(v));
  });
  registerRelayHandler("rpa.sequenceSave", async (params) => {
    const slug = slugOf(params);
    const p = (params ?? {}) as Record<string, unknown>;
    const body = p.sequence && typeof p.sequence === "object" ? p.sequence : p;
    return { app: slug, saved: await saveSequence(slug, body) };
  });
  registerRelayHandler("rpa.sequenceRemove", async (params) => {
    const slug = slugOf(params);
    const name = str(params, "name") || str(params, "sequence");
    await removeSequence(slug, name);
    return { app: slug, removed: name };
  });
  registerRelayHandler("rpa.sequenceRun", async (params) => {
    const slug = slugOf(params);
    const name = str(params, "sequence") || str(params, "name");
    if (!name) throw new Error("rpa.sequenceRun needs { app, sequence }");
    const a = (params as Record<string, unknown>).args;
    return runSequence(slug, name, a && typeof a === "object" ? (a as Record<string, unknown>) : {});
  });
}
