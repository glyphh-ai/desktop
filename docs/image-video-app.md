# Glyphh Image + Glyphh Video — the production suite

*Branch: `image-video` (server, sdk, app; web joins at P6). Status doc — updated
as phases land. This is the build plan of record.*

## What we're building

Two workbench apps and the machinery under them — a HeyGen/Runway/Veo-class
production floor inside Glyphh, where image and video **production agents** do
the work, everything is **metered in credits**, and every output is **on-system
by default** (direct Glyphh Design alignment). The outputs feed the next app in
the chain: **Glyphh Marketing** (social ads engine) — so every render ships with
the renditions and metadata Marketing will need.

**Naming.** Working titles are the literal suite names — **Glyphh Image** and
**Glyphh Video** — matching Slides/Docs/Sheets/Drive/Design/Memory. Clever
alternates on the shelf if wanted: *Lens* (image), *Reel* / *Motion* (video).
Icons join the filled two-tone family: Image = amber (#f59e0b) photo mark,
Video = red (#ef4444) clapper/play mark.

## The requirements, verbatim → where they land

| Ask | Lands in |
|---|---|
| a) videos from text | P3 — t2v providers via media jobs |
| b) avatars from uploaded images | P2 — avatar assets + talking-head jobs |
| c) write a script, record a screen, store in R2 | P3 — scripts + desktopCapturer recording + presigned R2 upload |
| d) explainer videos and content | P3/P4 — projects + scene templates + render |
| e) voice from the user's voice (record a phrase → clone) | P2 — consent phrase recording + voice-clone provider |
| f) HeyGen feel + Glyphh Design alignment | P3 editor + P4 brand overlays (`--design-*` everywhere) |
| g) camera-setup templates | P3 — code-defined scene/camera template catalog |
| charge tokens for everything | P0 — every job priced off the model catalog rate card, usage-ledgered |
| agent tools + models to leverage | P5 — tool belt + builtin skills |
| web leg | P6 — /products page + Products dropdown |
| → Glyphh Marketing | P6 — output contract (renditions + tags) |

## Architecture (the Office pattern, plus jobs)

### Server — new `media` domain

**Migration 0012 (`@@PER_ORG_TEMPLATE@@`)** — three tables:

- `media_assets` — the library index. `id, org_id, kind
  (image|video|audio|voice|avatar|recording|script), file, title, mime,
  size_bytes, width, height, duration_ms, status (uploading|ready|failed),
  meta jsonb (prompt, model, seed, brand file, source refs), created_by,
  timestamps`. Bytes in R2 under `media/{orgId}/{kind}/{id}.{ext}`.
- `media_jobs` — async generation. `id, org_id, kind (t2i|i2i|t2v|i2v|avatar|
  tts|voice_clone|lipsync|render), status (queued|running|succeeded|failed),
  provider, model, params jsonb, credits_charged, asset_id (result),
  error, timestamps`. A server-side job loop polls providers; results land as
  assets. Jobs are the ONLY way generation happens — that's where metering
  bites.
- `media_projects` — the HeyGen document. `id, org_id, title, script (the
  teleprompter text), design_file (Glyphh Design ref), voice_id, avatar_id,
  template, scenes jsonb, status, render_asset_id, timestamps`. A scene:
  `{ template, text, avatarId?, mediaId? (screen recording / b-roll),
  durationMs?, overlays }`.

**Uploads — presigned, never base64.** Screen recordings are hundreds of MB:
`POST /api/media/upload-url` mints a presigned R2 PUT (the existing R2 creds
already sign); the client streams bytes browser→R2 direct; `POST
/api/media/finalize` verifies the object and writes the index row. Small
assets (avatars, voice samples) may still ride base64 for simplicity.

**Playback** — `GET /api/media/:id/bytes` streams with **Range support**
(video scrubbing needs it).

**Providers — a driver interface** (the hosting-driver pattern):
```
MediaDriver { kind(): JobKind[]; estimate(params): credits;
              submit(params): providerJobId; poll(id): status+resultUrl }
```
First drivers: **fal.ai** (Flux t2i, Kling/Minimax t2v+i2v, LivePortrait
lipsync — one key, broad coverage), **ElevenLabs** (voice clone + TTS),
**OpenAI images** (fallback t2i). Keys ride the existing write-only encrypted
provider-key store; **models enter the existing catalog with a new `modality`
field** (image|video|audio) so governance (org support-list → workspace allow
→ picker) and **pricing** ride the rails we already have. Rate card units:
per image, per second of video, per 1k TTS chars, per voice clone —
admin-priced, credit-attributed per model/service in the usage ledger,
402 when the org is dry. *Charge tokens for everything.*

**Voice cloning consent** — the clone flow REQUIRES the recorded consent
phrase ("I, <name>, authorize Glyphh to synthesize my voice") stored as the
`voice` asset's provenance. Own-voice only; the sample and consent live
together in R2.

**Render (P4)** — final compositing (avatar take + screen recording + brand
overlays + voiceover) is an ffmpeg job (`render` kind) in the server container
(ffmpeg added to the image; a dedicated worker container if it gets hot).
Brand overlays are generated FROM the project's Design file: lower thirds,
intro/outro cards, color grade — `--design-*` as video.

**Stator** — prompts, scripts, and titles embed on save (threads
`media:<id>`), one memory plane.

### SDK — `client.media` (+ CLI `media` family, full parity)

assets (list/get/bytes/uploadUrl/finalize/delete) · jobs (create/get/list) ·
projects (CRUD/render) · voices (clone/list/delete) · templates (list).

### Desktop

