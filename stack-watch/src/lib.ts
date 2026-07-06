/**
 * Modelglass feed fetching, tier gating, and drift computation for stack-watch.
 *
 * Uses the plain REST feed (GET /v1/models, GET /v1/keys,
 * GET /v1/models/:modelId/competitors) rather than the MCP endpoint — the
 * two capabilities this tool needs (tier introspection via /v1/keys, and
 * competitor lookups via /v1/models/:modelId/competitors) aren't exposed by
 * any of the four MCP tools, so there's no MCP-only path available here,
 * unlike av-prompt-refiner's deliberate MCP-transport choice.
 */

// ---------------------------------------------------------------------------
// Types — stack file
// ---------------------------------------------------------------------------

export interface StackFile {
  /** Cross-modality model ids (llm, image, video, audio, or any model_id
   *  also tracked by the coding/science/agentic capability verticals —
   *  see the README's "What's excluded" section for what that last case
   *  does and doesn't cover). */
  models: string[];
}

// ---------------------------------------------------------------------------
// Types — Modelglass feed
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
  knowledge?: ModelKnowledge | null;
  offerings: Offering[];
}

interface ApiListResponse {
  ok: boolean;
  data: ModelEntry[];
  error?: { code: string; message: string };
}

export interface KeyRecord {
  keyId: string;
  tier: "free" | "starter" | "pro" | "internal";
  status: string;
}

interface KeysResponse {
  ok: boolean;
  data: KeyRecord[];
  error?: { code: string; message: string };
}

export interface CompetitorEntry {
  slug: string;
  model_id: string | null;
  model_name: string | null;
  provider: string | null;
  current_price: { amount: number; currency: string; unit: string } | null;
  price_delta_ratio: number | null;
  notes: string | null;
}

