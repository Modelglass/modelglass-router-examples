/**
 * Tests for image-batch-coster's job-spec validation, capability filtering,
 * and cost computation.
 *
 * Follows the same convention stack-watch established as the first test
 * suite in this repo: Node's built-in test runner (`node --test`), zero
 * added dependencies.
 *
 * Run: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseMegapixels,
  availableDimensions,
  validateRequirementKeys,
  filterByCapability,
  computeCosts,
  crossHostSpreads,
  type ModelEntry,
  type JobSpec,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Fixtures — shapes mirror real responses observed against the live feed
// (modelglass_list_models, modality=image) during development.
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    model_id: "bfl/flux-1-1-pro",
    name: "FLUX 1.1 [pro]",
    join_status: "joined",
    knowledge: {
      capability_profile: [
        { dimension: "photorealism", rating: "strong" },
        { dimension: "text-rendering", rating: "strong" },
      ],
    },
    offerings: [
      {
        slug: "flux-1-1-pro-replicate",
        provider: "replicate",
        model: { id: "bfl/flux-1-1-pro", modality: "text-to-image", status: "ga", generation: "current" },
        tiers: [
          {
            id: "default",
            pricing: [
              { amount: 0.04, currency: "USD", unit: "per_image", effective_from: "2026-06-09" },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseMegapixels
// ---------------------------------------------------------------------------

describe("parseMegapixels", () => {
  test("parses WIDTHxHEIGHT into megapixels", () => {
    assert.equal(parseMegapixels("1000x1000"), 1);
    assert.equal(parseMegapixels("1536x1536"), 2.359296);
  });

  test("accepts the × character as a separator", () => {
    assert.equal(parseMegapixels("1000×1000"), 1);
  });

  test("throws on a malformed resolution", () => {
    assert.throws(() => parseMegapixels("bogus"), /Invalid resolution/);
    assert.throws(() => parseMegapixels("1024"), /Invalid resolution/);
  });
});

// ---------------------------------------------------------------------------
// availableDimensions / validateRequirementKeys
// ---------------------------------------------------------------------------

describe("availableDimensions", () => {
  test("collects the union of dimensions actually present, deduped and sorted", () => {
    const models = [
      makeModel(),
      makeModel({
        model_id: "openai/dall-e-3",
        knowledge: { capability_profile: [{ dimension: "artistic-range", rating: "moderate" }] },
      }),
    ];
    assert.deepEqual(availableDimensions(models), ["artistic-range", "photorealism", "text-rendering"]);
  });

  test("ignores models with no capability_profile", () => {
    const models = [makeModel({ knowledge: null })];
    assert.deepEqual(availableDimensions(models), []);
  });
});

describe("validateRequirementKeys", () => {
  const models = [makeModel()];

  test("passes for a known dimension and a known rating", () => {
    assert.doesNotThrow(() => validateRequirementKeys({ photorealism: "strong" }, models));
  });

  test("throws for an unknown dimension, listing the real ones", () => {
    assert.throws(
      () => validateRequirementKeys({ "not-a-real-dimension": "strong" }, models),
      /Unknown capability dimension.*photorealism, text-rendering/,
    );
  });

  test("throws for an unknown minimum rating", () => {
    assert.throws(
      () => validateRequirementKeys({ photorealism: "amazing" }, models),
      /Unknown minimum rating/,
    );
  });
});

// ---------------------------------------------------------------------------
// filterByCapability
// ---------------------------------------------------------------------------

describe("filterByCapability", () => {
  test("returns every model unchanged when there are no requirements", () => {
    const models = [makeModel()];
    const result = filterByCapability(models, undefined);
    assert.equal(result.qualifying.length, 1);
    assert.equal(result.excluded.length, 0);
  });

  test("qualifies a model that meets the minimum rating", () => {
    const result = filterByCapability([makeModel()], { photorealism: "strong" });
    assert.equal(result.qualifying.length, 1);
    assert.equal(result.excluded.length, 0);
  });

  test("excludes a model below the minimum rating, citing the field", () => {
    const model = makeModel({
      knowledge: { capability_profile: [{ dimension: "photorealism", rating: "moderate" }] },
    });
    const result = filterByCapability([model], { photorealism: "strong" });
    assert.equal(result.qualifying.length, 0);
    assert.equal(result.excluded.length, 1);
    assert.match(result.excluded[0]!.reason, /capability_profile\.photorealism.*'moderate'.*'strong'/);
  });

  test("excludes a model with no capability_profile at all, citing join_status", () => {
    const model = makeModel({ knowledge: null, join_status: "pricing_only" });
    const result = filterByCapability([model], { photorealism: "strong" });
    assert.equal(result.excluded.length, 1);
    assert.match(result.excluded[0]!.reason, /no capability_profile.*pricing_only/);
  });

  test("excludes a model missing a rating for the requested dimension", () => {
    const model = makeModel({
      knowledge: { capability_profile: [{ dimension: "text-rendering", rating: "strong" }] },
    });
    const result = filterByCapability([model], { photorealism: "strong" });
    assert.equal(result.excluded.length, 1);
    assert.match(result.excluded[0]!.reason, /no rating recorded for capability_profile\.photorealism/);
  });
});

// ---------------------------------------------------------------------------
// computeCosts
// ---------------------------------------------------------------------------

describe("computeCosts", () => {
  const job: JobSpec = { count: 100, resolution: "1000x1000" }; // exactly 1 MP

  test("computes per_image cost as amount × count", () => {
    const result = computeCosts([makeModel()], job);
    assert.equal(result.ranked.length, 1);
    assert.equal(result.ranked[0]!.cost_per_job, 4); // 0.04 * 100
    assert.equal(result.ranked[0]!.cost_per_1k_images, 40); // 0.04 * 1000
  });

  test("computes per_megapixel cost as amount × count × megapixels", () => {
    const model = makeModel({
      offerings: [
        {
          slug: "fal-flux-1-1-pro-fal",
          provider: "fal",
          model: { id: "bfl/flux-1-1-pro", modality: "text-to-image", status: "ga", generation: "current" },
          tiers: [
            {
              id: "default",
              pricing: [
                { amount: 0.04, currency: "USD", unit: "per_megapixel", effective_from: "2026-06-09" },
              ],
            },
          ],
        },
      ],
    });
    const twoMpJob: JobSpec = { count: 100, resolution: "1414x1414" }; // ~2 MP
    const result = computeCosts([model], twoMpJob);
    assert.equal(result.ranked.length, 1);
    // 0.04 * 100 * ~2 MP
    assert.ok(Math.abs(result.ranked[0]!.cost_per_job - 8) < 0.05);
  });

  test("routes per_credit and per_month to nonComparable, never force-converted", () => {
    const model = makeModel({
      offerings: [
        {
          slug: "leonardo-phoenix-leonardo",
          provider: "leonardo",
          model: { id: "leonardo/phoenix", modality: "text-to-image", status: "ga", generation: "current" },
          tiers: [
            {
              id: "default",
              pricing: [
                { amount: 0.00257, currency: "USD", unit: "per_credit", effective_from: "2026-06-01" },
              ],
            },
          ],
        },
      ],
    });
    const result = computeCosts([model], job);
    assert.equal(result.ranked.length, 0);
    assert.equal(result.nonComparable.length, 1);
    assert.equal(result.nonComparable[0]!.unit, "per_credit");
    assert.match(result.nonComparable[0]!.reason, /guessing how many credits/);
  });

  test("sorts ranked offerings ascending by cost_per_job", () => {
    const cheap = makeModel({ model_id: "a/cheap", name: "Cheap" });
    const expensive = makeModel({
      model_id: "b/expensive",
      name: "Expensive",
      offerings: [
        {
          slug: "expensive-host",
          provider: "host",
          model: { id: "b/expensive", modality: "text-to-image", status: "ga", generation: "current" },
          tiers: [
            {
              id: "default",
              pricing: [{ amount: 5, currency: "USD", unit: "per_image", effective_from: "2026-06-09" }],
            },
          ],
        },
      ],
    });
    const result = computeCosts([expensive, cheap], job);
    assert.equal(result.ranked[0]!.name, "Cheap");
    assert.equal(result.ranked[1]!.name, "Expensive");
  });
});

// ---------------------------------------------------------------------------
// crossHostSpreads
// ---------------------------------------------------------------------------

describe("crossHostSpreads", () => {
  const job: JobSpec = { count: 100, resolution: "1000x1000" };

  test("flags a model_id offered at two hosts with different job costs", () => {
    const twoHost = makeModel({
      offerings: [
        {
          slug: "flux-1-1-pro-replicate",
          provider: "replicate",
          model: { id: "bfl/flux-1-1-pro", modality: "text-to-image", status: "ga", generation: "current" },
          tiers: [{ id: "default", pricing: [{ amount: 0.04, currency: "USD", unit: "per_image", effective_from: "2026-06-09" }] }],
        },
        {
          slug: "fal-flux-1-1-pro-fal",
          provider: "fal",
          model: { id: "bfl/flux-1-1-pro", modality: "text-to-image", status: "ga", generation: "current" },
          tiers: [{ id: "default", pricing: [{ amount: 0.06, currency: "USD", unit: "per_megapixel", effective_from: "2026-06-09" }] }],
        },
      ],
    });
    const { ranked } = computeCosts([twoHost], job);
    const spreads = crossHostSpreads(ranked);
    assert.equal(spreads.length, 1);
    assert.equal(spreads[0]!.model_id, "bfl/flux-1-1-pro");
    assert.equal(spreads[0]!.cheapest.provider, "replicate");
    assert.equal(spreads[0]!.priciest.provider, "fal");
    assert.ok(spreads[0]!.spread_pct > 0);
  });

  test("ignores a model_id offered at only one host", () => {
    const { ranked } = computeCosts([makeModel()], job);
    assert.deepEqual(crossHostSpreads(ranked), []);
  });

  test("ignores a model_id whose hosts land on an identical job cost", () => {
    const sameCost = makeModel({
      offerings: [
        {
          slug: "host-a",
          provider: "a",
          model: { id: "bfl/flux-1-1-pro", modality: "text-to-image", status: "ga", generation: "current" },
          tiers: [{ id: "default", pricing: [{ amount: 0.04, currency: "USD", unit: "per_image", effective_from: "2026-06-09" }] }],
        },
        {
          slug: "host-b",
          provider: "b",
          model: { id: "bfl/flux-1-1-pro", modality: "text-to-image", status: "ga", generation: "current" },
          tiers: [{ id: "default", pricing: [{ amount: 0.04, currency: "USD", unit: "per_megapixel", effective_from: "2026-06-09" }] }],
        },
      ],
    });
    // At exactly 1 MP, per_image and per_megapixel produce the same job cost.
    const { ranked } = computeCosts([sameCost], job);
    assert.deepEqual(crossHostSpreads(ranked), []);
  });
});
