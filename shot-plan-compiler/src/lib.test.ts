/**
 * Tests for shot-plan-compiler's per-shot selection, chain-feasibility
 * checks, and cost normalization (SCO-190).
 *
 * Fixtures mirror real shapes observed against the live feed
 * (modelglass_list_models, modality=video) during development on
 * 2026-07-12 — including the exact Runway Act Two / Wan 2.5 combination
 * that caught a real bug (Act Two has no text-to-video mode and was
 * initially picked for a fresh, non-continuity shot before the primary-mode
 * gate was added).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  type ModelEntry,
  type Shot,
  type Storyboard,
  computeTierCost,
  tierMatchesResolution,
  tierMatchesFps,
  selectForShot,
  checkHandoff,
  deriveShotFlags,
  computePlan,
  computeAlternatePlans,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACT_TWO: ModelEntry = {
  model_id: "runway/act-two",
  name: "Act Two",
  join_status: "joined",
  knowledge: {
    max_clip_duration: 10,
    supported_resolutions: ["1080p"],
    fps_options: [24],
    generation_modes: ["image-to-video", "video-to-video"],
    native_audio: true,
  },
  offerings: [
    {
      slug: "act-two-runway",
      provider: "runway",
      model: { id: "runway/act-two", modality: "image-to-video", status: "ga", generation: "current" },
      tiers: [
        {
          id: "standard",
          attributes: { resolution: "1080p", fps: 24 },
          pricing: [{ amount: 0.05, currency: "USD", unit: "per_second", effective_from: "2025-07-21" }],
        },
      ],
    },
  ],
};

const WAN_2_5: ModelEntry = {
  model_id: "wan-video/wan-2-5",
  name: "Wan 2.5",
  join_status: "joined",
  knowledge: {
    max_clip_duration: 10,
    supported_resolutions: ["480p", "720p", "1080p"],
    fps_options: [16, 24],
    generation_modes: ["text-to-video", "image-to-video"],
    native_audio: false,
  },
  offerings: [
    {
      slug: "wan-2-5-fal",
      provider: "fal",
      model: { id: "wan-video/wan-2-5", modality: "text-to-video", status: "ga", generation: "current" },
      tiers: [
        {
          id: "standard",
          pricing: [{ amount: 0.05, currency: "USD", unit: "per_second", effective_from: "2026-01-01" }],
        },
      ],
    },
  ],
};

// per_clip with a documented clip_seconds attribute — should be comparable.
const LTX_VIDEO: ModelEntry = {
  model_id: "lightricks/ltx-video-0-9-7",
  name: "LTX Video 0.9.7",
  join_status: "joined",
  knowledge: {
    max_clip_duration: 10,
    supported_resolutions: ["480p", "720p"],
    fps_options: [24],
    generation_modes: ["text-to-video", "image-to-video"],
    native_audio: false,
  },
  offerings: [
    {
      slug: "ltx-video-0-9-7-fal",
      provider: "fal",
      model: { id: "lightricks/ltx-video-0-9-7", modality: "text-to-video", status: "ga", generation: "current" },
      tiers: [
        {
          id: "standard",
          attributes: { clip_seconds: 5 },
          pricing: [{ amount: 0.048, currency: "USD", unit: "per_clip", effective_from: "2026-01-01" }],
        },
      ],
    },
  ],
};

// per_credit with documented credits_per_second — should be comparable.
const GEN_4_TURBO: ModelEntry = {
  model_id: "runway/gen-4-turbo",
  name: "Gen-4 Turbo",
  join_status: "joined",
  knowledge: {
    max_clip_duration: 10,
    supported_resolutions: ["720p", "1080p"],
    fps_options: [24],
    generation_modes: ["image-to-video"],
    native_audio: false,
  },
  offerings: [
    {
      slug: "gen-4-turbo-runway",
      provider: "runway",
      model: { id: "runway/gen-4-turbo", modality: "image-to-video", status: "ga", generation: "current" },
      tiers: [
        {
          id: "standard",
          attributes: { credits_per_second: 5 },
          pricing: [{ amount: 0.01, currency: "USD", unit: "per_credit", effective_from: "2025-07-21" }],
        },
      ],
    },
  ],
};

const DEPRECATED_MODEL: ModelEntry = {
  model_id: "google-deepmind/veo-3",
  name: "Veo 3",
  join_status: "joined",
  knowledge: {
    max_clip_duration: 8,
    supported_resolutions: ["720p", "1080p", "4K"],
    fps_options: [24],
    generation_modes: ["text-to-video", "image-to-video"],
    native_audio: true,
  },
  offerings: [
    {
      slug: "veo-3-google-deepmind",
      provider: "google-deepmind",
      model: { id: "google-deepmind/veo-3", modality: "text-to-video", status: "deprecated" },
      tiers: [
        {
          id: "standard",
          pricing: [{ amount: 0.01, currency: "USD", unit: "per_second", effective_from: "2025-01-01" }],
        },
      ],
    },
  ],
};

const POOL = [ACT_TWO, WAN_2_5, LTX_VIDEO, GEN_4_TURBO, DEPRECATED_MODEL];

function makeShot(overrides: Partial<Shot> & { id: string }): Shot {
  return {
    description: "test shot",
    durationSeconds: 5,
    resolution: "1080p",
    fps: 24,
    audio: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeTierCost
// ---------------------------------------------------------------------------

describe("computeTierCost", () => {
  test("per_second: amount × duration, no attributes needed", () => {
    const tier = ACT_TWO.offerings[0]!.tiers[0]!;
    const price = tier.pricing[0]!;
    const cost = computeTierCost(tier, price, 12);
    assert.ok(!("reason" in cost));
    assert.equal(Math.round((cost as { cost_usd: number }).cost_usd * 100) / 100, 0.6);
  });

  test("per_clip with clip_seconds: amount × ceil(duration / clip_seconds)", () => {
    const tier = LTX_VIDEO.offerings[0]!.tiers[0]!;
    const price = tier.pricing[0]!;
    const cost = computeTierCost(tier, price, 12); // ceil(12/5) = 3 clips
    assert.ok(!("reason" in cost));
    const c = cost as { cost_usd: number; clips_needed: number };
    assert.equal(c.clips_needed, 3);
    assert.equal(Math.round(c.cost_usd * 1000) / 1000, Math.round(0.048 * 3 * 1000) / 1000);
  });

  test("per_clip with NO clip_seconds attribute: non-comparable, not guessed", () => {
    const tier = { id: "x", pricing: [{ amount: 0.5, currency: "USD", unit: "per_clip", effective_from: "2026-01-01" }] };
    const cost = computeTierCost(tier, tier.pricing[0]!, 10);
    assert.ok("reason" in cost);
    assert.match((cost as { reason: string }).reason, /clip_seconds/);
  });

  test("per_credit with credits_per_second: derives an effective per-second rate from documented fields", () => {
    const tier = GEN_4_TURBO.offerings[0]!.tiers[0]!;
    const price = tier.pricing[0]!;
    const cost = computeTierCost(tier, price, 10);
    assert.ok(!("reason" in cost));
    // $0.01/credit × 5 credits/s × 10s = $0.50
    assert.equal((cost as { cost_usd: number }).cost_usd, 0.5);
  });

  test("per_credit with NO credits_per_second attribute: non-comparable, not guessed", () => {
    const tier = { id: "x", pricing: [{ amount: 0.01, currency: "USD", unit: "per_credit", effective_from: "2026-01-01" }] };
    const cost = computeTierCost(tier, tier.pricing[0]!, 10);
    assert.ok("reason" in cost);
    assert.match((cost as { reason: string }).reason, /credits_per_second/);
  });

  test("an unknown unit is always non-comparable", () => {
    const tier = { id: "x", pricing: [{ amount: 5, currency: "USD", unit: "per_month", effective_from: "2026-01-01" }] };
    const cost = computeTierCost(tier, tier.pricing[0]!, 10);
    assert.ok("reason" in cost);
  });
});

// ---------------------------------------------------------------------------
// tierMatchesResolution / tierMatchesFps
// ---------------------------------------------------------------------------

describe("tierMatchesResolution", () => {
  test("exact match", () => {
    assert.equal(tierMatchesResolution({ id: "x", attributes: { resolution: "1080p" }, pricing: [] }, "1080p"), true);
  });
  test("range string containing the requested resolution matches", () => {
    assert.equal(tierMatchesResolution({ id: "x", attributes: { resolution: "720p-1080p" }, pricing: [] }, "1080p"), true);
  });
  test("range string NOT containing the requested resolution does not match", () => {
    assert.equal(tierMatchesResolution({ id: "x", attributes: { resolution: "480p-720p" }, pricing: [] }, "1080p"), false);
  });
  test("no attributes.resolution at all — assumed to cover it (tier doesn't disambiguate)", () => {
    assert.equal(tierMatchesResolution({ id: "x", pricing: [] }, "1080p"), true);
  });
});

describe("tierMatchesFps", () => {
  test("exact match required when the tier sets attributes.fps", () => {
    assert.equal(tierMatchesFps({ id: "x", attributes: { fps: 24 }, pricing: [] }, 24), true);
    assert.equal(tierMatchesFps({ id: "x", attributes: { fps: 24 }, pricing: [] }, 30), false);
  });
  test("no attributes.fps — assumed to cover whatever knowledge.fps_options promises", () => {
    assert.equal(tierMatchesFps({ id: "x", pricing: [] }, 30), true);
  });
});

// ---------------------------------------------------------------------------
// selectForShot — the primary-mode gate is the bug this suite exists to
// pin down: Act Two (image-to-video/video-to-video only) must never be
// picked for a fresh, non-continuity shot.
// ---------------------------------------------------------------------------

describe("selectForShot", () => {
  test("a fresh (non-continuity) shot excludes an i2v-only model for lacking text-to-video", () => {
    const shot = makeShot({ id: "shot-1" });
    const sel = selectForShot(POOL, shot);
    assert.notEqual(sel.picked?.model_id, "runway/act-two");
    const actTwoExclusion = sel.excluded.find((e) => e.model_id === "runway/act-two");
    assert.ok(actTwoExclusion);
    assert.match(actTwoExclusion!.reason, /text-to-video/);
  });

  test("a continuity shot requires image-to-video and can select Act Two", () => {
    const shot = makeShot({ id: "shot-2", continuityFromPrevious: true });
    const sel = selectForShot(POOL, shot);
    assert.equal(sel.picked?.model_id, "runway/act-two");
  });

  test("cheapest qualifying candidate wins, by computed cost not raw amount", () => {
    // LTX Video's raw per-clip amount (0.048) is cheaper than Wan 2.5's
    // per-second amount (0.05), but for a 5s shot LTX needs exactly 1 clip
    // (clip_seconds=5) costing 0.048 total vs Wan 2.5's 0.05×5=0.25 — LTX
    // should win on total cost, not get skipped for its lower per-tier resolution ceiling.
    const shot = makeShot({ id: "shot-1", resolution: "720p", durationSeconds: 5 });
    const sel = selectForShot(POOL, shot);
    assert.equal(sel.picked?.model_id, "lightricks/ltx-video-0-9-7");
    assert.equal(sel.picked?.cost_usd, 0.048);
  });

  test("excludes a model whose supported_resolutions doesn't include the shot's resolution", () => {
    const shot = makeShot({ id: "shot-1", resolution: "4K" });
    const sel = selectForShot(POOL, shot);
    const reasons = sel.excluded.map((e) => e.reason);
    assert.ok(reasons.some((r) => r.includes("supported_resolutions")));
  });

  test("excludes a deprecated offering, citing model.status", () => {
    const shot = makeShot({ id: "shot-1", resolution: "4K", fps: 24 });
    const sel = selectForShot([DEPRECATED_MODEL], shot);
    assert.equal(sel.picked, null);
    assert.match(sel.excluded[0]!.reason, /deprecated/);
  });

  test("flags a split when shot duration exceeds the picked model's max_clip_duration", () => {
    const shot = makeShot({ id: "shot-2", continuityFromPrevious: true, durationSeconds: 12 });
    const sel = selectForShot(POOL, shot);
    assert.equal(sel.picked?.model_id, "runway/act-two"); // max_clip_duration 10 < 12
    assert.equal(sel.needsSplit, true);
    assert.equal(sel.splitSegments, 2);
  });

  test("excludes a model when duration exceeds max_clip_duration AND it has no image-to-video for self-chaining", () => {
    // Gen-4 Turbo already lacks text-to-video, but even models WITH
    // text-to-video and no i2v would fail a long fresh shot the same way —
    // constructed here as a minimal fixture for that exact condition.
    const noI2v: ModelEntry = {
      model_id: "test/t2v-only",
      name: "T2V Only",
      join_status: "joined",
      knowledge: {
        max_clip_duration: 5,
        supported_resolutions: ["1080p"],
        fps_options: [24],
        generation_modes: ["text-to-video"],
        native_audio: false,
      },
      offerings: [
        {
          slug: "t2v-only-x",
          provider: "x",
          model: { id: "test/t2v-only", modality: "text-to-video", status: "ga" },
          tiers: [{ id: "standard", pricing: [{ amount: 0.05, currency: "USD", unit: "per_second", effective_from: "2026-01-01" }] }],
        },
      ],
    };
    const shot = makeShot({ id: "shot-1", durationSeconds: 12 });
    const sel = selectForShot([noI2v], shot);
    assert.equal(sel.picked, null);
    assert.match(sel.excluded[0]!.reason, /image-to-video.*self-chain/);
  });

  test("flags needsSeparateAudioPass when the shot wants audio but the pick has no native_audio", () => {
    const shot = makeShot({ id: "shot-1", audio: true });
    const sel = selectForShot(POOL, shot);
    assert.equal(sel.needsSeparateAudioPass, true);
  });

  test("no needsSeparateAudioPass when the pick already has native_audio", () => {
    const shot = makeShot({ id: "shot-2", continuityFromPrevious: true, audio: true });
    const sel = selectForShot(POOL, shot);
    assert.equal(sel.picked?.model_id, "runway/act-two");
    assert.equal(sel.needsSeparateAudioPass, false);
  });

  test("no qualifying candidate at all → picked is null with an explanatory rationale", () => {
    const shot = makeShot({ id: "shot-x", resolution: "8K" });
    const sel = selectForShot(POOL, shot);
    assert.equal(sel.picked, null);
    assert.match(sel.rationale, /No qualifying model/);
  });
});

// ---------------------------------------------------------------------------
// checkHandoff — the genuinely novel chain-feasibility logic
// ---------------------------------------------------------------------------

describe("checkHandoff", () => {
  test("no flags when fps, resolution, and audio continuity all match", () => {
    const shotA = makeShot({ id: "a", fps: 24, resolution: "1080p" });
    const shotB = makeShot({ id: "b", fps: 24, resolution: "1080p" });
    const pickedA = selectForShot(POOL, shotA).picked;
    const pickedB = selectForShot(POOL, shotB).picked;
    const handoff = checkHandoff({ shot: shotA, picked: pickedA }, { shot: shotB, picked: pickedB });
    assert.equal(handoff.flags.length, 0);
  });

  test("flags an fps mismatch between consecutive shots", () => {
    const shotA = makeShot({ id: "a", fps: 24 });
    const shotB = makeShot({ id: "b", fps: 30 });
    const handoff = checkHandoff({ shot: shotA, picked: null }, { shot: shotB, picked: null });
    assert.ok(handoff.flags.some((f) => f.type === "fps-mismatch"));
  });

  test("flags a resolution step between consecutive shots", () => {
    const shotA = makeShot({ id: "a", resolution: "720p" });
    const shotB = makeShot({ id: "b", resolution: "1080p" });
    const handoff = checkHandoff({ shot: shotA, picked: null }, { shot: shotB, picked: null });
    assert.ok(handoff.flags.some((f) => f.type === "resolution-step"));
  });

  test("flags a silent-to-audio-native seam", () => {
    const shotA = makeShot({ id: "a" });
    const shotB = makeShot({ id: "b", continuityFromPrevious: true });
    const pickedA = selectForShot(POOL, shotA).picked; // Wan 2.5 (no native audio)
    const pickedB = selectForShot(POOL, shotB).picked; // Act Two (native audio)
    const handoff = checkHandoff({ shot: shotA, picked: pickedA }, { shot: shotB, picked: pickedB });
    assert.ok(handoff.flags.some((f) => f.type === "audio-seam"));
  });

  test("flags infeasible-continuity when a continuity shot has no picked model", () => {
    const shotA = makeShot({ id: "a" });
    const shotB = makeShot({ id: "b", continuityFromPrevious: true, resolution: "8K" });
    const handoff = checkHandoff({ shot: shotA, picked: null }, { shot: shotB, picked: null });
    assert.ok(handoff.flags.some((f) => f.type === "infeasible-continuity"));
  });
});

// ---------------------------------------------------------------------------
// deriveShotFlags
// ---------------------------------------------------------------------------

describe("deriveShotFlags", () => {
  test("produces no-feasible-model when a selection has no pick", () => {
    const shot = makeShot({ id: "a", resolution: "8K" });
    const sel = selectForShot(POOL, shot);
    const flags = deriveShotFlags([sel]);
    assert.ok(flags.some((f) => f.type === "no-feasible-model"));
  });

  test("produces split-required and needs-separate-audio-pass together when both apply", () => {
    // A dedicated fixture (rather than POOL) to unambiguously exercise both
    // flags on the same pick: i2v-capable (for continuity + self-chaining),
    // no native_audio, and a max_clip_duration shorter than the shot.
    const shortSilentI2v: ModelEntry = {
      model_id: "test/short-silent-i2v",
      name: "Short Silent I2V",
      join_status: "joined",
      knowledge: {
        max_clip_duration: 5,
        supported_resolutions: ["1080p"],
        fps_options: [24],
        generation_modes: ["image-to-video"],
        native_audio: false,
      },
      offerings: [
        {
          slug: "short-silent-i2v-x",
          provider: "x",
          model: { id: "test/short-silent-i2v", modality: "image-to-video", status: "ga" },
          tiers: [{ id: "standard", pricing: [{ amount: 0.05, currency: "USD", unit: "per_second", effective_from: "2026-01-01" }] }],
        },
      ],
    };
    const shot = makeShot({ id: "b", continuityFromPrevious: true, durationSeconds: 12, audio: true });
    const sel = selectForShot([shortSilentI2v], shot);
    assert.equal(sel.picked?.model_id, "test/short-silent-i2v");
    const flags = deriveShotFlags([sel]);
    assert.ok(flags.some((f) => f.type === "split-required"));
    assert.ok(flags.some((f) => f.type === "needs-separate-audio-pass"));
  });
});

// ---------------------------------------------------------------------------
// computePlan / computeAlternatePlans
// ---------------------------------------------------------------------------

describe("computePlan", () => {
  test("totals cost across shots and lists infeasible shots separately", () => {
    const storyboard: Storyboard = {
      title: "test",
      shots: [makeShot({ id: "a" }), makeShot({ id: "b", resolution: "8K" })],
    };
    const plan = computePlan(POOL, storyboard);
    assert.equal(plan.shots_without_cost.length, 1);
    assert.equal(plan.shots_without_cost[0], "b");
    // total only reflects the feasible shot
    assert.equal(plan.total_cost_usd, plan.selections[0]!.picked!.cost_usd);
  });
});

describe("computeAlternatePlans", () => {
  test("budget ≤ balanced ≤ premium in total cost", () => {
    const storyboard: Storyboard = {
      title: "test",
      shots: [makeShot({ id: "a" }), makeShot({ id: "b", continuityFromPrevious: true })],
    };
    const { budget, balanced, premium } = computeAlternatePlans(POOL, storyboard);
    assert.ok(budget.total_cost_usd <= balanced.total_cost_usd);
    assert.ok(balanced.total_cost_usd <= premium.total_cost_usd);
  });
});
