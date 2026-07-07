# Local Coder Model — Evaluation & Direction

**Status:** Draft · decisions recorded 2026-07-06
**Related:** [GLYPHH-APP-SPEC.md](./GLYPHH-APP-SPEC.md) (the output contract), [THE-PIVOT-BYOK.md](./THE-PIVOT-BYOK.md)

---

## 1. What we're building

A **free, local, coder-level model** bundled in the Glyphh runtime, fine-tuned to
build Glyphh apps (one-page apps to *our* spec), driven by a Glyphh agent loop.

Not a frontier model — **free, local, private, offline.** The positioning is honest:
*"is it a frontier model? no. but it is free as fuck."* It competes with **"nothing"**
and **"expensive"** on the free/local axis, not with Claude on capability.

Two things make it more than "yet another local coding agent":

1. **The relay makes what it builds publishable.** Every open local coding agent
   (Aider, Cline, Continue, OpenHands) is a dead-end island — what it builds can't
   leave the machine. Glyphh already has the OAuth-gated relay: the free local model
   is the **builder**, the relay is the **distribution**. It builds an app for zero
   tokens → that app is instantly a callable MCP endpoint any LLM/teammate/cron can hit.
2. **Zero-token daily assistant + automation builder.** The value lives in the
   deterministic capabilities and connectors (which cost zero tokens — they're API/DOM
   calls). The local model is the tiny **router** that dispatches to them, not the thing
   doing the work. That's *why* "zero tokens" holds.

---

## 2. The thesis — why a small model can work

- **Harness > model for bounded/templated tasks.** A big chunk of what makes agentic
  coding tools feel smart is the loop (plan → act → run → read error → repair → retry),
  not raw model IQ. A 7B–14B that's wrong on the first pass but sitting in a
  verify-repair loop produces code that *passes*. The model doesn't have to be right;
  it has to be right *eventually, with feedback.* **The loop is the moat; the model is
  a swappable commodity underneath it.**
- **Narrow, templated target → smallest viable base wins.** We're not building a
  SWE-bench competitor. "Emit a Glyphh app to our spec" is low-entropy, templated
  generation. Model size past a threshold becomes a *liability* — we re-tune as the spec
  evolves (cheap iteration compounds), it has to run free on the user's CPU, and the
  **dataset + loop**, not raw IQ, is what makes it good at *our* task.
- **Fine-tuning co-designs model to harness + spec.** A stock Qwen is good at coding in
  general; a Glyphh-tuned one is good at coding *through our loop, in our structure*.
  The **dataset is the moat; the base is a commodity.**

---

## 3. Runtime reality — what already ships

The hardest, ugliest part of local inference in Electron — **native binaries, per
platform, code-signed and packaged** — is already solved:

- `onnxruntime-node` + `@huggingface/transformers` (Transformers.js) are bundled,
  asar-unpacked, cross-platform ([glyphh-app-ai.ts](../src/main/glyphh-app-ai.ts)),
  wired **for embeddings today** (`llm.embed` / `llm.chunk`).
- The runtime is wired for **feature-extraction, not text generation** — that's the gap,
  not the packaging.

Two serving paths:

| Path | Engine | Ships new native dep? | Realistic model size (CPU) |
|------|--------|----------------------|---------------------------|
| **A** | Transformers.js text-gen on the existing ONNX runtime | **No** | ≤ ~4B |
| **B** | `node-llama-cpp` (GGUF) | Yes (but packaging muscle exists) | 7B–14B at usable CPU speed |

---

## 4. Model landscape (July 2026)

Key findings from the current landscape:

- **There is still no small *current-gen* coder.** The 3.x coders start at 27B. The
  smallest strong coder in the whole lineup is **Qwen2.5-Coder** (7B/14B/32B) — and it's
  the **only** current family with native **FIM** (fill-in-middle); the 3.x families
  dropped it.
