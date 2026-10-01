/**
 * Tests for cost-aware-vscode-router's selection logic — in particular the
 * quality-bar filter (SCO-165 finding #1): `minSweBenchVerified` must
 * actually filter candidates, not just exist in the schema unread; and host
 * attribution (SCO-165 finding #3): normalise() must not discard which
 * provider the selected offering came from.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  type ModelEntry,
  type NormalisedModel,
  type Task,
  type Tier,
  codingQualityBar,
  deviationType,
  currentPrice,
  headlinePrice,
  isHeadlineTier,
  normalise,
  selectCodingModel,
  selectWritingModel,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<NormalisedModel> & { name: string }): NormalisedModel {
  return {
    slug: overrides.name.toLowerCase().replace(/\s+/g, "-"),
    provider: "test-provider",
    qualityTier: "premium",
    codingRating: "strong",
    instrRating: null,
    sweBenchVerified: null,
    sweBenchSource: "",
    hasSweBenchPro: false,
    inputPricePerM: null,
    outputPricePerM: null,
    ...overrides,
  };
}

// Mirrors the real live-feed shape checked on 2026-07-12: o4-mini (68.1%,
// $1.10) is both cheaper and higher-scored than Gemini 2.5 Pro (63.8%, $1.25).
const O4_MINI = makeModel({
  name: "o4-mini",
  sweBenchVerified: 68.1,
  sweBenchSource: "openai.com, vendor",
  inputPricePerM: 1.1,
  outputPricePerM: 4.4,
});
const GEMINI_2_5_PRO = makeModel({
  name: "Gemini 2.5 Pro",
  sweBenchVerified: 63.8,
  sweBenchSource: "deepmind.google, vendor",
  inputPricePerM: 1.25,
  outputPricePerM: 10,
});
const NO_SCORE_MODEL = makeModel({ name: "Mistral Large 3", inputPricePerM: 0.5 });
const PRO_ONLY_MODEL = makeModel({
  name: "Claude Sonnet 5",
  hasSweBenchPro: true,
  inputPricePerM: 3,
});

const POOL = [O4_MINI, GEMINI_2_5_PRO, NO_SCORE_MODEL, PRO_ONLY_MODEL];

// ---------------------------------------------------------------------------
// selectCodingModel — no threshold (backward-compatible default)
// ---------------------------------------------------------------------------

describe("selectCodingModel with no threshold", () => {
  test("picks the cheapest confirmed-score candidate, unaffected by qualifying filter", () => {
    const { selected, qualifying } = selectCodingModel(POOL);
    assert.equal(selected, O4_MINI);
    assert.equal(qualifying.length, 2); // both scored models qualify when there's no bar
  });

  test("excludes no-score and pro-only models with their existing reasons", () => {
    const { excluded } = selectCodingModel(POOL);
    const reasons = excluded.map((e) => e.model.name);
    assert.ok(reasons.includes("Mistral Large 3"));
    assert.ok(reasons.includes("Claude Sonnet 5"));
  });
});

// ---------------------------------------------------------------------------
// selectCodingModel — with a quality-bar threshold (SCO-165 finding #1)
// ---------------------------------------------------------------------------

describe("selectCodingModel with minSweBenchVerified threshold", () => {
  test("a threshold between the two real scores excludes the weaker one, keeps the pick unchanged", () => {
    const { selected, qualifying, excluded } = selectCodingModel(POOL, 65);
    assert.equal(selected, O4_MINI);
    assert.equal(qualifying.length, 1);
    assert.equal(qualifying[0], O4_MINI);
    const belowBarReason = excluded.find((e) => e.model === GEMINI_2_5_PRO);
    assert.ok(belowBarReason);
    assert.equal(
      belowBarReason!.reason,
      "SWE-bench Verified 63.8% is below the required threshold of 65%",
    );
  });

  test("a threshold above every candidate's score yields no selection at all", () => {
    const { selected, qualifying } = selectCodingModel(POOL, 90);
    assert.equal(selected, null);
    assert.equal(qualifying.length, 0);
  });

  test("a threshold at or below the weaker score doesn't exclude it — the mechanism only filters, never inflates", () => {
    const { selected, qualifying } = selectCodingModel(POOL, 63.8);
    assert.equal(selected, O4_MINI); // still cheapest among both qualifying candidates
    assert.equal(qualifying.length, 2);
  });

  test("a cheaper-but-below-bar model does NOT win over a pricier-but-qualifying one", () => {
    // Construct a case the real feed doesn't currently have: a cheap weak
    // model and an expensive strong one, to prove the filter runs BEFORE
    // the cheapest-price sort, not after.
    const cheapWeak = makeModel({ name: "Cheap Weak", sweBenchVerified: 40, inputPricePerM: 0.1 });
    const pricyStrong = makeModel({ name: "Pricy Strong", sweBenchVerified: 80, inputPricePerM: 9 });
    const { selected } = selectCodingModel([cheapWeak, pricyStrong], 65);
    assert.equal(selected, pricyStrong);
  });
});

// ---------------------------------------------------------------------------
// codingQualityBar — derives the task-level threshold
// ---------------------------------------------------------------------------

function makeTask(subtasks: Task["subtasks"]): Task {
  return { description: "test task", subtasks };
}

describe("codingQualityBar", () => {
  test("returns null when no subtask sets a threshold", () => {
    const task = makeTask([{ description: "code it", tag: "coding" }]);
    assert.equal(codingQualityBar(task), null);
  });

  test("returns the single threshold when only one coding subtask sets one", () => {
    const task = makeTask([
      { description: "code it", tag: "coding", minSweBenchVerified: 65 },
      { description: "write it", tag: "writing" },
    ]);
    assert.equal(codingQualityBar(task), 65);
  });

  test("returns the strictest (highest) threshold across multiple coding subtasks", () => {
    const task = makeTask([
      { description: "easy part", tag: "coding", minSweBenchVerified: 50 },
      { description: "hard part", tag: "coding", minSweBenchVerified: 75 },
    ]);
    assert.equal(codingQualityBar(task), 75);
  });

  test("ignores a threshold set on a non-coding subtask", () => {
    // The type doesn't forbid this, but codingQualityBar must not honour it —
    // a bar on a writing subtask has no SWE-bench score to compare against.
    const task = makeTask([
      { description: "code it", tag: "coding" },
      { description: "write it", tag: "writing", minSweBenchVerified: 90 },
    ]);
    assert.equal(codingQualityBar(task), null);
  });
});

// ---------------------------------------------------------------------------
// selectWritingModel — unaffected by this change (regression guard)
// ---------------------------------------------------------------------------

describe("selectWritingModel", () => {
  test("still picks cheapest strong|good instruction-following candidate, untouched by the coding quality bar", () => {
    const writer = makeModel({ name: "Llama 4 Scout", instrRating: "strong", inputPricePerM: 0.1 });
    const selected = selectWritingModel([...POOL, writer]);
    assert.equal(selected, writer);
  });
});

// ---------------------------------------------------------------------------
// normalise — host attribution (SCO-165 finding #3)
// ---------------------------------------------------------------------------

function makeModelEntry(overrides: Partial<ModelEntry> & { model_id: string }): ModelEntry {
  return {
    name: overrides.model_id,
    offerings: [],
    ...overrides,
  };
}

describe("normalise", () => {
  test("carries the provider of the selected (cheapest) offering", () => {
    const entry = makeModelEntry({
      model_id: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      offerings: [
        {
          slug: "claude-sonnet-5-anthropic",
          provider: "anthropic",
          quality_tier: "premium",
          tiers: [
            {
              id: "input",
              pricing: [{ amount: 3, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-01-01" }],
            },
          ],
        },
      ],
    });
    const result = normalise(entry);
    assert.equal(result.provider, "anthropic");
  });

  test("picks the cheapest offering's provider when a model has multiple hosts", () => {
    // No current LLM model in the live feed has more than one offering
    // (confirmed against the live feed on 2026-07-12), but normalise() must
    // still get this right for any model that does -- image models commonly
    // do, and this function's contract shouldn't assume LLM-only shape.
    const entry = makeModelEntry({
      model_id: "meta/llama-4-scout",
      name: "Llama 4 Scout",
      offerings: [
        {
          slug: "llama-4-scout-expensive-host",
          provider: "expensive-host",
          quality_tier: "fast",
          tiers: [
            {
              id: "input",
              pricing: [{ amount: 0.5, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-01-01" }],
            },
          ],
        },
        {
          slug: "llama-4-scout-cheap-host",
          provider: "cheap-host",
          quality_tier: "fast",
          tiers: [
            {
              id: "input",
              pricing: [{ amount: 0.1, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-01-01" }],
            },
          ],
        },
      ],
    });
    const result = normalise(entry);
    assert.equal(result.provider, "cheap-host");
    assert.equal(result.inputPricePerM, 0.1);
  });

  test("provider is an empty string, not undefined/throwing, when a model has zero offerings", () => {
    const entry = makeModelEntry({ model_id: "orphan/model", name: "Orphan Model" });
    const result = normalise(entry);
    assert.equal(result.provider, "");
  });
});

// ---------------------------------------------------------------------------
// deviationType — escalation vs override distinction (SCO-165 finding #6)
// ---------------------------------------------------------------------------

describe("deviationType", () => {
  test("actual matches recommended → none, regardless of the --escalated flag", () => {
    assert.equal(deviationType("o4-mini", "o4-mini", false), "none");
    assert.equal(deviationType("o4-mini", "o4-mini", true), "none");
  });

  test("actual differs from recommended and --escalated is set → escalation", () => {
    assert.equal(deviationType("o4-mini", "Gemini 2.5 Pro", true), "escalation");
  });

  test("actual differs from recommended and --escalated is not set → override", () => {
    assert.equal(deviationType("o4-mini", "Gemini 2.5 Pro", false), "override");
  });
});

// ---------------------------------------------------------------------------
// Headline tiers (SCO-646 — the SCO-640 rule, same as modelglass.com.au/MCP)
// ---------------------------------------------------------------------------

function priced(id: string, amount: number, unit: string, attributes?: Record<string, unknown>): Tier {
  return {
    id,
    ...(attributes ? { attributes } : {}),
    pricing: [{ amount, currency: "USD", unit, effective_from: "2026-01-01" }],
  };
}

function singleOffering(model_id: string, tiers: Tier[]): ModelEntry {
  return makeModelEntry({
    model_id,
    offerings: [{ slug: `${model_id.replace("/", "-")}-host`, provider: "host", quality_tier: "premium", tiers }],
  });
}

/** Mirrors modelglass-llm's gpt-5-5-pro-openai: Batch is half the list price. */
const WITH_BATCH_TIERS = [
  priced("batch-input", 15, "per_1m_tokens_input", { processing: "batch" }),
  priced("batch-output", 90, "per_1m_tokens_output", { processing: "batch" }),
  priced("input", 30, "per_1m_tokens_input"),
  priced("output", 180, "per_1m_tokens_output"),
];

