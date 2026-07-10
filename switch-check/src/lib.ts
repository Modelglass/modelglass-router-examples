/**
 * Modelglass feed fetching, tier introspection, and migration-diff computation
 * for switch-check.
 *
 * Uses the plain REST feed (GET /v1/models, GET /v1/keys,
 * GET /v1/models/:modelId/competitors) rather than the MCP endpoint — same
 * reasoning as stack-watch: two of the capabilities this tool needs (tier
 * introspection via /v1/keys, and competitor lookups via
 * /v1/models/:modelId/competitors) aren't exposed by any of the four MCP
 * tools, so there's no MCP-only path available here.
 */

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
  join_status?: string;
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
  tier: "free" | "app" | "starter" | "pro" | "internal";
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

// Override for pointing at a local/self-hosted API instance (e.g. `pnpm dev:api`
// in the main modelglass repo) — used to verify this tool against Starter/Pro
// dev keys without a production paid account. Unset in normal use; defaults to
// the live production API.
export const MODELGLASS_API = process.env["MODELGLASS_API_URL"] || "https://modelglass-api.vercel.app";

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

/** Every model across every modality, including previous-generation ones —
 *  a migration diff must be able to say "the model you're moving TO is
 *  previous-gen," which requires previous-gen models to be in the pool at
 *  all (the feed's default is current-generation only). */
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

/**
 * The caller's own plan tier via GET /v1/keys — a real signal from the
 * account's key record, not an assumption based on key-string format (same
 * approach as stack-watch). Unlike stack-watch this is NOT a gate: every
 * tier runs. The tier decides how the price-stability section is framed —
 * what history window the numbers were computed under, and (on Free) what
 * Starter/Pro would add to this specific run.
 */
