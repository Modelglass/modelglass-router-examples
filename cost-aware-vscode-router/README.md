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
      "qualityBar": "Must handle JWT edge cases correctly",
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
Select the cheapest ranked candidate. Models with no curated SWE-bench Verified
score are shown as excluded with the reason, not silently skipped — including
the case where a model has a score for a *different* benchmark (SWE-bench Pro).

**Writing / general subtasks** — filter `instruction_following in [strong, good]`,
ignore the coding filter entirely. Select the cheapest qualifying model.

**Escalation** — if a coding subtask fails correctness review, retry on the
next model up the ranked pool's cost ladder. Walk up one step at a time;
don't jump straight to the most expensive option.

---

## Worked example — rate-limiting middleware (2026-07-09)

This is the output of `npm run demo` against the live feed on 2026-07-09 (the
model pool moves as the registry does — your run may differ):

**Task:** Add per-endpoint rate limiting middleware to the Modelglass API
(Redis KV, 429/Retry-After, unit tests, PR description, Slack summary).

```
────────────────────────────────────────────────────────────────────────────────
  Modelglass Task Router
────────────────────────────────────────────────────────────────────────────────
  Task: Add per-endpoint rate limiting middleware to the Modelglass API (Redis KV, 429/Retry-After, unit tests, PR description, Slack summary).
────────────────────────────────────────────────────────────────────────────────

  CODING MODEL POOL  (coding=strong, ranked by SWE-bench Verified)

  Model                        SWE-bench Verified (source, type)    Input/1M     Output/1M
  ──────────────────────────────────────────────────────────────────────────────────────────
  o4-mini                      68.1%  (openai.com, vendor)          $1.1         $4.4  ← selected
  Gemini 2.5 Pro               63.8%  (deepmind.google, vendor)     $1.25        $10  

  Excluded from the ranked pool:
  ✗ Claude Fable 5: no curated SWE-bench Verified score in the Modelglass registry
  ✗ Claude Sonnet 5: has a curated SWE-bench Pro score (different benchmark) — not SWE-bench Verified
  ✗ Gemini 3.1 Pro: no curated SWE-bench Verified score in the Modelglass registry
  ✗ Gemini 3.5 Flash: no curated SWE-bench Verified score in the Modelglass registry
  ✗ GPT-5.5: no curated SWE-bench Verified score in the Modelglass registry
  ✗ Mistral Large 3: no curated SWE-bench Verified score in the Modelglass registry
  ✗ Qwen 3 235B-A22B: no curated SWE-bench Verified score in the Modelglass registry

  WRITING/GENERAL MODEL  (instruction_following=strong|good, cheapest)

  Llama 4 Scout  Input $0.1/1M  Output $0.3/1M  ← selected

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

  Escalation: if coding subtasks fail correctness review → retry on Gemini 2.5 Pro (SWE-bench Verified 63.8%, $1.25/1M input)

────────────────────────────────────────────────────────────────────────────────
```

**Why o4-mini?** In the current ranked pool it has both the highest curated
SWE-bench Verified score (68.1%) and the cheapest input price ($1.10/1M), so
cheapest-ranked selection picks it outright — no score/price tradeoff arises on
today's data. Note the provenance column: both ranked scores are
vendor-published numbers (`openai.com`, `deepmind.google`), shown as such
rather than laundered into unqualified facts, and Claude Sonnet 5's exclusion
names the actual data condition (a SWE-bench **Pro** score is not a SWE-bench
**Verified** score).

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

Each call appends one line to `logs/routing-log.jsonl` (gitignored — stays local).
The entry records: recommended model, estimated tokens/cost, actual model used,
actual tokens, actual cost, and a hypothetical baseline (what those tokens would
have cost at the most expensive model in the pool).

Once you've logged a few subtasks, run the summary:

```bash
npm run summary
```

This prints total actual spend, total estimated spend, and savings vs the
hypothetical always-expensive-model baseline in both $ and %.

**Why the router doesn't execute subtasks itself:** keeping N provider API keys
out of this repo is an explicit goal. The report-back workflow (B2) lets real
token counts flow in from whatever tool you actually used — Claude Code, a
custom agent, direct API calls — without this repo needing credentials for any
of them.

---

## What's not here (intentional)

- **Token-spend measurement/tracking** — deferred; see SCO-139.
- **VS Code extension** — surface layer, builds on top of this script.
- **MCP tool** — same.
- **Task decomposition** — the caller tags subtasks at decomposition time.
  No router-calling-a-router.

---

Copyright © 2026 Modelglass Pty Ltd. Licensed under the MIT License — see [LICENSE](../LICENSE).
