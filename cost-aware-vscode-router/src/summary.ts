/**
 * summary — print spend summary across all logged subtasks
 *
 * Usage:
 *   npm run summary
 *
 * Reads logs/routing-log.jsonl and prints:
 *   - Total actual spend
 *   - Total estimated spend
 *   - Hypothetical baseline (same tokens at most-expensive model in each run's pool)
 *   - Savings vs baseline ($ and %)
 *   - Escalations vs overrides — how many logged subtasks deviated from the
 *     recommended model, split by whether `npm run report` was called with
 *     `--escalated` (a retry-after-failure) or not (a plain override)
 */

import { readFileSync, existsSync } from "node:fs";
import { type LogEntry, fmtCost, hr } from "./lib.js";

const LOG_PATH = "logs/routing-log.jsonl";

function readLog(): LogEntry[] {
  if (!existsSync(LOG_PATH)) {
    console.error(`No log found at ${LOG_PATH}.\nRun 'npm run report' after completing subtasks.`);
    process.exit(1);
  }
  return readFileSync(LOG_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, i) => {
      try {
        return JSON.parse(line) as LogEntry;
      } catch {
        console.error(`  Skipping malformed line ${i + 1}: ${line.slice(0, 80)}`);
        return null;
      }
    })
    .filter((e): e is LogEntry => e !== null);
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function main(): void {
  const entries = readLog();
  if (!entries.length) {
    console.log("Log is empty — no entries to summarise.");
    process.exit(0);
  }

  const totalActual = entries.reduce((s, e) => s + e.actual_cost_usd, 0);
  const totalEstimated = entries.reduce((s, e) => s + e.estimated_cost_usd, 0);
  const totalBaseline = entries.reduce((s, e) => s + e.baseline_cost_usd, 0);

  const savingsVsBaseline = totalBaseline - totalActual;
  const savingsVsEstimated = totalEstimated - totalActual;

  console.log("\n" + hr());
  console.log("  Modelglass Router — Spend Summary");
  console.log(hr());
  console.log(`  Entries: ${entries.length} subtask(s) logged\n`);

  console.log(`  Total actual spend:    ${fmtCost(totalActual)}`);
  console.log(`  Total estimated spend: ${fmtCost(totalEstimated)}  (delta: ${savingsVsEstimated >= 0 ? "+" : ""}${fmtCost(savingsVsEstimated)})`);
  console.log(`  Hypothetical baseline: ${fmtCost(totalBaseline)}  (all tokens at most-expensive model in each run)\n`);

  if (totalBaseline > 0) {
    console.log(
      `  Savings vs baseline:   ${fmtCost(savingsVsBaseline)}  (${pct(savingsVsBaseline, totalBaseline)} cheaper)`,
    );
  }

  // Per-entry breakdown
  console.log("\n" + hr());
  console.log("  Per-subtask breakdown  (⚑ escalation, ⚠ override — see summary below)\n");
  console.log(
    `  ${"#".padEnd(3)} ${"Subtask".padEnd(42)} ${"Recommended".padEnd(22)} ${"Actual".padEnd(22)} ${"Est. cost".padEnd(12)} ${"Act. cost".padEnd(12)} ${"Baseline".padEnd(12)} Delta`,
  );
  console.log("  " + "─".repeat(148));

  for (const e of entries) {
    const desc =
      e.subtask_description.length > 40
        ? e.subtask_description.slice(0, 37) + "..."
        : e.subtask_description;
    const recommended =
      e.recommended_model_name.length > 20
        ? e.recommended_model_name.slice(0, 18) + ".."
        : e.recommended_model_name;
    const actual =
      e.actual_model_name.length > 20
        ? e.actual_model_name.slice(0, 18) + ".."
        : e.actual_model_name;
    const flagged =
      e.deviation_type === "escalation" ? " ⚑" : e.deviation_type === "override" ? " ⚠" : "";
    const delta = e.delta_usd >= 0 ? `+${fmtCost(e.delta_usd)}` : fmtCost(e.delta_usd);
    console.log(
      `  ${String(e.subtask_index).padEnd(3)} ${desc.padEnd(42)} ${recommended.padEnd(22)} ${(actual + flagged).padEnd(22)} ${fmtCost(e.estimated_cost_usd).padEnd(12)} ${fmtCost(e.actual_cost_usd).padEnd(12)} ${fmtCost(e.baseline_cost_usd).padEnd(12)} ${delta}`,
    );
  }
  console.log("  " + "─".repeat(148));
  console.log(
    `  ${"".padEnd(3)} ${"".padEnd(42)} ${"".padEnd(22)} ${"Totals".padEnd(22)} ${fmtCost(totalEstimated).padEnd(12)} ${fmtCost(totalActual).padEnd(12)} ${fmtCost(totalBaseline).padEnd(12)}`,
  );

  const escalations = entries.filter((e) => e.deviation_type === "escalation");
  const overrides = entries.filter((e) => e.deviation_type === "override");
  if (escalations.length) {
    console.log(
      `\n  ⚑ ${escalations.length} subtask(s) escalated to a different model after the recommendation failed (--escalated).`,
    );
  }
  if (overrides.length) {
    console.log(
      `  ⚠ ${overrides.length} subtask(s) used a different model than recommended, not reported as an escalation.`,
    );
  }

  console.log("\n" + hr() + "\n");
}

main();
