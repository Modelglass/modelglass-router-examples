/**
 * Modelglass MCP client + grounding-context formatting for the AV Prompt Refiner.
 *
 * Talks to the live Modelglass HTTP MCP endpoint directly over JSON-RPC (no MCP
 * client library) — see https://github.com/Modelglass/modelglass/blob/main/docs/mcp-usage.md.
 * This is deliberately a different integration style than cost-aware-vscode-router's
 * lib.ts, which calls the plain REST feed (GET /v1/models) — this example calls the
 * MCP surface specifically, since that's the tool surface an agent/IDE integration
 * would actually use.
 */

export type Mode = "video" | "audio" | "both";

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

export interface ModelProfile {
  model_id: string;
  name: string;
  /** Raw `knowledge` object from the joined artifact — shape varies by modality
   *  (video models carry max_clip_duration/supported_resolutions/generation_modes;
   *  audio models carry sub_modality/features_and_differences; both share
   *  capability_profile/use_cases/routing_guidance/limitations/notes). Untyped
   *  here deliberately — see formatGroundingContext for how it's used. */
  knowledge: Record<string, unknown> | null;
}

/** Fetch one model's full profile (pricing + capability knowledge) via the live
 *  Modelglass MCP endpoint (modelglass_get_model tool). */
export async function fetchModelProfile(apiKey: string, modelId: string): Promise<ModelProfile> {
  const data = (await callMcpTool(apiKey, "modelglass_get_model", {
    model_id: modelId,
  })) as { model_id: string; name: string; knowledge: Record<string, unknown> | null };
  if (!data.knowledge) {
    throw new Error(
      `'${modelId}' has no capability profile in the Modelglass registry (pricing-only entry) — ` +
        "this tool needs a model with ontology data to ground the prompt rewrite.",
    );
  }
  return { model_id: data.model_id, name: data.name, knowledge: data.knowledge };
}

/** Fields on `knowledge` that are provenance/licensing metadata, not useful for
 *  writing a generation prompt — dropped from the grounding context to keep it
 *  focused on what actually shapes a prompt. */
const NON_PROMPT_FIELDS = new Set([
  "schema_version",
  "model_id",
  "name",
  "creator",
  "training",
  "benchmarks",
  "citations",
  "origin",
  "license",
  "ethical_notes",
  "training_data_notes",
  "capability_confidence",
]);

/** Format one model's capability profile as a grounding-context block for the
 *  system prompt. Passes through whatever modality-specific fields exist
 *  (max_clip_duration, sub_modality, etc.) rather than hardcoding a schema —
 *  video and audio ontology entries carry different top-level fields beyond
 *  the shared capability_profile/use_cases/routing_guidance/limitations shape. */
export function formatGroundingContext(profile: ModelProfile, mediaLabel: "video" | "audio"): string {
  const knowledge = profile.knowledge as Record<string, unknown>;
  const filtered = Object.fromEntries(
    Object.entries(knowledge).filter(([key]) => !NON_PROMPT_FIELDS.has(key)),
  );
  return `### ${profile.name} (${profile.model_id}) — ${mediaLabel} model\n\n${JSON.stringify(filtered, null, 2)}`;
}

export function requireApiKey(name: "MODELGLASS_API_KEY" | "ANTHROPIC_API_KEY"): string {
  const key = process.env[name];
  if (key) return key;
  console.error(`Error: ${name} is not set.`);
  if (name === "MODELGLASS_API_KEY") {
    console.error(
      "Get a free key at https://modelglass.com.au/signup, then:\n  export MODELGLASS_API_KEY=<your-key>",
    );
  } else {
    console.error(
      "Get a key at https://console.anthropic.com, then:\n  export ANTHROPIC_API_KEY=<your-key>",
    );
  }
  process.exit(1);
}
