/**
 * Modelglass MCP client, storyboard types, and shot-plan compilation logic
 * for shot-plan-compiler (SCO-190).
 *
 * Uses the live Modelglass HTTP MCP endpoint directly over JSON-RPC (no MCP
 * client library) — same integration style as av-prompt-refiner's and
 * image-batch-coster's lib.ts.
 *
 * Planner only: this file never calls a generation provider. It picks
 * models, checks whether the sequence of picks can actually be stitched
 * together, and totals a cost — all from registry data.
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
// Types — Modelglass feed (video modality)
// ---------------------------------------------------------------------------

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

/** Tier-level attributes. Video tiers carry the specific fields needed to
 *  turn per_clip/per_credit prices into an honest per-second-of-storyboard
 *  cost without guessing (clip_seconds, credits_per_second) — see
 *  computeTierCost. Open-ended since not every tier sets every field. */
export interface TierAttributes {
  resolution?: string;
  fps?: number;
  clip_seconds?: number;
  credits_per_second?: number;
  [key: string]: unknown;
}

export interface Tier {
  id: string;
  label?: string;
  attributes?: TierAttributes;
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

/** The subset of `knowledge` this tool reads — video ontology docs carry
 *  more fields (architecture, training, citations, ...) that a shot planner
 *  has no use for; see modelglass-video-gen's
 *  ontology/schema/model-knowledge.schema.json for the full schema. */
export interface VideoKnowledge {
  max_clip_duration?: number;
  supported_resolutions?: string[];
  fps_options?: number[];
  generation_modes?: string[];
  native_audio?: boolean;
}

export interface ModelEntry {
  model_id: string;
  name: string;
  join_status: string;
  knowledge?: VideoKnowledge | null;
  offerings: Offering[];
}

/** Fetch the full video-modality offering pool via the live Modelglass MCP
 *  endpoint (modelglass_list_models tool). */
export async function fetchVideoModels(apiKey: string): Promise<ModelEntry[]> {
  const data = (await callMcpTool(apiKey, "modelglass_list_models", {
    modality: "video",
  })) as ModelEntry[];
  return data;
}

// ---------------------------------------------------------------------------
// Storyboard input
// ---------------------------------------------------------------------------

export interface Shot {
  id: string;
  description: string;
  durationSeconds: number;
  /** One of the registry's resolution strings, e.g. "720p", "1080p", "4K". */
  resolution: string;
  fps: number;
  audio: boolean;
  /**
   * True when this shot is meant to continue directly from the previous
   * shot's last frame (a frame-conditioned continuation, not just a cut).
   * The one flag that toggles whether image-to-video support is a hard
   * requirement on the model serving this shot (SCO-190's "dissolved design
   * question" — frame-continuity intent is a per-handoff flag, not a fork in
   * the planner's design).
   */
  continuityFromPrevious?: boolean;
}

export interface Storyboard {
  title: string;
  shots: Shot[];
}

// ---------------------------------------------------------------------------
// Current price
// ---------------------------------------------------------------------------

export function currentPrice(tier: Tier): PriceEntry | null {
  const active = tier.pricing.find((p) => !p.effective_to);
  if (active) return active;
  if (!tier.pricing.length) return null;
  return [...tier.pricing].sort((a, b) => (a.effective_from > b.effective_from ? -1 : 1))[0]!;
}

// ---------------------------------------------------------------------------
// Cost normalization — honest-unit discipline (mirrors image-batch-coster's
// computeCosts: never force-convert a unit without a documented basis in the
// registry's own data). Video's units differ from image's (per_second /
// per_clip / per_credit, not per_image / per_megapixel), but every per_clip
// and per_credit tier in the live video registry documents the field needed
// to convert it honestly (tier.attributes.clip_seconds,
// tier.attributes.credits_per_second) — unlike image's per_credit case,
// where the credits-per-generation rate isn't tracked at all. Only a tier
// that's actually missing the needed attribute is treated as
// non-comparable.
// ---------------------------------------------------------------------------

export interface TierCost {
  cost_usd: number;
  clips_needed: number;
  basis: string;
}

export interface NonComparable {
  reason: string;
}

export function computeTierCost(
  tier: Tier,
  price: PriceEntry,
  durationSeconds: number,
): TierCost | NonComparable {
  const attrs = tier.attributes ?? {};
  if (price.unit === "per_second") {
    return {
      cost_usd: price.amount * durationSeconds,
      clips_needed: 1,
      basis: `${price.currency} ${price.amount}/s × ${durationSeconds}s`,
    };
  }
  if (price.unit === "per_clip") {
    if (!attrs.clip_seconds) {
      return {
        reason:
          `billed per_clip with no tier.attributes.clip_seconds recorded — clip duration is ` +
          `unknown, so cost per second of storyboard time can't be derived without guessing.`,
      };
    }
    const clipsNeeded = Math.ceil(durationSeconds / attrs.clip_seconds);
    return {
      cost_usd: price.amount * clipsNeeded,
      clips_needed: clipsNeeded,
      basis:
        `${price.currency} ${price.amount}/clip × ${clipsNeeded} clip(s) ` +
        `(tier.attributes.clip_seconds=${attrs.clip_seconds}, ${durationSeconds}s shot)`,
    };
  }
  if (price.unit === "per_credit") {
    if (!attrs.credits_per_second) {
      return {
        reason:
          `billed per_credit with no tier.attributes.credits_per_second recorded — credit ` +
          `consumption rate is unknown, so cost can't be derived without guessing.`,
      };
    }
    const perSecond = price.amount * attrs.credits_per_second;
    return {
      cost_usd: perSecond * durationSeconds,
      clips_needed: 1,
      basis:
        `${price.currency} ${price.amount}/credit × ${attrs.credits_per_second} credits/s × ` +
        `${durationSeconds}s (tier.attributes.credits_per_second)`,
    };
  }
  return {
    reason: `billed in '${price.unit}', not a per-second/per-clip/per-credit rate this tool converts.`,
  };
}

function isNonComparable(v: TierCost | NonComparable): v is NonComparable {
  return "reason" in v;
}

// ---------------------------------------------------------------------------
// Tier-level resolution/fps refinement
// ---------------------------------------------------------------------------

/** A tier with no attributes.resolution doesn't disambiguate by resolution
 *  at the tier level — assumed to cover whatever the model-level
 *  supported_resolutions promises. A tier that does set it must match
 *  exactly or contain the requested resolution (tiers are sometimes
 *  labelled with a range, e.g. "720p-1080p" or "480p-720p"). */
export function tierMatchesResolution(tier: Tier, resolution: string): boolean {
  const attrRes = tier.attributes?.resolution;
  if (!attrRes) return true;
  return attrRes === resolution || attrRes.includes(resolution);
}

/** Same idea for fps — most tiers don't set attributes.fps at all (fps is
 *  usually a model-level constant via knowledge.fps_options); a tier that
 *  does set it must match the shot's requested fps exactly. */
export function tierMatchesFps(tier: Tier, fps: number): boolean {
  const attrFps = tier.attributes?.fps;
  if (attrFps === undefined) return true;
  return attrFps === fps;
}

// ---------------------------------------------------------------------------
// Per-shot model selection
// ---------------------------------------------------------------------------

export interface CandidateTier {
  model_id: string;
  name: string;
  provider: string;
  slug: string;
  tier_id: string;
  unit: string;
  amount: number;
  currency: string;
  cost_usd: number;
  clips_needed: number;
  cost_basis: string;
  native_audio: boolean;
}

export interface ShotExclusion {
  model_id: string;
  name: string;
  reason: string;
}

export interface ShotSelection {
  shot_id: string;
  picked: CandidateTier | null;
  rationale: string;
  needsSplit: boolean;
  splitSegments: number | null;
  needsSeparateAudioPass: boolean;
  /** All qualifying candidates, cheapest first — the full ranked pool this
   *  shot's pick was drawn from. Used by computeAlternatePlans to select a
   *  different rank position per shot for budget-level alternates, and
   *  surfaced in the report so a reader can see what else qualified. */
  candidates: CandidateTier[];
  excluded: ShotExclusion[];
}

/** Selects the cheapest model/tier that can serve one shot, applying every
 *  hard requirement the shot's own spec implies:
 *  - resolution ∈ knowledge.supported_resolutions
 *  - fps ∈ knowledge.fps_options
 *  - a fresh (non-continuity) shot needs "text-to-video" ∈
 *    knowledge.generation_modes — it starts from a text description, not a
 *    conditioning image. A continuityFromPrevious shot needs "image-to-video"
 *    instead — it's conditioned on the previous shot's last frame, not text.
 *    Without this gate a driver-video/i2v-only model (e.g. Runway Act Two,
 *    which has no text-to-video mode at all per its own generation_modes)
 *    could get picked for an ordinary fresh shot it structurally cannot
 *    originate — caught by running this planner against the live feed, not
 *    assumed.
 *  - duration > knowledge.max_clip_duration ⇒ the shot must be split into
 *    multiple generations from the SAME model, which additionally requires
 *    "image-to-video" (to chain each split segment's last frame into the
 *    next) regardless of the primary-mode requirement above
 *  - offering.model.status !== "deprecated"
 *  Every exclusion cites the specific disqualifying field, same house style
 *  as cost-aware-vscode-router/image-batch-coster. */
export function selectForShot(models: ModelEntry[], shot: Shot, rank = 0): ShotSelection {
  const excluded: ShotExclusion[] = [];
  const candidates: CandidateTier[] = [];

  for (const m of models) {
    const k = m.knowledge;
    if (!k) {
      excluded.push({
        model_id: m.model_id,
        name: m.name,
        reason: `no capability profile in the registry (join_status: ${m.join_status}) — cannot verify requirements`,
      });
      continue;
    }

    const resolutions = k.supported_resolutions ?? [];
    if (!resolutions.includes(shot.resolution)) {
      excluded.push({
        model_id: m.model_id,
        name: m.name,
        reason: `knowledge.supported_resolutions [${resolutions.join(", ")}] does not include '${shot.resolution}'`,
      });
      continue;
    }

    const fpsOptions = k.fps_options ?? [];
    if (!fpsOptions.includes(shot.fps)) {
      excluded.push({
        model_id: m.model_id,
        name: m.name,
        reason: `knowledge.fps_options [${fpsOptions.join(", ")}] does not include ${shot.fps}`,
      });
      continue;
    }

    const modes = k.generation_modes ?? [];
    const hasImageToVideo = modes.includes("image-to-video");

    const primaryMode = shot.continuityFromPrevious ? "image-to-video" : "text-to-video";
    if (!modes.includes(primaryMode)) {
      excluded.push({
        model_id: m.model_id,
        name: m.name,
        reason:
          `knowledge.generation_modes [${modes.join(", ")}] does not include '${primaryMode}' — ` +
          `required for ${shot.continuityFromPrevious ? "a continuity shot (conditioned on the previous shot's last frame)" : "a fresh shot generated from a text prompt"}`,
      });
      continue;
    }

    const maxClip = k.max_clip_duration ?? 0;
    const needsSplit = shot.durationSeconds > maxClip;
    if (needsSplit && !hasImageToVideo) {
      excluded.push({
        model_id: m.model_id,
        name: m.name,
        reason:
          `shot duration ${shot.durationSeconds}s exceeds knowledge.max_clip_duration ${maxClip}s ` +
          `and knowledge.generation_modes [${modes.join(", ")}] lacks 'image-to-video' needed to ` +
          `self-chain the split segments`,
      });
      continue;
    }

    for (const off of m.offerings) {
      if (off.model.status === "deprecated") {
        excluded.push({
          model_id: m.model_id,
          name: m.name,
          reason: `${off.provider} offering: model.status is 'deprecated'`,
        });
        continue;
      }

      const matchingTiers = off.tiers.filter(
        (t) => tierMatchesResolution(t, shot.resolution) && tierMatchesFps(t, shot.fps),
      );
      if (matchingTiers.length === 0) {
        excluded.push({
          model_id: m.model_id,
          name: m.name,
          reason: `${off.provider} offering: no tier attributes compatible with '${shot.resolution}' / ${shot.fps}fps`,
        });
        continue;
      }

      for (const tier of matchingTiers) {
        const price = currentPrice(tier);
        if (!price) continue;
        const cost = computeTierCost(tier, price, shot.durationSeconds);
        if (isNonComparable(cost)) {
          excluded.push({
            model_id: m.model_id,
            name: m.name,
            reason: `${off.provider} offering, tier '${tier.id}': ${cost.reason}`,
          });
          continue;
        }
        candidates.push({
          model_id: m.model_id,
          name: m.name,
          provider: off.provider,
          slug: off.slug,
          tier_id: tier.id,
          unit: price.unit,
          amount: price.amount,
          currency: price.currency,
          cost_usd: cost.cost_usd,
          clips_needed: cost.clips_needed,
          cost_basis: cost.basis,
          native_audio: k.native_audio ?? false,
        });
      }
    }
  }

  candidates.sort((a, b) => a.cost_usd - b.cost_usd);
  const index = rank < 0 ? candidates.length + rank : rank;
  const picked = candidates[index] ?? null;

  const maxClipOfPicked = picked
    ? (models.find((m) => m.model_id === picked.model_id)?.knowledge?.max_clip_duration ?? 0)
    : 0;
  const needsSplit = picked !== null && shot.durationSeconds > maxClipOfPicked;
  const splitSegments = needsSplit ? Math.ceil(shot.durationSeconds / maxClipOfPicked) : null;
  const needsSeparateAudioPass = shot.audio && !(picked?.native_audio ?? false);

  let rationale: string;
  if (!picked) {
    rationale = `No qualifying model/tier found for ${shot.resolution} @ ${shot.fps}fps, ${shot.durationSeconds}s${shot.audio ? ", audio" : ""}${shot.continuityFromPrevious ? ", continuity" : ""} — see excluded candidates.`;
  } else {
    const parts = [
      `${picked.name} (${picked.provider}): ${picked.cost_basis}`,
      `clears knowledge.supported_resolutions (${shot.resolution}) and knowledge.fps_options (${shot.fps})`,
      `cheapest of ${candidates.length} qualifying candidate(s)`,
    ];
    if (needsSplit) {
      parts.push(
        `knowledge.max_clip_duration ${maxClipOfPicked}s < shot duration ${shot.durationSeconds}s — split into ${splitSegments} self-chained generations`,
      );
    }
    if (needsSeparateAudioPass) {
      parts.push(`shot needs audio but knowledge.native_audio is false — needs a separate audio pass`);
    }
    rationale = parts.join("; ");
  }

  return {
    shot_id: shot.id,
    picked,
    rationale,
    needsSplit,
    splitSegments,
    needsSeparateAudioPass,
    candidates,
    excluded,
  };
}

// ---------------------------------------------------------------------------
// Chain-feasibility — the handoff check between consecutive shots
// ---------------------------------------------------------------------------

export type FlagType = "fps-mismatch" | "resolution-step" | "audio-seam" | "infeasible-continuity";

export interface HandoffFlag {
  type: FlagType;
  detail: string;
  recommendation: string;
}

export interface Handoff {
  from_shot: string;
  to_shot: string;
  flags: HandoffFlag[];
}

export function checkHandoff(
  prev: { shot: Shot; picked: CandidateTier | null },
  next: { shot: Shot; picked: CandidateTier | null },
): Handoff {
  const flags: HandoffFlag[] = [];

  if (prev.shot.fps !== next.shot.fps) {
    flags.push({
      type: "fps-mismatch",
      detail: `${prev.shot.id} is ${prev.shot.fps}fps, ${next.shot.id} is ${next.shot.fps}fps.`,
      recommendation:
        `Insert a frame-rate conversion pass at the cut (or re-author one shot to match fps) — ` +
        `a raw fps step will visibly judder.`,
    });
  }

  if (prev.shot.resolution !== next.shot.resolution) {
    flags.push({
      type: "resolution-step",
      detail: `${prev.shot.id} is ${prev.shot.resolution}, ${next.shot.id} is ${next.shot.resolution}.`,
      recommendation:
        `Upscale/downscale one side to match at the seam, or accept the step as an intentional ` +
        `scene change with a hard cut — a crossfade across a resolution step reads as soft focus.`,
    });
  }

  const prevAudio = prev.picked?.native_audio ?? false;
  const nextAudio = next.picked?.native_audio ?? false;
  if (prevAudio !== nextAudio) {
    flags.push({
      type: "audio-seam",
      detail:
        `${prev.shot.id}'s pick (${prev.picked?.name ?? "none"}) ${prevAudio ? "produces" : "does not produce"} native audio; ` +
        `${next.shot.id}'s pick (${next.picked?.name ?? "none"}) ${nextAudio ? "produces" : "does not produce"} native audio.`,
      recommendation:
        `Add a fade on the audio track across this cut, or run a separate audio-generation pass ` +
        `(see av-prompt-refiner) to cover the silent side rather than an abrupt audio cut.`,
    });
  }

  if (next.shot.continuityFromPrevious && !next.picked) {
    flags.push({
      type: "infeasible-continuity",
      detail: `${next.shot.id} is flagged continuityFromPrevious but no model in the pool qualifies.`,
      recommendation:
        `Relax one of ${next.shot.id}'s requirements, or drop continuityFromPrevious and accept a ` +
        `hard cut instead of a frame-conditioned continuation.`,
    });
  }

  return { from_shot: prev.shot.id, to_shot: next.shot.id, flags };
}

// ---------------------------------------------------------------------------
// Shot-level flags (not a handoff — a property of one shot's own plan)
// ---------------------------------------------------------------------------

export type ShotFlagType = "split-required" | "no-feasible-model" | "needs-separate-audio-pass";

export interface ShotFlag {
  shot_id: string;
  type: ShotFlagType;
  detail: string;
  recommendation: string;
}

export function deriveShotFlags(selections: ShotSelection[]): ShotFlag[] {
  const flags: ShotFlag[] = [];
  for (const sel of selections) {
    if (!sel.picked) {
      flags.push({
        shot_id: sel.shot_id,
        type: "no-feasible-model",
        detail: `No candidate in the pool met this shot's requirements.`,
        recommendation: `Relax resolution/fps/duration/continuity requirements, or widen the model pool.`,
      });
      continue;
    }
    if (sel.needsSplit) {
      flags.push({
        shot_id: sel.shot_id,
        type: "split-required",
        detail: `Shot exceeds ${sel.picked.name}'s max_clip_duration — needs ${sel.splitSegments} self-chained generations.`,
        recommendation: `Generate ${sel.splitSegments} segments back to back, each conditioned on the previous segment's last frame (image-to-video), then trim the internal splice points.`,
      });
    }
    if (sel.needsSeparateAudioPass) {
      flags.push({
        shot_id: sel.shot_id,
        type: "needs-separate-audio-pass",
        detail: `Shot needs audio but ${sel.picked.name} has no native audio.`,
        recommendation: `Run a separate audio-generation pass (see av-prompt-refiner) and mux it onto this shot.`,
      });
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Full plan
// ---------------------------------------------------------------------------

export interface Plan {
  storyboard_title: string;
  selections: ShotSelection[];
  handoffs: Handoff[];
  shotFlags: ShotFlag[];
  total_cost_usd: number;
  shots_without_cost: string[];
}

export function computePlan(models: ModelEntry[], storyboard: Storyboard, rank = 0): Plan {
  const selections = storyboard.shots.map((shot) => selectForShot(models, shot, rank));
  const handoffs: Handoff[] = [];
  for (let i = 0; i < selections.length - 1; i++) {
    handoffs.push(
      checkHandoff(
        { shot: storyboard.shots[i]!, picked: selections[i]!.picked },
        { shot: storyboard.shots[i + 1]!, picked: selections[i + 1]!.picked },
      ),
    );
  }
  const shotFlags = deriveShotFlags(selections);
  const total_cost_usd = selections.reduce((s, sel) => s + (sel.picked?.cost_usd ?? 0), 0);
  const shots_without_cost = selections.filter((s) => !s.picked).map((s) => s.shot_id);

  return {
    storyboard_title: storyboard.title,
    selections,
    handoffs,
    shotFlags,
    total_cost_usd,
    shots_without_cost,
  };
}

// ---------------------------------------------------------------------------
// Alternate budget-level plans (stretch — SCO-190's "optionally 2-3
// alternate plans"). "Premium" uses the priciest qualifying candidate per
// shot as a price-as-quality proxy, since capability_profile doesn't give a
// single per-shot-type quality scalar to rank on — a simplification, stated
// plainly rather than silently assumed.
// ---------------------------------------------------------------------------

export type BudgetLevel = "budget" | "balanced" | "premium";

export function computeAlternatePlans(
  models: ModelEntry[],
  storyboard: Storyboard,
): Record<BudgetLevel, Plan> {
  const budget = computePlan(models, storyboard, 0);
  const premium = computePlan(models, storyboard, -1);

  // Balanced needs each shot's own candidate count to pick a true middle
  // rank, so it can't reuse a single global rank the way budget/premium can.
  const balancedSelections = storyboard.shots.map((shot) => {
    const probe = selectForShot(models, shot, 0);
    const middleRank = Math.floor(Math.max(0, probe.candidates.length - 1) / 2);
    return selectForShot(models, shot, middleRank);
  });
  const balancedHandoffs: Handoff[] = [];
  for (let i = 0; i < balancedSelections.length - 1; i++) {
    balancedHandoffs.push(
      checkHandoff(
        { shot: storyboard.shots[i]!, picked: balancedSelections[i]!.picked },
        { shot: storyboard.shots[i + 1]!, picked: balancedSelections[i + 1]!.picked },
      ),
    );
  }
  const balanced: Plan = {
    storyboard_title: storyboard.title,
    selections: balancedSelections,
    handoffs: balancedHandoffs,
    shotFlags: deriveShotFlags(balancedSelections),
    total_cost_usd: balancedSelections.reduce((s, sel) => s + (sel.picked?.cost_usd ?? 0), 0),
    shots_without_cost: balancedSelections.filter((s) => !s.picked).map((s) => s.shot_id),
  };

  return { budget, balanced, premium };
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
