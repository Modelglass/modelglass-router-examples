# modelglass-router-examples

Worked examples of building on top of the live [Modelglass](https://modelglass.com.au) pricing and capability feed — each one demonstrates a different way of using Modelglass data as grounding context for an LLM-powered tool. These are code examples meant to be read and adapted, not hosted/live demos.

## Examples

| Example | Modality | What it demonstrates | Link |
|---|---|---|---|
| `cost-aware-vscode-router` | LLM (text) | Routes each subtask of a dev task to the cheapest LLM that clears a confirmed-benchmark quality bar, using the live Modelglass LLM feed as the model pool. | [README](cost-aware-vscode-router/README.md) |
| `av-prompt-refiner` | Video, Audio | Given a rough prompt and one or two already-chosen models, pulls MCP capability-profile data (prompt conventions, supported params, known quirks) and rewrites the prompt to fit that model specifically — including a coordinated video+audio mode that reasons across both profiles at once. | [README](av-prompt-refiner/README.md) |

## Requirements

- Node.js 20+
- A Modelglass API key ([get a free one](https://modelglass.com.au/signup)) — required by every example
- `av-prompt-refiner` additionally requires an Anthropic API key (`ANTHROPIC_API_KEY`) — see its own README

## Setup

```bash
git clone https://github.com/Modelglass/modelglass-router-examples.git
cd modelglass-router-examples
npm install
export MODELGLASS_API_KEY=<your-key>
```

Dependencies and npm scripts are shared at the repo root across all examples — each example's own README documents its specific `npm run` commands.

## What's not here (intentional, across every example)

- **Hosted/live demos** — these are CLI/code examples meant to be read and adapted, not run as hosted tools.
- **Model selection logic** — each example assumes the caller has already chosen their target model(s); routing/selection is each example's own concern, not a shared capability.

---

Copyright © 2026 Modelglass Pty Ltd. Licensed under the MIT License — see [LICENSE](LICENSE).
