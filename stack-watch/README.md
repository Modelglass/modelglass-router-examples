# stack-watch

Price-drift and deprecation watchdog for a fixed set of models your product
uses. Teams pick a model once and rarely re-evaluate — prices move (the live
Modelglass feed keeps append-only, provenance-stamped history for exactly
this reason), models get deprecated or superseded, and cheaper capable
alternatives appear. Nothing else surfaces that automatically; it's the
dataset's most defensible asset and easy to leave invisible.

**⚠️ Requires a Starter or Pro Modelglass key.** Unlike the other two
examples in this repo, there's no Free-tier mode here — see
[Requirements](#requirements) for why.

---

## Why Free isn't enough (read before setup)

Free-plan keys only see pricing history from the last ~2 days (ADR 0004).
Meaningful drift detection needs to look back further than that for any
realistic check-in cadence — a daily or weekly cron run needs to see
whatever changed *since the last run*, and a 2-day window doesn't reliably
cover that gap. There's no honest "degraded but useful" middle ground the
way the other two examples have one: a Free-tier attempt here would either
silently miss real price changes that fell outside the window, or report
"no drift" when the window just didn't reach back far enough — worse than
not running at all.

stack-watch checks the calling key's actual tier via `GET /v1/keys` before
attempting anything — not a guess based on the `mg_free_`/`mg_starter_`/
`mg_pro_` key-string prefix, but the tier the account was actually
provisioned at. On Free, it exits immediately with that explanation and a
link to upgrade. It does not run in a caveated/degraded mode.

---

## Requirements

- Node.js 20+
- A Modelglass **Starter or Pro** key — [pricing](https://modelglass.com.au/signup)
  (Starter: 12-month pricing-history window. Pro: full history, no window
  limit — the pricing-history gate, ADR 0004 internally)

---

## Setup

```bash
git clone https://github.com/Modelglass/modelglass-router-examples.git
cd modelglass-router-examples
npm install
export MODELGLASS_API_KEY=<your-starter-or-pro-key>
```

---

## Usage

**Run against the built-in demo stack** (one model per modality —
`openai/o4-mini`, `bfl/flux-1-1-pro`, `klingai/kling-2-1`,
`stability-ai/stable-audio-3-0`):

```bash
npm run watch
```

**Run against your own stack:**

```bash
node --import tsx/esm stack-watch/src/watch.ts my-stack.json
```

(Run from the repo root — dependencies and npm scripts are shared across
all examples in this repo; see the [root README](../README.md) for the
full example index.)

**Stack file format:**

```json
{
  "models": [
    "openai/o4-mini",
    "bfl/flux-1-1-pro",
    "klingai/kling-2-1",
    "stability-ai/stable-audio-3-0"
  ]
}
```

`models` is a flat, cross-modality list of Modelglass model ids — the same
id format used across the whole feed (`creator/model-name`), regardless of
whether the model is llm/image/video/audio, or also tracked by one of the
capability-vertical registries (coding/science/agentic — see
[What's excluded](#whats-not-here-intentional) for what that case does and
doesn't cover).

**Testing against a non-production API instance:** set `MODELGLASS_API_URL`
to override the base URL (default: `https://modelglass-api.vercel.app`) —
e.g. to point at a local `pnpm dev:api` instance from the main `modelglass`
repo. Not needed for normal use.

**Drop it into cron:**

```bash
# crontab: check daily at 9am, alert only when there's something actionable
0 9 * * * cd /path/to/modelglass-router-examples && MODELGLASS_API_KEY=... npm run watch -- my-stack.json || echo "stack-watch found drift" | mail -s "Stack alert" you@example.com
```

Exit code is `0` when the stack is unchanged (or on the first run — see
below), non-zero whenever there's something actionable, so it drops
straight into cron/CI without extra plumbing.

---

## How it works

1. Checks the key's tier via `GET /v1/keys` — exits immediately on Free
   (see above).
2. Fetches every model in the stack via one `GET /v1/models` call (the bulk
   response has the same per-model shape as `GET /v1/models/:modelId`, so
   one fetch covers a cross-modality stack regardless of size).
3. Compares against the prior run's snapshot
   (`logs/stack-snapshot.json`, gitignored, same pattern as the cost-aware
   router's `logs/routing-log.jsonl`) across three axes:
   - **Price** — current active price per tier vs. the snapshot's recorded
     price, citing the new `effective_from` and `source.url`.
   - **Lifecycle** — `status` (ga → deprecated/retired) and `generation`
     (current → previous).
   - **Capability** — any `capability_profile` dimension whose rating
     changed (e.g. `coding: strong → good`).
4. For each stack model rated `"strong"` on any dimension, checks
   `GET /v1/models/:modelId/competitors` for cheaper alternatives, then
   fetches each cheaper candidate's own `capability_profile` and suggests a
   switch only when the candidate matches `"strong"` on the same dimension —
   citing the specific fields (`capability_profile.<dimension>`,
   `tiers.pricing`), not just "cheaper."
5. **First run**: no prior snapshot exists, so there's nothing to diff
   against. Reports the current state as a baseline and says so explicitly
   — it does not report every model's current price/status/rating as "new."
   Writes the snapshot either way, so the *next* run has something to
   compare against.
6. Writes the new snapshot at the end of every run (baseline or not).

---

## Worked example — tier gate (real, verified run)

This is the actual, live output of `npm run watch -- --demo` against a real
Free-plan key, run 2026-07-06:

```
> node --import tsx/esm stack-watch/src/watch.ts --demo

stack-watch requires a Starter or Pro Modelglass key — this key is on the Free plan.

Why: meaningful drift detection needs to look back further than Free's ~2-day
pricing-history window covers for any realistic check-in cadence (daily/weekly
cron). There's no useful degraded mode here, unlike the other examples in this
repo — a Free-tier run would either miss real price changes silently or report
"no drift" when the window just didn't reach back far enough, which is worse
than not running at all.

Upgrade at https://modelglass.com.au/signup (Starter: 12-month pricing-history
window. Pro: full history, no window limit).
```

Exit code: `1`.

## Worked example — drift report (real, verified run against a local dev instance)

No Starter/Pro key existed against **production** while building this, so this
section was verified a different way: a **local instance of the Modelglass
API** (the exact same `packages/api` code, run via `pnpm dev:api` in the main
`modelglass` repo), authenticated with `mg_starter_devkey` — a fixed,
non-secret dev key that repo seeds automatically for local development only
(confirmed **no-op in production**, since it only seeds when
`UPSTASH_REDIS_REST_URL` is unset). `GET /v1/keys` against that instance
returns `"tier": "starter"` for it, same real signal `requireStarterOrPro()`
checks in production — so the tier gate itself, not just the report logic
downstream of it, is exercised for real here, just against a local server
instead of `modelglass-api.vercel.app`. Pointed at it via the optional
`MODELGLASS_API_URL` override (see [Usage](#usage)); everything else —
fetch, tier check, snapshot diffing, report rendering, exit code — is the
same code path production would run.

Two models already in that repo's own local registry
(`bfl/flux-1-1-pro`, `stability-ai/stable-image-ultra`) stood in for the
stack. First run recorded a real baseline against that (unmodified) local
data. To produce a genuine second-run diff without touching any source-of-
truth registry data, the tool's own local snapshot file
(`logs/stack-snapshot.json` — gitignored state, not registry data) was then
edited to record different prior values — the same effect as if the tool
had genuinely run once, weeks earlier, and the registry had moved on since.
The second run below diffed those edited prior values against the real,
unmodified current data from the local API — the drift computation, every
number in the output, and the exit code are all genuinely produced by the
tool, not hand-typed:

```
> node --import tsx/esm stack-watch/src/watch.ts local-dev-stack.json

Fetching 2 model(s) from http://localhost:8787 ...

────────────────────────────────────────────────────────────────────────────────
  stack-watch
────────────────────────────────────────────────────────────────────────────────

  PRICE CHANGES (1):
  FLUX 1.1 [pro] (replicate, default): $0.035/image → $0.04/image on 2026-06-09 — source: https://replicate.com/black-forest-labs/flux-1.1-pro

  LIFECYCLE CHANGES (1):
  Stable Image Ultra (stability-ai): status deprecated → ga

  CAPABILITY RATING CHANGES (1):
  FLUX 1.1 [pro]: photorealism good → strong

────────────────────────────────────────────────────────────────────────────────
```

Exit code: `1` (there's something actionable) — verified.

**No switch suggestion appeared, and that's the honest result, not an
omission**: `GET /v1/models/bfl%2Fflux-1-1-pro/competitors` was checked for
real against the same local instance, and every listed competitor was the
same price or more expensive — `computeSwitchSuggestions` only surfaces a
candidate when one is genuinely cheaper, so it correctly stayed silent here
rather than manufacturing a suggestion.

On a run with nothing to report, the tool prints `No drift since last run —
stack unchanged (N model(s) checked).` and exits `0` (covered by the
`computeDrift` "no drift" test in `src/lib.test.ts`, not separately
re-verified live).

**What's still unverified:** this confirms the tier gate and the full
drift/report pipeline work end-to-end against a real Starter-tier account —
just not against `modelglass-api.vercel.app` itself, and not yet against
Pro, against a stack spanning llm/video/audio (the demo stack does, but
wasn't used for this run — see below), or against a longer-lived snapshot
across a real time gap. Scott can confirm those once he has a production
Starter/Pro key.

---

## What's not here (intentional)

- **Coding/science/agentic benchmark-score drift** — SCO-166's original
  scope named coding/science/agentic alongside llm/image/video/audio as
  modalities a stack can reference. A model id can absolutely belong to one
  of those capability verticals — but the **paid API/MCP feed doesn't
  expose SWE-bench/GAIA/HLE benchmark data at all**, for any modality; that
  data lives only in the sibling repos' own artifacts
  (`modelglass-coding`/`-science`/`-agentic`), consumed exclusively by the
  modelglass.com.au website build, never surfaced through `/v1/` or the MCP
  tools. So a coding-focused stack entry still gets full pricing/lifecycle/
  `capability_profile.coding` (qualitative rating) drift — the same as any
  other model — just not a numeric benchmark-score delta, because the live
  feed a real customer calls has no such field to diff. (This mirrors
  `cost-aware-vscode-router`'s own approach: it extracts a SWE-bench
  Verified percentage from `capability_profile.coding.notes` free text via
  regex, when present, rather than from a dedicated benchmark endpoint —
  there isn't one.) Re-confirmed live against production on 2026-07-06:
  `GET /v1/benchmarks` still returns only the seven image-modality ontology
  benchmarks (`clip-score`, `dpg-bench`, `fid`, `geneval`, `hpsv2`,
  `pickscore`, `t2i-compbench`); `openai/o4-mini`'s
  `knowledge.benchmarks` field is `null`; its SWE-bench Verified score
  (68.1%) only exists as free text inside
  `capability_profile.coding.notes`, exactly the shape
  `cost-aware-vscode-router`'s regex already handles.
- **Provider-level outage/latency monitoring** — this watches the
  registry's pricing/lifecycle/capability data, not live API uptime for
  each provider.
- **Automatic switching** — suggestions are grounded and cited, but nothing
  here calls a provider API or changes your actual routing; that decision
  stays with you.
- **Multi-account/team snapshot sharing** — the snapshot is a local
  gitignored file, same as the cost-aware router's log. No shared state.
- **Hosted/live demo** — CLI example only, meant to be read and adapted.

---

Copyright © 2026 Modelglass Pty Ltd. Licensed under the MIT License — see [LICENSE](../LICENSE).
