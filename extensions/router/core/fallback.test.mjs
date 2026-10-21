import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isProviderQuotaExhaustionError, resolveFallback, validateFallbackTopology } from "./fallback.ts";
import { conservativeFeatures } from "./features.ts";
import { createTaskLease } from "./lease.ts";

function choice(vendor, modelId, profileId = `${vendor}-profile`) {
  return {
    provider: vendor,
    modelId,
    vendor,
    effort: "high",
    ability: 3,
    profileId,
    contextWindow: 1_000_000,
    rankReason: "bootstrap",
  };
}

function taskLease(archetype, selected, fallbacks) {
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
      choice("openai-codex", "gpt-5.6-terra", "openai-gpt-6-agent-v1"),
      [
        choice("openai", "gpt-5.6-terra", "openai-gpt-6-agent-v1"),
        choice("anthropic", "claude-sonnet-5", "anthropic-claude-fast-agent-v1"),
        choice("bifrost", "bedrock/anthropic.claude-sonnet-5", "anthropic-claude-fast-agent-v1"),
      ],
    );
    assert.deepEqual(validateFallbackTopology(lease), []);
    const openai = resolveFallback(lease, "availability", "2026-07-17T00:01:00.000Z");
    assert.equal(openai.action, "use_choice");
    assert.equal(openai.choice.provider, "openai");
    const anthropic = resolveFallback(openai.lease, "availability", "2026-07-17T00:02:00.000Z");
    assert.equal(anthropic.action, "use_choice");
    assert.equal(anthropic.choice.provider, "anthropic");
    const bifrost = resolveFallback(anthropic.lease, "availability", "2026-07-17T00:03:00.000Z");
    assert.equal(bifrost.action, "use_choice");
    assert.equal(bifrost.choice.provider, "bifrost");
    const exhausted = resolveFallback(bifrost.lease, "availability", "2026-07-17T00:04:00.000Z");
    assert.equal(exhausted.action, "restore_previous");
    assert.match(exhausted.reason, /all authorized ordinary provider choices exhausted/);
  });

  it("fast-skips remaining exhausted provider candidates upon provider quota limit exhaustion", () => {
    const lease = taskLease(
      "deliberate_tool_workflow",
      choice("openai-codex", "gpt-5.6-sol", "openai-gpt-5.6-agent-v1"),
      [
        choice("openai-codex", "gpt-5.6-terra", "openai-gpt-5.6-agent-v1"),
        choice("openai-codex", "gpt-5.6-sol", "openai-gpt-5.6-agent-v1"),
        choice("openai-codex", "gpt-5.6-sol", "openai-gpt-5.6-agent-v1"),
        choice("anthropic", "claude-opus-5", "anthropic-claude-planning-v1"),
        choice("amazon-bedrock", "us.anthropic.claude-opus-5", "anthropic-claude-planning-v1"),
      ],
    );
    assert.equal(isProviderQuotaExhaustionError("Codex error: The usage limit has been reached"), true);
    assert.equal(isProviderQuotaExhaustionError("insufficient_quota"), true);
    assert.equal(isProviderQuotaExhaustionError("Monthly usage limit reached"), true);
    assert.equal(isProviderQuotaExhaustionError("Rate limit exceeded"), false);
    assert.equal(isProviderQuotaExhaustionError("429 quota exhaustion"), true);
    assert.equal(isProviderQuotaExhaustionError("Project quota has been exhausted"), true);
    // Gemini's transient per-minute 429 must keep same-provider fallback.
    assert.equal(isProviderQuotaExhaustionError("Resource has been exhausted (e.g. check quota)."), false);
    assert.equal(isProviderQuotaExhaustionError(undefined), false);

    // Initial failure on openai-codex skips all 3 remaining openai-codex fallbacks directly to anthropic
    const skipped = resolveFallback(lease, "model_error", "2026-07-17T00:01:00.000Z", {
      skipProvider: "openai-codex",
    });
    assert.equal(skipped.action, "use_choice");
    assert.equal(skipped.choice.provider, "anthropic");
    assert.equal(skipped.lease.attemptIndex, 1);
    assert.match(skipped.reason, /fast-skipped exhausted provider openai-codex/);

    // Next sequential fallback from anthropic proceeds normally to amazon-bedrock
    const next = resolveFallback(skipped.lease, "availability", "2026-07-17T00:02:00.000Z");
    assert.equal(next.action, "use_choice");
    assert.equal(next.choice.provider, "amazon-bedrock");
    assert.equal(next.lease.attemptIndex, 2);
  });

  it("removes exhausted providers across interleaved provider fallback chains", () => {
    const interleaved = taskLease(
      "deliberate_tool_workflow",
      choice("openai-codex", "gpt-5.6-sol", "openai-gpt-5.6-agent-v1"),
      [
        choice("anthropic", "claude-sonnet-5", "anthropic-claude-fast-agent-v1"),
        choice("openai-codex", "gpt-5.6-terra", "openai-gpt-5.6-agent-v1"),
        choice("amazon-bedrock", "us.anthropic.claude-opus-5", "anthropic-claude-planning-v1"),
      ],
    );
    // When openai-codex fails with quota exhaustion, it skips directly to anthropic and filters out
    // the subsequent openai-codex candidate so it is never revisited.
    const first = resolveFallback(interleaved, "model_error", "2026-07-17T00:01:00.000Z", {
      skipProvider: "openai-codex",
    });
    assert.equal(first.action, "use_choice");
    assert.equal(first.choice.provider, "anthropic");
    assert.equal(first.lease.attemptIndex, 1);
    assert.deepEqual(
      first.lease.fallbacks.map((c) => c.provider),
      ["anthropic", "amazon-bedrock"],
    );

    // If anthropic now fails on availability, the next candidate must be amazon-bedrock, not openai-codex
    const second = resolveFallback(first.lease, "availability", "2026-07-17T00:02:00.000Z");
    assert.equal(second.action, "use_choice");
    assert.equal(second.choice.provider, "amazon-bedrock");
    assert.equal(second.lease.attemptIndex, 2);
  });

  it("keeps already-attempted fallbacks in place when skipping a provider after an earlier fallback", () => {
    const lease = taskLease("deliberate_tool_workflow", choice("openai", "gpt-5.6-sol"), [
      choice("anthropic", "claude-sonnet-5"),
      choice("openai", "gpt-5.6-terra"),
      choice("anthropic", "claude-opus-5"),
      choice("amazon-bedrock", "us.anthropic.claude-opus-5"),
    ]);
    const first = resolveFallback(lease, "availability", "2026-07-17T00:01:00.000Z");
    assert.equal(first.choice.provider, "anthropic");
    assert.equal(first.lease.attemptIndex, 1);

    const skipped = resolveFallback(first.lease, "model_error", "2026-07-17T00:02:00.000Z", {
      skipProvider: "anthropic",
    });
    assert.equal(skipped.action, "use_choice");
    assert.equal(skipped.choice.provider, "openai");
    assert.equal(skipped.choice.modelId, "gpt-5.6-terra");
    assert.equal(skipped.lease.attemptIndex, 2);
    assert.deepEqual(
      skipped.lease.fallbacks.map((c) => `${c.provider}/${c.modelId}`),
      ["anthropic/claude-sonnet-5", "openai/gpt-5.6-terra", "amazon-bedrock/us.anthropic.claude-opus-5"],
    );

    const last = resolveFallback(skipped.lease, "availability", "2026-07-17T00:03:00.000Z");
    assert.equal(last.choice.provider, "amazon-bedrock");
    assert.equal(last.lease.attemptIndex, 3);
  });

  it("keeps a restorable topology when quota skipping removes every fallback", () => {
    const lease = taskLease("deliberate_tool_workflow", choice("openai-codex", "gpt-6-sol"), [
      choice("openai-codex", "gpt-5.6-terra"),
      choice("openai-codex", "gpt-6-luna"),
    ]);
    const exhausted = resolveFallback(lease, "model_error", "2026-07-17T00:01:00.000Z", {
      skipProvider: "openai-codex",
    });
    assert.equal(exhausted.action, "restore_previous");
    assert.deepEqual(exhausted.lease.fallbacks, lease.fallbacks);
    assert.deepEqual(validateFallbackTopology(exhausted.lease), []);
  });

  it("reaches a cross-provider fallback when the exhausted provider also owns the consumed prefix", () => {
    const lease = taskLease("deliberate_tool_workflow", choice("openai", "gpt-5.6-sol"), [
      choice("anthropic", "claude-sonnet-5"),
      choice("anthropic", "claude-opus-5"),
      choice("amazon-bedrock", "us.anthropic.claude-opus-5"),
    ]);
    const first = resolveFallback(lease, "availability", "2026-07-17T00:01:00.000Z");
    const skipped = resolveFallback(first.lease, "model_error", "2026-07-17T00:02:00.000Z", {
      skipProvider: "anthropic",
    });
    assert.equal(skipped.action, "use_choice");
    assert.equal(skipped.choice.provider, "amazon-bedrock");
    assert.equal(skipped.lease.attemptIndex, 2);
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
    const standaloneExhausted = resolveFallback(standaloneFallback.lease, "model_error", "2026-07-17T00:02:00.000Z");
    assert.equal(standaloneExhausted.action, "restore_previous");
    assert.match(standaloneExhausted.reason, /standalone review/);
  });
});
