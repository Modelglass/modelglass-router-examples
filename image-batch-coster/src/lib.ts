/**
 * Modelglass MCP client, job-spec validation, and cost computation for
 * image-batch-coster.
 *
 * Uses the live Modelglass HTTP MCP endpoint directly over JSON-RPC (no MCP
 * client library) — same integration style as av-prompt-refiner's lib.ts.
 * Unlike stack-watch (which needed GET /v1/keys for tier introspection and
 * GET /v1/models/:id/competitors, neither exposed by any MCP tool, so it had
 * no choice but plain REST), this example only ever needs the full offering
 * pool with pricing + capability data — exactly what modelglass_list_models
 * already returns (modality + generation filters included) — so MCP is a
 * genuine, sufficient fit here, not a REST workaround.
 */

// ---------------------------------------------------------------------------
// Modelglass MCP client
// ---------------------------------------------------------------------------

export const MODELGLASS_MCP_URL = "https://modelglass-api.vercel.app/mcp";

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
  const res = await fetch(MODELGLASS_MCP_URL, {
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

// ---------------------------------------------------------------------------
// Types — Modelglass feed (image modality)
// ---------------------------------------------------------------------------

export interface CapabilityDim {
  dimension: string;
  rating: string;
  notes?: string;
}

export interface PriceSource {
  url?: string;
  verified_at?: string;
  method?: string;
}

export interface PriceEntry {
  amount: number;
  currency: string;
  unit: string;
  effective_from: string;
  effective_to?: string;
  source?: PriceSource;
}

export interface Tier {
  id: string;
  label?: string;
  pricing: PriceEntry[];
}

export interface ModelInfo {
  id: string;
  creator?: string;
  modality: string;
  status: string;
  generation?: string;
}

export interface Offering {
  slug: string;
  provider: string;
  quality_tier?: string;
  model: ModelInfo;
  tiers: Tier[];
}

export interface ModelKnowledge {
  capability_profile?: CapabilityDim[];
}

export interface ModelEntry {
  model_id: string;
  name: string;
  join_status: string;
  knowledge?: ModelKnowledge | null;
  offerings: Offering[];
}

/** Fetch the full image-modality, current-generation offering pool via the
 *  live Modelglass MCP endpoint (modelglass_list_models tool). */
export async function fetchImageModels(apiKey: string): Promise<ModelEntry[]> {
  const data = (await callMcpTool(apiKey, "modelglass_list_models", {
    modality: "image",
    generation: "current",
  })) as ModelEntry[];
  return data;
}

// ---------------------------------------------------------------------------
// Job spec
// ---------------------------------------------------------------------------

export interface JobSpec {
  count: number;
  /** "WIDTHxHEIGHT", e.g. "1536x1536" — converted to megapixels internally,
   *  since that's the unit per_megapixel tiers actually price on. */
  resolution: string;
  /** Capability dimension → minimum acceptable rating, e.g.
   *  {"text-rendering": "strong"}. Keys are validated at runtime against
   *  whatever dimensions are actually present in the live feed (see
   *  validateRequirementKeys) — never a hardcoded fixed list, since the
   *  ontology's capability_profile vocabulary can grow. */
  requirements?: Record<string, string>;
}

/** Parses "WIDTHxHEIGHT" into a raw megapixel count. Throws on malformed
 *  input rather than silently defaulting — a wrong resolution silently
 *  accepted would produce a wrong cost for the whole job. */
export function parseMegapixels(resolution: string): number {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(resolution.trim());
  if (!match) {
    throw new Error(
      `Invalid resolution '${resolution}' — expected "WIDTHxHEIGHT", e.g. "1536x1536".`,
    );
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  return (width * height) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Capability rating scale
// ---------------------------------------------------------------------------

/** Ordinal scale as used across the rest of the site (see
 *  apps/web/src/pages/compare.astro's ["strong","moderate","weak"] grading
 *  order) — this is a small, stable vocabulary, unlike capability
 *  *dimensions* (text-rendering, photorealism, ...), which this tool
 *  deliberately does NOT hardcode and instead reads from the live feed. */
export const RATING_ORDER = ["weak", "moderate", "strong"] as const;

function ratingIndex(rating: string): number {
  return RATING_ORDER.indexOf(rating as (typeof RATING_ORDER)[number]);
}

/** Every capability dimension actually present across the fetched pool —
 *  used to validate the job spec's requirement keys against real data
 *  instead of a fixed schema. */
export function availableDimensions(models: ModelEntry[]): string[] {
  const dims = new Set<string>();
  for (const m of models) {
    for (const d of m.knowledge?.capability_profile ?? []) dims.add(d.dimension);
  }
  return [...dims].sort();
}

/** Throws with a precise, actionable message if the job spec references a
 *  capability dimension or a minimum rating that doesn't exist in the live
 *  feed — the honest failure mode is refusing to silently exclude every
 *  candidate against a typo'd key, not proceeding with a wrong answer. */
export function validateRequirementKeys(
  requirements: Record<string, string>,
  models: ModelEntry[],
): void {
  const dims = availableDimensions(models);
  for (const [dimension, minRating] of Object.entries(requirements)) {
    if (!dims.includes(dimension)) {
      throw new Error(
        `Unknown capability dimension '${dimension}' in job spec requirements. ` +
          `Dimensions actually present in the live feed: ${dims.join(", ")}.`,
      );
    }
    if (ratingIndex(minRating) === -1) {
      throw new Error(
        `Unknown minimum rating '${minRating}' for '${dimension}'. ` +
          `Valid ratings (low→high): ${RATING_ORDER.join(", ")}.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Capability filtering
// ---------------------------------------------------------------------------

export interface Exclusion {
  model_id: string;
  name: string;
  reason: string;
}

export interface FilterResult {
  qualifying: ModelEntry[];
  excluded: Exclusion[];
}

/** Filters the pool against the job spec's capability requirements, citing
 *  the specific disqualifying field for every exclusion — same
 *  honest-exclusion style as stack-watch and cost-aware-vscode-router. */
export function filterByCapability(
  models: ModelEntry[],
  requirements: Record<string, string> | undefined,
): FilterResult {
  if (!requirements || Object.keys(requirements).length === 0) {
    return { qualifying: models, excluded: [] };
  }

  const qualifying: ModelEntry[] = [];
  const excluded: Exclusion[] = [];

  for (const m of models) {
    const profile = m.knowledge?.capability_profile;
    if (!profile) {
      excluded.push({
        model_id: m.model_id,
        name: m.name,
        reason:
          `no capability_profile in the registry (join_status: ${m.join_status}) — ` +
          `cannot verify ${Object.keys(requirements).join(", ")}`,
      });
      continue;
    }

    const ratingsByDim = new Map(profile.map((d) => [d.dimension, d.rating]));
    let disqualified: string | null = null;
    for (const [dimension, minRating] of Object.entries(requirements)) {
      const actual = ratingsByDim.get(dimension);
      if (actual === undefined) {
        disqualified = `no rating recorded for capability_profile.${dimension}`;
        break;
      }
      if (ratingIndex(actual) < ratingIndex(minRating)) {
        disqualified = `capability_profile.${dimension}: '${actual}' below required '${minRating}'`;
        break;
      }
    }

    if (disqualified) {
      excluded.push({ model_id: m.model_id, name: m.name, reason: disqualified });
    } else {
      qualifying.push(m);
    }
  }

  return { qualifying, excluded };
}

// ---------------------------------------------------------------------------
// Cost normalization
// ---------------------------------------------------------------------------

export const COMPARABLE_UNITS = new Set(["per_image", "per_megapixel"]);

export function currentPrice(tier: Tier): PriceEntry | null {
  const active = tier.pricing.find((p) => !p.effective_to);
  if (active) return active;
  if (!tier.pricing.length) return null;
  return [...tier.pricing].sort((a, b) => (a.effective_from > b.effective_from ? -1 : 1))[0]!;
}

export interface RankedOffering {
  model_id: string;
  name: string;
  provider: string;
  slug: string;
  tier_id: string;
  unit: string;
  amount: number;
  currency: string;
  effective_from: string;
  source_url?: string;
  cost_per_job: number;
  cost_per_1k_images: number;
}

export interface NonComparableOffering {
  model_id: string;
  name: string;
  provider: string;
  slug: string;
  tier_id: string;
  unit: string;
  amount: number;
  currency: string;
  reason: string;
}

export interface CostResult {
  ranked: RankedOffering[];
  nonComparable: NonComparableOffering[];
}

const NON_COMPARABLE_REASONS: Record<string, string> = {
  per_credit:
    "billed in provider credits, not a fixed per-image/per-megapixel rate — converting to a " +
    "per-job dollar estimate would require guessing how many credits one generation actually " +
    "consumes, which Modelglass does not track. Listed at face value instead of guessed.",
  per_month:
    "a flat subscription rate, not a per-generation charge — amortizing it into a per-job cost " +
    "would require assuming a generation volume this tool has no basis for. Listed at face " +
    "value instead of guessed.",
};

/** Normalizes every current price for the job into a per_image/per_megapixel
 *  comparable cost-per-job (+ cost-per-1k-images for scale-independent
 *  comparison), and separately lists per_credit/per_month offerings with the
 *  reason they're deliberately never force-converted — this mirrors known
 *  debt item #7 in the main modelglass repo (cross-unit sorting is
 *  approximate) and turns it into an explicit data-honesty stance instead. */
export function computeCosts(models: ModelEntry[], job: JobSpec): CostResult {
  const megapixels = parseMegapixels(job.resolution);
  const ranked: RankedOffering[] = [];
  const nonComparable: NonComparableOffering[] = [];

  for (const m of models) {
    for (const off of m.offerings) {
      for (const tier of off.tiers) {
        const price = currentPrice(tier);
        if (!price) continue;

        if (price.unit === "per_image") {
          ranked.push({
            model_id: m.model_id,
            name: m.name,
            provider: off.provider,
            slug: off.slug,
            tier_id: tier.id,
            unit: price.unit,
            amount: price.amount,
            currency: price.currency,
            effective_from: price.effective_from,
            source_url: price.source?.url,
            cost_per_job: price.amount * job.count,
            cost_per_1k_images: price.amount * 1000,
          });
        } else if (price.unit === "per_megapixel") {
          ranked.push({
            model_id: m.model_id,
            name: m.name,
            provider: off.provider,
            slug: off.slug,
            tier_id: tier.id,
            unit: price.unit,
            amount: price.amount,
            currency: price.currency,
            effective_from: price.effective_from,
            source_url: price.source?.url,
            cost_per_job: price.amount * job.count * megapixels,
            cost_per_1k_images: price.amount * 1000 * megapixels,
          });
        } else {
          nonComparable.push({
            model_id: m.model_id,
            name: m.name,
            provider: off.provider,
            slug: off.slug,
            tier_id: tier.id,
            unit: price.unit,
            amount: price.amount,
            currency: price.currency,
            reason:
              NON_COMPARABLE_REASONS[price.unit] ??
              `billed in '${price.unit}', not a per-image/per-megapixel rate — no safe conversion.`,
          });
        }
      }
    }
  }

  ranked.sort((a, b) => a.cost_per_job - b.cost_per_job);
  return { ranked, nonComparable };
}

// ---------------------------------------------------------------------------
// Cross-host callout
// ---------------------------------------------------------------------------

export interface CrossHostSpread {
  model_id: string;
  name: string;
  cheapest: RankedOffering;
  priciest: RankedOffering;
  /** (priciest - cheapest) / priciest, as a percentage — "the priciest host
   *  costs X% more than the cheapest for this exact job." */
  spread_pct: number;
}

/** Groups ranked (comparable-unit) offerings by model_id and flags every
 *  model_id offered at more than one host, citing the actual cheapest vs
 *  priciest cost for THIS job spec (not just the raw per-unit rate — the
 *  same numeric rate can still produce different job costs when one host
 *  bills per_image and the other per_megapixel at a non-1MP resolution). */
export function crossHostSpreads(ranked: RankedOffering[]): CrossHostSpread[] {
  const byModel = new Map<string, RankedOffering[]>();
  for (const r of ranked) {
    const list = byModel.get(r.model_id) ?? [];
    list.push(r);
    byModel.set(r.model_id, list);
  }

  const spreads: CrossHostSpread[] = [];
  for (const [model_id, offs] of byModel) {
    const hosts = new Set(offs.map((o) => o.provider));
    if (hosts.size < 2) continue;
    const sorted = [...offs].sort((a, b) => a.cost_per_job - b.cost_per_job);
    const cheapest = sorted[0]!;
    const priciest = sorted[sorted.length - 1]!;
    if (cheapest.cost_per_job === priciest.cost_per_job) continue; // same cost, no spread to report
    spreads.push({
      model_id,
      name: cheapest.name,
      cheapest,
      priciest,
      spread_pct: ((priciest.cost_per_job - cheapest.cost_per_job) / priciest.cost_per_job) * 100,
    });
  }
  return spreads.sort((a, b) => b.spread_pct - a.spread_pct);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function hr(len = 96): string {
  return "─".repeat(len);
}

export function fmtUsd(amount: number): string {
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}

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