export async function fetchTier(apiKey: string): Promise<KeyRecord["tier"]> {
  const json = await apiGet<KeysResponse>("/v1/keys", apiKey);
  const mine = json.data.find((k) => k.status === "active") ?? json.data[0];
  if (!mine) throw new Error("GET /v1/keys returned no key records for this account");
  return mine.tier;
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

// ---------------------------------------------------------------------------
// Current-price resolution
// ---------------------------------------------------------------------------

/** The active price in a tier's pricing[] history — the entry with no
 *  effective_to (still in force), falling back to the most recent by
 *  effective_from. Mirrors packages/api's own currentPrice() convention so
 *  "current" means the same thing here as in the API's competitor ranking. */
export function currentPrice(tier: Tier): PriceEntry | null {
  const active = tier.pricing.find((p) => !p.effective_to);
  if (active) return active;
  if (!tier.pricing.length) return null;
  return [...tier.pricing].sort((a, b) => (a.effective_from > b.effective_from ? -1 : 1))[0]!;
}

// ---------------------------------------------------------------------------
// Section 1a — current price, unit-matched
// ---------------------------------------------------------------------------

export interface OfferPrice {
  provider: string;
  slug: string;
  tier_id: string;
  amount: number;
  currency: string;
  unit: string;
  effective_from: string;
  source_url?: string;
}

export interface UnitComparison {
  unit: string;
  from: OfferPrice; // cheapest current price on the from-side for this unit
  to: OfferPrice; // cheapest current price on the to-side for this unit
  /** (to - from) / from × 100 — negative means the to-model is cheaper. */
  delta_pct: number;
}

export interface PriceComparison {
  shared: UnitComparison[];
  /** Units priced on only one side — never force-converted into the other
   *  side's unit (see unitWarnings for why). */
  fromOnly: OfferPrice[];
  toOnly: OfferPrice[];
}

/** All current prices for a model, one per offering×tier. */
export function collectCurrentPrices(model: ModelEntry): OfferPrice[] {
  const prices: OfferPrice[] = [];
  for (const off of model.offerings) {
    for (const tier of off.tiers) {
      const p = currentPrice(tier);
      if (!p) continue;
      prices.push({
        provider: off.provider,
        slug: off.slug,
        tier_id: tier.id,
        amount: p.amount,
        currency: p.currency,
        unit: p.unit,
        effective_from: p.effective_from,
        source_url: p.source?.url,
      });
    }
  }
  return prices;
}

/** Unit-matched price deltas: for every billing unit present on BOTH sides,
 *  compare the cheapest current price on each (apples-to-apples, same rule
 *  the API's own competitor ranking uses — it only computes a ratio when the
 *  units match). Units present on one side only are reported as-is, never
 *  converted. */
export function comparePrices(fromModel: ModelEntry, toModel: ModelEntry): PriceComparison {
  const fromPrices = collectCurrentPrices(fromModel);
  const toPrices = collectCurrentPrices(toModel);

  const byUnit = (prices: OfferPrice[]) => {
    const m = new Map<string, OfferPrice[]>();
    for (const p of prices) {
      const list = m.get(p.unit) ?? [];
      list.push(p);
      m.set(p.unit, list);
    }
    return m;
  };
  const fromByUnit = byUnit(fromPrices);
  const toByUnit = byUnit(toPrices);

  const cheapest = (list: OfferPrice[]) => [...list].sort((a, b) => a.amount - b.amount)[0]!;

  const shared: UnitComparison[] = [];
  const fromOnly: OfferPrice[] = [];
  const toOnly: OfferPrice[] = [];

  for (const [unit, list] of fromByUnit) {
    const toList = toByUnit.get(unit);
    if (toList) {
      const from = cheapest(list);
      const to = cheapest(toList);
      shared.push({
        unit,
        from,
        to,
        delta_pct: ((to.amount - from.amount) / from.amount) * 100,
      });
    } else {
      fromOnly.push(...list);
    }
  }
  for (const [unit, list] of toByUnit) {
    if (!fromByUnit.has(unit)) toOnly.push(...list);
  }

  shared.sort((a, b) => a.unit.localeCompare(b.unit));
  return { shared, fromOnly, toOnly };
}

// ---------------------------------------------------------------------------
// Section 1b — price stability, from the append-only history
// ---------------------------------------------------------------------------

export interface HistoryAnalysis {
  provider: string;
  tier_id: string;
  /** How many history entries the calling key's plan window let through
   *  (ADR 0004 — free ≈2 days, starter 12 months, pro all; the current
   *  price is always visible regardless). */
  visible_entries: number;
  current: {
    amount: number;
    currency: string;
    unit: string;
    effective_from: string;
    age_days: number;
    source_url?: string;
  };
  /** The entry the current price superseded, when the window shows it. */
  previous: {
    amount: number;
    effective_from: string;
    direction: "cut" | "raise";
    delta_pct: number;
    source_url?: string;
  } | null;
}

export function daysBetween(fromIso: string, to: Date): number {
  const from = new Date(fromIso);
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

/** Stability analysis for one offering×tier, computed from whatever slice of
 *  the append-only pricing[] history the caller's plan window exposes. */
export function analyzeHistory(
  provider: string,
  tier: Tier,
  today: Date = new Date(),
): HistoryAnalysis | null {
  const cur = currentPrice(tier);
  if (!cur) return null;
  const sorted = [...tier.pricing].sort((a, b) => (a.effective_from > b.effective_from ? -1 : 1));
  const curIdx = sorted.indexOf(cur);
  const prev = curIdx >= 0 ? (sorted[curIdx + 1] ?? null) : null;
  return {
    provider,
    tier_id: tier.id,
    visible_entries: tier.pricing.length,
    current: {
      amount: cur.amount,
      currency: cur.currency,
      unit: cur.unit,
      effective_from: cur.effective_from,
      age_days: daysBetween(cur.effective_from, today),
      source_url: cur.source?.url,
    },
    previous: prev
      ? {
          amount: prev.amount,
          effective_from: prev.effective_from,
          direction: cur.amount < prev.amount ? "cut" : "raise",
          delta_pct: ((cur.amount - prev.amount) / prev.amount) * 100,
          source_url: cur.source?.url ?? prev.source?.url,
        }
      : null,
  };
}

export function analyzeModelHistory(model: ModelEntry, today: Date = new Date()): HistoryAnalysis[] {
  const analyses: HistoryAnalysis[] = [];
  for (const off of model.offerings) {
    for (const tier of off.tiers) {
      const a = analyzeHistory(off.provider, tier, today);
      if (a) analyses.push(a);
    }
  }
  return analyses;
}

/** Human framing of the pricing-history window the caller's plan grants
 *  (ADR 0004) — printed with the stability section so every number above it
 *  is read against the window it was computed under. */
export function historyWindowLabel(tier: KeyRecord["tier"]): string {
  switch (tier) {
    case "free":
      return "Free plan — ≈2-day window (current price always visible)";
    case "app":
      return "App plan — 90-day window (current price always visible)";
    case "starter":
      return "Starter plan — 12-month window (current price always visible)";
    case "pro":
      return "Pro plan — full append-only history, no window";
    case "internal":
      return "Internal plan — full append-only history, no window";
  }
}

// ---------------------------------------------------------------------------
// Section 2 — capability diff
// ---------------------------------------------------------------------------

/** Ordinal scale as used across the rest of the site — a small, stable
 *  vocabulary, unlike capability *dimensions*, which this tool deliberately
 *  does NOT hardcode and instead reads off both models' live profiles. */
export const RATING_ORDER = ["weak", "moderate", "strong"] as const;

function ratingIndex(rating: string): number {
  return RATING_ORDER.indexOf(rating as (typeof RATING_ORDER)[number]);
}

export interface CapabilityChange {
  dimension: string;
  from: string | null;
  to: string | null;
  kind: "lose" | "gain" | "same" | "unverifiable";
}

function profileMap(model: ModelEntry): Map<string, string> {
  return new Map((model.knowledge?.capability_profile ?? []).map((d) => [d.dimension, d.rating]));
}

/** Per-dimension diff across the union of both models' capability_profile
 *  dimensions. A dimension rated on only one side is "unverifiable" — the
 *  honest answer when the registry has no rating to compare against, not a
 *  silent omission and not an assumed loss. Ratings outside the known
 *  ordinal scale also land in "unverifiable" rather than being force-ranked. */
export function capabilityDiff(fromModel: ModelEntry, toModel: ModelEntry): CapabilityChange[] {
  const fromCap = profileMap(fromModel);
  const toCap = profileMap(toModel);
  const dims = [...new Set([...fromCap.keys(), ...toCap.keys()])].sort();

  return dims.map((dimension) => {
    const from = fromCap.get(dimension) ?? null;
    const to = toCap.get(dimension) ?? null;
    if (from === null || to === null) return { dimension, from, to, kind: "unverifiable" as const };
    const fi = ratingIndex(from);
    const ti = ratingIndex(to);
    if (fi === -1 || ti === -1) return { dimension, from, to, kind: "unverifiable" as const };
    if (ti < fi) return { dimension, from, to, kind: "lose" as const };
    if (ti > fi) return { dimension, from, to, kind: "gain" as const };
    return { dimension, from, to, kind: "same" as const };
  });
}

// ---------------------------------------------------------------------------
// Section 3 — billing-unit warnings
// ---------------------------------------------------------------------------

/** Why specific unit changes deserve a warning, in image-batch-coster's
 *  honest-unit house style: name how the cost curve changes, never fake a
 *  conversion factor. */
const UNIT_CHANGE_NOTES: Record<string, string> = {
  "per_image→per_megapixel":
    "cost stops being flat per generation and starts scaling with resolution — equal at 1MP, " +
    "but a 2048×2048 image is ~4.2MP, so the same per-unit rate costs ~4× more per image there.",
  "per_megapixel→per_image":
    "cost stops scaling with resolution and becomes flat per generation — cheaper for " +
    "high-resolution output, comparatively worse for small thumbnails.",
  "per_image→per_second":
    "cost starts scaling with inference time instead of output count — job cost now depends " +
    "on steps/settings, not just how many images you make.",
  "per_second→per_image":
    "cost stops scaling with inference time and becomes flat per generation.",
};

const NON_CONVERTIBLE_UNITS: Record<string, string> = {
  per_credit:
    "billed in provider credits — converting to a dollar rate would require guessing how many " +
    "credits one generation consumes, which Modelglass does not track. Listed at face value.",
  per_month:
    "a flat subscription, not a per-generation charge — amortizing it into a comparable rate " +
    "would require assuming a usage volume this tool has no basis for. Listed at face value.",
};

export interface UnitWarning {
  from_unit: string;
  to_unit: string;
  note: string;
}

/** Warnings for every (from-unit, to-unit) pairing that changes the cost
 *  curve. Only fires when the from-side unit has no same-unit counterpart on
 *  the to-side (if both sides price per_image, moving between them on that
 *  unit is a pure rate change and section 1 already covers it). */
export function unitWarnings(comparison: PriceComparison): UnitWarning[] {
  const warnings: UnitWarning[] = [];
  const seen = new Set<string>();

  for (const f of comparison.fromOnly) {
    for (const t of comparison.toOnly) {
      const key = `${f.unit}→${t.unit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const note = UNIT_CHANGE_NOTES[key];
      warnings.push({
        from_unit: f.unit,
        to_unit: t.unit,
        note:
          note ??
          `no safe conversion between '${f.unit}' and '${t.unit}' — compared at face value only.`,
      });
    }
  }

  // Non-convertible units on either side get flagged even without a pairing.
  for (const p of [...comparison.fromOnly, ...comparison.toOnly]) {
    const reason = NON_CONVERTIBLE_UNITS[p.unit];
    const key = `nc:${p.unit}`;
    if (reason && !seen.has(key)) {
      seen.add(key);
      warnings.push({ from_unit: p.unit, to_unit: p.unit, note: reason });
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Section 4 — lifecycle
// ---------------------------------------------------------------------------

export interface LifecycleFlag {
  side: "from" | "to";
  model_id: string;
  provider: string;
  field: "status" | "generation";
  value: string;
  severity: "warn" | "info";
  note: string;
}

/** Lifecycle check in both directions. Non-ga status or previous generation
 *  on the TO side is a warning (you'd be migrating onto a model already on
 *  its way out); the same on the FROM side is informational context (it
 *  explains the pressure to switch). */
export function lifecycleCheck(fromModel: ModelEntry, toModel: ModelEntry): LifecycleFlag[] {
  const flags: LifecycleFlag[] = [];
  const sides: Array<{ side: "from" | "to"; model: ModelEntry }> = [
    { side: "from", model: fromModel },
    { side: "to", model: toModel },
  ];
  for (const { side, model } of sides) {
    for (const off of model.offerings) {
      if (off.model.status !== "ga") {
        flags.push({
          side,
          model_id: model.model_id,
          provider: off.provider,
          field: "status",
          value: off.model.status,
          severity: side === "to" ? "warn" : "info",
          note:
            side === "to"
              ? `the ${off.provider} offering you'd be migrating TO is '${off.model.status}', not ga`
              : `the ${off.provider} offering you'd be leaving is '${off.model.status}' — context for why a switch is on the table`,
        });
      }
      const gen = off.model.generation;
      if (gen && gen !== "current") {
        flags.push({
          side,
          model_id: model.model_id,
          provider: off.provider,
          field: "generation",
          value: gen,
          severity: side === "to" ? "warn" : "info",
          note:
            side === "to"
              ? `the ${off.provider} offering you'd be migrating TO is generation '${gen}', not current — it may itself be superseded soon`
              : `the ${off.provider} offering you'd be leaving is generation '${gen}' — context for why a switch is on the table`,
        });
      }
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function hr(len = 96): string {
  return "─".repeat(len);
}

export function fmtPrice(amount: number, unit: string): string {
  return `$${amount}/${unit.replace(/^per_/, "")}`;
}

export function fmtPct(pct: number): string {
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}
