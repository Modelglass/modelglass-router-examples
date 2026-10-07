# Image Prompt Refiner

Capability-aware prompt rewriting for image generation models, grounded in
live [Modelglass](https://modelglass.com.au) capability data.

You've already picked your target model — this doesn't do model selection
(see [cost-aware-vscode-router](../cost-aware-vscode-router/README.md) for
that, or [image-batch-coster](../image-batch-coster/README.md) if you're
choosing on cost). What it does: pulls the chosen model's real capability
profile (rated strengths, known limitations, prompting conventions where the
registry states them) from the live Modelglass MCP endpoint, and has Claude
rewrite your rough prompt to fit that model specifically — citing the exact
capability-data field behind every change, not generic advice.

Sibling example to [`av-prompt-refiner`](../av-prompt-refiner/README.md)
(video/audio) — same shape, image vertical.

---

## Two modes

- **Generate** — pure text-to-image models (e.g. `bfl/flux-1-1-pro`,
  `google/imagen-4`). Describe the complete desired image from scratch.
- **Edit** — image-editing models that take an existing image plus an
  instruction (e.g. `bfl/flux-kontext`, `bytedance/seedream-4-0`). Rewrites
  the prompt as an edit instruction — describing only what should change and
  explicitly preserving what shouldn't — rather than a from-scratch scene
  description.

This split mirrors a real distinction the image ontology itself draws, not
an invented category: FLUX Kontext's own `routing_guidance` explicitly says
to route there "for image-editing workloads... rather than pure
text-to-image generation," and Seedream 4.0's data describes "editing and
text-to-image generation" as two different post-training tasks. There's no
combined/coordinated mode here the way `av-prompt-refiner` has for
video+audio — a single image has no second-modality counterpart to
coordinate with.

---

## What's genuinely different from `av-prompt-refiner` (video/audio)

Modelglass's image model profiles have **no modality-specific structured fields** the way
video and audio do. Video entries carry typed fields like
`max_clip_duration`, `supported_resolutions`, and `generation_modes`; audio
entries carry `voice_cloning`, `ssml_support`, `sub_modality`. Image entries
carry only the fields shared across all three modalities —
`architecture`, `capability_profile`, `use_cases`, `routing_guidance`,
`limitations`, `notes` — and nothing image-specific beyond them.

Concretely, that means:

- **No structured aspect-ratio or resolution-ceiling field to check against**
  the way `av-prompt-refiner` checks a rough prompt's requested duration
  against `max_clip_duration` exactly. Resolution/aspect-ratio information,
  when a model's data has it at all, is prose inside `capability_profile`'s
  `resolution-ceiling` dimension notes (e.g. FLUX 1.1 Pro's "Ultra variants
  push to ~4MP; base ~1-2MP") or `limitations` — this tool reads and cites
  that prose the same way it cites any other field, but can't do exact
  numeric constraint-checking the way the video tool can.
- **No structured negative-prompt-support or reference-image-count field.**
  Multi-reference-image support (e.g. Seedream 4.0's "up to a dozen
  reference images") is stated as prose in `capability_profile` notes and
  `use_cases`, not a typed field — the system prompt is instructed to read
  for this rather than expect a dedicated key.
- **The generate/edit split takes the place of `av-prompt-refiner`'s
  video/audio/both mode split** — the genuinely useful image-specific
  distinction is generation-vs-editing, not a coordinated multi-modality
  mode (there's nothing for a single image to coordinate with).

This isn't a gap this tool works around silently — see `PROMPT_FIELDS` in
[`src/lib.ts`](src/lib.ts) for the exact allowlist and why it's shorter than
`av-prompt-refiner`'s.

---

## Which models this works for

Needs a model with real ontology data in the Modelglass registry — a
pricing-only entry (`join_status: pricing_only`) has nothing to ground the
rewrite in and errors out clearly. As of 2026-08-05, 30 image models in the
registry carry ontology entries with real `capability_profile` ratings
across seven dimensions (`prompt-adherence`, `photorealism`,
`artistic-range`, `text-rendering`, `compositional-accuracy`,
`resolution-ceiling`, `inference-speed`) — including both pure-generation
models (the FLUX 1.1/1.pro line, Imagen 4, Ideogram 3.0, Seedream 4.0/4.5)
and editing-capable models (FLUX Kontext, Seedream's own editing mode,
GPT Image 2). Find ids via `GET /v1/models?modality=image` on the live feed,
or the `modelglass_list_models` MCP tool.

---

## Requirements

- Node.js 20+
- A Modelglass API key ([get a free one](https://modelglass.com.au/signup))
- An Anthropic API key ([console.anthropic.com](https://console.anthropic.com))

---

## Setup

```bash
git clone https://github.com/Modelglass/modelglass-router-examples.git
cd modelglass-router-examples
npm install
export MODELGLASS_API_KEY=<your-key>
export ANTHROPIC_API_KEY=<your-key>
```

---

## Usage

```bash
# Generate mode — pure text-to-image
npm run refine-image -- --mode generate --model <model_id> --prompt "<rough prompt>"

# Edit mode — image-editing models
npm run refine-image -- --mode edit --model <model_id> --prompt "<rough prompt>"
```

`<model_id>` is the Modelglass cross-host id, e.g. `bfl/flux-1-1-pro` or
`bfl/flux-kontext`. Model ids must have capability data in the registry (a
pricing-only entry errors out — there's nothing to ground the rewrite in).

---

## Worked examples (live runs, 2026-08-05)

### Generate mode — `openai/dall-e-3`

Rough prompt asks for square 512×512 and "ultra-photorealistic"; DALL·E 3's
data rates `photorealism: moderate` ("tends to stylise / over-beautify") and
only supports three fixed output resolutions (1024×1024, 1024×1792,
1792×1024) — no 512×512.

**Input:** `--mode generate --model openai/dall-e-3 --prompt "An ultra-photorealistic macro close-up photo of a dewdrop on a spider web at dawn, square 512x512, tiny readable text caption in the corner reading 'Morning Dew'"`

**Output:**

```
## Refined Prompt

A macro close-up of a single glistening dewdrop clinging to a strand of a spider's web at dawn. The dewdrop acts as a tiny lens, faintly refracting the soft golden-pink morning light and the blurred silhouette of the web behind it. Fine silk threads radiate outward, beaded with smaller droplets, catching cool backlight against a dreamy, softly blurred background of muted dawn colors. Shallow depth of field with delicate, painterly bokeh; gentle, luminous, slightly idealized lighting. In the lower-right corner, a small clean caption in a simple sans-serif font reads "Morning Dew" in soft white lettering. Square 1024×1024 composition.

## What Changed and Why

- **Resolution changed from 512×512 to 1024×1024 (square).** — Driven by `resolution-ceiling` notes: "Fixed outputs: 1024×1024, 1024×1792, 1792×1024"; 512×512 is not an available output, so the nearest square option was used.
- **Softened "ultra-photorealistic" to a stylised, luminous, slightly idealized macro look.** — Driven by `photorealism` rating "moderate" with notes "tends to stylise / over-beautify" and the limitation "weaker raw photorealism"; the prompt leans into the model's strength rather than promising true photorealism it delivers weakly. Tradeoff: expect a beautified/artistic macro rather than a clinically realistic photograph.
- **Kept the corner text caption and specified it plainly ("Morning Dew," simple sans-serif, white).** — Driven by `text-rendering` rating "strong" ("Notably better at legible in-image text"); the caption is a good fit, though I dropped the word "tiny" and asked for a clean simple font since very small type still renders more reliably when kept legible-sized.
- **Expanded into one rich, descriptive scene paragraph.** — Driven by `prompt-adherence` rating "strong" and `use_cases` ("Complex prompts that must be followed faithfully"); the model responds well to detailed, caption-style descriptions.
```

### Edit mode — `bytedance/seedream-4-0`

Rough prompt asks to combine three product photos into one lifestyle shot;
Seedream 4.0's data specifically calls out support for up to a dozen
reference images for multi-image composition/fusion.

**Input:** `--mode edit --model bytedance/seedream-4-0 --prompt "Combine these three product photos into one clean lifestyle photo showing all three items together, keeping each item's appearance exactly as shown in its source photo"`

**Output:**

```
## Refined Edit Instruction

Using the three provided product photos as reference images, compose a single clean lifestyle scene that arranges all three items together in a natural, cohesive setting.

- Fuse the three source photos into one unified image, placing all three products together as if photographed in the same lifestyle setting.
- Preserve each item's appearance exactly as shown in its own source photo — identical shape, color, materials, proportions, branding, and any on-product text or logos. Do not restyle, recolor, or redesign any product.
- Generate a clean, uncluttered lifestyle background and consistent lighting that ties the three items together, without introducing extra props that compete with the products.
- Render at high resolution (up to 4K) for a crisp, presentation-ready result.
- If any product carries printed labels or text, keep that text sharp and correctly rendered.

## What Changed and Why

- **Framed as a multi-reference composition rather than a single-image edit** — driven by `compositional-accuracy` ("Supports up to a dozen reference images for organic multi-image composition/fusion") and the `use_cases` entry "Multi-image composition/fusion from up to a dozen reference images"; three source photos fall well within the dozen-image ceiling.
- **Explicitly instructed to preserve each item's exact appearance per its source** — the rough prompt required identity preservation, and the multi-image fusion capability is the specific feature that carries per-item fidelity across the composite.
- **Added guidance to keep any on-product text/labels sharp** — leverages `text-rendering` (rated "strong," with correct in-image text rendering called out).
- **Specified "up to 4K" high-resolution output** — grounded in `resolution-ceiling` ("4K generation," rated strong).
- **Kept requirements modest on photographic realism and did not over-promise a polished photoreal render** — `photorealism` and `artistic-range` are rated "unknown" (see `limitations`: unrated), so a clean lifestyle look was requested without asserting guaranteed photographic realism.
- **No negative-prompt or aspect-ratio directives added** — the capability data contains no prose in architecture/routing/limitations describing negative-prompt syntax or aspect-ratio limits, so none were invented.
```

---

## Background

Sibling example to `av-prompt-refiner`, following the same pattern: calls
the **Modelglass HTTP MCP endpoint** directly over JSON-RPC via
`modelglass_get_model` (a single model's full profile, to ground the
prompt-refinement guidance) — the tool surface an agent or IDE integration
would actually use. See
the [Modelglass API docs](https://modelglass.com.au/api-docs) for the full
MCP contract.

---

## What's not here (intentional)

- **Model selection** — the caller has already chosen their target model.
  See `cost-aware-vscode-router` for cost-aware LLM routing or
  `image-batch-coster` for cost-ranked image-model selection; nothing
  equivalent exists here for choosing *which* image model to use.
- **Exact numeric constraint-checking on aspect ratio/resolution** — unlike
  `av-prompt-refiner`'s exact `max_clip_duration` check, the image ontology
  has no structured field for this (see "What's genuinely different" above).
  The tool grounds in whatever prose the registry provides instead of
  inventing precision the data doesn't have.
- **Hosted/live demo** — CLI example only, meant to be read and adapted.
- **Actual generation calls** — this rewrites a prompt; it never calls an
  image-generation provider or spends money on a generation.

---

Copyright © 2026 Modelglass Pty Ltd. Licensed under the MIT License — see [LICENSE](../LICENSE).
