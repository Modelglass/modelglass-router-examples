# switch-check

Grounded migration diff for a model switch you're considering. stack-watch and
the news feed tell you a switch *might* be worth it — nothing evaluates one.
switch-check takes `--from` and `--to` model ids and prints what the live
Modelglass feed can actually prove about the move: the unit-matched price
delta, how stable each price has been (from the append-only, provenance-stamped
history — the part no scraper of current pricing pages can answer), the
capability ratings you'd gain or lose, billing-unit changes that reshape the
cost curve, and lifecycle status in both directions. Every line cites the feed
field it came from, and it deliberately stops short of a recommendation —
evidence, not a verdict. Works on every plan tier, including Free.

**Works on a Free key.** The current-price delta, capability diff, unit
warnings, and lifecycle checks are all computed from data every tier sees in
full. The price-*stability* section is computed from whatever slice of the
pricing history your plan's window exposes (ADR 0004 internally), and says so
in the output: on Free it states, for that specific run, exactly what Starter
(12-month window) and Pro (full history) would add.

---

## Requirements

- Node.js 20+
- A Modelglass API key on **any tier** — [get a free one](https://modelglass.com.au/signup).
  (Free: ≈2-day pricing-history window. Starter: 12 months. Pro: full history.
  The current price is always visible on every tier.)

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

**Diff a specific pair:**

```bash
npm run check -- --from bfl/flux-1-1-pro --to bfl/flux-1-dev
```

**Or give only `--from`** — candidates then come from the feed's own
`GET /v1/models/:modelId/competitors` list (the registry's curated
`closest_competitors`), and each candidate that resolves to a distinct model
in the feed gets the full diff. Candidates that don't resolve (or that are the
same model on a different host — a hosting decision, not a migration) are
listed with the reason, not silently dropped:

```bash
npm run check -- --from bfl/flux-1-1-pro
```

Model ids are the standard cross-modality feed format (`creator/model-name`)
— llm, image, video, and audio models all work.

(Run from the repo root — dependencies and npm scripts are shared across all
examples in this repo; see the [root README](../README.md) for the full
example index.)

**Testing against a non-production API instance:** set `MODELGLASS_API_URL`
to override the base URL (default: `https://modelglass-api.vercel.app`) —
e.g. to point at a local `pnpm dev:api` instance from the main `modelglass`
repo. Not needed for normal use.

**Exit codes:** `0` whenever the diff was produced — a warning in the output
is evidence for you to weigh, not a failure state (this tool renders no
verdict, so it doesn't gate CI the way stack-watch's drift exit code does).
Non-zero only on real errors (unknown model id, missing key, API failure).

---

## How it works

1. Looks up the calling key's actual plan tier via `GET /v1/keys` — the same
   real account-record signal stack-watch checks. Unlike stack-watch this is
   **not a gate**: every tier runs. The tier decides how the price-stability
   section is framed — which history window the numbers were computed under,
   and (on Free) what a wider window would add to this specific run.
2. Fetches the whole feed via one `GET /v1/models?generation=all` call —
   `generation=all` because a migration diff must be able to say "the model
   you're moving TO is previous-gen," which requires previous-gen models to
   be in the pool at all.
