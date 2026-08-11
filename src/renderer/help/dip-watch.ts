/**
 * dip-watch.ts — TYPE `.dip` anywhere and the drip picker opens.
 *
 * A document-level keystroke watcher (wired once from navigation's help init,
 * beside wireGlobalDotCommands): it tracks the last few typed characters and,
 * the moment they spell the exact `.dip` sequence, opens the drips surface —
 * from the agent input (#code-input), any other input/textarea, or outside
 * inputs entirely. Typed inside a field, the `.dip` text is REMOVED from the
 * field so it never pollutes the message.
 *
 * It cannot fire mid-word: the character before the `.` must be a boundary
 * (start of the buffer/field or whitespace), so "file.dip" or "voip.dipsw"
 * never trigger it. Esc closes the pop as usual (the pop owns that).
 *
 * The opener is `window.__glyphhOpenDrips`, published where the Echo topbar
 * builds the pop. If the command centre isn't up yet the watcher raises it
 * first and retries briefly for the hook.
 */

import { openCommandCenter } from "./code.js";

const SEQ = ".dip";

/** Open the drips surface — directly when the pop's opener is live, else by
 *  raising the command centre first and waiting a few frames for it. */
function openDrips(tries = 0): void {
  const w = window as unknown as { __glyphhOpenDrips?: () => void };
  if (w.__glyphhOpenDrips) { w.__glyphhOpenDrips(); return; }
  if (tries === 0) openCommandCenter();
  if (tries < 40) requestAnimationFrame(() => openDrips(tries + 1));
}

/** True when `text` ends with `.dip` at a word boundary (start or whitespace
 *  right before the dot). */
function endsWithDip(text: string): boolean {
  if (!text.toLowerCase().endsWith(SEQ)) return false;
  const before = text[text.length - SEQ.length - 1];
  return before === undefined || /\s/.test(before);
}

function isEditable(t: unknown): t is HTMLInputElement | HTMLTextAreaElement {
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLInputElement) {
    // selectionStart only exists on text-like inputs (checkboxes etc. throw);
    // passwords stay out — no surprise surface while typing a secret.
    return /^(text|search|url|tel|email|)$/i.test(t.type || "text");
  }
  return false;
}

export function wireDipWatcher(): void {
  // ── Inside inputs/textareas: watch the text at the caret on every input
  // event (fires after the field's value updated). The open is DEBOUNCED:
  // `.dip <app-or-layout>` is also a real composer command, and the instant
  // form ate the sequence before an argument could be typed. The picker now
  // opens only when the user PAUSES on a bare `.dip`; any further keystroke
  // (they're typing the argument) cancels the pending open, and Enter runs
  // the command path as usual. ──
  let pendingOpen: number | null = null;
  const cancelPending = (): void => {
    if (pendingOpen !== null) { clearTimeout(pendingOpen); pendingOpen = null; }
  };
  document.addEventListener("input", (ev) => {
    if ((ev as InputEvent).isComposing) return;   // never strip mid-IME-composition
    const t = ev.target;
    if (!isEditable(t)) return;
    cancelPending();                              // still typing — not a pause
    const caret = t.selectionStart;
    if (caret == null || caret < SEQ.length) return;
    const before = t.value.slice(0, caret);
    if (!endsWithDip(before)) return;
    pendingOpen = window.setTimeout(() => {
      pendingOpen = null;
      // Re-check at fire time: the field must STILL end in the bare sequence
      // (the user may have sent, cleared, or moved on during the pause).
      const c = t.selectionStart;
      if (c == null || c < SEQ.length || !endsWithDip(t.value.slice(0, c))) return;
      // Remove the typed ".dip" so it doesn't pollute the message.
      t.value = t.value.slice(0, c - SEQ.length) + t.value.slice(c);
      const pos = c - SEQ.length;
      try { t.setSelectionRange(pos, pos); } catch { /* non-text input */ }
      // The field's own listeners (composer autoGrow, live search) must see
      // the change; this synthetic event re-enters this handler but the value
      // no longer ends in ".dip", so it passes straight through.
      t.dispatchEvent(new Event("input", { bubbles: true }));
      openDrips();
    }, 600);
  }, true);
  // Enter/Esc/blur while a bare-`.dip` pause is pending: the user is sending
  // the command (or leaving) — never fight the command path for the text.
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === "Escape") cancelPending();
  }, true);
  document.addEventListener("focusout", cancelPending, true);

  // ── Outside inputs: a rolling buffer of the last few printable keys. Any
  // non-printable key or a click breaks the sequence. ──
  let buf = "";
  document.addEventListener("keydown", (ev) => {
    if (isEditable(ev.target)) return;              // fields are the input path
    if ((ev.target as HTMLElement | null)?.isContentEditable) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) { buf = ""; return; }
    if (ev.key.length !== 1) { buf = ""; return; }  // Esc/Enter/arrows break it
    buf = (buf + ev.key).slice(-8);
    if (endsWithDip(buf)) {
      buf = "";
      openDrips();
    }
  }, true);
  document.addEventListener("mousedown", () => { buf = ""; }, true);
}
