import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveFallback, validateFallbackTopology } from "./fallback.ts";
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

    // A tracked review holds one reviewer per eligible non-builder vendor, so the chain grows with the
    // supported vendor set. It used to be validated as "exactly one fallback" and "exactly two
    // vendors", which would have made a three-reviewer lease invalid, and isTaskLease discards an
    // invalid lease rather than repairing it, so tracked review would have failed to restore.
    const threeReviewers = createTaskLease({
      ...tracked,
      taskId: "tracked-review-long",
      fallbacks: [
        choice("google", "gemini-3.6-flash", "google-gemini-3.6-iterative-v1"),
        // A fourth supported vendor. The parent builder is openai, so anthropic, google and this are
        // all independent of it.
        { ...choice("amazon-bedrock", "kimi-k2.5", "moonshot-kimi-bounded-v1"), vendor: "moonshot" },
      ],
    });
    assert.deepEqual(
      validateFallbackTopology(threeReviewers),
      [],
      "a review chain longer than two must be valid, not discarded",
    );
    // Exhaustion still terminates and still preserves the parent rather than falling back to it.
    const longChainSecond = resolveFallback(threeReviewers, "availability", "2026-07-17T00:01:00.000Z");
    assert.equal(longChainSecond.action, "use_choice");
    assert.equal(longChainSecond.reviewFellBackToBuilder, false);
    const third = resolveFallback(longChainSecond.lease, "availability", "2026-07-17T00:02:00.000Z");
    assert.equal(third.action, "use_choice");
    assert.equal(third.reviewFellBackToBuilder, false);
    const longChainExhausted = resolveFallback(third.lease, "availability", "2026-07-17T00:03:00.000Z");
    assert.equal(longChainExhausted.action, "skip_review", "a longer chain must still terminate in skip_review");

    // The independence rules survive the length relaxation.
    const withBuilderVendor = createTaskLease({
      ...tracked,
      taskId: "tracked-review-builder-vendor",
      fallbacks: [
        choice("google", "gemini-3.6-flash", "google-gemini-3.6-iterative-v1"),
        // The parent builder is openai/gpt-5.6-sol, so this attempt is not independent.
        choice("openai", "gpt-5.6-sol", "openai-gpt-5.6-agent-v1"),
      ],
    });
    assert.ok(
      validateFallbackTopology(withBuilderVendor).some((error) => /must not include the builder's vendor/.test(error)),
      "an attempt sharing the builder's vendor must still be rejected at any chain length",
    );

    const duplicateVendor = createTaskLease({
      ...tracked,
      taskId: "tracked-review-duplicate-vendor",
      fallbacks: [
        choice("google", "gemini-3.6-flash", "google-gemini-3.6-iterative-v1"),
        choice("google", "gemini-2.5-pro", "google-gemini-2.5-iterative-v1"),
      ],
    });
    assert.ok(
      validateFallbackTopology(duplicateVendor).some((error) => /each come from a different vendor/.test(error)),
      "two attempts from one vendor are not two independent opinions",
    );

    const singleReviewer = createTaskLease({ ...tracked, taskId: "tracked-review-single", fallbacks: [] });
    assert.ok(
      validateFallbackTopology(singleReviewer).length > 0,
      "a single reviewer must still fail the independence floor",
    );
    const secondIndependent = resolveFallback(tracked, "availability", "2026-07-17T00:01:00.000Z");
    assert.equal(secondIndependent.action, "use_choice");
    assert.equal(secondIndependent.reviewFellBackToBuilder, false);
    const exhausted = resolveFallback(secondIndependent.lease, "model_error", "2026-07-17T00:02:00.000Z");
    assert.equal(exhausted.action, "skip_review");
  });
});
