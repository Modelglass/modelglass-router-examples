# Cost-Aware VS Code Router

Cost-aware task router for development workflows. Routes each subtask of an
incoming dev task to the **cheapest LLM that can handle it**, using the live
[Modelglass](https://modelglass.com.au) feed as the model pool.

Coding subtasks (write/debug code) go to the cheapest model with a **confirmed
SWE-bench Verified score** above the task's quality bar. Writing subtasks (PR
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
confirmed SWE-bench Verified score (not `quality_tier` — qualitative ratings are
excluded). Select the cheapest candidate that clears the task's stated quality
bar. Models with no confirmed independent score are shown as excluded, not
silently skipped.

**Writing / general subtasks** — filter `instruction_following in [strong, good]`,
ignore the coding filter entirely. Select the cheapest qualifying model.

**Escalation** — if a coding subtask fails correctness review, retry on the
next-ranked confirmed-score model up the cost ladder. Walk up one step at a time;
don't jump straight to the most expensive option.

---

## Worked example — rate-limiting middleware (2026-07-01)

This is the live routing run that validated the design. It's also the output of
`npm run demo`.

**Task:** Add per-endpoint rate limiting middleware to the Modelglass API
(Redis KV, 429/Retry-After, unit tests, PR description, Slack summary).

```
────────────────────────────────────────────────────────────────────────────────
  Modelglass Task Router
────────────────────────────────────────────────────────────────────────────────
  Task: Add per-endpoint rate limiting middleware to the Modelglass API
        (Redis KV, 429/Retry-After, unit tests, PR description, Slack summary).
────────────────────────────────────────────────────────────────────────────────

  CODING MODEL POOL  (coding=strong, ranked by SWE-bench Verified)

  Model                        SWE-bench Verified          Input/1M   Output/1M
  ──────────────────────────────────────────────────────────────────────────────
  Claude Sonnet 4              72.7%  (anthropic.com)      $3         $15
  o4-mini                      68.1%  (openai.com)         $1.10      $4.40  ← selected
  Gemini 2.5 Pro               63.8%  (deepmind.google)    $1.25      $10

  Excluded (no confirmed SWE-bench Verified score):
  ✗ Claude Fable 5: vendor-reported score — not independently verified
  ✗ Claude Sonnet 5: internal eval only — not independently verified
  ✗ GPT-5.5: no confirmed SWE-bench Verified score in primary sources
  ✗ Mistral Large 3: no confirmed SWE-bench Verified score in primary sources
  ✗ Qwen 3 235B-A22B: no confirmed SWE-bench Verified score in primary sources

  WRITING/GENERAL MODEL  (instruction_following=strong|good, cheapest)

  Llama 4 Scout  Input $0.10/1M  Output $0.30/1M  ← selected

────────────────────────────────────────────────────────────────────────────────
  ROUTING TABLE

  #   Subtask                       Tag      Model           Est. in  Est. out  Cost
  ────────────────────────────────────────────────────────────────────────────────
  1   Implement rate-limit middleware  coding   o4-mini        10,000   2,500    $0.022
  2   Write unit tests                 coding   o4-mini         8,000   2,000    $0.018
  3   Write PR description             writing  Llama 4 Scout   3,000     500    $0.0005
  4   Write Slack summary              writing  Llama 4 Scout   2,000     200    $0.0003
  ────────────────────────────────────────────────────────────────────────────────
                                                                        Total    ~$0.040

  Escalation: if coding subtasks fail → retry on Claude Sonnet 4
              (SWE-bench Verified 72.7%, $3/1M input)
────────────────────────────────────────────────────────────────────────────────
```

**Why o4-mini over Claude Sonnet 4 (higher score)?** o4-mini has a confirmed
68.1% SWE-bench Verified and the highest Aider Polyglot score in its tier
(72.0%) at 2.7× lower input cost. The 4.6pp score gap doesn't justify the
premium for this task shape. If the first attempt fails correctness review,
escalate to Claude Sonnet 4 — not the most expensive option.

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