- **main/media.ts** — IPC over client.media; `desktopCapturer` source picker
  for screen recording; mic capture rides renderer `getUserMedia`.
- **wb-image.ts** — library grid (generations with prompt/model/cost metadata,
  pagination, kebab) + the CREATE bar: prompt, model picker (governed
  catalog), size/aspect chips, **brand toggle** (inject the org Design's
  palette/fonts into the prompt + params), variations/upscale on existing.
- **wb-video.ts** — library + the PROJECT EDITOR (the HeyGen feel):
  left = scene strip; center = player (Range-streamed) + record controls
  (screen via desktopCapturer, voice sample via mic, teleprompter overlay
  scrolling the script while recording); right rail = Script, Avatar,
  Voice, **Design** (pick the system), **Camera template** picker. Generate
  buttons show the CREDIT ESTIMATE before running.
- **Camera/scene templates** (code-defined, like doc-templates): talking-head
  center · picture-in-picture over screen · split explainer · full-screen
  b-roll + voiceover · social vertical 9:16 · square 1:1 · product close-up.
- Wiring: `gimage`/`gvideo` views, icons, dropdown entries, command center,
  rail, echo dispatch, TOOL_VIEWS, `__wbOpenImage/Video`, popout, open rule.

### Agent surface (P5)

Tools: `generate_image`, `edit_image` (variation/upscale), `generate_video`,
`create_avatar`, `clone_voice` (points at the consent flow, never silent),
`speak` (TTS), `list_media`, `read_media`, `create_video_project`,
`update_video_project`, `render_video`, `open_image`, `open_video`. Every
generation tool returns the CREDITS CHARGED in its result line.
Builtin skills: `create-image`, `create-video` — both teach: check
`list_designs` first, on-brand is the default; estimate before you spend;
project → scenes → render; scripts are teleprompter-shaped.

### The Marketing handoff (P6 contract)

Every render can emit **renditions** (16:9, 9:16, 1:1) + a `meta.marketing`
block (headline, cta, design file, duration, formats). Glyphh Marketing reads
the media library by this contract — nothing to migrate later.

### Web leg (P6)

`/products` gains the suite page (punk voice, no AI-words — see the memory);
Products dropdown grows the entry; mockups in CSS per the house style.

## Phases

- **P0 — Foundations**: 0012 migration; catalog `modality` + rate-card units;
  presigned upload + finalize + Range streaming; assets CRUD; credits
  plumbing + usage rows; tests.
- **P1 — Images**: fal/openai drivers; job loop; generate/edit endpoints;
  wb-image panel; wiring; image tools + skill.
- **P2 — Voice + Avatar**: consent recording flow; ElevenLabs clone + TTS;
  avatar assets (upload + talking-head job); mic capture.
- **P3 — Video**: t2v/i2v drivers; projects + scenes + camera templates;
  wb-video editor (script/teleprompter, record screen, pickers);
  screen-record capture → presigned upload.
- **P4 — Render**: ffmpeg compositing; brand overlays from Design; renditions.
- **P5 — Agent**: full tool belt, builtin skills, stator embedding, credit
  lines in tool results.
- **P6 — Marketing contract + web leg**: renditions/meta contract; products
  page; dropdown.

Ship order rationale: images are the shortest path to a metered generation
loop end-to-end (P0+P1 proves the whole spine); voice/avatar unlock the
HeyGen core; video rides on both; render last because everything before it
already delivers value.

## The Music Studio (Sounds grows up) — spec addendum 2026-08-17

The Sounds app becomes a MUSIC STUDIO with four views:

- **Library** — the existing sounds grid (music/sfx/speech).
- **Artists** — singer/band-member profiles: a NAME, a LOOK (avatar from the
  media library — generate_image or upload), and a VOICE (cloned from the
  user's own recording via the P2 consent flow, or picked/synthesized from
  scratch), plus a style line ("gravel-voiced blues shouter").
- **Songs** — the documents. A song = title + LYRICS + the generation PROMPT
  (editable — it's how you steer) + band slots: artists (one or more) +
  INSTRUMENTS (drums/guitar/bass/banjo/…, each with its own sound tweak line)
  + the current audio asset + LINEAGE (regenerate creates a child, the
  original stays). "Type of band" is an input; prompting a song style is the
  fast path.
- **Music Video** — assemble the final product: a song + imagery/video pulled
  from the library; renders through the P4 ffmpeg pipeline.

THE SONG PAGE (Apps → General shape, left/right):
- Left: Title, then LYRICS — tall (a real song fits), glowing purple
  underline treatment; below them the PROMPT that made the song, editable.
- Right: the sound editor — waveform (bars per selected interval, zoom,
  scroll), drag-select, CUT/COPY/PASTE at the playhead, undo, play/pause with
  a moving playhead. Client-side Web Audio; Save as New encodes WAV and lands
  a NEW asset + song version; REGENERATE re-runs the music model with the
  edited prompt+lyrics+band and creates a child song.
- Iteration is agent-first: the song tools let the agent evolve lyrics,
  prompt, band and regenerate from the conversation.

Data: migration 0013 — `music_artists` + `music_projects` (lineage via
parent_id). Regeneration rides the SAME metered /api/media/generate path.

## Standing rules for this build

- Branch `image-video` in every touched repo; merge to main per-phase only
  when green (virgin-DB server tests, sdk parity, app typecheck+build).
- Provider keys are server-side, write-only, governed — never in the client.
- Everything the user or agent generates costs credits from the SAME ledger
  the gateway uses; no free path.
- Design alignment is a default, not a feature flag: any generator that CAN
  take brand input reads the org's design system unless told otherwise.