/** Mirrors modelglass-llm's inkling-thinking-machines: context-length tiers
 *  only — there is no tier literally named `input`. */
const CONTEXT_TIERS = [
  priced("input-64k", 1.87, "per_1m_tokens_input"),
  priced("output-64k", 4.68, "per_1m_tokens_output"),
  priced("input-256k", 3.74, "per_1m_tokens_input"),
  priced("output-256k", 9.36, "per_1m_tokens_output"),
];

describe("isHeadlineTier", () => {
  test("accepts standard and context-length tiers", () => {
    assert.equal(isHeadlineTier(priced("input", 1, "per_1m_tokens_input")), true);
    assert.equal(isHeadlineTier(priced("input-256k", 1, "per_1m_tokens_input")), true);
    assert.equal(isHeadlineTier(priced("input", 1, "per_1m_tokens_input", { processing: "standard" })), true);
  });

  test("rejects batch / flex / cached tiers, by attribute or by id prefix", () => {
    assert.equal(isHeadlineTier(priced("batch-input", 1, "per_1m_tokens_input", { processing: "batch" })), false);
    assert.equal(isHeadlineTier(priced("input", 1, "per_1m_tokens_input", { processing: "flex" })), false);
    assert.equal(isHeadlineTier(priced("batch-input", 1, "per_1m_tokens_input")), false);
    assert.equal(isHeadlineTier(priced("cached-input", 1, "per_1m_tokens_input")), false);
  });

  test("rejects prompt-cache units whatever the tier id (ADR-0015)", () => {
    assert.equal(isHeadlineTier(priced("cached-input", 0.1, "per_1m_tokens_cache_read")), false);
    assert.equal(isHeadlineTier(priced("prompt-cache", 0.1, "per_1m_tokens_cache_read")), false);
    assert.equal(isHeadlineTier(priced("writes", 2.5, "per_1m_tokens_cache_write")), false);
  });
});

