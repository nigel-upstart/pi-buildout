import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { fastCheckOptions } from "../fast-check-options.mjs";
import { conservativeFeatures } from "./features.ts";
import { createTaskLease } from "./lease.ts";
import { createLeaseOwner } from "./lease-machine.ts";

function lease(taskId = "parent") {
  return createTaskLease({
    taskId,
    startedAt: "2026-10-07",
    updatedAt: "2026-10-07",
    archetype: "median_repository_implementation",
    features: conservativeFeatures(),
    selected: {
      provider: "openai-codex",
      modelId: "gpt-6-sol",
      vendor: "openai",
      effort: "high",
      ability: 3,
      profileId: "openai-gpt-6-agent-v1",
      contextWindow: 1_000_000,
      rankReason: "fixture",
    },
    fallbacks: [],
    modelSnapshotId: "snapshot",
    policyVersion: "fixture",
    lastPromptFingerprint: "prompt",
    lifecycle: { phase: "preflight", policy: "authorization_then_completion_review", taskFingerprint: "task" },
  });
}

describe("XState lease owner", () => {
  it("rejects stale completions across arbitrary revocation boundaries", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.constantFrom("INTENT", "RESET", "MODE", "BOUNDARY", "OVERRIDE"),
        async (scheduler, kind) => {
          const original = lease();
          const owner = createLeaseOwner({ mode: "active", active: original, manualOverride: false });
          const epoch = owner.epoch;
          const candidate = { ...original, attemptIndex: 1 };
          let revoked = false;
          const pending = scheduler.schedule(Promise.resolve(), "ledger/model completion").then(() => {
            const accepted = owner.advance("FALLBACK", candidate, original, epoch);
            assert.equal(accepted, !revoked);
          });
          const revocation = scheduler.schedule(Promise.resolve(), "revocation").then(() => {
            revoked = true;
            owner.send(
              kind === "MODE"
                ? { type: kind, mode: "off" }
                : kind === "BOUNDARY"
                  ? { type: kind, boundary: "post_compaction" }
                  : { type: kind },
            );
          });
          await scheduler.waitAll();
          await Promise.all([pending, revocation]);
          assert.equal(owner.advance("FALLBACK", candidate, original, epoch), false);
          const revokedState = owner.state;
          owner.send({
            type: "RESTORE",
            state: { mode: "active", active: original, manualOverride: false },
            owner: original,
            epoch,
          });
          assert.equal(owner.state, revokedState, "an async restore must not supersede a revocation");
        },
      ),
      fastCheckOptions,
    );
  });

  it("keeps a cancellable secondary and its latch across review-family lifecycle progress", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("review", "repair", "fallback"), { maxLength: 20 }),
        async (changes) => {
          const owner = createLeaseOwner({ mode: "active", active: lease(), manualOverride: false });
          const key = {};
          let signal;
          owner.send({
            type: "START_SECONDARY",
            owner: owner.state.active,
            input: {
              key,
              gated: true,
              work: async (abortSignal) => {
                signal = abortSignal;
                await new Promise((resolve) => abortSignal.addEventListener("abort", resolve, { once: true }));
              },
            },
          });
          for (const change of changes) {
            const active = owner.state.active;
            if (change === "review") {
              const child = {
                ...active,
                taskId: "review",
                parentTaskId: active.taskId,
                parentLease: active,
                lifecycle: {
                  phase: "review",
                  policy: "ordinary",
                  taskFingerprint: "task",
                  reviewKind: "authorization",
                  scopeFingerprint: "scope",
                },
              };
              assert.equal(owner.advance("REVIEW_STARTED", child, active, owner.epoch), true);
              owner.settleSecondary(key, false);
              assert.equal(owner.advance("REVIEW_FINISHED", { ...active }, child, owner.epoch), true);
            } else {
              assert.equal(
                owner.advance(
                  change === "repair" ? "REPAIR" : "FALLBACK",
                  { ...active, attemptIndex: active.attemptIndex + 1 },
                  active,
                  owner.epoch,
                ),
                true,
              );
            }
            assert.equal(owner.secondaryGated, true);
            assert.equal(signal.aborted, false);
          }
          owner.send({ type: "ABORT_SECONDARY", retain: true });
          assert.equal(signal.aborted, true);
          assert.equal(owner.secondaryGated, true);
          owner.send({ type: "RESET" });
          assert.equal(owner.secondaryGated, false);
          owner.settleSecondary(key, true);
          assert.equal(owner.state.active, undefined);
        },
      ),
      fastCheckOptions,
    );
  });

  it("restores an unresolved safety question and ignores late settlements from replaced actors", () => {
    const owner = createLeaseOwner({
      mode: "active",
      active: lease(),
      manualOverride: false,
      secondarySafetyPending: true,
    });
    assert.equal(owner.secondaryGated, true);
    owner.send({ type: "ABORT_SECONDARY", retain: true });
    assert.equal(owner.secondaryGated, true);
    const key = {};
    owner.send({
      type: "START_SECONDARY",
      owner: owner.state.active,
      input: { key, gated: true, work: async () => {} },
    });
    owner.settleSecondary({}, true);
    assert.equal(owner.secondaryGated, true);
    owner.settleSecondary(key, true);
    assert.equal(owner.secondaryGated, false);
  });

  it("rejects out-of-phase transitions and mutation through nested snapshots", () => {
    const active = lease();
    const owner = createLeaseOwner({ mode: "active", active, manualOverride: false });
    assert.equal(owner.advance("SUBMIT_REVIEW", active, active, owner.epoch), false);
    assert.equal(owner.advance("SPEND_DISCOVERY", active, active, owner.epoch), false);
    assert.throws(() => {
      owner.state.active.lifecycle.phase = "discovery_ready";
    }, TypeError);
    assert.throws(() => {
      owner.state.active.safetyEvidence.checks.push({});
    }, TypeError);
    const shallow = createLeaseOwner({
      mode: "active",
      active: Object.freeze(lease("shallow")),
      manualOverride: false,
    });
    assert.throws(() => {
      shallow.state.active.features.confidence = 1;
    }, TypeError);
  });
});
