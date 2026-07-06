/**
 * Tests for stack-watch's tier gate and drift computation.
 *
 * Neither existing example (av-prompt-refiner, cost-aware-vscode-router) has
 * a test suite to follow, so this uses Node's built-in test runner
 * (`node --test`) — zero added dependencies, consistent with this repo's
 * existing "Node.js 20+, nothing else required" posture.
 *
 * Run: npm test
 */
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import {
  currentPrice,
  toSnapshotModel,
  computeDrift,
  requireStarterOrPro,
  type Tier,
  type ModelEntry,
  type Snapshot,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Fixtures — shapes mirror real responses observed against the live feed
// (GET /v1/models, GET /v1/keys) during development.
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    model_id: "openai/o4-mini",
    name: "o4-mini",
    knowledge: {
      capability_profile: [
        { dimension: "coding", rating: "strong" },
        { dimension: "reasoning", rating: "strong" },
      ],
    },
    offerings: [
      {
        slug: "o4-mini-openai",
        provider: "openai",
        model: { id: "openai/o4-mini", modality: "text-generation", status: "ga", generation: "current" },
        tiers: [
          {
            id: "input",
            pricing: [
              {
                amount: 1.1,
                currency: "USD",
                unit: "per_1m_tokens_input",
                effective_from: "2026-06-01",
                source: { url: "https://openai.com/pricing" },
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// currentPrice
// ---------------------------------------------------------------------------

describe("currentPrice", () => {
  test("returns the entry with no effective_to", () => {
    const tier: Tier = {
      id: "input",
      pricing: [
        { amount: 1.5, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-05-01", effective_to: "2026-06-01" },
        { amount: 1.1, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-06-01" },
      ],
    };
    assert.equal(currentPrice(tier)?.amount, 1.1);
  });

  test("falls back to the most recent effective_from when nothing is open-ended", () => {
    const tier: Tier = {
      id: "input",
      pricing: [
        { amount: 1.5, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-05-01", effective_to: "2026-06-01" },
        { amount: 1.2, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-06-01", effective_to: "2026-06-15" },
      ],
    };
    assert.equal(currentPrice(tier)?.amount, 1.2);
  });

  test("returns null for an empty pricing array", () => {
    assert.equal(currentPrice({ id: "input", pricing: [] }), null);
  });
});

// ---------------------------------------------------------------------------
// toSnapshotModel
// ---------------------------------------------------------------------------

describe("toSnapshotModel", () => {
  test("extracts capability_profile as a dimension->rating map", () => {
    const snap = toSnapshotModel(makeModel());
    assert.deepEqual(snap.capability_profile, { coding: "strong", reasoning: "strong" });
  });

  test("records current price per offering/tier", () => {
    const snap = toSnapshotModel(makeModel());
    assert.equal(snap.offerings[0]!.prices["input"]!.amount, 1.1);
    assert.equal(snap.offerings[0]!.status, "ga");
    assert.equal(snap.offerings[0]!.generation, "current");
  });
});

// ---------------------------------------------------------------------------
// computeDrift
// ---------------------------------------------------------------------------

describe("computeDrift", () => {
  test("first run (no snapshot) reports baseline, not drift", () => {
    const model = makeModel();
    const report = computeDrift(["openai/o4-mini"], [model], null);
    assert.equal(report.isBaseline, true);
    assert.deepEqual(report.priceDrift, []);
    assert.deepEqual(report.lifecycleDrift, []);
    assert.deepEqual(report.capabilityDrift, []);
  });

  test("flags a stack model missing from the current feed", () => {
    const report = computeDrift(["openai/does-not-exist"], [makeModel()], {
      captured_at: "2026-07-01T00:00:00Z",
      models: {},
    });
    assert.deepEqual(report.notFound, ["openai/does-not-exist"]);
  });

  test("detects a price change since the snapshot", () => {
    const prior: Snapshot = {
      captured_at: "2026-07-01T00:00:00Z",
      models: {
        "openai/o4-mini": {
          model_id: "openai/o4-mini",
          name: "o4-mini",
          capability_profile: { coding: "strong", reasoning: "strong" },
          offerings: [
            {
              slug: "o4-mini-openai",
              provider: "openai",
              status: "ga",
              generation: "current",
              prices: { input: { amount: 1.25, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-05-01" } },
            },
          ],
        },
      },
    };
    const report = computeDrift(["openai/o4-mini"], [makeModel()], prior);
    assert.equal(report.priceDrift.length, 1);
    assert.equal(report.priceDrift[0]!.from?.amount, 1.25);
    assert.equal(report.priceDrift[0]!.to.amount, 1.1);
  });

  test("detects a lifecycle status change (deprecation)", () => {
    const prior: Snapshot = {
      captured_at: "2026-07-01T00:00:00Z",
      models: {
        "openai/o4-mini": {
          model_id: "openai/o4-mini",
          name: "o4-mini",
          capability_profile: { coding: "strong", reasoning: "strong" },
          offerings: [
            {
              slug: "o4-mini-openai",
              provider: "openai",
              status: "ga",
              generation: "current",
              prices: { input: { amount: 1.1, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-06-01" } },
            },
          ],
        },
      },
    };
    const deprecated = makeModel({
      offerings: [
        {
          slug: "o4-mini-openai",
          provider: "openai",
          model: { id: "openai/o4-mini", modality: "text-generation", status: "deprecated", generation: "current" },
          tiers: [
            {
              id: "input",
              pricing: [{ amount: 1.1, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-06-01" }],
            },
          ],
        },
      ],
    });
    const report = computeDrift(["openai/o4-mini"], [deprecated], prior);
    assert.equal(report.lifecycleDrift.length, 1);
    assert.equal(report.lifecycleDrift[0]!.from, "ga");
    assert.equal(report.lifecycleDrift[0]!.to, "deprecated");
  });

  test("detects a capability rating change", () => {
    const prior: Snapshot = {
      captured_at: "2026-07-01T00:00:00Z",
      models: {
        "openai/o4-mini": {
          model_id: "openai/o4-mini",
          name: "o4-mini",
          capability_profile: { coding: "good", reasoning: "strong" },
          offerings: [
            {
              slug: "o4-mini-openai",
              provider: "openai",
              status: "ga",
              generation: "current",
              prices: { input: { amount: 1.1, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-06-01" } },
            },
          ],
        },
      },
    };
    const report = computeDrift(["openai/o4-mini"], [makeModel()], prior); // makeModel() has coding: strong
    assert.equal(report.capabilityDrift.length, 1);
    assert.equal(report.capabilityDrift[0]!.from, "good");
    assert.equal(report.capabilityDrift[0]!.to, "strong");
  });

  test("reports no drift when nothing changed", () => {
    const prior: Snapshot = {
      captured_at: "2026-07-01T00:00:00Z",
      models: {
        "openai/o4-mini": {
          model_id: "openai/o4-mini",
          name: "o4-mini",
          capability_profile: { coding: "strong", reasoning: "strong" },
          offerings: [
            {
              slug: "o4-mini-openai",
              provider: "openai",
              status: "ga",
              generation: "current",
              prices: { input: { amount: 1.1, currency: "USD", unit: "per_1m_tokens_input", effective_from: "2026-06-01" } },
            },
          ],
        },
      },
    };
    const report = computeDrift(["openai/o4-mini"], [makeModel()], prior);
    assert.equal(report.priceDrift.length, 0);
    assert.equal(report.lifecycleDrift.length, 0);
    assert.equal(report.capabilityDrift.length, 0);
    assert.equal(report.notFound.length, 0);
  });
});

// ---------------------------------------------------------------------------
// requireStarterOrPro — the free-key rejection path
// ---------------------------------------------------------------------------

describe("requireStarterOrPro", () => {
  test("exits with a clear message when the key's tier is free", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({ ok: true, data: [{ keyId: "k1", tier: "free", status: "active" }] }),
        { status: 200 },
      ),
    );
    const exitMock = mock.method(process, "exit", ((): never => {
      throw new Error("__EXIT__");
    }) as never);
    const errorMock = mock.method(console, "error", () => {});

    try {
      await assert.rejects(() => requireStarterOrPro("mg_free_test"), /__EXIT__/);
      assert.equal(exitMock.mock.calls.length, 1);
      assert.equal(exitMock.mock.calls[0]!.arguments[0], 1);
      const message = errorMock.mock.calls[0]!.arguments[0] as string;
      assert.match(message, /requires a Starter or Pro/);
      assert.match(message, /Free/);
    } finally {
      fetchMock.mock.restore();
      exitMock.mock.restore();
      errorMock.mock.restore();
    }
  });

  test("does not exit when the key's tier is starter", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({ ok: true, data: [{ keyId: "k1", tier: "starter", status: "active" }] }),
        { status: 200 },
      ),
    );
    const exitMock = mock.method(process, "exit", (() => {}) as never);

    try {
      await requireStarterOrPro("mg_starter_test");
      assert.equal(exitMock.mock.calls.length, 0);
    } finally {
      fetchMock.mock.restore();
      exitMock.mock.restore();
    }
  });

  test("does not exit when the key's tier is pro", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({ ok: true, data: [{ keyId: "k1", tier: "pro", status: "active" }] }),
        { status: 200 },
      ),
    );
    const exitMock = mock.method(process, "exit", (() => {}) as never);

    try {
      await requireStarterOrPro("mg_pro_test");
      assert.equal(exitMock.mock.calls.length, 0);
    } finally {
      fetchMock.mock.restore();
      exitMock.mock.restore();
    }
  });
});
