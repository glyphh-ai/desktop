/**
 * starter-skills — the skills a starter card needs in order to work.
 *
 * A card that seeds "/notebook-research " is a broken promise unless that
 * skill is in the caller's library: the slash-ref resolver reads the SERVER
 * library, and nothing ships `desktop/skills/` into it (that directory is
 * repo documentation — it isn't even packaged). So the starter seeds its own
 * skill on first use, the same self-healing contract as the starter layouts
 * and the NotebookLM app.
 *
 * This module is the ONE source: skills live in the server DB (the `skills`
 * table), and this is what gets written there. There is deliberately no
 * SKILL.md twin in the repo — nothing reads it, nothing packages it, and a
 * second copy only drifts.
 */

export interface StarterSkill {
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  allowedTools: string[];
  prompt: string;
}

export const NOTEBOOK_RESEARCH: StarterSkill = {
  slug: "notebook-research",
  name: "Notebook Research",
  description:
    "Opens NotebookLM via RPA, expands a user topic into a research prompt, runs Fast Research, " +
    "imports sources, names the notebook, triggers Slide Deck creation, scrapes the generated " +
    "summary (.summary-content / .notebook-summary), and saves the research in memory via ada_remember.",
  whenToUse:
    "When the user wants to start research in NotebookLM, expand a topic into a research prompt, " +
    "import sources, build slides/presentation decks, scrape research summaries, or run 'notebook-research'.",
  allowedTools: ["open_app", "list_windows", "rpa_read", "rpa_click", "rpa_type", "rpa_goto", "ada_remember"],
  prompt: `# Notebook Research

You are a research synthesis agent. Your role is to take a user's research topic or prompt, expand it into a comprehensive, multi-angle research prompt (including overlooked topics and slide deck structures), and use RPA to interact with NotebookLM to open a new notebook, input the research query, submit it, import discovered sources, title the notebook, trigger Slide Deck generation, scrape the generated research summary, and store it in agent memory.

## App details

NotebookLM ships as a default app, but its panel slug differs per workspace (\`notebooklm\` on a fresh install, \`notebooklm-<id>\` where it was added by hand). Resolve it ONCE and reuse it — never hard-code an id:

1. \`open_app("NotebookLM")\` — resolves by name or slug.
2. \`list_windows()\` — read back the open panel's slug.
3. Use that slug for every \`rpa_*\` call below (written here as \`<app>\`).

## Key Selectors & Interactivity

- **Create New Notebook**: \`[aria-label="Create new notebook"]\` or \`.create-button\`
- **Text / Search Input**: \`textarea\`, \`input\`, or \`[contenteditable="true"]\`
- **Submit Search Button**: \`.search-icon\` or \`.search-icon-active\` (the \`mat-icon\` containing \`arrow_forward\`)
- **Import / Add Discovered Sources Button**: \`button.mat-mdc-unelevated-button\` or \`button:nth-of-type(1)\` in the completed research header
- **Title Input**: \`.title-input\`
- **Slide Deck Generator**: \`[aria-label="Slide Deck"]\` or \`.create-artifact-button-container\` in Studio sidebar
- **Summary Content Scrape**: \`.summary-content\`, \`.notebook-summary\`, or \`.chat-panel-empty-state\`

## Workflow

### 1. Open NotebookLM & Create Notebook
- Open the app and resolve \`<app>\` as above.
- Click \`[aria-label="Create new notebook"]\`.
- Verify new notebook state via \`rpa_read("<app>")\`.

### 2. Construct & Submit Expanded Research Prompt
- Expand raw idea into core themes, overlooked technical/regulatory/regional angles, and slide deck outline structure.
- Type into \`textarea\` using \`rpa_type("<app>", "textarea", text)\`.
- Submit by clicking \`.search-icon\` using \`rpa_click("<app>", ".search-icon")\`.

### 3. Import Sources
- Once Fast Research finishes, click the blue primary Import button using \`rpa_click("<app>", "button.mat-mdc-unelevated-button")\` (or \`button:nth-of-type(1)\`).

### 4. Title Notebook
- Click \`.title-input\` and type a clear title matching the research topic using \`rpa_type("<app>", ".title-input", title, submit=true)\`.

### 5. Generate Slide Deck
- In the right-side Studio panel, click Slide Deck using \`rpa_click("<app>", "[aria-label=\\"Slide Deck\\"]")\` to trigger presentation generation.

### 6. Scrape Summary Content & Store in Memory
- Use \`rpa_read("<app>", selector=".summary-content")\` (or \`.notebook-summary\`) to extract the full synthesized summary text.
- Store the scraped research text into Ada memory using \`ada_remember(fact=summary_text, key="research_summary_<topic>")\`.

### 7. Respond to User
- Confirm complete execution across prompt expansion, source discovery, source import, notebook renaming, presentation generation, and memory storage with a brief summary of the stored facts.`,
};

/**
 * Ensure a starter's skill is in the library. Answers whether the slash-ref
 * will resolve — a card seeds `/slug ` only when it will, and plain English
 * when it won't, so a starter never leaves a dead reference in the composer.
 */
export async function ensureStarterSkill(skill: StarterSkill): Promise<boolean> {
  try {
    const listed = await window.yo.librarySkillsList?.();
    const rows = (listed?.ok ? listed.data : []) as Array<{ slug?: string }> | undefined;
    if (Array.isArray(rows) && rows.some((r) => (r.slug || "").toLowerCase() === skill.slug)) return true;
    const made = await window.yo.librarySkillCreate?.({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      prompt: skill.prompt,
      manifest: { whenToUse: skill.whenToUse, allowedTools: skill.allowedTools },
    });
    return !!made?.ok;
  } catch {
    return false;
  }
}

/** Is this skill already in the library? (For skills we reference but don't
 *  ship a body for — the card falls back to plain English when it isn't.) */
export async function hasSkill(slug: string): Promise<boolean> {
  try {
    const listed = await window.yo.librarySkillsList?.();
    const rows = (listed?.ok ? listed.data : []) as Array<{ slug?: string }> | undefined;
    return Array.isArray(rows) && rows.some((r) => (r.slug || "").toLowerCase() === slug.toLowerCase());
  } catch {
    return false;
  }
}
