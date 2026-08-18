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

## What the agent authors — the LAYOUT + THEME engine (primary path)

Agents no longer hand-write slide HTML. They **slot structured content into
controlled layouts** and the engine (`@glyphh/sdk/slides`, mirrored to the web
surface) renders professional, on-brand HTML that still passes through the
structure lock. This is the enforcement of "the shell is code; the agent authors
only content" taken one level further — the agent authors only *typed content*.

- **`create_slides(name, title, slides, theme?, design?)`** — `slides` is an
  array of typed specs, one per slide: `[{ layout, …fields }]`. The tool
  validates each spec, renders it, resolves media, wraps it in the shell.
- **Layouts** (`SLIDE_LAYOUTS`, ~18): `title`, `section-divider`, `bullets`,
  `two-column`, `image-left`, `image-right`, `quote`, `big-stat`, `cards`,
  `comparison`, `timeline`, `agenda`, `chart` (self-contained SVG), `code`,
  `full-bleed-image`, `team`, `closing`, `blank` (raw-HTML escape hatch).
  `list_slide_layouts` returns each layout's required fields + a copyable sample.
- **Themes** (`SLIDE_THEMES`): `midnight` (the classic default), `paper`, `mono`,
  `editorial`, `neon`, `corporate`, `warm`, `ocean` — each a `:root` block of
  `--slide-*` vars every layout renders against. `list_slide_themes` lists them.
- **Design-system spine**: pass `design="<name>"` and the deck derives its palette
  + fonts from the org design system (`read_design` → `themeFromDesign`), so decks
  match the org's docs by construction.
- **Media slots**: a layout's `media`/`photo` field takes a media-library asset
  **id**; the renderer inlines the bytes as a data URI (decks stay self-contained).
- **Speaker notes**: `notes:"…"` on any spec → `data-notes` on the section →
  surfaced in the presenter's **speaker view** (press `S` while presenting).
- **`update_slides`** structural ops (`replace_slide`/`insert_slide`) take a
  content `spec` (or `{html}` for raw); the engine re-renders that one section.

### Escape hatch — raw `slides_html`

When no layout fits, pass `slides_html`: a sequence of
`<section class="slide">…</section>` blocks (the legacy contract):

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
