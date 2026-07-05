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
  qualityBar?: string;
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
  quality_tier: string;
  tiers: Tier[];
}

export interface ModelEntry {
  model_id: string;
  name: string;
  knowledge?: { capability_profile?: CapabilityDim[] };
  offerings: Offering[];
}

export interface ApiResponse {
  ok: boolean;
  data: ModelEntry[];
}

export interface NormalisedModel {
  name: string;
  slug: string;
  qualityTier: string;
  codingRating: string | null;
  codingNotes: string;
  instrRating: string | null;
  sweBenchVerified: number | null;
  sweBenchSource: string;
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
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number;
  actual_model_name: string;      // as supplied by caller
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

export const MODELGLASS_API = "https://modelglass-api.vercel.app";

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

export function extractSweBenchVerified(notes: string): { score: number | null; source: string } {
  const m = notes.match(/SWE-bench Verified\s+([\d.]+)%\s*\(([^)]+)\)/i);
  if (m) {
    return { score: parseFloat(m[1]), source: m[2].trim().split(",")[0].trim() };
  }
  return { score: null, source: "" };
}

export function currentPrice(tiers: Tier[], id: string): number | null {
  const tier = tiers.find((t) => t.id === id);
  if (!tier || !tier.pricing.length) return null;
  return tier.pricing[tier.pricing.length - 1].amount;
}

export function normalise(m: ModelEntry): NormalisedModel {
  const cap = m.knowledge?.capability_profile ?? [];
  let codingRating: string | null = null;
  let codingNotes = "";
  let instrRating: string | null = null;
  for (const dim of cap) {
    if (dim.dimension === "coding") { codingRating = dim.rating; codingNotes = dim.notes ?? ""; }
    if (dim.dimension === "instruction-following") instrRating = dim.rating;
  }
  const { score: sweBenchVerified, source: sweBenchSource } = extractSweBenchVerified(codingNotes);
  const offering = [...m.offerings].sort(
    (a, b) =>
      (currentPrice(a.tiers, "input") ?? Infinity) -
      (currentPrice(b.tiers, "input") ?? Infinity),
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
// Selection
// ---------------------------------------------------------------------------

export interface CodingSelection {
  selected: NormalisedModel | null;
  ranked: NormalisedModel[];            // sorted desc by SWE-bench Verified
  excluded: { model: NormalisedModel; reason: string }[];
  mostExpensive: NormalisedModel | null;
}

export function selectCodingModel(models: NormalisedModel[]): CodingSelection {
  const strong = models.filter((m) => m.codingRating === "strong");
  const ranked: NormalisedModel[] = [];
  const excluded: { model: NormalisedModel; reason: string }[] = [];

  for (const m of strong) {
    if (m.sweBenchVerified !== null) {
      ranked.push(m);
    } else {
      let reason = "no confirmed SWE-bench Verified score in primary sources";
      if (m.codingNotes.toLowerCase().includes("internal") || m.codingNotes.toLowerCase().includes("vendor-reported")) {
        reason = "score is vendor-reported / internal eval — not independently verified";
      } else if (m.codingNotes.toLowerCase().includes("swe-bench pro")) {
        reason = "has SWE-bench Pro score (different benchmark) — not SWE-bench Verified";
      }
      excluded.push({ model: m, reason });
    }
  }

  ranked.sort((a, b) => {
    const d = (b.sweBenchVerified ?? 0) - (a.sweBenchVerified ?? 0);
    return d !== 0 ? d : (a.inputPricePerM ?? Infinity) - (b.inputPricePerM ?? Infinity);
  });

  const cheapestFirst = [...ranked].sort(
    (a, b) => (a.inputPricePerM ?? Infinity) - (b.inputPricePerM ?? Infinity),
  );
  const selected = cheapestFirst[0] ?? null;

  // Most expensive model in the entire pool (for baseline calculation)
  const allStrong = [...ranked, ...excluded.map((e) => e.model)];
  const mostExpensive = allStrong.sort(
    (a, b) => (b.inputPricePerM ?? 0) - (a.inputPricePerM ?? 0),
  )[0] ?? null;

  return { selected, ranked, excluded, mostExpensive };
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
