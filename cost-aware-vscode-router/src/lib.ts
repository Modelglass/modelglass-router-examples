/**
 * Shared types, Modelglass feed fetching, and routing selection logic.
 * Used by route.ts, report.ts, and summary.ts.
 */

// ---------------------------------------------------------------------------
// Types — task
// ---------------------------------------------------------------------------

export type SubtaskTag = "coding" | "writing" | "general";

export interface Subtask {
  description: string;
  tag: SubtaskTag;
  /**
   * Minimum SWE-bench Verified score (0-100) a coding-tagged subtask requires
   * of its selected model. Ignored for non-coding subtasks. Omit for no
   * threshold (any confirmed-score model qualifies, the pre-SCO-165 default
   * behaviour). Replaces the old free-text `qualityBar: string` field, which
   * was never read by selection logic (SCO-165 finding #1) -- a numeric
   * threshold against the same structured `knowledge.benchmarks` field
   * `selectCodingModel` already ranks by is the one comparison this router
   * can actually make; a prose rubric would need the tool to run the task
   * and grade the output, which it doesn't do.
   */
  minSweBenchVerified?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export interface Task {
  description: string;
  subtasks: Subtask[];
}

// ---------------------------------------------------------------------------
// Types — Modelglass feed
// ---------------------------------------------------------------------------

export interface CapabilityDim {
  dimension: string;
  rating: string;
  notes?: string;
}

/**
 * A curated benchmark score from the feed's `knowledge.benchmarks` — sourced
 * from the Modelglass coding-capability registry and joined into the model
 * payload by the API. Every score carries provenance: the source URL and its
 * type (vendor / leaderboard / paper / independent).
 */
export interface BenchmarkScore {
  benchmark: string;
  score: number; // 0–1 fraction
  score_date?: string;
  harness?: string;
  variant?: string;
  source: { url: string; type: string; verified_at?: string };
  notes?: string;
}

export interface PricingEntry {
  amount: number;
  currency: string;
  unit: string;
  effective_from: string;
}

export interface Tier {
  id: string;
  pricing: PricingEntry[];
}

export interface Offering {
  slug: string;
  provider: string;
  quality_tier: string;
  tiers: Tier[];
}

export interface ModelEntry {
  model_id: string;
  name: string;
  knowledge?: {
    capability_profile?: CapabilityDim[];
    benchmarks?: BenchmarkScore[];
  };
  offerings: Offering[];
}

export interface ApiResponse {
  ok: boolean;
  data: ModelEntry[];
}

export interface NormalisedModel {
  name: string;
  slug: string;
  /**
   * Which host serves the selected (cheapest) offering -- "same model,
   * different host, different price" is a real Modelglass differentiator
   * that normalise() previously discarded entirely (SCO-165 finding #3).
   * Empty string only if a model somehow has zero offerings.
   */
  provider: string;
  qualityTier: string;
  codingRating: string | null;
  instrRating: string | null;
  sweBenchVerified: number | null;
  sweBenchSource: string;
  /** Model has a curated SWE-bench Pro score (a different benchmark). */
  hasSweBenchPro: boolean;
  inputPricePerM: number | null;
  outputPricePerM: number | null;
}

// ---------------------------------------------------------------------------
// Types — log
// ---------------------------------------------------------------------------

export interface LogEntry {
  timestamp: string;
  task_description: string;
  subtask_index: number;          // 1-based, matches routing table
  subtask_description: string;
  subtask_tag: SubtaskTag;
  recommended_model_name: string;
  recommended_model_slug: string;
  recommended_model_provider: string;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number;
  actual_model_name: string;      // as supplied by caller
  actual_model_provider: string;  // "" if model not found in feed
  actual_input_tokens: number;
  actual_output_tokens: number;
  actual_cost_usd: number;        // 0 if model not found in feed
  baseline_model_name: string;    // most expensive model in pool at routing time
  baseline_cost_usd: number;      // actual tokens × baseline model prices
  delta_usd: number;              // actual_cost_usd − estimated_cost_usd
}

// ---------------------------------------------------------------------------
// Modelglass API
// ---------------------------------------------------------------------------

export const MODELGLASS_API =
  process.env.MODELGLASS_API ?? "https://modelglass-api.vercel.app";

export async function fetchLLMModels(apiKey: string): Promise<NormalisedModel[]> {
  const res = await fetch(`${MODELGLASS_API}/v1/models?modality=llm`, {
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
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Read a model's curated SWE-bench Verified score from the structured
 * `knowledge.benchmarks` field — score + provenance as curated in the
 * Modelglass coding-capability registry, not parsed out of prose.
 */
export function sweBenchVerifiedScore(
  benchmarks: BenchmarkScore[] | undefined,
): { score: number | null; source: string } {
  const entry = benchmarks?.find((b) => b.benchmark === "swe-bench-verified");
  if (!entry) return { score: null, source: "" };
  let host = entry.source.url;
  try {
    host = new URL(entry.source.url).hostname.replace(/^www\./, "");
  } catch {
    // keep the raw URL if it doesn't parse
  }
  return {
    score: Math.round(entry.score * 1000) / 10, // 0–1 fraction → percent, 1 dp
    source: `${host}, ${entry.source.type}`,
  };
}

export function currentPrice(tiers: Tier[], id: string): number | null {
  const tier = tiers.find((t) => t.id === id);
  if (!tier || !tier.pricing.length) return null;
  return tier.pricing[tier.pricing.length - 1].amount;
}

export function normalise(m: ModelEntry): NormalisedModel {
  const cap = m.knowledge?.capability_profile ?? [];
  let codingRating: string | null = null;
  let instrRating: string | null = null;
  for (const dim of cap) {
    if (dim.dimension === "coding") codingRating = dim.rating;
    if (dim.dimension === "instruction-following") instrRating = dim.rating;
  }
  const benchmarks = m.knowledge?.benchmarks;
  const { score: sweBenchVerified, source: sweBenchSource } = sweBenchVerifiedScore(benchmarks);
  const hasSweBenchPro = benchmarks?.some((b) => b.benchmark === "swe-bench-pro") ?? false;
  const offering = [...m.offerings].sort(
    (a, b) =>
      (currentPrice(a.tiers, "input") ?? Infinity) -
      (currentPrice(b.tiers, "input") ?? Infinity),
  )[0];
  return {
    name: m.name,
    slug: offering?.slug ?? m.model_id,
    provider: offering?.provider ?? "",
    qualityTier: offering?.quality_tier ?? "",
    codingRating,
    instrRating,
    sweBenchVerified,
    sweBenchSource,
    hasSweBenchPro,
    inputPricePerM: offering ? currentPrice(offering.tiers, "input") : null,
    outputPricePerM: offering ? currentPrice(offering.tiers, "output") : null,
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface CodingSelection {
  selected: NormalisedModel | null;
  ranked: NormalisedModel[];            // every confirmed-score model, sorted desc by SWE-bench Verified
  qualifying: NormalisedModel[];        // ranked models that also clear minSweBenchVerified
  excluded: { model: NormalisedModel; reason: string }[];
  mostExpensive: NormalisedModel | null;
  minSweBenchVerified: number | null;   // the threshold actually applied, for display
}

/**
 * Highest `minSweBenchVerified` set across a task's coding-tagged subtasks,
 * or null if none set any threshold. `selectCodingModel` picks one model for
 * every coding subtask (SCO-165's noted "one model globally" architecture is
 * unchanged by this fix), so the strictest bar among them is the one the
 * shared selection has to clear.
 */
export function codingQualityBar(task: Task): number | null {
  const bars = task.subtasks
    .filter((s) => s.tag === "coding" && s.minSweBenchVerified !== undefined)
    .map((s) => s.minSweBenchVerified!);
  return bars.length ? Math.max(...bars) : null;
}

export function selectCodingModel(
  models: NormalisedModel[],
  minSweBenchVerified: number | null = null,
): CodingSelection {
  const strong = models.filter((m) => m.codingRating === "strong");
  const ranked: NormalisedModel[] = [];
  const excluded: { model: NormalisedModel; reason: string }[] = [];

  for (const m of strong) {
    if (m.sweBenchVerified !== null) {
      ranked.push(m);
    } else if (m.hasSweBenchPro) {
      excluded.push({
        model: m,
        reason: "has a curated SWE-bench Pro score (different benchmark) — not SWE-bench Verified",
      });
    } else {
      excluded.push({
        model: m,
        reason: "no curated SWE-bench Verified score in the Modelglass registry",
      });
    }
  }

  ranked.sort((a, b) => {
    const d = (b.sweBenchVerified ?? 0) - (a.sweBenchVerified ?? 0);
    return d !== 0 ? d : (a.inputPricePerM ?? Infinity) - (b.inputPricePerM ?? Infinity);
  });

  // Quality-bar filter (SCO-165 finding #1): a confirmed score is necessary
  // but not sufficient — it must also clear the task's stated minimum. Models
  // that rank but fall short move from "ranked" to "excluded" with a reason
  // naming the actual gap, rather than silently losing on price alone.
  const qualifying = ranked.filter(
    (m) => minSweBenchVerified === null || (m.sweBenchVerified ?? 0) >= minSweBenchVerified,
  );
  if (minSweBenchVerified !== null) {
    for (const m of ranked) {
      if (!qualifying.includes(m)) {
        excluded.push({
          model: m,
          reason: `SWE-bench Verified ${m.sweBenchVerified}% is below the required threshold of ${minSweBenchVerified}%`,
        });
      }
    }
  }

  const cheapestFirst = [...qualifying].sort(
    (a, b) => (a.inputPricePerM ?? Infinity) - (b.inputPricePerM ?? Infinity),
  );
  const selected = cheapestFirst[0] ?? null;

  // Most expensive model in the entire pool (for baseline calculation) —
  // deliberately over the full ranked+excluded set, not just qualifying
  // ones: the baseline represents "most expensive option a caller might
  // have picked without this tool," which shouldn't shrink just because a
  // quality bar narrowed the recommended pool.
  const allStrong = [...ranked, ...excluded.map((e) => e.model)];
  const mostExpensive = allStrong.sort(
    (a, b) => (b.inputPricePerM ?? 0) - (a.inputPricePerM ?? 0),
  )[0] ?? null;

  return { selected, ranked, qualifying, excluded, mostExpensive, minSweBenchVerified };
}

export function selectWritingModel(models: NormalisedModel[]): NormalisedModel | null {
  const candidates = models.filter(
    (m) => m.instrRating === "strong" || m.instrRating === "good",
  );
  if (!candidates.length) return null;
  return candidates.sort(
    (a, b) => (a.inputPricePerM ?? Infinity) - (b.inputPricePerM ?? Infinity),
  )[0];
}

/** Most expensive model across the full pool — used as the summary baseline. */
export function mostExpensiveInPool(models: NormalisedModel[]): NormalisedModel | null {
  return [...models].sort(
    (a, b) => (b.inputPricePerM ?? 0) - (a.inputPricePerM ?? 0),
  )[0] ?? null;
}

// ---------------------------------------------------------------------------
// Cost helpers
// ---------------------------------------------------------------------------

export function estimateCost(m: NormalisedModel, inTok: number, outTok: number): number {
  return (
    ((m.inputPricePerM ?? 0) * inTok) / 1_000_000 +
    ((m.outputPricePerM ?? 0) * outTok) / 1_000_000
  );
}

export function fmtCost(usd: number): string {
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export function fmtPrice(p: number | null): string {
  return p !== null ? `$${p}` : "N/A";
}

export function hr(len = 80): string {
  return "─".repeat(len);
}

// ---------------------------------------------------------------------------
// API key helper
// ---------------------------------------------------------------------------

export function requireApiKey(): string {
  const key = process.env["MODELGLASS_API_KEY"];
  if (!key) {
    console.error(
      "Error: MODELGLASS_API_KEY is not set.\n" +
        "Get a free key at https://modelglass.com.au/signup, then:\n" +
        "  export MODELGLASS_API_KEY=<your-key>",
    );
    process.exit(1);
  }
  return key;
}
