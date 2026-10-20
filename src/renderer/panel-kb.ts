/**
 * panel-kb.ts — the SHARED keyboard + clipboard capture for streamed panels.
 *
 * A streamed panel renders a REMOTE page (the attached desktop casts it — see
 * panel-stream.ts and web/src/mobile-panel.ts), so there is no local editable
 * for the browser to type into. This module provides one: a hidden, focusable
 * <textarea> proxy layered into the panel surface. Focusing IT is what makes a
 * phone raise its virtual keyboard, and what gives every browser a real
 * editable context for paste events and IME composition. What it captures
 * becomes the panel.input wire vocabulary (src/main/panel-input.ts):
 *
 *   · physical keys → {type:"key"} down/up. The KEY NAME crosses the wire and
 *     the desktop derives the virtual-key code, so Backspace/Enter/arrows work
 *     — a printable-only path drops every non-character key.
 *   · virtual-keyboard/IME text → {type:"insertText"} committed batches, read
 *     off beforeinput/composition (iOS keyboards often never fire real
 *     keydowns; autocorrect and swipe-typing NEVER do).
 *   · paste (Cmd/Ctrl+V, the iOS callout) → the LOCAL clipboard read off the
 *     native paste event, sent as {type:"insertText"} chunks. Forwarding the
 *     keystroke could only paste the DESKTOP's clipboard.
 *   · copy/cut (Cmd/Ctrl+C/X) → handed to the caller, which round-trips
 *     panel.clipboard and lands the far page's selection on the LOCAL
 *     clipboard.
 *
 * Framework-free and surface-agnostic: the web canvas (panel-stream.ts) and
 * the mobile tray (web/src/mobile-panel.ts) mount the same proxy. The decision
 * logic is pure and exported so the units are testable without a DOM.
 */

/** One captured key event in the panel.input wire shape. */
export interface KbKeyEvent {
  type: "key";
  action: "down" | "up";
  key: string;
  code: string;
  text: string;
  mods: number;
}

/** Where captured input goes — the mounting surface owns the relay send. */
export interface PanelKbSink {
  key(ev: KbKeyEvent): void;
  /** Committed text (IME/virtual keyboard/paste), pre-chunked to wire size. */
  insertText(text: string): void;
  /** Run copy|cut in the far page + land its text on the local clipboard. */
  clipboard(action: "copy" | "cut"): void;
}

export interface PanelKb {
  /** The hidden proxy element (already appended to the host). */
  readonly el: HTMLTextAreaElement;
  /** Focus the proxy — call from a user gesture so iOS raises its keyboard. */
  focus(): void;
  dispose(): void;
}

/** What one keydown should turn into. Pure — unit-tested without a DOM. */
export type KeyDecision =
  | { kind: "forward"; text: string } // preventDefault + send down (up follows on keyup)
  | { kind: "clipboard"; action: "copy" | "cut" } // preventDefault + round-trip
  | { kind: "paste" } // do NOT preventDefault — the native paste event carries the LOCAL clipboard
  | { kind: "ime" }; // composition / synthetic soft-keyboard noise — beforeinput is the source of truth

export function decideKeydown(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing?: boolean }): KeyDecision {
  // Soft keyboards report "Unidentified"/229 for keys they deliver via
  // beforeinput instead; forwarding those would be noise, dropping real text.
  if (e.isComposing || e.key === "Unidentified" || e.key === "Process" || e.key === "Dead") return { kind: "ime" };
  const shortcut = (e.metaKey || e.ctrlKey) && !e.altKey;
  const k = e.key.toLowerCase();
  if (shortcut && k === "v") return { kind: "paste" };
  if (shortcut && (k === "c" || k === "x")) return { kind: "clipboard", action: k === "c" ? "copy" : "cut" };
  // Printable keys carry their character; chords never do (Ctrl/Meta+letter is
  // a command, not typing — the desktop side also enforces this).
  const text = e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : "";
  return { kind: "forward", text };
}

/** What one beforeinput should turn into. Pure. `data` is the resolved payload
 *  (the caller reads dataTransfer for insertFromPaste). */
export type BeforeInputDecision =
  | { kind: "text"; text: string }
  | { kind: "key"; key: string; code: string }
  | { kind: "none" };

const INPUT_TYPE_KEY: Readonly<Record<string, { key: string; code: string }>> = {
  insertLineBreak: { key: "Enter", code: "Enter" },
  insertParagraph: { key: "Enter", code: "Enter" },
  deleteContentBackward: { key: "Backspace", code: "Backspace" },
  deleteContentForward: { key: "Delete", code: "Delete" },
};

