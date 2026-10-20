/**
 * streamed-panels-flag.ts — the STREAMED WEB PANELS flag (his order, 2026-10-04).
 *
 * On the web a URL app panel or the Browser tile can only be a page rendered
 * on a worker and streamed to this tab (panel-stream.ts). That is experimental
 * — slower, metered, and some sites refuse it — so it is OFF by default and
 * lives behind one preference, shared by web and desktop:
 *
 *   pref `streamedPanels` (boolean, default false)
 *
 * Turning it ON is a two-step: the switch shows an inline warning and only a
 * second click ("Turn on") persists. Turning it OFF is immediate. The step
 * machine below is pure (web/test/streamed-panels-flag.test.js); settings.ts
 * paints it and the workbench reads the pref to decide card vs stream.
 */

export const STREAMED_PANELS_PREF = "streamedPanels";

/** The warning shown before the flag goes on — verbatim, his text. */
export const STREAMED_PANELS_WARNING =
  "Streams a real browser from a worker to this page. Experimental: slower, costs more, and some sites block it. You can turn it off any time.";

/** The one-line "why" on the panel card when the flag is off. */
export const STREAMED_PANELS_OFF_WHY =
  "This panel would stream a real browser from a worker to this page — an experimental, metered feature that is off by default.";

/** DOM events the settings row and the panels talk over (one document). */
export const STREAMED_PANELS_CHANGED_EVENT = "glyphh:streamed-panels-changed";
export const OPEN_STREAMED_PANELS_SETTING_EVENT = "glyphh:open-streamed-panels-setting";

export type FlagStep = "off" | "confirming" | "on";
export type FlagAction = "toggle-on" | "toggle-off" | "confirm" | "cancel";

/** The next step for an action, and whether a value must be PERSISTED
 *  (`persist` absent = nothing to write: a cancelled or redundant move). */
export function nextFlagStep(step: FlagStep, action: FlagAction): { step: FlagStep; persist?: boolean } {
  switch (action) {
    case "toggle-on":
      // Never straight to on: the switch asks first.
      return step === "on" ? { step: "on" } : { step: "confirming" };
    case "confirm":
      return step === "confirming" ? { step: "on", persist: true } : { step };
    case "cancel":
      return step === "confirming" ? { step: "off" } : { step };
    case "toggle-off":
      // Off is immediate; leaving the warning persists nothing (it was never on).
      if (step === "on") return { step: "off", persist: false };
      return { step: "off" };
  }
}

/** What the switch shows for a step: checked only once the flag is really on. */
export function flagSwitchChecked(step: FlagStep): boolean { return step === "on"; }
/** The warning is visible only while the switch is asking. */
export function flagWarningShown(step: FlagStep): boolean { return step === "confirming"; }
