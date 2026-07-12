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
  DEMO_TASK,
  fetchLLMModels,
  selectCodingModel,
  selectWritingModel,
  codingQualityBar,
  estimateCost,
  fmtCost,
  fmtPrice,
  hr,
  requireApiKey,
  MODELGLASS_API,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

function printRoutingTable(task: Task, models: NormalisedModel[]): void {
  const minSweBenchVerified = codingQualityBar(task);
  const { selected: codingModel, ranked, qualifying, excluded } = selectCodingModel(
    models,
    minSweBenchVerified,
  );
  const writingModel = selectWritingModel(models);

  console.log("\n" + hr());
  console.log("  Modelglass Task Router");
  console.log(hr());
  console.log(`  Task: ${task.description}`);
  console.log(hr());

  const barLabel =
    minSweBenchVerified !== null
      ? `, min. SWE-bench Verified ${minSweBenchVerified}%`
      : "";
  console.log(`\n  CODING MODEL POOL  (coding=strong, ranked by SWE-bench Verified${barLabel})\n`);
  console.log(
    `  ${"Model".padEnd(24)} ${"Provider".padEnd(18)} ${"SWE-bench Verified (source, type)".padEnd(36)} ${"Input/1M".padEnd(12)} Output/1M`,
  );
  console.log("  " + "─".repeat(108));
  for (const m of ranked) {
    const belowBar = !qualifying.includes(m);
    const marker = m === codingModel ? "← selected" : belowBar ? "✗ below quality bar" : "";
    const score = `${m.sweBenchVerified}%  (${m.sweBenchSource})`;
    console.log(
      `  ${m.name.padEnd(24)} ${m.provider.padEnd(18)} ${score.padEnd(36)} ${fmtPrice(m.inputPricePerM).padEnd(12)} ${fmtPrice(m.outputPricePerM)}  ${marker}`,
    );
  }
  if (excluded.length) {
    console.log("\n  Excluded from the ranked pool:");
    for (const { model: m, reason } of excluded) {
      console.log(`  ✗ ${m.name}: ${reason}`);
    }
  }

  console.log("\n  WRITING/GENERAL MODEL  (instruction_following=strong|good, cheapest)\n");
  if (writingModel) {
    console.log(
      `  ${writingModel.name} (${writingModel.provider})  ` +
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

  if (codingModel && qualifying.length > 1) {
    // Escalation must stay within the quality-bar-qualifying pool -- offering
    // a cheaper-than-o4-mini-in-theory step up that itself fails the bar
    // would be a worse recommendation than the one being escalated from.
    const next = qualifying.find(
      (m) => m !== codingModel && (m.inputPricePerM ?? 0) > (codingModel.inputPricePerM ?? 0),
    );
    if (next) {
      console.log(
        `\n  Escalation: if coding subtasks fail correctness review → retry on ${next.name}` +
          ` (SWE-bench Verified ${next.sweBenchVerified}%, ${fmtPrice(next.inputPricePerM)}/1M input)` +
          `\n  When you do, log it with 'npm run report -- ... --model "${next.name}" --escalated'` +
          ` so it's tracked as an escalation, not an override.`,
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
