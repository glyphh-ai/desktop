/**
 * panel/input.ts — the PURE client-input → CDP-command mapping.
 *
 * The browser panel takes raw input events off the WS (mouse/key/wheel/resize)
 * and dispatches them into the streamed page's real browser via CDP. This module
 * holds the pure, side-effect-free translation: `InputEvent` (the wire shape the
 * app-web canvas sends) → a `CdpCommand` (`method` + `params`) the panel source
 * feeds to the debugger. Keeping it pure makes it unit-
 * testable with no browser (the input tests fake nothing — they assert the
 * mapping), and keeps the coordinate/modifier/keycode conventions in ONE place.
 *
 * The wire event vocabulary (client → server), all coordinates in CSS px in the
 * panel's own viewport space (the client scales canvas→viewport before sending):
 *
 *   { type:"mouse", action:"move"|"down"|"up", x, y, button?, buttons?, mods? }
 *   { type:"wheel", x, y, dx, dy, mods? }
 *   { type:"key",   action:"down"|"up",       key, code?, text?, mods? }
 *   { type:"resize", width, height }
 *
 * `mods` is the CDP modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8); the client
 * assembles it from the DOM event. Buttons follow the CDP naming
 * ("none"|"left"|"middle"|"right"|"back"|"forward").
 *
 * `resize` maps to `Emulation.setDeviceMetricsOverride` (device-metric emulation,
 * NOT a real window resize — headless has no window) plus a screencast restart is
 * the session's job; here we only produce the metrics command.
 */

/** CDP mouse button names (`Input.dispatchMouseEvent.button`). */
export type MouseButton = "none" | "left" | "middle" | "right" | "back" | "forward";

/** The client→server input wire vocabulary. */
export type InputEvent =
  | { type: "mouse"; action: "move" | "down" | "up"; x: number; y: number; button?: MouseButton; buttons?: number; mods?: number; clickCount?: number }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number; mods?: number }
  | { type: "key"; action: "down" | "up"; key?: string; code?: string; text?: string; mods?: number }
  | { type: "resize"; width: number; height: number };

/** A CDP command: the `method` and its `params`, ready for `CDPSession.send`. */
export interface CdpCommand {
  method: string;
  params: Record<string, unknown>;
}

const MOUSE_TYPE: Record<"move" | "down" | "up", string> = {
  move: "mouseMoved",
  down: "mousePressed",
  up: "mouseReleased",
};

const KEY_TYPE: Record<"down" | "up", string> = { down: "keyDown", up: "keyUp" };

const VALID_BUTTONS: ReadonlySet<string> = new Set(["none", "left", "middle", "right", "back", "forward"]);

/** Clamp a coordinate to a finite non-negative integer (defends against NaN/negatives from the wire). */
function coord(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/** Coerce the CDP modifier bitmask to the 0–15 range. */
function mods(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n & 0b1111 : 0;
}

function button(v: unknown): MouseButton {
  return typeof v === "string" && VALID_BUTTONS.has(v) ? (v as MouseButton) : "none";
}

