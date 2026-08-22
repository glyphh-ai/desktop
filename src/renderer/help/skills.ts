/**
 * Glyphh Skill export — teach an external LLM (Claude / Gemini / OpenAI) to
 * drive Glyphh over the cloud MCP endpoint. The buttons live on Settings › MCP
 * (no standalone Skills page).
 *
 * Two surfaces, one content (glyphh-skill-content.ts / its main-process twin):
 *   • desktop — the Electron bridge (export-glyphh-skill): Claude installs
 *     straight into ~/.claude/skills, the others open a save dialog.
 *   • web — no bridge (window.glyphh is a fabricate-anything Proxy, so the
 *     surface is checked, not the method): the same content downloads as a
 *     file via a Blob link instead.
 */

import { generateGlyphhSkill, type SkillProvider } from "./glyphh-skill-content.js";

function isWeb(): boolean {
  return !!(window as unknown as { __GLYPHH_WEB__?: boolean }).__GLYPHH_WEB__;
}

/** Web: download the skill as a file — no Electron, no save dialog. */
function downloadSkill(provider: SkillProvider): { ok: boolean; path?: string; error?: string } {
  try {
    const { filename, content } = generateGlyphhSkill(provider);
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { ok: true, path: filename };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Wire the export buttons. Called once at init. */
export function initSkills(): void {
  const status = document.getElementById("export-skill-status");
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("[id^='export-skill-']"))) {
    const provider = btn.dataset.provider;
    if (!provider) continue;
    btn.addEventListener("click", async () => {
      if (status) { status.textContent = "Saving…"; status.style.color = "var(--text-3)"; }
      const res = isWeb()
        ? downloadSkill(provider as SkillProvider)
        : await window.glyphh.exportGlyphhSkill(provider);
      if (!status) return;
      if (res.ok) {
        status.textContent = isWeb() ? `✓ Downloaded ${res.path}` : `✓ Saved to ${res.path}`;
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
