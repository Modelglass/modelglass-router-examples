# modelglass-router-examples

Worked examples of building on top of the live [Modelglass](https://modelglass.com.au) pricing and capability feed — each one demonstrates a different way of using Modelglass data as grounding context for an LLM-powered tool. These are code examples meant to be read and adapted, not hosted/live demos.

## Examples

| Example | Modality | What it demonstrates | Link |
|---|---|---|---|
| `cost-aware-vscode-router` | LLM (text) | Routes each subtask of a dev task to the cheapest LLM that clears a confirmed-benchmark quality bar, using the live Modelglass LLM feed as the model pool. | [README](cost-aware-vscode-router/README.md) |
| `av-prompt-refiner` | Video, Audio | Given a rough prompt and one or two already-chosen models, pulls MCP capability-profile data (prompt conventions, supported params, known quirks) and rewrites the prompt to fit that model specifically — including a coordinated video+audio mode that reasons across both profiles at once. | [README](av-prompt-refiner/README.md) |
| `stack-watch` | LLM, image, video, audio (cross-modality) | Price-drift and deprecation watchdog for a fixed list of models — flags price changes, deprecations/supersessions, and grounded cheaper-alternative suggestions since the last run. **Requires a Starter or Pro key** — the only example that doesn't run on Free (a 2-day pricing-history window isn't enough for meaningful drift detection at any realistic check-in cadence). | [README](stack-watch/README.md) |
| `image-batch-coster` | Image | Cross-host cost ranking for an image-generation batch job — normalizes `per_image`/`per_megapixel` pricing to a cost-per-job, calls out same-model different-host price spreads, and honestly refuses to force-convert `per_credit`/`per_month` offerings into a fake estimate. Free-tier friendly, no LLM call. | [README](image-batch-coster/README.md) |
| `switch-check` | LLM, image, video, audio (cross-modality) | Grounded migration diff for a model switch you're considering (`--from X --to Y`, or `--from` alone to diff against the feed's own competitor list) — unit-matched price delta, price *stability* from the append-only history ("cheaper today — but is that a month-old cut or a year-old rate?"), per-dimension capability gains/losses, billing-unit cost-curve warnings, and lifecycle checks in both directions. Evidence, not a verdict. Works on every tier including Free; paid tiers deepen the stability section and the output says exactly how. | [README](switch-check/README.md) |
| `shot-plan-compiler` | Video | Storyboard-in, execution-plan-out: per-shot model pick from the live video registry with field-cited rationale, a chain-feasibility check on every shot-to-shot handoff (fps mismatches, resolution steps, silent-to-native-audio seams, shots exceeding `max_clip_duration` needing a split), and a total job cost with the same honest-unit discipline as image-batch-coster. Planner only — no generation calls, no compositing. | [README](shot-plan-compiler/README.md) |

## Requirements

- Node.js 20+
- A Modelglass API key ([get a free one](https://modelglass.com.au/signup)) — required by every example
- `av-prompt-refiner` additionally requires an Anthropic API key (`ANTHROPIC_API_KEY`) — see its own README
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

---

Copyright © 2026 Modelglass Pty Ltd. Licensed under the MIT License — see [LICENSE](LICENSE).
