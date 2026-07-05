# av-prompt-refiner

Capability-aware prompt rewriting for video and audio generation models,
grounded in live [Modelglass](https://modelglass.com.au) capability data.

You've already picked your target model(s) — this doesn't do model selection
(see [cost-aware-vscode-router](../cost-aware-vscode-router/README.md) for
that). What it does: pulls the chosen model's real capability profile
(prompt conventions, supported parameters, known limitations) from the live
Modelglass MCP endpoint, and has Claude rewrite your rough prompt to fit that
model specifically — citing the exact capability-data field behind every
change, not generic advice.

---

## Three modes

- **Video only** — refine a prompt for one video model.
- **Audio only** — refine a prompt for one audio model.
- **Both (coordinated)** — you want video and audio for the same piece (e.g. a
  silent video model paired with a separate music/sound-design model). This
  reasons across **both** capability profiles at once — not two independent
  rewrites bolted together — to produce a matched-duration, matched-mood pair
  of prompts plus explicit sync notes (e.g. "audio swell at 0:05 matches the
  video's camera push-in").

---

## Background

Second example in this repo, alongside `cost-aware-vscode-router`. Where that
one calls the plain REST feed (`GET /v1/models`) for LLM routing decisions,
this one calls the **Modelglass HTTP MCP endpoint** directly over JSON-RPC —
the tool surface an agent or IDE integration would actually use — via the
`modelglass_get_model` tool. See
[`docs/mcp-usage.md`](https://github.com/Modelglass/modelglass/blob/main/docs/mcp-usage.md)
in the main repo for the full MCP contract.

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
# Video only
npm run refine -- --mode video --video-model <model_id> --prompt "<rough prompt>"

# Audio only
npm run refine -- --mode audio --audio-model <model_id> --prompt "<rough prompt>"

# Both, coordinated
npm run refine -- --mode both --video-model <model_id> --audio-model <model_id> --prompt "<rough prompt>"
```

`<model_id>` is the Modelglass cross-host id, e.g. `klingai/kling-2-1` or
`stability-ai/stable-audio-3-0`. Find ids via `GET /v1/models?modality=video|audio`
on the live feed, or the `modelglass_list_models` MCP tool. Model ids must have
capability data in the registry (a pricing-only entry errors out — there's
nothing to ground the rewrite in).

---

## Worked examples (live runs, 2026-07-05)

### Video only — `klingai/kling-2-1`

Rough prompt intentionally asks for 15 seconds; Kling 2.1's clip-duration
ceiling is 10 seconds.

**Input:** `--mode video --video-model klingai/kling-2-1 --prompt "A woman walks through a bustling night market, camera slowly zooming in on her face as neon lights reflect in her eyes, 15 seconds long"`

**Output (excerpt):**

```
## Refined Video Prompt

A young woman moves at an unhurried pace through a bustling night market,
weaving between food stalls and crowds. Warm steam rises from vendor carts
as neon signage in pink, cyan, and amber washes over the scene. The camera
holds on her from a medium distance, then executes a slow, steady push-in
toward her face over the length of the shot, tightening to a close-up as
the vivid neon lights reflect and shimmer in her eyes. ...

## What Changed and Why

- Trimmed from 15s to 10s — max_clip_duration / clip-duration-ceiling caps
  Kling 2.1 at 10 seconds per call.
- Wrote the zoom as cinematic prose ("slow, steady push-in") rather than a
  parameter — camera-control is only moderate, so pacing the move in
  descriptive language gives it the best chance of landing.
- Emphasized consistent facial identity and grounded walking motion — leans
  on the model's strong character-consistency and motion-quality ratings.
```

### Audio only — `stability-ai/stable-audio-3-0`

Rough prompt asks for sung vocals; Stable Audio 3.0's `vocal_generation` is
`false`.

**Input:** `--mode audio --audio-model stability-ai/stable-audio-3-0 --prompt "An upbeat pop song with vocals about summer, 3 minutes long"`

**Output (excerpt):**

```
## Refined Audio Prompt

An energetic, feel-good instrumental pop track that captures the spirit of
summer ... Build through a bright, hook-driven lead melody (carried by synth
and guitar in place of a vocal line) that stands in for the "chorus" ...

## What Changed and Why

- Converted from a vocal song to an instrumental track with a lead-melody
  "hook" replacing the sung chorus — vocal-support is rated "weak" and
  features_and_differences.vocal_generation is false.
- Dropped the lyric-driven "about summer" narrative and expressed the theme
  through instrumentation and mood instead — lyric_control is false.

Tradeoff: This prompt cannot deliver a sung, lyric-based vocal about summer.
If sung vocals and lyrics are essential, the routing guidance points to
Suno v4 as the better choice.
```

### Both, coordinated — `klingai/kling-2-1` + `stability-ai/stable-audio-3-0`

Rough prompt again asks for 12 seconds — Kling's 10s ceiling becomes the
binding constraint for the whole piece, not just the video half.

**Input:** `--mode both --video-model klingai/kling-2-1 --audio-model stability-ai/stable-audio-3-0 --prompt "A dog running joyfully on a beach at sunset, with fun upbeat music, 12 seconds long"`

**Output (excerpt):**

```
## Refined Video Prompt

A golden retriever bounds joyfully across a wide sandy beach at sunset ...
10 seconds, 1080p, 24fps, no native audio track (scored separately).

## Refined Audio Prompt

Fun, upbeat instrumental cue for a playful beach scene at golden hour ...
- seconds-start: 0
- seconds-total: 10

## Consistency Notes

- Total length locked to 10s on both sides — the video's ceiling is the
  binding constraint, and Stable Audio's seconds-total timing conditioning
  is set explicitly to 10 to match.
- Because Stable Audio 3.0 exposes seconds-start/seconds-total timing
  conditioning, sync points are given as real instants, not just prose:
  the two-second musical build (0:00–0:02) covers the dog's initial burst
  into a run; the resolving flourish at ~0:09–0:10 lands under the
  camera's slow push-in.

## What Changed and Why

- Trimmed 12s → 10s (video) — Kling 2.1's clip-duration-ceiling caps at 10s.
- Set audio seconds-total to 10s — matched to the video ceiling.
- Scored audio separately instead of Kling native audio — Kling's
  native-audio is only moderate/"variable quality," so the dedicated audio
  model (strong audio-quality) carries the music.
```

---

## What's not here (intentional)

- **Model selection** — the caller has already chosen their target model(s).
  See `cost-aware-vscode-router` for cost-aware LLM routing; nothing
  equivalent exists here for video/audio model choice.
- **Hosted/live demo** — CLI example only, meant to be read and adapted.

---

Copyright © 2026 Modelglass Pty Ltd. All rights reserved.

This software and its source code are proprietary and confidential.
Unauthorised copying, modification, distribution, or use is strictly prohibited.
Access to data and APIs is subject to the Modelglass Terms of Service.
