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

/**
 * Built-in demo task (rate-limiting middleware — from
 * sco-139-orchestrator-routing-design.md §4). Single source of truth for
 * `--demo`/`--task demo` across route.ts and report.ts — previously each
 * file hardcoded its own copy and the two had already drifted (SCO-165
 * finding #7: `minSweBenchVerified` present on one copy, absent on the
 * other, after finding #1's fix touched only route.ts's copy first).
 */
export const DEMO_TASK: Task = {
  description:
    "Add per-endpoint rate limiting middleware to the Modelglass API " +
    "(Redis KV, 429/Retry-After, unit tests, PR description, Slack summary).",
  subtasks: [
    {
      description: "Implement rate-limit middleware (Upstash KV, 429/Retry-After)",
      tag: "coding",
      // Moderately demanding real-world SWE task, not a frontier-tier bar —
      // 65 excludes the current pool's weaker scored candidate while still
      // being clearable by more than one model (SCO-165 finding #1; value
      // chosen against the live feed on 2026-07-12, see README).
      minSweBenchVerified: 65,
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_500,
    },
    {
      description: "Write unit tests (pass/reject/tier-boundary)",
      tag: "coding",
      minSweBenchVerified: 65,
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
  /** e.g. `{ processing: "batch" }` on a discounted Batch/Flex tier (SCO-646). */
  attributes?: Record<string, unknown>;
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

/**
 * Whether the actual model used differs from the recommendation, and if so,
 * why (SCO-165 finding #6). "none" = actual matches recommended. "escalation"
 * = the caller explicitly reported this as a retry-after-failure via
 * `report --escalated` (route.ts's own "walk up the cost ladder on failure"
 * concept, now with mechanical support instead of only a printed suggestion).
 * "override" = actual differs from recommended but wasn't flagged as an
 * escalation -- some other reason (caller preference, a model swap unrelated
 * to correctness review, etc.). Previously both cases were indistinguishable
 * (`actual_model_name !== recommended_model_name`).
 */
export type DeviationType = "none" | "escalation" | "override";

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
  deviation_type: DeviationType;
  baseline_model_name: string;    // most expensive model in pool at routing time
  baseline_cost_usd: number;      // actual tokens × baseline model prices
  delta_usd: number;              // actual_cost_usd − estimated_cost_usd
}

/** Derive deviation_type from whether models match and the --escalated flag. */
export function deviationType(
  recommendedName: string,
  actualName: string,
  escalatedFlag: boolean,
): DeviationType {
  if (recommendedName === actualName) return "none";
  return escalatedFlag ? "escalation" : "override";
}

// ---------------------------------------------------------------------------
// Modelglass MCP client (SCO-337) — this example's one REST call
// (GET /v1/models?modality=llm) had no documented blocking reason to stay
// REST, unlike stack-watch/switch-check before their own SCO-351 swap; the
// existing modelglass_list_models tool already returns exactly this
// (modality + generation filters included), same integration style as
// image-batch-coster's lib.ts.
// ---------------------------------------------------------------------------

export const MODELGLASS_API =
  process.env.MODELGLASS_API ?? "https://modelglass-api.vercel.app";

interface McpToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: McpToolCallResult;
  error?: { code: number; message: string };
}

let requestId = 0;

async function callMcpTool(
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${MODELGLASS_API}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name, arguments: args },
      id: ++requestId,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Modelglass MCP ${res.status}: ${body}`);
  }
  const json = (await res.json()) as McpJsonRpcResponse;
  if (json.error) {
    throw new Error(`Modelglass MCP error ${json.error.code}: ${json.error.message}`);
  }
  const result = json.result;
  const text = result?.content?.[0]?.text;
  if (!result || result.isError || !text) {
    throw new Error(`Modelglass MCP tool call failed: ${text ?? "no content returned"}`);
  }
  const parsed = JSON.parse(text) as {
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  };
  if (!parsed.ok) {
    throw new Error(`Modelglass API error: ${parsed.error?.code} — ${parsed.error?.message}`);
  }
  return parsed.data;
}

export async function fetchLLMModels(apiKey: string): Promise<NormalisedModel[]> {
  const data = (await callMcpTool(apiKey, "modelglass_list_models", {
    modality: "llm",
  })) as ModelEntry[];
  return data.map(normalise);
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

/** Tier-id prefixes that mark a discounted / non-standard rate even when the
 *  tier carries no `attributes.processing` (a guard for future entries). */
const NON_HEADLINE_TIER_ID = /^(batch|flex|cached|cache)-/;

/**
 * SCO-646 (the SCO-640 rule, same as modelglass.com.au and the MCP tools):
 * whether a tier's price may stand in for a model's headline (list) price.
 * Batch/Flex/cached-input tiers are real rates but not the list price, so
 * they never win a "cheapest" pick. Context-length tiers (`input-64k` /
 * `input-256k`) stay eligible, so the lowest base rate wins by convention.
 * Same rule as ../../pricing-math's isHeadlineTier — keep them in sync.
 */
export function isHeadlineTier(tier: Tier): boolean {
  const processing = tier.attributes?.processing;
  if (processing !== undefined && processing !== null && processing !== "standard") return false;
  return !NON_HEADLINE_TIER_ID.test(tier.id);
}

/**
 * An offering's headline price for one billing unit: the cheapest current
 * price across its headline tiers of that unit (e.g. `per_1m_tokens_input`).
 * Replaces reading the tier literally named `input`, which missed models
 * priced only on context-length tiers (inkling: `input-64k` / `input-256k`)
 * and would have picked up a Standard tier named anything else wrongly.
 */
export function headlinePrice(tiers: Tier[], unit: string): number | null {
  let best: number | null = null;
  for (const tier of tiers) {
    if (!isHeadlineTier(tier) || !tier.pricing.length) continue;
    const latest = tier.pricing[tier.pricing.length - 1];
    if (latest.unit !== unit) continue;
    if (best === null || latest.amount < best) best = latest.amount;
  }
  return best;
}

export const INPUT_UNIT = "per_1m_tokens_input";
export const OUTPUT_UNIT = "per_1m_tokens_output";

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
      (headlinePrice(a.tiers, INPUT_UNIT) ?? Infinity) -
      (headlinePrice(b.tiers, INPUT_UNIT) ?? Infinity),
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
    inputPricePerM: offering ? headlinePrice(offering.tiers, INPUT_UNIT) : null,
    outputPricePerM: offering ? headlinePrice(offering.tiers, OUTPUT_UNIT) : null,
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