export function decideBeforeinput(inputType: string, data: string, composing: boolean): BeforeInputDecision {
  // Mid-composition updates are provisional — compositionend commits the text.
  if (composing || inputType === "insertCompositionText") return { kind: "none" };
  if (inputType === "insertText" || inputType === "insertReplacementText" || inputType === "insertFromPaste") {
    return data ? { kind: "text", text: data } : { kind: "none" };
  }
  const key = INPUT_TYPE_KEY[inputType];
  return key ? { kind: "key", ...key } : { kind: "none" };
}

/** Split committed text into relay-frame-sized pieces (one giant paste must not
 *  become one giant WS frame). */
export function chunkText(text: string, max = 8192): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

/** The CDP modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8) off a DOM event. */
export function modBits(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** A zero-width sentinel kept in the proxy so a virtual keyboard's delete key
 *  always has something to delete — on an EMPTY field some soft keyboards fire
 *  neither keydown nor beforeinput for Backspace. Every default is prevented,
 *  so the sentinel is all the field ever holds outside composition. */
const SENTINEL = "\u200B";

/** Mount the hidden key proxy into a panel surface. */
export function mountPanelKb(host: HTMLElement, sink: PanelKbSink): PanelKb {
  const kb = document.createElement("textarea");
  kb.className = "panel-kb-proxy";
  kb.setAttribute("aria-hidden", "true");
  kb.setAttribute("autocapitalize", "none");
  kb.setAttribute("autocomplete", "off");
  kb.setAttribute("autocorrect", "off");
  kb.spellcheck = false;
  kb.tabIndex = -1;
  // Invisible but real: 1px, transparent, no pointer targets. font-size 16px
  // stops iOS from zooming the viewport onto a focused small-text field.
  kb.style.cssText =
    "position:absolute;top:0;left:0;width:1px;height:1px;padding:0;border:0;margin:0;opacity:0;" +
    "pointer-events:none;resize:none;overflow:hidden;font-size:16px;background:transparent;color:transparent;caret-color:transparent;";
  host.appendChild(kb);

  let composing = false;
  const reseed = (): void => {
    kb.value = SENTINEL;
    try { kb.setSelectionRange(SENTINEL.length, SENTINEL.length); } catch { /* not focused yet */ }
  };

  kb.addEventListener("focus", reseed);

  kb.addEventListener("keydown", (e) => {
    const d = decideKeydown(e);
    if (d.kind === "ime") return;
    if (d.kind === "paste") return; // the native paste event follows with the LOCAL clipboard
    e.preventDefault();
    if (d.kind === "clipboard") { sink.clipboard(d.action); return; }
    sink.key({ type: "key", action: "down", key: e.key, code: e.code, text: d.text, mods: modBits(e) });
  });
  kb.addEventListener("keyup", (e) => {
    const d = decideKeydown(e);
    if (d.kind !== "forward") return; // pastes/clipboard chords/IME never sent a down
    e.preventDefault();
    sink.key({ type: "key", action: "up", key: e.key, code: e.code, text: "", mods: modBits(e) });
  });

  // The virtual-keyboard/IME path: keys the soft keyboard never surfaced as
  // keydowns arrive here as input intents against the (sentinel-only) proxy.
  kb.addEventListener("beforeinput", (e) => {
    const ie = e as InputEvent;
    const data = ie.inputType === "insertFromPaste"
      ? ie.dataTransfer?.getData("text/plain") || ie.data || ""
      : ie.data ?? "";
    const d = decideBeforeinput(ie.inputType, data, composing || ie.isComposing === true);
    if (d.kind === "none") return;
    e.preventDefault();
    if (d.kind === "text") {
      for (const part of chunkText(d.text)) sink.insertText(part);
      return;
    }
    sink.key({ type: "key", action: "down", key: d.key, code: d.code, text: "", mods: 0 });
    sink.key({ type: "key", action: "up", key: d.key, code: d.code, text: "", mods: 0 });
  });

  kb.addEventListener("compositionstart", () => { composing = true; });
  kb.addEventListener("compositionend", (e) => {
    composing = false;
    const text = (e as CompositionEvent).data || "";
    if (text) for (const part of chunkText(text)) sink.insertText(part);
    reseed(); // drop the accumulated composition — the far page has the text now
  });

  // Paste — from a keyboard chord OR the platform's own UI (iOS callout, menu).
  // preventDefault here also stops the insertFromPaste beforeinput, so the text
  // is sent exactly once whichever event a browser fires first.
  kb.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text) for (const part of chunkText(text)) sink.insertText(part);
  });

  return {
    el: kb,
    focus: () => { kb.focus({ preventScroll: true }); },
    dispose: () => { kb.remove(); },
  };
}
