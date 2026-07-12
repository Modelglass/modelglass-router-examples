/**
 * shot-plan-compiler — storyboard-in, model-picks + chain-feasibility +
 * cost-out (CLI core)
 *
 * Usage:
 *   MODELGLASS_API_KEY=<free-or-paid-key> node --import tsx/esm src/plan.ts [storyboard.json]
 *   MODELGLASS_API_KEY=<free-or-paid-key> node --import tsx/esm src/plan.ts --demo
 *   MODELGLASS_API_KEY=<free-or-paid-key> node --import tsx/esm src/plan.ts --demo --alternates
 *
 * Planner only — see Linear SCO-190. This never calls a generation provider,
 * never spends money, and needs no key beyond the Modelglass API key.
 */

import { readFileSync } from "node:fs";
import {
  type Storyboard,
  type Plan,
  type BudgetLevel,
  fetchVideoModels,
  computePlan,
  computeAlternatePlans,
  requireApiKey,
  hr,
  fmtUsd,
  MODELGLASS_MCP_URL,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Demo storyboard — kept in sync with the README's worked example
// ---------------------------------------------------------------------------

export const DEMO_STORYBOARD: Storyboard = {
  title: "Product teaser — 3 shots",
  shots: [
    {
      id: "shot-1",
      description: "Wide establishing shot of the product on a table, slow push-in",
      durationSeconds: 5,
      resolution: "1080p",
      fps: 24,
      audio: false,
    },
    {
      id: "shot-2",
      description: "Continuation: camera continues past the product into a close-up detail",
      durationSeconds: 12,
      resolution: "1080p",
      fps: 24,
      audio: false,
      continuityFromPrevious: true,
    },
    {
      id: "shot-3",
      description: "Final hero shot with voiceover tagline",
      durationSeconds: 6,
      resolution: "1080p",
      fps: 30,
      audio: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function printPlan(plan: Plan, label?: string): void {
  console.log("\n" + hr());
  console.log(`  shot-plan-compiler${label ? ` — ${label}` : ""}`);
  console.log(hr());
  console.log(`  Storyboard: ${plan.storyboard_title}`);
  console.log(hr());

  console.log("\n  SHOT PLAN\n");
  for (const sel of plan.selections) {
    console.log(`  ${sel.shot_id}${sel.picked ? "" : "  ✗ INFEASIBLE"}`);
    console.log(`    ${sel.rationale}`);
    if (sel.picked) {
      console.log(`    Cost: ${fmtUsd(sel.picked.cost_usd)}`);
    }
    if (sel.excluded.length) {
      console.log(`    Excluded (${sel.excluded.length}):`);
      for (const ex of sel.excluded) {
        console.log(`      ✗ ${ex.name} (${ex.model_id}): ${ex.reason}`);
      }
    }
    console.log();
  }

  if (plan.shotFlags.length) {
    console.log(hr());
    console.log(`  SHOT FLAGS (${plan.shotFlags.length})\n`);
    for (const f of plan.shotFlags) {
      console.log(`  [${f.type}] ${f.shot_id}: ${f.detail}`);
      console.log(`    → ${f.recommendation}\n`);
    }
  }

  const handoffsWithFlags = plan.handoffs.filter((h) => h.flags.length > 0);
  console.log(hr());
  console.log(`  CHAIN-FEASIBILITY (${plan.handoffs.length} handoff(s), ${handoffsWithFlags.length} flagged)\n`);
  if (handoffsWithFlags.length === 0) {
    console.log("  No flagged seams — every handoff matches fps, resolution, and audio continuity.");
  } else {
    for (const h of handoffsWithFlags) {
      console.log(`  ${h.from_shot} → ${h.to_shot}:`);
      for (const f of h.flags) {
        console.log(`    [${f.type}] ${f.detail}`);
        console.log(`      → ${f.recommendation}`);
      }
      console.log();
    }
  }

  console.log(hr());
  console.log(`  TOTAL COST: ${fmtUsd(plan.total_cost_usd)}`);
  if (plan.shots_without_cost.length) {
    console.log(
      `  ⚠ ${plan.shots_without_cost.length} shot(s) have no feasible model and are NOT included in the total: ${plan.shots_without_cost.join(", ")}`,
    );
  }
  console.log(hr() + "\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = requireApiKey();
  const args = process.argv.slice(2);
  const wantsAlternates = args.includes("--alternates");
  const positional = args.filter((a) => !a.startsWith("--"));

  let storyboard: Storyboard;
  if (args.includes("--demo") || positional.length === 0) {
    storyboard = DEMO_STORYBOARD;
    if (positional.length === 0 && !args.includes("--demo")) {
      console.log("No storyboard supplied — running the built-in demo storyboard.");
      console.log(
        "Pass --demo explicitly, or provide a storyboard.json path as the first argument. " +
          "Add --alternates for budget/balanced/premium plans.\n",
      );
    }
  } else {
    const file = positional[0]!;
    try {
      storyboard = JSON.parse(readFileSync(file, "utf8")) as Storyboard;
    } catch (e) {
      console.error(`Failed to read storyboard '${file}': ${e}`);
      process.exit(1);
    }
  }

  if (!storyboard.shots || storyboard.shots.length === 0) {
    console.error("Storyboard needs a non-empty 'shots' array.");
    process.exit(1);
  }

  console.log(`Fetching the video-modality offering pool from ${MODELGLASS_MCP_URL} ...`);
  const models = await fetchVideoModels(apiKey);
  console.log(`  ${models.length} video models loaded.`);

  if (wantsAlternates) {
    const plans = computeAlternatePlans(models, storyboard);
    const levels: BudgetLevel[] = ["budget", "balanced", "premium"];
    for (const level of levels) {
      printPlan(plans[level], level);
    }
    console.log(
      "  Note: 'premium' picks the priciest qualifying candidate per shot as a price-as-quality " +
        "proxy — the registry has no single per-shot-type quality scalar to rank on instead.\n",
    );
    const anyInfeasible = levels.some((l) => plans[l].shots_without_cost.length > 0);
    process.exit(anyInfeasible ? 1 : 0);
  } else {
    const plan = computePlan(models, storyboard);
    printPlan(plan);
    process.exit(plan.shots_without_cost.length > 0 ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
