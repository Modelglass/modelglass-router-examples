<p align="center"><strong>Eight worked examples of building on the live Modelglass pricing + capability feed — cost-aware routing, prompt refinement grounded in per-model capability data, price-drift watching, migration diffing, and cross-host cost ranking for image/video/audio jobs.</strong></p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-green.svg?style=flat-square" alt="Node.js >= 20"></a>
  <a href="https://modelglass.com.au/api-docs"><img src="https://img.shields.io/badge/Documentation-modelglass.com.au%2Fapi--docs-blue.svg?style=flat-square" alt="Documentation"></a>
  <a href="#setup"><img src="https://img.shields.io/badge/Quickstart-jump%20to%20setup-blue.svg?style=flat-square" alt="Quickstart"></a>
  <a href="https://modelglass.com.au/signup"><img src="https://img.shields.io/badge/API%20key-free%2C%20no%20card-blue.svg?style=flat-square" alt="Free API key"></a>
</p>

# modelglass-router-examples

## What Modelglass is

[Modelglass](https://modelglass.com.au) is a pricing-and-capability data
layer for AI models — image, video, audio, and LLM — built as a sourced,
append-only registry: every price carries a source URL and the date it was
verified, and a repricing is a new dated entry, never a silent overwrite.
It's served two ways: a free comparison site, and a paid **read API + MCP
server** (`https://modelglass-api.vercel.app`, `POST /mcp`) for operators
wiring model pricing into their own routing or tooling. Modelglass isn't a
router or a gateway itself — it doesn't proxy your traffic or pick a model
at runtime. It's the data other people's routing logic (including every
example in this repo) reads.

## What this repo demonstrates

Each top-level directory is a small, self-contained, **read-and-adapt** code
example of using that feed as grounding context for an LLM-powered tool —
not a hosted demo, not something you install as a package. Every example
answers a real question you'd otherwise answer by hand: which model is
cheapest for this task and still clears a quality bar, does this prompt
actually fit the model I picked, has this model's price moved since I last
checked, what would switching models actually cost and gain me, what would
this batch job cost across every host that sells the model.

## Examples

| Example | Modality | What it demonstrates | Link |
|---|---|---|---|
| `cost-aware-vscode-router` | LLM (text) | Routes each subtask of a dev task to the cheapest LLM that clears a confirmed-benchmark quality bar, using the live Modelglass LLM feed as the model pool. | [README](cost-aware-vscode-router/README.md) |
| `av-prompt-refiner` | Video, Audio | Given a rough prompt and one or two already-chosen models, pulls MCP capability-profile data (prompt conventions, supported params, known quirks) and rewrites the prompt to fit that model specifically — including a coordinated video+audio mode that reasons across both profiles at once. | [README](av-prompt-refiner/README.md) |
| `stack-watch` | LLM, image, video, audio (cross-modality) | Price-drift and deprecation watchdog for a fixed list of models — flags price changes, deprecations/supersessions, and grounded cheaper-alternative suggestions since the last run. **Requires a Starter or Pro key** — the only example that doesn't run on Free (a 2-day pricing-history window isn't enough for meaningful drift detection at any realistic check-in cadence). | [README](stack-watch/README.md) |
| `image-batch-coster` | Image | Cross-host cost ranking for an image-generation batch job — normalizes `per_image`/`per_megapixel` pricing to a cost-per-job, calls out same-model different-host price spreads, and honestly refuses to force-convert `per_credit`/`per_month` offerings into a fake estimate. Free-tier friendly, no LLM call. | [README](image-batch-coster/README.md) |
| `switch-check` | LLM, image, video, audio (cross-modality) | Grounded migration diff for a model switch you're considering (`--from X --to Y`, or `--from` alone to diff against the feed's own competitor list) — unit-matched price delta, price *stability* from the append-only history ("cheaper today — but is that a month-old cut or a year-old rate?"), per-dimension capability gains/losses, billing-unit cost-curve warnings, and lifecycle checks in both directions. Evidence, not a verdict. Works on every tier including Free; paid tiers deepen the stability section and the output says exactly how. | [README](switch-check/README.md) |
| `shot-plan-compiler` | Video | Storyboard-in, execution-plan-out: per-shot model pick from the live video registry with field-cited rationale, a chain-feasibility check on every shot-to-shot handoff (fps mismatches, resolution steps, silent-to-native-audio seams, shots exceeding `max_clip_duration` needing a split), and a total job cost with the same honest-unit discipline as image-batch-coster. Planner only — no generation calls, no compositing. | [README](shot-plan-compiler/README.md) |
| `image-prompt-refiner` | Image | Given a rough prompt and an already-chosen image model, pulls MCP capability-profile data and rewrites the prompt to fit — `--mode generate` for pure text-to-image, `--mode edit` for image-editing models (existing image + instruction), mirroring the real generation/editing split the image ontology itself draws. Sibling to `av-prompt-refiner` for the image vertical. | [README](image-prompt-refiner/README.md) |
| `shot-prompt-refiner` | Video | Refines each shot's rough prompt to fit the model shot-plan-compiler picked for it, grounded in that model's live capability data — one combined LLM call across the whole storyboard for cross-shot consistency, with the refiner LLM itself routed off the live LLM feed (cheap/fast for a single shot, stronger reasoning for a multi-shot job) rather than hardcoded. Opt-in, not a default step — makes a real LLM call, but never a video-generation call. Pairs with `shot-plan-compiler`: plan the shots there, refine the prompts here. | [README](shot-prompt-refiner/README.md) |

## Requirements

- Node.js 20+
- A Modelglass API key ([get a free one](https://modelglass.com.au/signup), no card) — required by every example
- `av-prompt-refiner`, `image-prompt-refiner`, and `shot-prompt-refiner` additionally require an Anthropic API key (`ANTHROPIC_API_KEY`) — see each one's own README
- `stack-watch` additionally requires that key to be **Starter or Pro**, not Free — see its own README for why

## Setup

```bash
git clone https://github.com/Modelglass/modelglass-router-examples.git
cd modelglass-router-examples
npm install
export MODELGLASS_API_KEY=<your-key>
```

Dependencies and npm scripts are shared at the repo root across all examples — each example's own README documents its specific `npm run` commands.

## Development

```bash
npx tsc --noEmit   # typecheck every example
npm test           # run every example's test suite (node:test)
```

Both run in CI (`.github/workflows/validate.yml`) on every PR and push to `main`.

## What's not here (intentional, across every example)

- **Hosted/live demos** — these are CLI/code examples meant to be read and adapted, not run as hosted tools.
- **Model selection logic** — each example assumes the caller has already chosen their target model(s); routing/selection is each example's own concern, not a shared capability.
- **Actual generation calls, compositing, or rendering** — every example plans, ranks, or reports; none of them calls a generation provider, stitches media, or spends money. `shot-plan-compiler` is explicit about this in its own README since "compiler" could otherwise read as "and then it builds the video."

## Contributing

Bug reports, fixes, and new examples are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md).

To report a security vulnerability, follow [SECURITY.md](SECURITY.md)
instead of opening a public issue.

## Talk to us

Questions about Modelglass itself, these examples, or the underlying data —
email **scott@modelglass.com.au**.

---

Copyright © 2026 Modelglass Pty Ltd. Licensed under the MIT License — see [LICENSE](LICENSE).
