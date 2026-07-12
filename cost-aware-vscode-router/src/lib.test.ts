/**
 * Tests for cost-aware-vscode-router's selection logic — in particular the
 * quality-bar filter (SCO-165 finding #1): `minSweBenchVerified` must
 * actually filter candidates, not just exist in the schema unread.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  type NormalisedModel,
  type Task,
  codingQualityBar,
  selectCodingModel,
  selectWritingModel,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<NormalisedModel> & { name: string }): NormalisedModel {
  return {
    slug: overrides.name.toLowerCase().replace(/\s+/g, "-"),
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
