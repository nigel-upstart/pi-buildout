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
import type { BoundaryInput, HardBoundary, TaskLease } from "./lease.ts";

function lease(): TaskLease {
  return createTaskLease({
    taskId: "task-1",
    startedAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    archetype: "median_repository_implementation",
    features: {
      ...conservativeFeatures(),
      intent: "implement",
      workflowType: "coding_implementation",
      horizon: "single_pr",
      risk: "medium",
      ambiguity: "low",
    },
    selected: {
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      logicalModelId: "gpt-5.6-terra",
      vendor: "openai",
      effort: "medium",
      ability: 2,
      profileId: "openai-gpt-5.6-agent-v1",
      contextWindow: 372_000,
      endpointTier: "manufacturer",
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
    const boundaries: HardBoundary[] = ["new_session", "post_compaction", "post_push", "subagent"];
    for (const boundary of boundaries) {
      const state = setHardBoundary({ mode: "active", active, manualOverride: false }, boundary);
      const result = deterministicBoundaryGate(state, {
        isUserInput: true,
        source: "interactive",
        prompt: "continue",
        cachedTokens: 100_000,
        expectedReuseRatio: 1,
      });
      assert.equal(result.action, "new_task");
      if (result.action !== "new_task") throw new Error("unreachable: asserted above");
      assert.equal(result.hardBoundary, boundary);
    }
  });

  it("keeps extension and queued follow-up messages in the existing lease", () => {
    const active = lease();
    type PartialBoundarySource =
      Pick<BoundaryInput, "source"> | (Pick<BoundaryInput, "source"> & Pick<BoundaryInput, "streamingBehavior">);
    const inputs: PartialBoundarySource[] = [
      { source: "extension" },
      { source: "interactive", streamingBehavior: "followUp" },
    ];
    for (const input of inputs) {
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
      if (result.action !== "continue") throw new Error("unreachable: asserted above");
      assert.equal(result.lease.taskId, active.taskId);
    }
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
    const baseline = lease();
    const active: TaskLease = {
      ...baseline,
      archetype: "implementation_planning",
      features: { ...baseline.features, intent: "plan", workflowType: "implementation_planning" },
    };
    for (const prompt of ["Implement the plan.", "Start building PR one", "Now execute it"]) {
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
    if (!changed.success) throw new Error("unreachable: asserted above");
    assert.equal(changed.lease.taskId, active.taskId);
    assert.equal(changed.lease.selected.modelId, active.selected.modelId);
    assert.equal(changed.lease.promptProfileId, active.promptProfileId);
    assert.equal(changed.lease.selected.effort, "high");
  });
});
