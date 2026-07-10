/**
 * Tests for switch-check's diff computation — the pure functions between the
 * feed fetch and the report renderer.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  type ModelEntry,
  type Tier,
  currentPrice,
  collectCurrentPrices,
  comparePrices,
  analyzeHistory,
  analyzeModelHistory,
  daysBetween,
  historyWindowLabel,
  capabilityDiff,
  unitWarnings,
  lifecycleCheck,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<ModelEntry> & { model_id: string }): ModelEntry {
  return {
    name: overrides.model_id,
    join_status: "joined",
    knowledge: null,
    offerings: [],
    ...overrides,
  };
}

/** Mirrors the real bfl/flux-1-dev replicate tier: one superseded entry
 *  (0.03, closed out by effective_to) and one current entry (0.025). */
const CUT_TIER: Tier = {
  id: "default",
  pricing: [
    {
      amount: 0.03,
      currency: "USD",
      unit: "per_image",
      effective_from: "2026-06-09",
      effective_to: "2026-06-09",
      source: { url: "https://replicate.com/black-forest-labs/flux-dev" },
    },
    {
      amount: 0.025,
      currency: "USD",
      unit: "per_image",
      effective_from: "2026-06-10",
      source: { url: "https://replicate.com/pricing" },
    },
  ],
};

/** What the same tier looks like after the Free-plan gate: only the current
 *  entry survives, with its real effective_from intact. */
const GATED_TIER: Tier = {
  id: "default",
  pricing: [CUT_TIER.pricing[1]!],
};

