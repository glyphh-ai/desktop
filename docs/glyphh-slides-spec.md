# Glyphh Slides — deck format spec

A **deck** is ONE self-contained HTML document in the org's Slides library
(R2 behind yo-server, addressed by a stable `<slug>.html` file name). Decks are
**agent-authored**: there is no editor anywhere — the panel reads, presents,
and performs per-slide surgery (hide/delete/rename); the agent tools write.

## The one rule

**The shell is code; the agent authors only slide content.**
`create_slides` / `update_slides` wrap and splice `<section class="slide">`
blocks into the canonical shell (`buildDeckDocument`, `src/main/gpoints.ts`).
Hand-rolled harnesses drift (JS `fit()` scaling breaks in embedded panels —
learned the hard way); the shell is the spec's enforcement.

## The canonical shell (what the tool provides)

- `#stage` — a fixed **1920×1080** canvas, centered and scaled by pure CSS:
  `transform: scale(min(calc(100vw/1920), calc(100vh/1080)))`. The browser's
  layout engine rescales in ANY embed — panel, popout, fullscreen — no JS.
- **Nav script** — the exact contract the Slides reader/presenter drive:
  `→` / Space / PageDown / Enter / click = next build step, `←` / PageUp /
  Backspace = back, Home / End (End reveals everything), `#sN` hash
  deep-links a slide with its frags revealed, and the hash tracks the
  current slide.
- `#prog` — a bottom progress bar (accent-colored).
- Base type: Inter/system stack, light-on-dark (`#0d0d0f` / `#f1f1f1`).

## What the agent authors (`slides_html`)

A sequence of `<section class="slide">…</section>` blocks:

- First section: `class="slide on"`. Ids `s1…sN` (recommended — per-slide CSS
  hooks like `#s3 .card { … }`).
- **Self-contained**: inline all styling (a `<style>` block inside the deck
  content is fine), no external fonts, images, or network fetches.
- **Build steps**: `class="frag"` starts hidden, reveals on advance; elements
  sharing a `data-step` value reveal as one group.
- **Hidden slides**: `data-gp-hidden="1"` on the section. The reader shows
  them dimmed with a badge; the presenter strips them before mounting.
- Design for the fixed canvas: 48–120px titles, generous spacing; the deck is
  readable at thumbnail scale in the reader rail.

## Storage & limits (server-enforced)

- Bytes: R2 `office/slides/{orgId}/{file}`; metadata: per-org `office_slides`.
- `PUT /api/office/slides/:file` validates the slide-section shape, caps a
  deck at **10 MB** and an org at **500 decks**. Create-by-name = overwrite.

## Surfaces

One panel module (`src/renderer/wb-gpoint.ts`) renders everywhere: workbench
rail slot, Echo card, web (`web-contract.js` → SDK), and the popped-out
window (`popout-slides.html`, real fullscreen presenting). SDK:
`client.officeSlides.{list,get,put,delete}`; CLI: `slides list|get|save|delete`.

## Agent surface (global, code-shipped, read-only)

`list_slides · read_slides · create_slides · update_slides · delete_slides ·
open_slides` — plus the built-in `create-slides` skill
(`server/src/domains/skills/builtins.ts`): served to every org, not
modifiable, updated for everyone on deploy. Legacy `*_gpoint` names resolve
via `RENAMED_TOOLS`.
