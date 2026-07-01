/**
 * Modelglass cost-aware task router (CLI core)
 *
 * Usage:
 *   MODELGLASS_API_KEY=<key> node --import tsx/esm src/route.ts [task.json]
 *   MODELGLASS_API_KEY=<key> node --import tsx/esm src/route.ts --demo
 *
 * See docs/specs/sco-139-orchestrator-routing-design.md for the full spec.
 */

import { readFileSync } from "node:fs";
import {
  type Task,
  type NormalisedModel,
  fetchLLMModels,
  selectCodingModel,
  selectWritingModel,
  estimateCost,
  fmtCost,
  fmtPrice,
  hr,
  requireApiKey,
  MODELGLASS_API,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Demo task (rate-limiting middleware — from sco-139-orchestrator-routing-design.md §4)
// ---------------------------------------------------------------------------

const DEMO_TASK: Task = {
  description:
    "Add per-endpoint rate limiting middleware to the Modelglass API " +
    "(Redis KV, 429/Retry-After, unit tests, PR description, Slack summary).",
  subtasks: [
    {
      description: "Implement rate-limit middleware (Upstash KV, 429/Retry-After)",
      tag: "coding",
      qualityBar:
        "Must correctly handle Redis KV serialisation patterns already used in the codebase; no hallucinated APIs.",
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_500,
    },
    {
      description: "Write unit tests (pass/reject/tier-boundary)",
      tag: "coding",
      qualityBar:
        "Must correctly handle Redis KV serialisation patterns already used in the codebase; no hallucinated APIs.",
      estimatedInputTokens: 8_000,
      estimatedOutputTokens: 2_000,
    },
    {
      description: "Write PR description explaining the change and testing approach",
      tag: "writing",
      estimatedInputTokens: 3_000,
      estimatedOutputTokens: 500,
    },
    {
      description: "Write Slack summary for the team announcing the change",
      tag: "writing",
      estimatedInputTokens: 2_000,
      estimatedOutputTokens: 200,
    },
  ],
};

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

function printRoutingTable(task: Task, models: NormalisedModel[]): void {
  const { selected: codingModel, ranked, excluded } = selectCodingModel(models);
  const writingModel = selectWritingModel(models);

  console.log("\n" + hr());
  console.log("  Modelglass Task Router");
  console.log(hr());
  console.log(`  Task: ${task.description}`);
  console.log(hr());

  console.log("\n  CODING MODEL POOL  (coding=strong, ranked by SWE-bench Verified)\n");
  console.log(
    `  ${"Model".padEnd(28)} ${"SWE-bench Verified".padEnd(22)} ${"Input/1M".padEnd(12)} Output/1M`,
  );
  console.log("  " + "─".repeat(76));
  for (const m of ranked) {
    const marker = m === codingModel ? "← selected" : "";
    const score = `${m.sweBenchVerified}%  (${m.sweBenchSource})`;
    console.log(
      `  ${m.name.padEnd(28)} ${score.padEnd(22)} ${fmtPrice(m.inputPricePerM).padEnd(12)} ${fmtPrice(m.outputPricePerM)}  ${marker}`,
    );
  }
  if (excluded.length) {
    console.log("\n  Excluded (no confirmed SWE-bench Verified score):");
    for (const { model: m, reason } of excluded) {
      console.log(`  ✗ ${m.name}: ${reason}`);
    }
  }

  console.log("\n  WRITING/GENERAL MODEL  (instruction_following=strong|good, cheapest)\n");
  if (writingModel) {
    console.log(
      `  ${writingModel.name}  ` +
        `Input ${fmtPrice(writingModel.inputPricePerM)}/1M  ` +
        `Output ${fmtPrice(writingModel.outputPricePerM)}/1M  ← selected`,
    );
  } else {
    console.log("  (no qualifying model found)");
  }

  console.log("\n" + hr());
  console.log("  ROUTING TABLE\n");
  console.log(
    `  ${"#".padEnd(3)} ${"Subtask".padEnd(50)} ${"Tag".padEnd(10)} ${"Model".padEnd(20)} ${"Est. in".padEnd(10)} ${"Est. out".padEnd(10)} Est. cost`,
  );
  console.log("  " + "─".repeat(120));

  let totalCost = 0;
  task.subtasks.forEach((sub, i) => {
    const model = sub.tag === "coding" ? codingModel : writingModel;
    const inTok = sub.estimatedInputTokens ?? 0;
    const outTok = sub.estimatedOutputTokens ?? 0;
    const cost = model ? estimateCost(model, inTok, outTok) : 0;
    totalCost += cost;
    const modelName = model?.name ?? "(none)";
    const desc =
      sub.description.length > 48 ? sub.description.slice(0, 45) + "..." : sub.description;
    console.log(
      `  ${String(i + 1).padEnd(3)} ${desc.padEnd(50)} ${sub.tag.padEnd(10)} ${modelName.padEnd(20)} ${String(inTok).padEnd(10)} ${String(outTok).padEnd(10)} ${fmtCost(cost)}`,
    );
  });
  console.log("  " + "─".repeat(120));
  console.log(
    `  ${"".padEnd(3)} ${"".padEnd(50)} ${"".padEnd(10)} ${"".padEnd(20)} ${"".padEnd(10)} ${"Total".padEnd(10)} ${fmtCost(totalCost)}`,
  );

  if (codingModel && ranked.length > 1) {
    const next = ranked.find(
      (m) => m !== codingModel && (m.inputPricePerM ?? 0) > (codingModel.inputPricePerM ?? 0),
    );
    if (next) {
      console.log(
        `\n  Escalation: if coding subtasks fail correctness review → retry on ${next.name}` +
          ` (SWE-bench Verified ${next.sweBenchVerified}%, ${fmtPrice(next.inputPricePerM)}/1M input)`,
      );
    }
  }

  console.log("\n" + hr() + "\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = requireApiKey();
  const args = process.argv.slice(2);
  let task: Task;

  if (args.includes("--demo") || args.length === 0) {
    task = DEMO_TASK;
    if (args.length === 0) {
      console.log("No task file supplied — running built-in demo task.");
      console.log(
        "Pass --demo explicitly or provide a task JSON file as the first argument.\n",
      );
    }
  } else {
    const file = args[0];
    try {
      task = JSON.parse(readFileSync(file!, "utf8")) as Task;
    } catch (e) {
      console.error(`Failed to read task file '${file}': ${e}`);
      process.exit(1);
    }
  }

  console.log(`Fetching LLM models from ${MODELGLASS_API} ...`);
  const models = await fetchLLMModels(apiKey);
  console.log(`  ${models.length} LLM models loaded.\n`);
  printRoutingTable(task, models);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