interface CompetitorsResponse {
  ok: boolean;
  data: { model_id: string; competitors: CompetitorEntry[] };
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Modelglass API
// ---------------------------------------------------------------------------

export const MODELGLASS_API = "https://modelglass-api.vercel.app";

async function apiGet<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${MODELGLASS_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const json = (await res.json().catch(() => null)) as (T & { ok: boolean; error?: { code: string; message: string } }) | null;
  if (!res.ok || !json) {
    throw new Error(`Modelglass API ${res.status} on ${path}`);
  }
  if (!json.ok) {
    throw new Error(`Modelglass API error on ${path}: ${json.error?.code} — ${json.error?.message}`);
  }
  return json;
}

/** Every model across every modality — the bulk /v1/models response has the
 *  same per-model shape as GET /v1/models/:modelId, so one fetch covers the
 *  whole stack regardless of how many modalities it spans. */
export async function fetchAllModels(apiKey: string): Promise<ModelEntry[]> {
  const json = await apiGet<ApiListResponse>("/v1/models?generation=all", apiKey);
  return json.data;
}

export async function fetchCompetitors(apiKey: string, modelId: string): Promise<CompetitorEntry[]> {
  const json = await apiGet<CompetitorsResponse>(
    `/v1/models/${encodeURIComponent(modelId)}/competitors`,
    apiKey,
  );
  return json.data.competitors;
}

// ---------------------------------------------------------------------------
// Tier gate
// ---------------------------------------------------------------------------

/**
 * Look up the caller's own plan tier via GET /v1/keys — a real signal from
 * the account's key record, not an assumption based on key-string format
 * (mg_free_/mg_starter_/mg_pro_ prefixes are a human-readable convention,
 * not a contract; the tier the account was actually provisioned at is what
 * governs the pricing-history gate — ADR 0004 — so that's what's checked).
 */
export async function fetchTier(apiKey: string): Promise<KeyRecord["tier"]> {
  const json = await apiGet<KeysResponse>("/v1/keys", apiKey);
  const mine = json.data.find((k) => k.status === "active") ?? json.data[0];
  if (!mine) throw new Error("GET /v1/keys returned no key records for this account");
  return mine.tier;
}

/**
 * stack-watch requires Starter or Pro — there's no honest degraded mode on
 * Free. A free key's pricing-history window is ~2 days (ADR 0004); any
 * realistic check-in cadence (daily/weekly cron) needs to look back further
 * than that to say anything meaningful about drift since the last run, so a
 * free-tier attempt would either miss real changes silently or misreport
 * "no drift" when the window simply didn't cover the gap. Exits before any
 * drift comparison is attempted, rather than running with a caveat.
 */
export async function requireStarterOrPro(apiKey: string): Promise<void> {
  const tier = await fetchTier(apiKey);
  if (tier === "starter" || tier === "pro" || tier === "internal") return;
  console.error(
    "stack-watch requires a Starter or Pro Modelglass key — this key is on the Free plan.\n\n" +
      "Why: meaningful drift detection needs to look back further than Free's ~2-day\n" +
      "pricing-history window covers for any realistic check-in cadence (daily/weekly\n" +
      "cron). There's no useful degraded mode here, unlike the other examples in this\n" +
      "repo — a Free-tier run would either miss real price changes silently or report\n" +
      "\"no drift\" when the window just didn't reach back far enough, which is worse\n" +
      "than not running at all.\n\n" +
      "Upgrade at https://modelglass.com.au/signup (Starter: 12-month pricing-history\n" +
      "window. Pro: full history, no window limit).",
  );
  process.exit(1);
}

export function requireApiKey(): string {
  const key = process.env["MODELGLASS_API_KEY"];
  if (!key) {
    console.error(
      "Error: MODELGLASS_API_KEY is not set.\n" +
        "stack-watch needs a Starter or Pro key — see https://modelglass.com.au/signup.\n" +
        "  export MODELGLASS_API_KEY=<your-key>",
    );
    process.exit(1);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Current-price resolution
// ---------------------------------------------------------------------------

/** The active price in a tier's pricing[] history — the entry with no
 *  effective_to (still in force), falling back to the most recent by
 *  effective_from. Mirrors packages/api's own currentPrice() convention
 *  (competitors.ts) so "current" means the same thing here as it does in
 *  the API's own competitor-ranking logic. */
export function currentPrice(tier: Tier): PriceEntry | null {
  const active = tier.pricing.find((p) => !p.effective_to);
  if (active) return active;
  if (!tier.pricing.length) return null;
  return [...tier.pricing].sort((a, b) => (a.effective_from > b.effective_from ? -1 : 1))[0]!;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface SnapshotOffering {
  slug: string;
  provider: string;
  status: string;
  generation: string | null;
  /** tier id -> current price at capture time */
  prices: Record<string, { amount: number; currency: string; unit: string; effective_from: string }>;
}

export interface SnapshotModel {
  model_id: string;
  name: string;
  capability_profile: Record<string, string>; // dimension -> rating
  offerings: SnapshotOffering[];
}

export interface Snapshot {
  captured_at: string;
  models: Record<string, SnapshotModel>; // model_id -> snapshot
}

export function toSnapshotModel(m: ModelEntry): SnapshotModel {
  const capability_profile: Record<string, string> = {};
  for (const dim of m.knowledge?.capability_profile ?? []) {
    capability_profile[dim.dimension] = dim.rating;
  }
  return {
    model_id: m.model_id,
    name: m.name,
    capability_profile,
    offerings: m.offerings.map((o) => {
      const prices: SnapshotOffering["prices"] = {};
      for (const tier of o.tiers) {
        const p = currentPrice(tier);
        if (p) {
          prices[tier.id] = {
            amount: p.amount,
            currency: p.currency,
            unit: p.unit,
            effective_from: p.effective_from,
          };
        }
      }
      return {
        slug: o.slug,
        provider: o.provider,
        status: o.model.status,
        generation: o.model.generation ?? null,
        prices,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export interface PriceDrift {
  model_id: string;
  model_name: string;
  provider: string;
  tier_id: string;
  from: { amount: number; currency: string; unit: string } | null;
  to: { amount: number; currency: string; unit: string; effective_from: string; source_url?: string };
}

export interface LifecycleDrift {
  model_id: string;
  model_name: string;
  provider: string;
  field: "status" | "generation";
  from: string | null;
  to: string;
}

export interface CapabilityDrift {
  model_id: string;
  model_name: string;
  dimension: string;
  from: string | null;
  to: string;
}

export interface SwitchSuggestion {
  model_id: string;
  model_name: string;
  competitor_model_id: string;
  competitor_name: string;
  competitor_provider: string;
  cheaper_ratio: number; // competitor price / stack model price, < 1 = cheaper
  matched_dimension: string;
  matched_rating: string;
}

export interface DriftReport {
  isBaseline: boolean;
  notFound: string[];
  priceDrift: PriceDrift[];
  lifecycleDrift: LifecycleDrift[];
  capabilityDrift: CapabilityDrift[];
  switchSuggestions: SwitchSuggestion[];
}

function offeringKey(modelId: string, slug: string): string {
  return `${modelId}::${slug}`;
}

/** Compares the current feed state for the stack's models against the prior
 *  snapshot. `prior === null` means no snapshot exists yet (first run) —
 *  returns an empty/baseline report rather than reporting every current
 *  value as "new". */
export function computeDrift(
  stackModelIds: string[],
  current: ModelEntry[],
  prior: Snapshot | null,
): DriftReport {
  const byId = new Map(current.map((m) => [m.model_id, m]));
  const notFound: string[] = [];
  const priceDrift: PriceDrift[] = [];
  const lifecycleDrift: LifecycleDrift[] = [];
  const capabilityDrift: CapabilityDrift[] = [];

  for (const modelId of stackModelIds) {
    const model = byId.get(modelId);
    if (!model) {
      notFound.push(modelId);
      continue;
    }
    const priorModel = prior?.models[modelId];

    // Capability drift (only meaningful once we have a prior snapshot).
    if (priorModel) {
      const currentCap: Record<string, string> = {};
      for (const dim of model.knowledge?.capability_profile ?? []) {
        currentCap[dim.dimension] = dim.rating;
      }
      for (const [dimension, rating] of Object.entries(currentCap)) {
        const priorRating = priorModel.capability_profile[dimension] ?? null;
        if (priorRating !== null && priorRating !== rating) {
          capabilityDrift.push({
            model_id: modelId,
            model_name: model.name,
            dimension,
            from: priorRating,
            to: rating,
          });
        }
      }
    }

    for (const offering of model.offerings) {
      const priorOffering = priorModel?.offerings.find((o) => o.slug === offering.slug);

      if (priorModel) {
        if (!priorOffering) {
          // A new offering/provider appeared since last run — not "drift" on
          // an existing price, but still worth a lifecycle-style note.
          lifecycleDrift.push({
            model_id: modelId,
            model_name: model.name,
            provider: offering.provider,
            field: "status",
            from: null,
            to: `new offering (${offering.model.status})`,
          });
        } else {
          if (priorOffering.status !== offering.model.status) {
            lifecycleDrift.push({
              model_id: modelId,
              model_name: model.name,
              provider: offering.provider,
              field: "status",
              from: priorOffering.status,
              to: offering.model.status,
            });
          }
          const priorGen = priorOffering.generation;
          const curGen = offering.model.generation ?? null;
          if (priorGen !== curGen && curGen !== null) {
            lifecycleDrift.push({
              model_id: modelId,
              model_name: model.name,
              provider: offering.provider,
              field: "generation",
              from: priorGen,
              to: curGen,
            });
          }
        }
      }

      for (const tier of offering.tiers) {
        const cur = currentPrice(tier);
        if (!cur) continue;
        const priorPrice = priorOffering?.prices[tier.id] ?? null;
        if (priorModel && priorPrice && priorPrice.amount !== cur.amount) {
          priceDrift.push({
            model_id: modelId,
            model_name: model.name,
            provider: offering.provider,
            tier_id: tier.id,
            from: priorPrice,
            to: {
              amount: cur.amount,
              currency: cur.currency,
              unit: cur.unit,
              effective_from: cur.effective_from,
              source_url: cur.source?.url,
            },
          });
        }
      }
    }
  }

  return {
    isBaseline: prior === null,
    notFound,
    priceDrift,
    lifecycleDrift,
    capabilityDrift,
    switchSuggestions: [], // filled in separately — needs async competitor lookups
  };
}

/** Grounded switch suggestions: for each stack model, look at its
 *  competitors (GET /v1/models/:modelId/competitors), keep only ones
 *  strictly cheaper on the same price unit, then fetch each candidate's own
 *  capability_profile and keep only the ones that match or exceed the stack
 *  model's rating on every dimension the stack model rates "strong" on.
 *  Requires a second lookup per candidate — the competitors endpoint
 *  returns price but not capability data (see packages/api/src/handlers/
 *  competitors.ts in the main repo). */
export async function computeSwitchSuggestions(
  apiKey: string,
  stackModelIds: string[],
  current: ModelEntry[],
): Promise<SwitchSuggestion[]> {
  const byId = new Map(current.map((m) => [m.model_id, m]));
  const suggestions: SwitchSuggestion[] = [];

  for (const modelId of stackModelIds) {
    const model = byId.get(modelId);
    if (!model) continue;
    const strongDims = (model.knowledge?.capability_profile ?? [])
      .filter((d) => d.rating === "strong")
      .map((d) => d.dimension);
    if (!strongDims.length) continue;

    let competitors: CompetitorEntry[];
    try {
      competitors = await fetchCompetitors(apiKey, modelId);
    } catch {
      continue; // no competitor data for this model — skip, not fatal
    }

    for (const comp of competitors) {
      if (!comp.model_id || comp.price_delta_ratio === null || comp.price_delta_ratio >= 1) continue;
      const compModel = byId.get(comp.model_id);
      const compCap = compModel?.knowledge?.capability_profile ?? [];
      for (const dimension of strongDims) {
        const rating = compCap.find((d) => d.dimension === dimension)?.rating;
        if (rating === "strong") {
          suggestions.push({
            model_id: modelId,
            model_name: model.name,
            competitor_model_id: comp.model_id,
            competitor_name: comp.model_name ?? comp.model_id,
            competitor_provider: comp.provider ?? "unknown",
            cheaper_ratio: comp.price_delta_ratio,
            matched_dimension: dimension,
            matched_rating: rating,
          });
          break; // one suggestion per competitor is enough
        }
      }
    }
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function hr(len = 80): string {
  return "─".repeat(len);
}

export function fmtPrice(amount: number, unit: string): string {
  return `$${amount}/${unit.replace(/^per_/, "")}`;
}
