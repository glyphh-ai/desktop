/**
 * Skills section — export a Glyphh Skill for an external LLM (Claude / Gemini /
 * OpenAI) so it can drive Glyphh over the MCP relay. Promoted out of
 * Settings > General into its own page with a polished layout.
 *
 * There's no server round-trip here: the page is static (an explainer + three
 * export buttons), so loadSkills just clears stale status; initSkills wires the
 * buttons once.
 */

/** Called when the Skills section opens — clear any stale export status. */
export function loadSkills(): void {
  const status = document.getElementById("export-skill-status");
  if (status) { status.textContent = ""; status.style.color = "var(--text-3)"; }
}

/** Wire the export buttons + the "Settings › MCP" deep-link. Called once at init. */
export function initSkills(): void {
  const status = document.getElementById("export-skill-status");
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("[id^='export-skill-']"))) {
    const provider = btn.dataset.provider;
    if (!provider) continue;
    btn.addEventListener("click", async () => {
      if (status) { status.textContent = "Saving…"; status.style.color = "var(--text-3)"; }
      const res = await window.yo.exportGlyphhSkill(provider);
      if (!status) return;
      if (res.ok) {
        status.textContent = `✓ Saved to ${res.path}`;
        status.style.color = "var(--text-2)";
      } else if (res.error !== "Canceled") {
        status.textContent = `✗ ${res.error}`;
        status.style.color = "var(--danger)";
      } else {
        status.textContent = "";
      }
    });
  }
  // Deep-link to Settings › MCP by clicking the (hidden but live) nav sub-item,
  // avoiding a circular import of navigation's gotoSection.
  document.getElementById("skills-goto-mcp")?.addEventListener("click", () => {
    document.querySelector<HTMLButtonElement>('.help-nav-sub-item[data-section="settings"][data-sub="mcp"]')?.click();
  });
}
