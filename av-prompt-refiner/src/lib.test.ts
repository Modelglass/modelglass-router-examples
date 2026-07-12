/**
 * Tests for av-prompt-refiner's grounding-context formatting (SCO-165
 * finding #7 — this example previously had no test suite at all).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { type ModelProfile, formatGroundingContext } from "./lib.js";

function makeProfile(knowledge: Record<string, unknown>): ModelProfile {
  return {
    model_id: "test-creator/test-model",
    name: "Test Model",
    knowledge,
  };
}

describe("formatGroundingContext", () => {
  test("includes the model name, id, and media label in the header", () => {
    const profile = makeProfile({ capability_profile: { realism: "strong" } });
    const result = formatGroundingContext(profile, "video");
    assert.match(result, /^### Test Model \(test-creator\/test-model\) — video model/);
  });

  test("drops provenance/licensing fields not useful for prompt-writing", () => {
    const profile = makeProfile({
      schema_version: "1.0",
      model_id: "test-creator/test-model",
      name: "Test Model",
      creator: "Test Creator",
      training: { notes: "internal" },
      benchmarks: [{ benchmark: "vbench", score: 0.9 }],
      citations: ["https://example.com"],
      origin: "test",
      license: "proprietary",
      ethical_notes: "none",
      training_data_notes: "none",
      capability_confidence: "high",
      capability_profile: { realism: "strong" },
    });
    const result = formatGroundingContext(profile, "video");
    const jsonBlock = JSON.parse(result.split("\n\n")[1]!);
    assert.deepEqual(jsonBlock, { capability_profile: { realism: "strong" } });
  });

  test("passes through modality-specific fields it doesn't know about", () => {
    const profile = makeProfile({
      capability_profile: { realism: "strong" },
      max_clip_duration: "10s",
      supported_resolutions: ["1080p", "4k"],
    });
    const result = formatGroundingContext(profile, "video");
    const jsonBlock = JSON.parse(result.split("\n\n")[1]!);
    assert.equal(jsonBlock.max_clip_duration, "10s");
    assert.deepEqual(jsonBlock.supported_resolutions, ["1080p", "4k"]);
  });

  test("audio-specific fields pass through the same way", () => {
    const profile = makeProfile({
      capability_profile: { clarity: "strong" },
      sub_modality: "tts",
      features_and_differences: "multi-speaker support",
    });
    const result = formatGroundingContext(profile, "audio");
    assert.match(result, /— audio model/);
    const jsonBlock = JSON.parse(result.split("\n\n")[1]!);
    assert.equal(jsonBlock.sub_modality, "tts");
  });

  test("an empty knowledge object (all fields filtered) still produces valid output", () => {
    const profile = makeProfile({ schema_version: "1.0", model_id: "x", name: "x" });
    const result = formatGroundingContext(profile, "video");
    const jsonBlock = JSON.parse(result.split("\n\n")[1]!);
    assert.deepEqual(jsonBlock, {});
  });
});
