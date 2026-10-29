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
  isHeadlineTier,
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

  test("a same-price row isn't a change: previous is the last different price", () => {
    // Whisper Large v3 on Groq (2026-10-29): the 09-30 row only re-cited a new
    // source at the same $0.00185/min, and read as a 0% "raise".
    const recite: Tier = { id: "audio-minutes", pricing: [row(0.00185, "per_minute", "2024-10-01", "2026-09-29"), row(0.00185, "per_minute", "2026-09-30")] };
    const h = analyzeHistory("groq", recite, TODAY_DATE)!;
    assert.equal(h.current.amount, 0.00185);
    assert.equal(h.previous, null);
    // A real change before a re-cite is still found: $1 → $2, then re-cited at $2.
    const changed: Tier = { id: "t", pricing: [row(1, IN, "2026-01-01", "2026-01-31"), row(2, IN, "2026-02-01", "2026-02-28"), row(2, IN, "2026-03-01")] };
    const c = analyzeHistory("x", changed, TODAY_DATE)!;
    assert.equal(c.previous?.amount, 1);
    assert.equal(c.previous?.direction, "raise");
    assert.equal(c.previous?.delta_pct, 100);
  });

  test("stable_since: a same-price re-cite doesn't restart it (SCO-835, Whisper Large v3 on Groq)", () => {
    const recite: Tier = { id: "audio-minutes", pricing: [row(0.00185, "per_minute", "2024-10-01", "2026-09-29"), row(0.00185, "per_minute", "2026-09-30")] };
    const h = analyzeHistory("groq", recite, TODAY_DATE)!;
    assert.equal(h.current.effective_from, "2026-09-30");
    assert.equal(h.current.stable_since, "2024-10-01");
    assert.equal(h.current.age_days, 15); // unchanged meaning: age of the current row
  });

  test("stable_since stops at a real price change, a gap, or another unit", () => {
    // $1, then $2 from 02-01, re-cited at $2 from 03-01: stable since 02-01.
    const changed: Tier = { id: "t", pricing: [row(1, IN, "2026-01-01", "2026-01-31"), row(2, IN, "2026-02-01", "2026-02-28"), row(2, IN, "2026-03-01")] };
    assert.equal(analyzeHistory("x", changed, TODAY_DATE)!.current.stable_since, "2026-02-01");
    // Same $2 but unpriced 02-11..02-28: the run restarts on 03-01.
    const gap: Tier = { id: "t", pricing: [row(2, IN, "2026-02-01", "2026-02-10"), row(2, IN, "2026-03-01")] };
    assert.equal(analyzeHistory("x", gap, TODAY_DATE)!.current.stable_since, "2026-03-01");
    // An earlier row in another unit never extends the run.
    const units: Tier = { id: "t", pricing: [row(2, "per_image", "2026-01-01", "2026-02-28"), row(2, IN, "2026-03-01")] };
    assert.equal(analyzeHistory("x", units, TODAY_DATE)!.current.stable_since, "2026-03-01");
  });

  test("stable_since is the row's own date when nothing earlier matches", () => {
    const single: Tier = { id: "t", pricing: [row(3, IN, "2026-05-01")] };
    assert.equal(analyzeHistory("x", single, TODAY_DATE)!.current.stable_since, "2026-05-01");
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

// Mirrors Runway's seedance2_5 (SCO-813): 30 credits/s of 720p output plus
// 15 credits/s of input or reference video. The input rate is cheaper per
// second but is an add-on, never the clip's headline price.
const SEEDANCE_25 = model("bytedance/seedance-2.5", "seedance-2-5-runway", "runway", [
  { id: "standard-720p", pricing: [row(0.3, "per_second", "2026-10-01")] },
  { id: "input-video-720p", pricing: [row(0.15, "per_input_video_second", "2026-10-01")] },
]);

describe("input-video seconds are never a headline price (SCO-813)", () => {
  test("collectHeadlinePrices keeps the output rate and drops the input-video rate", () => {
    assert.deepEqual(amountsByTier(collectHeadlinePrices(SEEDANCE_25, TODAY)), { "standard-720p": 0.3 });
  });
  test("collectCurrentPrices still lists both", () => {
    assert.deepEqual(amountsByTier(collectCurrentPrices(SEEDANCE_25, TODAY)), { "standard-720p": 0.3, "input-video-720p": 0.15 });
  });
  test("isHeadlineTier rejects it whatever the tier is called", () => {
    assert.equal(isHeadlineTier({ id: "standard", pricing: [row(0.15, "per_input_video_second", "2026-10-01")] }), false);
  });
});
