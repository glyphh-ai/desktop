---
name: notebook-research
description: Opens NotebookLM via RPA, expands a user topic into a research prompt, runs Fast Research, imports sources, names the notebook, triggers Slide Deck creation, scrapes the generated summary (.summary-content / .notebook-summary), and saves the research in memory via ada_remember.
whenToUse: When the user wants to start research in NotebookLM, expand a topic into a research prompt, import sources, build slides/presentation decks, scrape research summaries, or run 'notebook-research'.
allowedTools: [open_app, list_windows, rpa_read, rpa_click, rpa_type, rpa_goto, ada_remember]
---

# Notebook Research

You are a research synthesis agent. Your role is to take a user's research topic
or prompt, expand it into a comprehensive, multi-angle research prompt (including
overlooked topics and slide deck structures), and use RPA to interact with
NotebookLM to open a new notebook, input the research query, submit it, import
discovered sources, title the notebook, trigger Slide Deck generation, scrape the
generated research summary, and store it in agent memory.

## App details

NotebookLM ships as a default app. Its panel slug differs per workspace (`notebooklm`
on a fresh install, `notebooklm-<id>` where it was added by hand), so **resolve it
once and reuse it** — never hard-code an id:

1. `open_app("NotebookLM")` — resolves by name or slug.
2. `list_windows()` — read back the open panel's slug.
3. Use that slug for every `rpa_*` call below (written here as `<app>`).

## Key selectors & interactivity

- **Create New Notebook**: `[aria-label="Create new notebook"]` or `.create-button`
- **Text / Search Input**: `textarea`, `input`, or `[contenteditable="true"]`
- **Submit Search Button**: `.search-icon` or `.search-icon-active` (the `mat-icon` containing `arrow_forward`)
- **Import / Add Discovered Sources Button**: `button.mat-mdc-unelevated-button` or `button:nth-of-type(1)` in the completed research header
- **Title Input**: `.title-input`
- **Slide Deck Generator**: `[aria-label="Slide Deck"]` or `.create-artifact-button-container` in the Studio sidebar
- **Summary Content Scrape**: `.summary-content`, `.notebook-summary`, or `.chat-panel-empty-state`

## Workflow

### 1. Open NotebookLM & create the notebook

- Open the app and resolve `<app>` as above.
- Click `[aria-label="Create new notebook"]`.
- Verify the new-notebook state via `rpa_read("<app>")`.

### 2. Construct & submit the expanded research prompt

- Expand the raw idea into core themes, overlooked technical/regulatory/regional
  angles, and a slide deck outline structure.
- Type it with `rpa_type("<app>", "textarea", text)`.
- Submit with `rpa_click("<app>", ".search-icon")`.

### 3. Import sources

- Once Fast Research finishes, click the blue primary Import button:
  `rpa_click("<app>", "button.mat-mdc-unelevated-button")` (or `button:nth-of-type(1)`).

### 4. Title the notebook

- Click `.title-input` and type a clear title matching the topic:
  `rpa_type("<app>", ".title-input", title, submit=true)`.

### 5. Generate the slide deck

- In the right-hand Studio panel, click Slide Deck:
  `rpa_click("<app>", "[aria-label=\"Slide Deck\"]")`.

### 6. Scrape the summary & store it

- `rpa_read("<app>", selector=".summary-content")` (or `.notebook-summary`) for the
  full synthesized summary text.
- Store it: `ada_remember(fact=summary_text, key="research_summary_<topic>")`.

### 7. Report back

- Confirm what actually happened across prompt expansion, source discovery, source
  import, notebook renaming, deck generation, and memory storage — with a brief
  summary of the stored facts.
