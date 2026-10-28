/**
 * SCO-735: every helper that picks a "current" price must use the same row
 * activePrice() picks, on the same `today`. The two fixtures are the live
 * feed's real rows (2026-10-15) that exposed the bug in compare_models:
 *
 * - Gemini 4 Argon: $2 / $10 until 2026-11-30, then a future-dated $4 / $20
 *   row from 2026-12-01. The future row was reported as current.
 * - DeepSeek V4-Pro: open-ended $0.435 / $0.87 rows from 2026-08-04,
 *   superseded by open-ended $1.32 / $3.96 rows from 2026-08-16. The old
 *   rows were reported as current.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  type ModelEntry,
  type PriceEntry,
  type Tier,
  activePrice,
  analyzeHistory,
  analyzeModelHistory,
  collectCurrentPrices,
  collectHeadlinePrices,
  comparePrices,
  todayIso,
  NON_HEADLINE_UNITS,
  NON_HEADLINE_UNIT_LIST,
} from "./index.js";

const IN = "per_1m_tokens_input";
const OUT = "per_1m_tokens_output";
const CACHE = "per_1m_tokens_cache_read";

const row = (amount: number, unit: string, from: string, to?: string): PriceEntry => ({
  amount,
  currency: "USD",
  unit,
  effective_from: from,
  ...(to ? { effective_to: to } : {}),
});

function model(model_id: string, slug: string, provider: string, tiers: Tier[]): ModelEntry {
  return {
    model_id,
    name: model_id,
    offerings: [{ slug, provider, model: { id: model_id, modality: "llm", status: "ga", generation: "current" }, tiers }],
  };
}

const ARGON = model("google-deepmind/gemini-4-argon", "gemini-4-argon-google-deepmind", "google-deepmind", [
  { id: "input", pricing: [row(2, IN, "2026-10-14", "2026-11-30"), row(4, IN, "2026-12-01")] },
  { id: "cached-input", pricing: [row(0.1, CACHE, "2026-10-14", "2026-11-30"), row(0.2, CACHE, "2026-12-01")] },
  { id: "output", pricing: [row(10, OUT, "2026-10-14", "2026-11-30"), row(20, OUT, "2026-12-01")] },
]);

const V4_PRO = model("deepseek/deepseek-v4-pro", "deepseek-v4-pro-deepseek", "deepseek", [
  { id: "input", pricing: [row(0.435, IN, "2026-08-04"), row(1.32, IN, "2026-08-16")] },
  { id: "output", pricing: [row(0.87, OUT, "2026-08-04"), row(3.96, OUT, "2026-08-16")] },
  { id: "off-peak-input", attributes: { processing: "off-peak" }, pricing: [row(0.66, IN, "2026-08-16")] },
  { id: "off-peak-output", attributes: { processing: "off-peak" }, pricing: [row(1.98, OUT, "2026-08-16")] },
  { id: "cached-input", pricing: [row(0.044, CACHE, "2026-08-16")] },
]);

const TODAY = "2026-10-15";
const TODAY_DATE = new Date(`${TODAY}T00:00:00Z`);

const amountsByTier = (prices: { tier_id: string; amount: number }[]) =>
  Object.fromEntries(prices.map((p) => [p.tier_id, p.amount]));

describe("SCO-735: Gemini 4 Argon (future-dated row)", () => {
  test("collectCurrentPrices shows today's $2 / $10, not the 2026-12-01 $4 / $20", () => {
    assert.deepEqual(amountsByTier(collectCurrentPrices(ARGON, TODAY)), { input: 2, "cached-input": 0.1, output: 10 });
  });

  test("the scheduled row takes over on its day", () => {
    assert.deepEqual(amountsByTier(collectHeadlinePrices(ARGON, "2026-11-30")), { input: 2, output: 10 });
    assert.deepEqual(amountsByTier(collectHeadlinePrices(ARGON, "2026-12-01")), { input: 4, output: 20 });
  });

  test("analyzeHistory: current $2 since 10-14, no previous change (the future row isn't one)", () => {
    const [input] = analyzeModelHistory(ARGON, TODAY_DATE);
    assert.equal(input!.current.amount, 2);
    assert.equal(input!.current.effective_from, "2026-10-14");
    assert.equal(input!.current.age_days, 1);
    assert.equal(input!.previous, null);
  });

  test("analyzeHistory after 12-01: a 100% raise from $2", () => {
    const h = analyzeHistory("google-deepmind", ARGON.offerings[0]!.tiers[0]!, new Date("2026-12-02T00:00:00Z"))!;
    assert.equal(h.current.amount, 4);
    assert.equal(h.previous?.amount, 2);
    assert.equal(h.previous?.direction, "raise");
    assert.equal(h.previous?.delta_pct, 100);
  });
});

describe("SCO-735: DeepSeek V4-Pro (superseded open-ended rows)", () => {
  test("collectHeadlinePrices shows $1.32 / $3.96, not the superseded $0.435 / $0.87", () => {
    assert.deepEqual(amountsByTier(collectHeadlinePrices(V4_PRO, TODAY)), { input: 1.32, output: 3.96 });
  });

  test("cheapest-per-unit never reaches back to a superseded row", () => {
    const cmp = comparePrices(V4_PRO, ARGON, TODAY);
    const input = cmp.shared.find((s) => s.unit === IN)!;
    assert.equal(input.from.amount, 1.32);
    assert.equal(input.to.amount, 2);
  });

  test("analyzeHistory: current $1.32 since 08-16, a raise from $0.435", () => {
    const [input, output] = analyzeModelHistory(V4_PRO, TODAY_DATE);
    assert.equal(input!.current.amount, 1.32);
    assert.equal(input!.current.effective_from, "2026-08-16");
    assert.equal(input!.previous?.amount, 0.435);
    assert.equal(input!.previous?.direction, "raise");
    assert.equal(output!.current.amount, 3.96);
    assert.equal(output!.previous?.amount, 0.87);
  });
});

describe("SCO-735: today is injectable and every helper agrees with activePrice()", () => {
  test("todayIso is the UTC date", () => {
    assert.equal(todayIso(new Date("2026-10-15T23:30:00Z")), "2026-10-15");
  });

  test("analyzeHistory uses its `today`, not the wall clock", () => {
    // Before 08-16 the old rows were genuinely current.
    const [input] = analyzeModelHistory(V4_PRO, new Date("2026-08-10T00:00:00Z"));
    assert.equal(input!.current.amount, 0.435);
    assert.equal(input!.previous, null);
  });

  test("archived rows are never current or previous (ADR-0014)", () => {
    const tier: Tier = {
      id: "input",
      pricing: [row(1, IN, "2026-01-01"), { ...row(9, IN, "2026-02-01"), archived: { at: "2026-02-02" } }],
    };
    assert.equal(activePrice(tier.pricing, TODAY)?.amount, 1);
    assert.equal(analyzeHistory("x", tier, TODAY_DATE)?.previous, null);
  });

  test("previous stays within the same unit and region", () => {
    const tier: Tier = {
      id: "t",
      pricing: [row(5, "per_image", "2026-01-01"), row(3, IN, "2026-02-01"), { ...row(2, IN, "2026-03-01"), region: "eu" }],
    };
    const h = analyzeHistory("x", tier, TODAY_DATE)!;
    assert.equal(h.current.amount, 2);
    assert.equal(h.previous, null);
  });

  // Every tier in both fixtures, across dates either side of each switch.
  const dates = ["2026-08-03", "2026-08-04", "2026-08-15", "2026-08-16", TODAY, "2026-11-30", "2026-12-01", "2027-01-01"];
  for (const m of [ARGON, V4_PRO]) {
    for (const date of dates) {
      test(`${m.model_id} on ${date}: collect* and analyze* match activePrice() tier by tier`, () => {
        const current = collectCurrentPrices(m, date);
        const history = analyzeModelHistory(m, new Date(`${date}T00:00:00Z`));
        for (const off of m.offerings) {
          for (const tier of off.tiers) {
            const expected = activePrice(tier.pricing, date);
            const got = current.find((p) => p.tier_id === tier.id);
            const hist = history.find((h) => h.tier_id === tier.id);
            assert.equal(got?.amount, expected?.amount, `collect ${tier.id}`);
            assert.equal(got?.effective_from, expected?.effective_from, `collect ${tier.id}`);
            assert.equal(hist?.current.amount, expected?.amount, `analyze ${tier.id}`);
          }
        }
      });
    }
  }
});

describe("NON_HEADLINE_UNITS (SCO-653: one list, generated from @modelglass/core)", () => {
  test("the set is exactly the generated list, with no duplicates", () => {
    assert.deepEqual([...NON_HEADLINE_UNITS].sort(), [...NON_HEADLINE_UNIT_LIST].sort());
    assert.equal(NON_HEADLINE_UNITS.size, NON_HEADLINE_UNIT_LIST.length);
  });
  test("includes the ADR-0015 prompt-cache units", () => {
    assert.ok(NON_HEADLINE_UNITS.has("per_1m_tokens_cache_read"));
    assert.ok(NON_HEADLINE_UNITS.has("per_1m_tokens_cache_write"));
  });
});