const FROM_MODEL = makeModel({
  model_id: "bfl/flux-1-1-pro",
  name: "FLUX 1.1 [pro]",
  knowledge: {
    capability_profile: [
      { dimension: "text-rendering", rating: "strong" },
      { dimension: "photorealism", rating: "strong" },
      { dimension: "inference-speed", rating: "moderate" },
      { dimension: "only-on-from", rating: "strong" },
    ],
  },
  offerings: [
    {
      slug: "flux-1-1-pro-replicate",
      provider: "replicate",
      model: { id: "bfl/flux-1-1-pro", modality: "image", status: "ga", generation: "current" },
      tiers: [
        {
          id: "default",
          pricing: [
            { amount: 0.04, currency: "USD", unit: "per_image", effective_from: "2026-06-09" },
          ],
        },
      ],
    },
    {
      slug: "fal-flux-1-1-pro-fal",
      provider: "fal",
      model: { id: "bfl/flux-1-1-pro", modality: "image", status: "ga", generation: "current" },
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

const TO_MODEL = makeModel({
  model_id: "bfl/flux-1-dev",
  name: "FLUX.1 [dev]",
  knowledge: {
    capability_profile: [
      { dimension: "text-rendering", rating: "moderate" },
      { dimension: "photorealism", rating: "strong" },
      { dimension: "inference-speed", rating: "strong" },
      { dimension: "only-on-to", rating: "weak" },
    ],
  },
  offerings: [
    {
      slug: "flux-1-dev-replicate",
      provider: "replicate",
      model: { id: "bfl/flux-1-dev", modality: "image", status: "ga", generation: "current" },
      tiers: [CUT_TIER],
    },
  ],
});

// ---------------------------------------------------------------------------
// currentPrice
// ---------------------------------------------------------------------------

describe("currentPrice", () => {
  test("prefers the open-ended (no effective_to) entry", () => {
    assert.equal(currentPrice(CUT_TIER)?.amount, 0.025);
  });

  test("falls back to most recent when every entry is closed", () => {
    const tier: Tier = {
      id: "t",
      pricing: CUT_TIER.pricing.map((p) => ({ ...p, effective_to: "2026-07-01" })),
    };
    assert.equal(currentPrice(tier)?.amount, 0.025);
  });

  test("returns null on an empty history", () => {
    assert.equal(currentPrice({ id: "t", pricing: [] }), null);
  });
});

// ---------------------------------------------------------------------------
// comparePrices
// ---------------------------------------------------------------------------

describe("comparePrices", () => {
  test("computes a delta only for units priced on both sides", () => {
    const result = comparePrices(FROM_MODEL, TO_MODEL);
    assert.equal(result.shared.length, 1);
    const cmp = result.shared[0]!;
    assert.equal(cmp.unit, "per_image");
    assert.equal(cmp.from.amount, 0.04);
    assert.equal(cmp.to.amount, 0.025);
    assert.ok(Math.abs(cmp.delta_pct - -37.5) < 0.001);
  });

  test("lists one-sided units instead of converting them", () => {
    const result = comparePrices(FROM_MODEL, TO_MODEL);
    assert.deepEqual(
      result.fromOnly.map((p) => p.unit),
      ["per_megapixel"],
    );
    assert.equal(result.toOnly.length, 0);
  });

  test("uses the cheapest offering per unit on each side", () => {
    const pricier = makeModel({
      ...structuredClone(TO_MODEL),
      model_id: TO_MODEL.model_id,
    });
    pricier.offerings.push({
      slug: "elsewhere",
      provider: "elsewhere",
      model: { id: pricier.model_id, modality: "image", status: "ga", generation: "current" },
      tiers: [
        {
          id: "default",
          pricing: [{ amount: 0.09, currency: "USD", unit: "per_image", effective_from: "2026-06-01" }],
        },
      ],
    });
    const result = comparePrices(FROM_MODEL, pricier);
    assert.equal(result.shared[0]!.to.amount, 0.025); // not 0.09
  });
});

// ---------------------------------------------------------------------------
// analyzeHistory
// ---------------------------------------------------------------------------

describe("analyzeHistory", () => {
  const today = new Date("2026-07-10T00:00:00Z");

  test("detects a cut and dates it, with age in days", () => {
    const h = analyzeHistory("replicate", CUT_TIER, today)!;
    assert.equal(h.visible_entries, 2);
    assert.equal(h.current.amount, 0.025);
    assert.equal(h.current.age_days, 30);
    assert.equal(h.previous?.amount, 0.03);
    assert.equal(h.previous?.direction, "cut");
    assert.ok(Math.abs((h.previous?.delta_pct ?? 0) - -16.666) < 0.01);
  });

  test("gated (Free-view) history keeps honest age but shows no previous entry", () => {
    const h = analyzeHistory("replicate", GATED_TIER, today)!;
    assert.equal(h.visible_entries, 1);
    assert.equal(h.current.age_days, 30); // real effective_from survives the gate
    assert.equal(h.previous, null);
  });

  test("detects a raise", () => {
    const tier: Tier = {
      id: "t",
      pricing: [
        { amount: 2, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2025-01-01", effective_to: "2026-06-01" },
        { amount: 3, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-06-01" },
      ],
    };
    const h = analyzeHistory("x", tier, today)!;
    assert.equal(h.previous?.direction, "raise");
    assert.equal(h.previous?.delta_pct, 50);
  });

  test("returns null for a tier with no pricing at all", () => {
    assert.equal(analyzeHistory("x", { id: "t", pricing: [] }, today), null);
  });

  test("analyzeModelHistory walks every offering×tier", () => {
    assert.equal(analyzeModelHistory(FROM_MODEL, today).length, 2);
  });
});

describe("daysBetween", () => {
  test("floors and never goes negative", () => {
    const today = new Date("2026-07-10T12:00:00Z");
    assert.equal(daysBetween("2026-07-09", today), 1);
    assert.equal(daysBetween("2026-08-01", today), 0);
  });
});

describe("historyWindowLabel", () => {
  test("labels every plan tier", () => {
    for (const tier of ["free", "app", "starter", "pro", "internal"] as const) {
      assert.ok(historyWindowLabel(tier).length > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// capabilityDiff
// ---------------------------------------------------------------------------

describe("capabilityDiff", () => {
  test("classifies lose, gain, same, and unverifiable", () => {
    const diff = capabilityDiff(FROM_MODEL, TO_MODEL);
    const byDim = new Map(diff.map((c) => [c.dimension, c]));
    assert.equal(byDim.get("text-rendering")?.kind, "lose"); // strong → moderate
    assert.equal(byDim.get("inference-speed")?.kind, "gain"); // moderate → strong
    assert.equal(byDim.get("photorealism")?.kind, "same");
    assert.equal(byDim.get("only-on-from")?.kind, "unverifiable");
    assert.equal(byDim.get("only-on-to")?.kind, "unverifiable");
  });

  test("a rating outside the known scale is unverifiable, not force-ranked", () => {
    const a = makeModel({
      model_id: "a/x",
      knowledge: { capability_profile: [{ dimension: "d", rating: "excellent" }] },
    });
    const b = makeModel({
      model_id: "b/y",
      knowledge: { capability_profile: [{ dimension: "d", rating: "strong" }] },
    });
    assert.equal(capabilityDiff(a, b)[0]?.kind, "unverifiable");
  });

  test("a model with no profile yields an empty diff (renderer states it)", () => {
    const bare = makeModel({ model_id: "a/x" });
    assert.deepEqual(capabilityDiff(bare, makeModel({ model_id: "b/y" })), []);
  });
});

// ---------------------------------------------------------------------------
// unitWarnings
// ---------------------------------------------------------------------------

describe("unitWarnings", () => {
  test("no warning when every unit is priced on both sides", () => {
    const symmetric = structuredClone(FROM_MODEL);
    const warnings = unitWarnings(comparePrices(symmetric, FROM_MODEL));
    assert.equal(warnings.length, 0);
  });

  test("warns on a per_image → per_megapixel cost-curve change", () => {
    const megapixelOnly = makeModel({
      model_id: "x/mp",
      offerings: [
        {
          slug: "mp",
          provider: "fal",
          model: { id: "x/mp", modality: "image", status: "ga", generation: "current" },
          tiers: [
            {
              id: "default",
              pricing: [{ amount: 0.04, currency: "USD", unit: "per_megapixel", effective_from: "2026-06-01" }],
            },
          ],
        },
      ],
    });
    const imageOnly = makeModel({
      model_id: "x/img",
      offerings: [
        {
          slug: "img",
          provider: "replicate",
          model: { id: "x/img", modality: "image", status: "ga", generation: "current" },
          tiers: [
            {
              id: "default",
              pricing: [{ amount: 0.03, currency: "USD", unit: "per_image", effective_from: "2026-06-01" }],
            },
          ],
        },
      ],
    });
    const warnings = unitWarnings(comparePrices(imageOnly, megapixelOnly));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.from_unit, "per_image");
    assert.equal(warnings[0]!.to_unit, "per_megapixel");
    assert.match(warnings[0]!.note, /resolution/);
  });

  test("flags per_credit as non-convertible instead of guessing a rate", () => {
    const creditOnly = makeModel({
      model_id: "x/credit",
      offerings: [
        {
          slug: "c",
          provider: "somewhere",
          model: { id: "x/credit", modality: "image", status: "ga", generation: "current" },
          tiers: [
            {
              id: "default",
              pricing: [{ amount: 10, currency: "USD", unit: "per_credit", effective_from: "2026-06-01" }],
            },
          ],
        },
      ],
    });
    const warnings = unitWarnings(comparePrices(FROM_MODEL, creditOnly));
    assert.ok(warnings.some((w) => w.note.includes("credits")));
  });
});

// ---------------------------------------------------------------------------
// lifecycleCheck
// ---------------------------------------------------------------------------

describe("lifecycleCheck", () => {
  test("clean pair produces no flags", () => {
    assert.deepEqual(lifecycleCheck(FROM_MODEL, TO_MODEL), []);
  });

  test("deprecated / previous-gen on the TO side is a warning", () => {
    const stale = structuredClone(TO_MODEL);
    stale.offerings[0]!.model.status = "deprecated";
    stale.offerings[0]!.model.generation = "previous";
    const flags = lifecycleCheck(FROM_MODEL, stale);
    assert.equal(flags.length, 2);
    assert.ok(flags.every((f) => f.side === "to" && f.severity === "warn"));
    assert.ok(flags.some((f) => f.field === "status" && f.value === "deprecated"));
    assert.ok(flags.some((f) => f.field === "generation" && f.value === "previous"));
  });

  test("the same on the FROM side is informational context, not a warning", () => {
    const stale = structuredClone(FROM_MODEL);
    for (const off of stale.offerings) off.model.status = "deprecated";
    const flags = lifecycleCheck(stale, TO_MODEL);
    assert.ok(flags.length > 0);
    assert.ok(flags.every((f) => f.side === "from" && f.severity === "info"));
  });
});
