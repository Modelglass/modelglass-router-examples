/**
 * image-batch-coster — cross-host image batch-job cost ranking (CLI core)
 *
 * Usage:
 *   MODELGLASS_API_KEY=<free-or-paid-key> node --import tsx/esm src/cost.ts [job-spec.json]
 *   MODELGLASS_API_KEY=<free-or-paid-key> node --import tsx/esm src/cost.ts --demo
 *
 * Free-tier friendly — no pricing-history lookback needed (current prices
 * only), no LLM call. See Linear SCO-167 for the full spec.
 */

import { readFileSync } from "node:fs";
import {
  type JobSpec,
  type FilterResult,
  type CostResult,
  fetchImageModels,
  requireApiKey,
  validateRequirementKeys,
  filterByCapability,
  computeCosts,
  crossHostSpreads,
  parseMegapixels,
  hr,
  fmtUsd,
  MODELGLASS_MCP_URL,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Demo job spec — kept in sync with the README's worked example
// ---------------------------------------------------------------------------

const DEMO_JOB: JobSpec = {
  count: 250,
  resolution: "1536x1536",
  requirements: {
    photorealism: "strong",
  },
};

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function printReport(
  job: JobSpec,
  megapixels: number,
  filterResult: FilterResult,
  costResult: CostResult,
): void {
  console.log("\n" + hr());
  console.log("  image-batch-coster");
  console.log(hr());
  console.log(
    `  Job: ${job.count} image(s) at ${job.resolution} (${megapixels.toFixed(2)} MP)` +
      (job.requirements && Object.keys(job.requirements).length
        ? ` — requires ${Object.entries(job.requirements)
            .map(([k, v]) => `${k}: ${v}+`)
            .join(", ")}`
        : ""),
  );

  if (costResult.ranked.length === 0) {
    console.log("\n  No offering meets these requirements — nothing to rank.");
  } else {
    console.log(`\n  RANKED (${costResult.ranked.length} offering(s), cheapest first):`);
    // Column widths are computed from the actual data (+ a 2-space gutter),
    // not a fixed guess — a fixed width silently overflows into the next
    // column once a model/provider name is longer than assumed.
    const nameW = Math.max(5, ...costResult.ranked.map((r) => r.name.length)) + 2;
    const hostW = Math.max(4, ...costResult.ranked.map((r) => r.provider.length)) + 2;
    const unitW = Math.max(4, ...costResult.ranked.map((r) => r.unit.length)) + 2;
    const costW = Math.max(8, ...costResult.ranked.map((r) => fmtUsd(r.cost_per_job).length)) + 2;
    console.log(
      `  ${"MODEL".padEnd(nameW)}${"HOST".padEnd(hostW)}${"UNIT".padEnd(unitW)}${"COST/JOB".padEnd(costW)}COST/1K IMAGES`,
    );
    for (const r of costResult.ranked) {
      console.log(
        `  ${r.name.padEnd(nameW)}${r.provider.padEnd(hostW)}${r.unit.padEnd(unitW)}` +
          `${fmtUsd(r.cost_per_job).padEnd(costW)}${fmtUsd(r.cost_per_1k_images)}`,
      );
    }
  }

  const spreads = crossHostSpreads(costResult.ranked);
  if (spreads.length) {
    console.log(`\n  CROSS-HOST PRICE SPREAD (${spreads.length}):`);
    for (const s of spreads) {
      console.log(
        `  ${s.name} (${s.model_id}): ${s.cheapest.provider} ${fmtUsd(s.cheapest.cost_per_job)} vs ` +
          `${s.priciest.provider} ${fmtUsd(s.priciest.cost_per_job)} for this job — ` +
          `same model, ${s.spread_pct.toFixed(1)}% spread`,
      );
    }
  }

  if (costResult.nonComparable.length) {
    console.log(`\n  NOT DIRECTLY COMPARABLE (${costResult.nonComparable.length}) — not ranked:`);
    for (const nc of costResult.nonComparable) {
      console.log(
        `  ${nc.name} (${nc.provider}, ${nc.unit} @ ${nc.currency} ${nc.amount}): ${nc.reason}`,
      );
    }
  }

  if (filterResult.excluded.length) {
    console.log(`\n  EXCLUDED (${filterResult.excluded.length}) — didn't meet requirements:`);
    for (const ex of filterResult.excluded) {
      console.log(`  ${ex.name} (${ex.model_id}): ${ex.reason}`);
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
  let job: JobSpec;
  if (args.includes("--demo") || args.length === 0) {
    job = DEMO_JOB;
    if (args.length === 0) {
      console.log("No job spec supplied — running the built-in demo job.");
      console.log("Pass --demo explicitly or provide a job-spec.json path as the first argument.\n");
    }
  } else {
    const file = args[0]!;
    try {
      job = JSON.parse(readFileSync(file, "utf8")) as JobSpec;
    } catch (e) {
      console.error(`Failed to read job spec '${file}': ${e}`);
      process.exit(1);
    }
  }

  if (!job.count || job.count <= 0) {
    console.error("Job spec needs a positive 'count'.");
    process.exit(1);
  }
  if (!job.resolution) {
    console.error("Job spec needs a 'resolution' (e.g. \"1536x1536\").");
    process.exit(1);
  }

  console.log(`Fetching the image-modality offering pool from ${MODELGLASS_MCP_URL} ...`);
  const models = await fetchImageModels(apiKey);

  try {
    validateRequirementKeys(job.requirements ?? {}, models);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  let megapixels: number;
  try {
    megapixels = parseMegapixels(job.resolution);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const filterResult = filterByCapability(models, job.requirements);
  const costResult = computeCosts(filterResult.qualifying, job);

  printReport(job, megapixels, filterResult, costResult);
  process.exit(costResult.ranked.length === 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