- **The 3.x coders** (Qwen3.6-27B dense, Qwen3.5/3.6-35B-A3B MoE, Qwen3-Coder-Next
  80B-A3B) are **agentic + tool-calling + Apache 2.0**, but big and FIM-less.
- **Licenses fall our way.** The entire Qwen line is **Apache 2.0** — clean for
  commercial use *and* eventual open-sourcing. (Even Mistral's coder went Apache 2.0 as
  Devstral 2, but at 123B it's server-only.) Everything server-class (GLM 5.2, Kimi K2.7,
  DeepSeek V4 Pro/Flash, Nemotron) is irrelevant for a local-first product.

| Model | Params (active) | License | Q4 size | FIM | Agentic | CPU-local? |
|-------|-----------------|---------|---------|-----|---------|-----------|
| Qwen2.5-Coder-7B | 7B | Apache 2.0 | ~5GB | ✅ | ⚠️ older-gen | ✅ any 16GB |
| **Qwen2.5-Coder-14B** | 14B | Apache 2.0 | ~9GB | ✅ | ⚠️ | ✅ 16GB+ |
| Qwen2.5-Coder-32B | 32B | Apache 2.0 | ~20GB | ✅ | ⚠️ | ⚠️ 32GB RAM |
| Qwen3.5-4B | 4B | Apache 2.0 | ~3.4GB | ❌ | ⚠️ | ✅ runs on current ONNX runtime |
| Qwen3.5/3.6-35B-A3B | 35B (3B) | Apache 2.0 | ~20GB | ❌ | ✅ native | ⚠️ 64GB RAM (MoE) |
| Qwen3-Coder-Next | 80B (3B) | Apache 2.0 | ~38GB | ❌ | ✅ native | ❌ 48GB+ |

---

## 5. Decisions (recorded)

| Tier | Model | Why |
|------|-------|-----|
| **Default local train target** | **Qwen2.5-Coder-14B-Instruct** | Apache 2.0, ~9GB Q4 (stays local on a 16GB machine), native FIM, strong React/JS prior (89% HumanEval). Bumped from 7B for a stronger base under a narrow fine-tune. |
| **Low-end local fallback** | Qwen2.5-Coder-7B | ~5GB, runs anywhere; same recipe, weaker machines. |
| **Tiny / router tier** | Qwen3.5-4B | ~3.4GB; closest to running on the ONNX runtime we *already ship* (Path A). Router + trivial completion only. |
| **Server-hosted ceiling** (later) | Qwen3.5/3.6-35B-A3B | MoE, 3B active → CPU-viable with 64GB RAM or hosted GPU; native agentic/tool-calling. **Built out at a later date.** |

**Serving:** GGUF via `node-llama-cpp` (Path B) for 7B/14B; ONNX (Path A) for the 4B tier.

---

## 6. The training target — the spec (CONFIRMED)

**The spec already exists and is code-enforced.** The training target is
*"emit a `.glyphh` bundle,"* **not** *"emit a Next.js app."* Confirmed by a full
cross-repo audit:

- **The contract** ([GLYPHH-APP-SPEC.md](./GLYPHH-APP-SPEC.md) v2) is law — violated
  manifests are rejected at install; capability lists are enforced in the main process.
- **The bundle IS the code structure the model emits:** `manifest.json` +
  `index.html` (a **self-contained SPA — vanilla JS, no framework, no build step**) +
  optional `worker.js` (sandboxed handler SDK: `glyphh.handle()` / `glyphh.call()`).
- The data model backs it: `saved_apps.appArchetype` = `glyphh-app` +
  archetype-specific `launchConfig` ([saved-app-service.ts](../../yo-server/src/services/saved-app-service.ts)).

**The current app UI is vanilla self-contained HTML, NOT Next.js** — strict-CSP,
no-build, no-network, no-node. So "train on our Next.js apps spec" is a mismatch with
what exists. The decision:

