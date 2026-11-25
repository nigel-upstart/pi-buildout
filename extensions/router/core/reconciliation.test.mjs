import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { fastCheckOptions } from "../fast-check-options.mjs";
import { conservativeFeatures } from "./features.ts";
import {
  DEFAULT_SECONDARY_RECONCILIATION_POLICY,
  decideSecondaryCorrection,
  estimateCacheSwitchPenaltyUsd,
  reconciliationDelta,
} from "./reconciliation.ts";

const policy = {
  secondaryDeadlineMs: 60,
  materialCorrectionBenefitUsd: 0.02,
};

const sameArchetype = {
  incumbent: "median_repository_implementation",
  corrected: "median_repository_implementation",
};

function routeChoice(overrides = {}) {
  return {
    provider: "openai-codex",
    modelId: "gpt-6-sol",
    logicalModelId: "gpt-6-sol",
    vendor: "openai",
    effort: "high",
    ability: 3,
    profileId: "openai-gpt-6-agent-v1",
    contextWindow: 1_000_000,
    endpointTier: "manufacturer",
    rankReason: "bootstrap",
    ...overrides,
  };
}

function registryEntry(provider, modelId, costPerMillion) {
  return {
    provider,
    modelId,
    name: modelId,
    vendor: modelId.startsWith("claude-") ? "anthropic" : "openai",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    available: true,
    reasoning: true,
    supportedEfforts: ["medium", "high", "max"],
    inputTypes: ["text"],
    toolCapable: true,
    costPerMillion,
  };
}

function features(overrides = {}) {
  return {
    ...conservativeFeatures("fixture"),
    intent: "implement",
    workflowType: "coding_implementation",
    actionMode: "reversible_mutation",
    horizon: "single_pr",
    risk: "medium",
    ambiguity: "low",
    confidence: 0.95,
    taskContinuity: "new_task",
    independenceRequirement: "none",
    interactivity: "developer_loop",
    expectedAgentTurns: 3,
    expectedFilesRead: 4,
    expectedFilesChanged: 1,
    expectedToolOutputTokens: 2_000,
    verificationStrength: "unit_tests",
    decompositionRecommended: false,
    ...overrides,
  };
}

