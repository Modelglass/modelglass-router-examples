/**
 * stack-watch — price-drift and deprecation watchdog (CLI core)
 *
 * Usage:
 *   MODELGLASS_API_KEY=<starter-or-pro-key> node --import tsx/esm src/watch.ts [stack.json]
 *   MODELGLASS_API_KEY=<starter-or-pro-key> node --import tsx/esm src/watch.ts --demo
 *
 * Requires a Starter or Pro key — see lib.ts's requireStarterOrPro() for why
 * there's no Free-tier degraded mode here.
 *
 * See docs/decisions in Linear SCO-166 for the full spec.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import {
  type StackFile,
  type Snapshot,
  type DriftReport,
  fetchAllModels,
  requireApiKey,
  requireStarterOrPro,
  computeDrift,
  computeSwitchSuggestions,
  toSnapshotModel,
  fmtPrice,
  hr,
  MODELGLASS_API,
} from "./lib.js";

const SNAPSHOT_PATH = "logs/stack-snapshot.json";

// ---------------------------------------------------------------------------
// Demo stack — one model per modality, kept in sync with the README
// ---------------------------------------------------------------------------

const DEMO_STACK: StackFile = {
  models: [
    "openai/o4-mini", // llm
    "bfl/flux-1-1-pro", // image
    "klingai/kling-2-1", // video
    "stability-ai/stable-audio-3-0", // audio
  ],
};

// ---------------------------------------------------------------------------
// Snapshot I/O
// ---------------------------------------------------------------------------

function loadSnapshot(): Snapshot | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot;
  } catch (e) {
    console.error(`Warning: could not parse ${SNAPSHOT_PATH} (${e}) — treating as first run.`);
    return null;
  }
}

function saveSnapshot(stackModelIds: string[], current: Awaited<ReturnType<typeof fetchAllModels>>): void {
  const models: Snapshot["models"] = {};
  for (const modelId of stackModelIds) {
    const m = current.find((c) => c.model_id === modelId);
    if (m) models[modelId] = toSnapshotModel(m);
  }
  const snapshot: Snapshot = { captured_at: new Date().toISOString(), models };
  mkdirSync("logs", { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function printReport(report: DriftReport, totalModels: number): void {
  console.log("\n" + hr());
  console.log("  stack-watch");
  console.log(hr());

  if (report.isBaseline) {
    console.log(`  First run — no prior snapshot found.`);
    console.log(
      `  Recorded baseline state for ${totalModels} model(s). This is not a drift report —`,
    );
    console.log(`  run stack-watch again later (e.g. via daily/weekly cron) to detect changes.`);
    console.log(hr() + "\n");
    return;
  }

  if (report.notFound.length) {
    console.log(`\n  NOT FOUND IN FEED (${report.notFound.length}):`);
    for (const id of report.notFound) {
      console.log(`  ✗ ${id} — no longer in the registry, or a typo in stack.json`);
    }
  }

  if (report.priceDrift.length) {
    console.log(`\n  PRICE CHANGES (${report.priceDrift.length}):`);
    for (const d of report.priceDrift) {
      const fromStr = d.from ? fmtPrice(d.from.amount, d.from.unit) : "(no prior price)";
      const toStr = fmtPrice(d.to.amount, d.to.unit);
      console.log(
        `  ${d.model_name} (${d.provider}, ${d.tier_id}): ${fromStr} → ${toStr}` +
          ` on ${d.to.effective_from}` +
          (d.to.source_url ? ` — source: ${d.to.source_url}` : ""),
      );
    }
  }

  if (report.lifecycleDrift.length) {
    console.log(`\n  LIFECYCLE CHANGES (${report.lifecycleDrift.length}):`);
    for (const d of report.lifecycleDrift) {
      console.log(`  ${d.model_name} (${d.provider}): ${d.field} ${d.from ?? "(none)"} → ${d.to}`);
    }
  }

  if (report.capabilityDrift.length) {
    console.log(`\n  CAPABILITY RATING CHANGES (${report.capabilityDrift.length}):`);
    for (const d of report.capabilityDrift) {
      console.log(`  ${d.model_name}: ${d.dimension} ${d.from ?? "(none)"} → ${d.to}`);
    }
  }

  if (report.switchSuggestions.length) {
    console.log(`\n  SWITCH SUGGESTIONS (${report.switchSuggestions.length}):`);
    for (const s of report.switchSuggestions) {
      const pct = Math.round((1 - s.cheaper_ratio) * 100);
      console.log(
        `  ${s.model_name} → ${s.competitor_name} (${s.competitor_provider}): ` +
          `${pct}% cheaper, same "${s.matched_dimension}: ${s.matched_rating}" rating ` +
          `— fields: capability_profile.${s.matched_dimension}, tiers.pricing`,
      );
    }
  }

  const totalActionable =
    report.notFound.length +
    report.priceDrift.length +
    report.lifecycleDrift.length +
    report.capabilityDrift.length +
    report.switchSuggestions.length;

  if (totalActionable === 0) {
    console.log(`\n  No drift since last run — stack unchanged (${totalModels} model(s) checked).`);
  }

  console.log("\n" + hr() + "\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = requireApiKey();
  await requireStarterOrPro(apiKey);

  const args = process.argv.slice(2);
  let stack: StackFile;
  if (args.includes("--demo") || args.length === 0) {
    stack = DEMO_STACK;
    if (args.length === 0) {
      console.log("No stack file supplied — running built-in demo stack.");
      console.log("Pass --demo explicitly or provide a stack.json path as the first argument.\n");
    }
  } else {
    const file = args[0]!;
    try {
      stack = JSON.parse(readFileSync(file, "utf8")) as StackFile;
    } catch (e) {
      console.error(`Failed to read stack file '${file}': ${e}`);
      process.exit(1);
    }
  }

  if (!stack.models?.length) {
    console.error("stack.json has no models — nothing to watch.");
    process.exit(1);
  }

  console.log(`Fetching ${stack.models.length} model(s) from ${MODELGLASS_API} ...`);
  const current = await fetchAllModels(apiKey);

  const prior = loadSnapshot();
  const report = computeDrift(stack.models, current, prior);

  // Switch suggestions need live competitor lookups — skip entirely on the
  // baseline run (nothing to suggest switching away from yet) and skip for
  // any model already flagged not-found.
  if (!report.isBaseline) {
    const checkable = stack.models.filter((id) => !report.notFound.includes(id));
    report.switchSuggestions = await computeSwitchSuggestions(apiKey, checkable, current);
  }

  printReport(report, stack.models.length);
  saveSnapshot(stack.models, current);

  if (report.isBaseline) {
    process.exit(0);
  }
  const actionable =
    report.notFound.length +
    report.priceDrift.length +
    report.lifecycleDrift.length +
    report.capabilityDrift.length +
    report.switchSuggestions.length;
  process.exit(actionable > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
