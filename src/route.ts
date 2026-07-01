/**
 * Modelglass cost-aware task router (CLI core)
 *
 * Routes each subtask of a dev task to the cheapest LLM that can handle it,
 * using the live Modelglass feed as the model pool.
 *
 * Usage:
 *   MODELGLASS_API_KEY=<key> node --import tsx/esm src/route.ts [task.json]
 *   MODELGLASS_API_KEY=<key> node --import tsx/esm src/route.ts --demo
 *
 * See docs/specs/sco-139-orchestrator-routing-design.md for the full spec.
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubtaskTag = "coding" | "writing" | "general";

interface Subtask {
  description: string;
  tag: SubtaskTag;
  /** Declared quality bar — only used for coding subtasks. */
  qualityBar?: string;
  /** Rough token estimates for cost projection. */
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

interface Task {
  description: string;
  subtasks: Subtask[];
}

interface CapabilityDim {
  dimension: string;
  rating: string;
  notes?: string;
}

interface PricingEntry {
  amount: number;
  currency: string;
  unit: string;
  effective_from: string;
}

interface Tier {
  id: string;
  pricing: PricingEntry[];
}

interface Offering {
  slug: string;
  quality_tier: string;
  tiers: Tier[];
}

interface ModelEntry {
  model_id: string;
  name: string;
  knowledge?: {
    capability_profile?: CapabilityDim[];
  };
  offerings: Offering[];
}

interface ApiResponse {
  ok: boolean;
  data: ModelEntry[];
}

interface NormalisedModel {
  name: string;
  slug: string;
  qualityTier: string;
  codingRating: string | null;
  codingNotes: string;
  instrRating: string | null;
  sweBenchVerified: number | null;   // % extracted from coding_notes, null if not confirmed
  sweBenchSource: string;            // human-readable source label
  inputPricePerM: number | null;     // USD per 1M input tokens
  outputPricePerM: number | null;    // USD per 1M output tokens
}

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
// Modelglass API fetch
// ---------------------------------------------------------------------------

const MODELGLASS_API = "https://modelglass-api.vercel.app";

