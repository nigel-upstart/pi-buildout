import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveFallback, validateFallbackTopology } from "./fallback.ts";
import { conservativeFeatures } from "./features.ts";
import { createTaskLease } from "./lease.ts";
import type { Archetype } from "./archetype.ts";
import type { RouteChoice } from "./routing.ts";
import type { ModelVendor } from "./profiles.ts";

// Every test provider used below is mapped to its real manufacturer vendor, so the fixture
// satisfies RouteChoice's ModelVendor constraint without changing any call site or assertion.
const PROVIDER_VENDORS: Readonly<Record<string, ModelVendor>> = {
  "openai-codex": "openai",
  openai: "openai",
  anthropic: "anthropic",
  bifrost: "anthropic",
  "google-vertex": "google",
  google: "google",
};

function vendorForProvider(provider: string): ModelVendor {
  const vendor = PROVIDER_VENDORS[provider];
  if (!vendor) throw new Error(`no test vendor mapping exists for provider ${provider}`);
  return vendor;
}

function choice(provider: string, modelId: string, profileId = `${provider}-profile`): RouteChoice {
  return {
    provider,
    modelId,
    logicalModelId: modelId,
    vendor: vendorForProvider(provider),
    effort: "high",
    ability: 3,
    profileId,
    contextWindow: 1_000_000,
    endpointTier: "manufacturer",
    rankReason: "bootstrap",
  };
}

function taskLease(archetype: Archetype, selected: RouteChoice, fallbacks: RouteChoice[]) {
  return createTaskLease({
    taskId: "task",
    startedAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    archetype,
    features: conservativeFeatures(),
    selected,
    fallbacks,
    modelSnapshotId: "snapshot",
    policyVersion: "policy",
    lastPromptFingerprint: "prompt",
  });
}

describe("ordinary fallback", () => {
  it("tries every authorized provider endpoint before restoring the previous selection", () => {
    const lease = taskLease(
      "median_repository_implementation",
      choice("openai-codex", "gpt-5.6-terra", "openai-gpt-5.6-agent-v1"),
      [
        choice("openai", "gpt-5.6-terra", "openai-gpt-5.6-agent-v1"),
        choice("anthropic", "claude-sonnet-5", "anthropic-claude-fast-agent-v1"),
        choice("bifrost", "bedrock/anthropic.claude-sonnet-5", "anthropic-claude-fast-agent-v1"),
      ],
    );
    assert.deepEqual(validateFallbackTopology(lease), []);
    const openai = resolveFallback(lease, "availability", "2026-07-17T00:01:00.000Z");
    assert.equal(openai.action, "use_choice");
    if (openai.action !== "use_choice") throw new Error("unreachable: asserted above");
    assert.equal(openai.choice.provider, "openai");
    const anthropic = resolveFallback(openai.lease, "availability", "2026-07-17T00:02:00.000Z");
    assert.equal(anthropic.action, "use_choice");
    if (anthropic.action !== "use_choice") throw new Error("unreachable: asserted above");
    assert.equal(anthropic.choice.provider, "anthropic");
    const bifrost = resolveFallback(anthropic.lease, "availability", "2026-07-17T00:03:00.000Z");
    assert.equal(bifrost.action, "use_choice");
    if (bifrost.action !== "use_choice") throw new Error("unreachable: asserted above");
    assert.equal(bifrost.choice.provider, "bifrost");
    const exhausted = resolveFallback(bifrost.lease, "availability", "2026-07-17T00:04:00.000Z");
    assert.equal(exhausted.action, "restore_previous");
    assert.match(exhausted.reason, /all authorized ordinary provider choices exhausted/);
  });
});

describe("review fallback", () => {
  it("keeps standalone review feature-routed and tracked-work review independent of its builder", () => {
    const standalone = taskLease(
      "code_review",
      choice("anthropic", "claude-sonnet-5", "anthropic-claude-fast-agent-v1"),
      [choice("google-vertex", "gemini-3.6-flash", "google-gemini-3.6-iterative-v1")],
    );
    assert.deepEqual(validateFallbackTopology(standalone), []);
    const standaloneFallback = resolveFallback(standalone, "availability", "2026-07-17T00:01:00.000Z");
    assert.equal(standaloneFallback.action, "use_choice");
    if (standaloneFallback.action !== "use_choice") throw new Error("unreachable: asserted above");
    const standaloneExhausted = resolveFallback(standaloneFallback.lease, "model_error", "2026-07-17T00:02:00.000Z");
    assert.equal(standaloneExhausted.action, "restore_previous");
    assert.match(standaloneExhausted.reason, /standalone review/);

    const parent = taskLease(
      "median_repository_implementation",
      choice("openai", "gpt-5.6-sol", "openai-gpt-5.6-agent-v1"),
      [choice("anthropic", "claude-opus-5", "anthropic-claude-planning-v1")],
    );
    const tracked = createTaskLease({
      taskId: "tracked-review",
      parentTaskId: parent.taskId,
      parentLease: parent,
      lifecycle: {
        phase: "review",
        policy: "ordinary",
        taskFingerprint: parent.lifecycle.taskFingerprint,
        reviewKind: "completion",
        scopeFingerprint: "a".repeat(64),
      },
      startedAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      archetype: "code_review",
      features: conservativeFeatures(),
      selected: choice("anthropic", "claude-opus-5", "anthropic-claude-planning-v1"),
      fallbacks: [choice("google", "gemini-3.6-flash", "google-gemini-3.6-iterative-v1")],
      modelSnapshotId: "snapshot",
      policyVersion: "policy",
      lastPromptFingerprint: "prompt",
    });
    assert.deepEqual(validateFallbackTopology(tracked), []);
    const secondIndependent = resolveFallback(tracked, "availability", "2026-07-17T00:01:00.000Z");
    assert.equal(secondIndependent.action, "use_choice");
    if (secondIndependent.action !== "use_choice") throw new Error("unreachable: asserted above");
    assert.equal(secondIndependent.reviewFellBackToBuilder, false);
    const exhausted = resolveFallback(secondIndependent.lease, "model_error", "2026-07-17T00:02:00.000Z");
    assert.equal(exhausted.action, "skip_review");
  });
});
