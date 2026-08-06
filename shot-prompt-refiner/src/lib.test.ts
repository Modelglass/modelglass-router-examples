/**
 * Tests for shot-prompt-refiner's storyboard/plan joining, grounding-context
 * formatting, and refiner-model routing (SCO-357).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  type ModelProfile,
  type Storyboard,
  type Plan,
  type RefinerCandidate,
  complexityFor,
  formatGroundingContext,
  joinStoryboardAndPlan,
  selectRefinerModel,
} from "./lib.js";

// ---------------------------------------------------------------------------
// joinStoryboardAndPlan
// ---------------------------------------------------------------------------

describe("joinStoryboardAndPlan", () => {
  const storyboard: Storyboard = {
    title: "Test storyboard",
    shots: [
      { id: "shot-1", description: "A wide shot", durationSeconds: 5, resolution: "1080p", fps: 24, audio: false },
      { id: "shot-2", description: "A close-up", durationSeconds: 6, resolution: "1080p", fps: 24, audio: false },
    ],
  };

  test("pairs each shot with its picked model in storyboard order", () => {
    const plan: Plan = {
      storyboard_title: "Test storyboard",
      selections: [
        { shot_id: "shot-1", picked: { model_id: "wan-video/wan-2-5", name: "Wan 2.5", provider: "fal" } },
        { shot_id: "shot-2", picked: { model_id: "runway/act-two", name: "Act Two", provider: "runway" } },
      ],
    };
    const { pairs, skipped } = joinStoryboardAndPlan(storyboard, plan);
    assert.equal(pairs.length, 2);
    assert.equal(skipped.length, 0);
    assert.equal(pairs[0]!.shot.id, "shot-1");
    assert.equal(pairs[0]!.picked.model_id, "wan-video/wan-2-5");
    assert.equal(pairs[1]!.shot.id, "shot-2");
    assert.equal(pairs[1]!.picked.model_id, "runway/act-two");
  });

  test("skips a shot missing from the plan's selections, with a reason", () => {
    const plan: Plan = {
      storyboard_title: "Test storyboard",
      selections: [
        { shot_id: "shot-1", picked: { model_id: "wan-video/wan-2-5", name: "Wan 2.5", provider: "fal" } },
        // shot-2 has no entry at all
      ],
    };
    const { pairs, skipped } = joinStoryboardAndPlan(storyboard, plan);
    assert.equal(pairs.length, 1);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]!.shot_id, "shot-2");
    assert.match(skipped[0]!.reason, /no matching selection/);
  });

  test("skips a shot the plan marked infeasible (picked: null), with a reason", () => {
    const plan: Plan = {
      storyboard_title: "Test storyboard",
      selections: [
        { shot_id: "shot-1", picked: { model_id: "wan-video/wan-2-5", name: "Wan 2.5", provider: "fal" } },
        { shot_id: "shot-2", picked: null },
      ],
    };
    const { pairs, skipped } = joinStoryboardAndPlan(storyboard, plan);
    assert.equal(pairs.length, 1);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]!.shot_id, "shot-2");
    assert.match(skipped[0]!.reason, /infeasible/);
  });
});

// ---------------------------------------------------------------------------
// complexityFor
// ---------------------------------------------------------------------------

describe("complexityFor", () => {
  test("a single shot is simple", () => {
    assert.equal(complexityFor(1), "simple");
  });
  test("two or more shots is complex", () => {
    assert.equal(complexityFor(2), "complex");
    assert.equal(complexityFor(3), "complex");
  });
});

// ---------------------------------------------------------------------------
// formatGroundingContext
// ---------------------------------------------------------------------------

describe("formatGroundingContext", () => {
  function makeProfile(knowledge: Record<string, unknown>): ModelProfile {
    return { model_id: "test-creator/test-model", name: "Test Model", knowledge };
  }

  test("includes the model name, id, and 'video model' label in the header", () => {
    const result = formatGroundingContext(makeProfile({ capability_profile: [{ dimension: "realism", rating: "strong" }] }));
    assert.match(result, /^### Test Model \(test-creator\/test-model\) — video model/);
  });

  test("passes through video-specific fields on the allowlist", () => {
    const result = formatGroundingContext(
      makeProfile({
        capability_profile: [{ dimension: "realism", rating: "strong" }],
        max_clip_duration: 10,
        supported_resolutions: ["1080p", "4K"],
      }),
    );
    const jsonBlock = JSON.parse(result.split("\n\n")[1]!);
    assert.equal(jsonBlock.max_clip_duration, 10);
    assert.deepEqual(jsonBlock.supported_resolutions, ["1080p", "4K"]);
  });

  test("drops provenance/licensing fields not useful for prompt-writing", () => {
    const result = formatGroundingContext(
      makeProfile({
        schema_version: "1.0",
        model_id: "test-creator/test-model",
        creator: "Test Creator",
        citations: ["https://example.com"],
        capability_profile: [{ dimension: "realism", rating: "strong" }],
      }),
    );
    const jsonBlock = JSON.parse(result.split("\n\n")[1]!);
    assert.deepEqual(jsonBlock, { capability_profile: [{ dimension: "realism", rating: "strong" }] });
  });

  test("drops a field neither ontology schema defines, even though it isn't a known provenance field", () => {
    const result = formatGroundingContext(
      makeProfile({
        capability_profile: [{ dimension: "realism", rating: "strong" }],
        some_future_registry_field: "not yet known to this tool",
      }),
    );
    const jsonBlock = JSON.parse(result.split("\n\n")[1]!);
    assert.equal("some_future_registry_field" in jsonBlock, false);
  });
});

// ---------------------------------------------------------------------------
// selectRefinerModel
// ---------------------------------------------------------------------------

describe("selectRefinerModel", () => {
  const haiku: RefinerCandidate = {
    model_id: "anthropic/claude-haiku-4",
    name: "Claude Haiku 4",
    slug: "claude-haiku-4-anthropic",
    provider: "anthropic",
    reasoningRating: "moderate",
    inputPricePerM: 1,
  };
  const sonnet: RefinerCandidate = {
    model_id: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    slug: "claude-sonnet-4-6-anthropic",
    provider: "anthropic",
    reasoningRating: "strong",
    inputPricePerM: 3,
  };
  const opus: RefinerCandidate = {
    model_id: "anthropic/claude-opus-4-8",
    name: "Claude Opus 4.8",
    slug: "claude-opus-4-8-anthropic",
    provider: "anthropic",
    reasoningRating: "strong",
    inputPricePerM: 5,
  };
  const gptMini: RefinerCandidate = {
    model_id: "openai/gpt-5-4-mini",
    name: "GPT-5.4 Mini",
    slug: "gpt-5-4-mini-openai",
    provider: "openai",
    reasoningRating: "strong",
    inputPricePerM: 0.5,
  };
  const pool = [haiku, sonnet, opus, gptMini];

  test("simple complexity: cheapest Anthropic model clearing the 'moderate' reasoning bar wins", () => {
    const result = selectRefinerModel(pool, "simple");
    assert.equal(result.minReasoningRating, "moderate");
    assert.equal(result.selected?.model_id, "anthropic/claude-haiku-4");
  });

  test("complex complexity: cheapest Anthropic model clearing the 'strong' reasoning bar wins (haiku excluded)", () => {
    const result = selectRefinerModel(pool, "complex");
    assert.equal(result.minReasoningRating, "strong");
    assert.equal(result.selected?.model_id, "anthropic/claude-sonnet-4-6");
    const haikuExclusion = result.excluded.find((e) => e.model.model_id === "anthropic/claude-haiku-4");
    assert.ok(haikuExclusion);
    assert.match(haikuExclusion!.reason, /below the required 'strong' bar for complex refinement/);
  });

  test("excludes a cheaper non-Anthropic model even though it clears the reasoning bar", () => {
    const result = selectRefinerModel(pool, "complex");
    assert.equal(result.selected?.provider, "anthropic");
    const gptExclusion = result.excluded.find((e) => e.model.model_id === "openai/gpt-5-4-mini");
    assert.ok(gptExclusion);
    assert.match(gptExclusion!.reason, /Anthropic SDK/);
  });

  test("a model with no reasoning rating at all is excluded, not silently allowed", () => {
    const unknown: RefinerCandidate = {
      model_id: "anthropic/claude-unknown",
      name: "Claude Unknown",
      slug: "claude-unknown-anthropic",
      provider: "anthropic",
      reasoningRating: null,
      inputPricePerM: 0.1,
    };
    const result = selectRefinerModel([unknown], "simple");
    assert.equal(result.selected, null);
    assert.match(result.excluded[0]!.reason, /'unknown'/);
  });

  test("returns null selected with cited exclusions when nothing qualifies", () => {
    const result = selectRefinerModel([gptMini], "simple");
    assert.equal(result.selected, null);
    assert.equal(result.excluded.length, 1);
  });
});
