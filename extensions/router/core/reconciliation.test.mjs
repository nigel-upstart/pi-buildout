import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conservativeFeatures } from "./features.ts";
import {
  chooseSecondaryGrace,
  decideSecondaryCorrection,
  estimateCacheSwitchPenaltyUsd,
  reconciliationDelta,
} from "./reconciliation.ts";

const policy = {
  maxGraceMs: 90,
  secondaryDeadlineMs: 60,
  lowPenaltyUsd: 0.001,
  mediumPenaltyUsd: 0.01,
  lowPenaltyGraceMs: 10,
  mediumPenaltyGraceMs: 30,
  highPenaltyGraceMs: 90,
  materialCorrectionBenefitUsd: 0.02,
  safetyCorrectionBenefitUsd: 25,
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
  it("chooses no grace when no reusable cache value is at risk", () => {
    const registry = [
      registryEntry("openai-codex", "gpt-6-sol", { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }),
      registryEntry("anthropic", "claude-opus-5-5", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }),
    ];

    const grace = chooseSecondaryGrace({ cachedTokens: 0, expectedReuseRatio: 0 }, routeChoice(), registry, policy);

    assert.deepEqual(grace, {
      graceMs: 0,
      expectedReusableTokens: 0,
      plausibleCacheMissPenaltyUsd: 0,
    });
  });

  it("caps cache-priced grace by both operator policy and the secondary deadline", () => {
    const registry = [
      registryEntry("openai-codex", "gpt-6-sol", { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }),
      registryEntry("anthropic", "claude-opus-5-5", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }),
    ];

    const grace = chooseSecondaryGrace(
      { cachedTokens: 1_000_000, expectedReuseRatio: 1 },
      routeChoice(),
      registry,
      policy,
    );

    assert.equal(grace.graceMs, 60);
    assert.equal(grace.expectedReusableTokens, 1_000_000);
    assert.ok(grace.plausibleCacheMissPenaltyUsd > policy.mediumPenaltyUsd);
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
    const corrected = routeChoice({ effort: "high" });
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

  it("accepts only material or safety-relevant corrections whose benefit exceeds cache cost", () => {
    const incumbent = routeChoice();
    const sameRoute = routeChoice();
    const newProfile = routeChoice({
      modelId: "claude-opus-5-5",
      logicalModelId: "claude-opus-5-5",
      vendor: "anthropic",
      profileId: "anthropic-opus-5-stack-v1",
    });

    const sameArchetype = {
      incumbent: "median_repository_implementation",
      corrected: "median_repository_implementation",
    };
    const none = reconciliationDelta(features(), features(), incumbent, sameRoute, sameArchetype);
    assert.equal(none.material, false);
    assert.equal(decideSecondaryCorrection(none, 0, policy).reason, "no_material_delta");

    const material = reconciliationDelta(features(), features(), incumbent, newProfile, sameArchetype);
    assert.deepEqual(material.reasons, ["prompt_profile_changed", "logical_model_changed"]);

    const archetypeOnly = reconciliationDelta(features(), features(), incumbent, sameRoute, {
      incumbent: "median_repository_implementation",
      corrected: "implementation_planning",
    });
    assert.equal(archetypeOnly.material, true);
    assert.equal(archetypeOnly.safetyRelevant, false);
    assert.deepEqual(archetypeOnly.reasons, ["archetype_changed"]);
    assert.equal(decideSecondaryCorrection(material, 0.03, policy).reason, "cache_penalty_exceeds_benefit");

    const safety = reconciliationDelta(
      features({ risk: "medium" }),
      features({
        risk: "critical",
        verificationStrength: "security_and_policy",
        independenceRequirement: "different_vendor_review",
      }),
      incumbent,
      sameRoute,
      sameArchetype,
    );
    assert.equal(safety.safetyRelevant, true);
    assert.equal(decideSecondaryCorrection(safety, 0.03, policy).action, "accept");
  });
});
