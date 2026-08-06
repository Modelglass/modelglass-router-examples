/**
 * Modelglass MCP client, storyboard/plan types, grounding-context
 * formatting, and refiner-model routing for shot-prompt-refiner (SCO-357).
 *
 * Talks to the live Modelglass HTTP MCP endpoint directly over JSON-RPC (no
 * MCP client library) — same integration style as every other example in
 * this repo (av-prompt-refiner, image-prompt-refiner, shot-plan-compiler).
 * This file deliberately duplicates that boilerplate rather than importing
 * from a sibling example — no example in this repo imports another's code
 * (see the root README's "Model selection logic" note); each is meant to be
 * read and adapted in isolation.
 *
 * This tool refines prompts. It never calls a video-generation provider.
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
// Storyboard / plan types — match shot-plan-compiler's (SCO-190) shapes
// exactly, field for field, so a storyboard.json or `plan.ts --json` output
// produced for one tool is valid input to the other without transformation.
// Copied rather than imported (see file header) — this is the "reuse the
// schema, not a parallel one" resolution from SCO-357's recon step.
// ---------------------------------------------------------------------------

export interface Shot {
  id: string;
  /** The shot's rough, unrefined prompt — shot-plan-compiler calls this
   *  field `description`; this tool treats it as the input to refine. */
  description: string;
  durationSeconds: number;
  resolution: string;
  fps: number;
  audio: boolean;
  continuityFromPrevious?: boolean;
}

export interface Storyboard {
  title: string;
  shots: Shot[];
}

/** The subset of a shot-plan-compiler `CandidateTier` this tool actually
 *  needs — just enough to know which model was picked for a shot. */
export interface PickedTier {
  model_id: string;
  name: string;
  provider: string;
}

export interface PlanShotSelection {
  shot_id: string;
  picked: PickedTier | null;
}

export interface Plan {
  storyboard_title: string;
  selections: PlanShotSelection[];
}

/** The exact `{ storyboard, plan }` shape shot-plan-compiler's
 *  `plan.ts --json` emits on stdout. */
export interface StoryboardPlan {
  storyboard: Storyboard;
  plan: Plan;
}

// ---------------------------------------------------------------------------
// Join — pair each shot with the model shot-plan-compiler picked for it
// ---------------------------------------------------------------------------

export interface ShotWithPick {
  shot: Shot;
  picked: PickedTier;
}

export interface JoinResult {
  pairs: ShotWithPick[];
  /** Shots present in the storyboard but either missing from the plan's
   *  selections or with no picked model (shot-plan-compiler found no
   *  feasible model) — this tool can't refine a prompt for a shot with no
   *  target model, so these are reported and skipped, not silently dropped. */
  skipped: { shot_id: string; reason: string }[];
}

/** Joins a storyboard against a plan by `shot.id === selection.shot_id`.
 *  Order follows the storyboard (the plan's own shot order should already
 *  match it, since shot-plan-compiler derives selections from the same
 *  storyboard, but this doesn't assume that). */
export function joinStoryboardAndPlan(storyboard: Storyboard, plan: Plan): JoinResult {
  const byShotId = new Map(plan.selections.map((s) => [s.shot_id, s]));
  const pairs: ShotWithPick[] = [];
  const skipped: { shot_id: string; reason: string }[] = [];

  for (const shot of storyboard.shots) {
    const selection = byShotId.get(shot.id);
    if (!selection) {
      skipped.push({
        shot_id: shot.id,
        reason: "no matching selection in the plan (shot_id not found in plan.selections)",
      });
      continue;
    }
    if (!selection.picked) {
      skipped.push({
        shot_id: shot.id,
        reason: "plan has no picked model for this shot (shot-plan-compiler found it infeasible)",
      });
      continue;
    }
    pairs.push({ shot, picked: selection.picked });
  }

  return { pairs, skipped };
}

// ---------------------------------------------------------------------------
// Video model capability profile (grounding context for the rewrite)
// ---------------------------------------------------------------------------

export interface ModelProfile {
  model_id: string;
  name: string;
  knowledge: Record<string, unknown> | null;
}

/** Fetch one model's full profile (pricing + capability knowledge) via the
 *  live Modelglass MCP endpoint (modelglass_get_model tool). Same call
 *  av-prompt-refiner/image-prompt-refiner make — this tool needs it
 *  independently of the plan JSON's `picked` field, which only carries
 *  enough to identify which model was picked, not its full knowledge. */
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

/** Video-only allowlist — matches av-prompt-refiner's video subset exactly
 *  (SCO-165 finding #8: allowlist, not denylist, so an unrelated new
 *  registry field never leaks into the prompt by accident). */
const PROMPT_FIELDS = new Set([
  "architecture",
  "capability_profile",
  "use_cases",
  "routing_guidance",
  "limitations",
  "notes",
  "max_clip_duration",
  "supported_resolutions",
  "fps_options",
  "generation_modes",
  "native_audio",
  "api_availability",
  "watermark",
]);

export function formatGroundingContext(profile: ModelProfile): string {
  const knowledge = profile.knowledge as Record<string, unknown>;
  const filtered = Object.fromEntries(
    Object.entries(knowledge).filter(([key]) => PROMPT_FIELDS.has(key)),
  );
  return `### ${profile.name} (${profile.model_id}) — video model\n\n${JSON.stringify(filtered, null, 2)}`;
}

