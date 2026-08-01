/**
 * Modelglass feed fetching, tier introspection, and migration-diff computation
 * for switch-check.
 *
 * SCO-338/SCO-351 follow-on: every Modelglass call in this file now goes over
 * the MCP endpoint (`POST /mcp`) instead of REST — same swap as stack-watch.
 * Tier introspection and competitor lookups (`modelglass_get_account`,
 * `modelglass_get_competitors`) shipped in PR #307 to close the gap this file
 * used to document, and the bulk model list (`modelglass_list_models` with
 * `generation: "all"`) was verified live to return the identical full
 * cross-modality listing as the REST `GET /v1/models?generation=all` call it
 * replaces (155/155 models, same id set) — an earlier version of this comment
 * claimed no MCP tool covered that case, which wasn't true even at the time
 * it was written.
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
// Modelglass MCP endpoint — every call in this file (SCO-338/SCO-351)
// ---------------------------------------------------------------------------

// Override for pointing at a local/self-hosted API instance (e.g. `pnpm dev:api`
// in the main modelglass repo) — used to verify this tool against Starter/Pro
// dev keys without a production paid account. Unset in normal use; defaults to
// the live production API.
export const MODELGLASS_API = process.env["MODELGLASS_API_URL"] || "https://modelglass-api.vercel.app";

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

/** Every model across every modality, including previous-generation ones, via
 *  `modelglass_list_models` with `generation: "all"` — a migration diff must
 *  be able to say "the model you're moving TO is previous-gen," which
 *  requires previous-gen models to be in the pool at all (the tool's default
 *  is current-generation only). Verified live to return the identical id set
 *  as the REST `GET /v1/models?generation=all` call this replaces (SCO-351). */
export async function fetchAllModels(apiKey: string): Promise<ModelEntry[]> {
  return mcpCall<ModelEntry[]>("modelglass_list_models", { generation: "all" }, apiKey);
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