describe("normalise headline price (SCO-646)", () => {
  test("a model with a cheaper Batch tier is priced at its Standard rate ($30/$180)", () => {
    const result = normalise(singleOffering("openai/gpt-5.5-pro", WITH_BATCH_TIERS));
    assert.equal(result.inputPricePerM, 30);
    assert.equal(result.outputPricePerM, 180);
  });

  test("a model priced only on context-length tiers is priced, not null ($1.87/$4.68)", () => {
    const result = normalise(singleOffering("thinking-machines/inkling", CONTEXT_TIERS));
    assert.equal(result.inputPricePerM, 1.87);
    assert.equal(result.outputPricePerM, 4.68);
  });

  test("offering choice ignores Batch rates: a $20 Standard host beats a $30 host with $15 Batch", () => {
    const entry = makeModelEntry({
      model_id: "x/multi-host",
      offerings: [
        { slug: "batch-host", provider: "batch-host", quality_tier: "premium", tiers: WITH_BATCH_TIERS },
        {
          slug: "plain-host",
          provider: "plain-host",
          quality_tier: "premium",
          tiers: [priced("input", 20, "per_1m_tokens_input"), priced("output", 60, "per_1m_tokens_output")],
        },
      ],
    });
    const result = normalise(entry);
    assert.equal(result.provider, "plain-host");
    assert.equal(result.inputPricePerM, 20);
  });

  test("headlinePrice returns null when no headline tier has the unit", () => {
    assert.equal(headlinePrice([priced("batch-input", 15, "per_1m_tokens_input", { processing: "batch" })], "per_1m_tokens_input"), null);
    assert.equal(headlinePrice([], "per_1m_tokens_input"), null);
  });

  // SCO-662: current row per the SCO-661 rule, not the last array element.
  test("headlinePrice uses DeepSeek V4-Pro's current $1.32, and V4-Flash (retired) has none", () => {
    const tier = (id: string, rows: Array<[number, string, string?]>): Tier => ({
      id,
      pricing: rows.map(([amount, from, to]) => ({ amount, currency: "USD", unit: "per_1m_tokens_input", effective_from: from, ...(to ? { effective_to: to } : {}) })),
    });
    // Reverse array order on purpose: the last element is the superseded row.
    assert.equal(headlinePrice([tier("input", [[1.32, "2026-08-16"], [0.435, "2026-08-04"]])], "per_1m_tokens_input"), 1.32);
    assert.equal(headlinePrice([tier("input", [[0.14, "2026-08-04"], [0.44, "2026-08-16", "2026-09-09"]])], "per_1m_tokens_input"), null);
    assert.equal(currentPrice([tier("input", [[0.14, "2026-08-04"], [0.44, "2026-08-16", "2026-09-09"]])], "input"), null);
  });
});
