/**
 * panel-source.ts — the SOURCE-AGNOSTIC contract a streamed panel is rendered
 * against.
 *
 * A streamed panel is "a page rendered somewhere the browser can't reach,
 * relayed to a web canvas + driven by the canvas's input". WHERE that page lives
 * is deliberately behind this interface so the exact same web component
 * (panel-stream.ts) and the exact same server relay (/ws/panel) carry it no
 * matter the origin:
 *
 *   • DESKTOP (shipping today) — the user's own attached machine. A real,
 *     off-screen Electron BrowserView renders the app with the user's logged-in
 *     cookies; frames come off Chromium's built-in CDP screencast. See
 *     {@link ElectronPanelSource} in panel-host.ts.
 *
 *   • SESSION POD (later) — a Fly/K8s pod running a headless browser (rrotor's
 *     panel-pod). It already speaks the identical panel.open / panel.input /
 *     panel.close surface and emits the identical `frame`/`nav` push shapes; a
 *     PodPanelSource would implement THIS interface by driving the pod's CDP
 *     over the pod's control channel instead of a local BrowserView. The relay,
 *     the wire frames, and the web component do not change — only the class that
 *     satisfies PanelSource does. That is the whole point of naming the seam.
 *
 * The manager (panel-host.ts) owns the panel registry, the relay-method
 * registration (panel.open/input/close/stats), and the push-sink plumbing; a
 * PanelSource owns only the four verbs below for ONE panel. To add a pod source
 * later: implement PanelSource for the pod, and give the manager a factory that
 * returns a PodPanelSource when the target is a pod rather than the local
 * machine (see `createPanelSource` in panel-host.ts — that is the one call site
 * a pod plugs into).
 */

import type { InputEvent } from "./panel-input.js";

/** A relayed panel frame (base64 JPEG today; a WebRTC source emits none — media
 *  rides the peer connection and only `nav`/`transport` control frames flow). */
export interface PanelFrame {
  type: "frame";
  /** base64-encoded JPEG (no data: prefix). */
  data: string;
  format: "jpeg";
  meta: { deviceWidth: number; deviceHeight: number };
  /** epoch ms the frame was produced, for the client's latency readout. */
  at: number;
}

/** A top-level navigation the client's address bar tracks. */
export interface PanelNav {
  type: "nav";
  url: string;
  title: string;
}

/** Anything a source pushes down the panel's channel to the web client. Phase 2
 *  adds `offer`/`ice`/`transport` here (see panel-webrtc.ts); the union stays
 *  open so a source can emit control frames the JPEG path never needed. */
export type PanelPush = PanelFrame | PanelNav | Record<string, unknown>;

/** How a source hands frames/nav/control up to the manager, which relays them on
 *  the panel's channel. Kept as a plain callback (not an EventEmitter) so a pod
 *  source is a thin adapter over its control channel. */
export type PanelSink = (data: PanelPush) => void;

/** Opening parameters, normalized by the manager before the source sees them. */
export interface PanelOpenOptions {
  url: string;
  width: number;
  height: number;
  /** JPEG quality 1–100 (screencast path). */
  quality: number;
}

/** Live counters for the client's stats readout + logs. */
export interface PanelSourceStats {
  frames: number;
  bytes: number;
  uptimeMs: number;
}

/**
 * ONE streamed panel, from ONE origin. Implementations: {@link ElectronPanelSource}
 * (desktop, shipping) and a future PodPanelSource (session pod). Every method is
 * async-tolerant and MUST NOT throw across teardown — a closed panel that gets a
 * late input event drops it, it does not crash the manager.
 */
export interface PanelSource {
  readonly id: string;

  /** Begin rendering + streaming. Resolves once the page has committed a
   *  navigation and the frame stream is armed. Frames arrive via the sink passed
   *  to the factory. */
  open(opts: PanelOpenOptions): Promise<void>;

  /** Replay ONE input event (mouse/key/wheel) into the rendered page. */
  input(ev: InputEvent): Promise<void>;

  /** Re-size the rendered surface + restart the stream at the new dimensions. */
  resize(width: number, height: number): Promise<void>;

  /** Tear everything down. Idempotent, never throws. */
  close(): Promise<void> | void;

  /** Current counters. */
  stats(): PanelSourceStats;

  /** The current render dimensions in CSS px — phase 2's encoder scales to them. */
  viewport(): { width: number; height: number };
}
