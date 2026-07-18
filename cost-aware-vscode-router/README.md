# Cost-Aware VS Code Router

Cost-aware task router for development workflows. Routes each subtask of an
incoming dev task to the **cheapest LLM that can handle it**, using the live
[Modelglass](https://modelglass.com.au) feed as the model pool.

Coding subtasks (write/debug code) go to the cheapest model with a **curated
SWE-bench Verified score** in the Modelglass registry. Writing subtasks (PR
descriptions, commit messages, docs) go to the cheapest model with strong
instruction-following. No token spend on premium models for work that doesn't
need them.

---

## Background

This is the CLI-script core of SCO-139 (VS Code cost-aware task router). The
full design spec is in
[`docs/specs/sco-139-orchestrator-routing-design.md`](https://github.com/Modelglass/modelglass/blob/main/docs/specs/sco-139-orchestrator-routing-design.md)
in the main Modelglass repo.

**Placement decision (2026-07-01):** this repo is the canonical home for the
routing logic. The VS Code extension, MCP tool, and CLI wrapper all build on top
of this core.

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

---

## Usage

**Run the built-in demo task:**

```bash
npm run demo
```

**Route a custom task from a JSON file:**

```bash
node --import tsx/esm cost-aware-vscode-router/src/route.ts my-task.json
```

(Run from the repo root — dependencies and npm scripts are shared across all examples in this repo; see the [root README](../README.md) for the full example index.)

**Task file format:**

```json
{
  "description": "One-line description of the overall task",
  "subtasks": [
    {
      "description": "Write the auth middleware",
      "tag": "coding",
      "minSweBenchVerified": 65,
      "estimatedInputTokens": 8000,
      "estimatedOutputTokens": 2000
    },
    {
      "description": "Write the PR description",
      "tag": "writing",
      "estimatedInputTokens": 2000,
      "estimatedOutputTokens": 400
    }
  ]
}
```

Tags: `coding` (write/edit/debug code), `writing` (prose), `general` (anything else).  
Token estimates are optional — omit them to skip cost projection.  
`minSweBenchVerified` is optional (0-100). Coding subtasks with it set only
consider models whose curated SWE-bench Verified score clears the threshold —
omit it to fall back to "any confirmed-score model qualifies." A model with no
curated score at all is still excluded either way (see "How it works").

---

## How it works

The router calls `GET /v1/models?modality=llm` on the live Modelglass feed, then
applies two selection rules:

**Coding subtasks** — filter `capability_profile.coding == "strong"`, rank by
the SWE-bench Verified score read from the feed's structured
`knowledge.benchmarks` field (not `quality_tier` — qualitative ratings are
excluded, and the score is **not** parsed out of prose notes). These scores are
curated in the Modelglass coding-capability registry — the same data behind
[modelglass.com.au/coding](https://modelglass.com.au/coding) — and every entry
carries provenance: a source URL and its type (`vendor` / `leaderboard` /
`paper` / `independent`), which the routing table displays next to each score.
Models with no curated SWE-bench Verified score are shown as excluded with the
reason, not silently skipped — including the case where a model has a score
for a *different* benchmark (SWE-bench Pro). Each offering in the feed carries
its own `provider`; picking the cheapest offering means picking a specific
*host*, not just a model, and the routing table names it — "same model,
different host, different price" is a real Modelglass fact this tool doesn't
discard on the way to a recommendation.

If any coding subtask sets `minSweBenchVerified`, the router takes the
**highest** threshold across all coding subtasks in the task (one model is
still selected for every coding subtask — see "What's not here" — so it has to
clear the strictest bar any of them set) and filters the ranked pool down to
models whose score meets or exceeds it *before* picking cheapest. A model with
a real, confirmed score that still falls short is marked `✗ below quality bar`
in the table and named explicitly in the exclusion list with its actual score
and the required threshold — it's a genuine filter, not a description. Omit
`minSweBenchVerified` entirely to fall back to the original behaviour (any
confirmed-score model qualifies, cheapest wins).

**Writing / general subtasks** — filter `instruction_following in [strong, good]`,
ignore the coding filter entirely. Select the cheapest qualifying model.

**Escalation** — if a coding subtask fails correctness review, retry on the
next model up the ranked pool's cost ladder. Walk up one step at a time;
don't jump straight to the most expensive option. The suggested next step
always still clears the quality bar itself — escalating to a cheaper-in-theory
model that fails the same threshold the original pick had to clear would be a
worse recommendation, not a better one. If nothing in the pool qualifies as a
next step, no escalation is suggested at all (see the worked example below).
When you follow an escalation suggestion, log it with `npm run report --
... --escalated` so it's tracked as its own category distinct from a plain
override — see "Measuring real savings" below.

---

## Worked example — rate-limiting middleware (2026-07-12)

This is the output of `npm run demo` against the live feed on 2026-07-12 (the
model pool moves as the registry does — your run may differ). The demo task's
coding subtasks set `minSweBenchVerified: 65`:

**Task:** Add per-endpoint rate limiting middleware to the Modelglass API
(Redis KV, 429/Retry-After, unit tests, PR description, Slack summary).

```
────────────────────────────────────────────────────────────────────────────────
  Modelglass Task Router
────────────────────────────────────────────────────────────────────────────────
  Task: Add per-endpoint rate limiting middleware to the Modelglass API (Redis KV, 429/Retry-After, unit tests, PR description, Slack summary).
────────────────────────────────────────────────────────────────────────────────

  CODING MODEL POOL  (coding=strong, ranked by SWE-bench Verified, min. SWE-bench Verified 65%)

  Model                    Provider           SWE-bench Verified (source, type)    Input/1M     Output/1M
  ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  o4-mini                  openai             68.1%  (openai.com, vendor)          $1.1         $4.4  ← selected
  Gemini 2.5 Pro           google-deepmind    63.8%  (deepmind.google, vendor)     $1.25        $10  ✗ below quality bar

  Excluded from the ranked pool:
  ✗ Claude Fable 5: no curated SWE-bench Verified score in the Modelglass registry
  ✗ Claude Sonnet 5: has a curated SWE-bench Pro score (different benchmark) — not SWE-bench Verified
  ✗ Gemini 3.1 Pro: no curated SWE-bench Verified score in the Modelglass registry
  ✗ Gemini 3.5 Flash: no curated SWE-bench Verified score in the Modelglass registry
  ✗ GPT-5.6 Sol: no curated SWE-bench Verified score in the Modelglass registry
  ✗ Mistral Large 3: no curated SWE-bench Verified score in the Modelglass registry
  ✗ Qwen 3 235B-A22B: no curated SWE-bench Verified score in the Modelglass registry
  ✗ Gemini 2.5 Pro: SWE-bench Verified 63.8% is below the required threshold of 65%

  WRITING/GENERAL MODEL  (instruction_following=strong|good, cheapest)

  Llama 4 Scout (together-ai)  Input $0.1/1M  Output $0.3/1M  ← selected

────────────────────────────────────────────────────────────────────────────────
  ROUTING TABLE

  #   Subtask                                            Tag        Model                Est. in    Est. out   Est. cost
  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  1   Implement rate-limit middleware (Upstash KV, ...   coding     o4-mini              10000      2500       $0.022
  2   Write unit tests (pass/reject/tier-boundary)       coding     o4-mini              8000       2000       $0.018
  3   Write PR description explaining the change an...   writing    Llama 4 Scout        3000       500        $0.00045
  4   Write Slack summary for the team announcing t...   writing    Llama 4 Scout        2000       200        $0.00026
  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
                                                                                                    Total      $0.040

────────────────────────────────────────────────────────────────────────────────
```

**Why o4-mini, and why no escalation line?** o4-mini (68.1%) clears the 65%
bar and is the cheapest input price in the pool ($1.10/1M) — cheapest-ranked
selection picks it outright. Gemini 2.5 Pro is genuinely excluded, not just
out-ranked: its real curated score (63.8%) is below the threshold, named
explicitly with both numbers rather than silently losing on price. That's also
why no escalation suggestion appears this run — on today's data, Gemini 2.5
Pro is the only other confirmed-score candidate, and it doesn't qualify either,
so there's honestly nothing to escalate to. Note the provenance column: both
scores are vendor-published numbers (`openai.com`, `deepmind.google`), shown
as such rather than laundered into unqualified facts, and Claude Sonnet 5's
exclusion names the actual data condition (a SWE-bench **Pro** score is not a
SWE-bench **Verified** score).

---

## Measuring real savings

The router recommends but doesn't execute. After you run each subtask using the
recommended model, feed the real token counts back with `npm run report`:

```bash
# After completing subtask 1 of the demo task using o4-mini:
npm run report -- --task demo --subtask 1 \
  --model o4-mini \
  --actual-input 9500 --actual-output 2100
```

If the actual model differs from the recommendation because you followed an
**escalation** suggestion (the recommended model failed correctness review and
you retried on the next model up the cost ladder), add `--escalated`:

```bash
# Recommended model failed review; escalated to Gemini 2.5 Pro per the
# router's suggestion:
npm run report -- --task demo --subtask 1 \
  --model "Gemini 2.5 Pro" \
  --actual-input 9500 --actual-output 2600 --escalated
```

Without `--escalated`, a different actual model is logged as an **override**
instead — some other reason the caller used a different model, not a
retry-after-failure. This distinction is tracked per entry
(`deviation_type: "none" | "escalation" | "override"`) and reported as two
separate categories by `npm run summary`, not folded into one generic
"different model than recommended" bucket.

Each call appends one line to `logs/routing-log.jsonl` (gitignored — stays local).
The entry records: recommended model, estimated tokens/cost, actual model used,
actual tokens, actual cost, deviation type, and a hypothetical baseline (what
those tokens would have cost at the most expensive model in the pool).

Once you've logged a few subtasks, run the summary:

```bash
npm run summary
```

This prints total actual spend, total estimated spend, savings vs the
hypothetical always-expensive-model baseline in both $ and %, and separate
counts of escalations vs overrides.

**Why the router doesn't execute subtasks itself:** this stays a minimal,
zero-provider-credential reference implementation by design, not because
execution is rejected as a goal — execution now genuinely exists, just
elsewhere. [`modelglass-vscode` 0.3.0+](https://github.com/Modelglass/modelglass-vscode/releases/tag/v0.3.0)
(Marketplace: [`modelglass.cost-aware-router`](https://marketplace.visualstudio.com/items?itemName=modelglass.cost-aware-router))
ships a `Run Task` command that ranks the same way this script does, then
calls the top-ranked model directly using a provider key you supply (BYOK —
Starter: one key; Pro: multiple keys with automatic fallback). That execution
layer is original code in `modelglass-vscode`
([`src/routing-engine.ts`, `src/run-task*.ts`, `src/provider-*.ts` — see its
README](https://github.com/Modelglass/modelglass-vscode#relationship-to-cost-aware-vscode-router)),
not built on this repo. This script — and the extension's separate,
still-recommend-only `Route Task` command that vendors it — intentionally
keeps zero provider credentials, so the report-back workflow below (B2) is
what lets real token counts flow in from whatever tool you actually used to
run each subtask: Claude Code, a custom agent, direct API calls, or now
`Run Task` itself.

---

## What's not here (intentional)

- **Token-spend measurement/tracking** — deferred; see SCO-139.
- **VS Code extension** — `Route Task`'s ranking is surface layer, vendoring
  this script directly; its separate `Run Task` command (0.3.0+) adds
  independent execution using your own provider key, not built on this repo —
  see "Why the router doesn't execute subtasks itself" above.
- **MCP tool** — same (surface layer, not yet built — SCO-235).
- **Task decomposition** — the caller tags subtasks at decomposition time.
  No router-calling-a-router.

---

Copyright © 2026 Modelglass Pty Ltd. Licensed under the MIT License — see [LICENSE](../LICENSE).
