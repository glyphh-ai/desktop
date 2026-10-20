/**
 * Help overlay — combined docs + settings (layouts, panels, apps).
 * This is the orchestrator that re-exports the public API.
 */

export { openHelp, openSettings, isHelpOpen, loadActiveSection, initHelp, gotoSection, openSettingsModal, closeSettingsModal, isSettingsModalOpen } from "./navigation.js";
export { closeHelp } from "./shared.js";
