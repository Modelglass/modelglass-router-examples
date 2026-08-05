/**
 * Tests for image-prompt-refiner's grounding-context formatting. Mirrors
 * av-prompt-refiner's lib.test.ts coverage (allowlist behavior, provenance
 * stripping) for the image ontology's field shape, which has no
 * modality-specific fields beyond the set shared with video/audio.
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
  test("includes the model name, id, and 'image model' label in the header", () => {
    const profile = makeProfile({ capability_profile: [{ dimension: "photorealism", rating: "strong" }] });
    const result = formatGroundingContext(profile);
    assert.match(result, /^### Test Model \(test-creator\/test-model\) — image model/);
  });

  test("drops provenance/licensing fields not useful for prompt-writing", () => {
    const profile = makeProfile({
      schema_version: 1,
      model_id: "test-creator/test-model",
      name: "Test Model",
      creator: "Test Creator",
      training: { paradigms: ["base-model"] },
      benchmarks: [{ benchmark: "geneval", score: 0.9 }],
      citations: [{ title: "x", url: "https://example.com" }],
      origin: { lab: "Test Lab" },
      license: { type: "Proprietary" },
      ethical_notes: ["none"],
      training_data_notes: "none",
      capability_confidence: "high",
      capability_profile: [{ dimension: "photorealism", rating: "strong" }],
    });
    const result = formatGroundingContext(profile);
    const jsonBlock = JSON.parse(result.split("\n\n")[1]!);
    assert.deepEqual(jsonBlock, {
      capability_profile: [{ dimension: "photorealism", rating: "strong" }],
    });
  });

  test("passes through the shared allowlisted fields", () => {
    const profile = makeProfile({
      architecture: { type: "flow-matching", notes: "rectified-flow transformer" },
      capability_profile: [{ dimension: "text-rendering", rating: "strong" }],
      use_cases: ["Hero/marketing assets"],
      routing_guidance: "Route here for top-tier prompt adherence.",
      limitations: ["Closed weights, API-only"],
      notes: "Single knowledge doc covers both priced offerings.",
    });
    const result = formatGroundingContext(profile);
    const jsonBlock = JSON.parse(result.split("\n\n")[1]!);
    assert.equal(jsonBlock.architecture.type, "flow-matching");
    assert.deepEqual(jsonBlock.use_cases, ["Hero/marketing assets"]);
    assert.equal(jsonBlock.routing_guidance, "Route here for top-tier prompt adherence.");
    assert.deepEqual(jsonBlock.limitations, ["Closed weights, API-only"]);
    assert.equal(jsonBlock.notes, "Single knowledge doc covers both priced offerings.");
  });

  test("drops a field neither ontology schema defines, even though it isn't a known provenance field", () => {
    const profile = makeProfile({
      capability_profile: [{ dimension: "photorealism", rating: "strong" }],
      some_future_registry_field: "not yet known to this tool",
    });
    const result = formatGroundingContext(profile);
    const jsonBlock = JSON.parse(result.split("\n\n")[1]!);
    assert.equal("some_future_registry_field" in jsonBlock, false);
    assert.ok("capability_profile" in jsonBlock);
  });

  test("an empty knowledge object (all fields filtered) still produces valid output", () => {
    const profile = makeProfile({ schema_version: 1, model_id: "x", name: "x" });
    const result = formatGroundingContext(profile);
    const jsonBlock = JSON.parse(result.split("\n\n")[1]!);
    assert.deepEqual(jsonBlock, {});
  });
});
