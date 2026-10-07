# shot-prompt-refiner

Storyboard-plan in, refined prompts out. Takes the plan
[shot-plan-compiler](../shot-plan-compiler/README.md) computed for a
storyboard — which model was picked for each shot — and has an LLM rewrite
each shot's rough prompt to fit the model actually assigned to it, grounded
in that model's live capability data from the
[Modelglass](https://modelglass.com.au) registry.

**This tool refines prompts. It does not generate or render video.** Same
"plans/refines, doesn't generate" discipline as shot-plan-compiler — see
["What's not here"](#whats-not-here-intentional) below.

---

## Why this exists, and why it's opt-in

This is the video half of Modelglass's LLM-in-the-loop prompt refinement. A human's rough prompt into a video model is usually
weaker than what a capability-grounded rewrite produces, the same way
`av-prompt-refiner` and `image-prompt-refiner` already demonstrate for their
verticals. This tool is a demonstrably better way to get **consistent,
reliable** output from the models shot-plan-compiler picked — it's not novel
for its own sake, and it isn't the default step in the storyboard workflow.

**Be honest about the trade-off.** An extra LLM call adds cost and latency
on top of whatever the actual video generation costs — this tool doesn't
pretend otherwise:

- **Cost**: one combined LLM call across the whole storyboard (not one call
  per shot — see [How it works](#how-it-works)), routed to the cheapest
  Anthropic model that clears the reasoning bar the job needs. For the
  worked example below (3 shots, "complex" tier), that's roughly
  1,500–2,500 input tokens (grounding data + rough prompts) and
  1,000–2,000 output tokens at Claude Sonnet 5's $2/$10 per-million rates —
  call it a few cents, not a rounding error at scale, and it's on top of
  whatever the actual video generation itself costs.
- **Latency**: seconds, not instant — a real reasoning-model completion, not
  a registry lookup.

Use this when a shot's output quality matters enough to justify that —
final assets, hero shots, anything you'd otherwise iterate on by hand. Skip
it for cheap/fast exploratory passes where the rough prompt is good enough.

**Access model**: this is a Pro-gated capability in the product sense (a
Modelglass API key still authenticates every registry/routing call this
tool makes either way — actual plan enforcement is a site-side concern, not
something this CLI example enforces itself; the Modelglass API applies the
plan gating).

---

## The pairing with shot-plan-compiler

```
┌─────────────────────┐        ┌──────────────────────┐
│  shot-plan-compiler  │  plan  │  shot-prompt-refiner  │
│  storyboard → picks  │ ─────► │  picks → refined      │
│  + chain-feasibility │  .json │  prompts, per shot    │
└─────────────────────┘        └──────────────────────┘
```

```bash
npm run plan -- my-storyboard.json --json > plan.json
npm run refine-shots -- plan.json
```

`shot-plan-compiler`'s `Storyboard`/`Shot` schema is reused as-is here — a
storyboard written for one tool is valid input to the other, no
transformation needed. `plan.ts --json` is the machine-readable companion to
its normal text report (added alongside this tool, not instead of it —
the default `npm run plan` behavior is unchanged).

---

## Requirements

- Node.js 20+
- A Modelglass API key ([get a free one](https://modelglass.com.au/signup))
- An Anthropic API key (`ANTHROPIC_API_KEY`) — BYOK, same as `av-prompt-refiner`/`image-prompt-refiner`

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

**Run the built-in demo** (the real product-teaser storyboard + picks from
shot-plan-compiler's own worked example — see its README — so this runs
without needing to invoke shot-plan-compiler first):

```bash
npm run refine-shots -- --demo
```

**Refine a real plan:**

```bash
npm run plan -- my-storyboard.json --json > plan.json
npm run refine-shots -- plan.json
```

**Input file format** — the exact `{ storyboard, plan }` shape
`shot-plan-compiler`'s `plan.ts --json` emits:

```json
{
  "storyboard": {
    "title": "Product teaser — 3 shots",
    "shots": [
      { "id": "shot-1", "description": "Wide establishing shot...", "durationSeconds": 5, "resolution": "1080p", "fps": 24, "audio": false }
    ]
  },
  "plan": {
    "storyboard_title": "Product teaser — 3 shots",
    "selections": [
      { "shot_id": "shot-1", "picked": { "model_id": "wan-video/wan-2-5", "name": "Wan 2.5", "provider": "fal" } }
    ]
  }
}
```

A shot with `"picked": null` (shot-plan-compiler found no feasible model) or
missing from `plan.selections` entirely is reported and skipped, not
silently dropped or refined against a guessed model.

---

## How it works

**Grounding each shot's rewrite.** For every distinct model picked across
the storyboard, this tool calls the live Modelglass MCP endpoint
(`modelglass_get_model`) for that model's capability profile — the same
video-field allowlist `av-prompt-refiner` uses (`max_clip_duration`,
`supported_resolutions`, `fps_options`, `generation_modes`, `native_audio`,
`capability_profile`, `routing_guidance`, `limitations`, etc.), never the
full untrusted registry payload.

**One combined LLM call, not one per shot.** A multi-shot storyboard needs
cross-shot narrative and style consistency reasoned about together — the
same principle behind `av-prompt-refiner`'s combined video+audio mode,
applied across N shots instead of two modalities. All shots being refined
go into a single system prompt with every relevant grounding block; the
model returns a refined prompt + "what changed and why" per shot, plus one
"Consistency notes" section when there's more than one shot.

**Routing the refiner LLM itself — the part `av-prompt-refiner` and
`image-prompt-refiner` don't do** (both hardcode `claude-opus-4-8`). This
tool selects it from the live Modelglass LLM feed instead, the same way
`cost-aware-vscode-router` routes a coding subtask: filter by a
`capability_profile` "reasoning" rating tier, cheapest qualifying candidate
wins, every exclusion cited by field.

- **Complexity signal**: shot count in the job being refined. A single shot
  is "simple cleanup" (`reasoning` ≥ `moderate` required). Two or more shots
  is "complex" (`reasoning` = `strong` required) — cross-shot consistency is
  the thing that actually gets harder, not prompt length, so that's the
  signal used, not an LLM-judged complexity score (which would add its own
  cost/latency just to decide whether to spend cost/latency — circular).
- **Anthropic-hosted candidates only.** This tool executes the refinement
  call itself via the Anthropic SDK (BYOK, `ANTHROPIC_API_KEY`) — the same
  single-provider convention every LLM-calling example in this repo uses.
  Routing to a model this tool then can't actually call would be a
  recommendation nobody can act on, so the candidate pool is restricted to
  `provider: anthropic` offerings, and every non-Anthropic exclusion says so
  explicitly rather than silently narrowing the pool.

**Verified against the live registry (2026-08-07)** — the actual routing
outcome, computed from the same registry data the MCP tool serves (not
simulated):

| Job | Reasoning bar | Cheapest qualifying Anthropic model | Input price |
|---|---|---|---|
| Single shot (simple) | ≥ moderate | Claude 3.5 Haiku | $0.80 / 1M tokens |
| 2+ shots (complex) | = strong | Claude Sonnet 5 | $2.00 / 1M tokens |

Claude Haiku 4 ($1.00) and Claude 3.5 Sonnet/Sonnet 4/Sonnet 4.6 ($3.00 each)
are real qualifying candidates too — Claude 3.5 Haiku and Claude Sonnet 5
just clear their respective bars at the lowest price in the live pool today.
This pool moves as the registry does; run `--demo` (or a real plan) against
your own key to see the current picks and full excluded-candidate list.

---

## Worked example — demo storyboard, routing decision

This is the real routing step for the built-in demo (3 shots, "complex" —
see `--demo`'s output on stderr before the refinement call starts):

```
────────────────────────────────────────────────────────────────────────────────────────────────
  shot-prompt-refiner
────────────────────────────────────────────────────────────────────────────────────────────────
  Storyboard: Product teaser — 3 shots
  3 shot(s) to refine, 0 skipped.

Fetching capability profiles for 3 model(s) ...

Routing refiner LLM (complexity: complex, 3 shot(s)) ...
  Selected: Claude Sonnet 5 (anthropic/claude-sonnet-5) — reasoning: strong, $2/1M input tokens;
  cheapest of 6 qualifying Anthropic-hosted candidate(s) clearing the 'strong' reasoning bar.

Refining 3 shot prompt(s) with claude-sonnet-5 ...
```

**The refined-prompt transcript itself is a follow-up, not fabricated
here** — same convention `image-prompt-refiner`'s README follows for its
Claude-rewrite half: this session has no live `ANTHROPIC_API_KEY` (or a
production `MODELGLASS_API_KEY` — the routing table above was verified
directly against the registry source files instead, not a live MCP call).
Whoever runs this next with real keys should add the actual output as a
follow-up commit:

```bash
export MODELGLASS_API_KEY=<your-key>
export ANTHROPIC_API_KEY=<your-key>
npm run refine-shots -- --demo
```

---

## What's not here (intentional)

- **Video generation, compositing, or rendering** — this tool never calls a
  video provider. It only reads Modelglass registry data and produces
  refined prompt text.
- **Provider keys beyond Modelglass + Anthropic** — no Runway, OpenAI,
  Google, or other generation-provider credential is needed or used, even
  though shots may be assigned to non-Anthropic-hosted video models; this
  tool only refines the *prompt* for whatever model shot-plan-compiler
  picked, it doesn't call that model.
- **Routing across LLM providers for the refinement call itself** — the
  candidate pool is Anthropic-hosted only, for the reason stated above. A
  genuinely multi-provider version would need this repo to carry more than
  one LLM SDK/key, which no example here does today.
- **A default, always-on enhancement step** — this is opt-in, invoked
  separately from `shot-plan-compiler`, for shots where the result matters
  enough to justify the extra cost/latency.

---

---

Copyright © 2026 Modelglass Pty Ltd. Licensed under the MIT License — see [LICENSE](../LICENSE).