describe("secondary reconciliation policy", () => {
  it("defaults to a background deadline and one material correction benefit", () => {
    assert.deepEqual(DEFAULT_SECONDARY_RECONCILIATION_POLICY, {
      secondaryDeadlineMs: 15_000,
      materialCorrectionBenefitUsd: 0.02,
    });
    assert.equal(Object.isFrozen(DEFAULT_SECONDARY_RECONCILIATION_POLICY), true);
    assert.deepEqual(decideSecondaryCorrection({ material: true, reasons: ["effort_changed"] }, 0), {
      action: "accept",
      expectedBenefitUsd: 0.02,
    });
  });

  it("prices the corrected route's cache-miss penalty against the incumbent cache-read value", () => {
    const incumbent = routeChoice();
    const corrected = routeChoice({
      provider: "anthropic",
      modelId: "claude-opus-5-5",
      logicalModelId: "claude-opus-5-5",
      vendor: "anthropic",
      profileId: "anthropic-opus-5-stack-v1",
    });
    const registry = [
      registryEntry("openai-codex", "gpt-6-sol", { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }),
      registryEntry("anthropic", "claude-opus-5-5", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }),
    ];

    assert.ok(
      Math.abs(
        estimateCacheSwitchPenaltyUsd(
          { cachedTokens: 100_000, expectedReuseRatio: 0.5 },
          incumbent,
          corrected,
          registry,
        ) - 0.912_5,
      ) < Number.EPSILON,
    );
  });

  it("charges no cache-switch penalty when the correction keeps the incumbent endpoint", () => {
    const incumbent = routeChoice();
    // Same provider and model, e.g. an effort-only correction: the existing cache is preserved, so
    // pricing a fresh cache write here would reject a correction that costs nothing.
    const corrected = routeChoice({ effort: "max" });
    const registry = [
      registryEntry("openai-codex", "gpt-6-sol", { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }),
    ];

    assert.equal(
      estimateCacheSwitchPenaltyUsd({ cachedTokens: 100_000, expectedReuseRatio: 0.5 }, incumbent, corrected, registry),
      0,
    );
  });

  it("does not substitute the input rate when a corrected endpoint has no cache-write line item", () => {
    const incumbent = routeChoice();
    const corrected = routeChoice({ provider: "uncached", modelId: "uncached-model" });
    const registry = [
      registryEntry("openai-codex", "gpt-6-sol", { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }),
      registryEntry("uncached", "uncached-model", { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 }),
    ];

    assert.equal(
      estimateCacheSwitchPenaltyUsd({ cachedTokens: 100_000, expectedReuseRatio: 0.5 }, incumbent, corrected, registry),
      0,
    );
  });

  it("normalizes cache estimates and never charges a negative rate difference", () => {
    const incumbent = routeChoice();
    const corrected = routeChoice({ provider: "anthropic", modelId: "claude-opus-5-5" });
    fc.assert(
      fc.property(
        fc.integer({ min: -2_000_000, max: 2_000_000 }),
        fc.integer({ min: -100, max: 200 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (cachedTokens, reusePercent, cacheRead, cacheWrite) => {
          const cache = { cachedTokens, expectedReuseRatio: reusePercent / 100 };
          const registry = [
            registryEntry(incumbent.provider, incumbent.modelId, { cacheRead, cacheWrite: 0 }),
            registryEntry(corrected.provider, corrected.modelId, { cacheRead: 0, cacheWrite }),
          ];
          const expected =
            ((Math.max(0, cachedTokens) * Math.min(1, Math.max(0, cache.expectedReuseRatio))) / 1_000_000) *
            Math.max(0, cacheWrite - cacheRead);
          const penalty = estimateCacheSwitchPenaltyUsd(cache, incumbent, corrected, registry);
          assert.equal(penalty, expected);
          assert.equal(estimateCacheSwitchPenaltyUsd(cache, incumbent, incumbent, registry), 0);
        },
      ),
      fastCheckOptions,
    );
  });

  it("ignores non-finite cache estimates", () => {
    const incumbent = routeChoice();
    const corrected = routeChoice({ modelId: "other-model" });
    const registry = [registryEntry(corrected.provider, corrected.modelId, { cacheRead: 0, cacheWrite: 10 })];
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(
        estimateCacheSwitchPenaltyUsd({ cachedTokens: value, expectedReuseRatio: 1 }, incumbent, corrected, registry),
        0,
      );
      assert.equal(
        estimateCacheSwitchPenaltyUsd(
          { cachedTokens: 1_000_000, expectedReuseRatio: value },
          incumbent,
          corrected,
          registry,
        ),
        0,
      );
    }
  });

  it("rejects an unchanged route even without a cache penalty", () => {
    const delta = reconciliationDelta(features(), features(), routeChoice(), routeChoice(), sameArchetype);
    assert.deepEqual(delta, { material: false, reasons: [] });
    assert.deepEqual(decideSecondaryCorrection(delta, 0, policy), {
      action: "reject",
      reason: "no_material_delta",
      expectedBenefitUsd: 0,
    });
  });

  for (const [overrides, reason] of [
    [{ profileId: "other-profile" }, "prompt_profile_changed"],
    [{ logicalModelId: "other-model" }, "logical_model_changed"],
    [{ effort: "max" }, "effort_changed"],
    [{ ability: 4 }, "capability_band_changed"],
  ]) {
    it(`detects a material ${reason} correction`, () => {
      const delta = reconciliationDelta(features(), features(), routeChoice(), routeChoice(overrides), sameArchetype);
      assert.deepEqual(delta, { material: true, reasons: [reason] });
      assert.equal(decideSecondaryCorrection(delta, 0, policy).action, "accept");
    });
  }

  it("treats an archetype-only correction as material even on the same endpoint", () => {
    const delta = reconciliationDelta(features(), features(), routeChoice(), routeChoice(), {
      ...sameArchetype,
      corrected: "implementation_planning",
    });
    assert.deepEqual(delta, { material: true, reasons: ["archetype_changed"] });
    assert.equal(decideSecondaryCorrection(delta, 0, policy).action, "accept");
  });

  for (const [overrides, reason] of [
    [{ decompositionRecommended: true }, "decomposition_required"],
    [{ independenceRequirement: "different_vendor_review" }, "independence_changed"],
  ]) {
    it(`treats ${reason} alone as a material routing requirement change`, () => {
      const delta = reconciliationDelta(features(), features(overrides), routeChoice(), routeChoice(), sameArchetype);
      assert.deepEqual(delta, { material: true, reasons: [reason] });
      assert.equal(decideSecondaryCorrection(delta, 0, policy).action, "accept");
    });
  }

  it("preserves archetype and routing requirement changes as material deltas", () => {
    const delta = reconciliationDelta(
      features(),
      features({ decompositionRecommended: true, independenceRequirement: "different_vendor_review" }),
      routeChoice(),
      routeChoice(),
      { ...sameArchetype, corrected: "implementation_planning" },
    );
    assert.deepEqual(delta, {
      material: true,
      reasons: ["archetype_changed", "decomposition_required", "independence_changed"],
    });
    assert.deepEqual(decideSecondaryCorrection(delta, 0.03, policy), {
      action: "reject",
      reason: "cache_penalty_exceeds_benefit",
      expectedBenefitUsd: policy.materialCorrectionBenefitUsd,
    });
  });

  it("does not treat safety-only feature changes as routing corrections or boost their benefit", () => {
    fc.assert(
      fc.property(
        fc.record({
          risk: fc.constantFrom("low", "medium", "high", "critical"),
          actionMode: fc.constantFrom(
            "information_only",
            "local_read",
            "reversible_mutation",
            "external_side_effect",
            "destructive",
          ),
          verificationStrength: fc.constantFrom(
            "none",
            "self_check",
            "unit_tests",
            "integration_tests",
            "security_and_policy",
          ),
          reviewIntent: fc.boolean(),
        }),
        (overrides) => {
          const primary = features();
          const corrected = features(overrides);
          const unchanged = reconciliationDelta(primary, corrected, routeChoice(), routeChoice(), sameArchetype);
          assert.deepEqual(unchanged, { material: false, reasons: [] });
          assert.equal(decideSecondaryCorrection(unchanged, 0, policy).reason, "no_material_delta");
          const changed = reconciliationDelta(
            primary,
            corrected,
            routeChoice(),
            routeChoice({ effort: "max" }),
            sameArchetype,
          );
          assert.deepEqual(changed, { material: true, reasons: ["effort_changed"] });
          assert.deepEqual(decideSecondaryCorrection(changed, 0.03, policy), {
            action: "reject",
            reason: "cache_penalty_exceeds_benefit",
            expectedBenefitUsd: policy.materialCorrectionBenefitUsd,
          });
        },
      ),
      fastCheckOptions,
    );
  });

  it("accepts exactly when a material correction's benefit exceeds cache cost, regardless of background deadline", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 60_000 }),
        (material, benefitCents, penaltyCents, secondaryDeadlineMs) => {
          const delta = { material, reasons: material ? ["effort_changed"] : [] };
          const materialCorrectionBenefitUsd = benefitCents / 100;
          const penalty = penaltyCents / 100;
          const decision = decideSecondaryCorrection(delta, penalty, {
            secondaryDeadlineMs,
            materialCorrectionBenefitUsd,
          });
          assert.equal(decision.expectedBenefitUsd, material ? materialCorrectionBenefitUsd : 0);
          assert.equal(decision.action, material && benefitCents > penaltyCents ? "accept" : "reject");
          if (decision.action === "reject") {
            assert.equal(decision.reason, material ? "cache_penalty_exceeds_benefit" : "no_material_delta");
          }
          assert.equal(
            decideSecondaryCorrection(delta, materialCorrectionBenefitUsd, {
              ...policy,
              materialCorrectionBenefitUsd,
            }).action,
            "reject",
            "equal cache cost and benefit must not trigger a correction",
          );
        },
      ),
      fastCheckOptions,
    );
  });
});
