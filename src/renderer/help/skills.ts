/**
 * Glyphh Skill export — teach an external LLM (Claude / Gemini / OpenAI) to
 * drive Glyphh over the MCP relay. The buttons live on Settings › MCP (no
 * standalone Skills page); Claude installs straight into ~/.claude/skills,
 * the others save a file to paste into custom instructions.
 */

/** Wire the export buttons. Called once at init. */
export function initSkills(): void {
  const status = document.getElementById("export-skill-status");
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("[id^='export-skill-']"))) {
    const provider = btn.dataset.provider;
    if (!provider) continue;
    btn.addEventListener("click", async () => {
      if (status) { status.textContent = "Saving…"; status.style.color = "var(--text-3)"; }
      const res = await window.glyphh.exportGlyphhSkill(provider);
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
}
