import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conservativeFeatures } from "./features.ts";
import {
  changeEffortWithinLease,
  createTaskLease,
  deterministicBoundaryGate,
  hasSignificantReusableCache,
  installLease,
  markManualOverride,
  resolveContinuity,
  setHardBoundary,
} from "./lease.ts";

function lease() {
  return createTaskLease({
    taskId: "task-1",
    startedAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    archetype: "median_repository_implementation",
    features: {
      ...conservativeFeatures(),
      intent: "implement",
      workflowType: "coding_implementation",
      actionMode: "reversible_mutation",
      horizon: "single_pr",
      risk: "medium",
      ambiguity: "low",
    },
    selected: {
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      vendor: "openai",
      effort: "medium",
      ability: 2,
      profileId: "openai-gpt-5.6-agent-v1",
      contextWindow: 372_000,
      rankReason: "bootstrap",
    },
    fallbacks: [],
    modelSnapshotId: "snapshot",
    policyVersion: "policy",
    lastPromptFingerprint: "abc",
  });
}

describe("task boundary gate", () => {
  it("never reevaluates on a non-user turn", () => {
    const active = lease();
    assert.deepEqual(
      deterministicBoundaryGate(
        { mode: "active", active, manualOverride: false },
        {
          isUserInput: false,
          source: "interactive",
          prompt: "new task",
          cachedTokens: 0,
          expectedReuseRatio: 0,
        },
      ),
      { action: "ignore", reason: "lease evaluation is user-turn-only" },
    );
  });

  it("forces the first user turn after every hard boundary to a new task", () => {
    const active = lease();
    for (const boundary of ["new_session", "post_compaction", "post_push", "subagent"]) {
      const state = setHardBoundary({ mode: "active", active, manualOverride: false }, boundary);
      const result = deterministicBoundaryGate(state, {
        isUserInput: true,
        source: "interactive",
        prompt: "continue",
        cachedTokens: 100_000,
        expectedReuseRatio: 1,
      });
      assert.equal(result.action, "new_task");
      assert.equal(result.hardBoundary, boundary);
    }
  });

  it("keeps extension and queued follow-up messages in the existing lease", () => {
    const active = lease();
    for (const input of [
      { source: "extension", streamingBehavior: undefined },
      { source: "interactive", streamingBehavior: "followUp" },
    ]) {
      const result = deterministicBoundaryGate(
        { mode: "active", active, manualOverride: false },
        {
          isUserInput: true,
          ...input,
          prompt: "Do something unrelated",
          cachedTokens: 0,
          expectedReuseRatio: 0,
        },
      );
      assert.equal(result.action, "continue");
      assert.equal(result.lease.taskId, active.taskId);
    }
  });

  it("continues only the anchored pure-acknowledgement allowlist unconditionally", () => {
    const active = lease();
    for (const prompt of [
      "Yes",
      "Yep",
      "Sure",
      "Ok",
      "Okay",
      "Go ahead.",
      "Proceed",
      "Continue",
      "Keep going",
      "Sounds good",
      "Please do",
      "Do it",
      "Go on",
      "Yes please!",
    ]) {
      const result = deterministicBoundaryGate(
        { mode: "active", active, manualOverride: false },
        {
          isUserInput: true,
          source: "interactive",
          prompt,
          cachedTokens: 0,
          expectedReuseRatio: 0,
        },
      );
      assert.equal(result.action, "continue", prompt);
      assert.equal(result.reason, "deterministic continuation signal", prompt);
    }
  });

  it("continues only tightly scoped same-task operational follow-ups", () => {
    const active = lease();
    const prompts = [
      "Commit whatever makes sense to commit.",
      "Please commit whatever makes sense.",
      "Re-run focused tests.",
      "Run the full checks.",
      "Run npm run check.",
      "Fix the remaining test failures.",
      "Address the actionable review findings.",
      "Fix CodeRabbit findings.",
      "Implement it.",
      "Fix it.",
      "Run the tests.",
      "Run it.",
      "Run them.",
      "Try again.",
    ];

    for (const prompt of prompts) {
      const result = deterministicBoundaryGate(
        { mode: "active", active, manualOverride: false },
        {
          isUserInput: true,
          source: "interactive",
          prompt,
          cachedTokens: 0,
          expectedReuseRatio: 0,
        },
      );
      assert.equal(result.action, "continue", prompt);
      assert.equal(result.reason, "obvious same-task operational follow-up", prompt);
      assert.equal(result.lease.taskId, active.taskId, prompt);
    }
  });

  it("classifies mutation-oriented operations under planning, review, and read-only leases", () => {
    const base = lease();
    const incompatibleLeases = [
      {
        ...base,
        archetype: "implementation_planning",
        features: {
          ...base.features,
          intent: "plan",
          workflowType: "implementation_planning",
          actionMode: "reversible_mutation",
        },
      },
      {
        ...base,
        archetype: "code_review",
        features: {
          ...base.features,
          intent: "review",
          workflowType: "code_review",
          actionMode: "reversible_mutation",
        },
      },
      {
        ...base,
        archetype: "median_repository_implementation",
        features: { ...base.features, actionMode: "local_read" },
      },
      {
        ...base,
        archetype: "median_repository_implementation",
        features: { ...base.features, actionMode: "information_only" },
      },
      {
        ...base,
        archetype: "terminal_heavy_implementation",
        features: {
          ...base.features,
          intent: "diagnose",
          workflowType: "research_or_analysis",
          actionMode: "reversible_mutation",
        },
      },
    ];
    const prompts = [
      "Fix the remaining test failures.",
      "Address the actionable review findings.",
      "Commit whatever makes sense to commit.",
      "Implement it.",
      "Fix it.",
      "Run the tests.",
      "Run it.",
      "Run them.",
      "Try again.",
    ];

    for (const active of incompatibleLeases) {
      for (const prompt of prompts) {
        const result = deterministicBoundaryGate(
          { mode: "active", active, manualOverride: false },
          {
            isUserInput: true,
            source: "interactive",
            prompt,
            cachedTokens: 100_000,
            expectedReuseRatio: 1,
          },
        );
        const expectedAction =
          active.archetype === "implementation_planning" && prompt === "Implement it."
            ? "new_task"
            : "classify_continuity";
        assert.equal(result.action, expectedAction, `${active.archetype}: ${prompt}`);
      }
    }
  });

  it("classifies topic-bearing additions and operational near misses", () => {
    const active = lease();
    const prompts = [
      "also adding a plugin by modifying the marketplace.json and plugin.json",
      'using gws CLI, let\'s update the Row "5" in the release tracker',
      "Commit whatever makes sense to commit, then add a plugin.",
      "Run the tests for the new plugin.",
      "Fix the remaining test failures in another repository.",
      "Address the review findings and plan the next feature.",
      "Please commit the marketplace.json plugin changes.",
      "Continue with a separate task.",
      "Sure, add a plugin.",
      "Go ahead with the plugin changes.",
      "Yes please, update the release tracker.",
      "Please do the other task.",
      "Add a plugin.",
    ];

    for (const prompt of prompts) {
      const result = deterministicBoundaryGate(
        { mode: "active", active, manualOverride: false },
        {
          isUserInput: true,
          source: "interactive",
          prompt,
          cachedTokens: 100_000,
          expectedReuseRatio: 1,
        },
      );
      assert.equal(result.action, "classify_continuity", prompt);
    }
  });

  it("applies hard boundaries and explicit discontinuity before operational follow-ups", () => {
    const active = lease();
    const input = {
      isUserInput: true,
      source: "interactive",
      prompt: "Commit whatever makes sense to commit.",
      cachedTokens: 100_000,
      expectedReuseRatio: 1,
    };

    const hardBoundary = deterministicBoundaryGate(
      setHardBoundary({ mode: "active", active, manualOverride: false }, "post_push"),
      input,
    );
    assert.equal(hardBoundary.action, "new_task");
    assert.equal(hardBoundary.hardBoundary, "post_push");

    const discontinuity = deterministicBoundaryGate(
      { mode: "active", active, manualOverride: false },
      { ...input, prompt: "New task: commit whatever makes sense to commit." },
    );
    assert.equal(discontinuity.action, "new_task");
    assert.equal(discontinuity.reason, "explicit semantic discontinuity");
  });

  it("lets strong discontinuity override cache but resists a marginal switch", () => {
    const active = lease();
    const marginal = resolveContinuity(
      active,
      {
        ...active.features,
        taskContinuity: "new_task",
        confidence: 0.82,
        ambiguity: "medium",
      },
      { cachedTokens: 20_000, expectedReuseRatio: 0.5 },
    );
    assert.equal(marginal.action, "continue");
    const strong = resolveContinuity(
      active,
      { ...active.features, taskContinuity: "strong_discontinuity" },
      { cachedTokens: 100_000, expectedReuseRatio: 1 },
    );
    assert.equal(strong.action, "new_task");
    assert.equal(hasSignificantReusableCache(19_999, 1), false);
  });

  it("starts implementation under a lease separate from planning", () => {
    const active = {
      ...lease(),
      archetype: "implementation_planning",
      features: { ...lease().features, intent: "plan", workflowType: "implementation_planning" },
    };
    for (const prompt of ["Implement the plan.", "Implement it.", "Start building PR one", "Now execute it"]) {
      const result = deterministicBoundaryGate(
        { mode: "active", active, manualOverride: false },
        {
          isUserInput: true,
          source: "interactive",
          prompt,
          cachedTokens: 100_000,
          expectedReuseRatio: 1,
        },
      );
      assert.equal(result.action, "new_task");
      assert.match(result.reason, /separate leases/);
    }
  });

  it("preserves manual selection without pinning semantic task continuity", () => {
    const active = lease();
    const overridden = markManualOverride({ mode: "active", active, manualOverride: false });
    const result = deterministicBoundaryGate(overridden, {
      isUserInput: true,
      source: "interactive",
      prompt: "Please inspect another file in this work",
      cachedTokens: 0,
      expectedReuseRatio: 0,
    });
    assert.equal(result.action, "classify_continuity");
    assert.match(result.reason, /manual.*semantic continuity/);
    assert.equal(result.lease.selected.modelId, active.selected.modelId);

    const continuation = deterministicBoundaryGate(overridden, {
      isUserInput: true,
      source: "interactive",
      prompt: "Continue",
      cachedTokens: 0,
      expectedReuseRatio: 0,
    });
    assert.equal(continuation.action, "continue");

    const installed = installLease(setHardBoundary(overridden, "new_session"), active);
    assert.equal(installed.manualOverride, false);
    assert.equal("pendingHardBoundary" in installed, false);
  });
});

describe("effort changes", () => {
  it("preserves task/model/profile identity inside a lease", () => {
    const active = lease();
    const changed = changeEffortWithinLease(active, "high", "2026-07-17T00:01:00.000Z");
    assert.equal(changed.success, true);
    assert.equal(changed.lease.taskId, active.taskId);
    assert.equal(changed.lease.selected.modelId, active.selected.modelId);
    assert.equal(changed.lease.promptProfileId, active.promptProfileId);
    assert.equal(changed.lease.selected.effort, "high");
  });
});