// ---------------------------------------------------------------------------
// Refiner-model routing (the genuinely novel part — SCO-357's actual ask).
// av-prompt-refiner and image-prompt-refiner both hardcode the LLM that does
// the rewrite ("claude-opus-4-8" in refine.ts). This tool routes it instead,
// the same way cost-aware-vscode-router routes a coding task: filter the
// live LLM pool by a capability_profile dimension rating tier, cheapest
// qualifying candidate wins, every exclusion cited by field.
// ---------------------------------------------------------------------------

export type Complexity = "simple" | "complex";

/** A single shot's prompt is "simple cleanup"; a multi-shot storyboard needs
 *  cross-shot narrative/style consistency reasoned about in one pass, which
 *  is the actual thing that gets harder — that's the complexity signal, not
 *  prompt length or an LLM-judged score (which would add its own cost/
 *  latency to decide whether to spend cost/latency, and be circular). */
export function complexityFor(shotCount: number): Complexity {
  return shotCount > 1 ? "complex" : "simple";
}

interface CapabilityDim {
  dimension: string;
  rating: string;
}

interface LLMEntry {
  model_id: string;
  name: string;
  knowledge?: { capability_profile?: CapabilityDim[] };
  offerings: Array<{
    slug: string;
    provider: string;
    tiers: Array<{ id: string; pricing: Array<{ amount: number; unit: string }> }>;
  }>;
}

export interface RefinerCandidate {
  model_id: string;
  name: string;
  slug: string;
  provider: string;
  reasoningRating: string | null;
  inputPricePerM: number | null;
}

/** Fetch the full LLM-modality pool and reduce it to what refiner-model
 *  routing needs: the `reasoning` capability_profile rating and the
 *  cheapest-provider input price, per model. */
export async function fetchLLMModels(apiKey: string): Promise<RefinerCandidate[]> {
  const data = (await callMcpTool(apiKey, "modelglass_list_models", {
    modality: "llm",
  })) as LLMEntry[];
  return data.map((m) => {
    const reasoning =
      m.knowledge?.capability_profile?.find((d) => d.dimension === "reasoning")?.rating ?? null;
    const offering = [...m.offerings].sort((a, b) => {
      const priceA = a.tiers.find((t) => t.id === "input")?.pricing.slice(-1)[0]?.amount ?? Infinity;
      const priceB = b.tiers.find((t) => t.id === "input")?.pricing.slice(-1)[0]?.amount ?? Infinity;
      return priceA - priceB;
    })[0];
    const inputPrice = offering?.tiers.find((t) => t.id === "input")?.pricing.slice(-1)[0];
    return {
      model_id: m.model_id,
      name: m.name,
      slug: offering?.slug ?? m.model_id,
      provider: offering?.provider ?? "",
      reasoningRating: reasoning,
      inputPricePerM: inputPrice?.unit === "per_1m_tokens_input" ? inputPrice.amount : null,
    };
  });
}

const REASONING_RANK: Record<string, number> = {
  strong: 3,
  moderate: 2,
  variable: 1,
  weak: 1,
  unknown: 0,
};

export interface RefinerExclusion {
  model: RefinerCandidate;
  reason: string;
}

export interface RefinerSelection {
  selected: RefinerCandidate | null;
  complexity: Complexity;
  minReasoningRating: "strong" | "moderate";
  qualifying: RefinerCandidate[];
  excluded: RefinerExclusion[];
}

/** Selects the cheapest LLM that clears a reasoning-rating bar set by
 *  complexity, restricted to Anthropic-hosted offerings only.
 *
 *  That restriction is an honest exclusion, not an oversight: this tool
 *  executes the refinement call itself via the Anthropic SDK (BYOK,
 *  ANTHROPIC_API_KEY) — the same single-provider convention every other
 *  LLM-calling example in this repo uses (av-prompt-refiner,
 *  image-prompt-refiner). Recommending a non-Anthropic model this tool then
 *  can't actually call would be a routing result nobody can act on. */
export function selectRefinerModel(
  models: RefinerCandidate[],
  complexity: Complexity,
): RefinerSelection {
  const minReasoningRating = complexity === "complex" ? "strong" : "moderate";
  const minRank = REASONING_RANK[minReasoningRating]!;
  const qualifying: RefinerCandidate[] = [];
  const excluded: RefinerExclusion[] = [];

  for (const m of models) {
    if (m.provider !== "anthropic") {
      excluded.push({
        model: m,
        reason:
          `provider '${m.provider || "unknown"}' — this tool executes the refinement call via the ` +
          `Anthropic SDK (ANTHROPIC_API_KEY, BYOK); only Anthropic-hosted models are executable candidates`,
      });
      continue;
    }
    const rank = REASONING_RANK[m.reasoningRating ?? "unknown"] ?? 0;
    if (rank < minRank) {
      excluded.push({
        model: m,
        reason:
          `capability_profile 'reasoning' rating is '${m.reasoningRating ?? "unknown"}', below the ` +
          `required '${minReasoningRating}' bar for ${complexity} refinement`,
      });
      continue;
    }
    if (m.inputPricePerM === null) {
      excluded.push({
        model: m,
        reason: "no per_1m_tokens_input price found on the 'input' tier — cost can't be compared",
      });
      continue;
    }
    qualifying.push(m);
  }

  qualifying.sort((a, b) => (a.inputPricePerM ?? Infinity) - (b.inputPricePerM ?? Infinity));

  return {
    selected: qualifying[0] ?? null,
    complexity,
    minReasoningRating,
    qualifying,
    excluded,
  };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function hr(len = 96): string {
  return "─".repeat(len);
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
