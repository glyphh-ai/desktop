/**
 * Help overlay — combined docs + settings (layouts, panels, apps).
 * This is the orchestrator that re-exports the public API.
 */

export { openHelp, openSettings, isHelpOpen, loadActiveSection, initHelp, gotoSection } from "./navigation.js";
export { closeHelp } from "./shared.js";
export { TERMS_OF_USE, PRIVACY_POLICY, REFUND_POLICY } from "./docs.js";
