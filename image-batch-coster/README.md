# image-batch-coster

Cross-host cost ranking for an image-generation batch job, using the live
[Modelglass](https://modelglass.com.au) image feed. Estimating what a batch
job will actually cost is genuinely fiddly: the same model is often priced
differently across hosts, and offerings bill in incompatible units — the
live image feed today mixes `per_image`, `per_megapixel`, `per_credit`, and
`per_month` tiers in the same pool. Cross-host arbitrage on identical models
is real, current data (see [Worked example](#worked-example-real-run-against-the-live-feed)
below) — this surfaces it directly, with the repo's standard grounded
rationale for every inclusion, exclusion, and unit conversion.

Free-tier friendly — only current prices are needed, no pricing-history
lookback, no LLM call. Pure data + arithmetic.

---

## Requirements

- Node.js 20+
- A Modelglass API key ([get a free one](https://modelglass.com.au/signup)) — any plan works

---

## Setup

```bash
git clone https://github.com/Modelglass/modelglass-router-examples.git
cd modelglass-router-examples
npm install
export MODELGLASS_API_KEY=<your-key>
```

---

## Usage

**Run the built-in demo job:**

```bash
npm run cost
```

**Cost a real job from a JSON file:**

```bash
node --import tsx/esm image-batch-coster/src/cost.ts my-job.json
```

(Run from the repo root — dependencies and npm scripts are shared across all
examples in this repo; see the [root README](../README.md) for the full
example index.)

**Job spec format:**

```json
{
  "count": 250,
  "resolution": "1536x1536",
  "requirements": {
    "photorealism": "strong"
  }
}
```

- `count` — how many images the job will generate.
- `resolution` — `"WIDTHxHEIGHT"`, converted to megapixels internally (the
  unit `per_megapixel` tiers actually price on).
- `requirements` — optional; a capability dimension → minimum acceptable
  rating map (`weak` / `moderate` / `strong`). **Keys are validated against
  whatever dimensions actually exist in the live feed at run time** —
  nothing is hardcoded here. Today that's `artistic-range`,
  `compositional-accuracy`, `inference-speed`, `photorealism`,
  `prompt-adherence`, `resolution-ceiling`, `text-rendering`, but this tool
  doesn't assume that list stays fixed; an unrecognized key (or an
  unrecognized minimum rating) fails fast with the actual current list
  rather than silently excluding everything.

---

## How it works

1. Fetches the full image-modality, current-generation offering pool via the
   live Modelglass MCP endpoint (`modelglass_list_models`, one call).
2. Validates the job spec's `requirements` keys and minimum ratings against
   what's actually present in that response.
3. **Capability filtering** — excludes any model that doesn't meet the job's
   stated requirements, citing the specific `capability_profile.<dimension>`
   field (or its absence) behind every exclusion.
4. **Cost normalization** for the surviving candidates:
   - `per_image` → `amount × count`
   - `per_megapixel` → `amount × count × megapixels` (from the spec's `resolution`)
   - `per_credit` / `per_month` → **never converted.** Routed to a separate
     "not directly comparable" section with the specific reason, instead of
     guessed. See [What's not here](#whats-not-here-intentional).
5. Ranks the comparable offerings by cost-per-job (and shows cost-per-1k-images
   for scale-independent comparison).
6. **Cross-host callout** — groups ranked offerings by `model_id`; when the
   same model is offered at ≥2 hosts and they land on different job costs,
   calls out the cheapest vs priciest host and the spread, by name.

---

## Worked example (real run, against the live feed)

This is the actual output of `npm run cost -- --demo`, run 2026-07-06
against the live Modelglass feed — not hand-written:

```
Fetching the image-modality offering pool from https://modelglass-api.vercel.app/mcp ...

────────────────────────────────────────────────────────────────────────────────────────────────
  image-batch-coster
────────────────────────────────────────────────────────────────────────────────────────────────
  Job: 250 image(s) at 1536x1536 (2.36 MP) — requires photorealism: strong+

  RANKED (18 offering(s), cheapest first):
  MODEL                             HOST         UNIT           COST/JOB  COST/1K IMAGES
  Z-Image-Turbo                     siliconflow  per_image      $1.25     $5.00
  GPT Image 1                       openai       per_image      $2.75     $11.00
  Adobe Firefly Image 3             adobe        per_image      $5.00     $20.00
  Imagen 4                          google       per_image      $5.00     $20.00
  FLUX.1 [dev]                      replicate    per_image      $6.25     $25.00
  FLUX 1.1 [pro]                    replicate    per_image      $10.00    $40.00
  Imagen 4                          google       per_image      $10.00    $40.00
  Stable Diffusion 3.5 Large Turbo  replicate    per_image      $10.00    $40.00
  GPT Image 1                       openai       per_image      $10.50    $42.00
  FLUX.1 [dev]                      together     per_megapixel  $14.75    $58.98
  Ideogram 3.0                      ideogram     per_image      $15.00    $60.00
  Ideogram 3.0                      ideogram     per_image      $15.00    $60.00
  Ideogram 3.0                      ideogram     per_image      $15.00    $60.00
  Imagen 4                          google       per_image      $15.00    $60.00
  Stable Diffusion 3.5 Large        replicate    per_image      $16.25    $65.00
  FLUX 1.1 [pro]                    fal          per_megapixel  $23.59    $94.37
  GPT Image 1                       openai       per_image      $41.75    $167.00
  HunyuanImage 3.0                  fal          per_megapixel  $58.98    $235.93

  CROSS-HOST PRICE SPREAD (2):
  FLUX 1.1 [pro] (bfl/flux-1-1-pro): replicate $10.00 vs fal $23.59 for this job — same model, 57.6% spread
  FLUX.1 [dev] (bfl/flux-1-dev): replicate $6.25 vs together $14.75 for this job — same model, 57.6% spread

  NOT DIRECTLY COMPARABLE (6) — not ranked:
  Leonardo Phoenix (leonardo, per_credit @ USD 0.00257): billed in provider credits, not a fixed per-image/per-megapixel rate — converting to a per-job dollar estimate would require guessing how many credits one generation actually consumes, which Modelglass does not track. Listed at face value instead of guessed.
  Midjourney v7 (midjourney, per_month @ USD 10): a flat subscription rate, not a per-generation charge — amortizing it into a per-job cost would require assuming a generation volume this tool has no basis for. Listed at face value instead of guessed.
  Midjourney v7 (midjourney, per_month @ USD 30): a flat subscription rate, not a per-generation charge — amortizing it into a per-job cost would require assuming a generation volume this tool has no basis for. Listed at face value instead of guessed.
  Midjourney v7 (midjourney, per_month @ USD 60): a flat subscription rate, not a per-generation charge — amortizing it into a per-job cost would require assuming a generation volume this tool has no basis for. Listed at face value instead of guessed.
  Midjourney v7 (midjourney, per_month @ USD 120): a flat subscription rate, not a per-generation charge — amortizing it into a per-job cost would require assuming a generation volume this tool has no basis for. Listed at face value instead of guessed.
  Runway Gen-4 Image (runway, per_credit @ USD 0.01): billed in provider credits, not a fixed per-image/per-megapixel rate — converting to a per-job dollar estimate would require guessing how many credits one generation actually consumes, which Modelglass does not track. Listed at face value instead of guessed.

  EXCLUDED (6) — didn't meet requirements:
  DALL·E 3 (openai/dall-e-3): capability_profile.photorealism: 'moderate' below required 'strong'
  FLUX.1 [schnell] (bfl/flux-1-schnell): capability_profile.photorealism: 'moderate' below required 'strong'
  Recraft V3 (recraft/recraft-v3): capability_profile.photorealism: 'moderate' below required 'strong'
  Stable Diffusion 3.5 Medium (stability-ai/stable-diffusion-3-5-medium): capability_profile.photorealism: 'moderate' below required 'strong'
  Stable Image Core (stability-ai/stable-image-core): no capability_profile in the registry (join_status: pricing_only) — cannot verify photorealism
  Stable Image Ultra (stability-ai/stable-image-ultra): no capability_profile in the registry (join_status: pricing_only) — cannot verify photorealism
────────────────────────────────────────────────────────────────────────────────────────────────
```

Exit code: `0` (offerings were ranked; exit is only non-zero when nothing
meets the job's requirements at all).

**Two things worth calling out about this specific run:**

- The cross-host spread here isn't about the same numeric rate meaning
  different things — FLUX 1.1 Pro is `$0.04` at both Replicate (`per_image`)
  and fal (`per_megapixel`); FLUX.1 [dev] is `$0.025` at both Replicate and
  Together, same pattern. At exactly 1 megapixel these would cost the same.
  The 57.6% spread only appears because this job's resolution (1536×1536 ≈
  2.36 MP) is above 1 MP, so the `per_megapixel` host's cost scales up while
  the `per_image` host's doesn't. **The spread is resolution-dependent** —
  a lower-resolution job could just as easily flip which host is cheaper.
- FLUX.1 [schnell] is also offered at both Replicate and fal (same
  `per_image`/`per_megapixel` pattern as the other two), but doesn't appear
  in the cross-host section here — it's excluded from this specific job for
  `photorealism: moderate` (below this job's `strong` requirement) before
  cost comparison even runs.

---

## What's not here (intentional)

- **No estimated `per_credit`/`per_month` conversion, ever.** Leonardo
  Phoenix and Runway Gen-4 Image bill in provider credits; Midjourney v7
  bills a flat monthly subscription across four tiers. None of these map to
  a fixed per-image or per-megapixel rate without guessing how many credits
  one generation actually consumes, or how many images a subscription month
  is meant to cover — Modelglass doesn't track either, so this tool reports
  the raw rate honestly instead of inventing a number that looks precise but
  isn't. This mirrors known-debt item #7 in the main `modelglass` repo
  (cross-unit price sorting is approximate) and turns a limitation into an
  explicit, permanent data-honesty stance rather than a gap to quietly paper
  over later.
- **No coding/science/agentic benchmark data** — not applicable here; this
  tool only ever looks at the image modality's own `capability_profile`
  ratings, which the live feed does expose in full (unlike stack-watch's
  documented gap for the other capability verticals).
- **No LLM call** — pure data + arithmetic. Cheapest example in this repo to
  run and to maintain.
- **No live/hosted demo** — CLI example only, meant to be read and adapted.

---

Copyright © 2026 Modelglass Pty Ltd. Licensed under the MIT License — see [LICENSE](../LICENSE).
