# shot-plan-compiler

Storyboard in, execution plan out. Takes a shot-list JSON and, for each shot,
picks the cheapest model in the live [Modelglass](https://modelglass.com.au)
video registry that can actually serve it — then checks whether the
*sequence* of picks can be stitched together at all, flagging fps
mismatches, resolution steps, silent-to-native-audio seams, and shots that
need to be split across multiple generations. Ends with a total job cost.

**This tool plans. It does not generate or composite anything.** No
generation calls, no provider keys beyond the Modelglass API key, no real
spend, fully reproducible output — see
["What's not here"](#whats-not-here-intentional) below.

---

## Background

This is [SCO-190](https://linear.app/scott-schinkel/issue/SCO-190/build-router-example-shot-plan-compiler-storyboard-in-model-picks) —
"shot-plan compiler," which absorbed an earlier idea (SCO-189, multi-model
video routing via last-frame handoff) after a review concluded the two ideas
were one example, not two, and that the *planner* half — the one that
actually needs nothing but registry data to be real — is the right half to
build. Actually rendering a chained video is a one-off marketing artifact,
not repo code; this tool stops at the plan.

---

## Requirements

- Node.js 20+
- A Modelglass API key ([get a free one](https://modelglass.com.au/signup))

---

## Setup

```bash
git clone https://github.com/Modelglass/modelglass-router-examples.git
cd modelglass-router-examples
npm install
export MODELGLASS_API_KEY=<your-key>
```

(Run from the repo root — dependencies and npm scripts are shared across all
examples in this repo; see the [root README](../README.md) for the full
example index.)

---

## Usage

**Run the built-in demo storyboard:**

```bash
npm run plan
```

**Plan a custom storyboard from a JSON file:**

```bash
node --import tsx/esm shot-plan-compiler/src/plan.ts my-storyboard.json
```

**Get budget/balanced/premium alternates instead of a single plan:**

```bash
npm run plan -- --demo --alternates
```

**Storyboard file format:**

```json
{
  "title": "Product teaser — 3 shots",
  "shots": [
    {
      "id": "shot-1",
      "description": "Wide establishing shot, slow push-in",
      "durationSeconds": 5,
      "resolution": "1080p",
      "fps": 24,
      "audio": false
    },
    {
      "id": "shot-2",
      "description": "Continues from shot-1's last frame into a close-up",
      "durationSeconds": 12,
      "resolution": "1080p",
      "fps": 24,
      "audio": false,
      "continuityFromPrevious": true
    }
  ]
}
```

`resolution` must be one of the registry's resolution strings (`"480p"`,
`"720p"`, `"1080p"`, `"4K"`, etc. — whatever the live feed's
`knowledge.supported_resolutions` actually uses). `continuityFromPrevious`
is optional — set it when a shot is meant to continue directly from the
previous shot's last frame (a frame-conditioned continuation) rather than
start fresh from a text description; it's the one flag that toggles whether
image-to-video support is a hard requirement on the model serving that shot.

---

## How it works

The planner calls `GET /v1/models?modality=video` (via the MCP endpoint,
`modelglass_list_models`) once, then applies the same per-shot selection to
every shot in the storyboard:

**Per-shot model pick.** A candidate model/tier must clear every hard
requirement the shot's own spec implies, each cited by field when it fails:

- `resolution` ∈ `knowledge.supported_resolutions`
- `fps` ∈ `knowledge.fps_options`
- a **fresh** shot (no `continuityFromPrevious`) needs `"text-to-video"` in
  `knowledge.generation_modes` — it starts from a text description. A
  **continuity** shot needs `"image-to-video"` instead — it's conditioned on
  the previous shot's last frame, not text. This gate caught a real bug
  during development: Runway Act Two's `generation_modes` are
  `["image-to-video", "video-to-video"]` with no text-to-video mode at all —
  without this check it could get picked for an ordinary fresh shot it
  structurally cannot originate.
- `offering.model.status !== "deprecated"`
- the tier's own `attributes.resolution`/`attributes.fps` (when a model
  prices different resolutions on different tiers) must match, not just the
  model-level capability

The cheapest qualifying candidate wins. Every offering is field-cited in the
rationale — cost, capability, host — same style as cost-aware-vscode-router
and av-prompt-refiner.

**Cost math — honest-unit discipline, extended for video.**
image-batch-coster never force-converts a price unit without a documented
basis in the registry's own data; this tool applies the same principle to
video's units, which differ from image's (`per_second` / `per_clip` /
`per_credit`, not `per_image` / `per_megapixel`):

- `per_second` — directly comparable: `amount × duration`.
- `per_clip` — comparable **when** the tier records `attributes.clip_seconds`
  (every `per_clip` tier in the live registry does): cost = `amount ×
  ceil(duration / clip_seconds)`, i.e. however many clip generations the
  shot's duration actually needs.
- `per_credit` — comparable **when** the tier records
  `attributes.credits_per_second` (every `per_credit` tier in the live video
  registry does, unlike image's `per_credit` case where the credit-per-
  generation rate isn't tracked at all): cost = `amount × credits_per_second
  × duration`.
- Anything missing the attribute needed to convert it honestly — or billed
  in a unit this tool doesn't recognize — is listed in that shot's excluded
  candidates with the specific reason, never guessed.

**Chain-feasibility — the novel part.** For every shot-to-shot handoff:

- **fps mismatch** — the two shots' fps differ (e.g. a 24fps shot cut into a
  30fps one). Flagged with a recommendation to insert a frame-rate
  conversion pass or re-author one shot to match.
- **resolution step** — the two shots' resolution differ. Flagged with a
  recommendation to upscale/downscale to match, or accept the step as an
  intentional hard cut (a crossfade across a resolution step reads as soft
  focus, so that's explicitly *not* the suggested fix).
- **audio seam** — one shot's pick produces native audio and the adjacent
  one doesn't. Flagged with a recommendation to fade the audio track across
  the cut, or run a separate audio-generation pass (see av-prompt-refiner)
  to cover the silent side.
- **infeasible continuity** — a `continuityFromPrevious` shot has no
  qualifying model at all.

**Split required.** When a shot's duration exceeds its picked model's
`knowledge.max_clip_duration`, the shot needs multiple back-to-back
generations from the same model, each conditioned on the previous segment's
last frame — which additionally requires `"image-to-video"` support for the
self-chaining, regardless of whether the shot itself is a continuity shot.
Flagged per shot with the exact segment count needed.

**Alternate budget levels** (`--alternates`, stretch scope). `budget` picks
the cheapest qualifying candidate per shot (the default). `premium` picks
the priciest qualifying candidate per shot, used as a price-as-quality proxy
— the registry has no single per-shot-type quality scalar to rank on
instead, and this tool says so rather than pretending otherwise. `balanced`
picks the middle-ranked candidate per shot.

---

## Worked example — product teaser (2026-07-12)

This is the output of `npm run plan` against the live feed on 2026-07-12
(18 video models; the pool moves as the registry does — your run may
differ):

**Storyboard:** 3 shots — a wide establishing shot (1080p/24fps, silent), a
close-up that continues from the first shot's last frame (1080p/24fps,
silent, 12s — longer than most models' clip cap), and a final hero shot with
voiceover (1080p/30fps, audio).

```
────────────────────────────────────────────────────────────────────────────────────────────────
  shot-plan-compiler
────────────────────────────────────────────────────────────────────────────────────────────────
  Storyboard: Product teaser — 3 shots
────────────────────────────────────────────────────────────────────────────────────────────────

  SHOT PLAN

  shot-1
    Wan 2.5 (fal): USD 0.05/s × 5s; clears knowledge.supported_resolutions (1080p) and knowledge.fps_options (24); cheapest of 13 qualifying candidate(s)
    Cost: $0.2500
    Excluded (9):
      ✗ Act Two (runway/act-two): knowledge.generation_modes [image-to-video, video-to-video] does not include 'text-to-video' — required for a fresh shot generated from a text prompt
      ✗ CogVideoX-5B (thudm/cogvideox-5b): knowledge.supported_resolutions [720p] does not include '1080p'
      ✗ Gemini Omni Flash (google-deepmind/gemini-omni-flash): knowledge.supported_resolutions [720p] does not include '1080p'
      ✗ Gen-4 Turbo (runway/gen-4-turbo): knowledge.generation_modes [image-to-video] does not include 'text-to-video' — required for a fresh shot generated from a text prompt
      ✗ Hailuo-02 (minimax/hailuo-02): minimax offering: no tier attributes compatible with '1080p' / 24fps
      ✗ Kling 2.1 (klingai/kling-2-1): klingai offering: no tier attributes compatible with '1080p' / 24fps
      ✗ LTX Video 0.9.7 (lightricks/ltx-video-0-9-7): knowledge.supported_resolutions [480p, 720p] does not include '1080p'
      ✗ Mochi 1 (genmo/mochi-1): knowledge.supported_resolutions [480p] does not include '1080p'
      ✗ Veo 3 (google-deepmind/veo-3): google-deepmind offering: model.status is 'deprecated'

  shot-2
    Act Two (runway): USD 0.05/s × 12s; clears knowledge.supported_resolutions (1080p) and knowledge.fps_options (24); cheapest of 15 qualifying candidate(s); knowledge.max_clip_duration 10s < shot duration 12s — split into 2 self-chained generations
    Cost: $0.6000
    Excluded (7):
      ✗ CogVideoX-5B (thudm/cogvideox-5b): knowledge.supported_resolutions [720p] does not include '1080p'
      ✗ Gemini Omni Flash (google-deepmind/gemini-omni-flash): knowledge.supported_resolutions [720p] does not include '1080p'
      ✗ Hailuo-02 (minimax/hailuo-02): minimax offering: no tier attributes compatible with '1080p' / 24fps
      ✗ Kling 2.1 (klingai/kling-2-1): klingai offering: no tier attributes compatible with '1080p' / 24fps
      ✗ LTX Video 0.9.7 (lightricks/ltx-video-0-9-7): knowledge.supported_resolutions [480p, 720p] does not include '1080p'
      ✗ Mochi 1 (genmo/mochi-1): knowledge.supported_resolutions [480p] does not include '1080p'
      ✗ Veo 3 (google-deepmind/veo-3): google-deepmind offering: model.status is 'deprecated'

  shot-3
    Sora 2 (openai): USD 0.7/s × 6s; clears knowledge.supported_resolutions (1080p) and knowledge.fps_options (30); cheapest of 1 qualifying candidate(s); shot needs audio but knowledge.native_audio is false — needs a separate audio pass
    Cost: $4.20
    Excluded (17):
      ✗ Act Two (runway/act-two): knowledge.fps_options [24] does not include 30
      ✗ CogVideoX-5B (thudm/cogvideox-5b): knowledge.supported_resolutions [720p] does not include '1080p'
      ✗ Gemini Omni Flash (google-deepmind/gemini-omni-flash): knowledge.supported_resolutions [720p] does not include '1080p'
      ✗ Gen-4 Turbo (runway/gen-4-turbo): knowledge.fps_options [24] does not include 30
      ✗ Gen-4.5 (runway/gen-4-5): knowledge.fps_options [24] does not include 30
      ✗ Hailuo-02 (minimax/hailuo-02): knowledge.fps_options [24] does not include 30
      ✗ HappyHorse 1.0 (happyhorse/happyhorse-1-0): knowledge.fps_options [24] does not include 30
      ✗ HunyuanVideo 1.5 (tencent/hunyuan-video-1-5): knowledge.fps_options [24] does not include 30
      ✗ Kling 2.1 (klingai/kling-2-1): klingai offering: no tier attributes compatible with '1080p' / 30fps
      ✗ LTX Video 0.9.7 (lightricks/ltx-video-0-9-7): knowledge.supported_resolutions [480p, 720p] does not include '1080p'
      ✗ Mochi 1 (genmo/mochi-1): knowledge.supported_resolutions [480p] does not include '1080p'
      ✗ Pika 2.2 (pika/pika-2-2): knowledge.fps_options [24] does not include 30
      ✗ Ray 3.2 (luma/ray-3-2): knowledge.fps_options [24] does not include 30
      ✗ Seedance 2 (runway/seedance-2): knowledge.fps_options [24] does not include 30
      ✗ Veo 3 (google-deepmind/veo-3): knowledge.fps_options [24] does not include 30
      ✗ Veo 3.1 (google-deepmind/veo-3-1): knowledge.fps_options [24] does not include 30
      ✗ Wan 2.5 (wan-video/wan-2-5): knowledge.fps_options [16, 24] does not include 30

────────────────────────────────────────────────────────────────────────────────────────────────
  SHOT FLAGS (2)

  [split-required] shot-2: Shot exceeds Act Two's max_clip_duration — needs 2 self-chained generations.
    → Generate 2 segments back to back, each conditioned on the previous segment's last frame (image-to-video), then trim the internal splice points.

  [needs-separate-audio-pass] shot-3: Shot needs audio but Sora 2 has no native audio.
    → Run a separate audio-generation pass (see av-prompt-refiner) and mux it onto this shot.

────────────────────────────────────────────────────────────────────────────────────────────────
  CHAIN-FEASIBILITY (2 handoff(s), 2 flagged)

  shot-1 → shot-2:
    [audio-seam] shot-1's pick (Wan 2.5) does not produce native audio; shot-2's pick (Act Two) produces native audio.
      → Add a fade on the audio track across this cut, or run a separate audio-generation pass (see av-prompt-refiner) to cover the silent side rather than an abrupt audio cut.

  shot-2 → shot-3:
    [fps-mismatch] shot-2 is 24fps, shot-3 is 30fps.
      → Insert a frame-rate conversion pass at the cut (or re-author one shot to match fps) — a raw fps step will visibly judder.
    [audio-seam] shot-2's pick (Act Two) produces native audio; shot-3's pick (Sora 2) does not produce native audio.
      → Add a fade on the audio track across this cut, or run a separate audio-generation pass (see av-prompt-refiner) to cover the silent side rather than an abrupt audio cut.

────────────────────────────────────────────────────────────────────────────────────────────────
  TOTAL COST: $5.05
────────────────────────────────────────────────────────────────────────────────────────────────
```

**Why this run is honest, not contrived.** Shot-1 initially resolved to
Runway Act Two during development — the cheapest raw per-second rate in the
pool — until running this planner against real data surfaced that Act Two
has no text-to-video mode at all (it's a performance-transfer model driven
by a video, not a prompt) and genuinely cannot originate a fresh shot. That
gap is what the primary-mode gate documented above exists to catch, and it's
exactly the kind of thing a naive "cheapest model" script would miss. The
fps-mismatch and audio-seam flags on shot-2 → shot-3 are also real: shot-3's
30fps requirement rules out every 24fps-only model, leaving Sora 2 as the
only qualifying candidate, and Sora 2 has no native audio — so both flags
fire honestly, not for demonstration purposes. Run `npm run plan -- --demo
--alternates` to see budget ($5.05) / balanced ($6.24) / premium ($16.20)
side by side.

---

## What's not here (intentional)

- **Generation calls** — this tool never calls a video/audio provider. It
  only reads the Modelglass registry and computes a plan.
- **Compositing/rendering** — stitching, fades, and trims are
  *recommended*, not executed. No video-editing library is a dependency
  here.
- **Provider keys** — only `MODELGLASS_API_KEY` is needed. No Runway,
  OpenAI, Google, or any other generation-provider credential.
- **Real spend** — nothing in this tool can cost money to run.
- **A quality-ranked "premium" tier** — `--alternates`'s `premium` level
  uses price as a proxy for quality because the registry doesn't expose a
  single quality scalar per shot type; this is a stated simplification, not
  a hidden one.

---

---

_Repo note: merges to this repo's `main` now publish to modelglass.com.au/routers
automatically (SCO-197, 2026-07-13) — no manual nudge to the main site repo
required._

Copyright © 2026 Modelglass Pty Ltd. Licensed under the MIT License — see [LICENSE](../LICENSE).
