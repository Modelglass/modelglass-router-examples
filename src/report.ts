/**
 * report — append one completed-subtask entry to logs/routing-log.jsonl
 *
 * Usage:
 *   npm run report -- --task <task.json|demo> --subtask <n> \
 *     --model <model-name-or-slug> \
 *     --actual-input <tokens> --actual-output <tokens>
 *
 * Fetches the live model pool to reproduce the routing run and look up
 * the actual model's prices. Appends one JSONL line to logs/routing-log.jsonl.
 */

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import {
  type Task,
  type LogEntry,
  fetchLLMModels,
  selectCodingModel,
  selectWritingModel,
  estimateCost,
  mostExpensiveInPool,
  requireApiKey,
  MODELGLASS_API,
} from "./lib.js";

const LOG_PATH = "logs/routing-log.jsonl";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  taskArg: string;
  subtaskIndex: number;
  modelArg: string;
  actualInput: number;
  actualOutput: number;
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const taskArg = get("--task");
  const subtaskArg = get("--subtask");
  const modelArg = get("--model");
  const actualInputArg = get("--actual-input");
  const actualOutputArg = get("--actual-output");

  const missing = [
    !taskArg && "--task",
    !subtaskArg && "--subtask",
    !modelArg && "--model",
    !actualInputArg && "--actual-input",
    !actualOutputArg && "--actual-output",
  ].filter(Boolean);

  if (missing.length) {
    console.error(
      `Missing required arguments: ${missing.join(", ")}\n\n` +
        "Usage:\n" +
        "  npm run report -- --task <task.json|demo> --subtask <n> \\\n" +
        "    --model <model-name-or-slug> \\\n" +
        "    --actual-input <tokens> --actual-output <tokens>\n\n" +
        "  --subtask   1-based index matching the routing table\n" +
        "  --model     model name or slug as shown in routing output (e.g. 'o4-mini')\n",
    );
    process.exit(1);
  }

  const subtaskIndex = parseInt(subtaskArg!, 10);
  if (isNaN(subtaskIndex) || subtaskIndex < 1) {
    console.error("--subtask must be a positive integer (1-based index)");
    process.exit(1);
  }

  return {
    taskArg: taskArg!,
    subtaskIndex,
    modelArg: modelArg!,
    actualInput: parseInt(actualInputArg!, 10),
    actualOutput: parseInt(actualOutputArg!, 10),
  };
}

// ---------------------------------------------------------------------------
// Demo task (kept in sync with route.ts)
// ---------------------------------------------------------------------------

const DEMO_TASK: Task = {
  description:
    "Add per-endpoint rate limiting middleware to the Modelglass API " +
    "(Redis KV, 429/Retry-After, unit tests, PR description, Slack summary).",
  subtasks: [
    {
      description: "Implement rate-limit middleware (Upstash KV, 429/Retry-After)",
      tag: "coding",
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_500,
    },
    {
      description: "Write unit tests (pass/reject/tier-boundary)",
      tag: "coding",
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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = requireApiKey();
  const args = process.argv.slice(2);
  const { taskArg, subtaskIndex, modelArg, actualInput, actualOutput } = parseArgs(args);

  // Load task
  let task: Task;
  if (taskArg === "demo") {
    task = DEMO_TASK;
  } else {
    try {
      task = JSON.parse(readFileSync(taskArg, "utf8")) as Task;
    } catch (e) {
      console.error(`Failed to read task file '${taskArg}': ${e}`);
      process.exit(1);
    }
  }

  if (subtaskIndex > task.subtasks.length) {
    console.error(
      `--subtask ${subtaskIndex} is out of range — task has ${task.subtasks.length} subtask(s)`,
    );
    process.exit(1);
  }

  const subtask = task.subtasks[subtaskIndex - 1]!;

  // Fetch model pool and reproduce routing run
  console.log(`Fetching LLM models from ${MODELGLASS_API} ...`);
  const models = await fetchLLMModels(apiKey);
  console.log(`  ${models.length} models loaded.`);

  const { selected: codingModel } = selectCodingModel(models);
  const writingModel = selectWritingModel(models);
  const recommended = subtask.tag === "coding" ? codingModel : writingModel;

  const estIn = subtask.estimatedInputTokens ?? 0;
  const estOut = subtask.estimatedOutputTokens ?? 0;
  const estimatedCost = recommended ? estimateCost(recommended, estIn, estOut) : 0;

  // Resolve actual model — match by name (case-insensitive) or slug
  const modelLower = modelArg.toLowerCase();
  const actualModelEntry = models.find(
    (m) =>
      m.name.toLowerCase() === modelLower ||
      m.slug.toLowerCase() === modelLower ||
      m.slug.toLowerCase().startsWith(modelLower) ||
      m.name.toLowerCase().includes(modelLower),
  );

  if (!actualModelEntry) {
    console.warn(
      `  Warning: model '${modelArg}' not found in feed — actual_cost_usd will be 0.\n` +
        `  Available models: ${models.map((m) => m.name).join(", ")}`,
    );
  }

  const actualCost = actualModelEntry
    ? estimateCost(actualModelEntry, actualInput, actualOutput)
    : 0;

  // Baseline — most expensive model in pool × actual tokens
  const baseline = mostExpensiveInPool(models);
  const baselineCost = baseline ? estimateCost(baseline, actualInput, actualOutput) : 0;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    task_description: task.description,
    subtask_index: subtaskIndex,
    subtask_description: subtask.description,
    subtask_tag: subtask.tag,
    recommended_model_name: recommended?.name ?? "(none)",
    recommended_model_slug: recommended?.slug ?? "",
    estimated_input_tokens: estIn,
    estimated_output_tokens: estOut,
    estimated_cost_usd: estimatedCost,
    actual_model_name: actualModelEntry?.name ?? modelArg,
    actual_input_tokens: actualInput,
    actual_output_tokens: actualOutput,
    actual_cost_usd: actualCost,
    baseline_model_name: baseline?.name ?? "(none)",
    baseline_cost_usd: baselineCost,
    delta_usd: actualCost - estimatedCost,
  };

  // Append to log
  mkdirSync("logs", { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");

  console.log(`\n  Logged subtask ${subtaskIndex}: "${subtask.description}"`);
  console.log(`  Recommended: ${entry.recommended_model_name}`);
  console.log(`  Actual:      ${entry.actual_model_name}  (${actualInput} in / ${actualOutput} out)`);
  console.log(`  Est. cost:   $${estimatedCost.toFixed(5)}`);
  console.log(`  Actual cost: $${actualCost.toFixed(5)}`);
  console.log(`  Delta:       ${entry.delta_usd >= 0 ? "+" : ""}$${entry.delta_usd.toFixed(5)}`);
  console.log(`  Baseline:    $${baselineCost.toFixed(5)} (${baseline?.name ?? "n/a"})`);
  console.log(`\n  Appended to ${LOG_PATH}`);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