3. Prints four sections, every claim citing its field:
   - **Price** — for every billing unit priced on *both* sides, the cheapest
     current price on each, compared apples-to-apples (the same same-unit-only
     rule the API's own competitor ranking uses). Then **stability**, from the
     append-only history: how long each current price has been in force
     (`effective_from`), and — where the plan window shows it — what it
     changed from, in which direction, and per which source. A 40%-cheaper
     price that was cut three weeks ago and a 40%-cheaper price that's held
     for a year are different facts, and only time-versioned history can tell
     them apart.
   - **Capability diff** — per-dimension `capability_profile` comparison
     across the union of both models' rated dimensions: lose / gain / same,
     with dimensions rated on only one side reported as *cannot verify* —
     never assumed either way.
   - **Billing units** — units priced on one side only are never
     force-converted (image-batch-coster's honest-unit discipline); instead
     the cost-curve change is named, e.g. per_image → per_megapixel means
     cost starts scaling with resolution.
   - **Lifecycle** — `status` and `generation` in both directions: non-ga or
     previous-gen on the TO side is a warning (you'd be migrating onto a
     model already on its way out); the same on the FROM side is
     informational context (it explains the pressure to switch).
4. Ends every diff with the same line: *evidence, not a verdict*. Nothing
   here recommends, scores, or ranks the migration — that call stays with
   you.

---

## Worked example — Free key (real, verified run against production)

Actual, live output of the command below against `modelglass-api.vercel.app`,
authenticated with a Free-plan key provisioned that day, run 2026-07-10:

```
> npm run check -- --from bfl/flux-1-1-pro --to bfl/flux-1-dev

Fetching feed from https://modelglass-api.vercel.app ...
Plan tier (via GET /v1/keys): free

────────────────────────────────────────────────────────────────────────────────────────────────
  switch-check — bfl/flux-1-1-pro → bfl/flux-1-dev
  (FLUX 1.1 [pro] → FLUX.1 [dev])
────────────────────────────────────────────────────────────────────────────────────────────────

  1. PRICE — current, unit-matched (fields: tiers.pricing[].amount, .unit)
  per_image: $0.04/image (replicate) → $0.025/image (replicate)  -37.5% cheaper
  per_megapixel: $0.04/megapixel (fal) → $0.025/megapixel (together)  -37.5% cheaper

  PRICE STABILITY — window: Free plan — ≈2-day window (current price always visible)
  (fields: tiers.pricing[].effective_from, .effective_to, .source.url)
  [from] FLUX 1.1 [pro]:
    fal/default: $0.04/megapixel since 2026-06-09 (31 days) — no earlier entry in window — source: https://fal.ai/models/fal-ai/flux-pro/v1.1
    replicate/default: $0.04/image since 2026-06-09 (31 days) — no earlier entry in window — source: https://replicate.com/black-forest-labs/flux-1.1-pro
  [to  ] FLUX.1 [dev]:
    replicate/default: $0.025/image since 2026-06-10 (30 days) — no earlier entry in window — source: https://replicate.com/pricing
    together/default: $0.025/megapixel since 2026-06-10 (30 days) — no earlier entry in window — source: https://docs.together.ai/docs/serverless-models

  This key's ≈2-day Free window shows each price's current entry only (unless it changed
  within the window). The current entry keeps its real effective_from — so the price AGES
  above are honest — but anything a price changed FROM is outside the window.

  On this exact run, Starter (12-month window) would show every price change since
  2025-07-10 for FLUX 1.1 [pro] and FLUX.1 [dev] (if any) — including whether either
  current price is a recent cut or a long-standing rate. Pro removes the window entirely:
  the full append-only history, every entry with effective_from + source provenance.
  Upgrade: https://modelglass.com.au/signup — fields unlocked: tiers.pricing[] (earlier entries)

  2. CAPABILITY DIFF (fields: knowledge.capability_profile[].dimension, .rating)
  LOSE  resolution-ceiling: strong → moderate
  LOSE  text-rendering: strong → moderate
  same  artistic-range: strong; compositional-accuracy: strong; inference-speed: moderate; photorealism: strong; prompt-adherence: strong

  3. BILLING UNITS (fields: tiers.pricing[].unit)
  No cost-curve change: every unit priced on one side is also priced on the other (per_image, per_megapixel). Deltas in section 1 are all same-unit.

  4. LIFECYCLE (fields: model.status, model.generation)
  Both directions clear: every offering on both sides is status=ga, generation=current.

────────────────────────────────────────────────────────────────────────────────────────────────
  Evidence, not a verdict — every line above cites the feed field it came from;
  whether to migrate stays your call.
────────────────────────────────────────────────────────────────────────────────────────────────
```

Exit code: `0`.

## Worked example — the same pair on Pro (real, verified run against a local dev instance)

No Pro key existed against production while building this, so — same approach
as stack-watch's paid-tier worked example — this run used a **local instance
of the Modelglass API** (the exact same `packages/api` code, run via
`pnpm dev:api` in the main `modelglass` repo), authenticated with
`mg_pro_devkey`, a fixed non-secret dev key that repo seeds for local
development only (a no-op in production, where the KV key store takes over).
`GET /v1/keys` against that instance returns `"tier": "pro"` — the same real
signal the framing logic reads in production. Same command, same pair; the
only line that changes in section 1's stability block is the one the Free
window was hiding:

```
  [to  ] FLUX.1 [dev]:
    replicate/default: $0.025/image since 2026-06-10 (30 days) — CUT from $0.03/image (-16.7%) — source: https://replicate.com/pricing
```

That's the whole pitch in one line: on Free, FLUX.1 [dev] simply looks 37.5%
cheaper. With history access, the feed shows that price is a **one-month-old
cut** — recent enough that "is this a teaser rate?" is a fair question to ask
before migrating, and answerable only because the registry keeps append-only,
provenance-stamped history (the Pro view also shows the superseded $0.03
entry's own source URL, so the cut itself is verifiable, not asserted).

---

## What's not here (intentional)

- **A verdict** — no score, no recommendation, no "you should switch." The
  output is the evidence a migration decision needs, with fields cited so you
  can check every claim; weighing it is your job (the same
  propose-don't-decide stance the Modelglass ingestion agents apply to
  registry writes, applied to output tone).
- **Cost-per-job arithmetic** — this diffs per-unit rates; sizing a specific
  batch job's cost across units and hosts is image-batch-coster's whole job.
- **Drift over time** — this is a point-in-time evaluation of one candidate
  switch; watching a stack for changes between runs is stack-watch's job.
  Detect (stack-watch) → evaluate (switch-check) → act (you).
- **Quality benchmarking** — the capability diff reports the registry's
  qualitative `capability_profile` ratings; it does not run generations or
  fetch benchmark scores (the paid feed exposes no numeric benchmark fields —
  see stack-watch's README for the details).
- **Automatic switching** — nothing here calls a provider API or changes your
  routing.
- **Hosted/live demo** — CLI example only, meant to be read and adapted.

---

Copyright © 2026 Modelglass Pty Ltd. Licensed under the MIT License — see [LICENSE](../LICENSE).
