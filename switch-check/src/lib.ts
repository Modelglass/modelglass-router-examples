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
 *
 * The feed types and pure diff/delta math (unit-matched pricing, price
 * stability, capability diffing, unit warnings, lifecycle checks) live in
 * ../../pricing-math (SCO-217) — shared with the Modelglass MCP server's
 * compare_models tool. This file re-exports them so check.ts and this
 * module's own tests are unaffected by the extraction.
 */

import type { ModelEntry, PlanTier } from "../../pricing-math/src/index.js";

export type {
  CapabilityDim,
  PriceSource,
  PriceEntry,
  Tier,
  ModelInfo,
  Offering,
  ModelKnowledge,
  ModelEntry,
  OfferPrice,
  UnitComparison,
  PriceComparison,
  HistoryAnalysis,
  CapabilityChange,
  UnitWarning,
  LifecycleFlag,
  PlanTier,
} from "../../pricing-math/src/index.js";

export {
  currentPrice,
  collectCurrentPrices,
  comparePrices,
  daysBetween,
  analyzeHistory,
  analyzeModelHistory,
  historyWindowLabel,
  RATING_ORDER,
  capabilityDiff,
  unitWarnings,
  lifecycleCheck,
} from "../../pricing-math/src/index.js";

// ---------------------------------------------------------------------------
// Types — switch-check's own REST responses (not shared; specific to this
// tool's fetch calls, not to the pure math)
// ---------------------------------------------------------------------------

interface ApiListResponse {
  ok: boolean;
  data: ModelEntry[];
  error?: { code: string; message: string };
}

export interface KeyRecord {
  keyId: string;
  tier: PlanTier;
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