- **(a) Target the existing vanilla `.glyphh` structure — RECOMMENDED.** It's what's
  code-enforced today, sandbox-safe, and *already installable + relay-callable*. And
  it's actively the **better** target for a *small* model: a single self-contained HTML
  file + one worker.js is **dramatically lower-entropy** than a Next.js project tree
  (no file graph, no build system, no framework boilerplate, no import resolution). The
  lower the structural entropy, the smaller the model that can nail it — which
  *strengthens* the free/local thesis.
- **(b) Introduce a new Next.js archetype** — only as a conscious departure. It **raises**
  the bar (multi-file tree + build step + framework idioms → a bigger model) for **zero
  runtime gain**, because the app sandbox can't run a Next.js build anyway. It would need
  its own hosting story (the `*.glyphh.app` app-proxy / `kind=mcp` path, not the bundled
  sandbox). Don't do this to "build one-page apps" — vanilla single-file *is* the
  one-page app, and it's cheaper.

**Recommendation: lock (a).** (`VIBE-SPEC.md` is the superseded "Vibe → Claude Code
builds" build-surface vision — not a basis to train on.)

---

## 7. Architecture — apps *are* agents, and the hostable loop

**An app and an agent are the same artifact, invoked differently.** A `.glyphh` bundle is
a **capability package**: a `worker.js` of tool-methods (handlers composed from the host
capability API) + a manifest declaring them. How it's used is orthogonal to what it is —
a **human** opens its UI, an **external LLM** calls its tools (`app_call_tool` over the
relay), or **the loop** drives its tools autonomously → that's an **agent**. The primitive
already exists: the spec's **`agent.run`** is "a real agentic loop: the model gets the
app's own manifest tools and drives them, multi-turn." Today it's per-app + BYOK. The work
is to **generalize it into a first-class, hostable loop.**

**The hostable loop is two-axis swappable:**
- **Model-swappable:** local 14B (free) → server 35B-A3B (metered) → BYOK frontier
  (ceiling). Same loop, swap the backend.
- **Location-swappable ("hostable"):** runs in the **client** (local model, local tools —
  *this is the free config*) **or** the **server** (scheduled / unattended / offline, or
  to use the 35B). Nearly free architecturally, because the relay already abstracts tool
  location — `app_call_tool` / `connector_call_tool` behave the same whether the caller is
  local or hosted. Write the loop once; it runs either side.
- **Honesty check:** "hostable" ≠ "free everywhere." *Free* is specifically the local
  config (user's CPU/machine). Server-hosted costs GPU or BYOK — the metered/ceiling tier.

**The training target is the `(manifest.json + worker.js + index.html)` triple** — but the
three are not equal in difficulty, and that's the point:
- **`manifest.json` + `worker.js` = the tool layer.** The lowest-entropy target imaginable:
  the model composes a **closed, fixed capability vocabulary** (`db.exec`, `connector.call`,
  `vector.*`, `notify.send`, …) into handler bodies + their declarations. Self-verifying
  (see below).
- **`index.html` = a *beautiful, self-contained single-file* UI** — in scope, because Glyphh
  apps are distributable/marketplace artifacts, not just headless tools. Higher entropy than
  the tool layer but still bounded: one file, no build step, no framework, host libs via
  `../_libs/*`, data via `window.glyphh.call(...)`. Far below Next.js. (Headless-only agents
  still ship a stub `index.html` the packer injects.)

Two consequences of the tool layer's closed vocabulary:
- **Sandbox constraint = training-data constraint.** The worker is strict-CSP, no-network,
  no-node, no-eval — handlers may **never** `fetch()` or `require()`; all I/O routes
  through `glyphh.call(capability, …)`. The dataset must reflect this (no raw network in
  worker.js — use `connector.call`). It's a feature: it's what makes output deterministic
  and safe.
- **Install-validation is a free automatic verifier.** The spec rejects malformed bundles
  (capability xor handler, declared-capability checks, handler-needs-worker, tool/handler
  consistency). Every generated sample is **auto-checkable by trying to install it** → a
  ground-truth reward/filter signal. **The dataset self-verifies.**

**The manifest also carries the marketplace listing** ([app spec §2.1](./GLYPHH-APP-SPEC.md))
— so the same artifact the model already emits is directly publishable; there's **no second
metadata target to train.** The split: the model emits everything *intrinsic* (name, tagline,
`about`, category, keywords, icon) inside the manifest; the *extrinsic* envelope (publisher
identity, pricing, screenshots, trust/ratings) is layered on at publish, **never generated
by the model.**

**Distributed intelligence — the small model is smart in aggregate.** Many tools the loop
calls are themselves inference-backed: some connector MCP servers do real semantic work,
and the loop can **escalate a hard sub-step to a BYOK frontier model exposed as a tool.**
So the *system* reasons well even though the *local model* is small — the completion of
harness > model: the loop not only catches the 14B's mistakes, it **routes cognitively
hard steps to smart tools.** Routing policy for the hardened loop: **prefer deterministic
tools; escalate to inference-backed tools only for the hard steps.** And all such inference
runs on the **user's own accounts/keys** — zero token markup, and the escalation target
*is* the upsell surface.

## 8. Fine-tune plan

- **QLoRA on Qwen2.5-Coder-14B** = one 24GB consumer GPU or a few rented A100 hours →
  **low hundreds of $ per run.** Cheap enough to iterate weekly as the spec evolves.
- **Tooling is first-class:** LLaMA-Factory / Axolotl / Unsloth all support
  Qwen2.5-Coder out of the box.
- **The dataset is the real work — and the moat.** A few thousand high-quality
  *(spec → `.glyphh` bundle)* pairs. Bootstrap synthetically: have a frontier model
  generate pairs conforming to the app structure, human-review a golden seed set, then
  scale. Anyone can download the base; *this dataset* is what makes it ours.
- **Two head-starts already in the repo** (this is not a cold start):
  - **Reference apps** — `apps/keep-in-touch/` (full v2: SQLite + cron + Contacts +
    Messages + 5 handler tools), `apps/daily-brief/` (Gmail + Calendar + RSS + vector +
    LLM), `apps/messages/` (v1 capability-passthrough). Golden hand-built exemplars.
  - **The `build-glyphh-app` skill** (`skills/build-glyphh-app/`) already walks an LLM
    through authoring a spec-conformant app end-to-end — i.e. it's *already* a synthetic
    (spec → app) generator. Point a frontier model at it + a corpus of app ideas to mint
    training pairs at scale.
- **Instruct** model for the agent loop; **FIM** for inline edits within an app.

---

## 9. Open questions

1. **§6 fork** — Next.js archetype vs. the existing vanilla `.glyphh` structure.
2. **Open-source scope + timing** — plan is to eventually strip the router and open-source
   a localized runtime/app. Keep the **relay + fine-tune proprietary** (the moat); the
   harness/loop is the candidate for OSS. Not yet, but coming.
3. **Path A vs B rollout** — tiny-on-ONNX first to de-risk the loop, then 14B-on-llama.cpp.

---

## 10. Next steps

1. **Resolve the §6 fork** (Next.js archetype vs. existing vanilla spec).
2. **Lock the app-structure spec** that becomes the training target.
3. **Path-A probe** — wire a text-gen pipeline onto the existing ONNX runtime, drop in a
   small Qwen, and run the plan → act → observe → repair loop against a handful of bounded
   app-build tasks. If the loop carries a 1.5–4B on the runtime we already ship, the 14B
   on `node-llama-cpp` is a lock — at zero new dependencies to find out.

---

### Sources

- [InsiderLLM — Best Local Coding Models 2026](https://insiderllm.com/guides/best-local-coding-models-2026/)
- [kilo.ai — Open-Source Coding Models](https://kilo.ai/open-source-models)
- [HuggingFace — Open-Source LLMs 2026](https://huggingface.co/blog/daya-shankar/open-source-llms)
- [PromptQuorum — Best Local Coding Models 2026](https://www.promptquorum.com/power-local-llm/best-local-coding-models-2026)
