/**
 * Modelglass feed fetching, tier introspection, and migration-diff computation
 * for switch-check.
 *
 * SCO-338 follow-on: tier introspection and competitor lookups now go over
 * the MCP endpoint (`POST /mcp`, tools `modelglass_get_account` and
 * `modelglass_get_competitors`) instead of REST — same swap as stack-watch,
 * closing the gap this file used to document (neither capability was exposed
 * by any of the original four MCP tools; PR #307 added both). The bulk model
 * list still uses the plain REST feed (`GET /v1/models`) — no MCP tool
 * returns the full cross-modality listing this tool needs, so that stays on
 * REST.
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
// Types — switch-check's own REST/MCP response shapes (not shared; specific
// to this tool's fetch calls, not to the pure math)
// ---------------------------------------------------------------------------

interface ApiListResponse {
  ok: boolean;
  data: ModelEntry[];
  error?: { code: string; message: string };
}

/** Shape of `modelglass_get_account`'s `data` — the calling credential's own
 *  account record, scoped to exactly that key (unlike the old GET /v1/keys
 *  response this replaces, which returned every key on the account). */
export interface AccountInfo {
  keyId: string;
  tier: PlanTier;
  status: string;
  label?: string;
  createdAt?: string;
  expiresAt?: string;
  lastUsedAt?: string;
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

interface CompetitorsResult {
  model_id: string;
  source_slug: string | null;
  competitors: CompetitorEntry[];
}

// ---------------------------------------------------------------------------
// Modelglass REST API — still used for the bulk model list only (see the
// file-level comment above for why this one call stays on REST)
// ---------------------------------------------------------------------------

// Override for pointing at a local/self-hosted API instance (e.g. `pnpm dev:api`
// in the main modelglass repo) — used to verify this tool against Starter/Pro
// dev keys without a production paid account. Unset in normal use; defaults to
// the live production API. Also the base for the /mcp endpoint below — same
// host, same auth, just a different path.
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

// ---------------------------------------------------------------------------
// Modelglass MCP endpoint — account + competitor lookups (SCO-338)
// ---------------------------------------------------------------------------

interface McpToolEnvelope<T> {
  schema_version: number;
  artifact_version: number;
  built_at: string;
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: { content: { type: string; text: string }[]; structuredContent: unknown; isError: boolean };
  error?: { code: number; message: string; data?: unknown };
}

let mcpRequestId = 0;

/** Calls one Modelglass MCP tool over the same stateless JSON-RPC HTTP
 *  endpoint (`POST /mcp`, docs/mcp-usage.md in the main repo) any MCP client
 *  uses — gated by the same Bearer-key `auth` as the REST API, so one call
 *  here costs exactly one rate-limit unit, same as one REST GET. Unwraps the
 *  JSON-RPC envelope and the tool's own ok/error envelope (contract.ts) down
 *  to `data`, throwing the same `Modelglass API error on ...` shape apiGet's
 *  REST callers already throw, so nothing downstream needs to change error
 *  handling to match a new shape. */
async function mcpCall<T>(toolName: string, args: Record<string, unknown>, apiKey: string): Promise<T> {
  const res = await fetch(`${MODELGLASS_API}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++mcpRequestId,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  const body = (await res.json().catch(() => null)) as McpJsonRpcResponse | null;
  if (!res.ok || !body) {
    throw new Error(`Modelglass API ${res.status} on mcp:${toolName}`);
  }
  if (body.error) {
    throw new Error(`Modelglass API error on mcp:${toolName}: ${body.error.code} — ${body.error.message}`);
  }
  const payload = body.result?.structuredContent as McpToolEnvelope<T> | undefined;
  if (!payload || !payload.ok) {
    throw new Error(
      `Modelglass API error on mcp:${toolName}: ${payload?.error?.code ?? "UNKNOWN"} — ` +
        `${payload?.error?.message ?? "no structuredContent in MCP response"}`,
    );
  }
  return payload.data as T;
}

export async function fetchCompetitors(apiKey: string, modelId: string): Promise<CompetitorEntry[]> {
  const result = await mcpCall<CompetitorsResult>(
    "modelglass_get_competitors",
    { model_id: modelId },
    apiKey,
  );
  return result.competitors;
}

/**
 * The caller's own plan tier via the modelglass_get_account MCP tool — a
 * real signal from the account's own key record, not an assumption based on
 * key-string format (same approach as stack-watch). Unlike stack-watch this
 * is NOT a gate: every tier runs. The tier decides how the price-stability
 * section is framed — what history window the numbers were computed under,
 * and (on Free) what Starter/Pro would add to this specific run.
 */
export async function fetchTier(apiKey: string): Promise<PlanTier> {
  const account = await mcpCall<AccountInfo>("modelglass_get_account", {}, apiKey);
  return account.tier;
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