async function fetchLLMModels(apiKey: string): Promise<NormalisedModel[]> {
  const url = `${MODELGLASS_API}/v1/models?modality=llm`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Modelglass API ${res.status}: ${body}`);
  }
  const json = (await res.json()) as ApiResponse;
  if (!json.ok) throw new Error("Modelglass API returned ok=false");
  return json.data.map(normalise);
}

// ---------------------------------------------------------------------------
// Normalisation + SWE-bench score extraction
// ---------------------------------------------------------------------------

/** Extract SWE-bench Verified % from the coding dimension notes string. */
function extractSweBenchVerified(notes: string): { score: number | null; source: string } {
  // Pattern: "SWE-bench Verified XX.X% (source, ...)"
  const m = notes.match(/SWE-bench Verified\s+([\d.]+)%\s*\(([^)]+)\)/i);
  if (m) {
    const score = parseFloat(m[1]);
    // Extract just the domain / short label from the parenthetical
    const raw = m[2].trim();
    const source = raw.split(",")[0].trim();
    return { score, source };
  }
  return { score: null, source: "" };
}

function currentPrice(tiers: Tier[], id: string): number | null {
  const tier = tiers.find((t) => t.id === id);
  if (!tier || !tier.pricing.length) return null;
  // Last entry = most recent (append-only ADR 0002)
  return tier.pricing[tier.pricing.length - 1].amount;
}

function normalise(m: ModelEntry): NormalisedModel {
  const cap = m.knowledge?.capability_profile ?? [];
  let codingRating: string | null = null;
  let codingNotes = "";
  let instrRating: string | null = null;
  for (const dim of cap) {
    if (dim.dimension === "coding") { codingRating = dim.rating; codingNotes = dim.notes ?? ""; }
    if (dim.dimension === "instruction-following") instrRating = dim.rating;
  }

  const { score: sweBenchVerified, source: sweBenchSource } =
    extractSweBenchVerified(codingNotes);

  // Use cheapest offering's pricing (most are single-offering but guard anyway)
  const offering = m.offerings.sort(
    (a, b) =>
      (currentPrice(a.tiers, "input") ?? Infinity) -
      (currentPrice(b.tiers, "input") ?? Infinity)
  )[0];

  return {
    name: m.name,
    slug: offering?.slug ?? m.model_id,
    qualityTier: offering?.quality_tier ?? "",
    codingRating,
    codingNotes,
    instrRating,
    sweBenchVerified,
    sweBenchSource,
    inputPricePerM: offering ? currentPrice(offering.tiers, "input") : null,
    outputPricePerM: offering ? currentPrice(offering.tiers, "output") : null,
  };
}

// ---------------------------------------------------------------------------
// Selection logic (spec §3)
// ---------------------------------------------------------------------------

/**
 * Coding subtask: filter coding==strong, rank by confirmed SWE-bench Verified,
 * exclude models with no confirmed score (flag them separately).
 * Select cheapest that clears the quality bar (passed as external assertion —
 * the human/LLM caller declares the bar; we just pick cheapest ranked model).
 */
function selectCodingModel(models: NormalisedModel[]): {
  selected: NormalisedModel | null;
  ranked: NormalisedModel[];
  excluded: { model: NormalisedModel; reason: string }[];
} {
  const strong = models.filter((m) => m.codingRating === "strong");

  const ranked: NormalisedModel[] = [];
  const excluded: { model: NormalisedModel; reason: string }[] = [];

  for (const m of strong) {
    if (m.sweBenchVerified !== null) {
      ranked.push(m);
    } else {
      // Determine why it lacks a confirmed score
      let reason = "no confirmed SWE-bench Verified score in primary sources";
      if (m.codingNotes.toLowerCase().includes("internal") || m.codingNotes.toLowerCase().includes("vendor-reported")) {
        reason = "score is vendor-reported / internal eval — not independently verified";
      } else if (m.codingNotes.toLowerCase().includes("swe-bench pro")) {
        reason = "has SWE-bench Pro score (different benchmark) — not SWE-bench Verified";
      }
      excluded.push({ model: m, reason });
    }
  }

  // Sort: descending SWE-bench Verified, then ascending input price as tiebreak
  ranked.sort((a, b) => {
    const scoreDiff = (b.sweBenchVerified ?? 0) - (a.sweBenchVerified ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (a.inputPricePerM ?? Infinity) - (b.inputPricePerM ?? Infinity);
  });

  // Select cheapest that clears quality bar — for now: cheapest with confirmed
  // SWE-bench Verified that is not the most expensive option (walk up from cheapest).
  // We sort cheapest-first among ranked models for selection.
  const cheapestFirst = [...ranked].sort(
    (a, b) => (a.inputPricePerM ?? Infinity) - (b.inputPricePerM ?? Infinity)
  );
  const selected = cheapestFirst[0] ?? null;

  return { selected, ranked, excluded };
}

/**
 * Writing/general subtask: filter instruction_following in [strong, good],
 * ignore coding filter, select cheapest.
 */
function selectWritingModel(models: NormalisedModel[]): NormalisedModel | null {
  const candidates = models.filter((m) =>
    m.instrRating === "strong" || m.instrRating === "good"
  );
  if (!candidates.length) return null;
  return candidates.sort(
    (a, b) => (a.inputPricePerM ?? Infinity) - (b.inputPricePerM ?? Infinity)
  )[0];
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

function estimateCost(
  model: NormalisedModel,
  inputTokens: number,
  outputTokens: number
): number {
  const inCost = ((model.inputPricePerM ?? 0) * inputTokens) / 1_000_000;
  const outCost = ((model.outputPricePerM ?? 0) * outputTokens) / 1_000_000;
  return inCost + outCost;
}

function fmtCost(usd: number): string {
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function fmtPrice(p: number | null): string {
  return p !== null ? `$${p}` : "N/A";
}

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

function hr(len = 80): string {
  return "─".repeat(len);
}

function printRoutingTable(
  task: Task,
  models: NormalisedModel[]
): void {
  const { selected: codingModel, ranked, excluded } = selectCodingModel(models);
  const writingModel = selectWritingModel(models);

  console.log("\n" + hr());
  console.log("  Modelglass Task Router");
  console.log(hr());
  console.log(`  Task: ${task.description}`);
  console.log(hr());

  // --- Coding model pool ---
  console.log("\n  CODING MODEL POOL  (coding=strong, ranked by SWE-bench Verified)\n");
  console.log(
    `  ${"Model".padEnd(28)} ${"SWE-bench Verified".padEnd(22)} ${"Input/1M".padEnd(12)} Output/1M`
  );
  console.log("  " + "─".repeat(76));
  for (const m of ranked) {
    const marker = m === codingModel ? "← selected" : "";
    const score = `${m.sweBenchVerified}%  (${m.sweBenchSource})`;
    console.log(
      `  ${m.name.padEnd(28)} ${score.padEnd(22)} ${fmtPrice(m.inputPricePerM).padEnd(12)} ${fmtPrice(m.outputPricePerM)}  ${marker}`
    );
  }
  if (excluded.length) {
    console.log("\n  Excluded (no confirmed SWE-bench Verified score):");
    for (const { model: m, reason } of excluded) {
      console.log(`  ✗ ${m.name}: ${reason}`);
    }
  }

  // --- Writing model ---
  console.log("\n  WRITING/GENERAL MODEL  (instruction_following=strong|good, cheapest)\n");
  if (writingModel) {
    console.log(
      `  ${writingModel.name}  ` +
        `Input ${fmtPrice(writingModel.inputPricePerM)}/1M  ` +
        `Output ${fmtPrice(writingModel.outputPricePerM)}/1M  ← selected`
    );
  } else {
    console.log("  (no qualifying model found)");
  }

  // --- Routing table ---
  console.log("\n" + hr());
  console.log("  ROUTING TABLE\n");
  console.log(
    `  ${"#".padEnd(3)} ${"Subtask".padEnd(50)} ${"Tag".padEnd(10)} ${"Model".padEnd(20)} ${"Est. in".padEnd(10)} ${"Est. out".padEnd(10)} Est. cost`
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
    const desc = sub.description.length > 48
      ? sub.description.slice(0, 45) + "..."
      : sub.description;
    console.log(
      `  ${String(i + 1).padEnd(3)} ${desc.padEnd(50)} ${sub.tag.padEnd(10)} ${modelName.padEnd(20)} ${String(inTok).padEnd(10)} ${String(outTok).padEnd(10)} ${fmtCost(cost)}`
    );
  });
  console.log("  " + "─".repeat(120));
  console.log(`  ${"".padEnd(3)} ${"".padEnd(50)} ${"".padEnd(10)} ${"".padEnd(20)} ${"".padEnd(10)} ${"Total".padEnd(10)} ${fmtCost(totalCost)}`);

  // --- Escalation rule ---
  if (codingModel && ranked.length > 1) {
    const next = ranked.find(
      (m) =>
        m !== codingModel &&
        (m.inputPricePerM ?? 0) > (codingModel.inputPricePerM ?? 0)
    );
    if (next) {
      console.log(
        `\n  Escalation: if coding subtasks fail correctness review → retry on ${next.name}` +
          ` (SWE-bench Verified ${next.sweBenchVerified}%, ${fmtPrice(next.inputPricePerM)}/1M input)`
      );
    }
  }

  console.log("\n" + hr() + "\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiKey = process.env["MODELGLASS_API_KEY"];
  if (!apiKey) {
    console.error(
      "Error: MODELGLASS_API_KEY is not set.\n" +
      "Get a free key at https://modelglass.com.au/signup, then:\n" +
      "  export MODELGLASS_API_KEY=<your-key>"
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  let task: Task;

  if (args.includes("--demo") || args.length === 0) {
    task = DEMO_TASK;
    if (args.length === 0) {
      console.log("No task file supplied — running built-in demo task.");
      console.log("Pass --demo explicitly or provide a task JSON file as the first argument.\n");
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
