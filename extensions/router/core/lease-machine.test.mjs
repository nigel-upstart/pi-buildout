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
    lifecycle: { phase: "planning", policy: "plan_review_then_completion_review", taskFingerprint: "task" },
  });
}

describe("XState lease owner", () => {
  it("ignores a redundant mode command without changing the task epoch", () => {
    const parent = lease();
    const owner = createLeaseOwner({ mode: "active", active: parent, manualOverride: false });
    const epoch = owner.epoch;
    owner.send({ type: "MODE", mode: "active" });
    assert.equal(owner.epoch, epoch);
    owner.send({ type: "INTENT" });
    assert.equal(owner.owns(parent, epoch), false);
  });

  it("keeps the installed lease's identity across mode changes unless an override is cleared", () => {
    const parent = lease();
    const owner = createLeaseOwner({ mode: "active", active: parent, manualOverride: false });
    for (const mode of ["shadow", "off", "active"]) {
      const epoch = owner.epoch;
      owner.send({ type: "MODE", mode });
      assert.equal(owner.state.active, parent, `${mode} must not replace the owner`);
      assert.equal(owner.owns(parent, epoch), false, "the epoch still revokes captured work");
    }
    owner.send({ type: "OVERRIDE" });
    const overridden = owner.state.active;
    assert.equal(overridden.manualOverride, true);
    owner.send({ type: "MODE", mode: "active" });
    assert.notEqual(owner.state.active, overridden, "re-enabling clears the override on a new lease value");
    assert.equal(owner.state.active.manualOverride, false);
  });

  it("keeps a pending hard boundary across same-family advances until ROUTE installs a fresh lease", () => {
    for (const type of ["EVIDENCE", "FALLBACK", "REPAIR", "PREPARE"]) {
      const parent = lease();
      const owner = createLeaseOwner({ mode: "active", active: parent, manualOverride: false });
      owner.send({ type: "BOUNDARY", boundary: "post_compaction" });
      const next = { ...parent, updatedAt: "2026-10-08" };
      assert.equal(owner.advance(type, next, parent, owner.epoch), true, type);
      assert.equal(owner.state.pendingHardBoundary, "post_compaction", `${type} must not consume the boundary`);
    }
    const parent = lease();
    const owner = createLeaseOwner({ mode: "active", active: parent, manualOverride: false });
    owner.send({ type: "BOUNDARY", boundary: "post_compaction" });
    const fresh = lease("fresh");
    assert.equal(owner.advance("ROUTE", fresh, parent, owner.epoch), true);
    assert.equal("pendingHardBoundary" in owner.state, false, "the freshly routed lease consumes the boundary");
  });

  it("rejects stale completions across arbitrary revocation boundaries", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.constantFrom("INTENT", "RESET", "MODE", "BOUNDARY", "OVERRIDE"),
        fc.constantFrom("FALLBACK", "RECONCILE"),
        async (scheduler, kind, type) => {
          const original = lease();
          const owner = createLeaseOwner({ mode: "active", active: original, manualOverride: false });
          const epoch = owner.epoch;
          const candidate = { ...original, attemptIndex: 1 };
          let revoked = false;
          const pending = scheduler.schedule(Promise.resolve(), "ledger/model completion").then(() => {
            const accepted = owner.advance(type, candidate, original, epoch);
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
          assert.equal(owner.advance(type, candidate, original, epoch), false);
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

  it("rejects stale RECONCILE and FALLBACK candidates racing to replace the same owner", async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async (scheduler) => {
        const original = lease();
        const owner = createLeaseOwner({ mode: "active", active: original, manualOverride: false });
        const epoch = owner.epoch;
        let installed;
        const pending = ["RECONCILE", "FALLBACK"].map((type) => {
          const candidate = { ...original, attemptIndex: type === "FALLBACK" ? 1 : 0 };
          return scheduler.schedule(Promise.resolve(), type).then(() => {
            const before = owner.state;
            const accepted = owner.advance(type, candidate, original, epoch);
            assert.equal(accepted, installed === undefined);
            if (accepted) installed = candidate;
            else assert.equal(owner.state, before, "a stale candidate must not overwrite the winning lease");
          });
        });
        await scheduler.waitAll();
        await Promise.all(pending);
        assert.equal(owner.state.active, installed);
        assert.equal(owner.epoch, epoch, "owner identity rejects the loser even without an epoch change");
      }),
      fastCheckOptions,
    );
  });

  it("keeps a cancellable secondary across review-family lifecycle progress", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("evidence", "repair", "fallback"), { maxLength: 20 }),
        async (changes) => {
          const owner = createLeaseOwner({ mode: "active", active: lease(), manualOverride: false });
          let signal;
          owner.send({
            type: "START_SECONDARY",
            owner: owner.state.active,
            input: {
              work: async (abortSignal) => {
                signal = abortSignal;
                await new Promise((resolve) => abortSignal.addEventListener("abort", resolve, { once: true }));
              },
            },
          });
          for (const change of changes) {
            const active = owner.state.active;
            assert.equal(
              owner.advance(
                change === "repair" ? "REPAIR" : change === "evidence" ? "EVIDENCE" : "FALLBACK",
                { ...active, attemptIndex: active.attemptIndex + 1 },
                active,
                owner.epoch,
              ),
              true,
            );
            assert.equal(signal.aborted, false);
          }
          owner.send({ type: "ABORT_SECONDARY" });
          assert.equal(signal.aborted, true);
          owner.send({ type: "RESET" });
          assert.equal(owner.state.active, undefined);
        },
      ),
      fastCheckOptions,
    );
  });

  it("cancels background work when its child or task family is replaced", () => {
    for (const change of ["START_SECONDARY", "ROUTE", "RESTORE", "RESET", "OVERRIDE"]) {
      const active = lease();
      const owner = createLeaseOwner({ mode: "active", active, manualOverride: false });
      let signal;
      owner.send({
        type: "START_SECONDARY",
        owner: active,
        input: {
          work: async (abortSignal) => {
            signal = abortSignal;
            await new Promise((resolve) => abortSignal.addEventListener("abort", resolve, { once: true }));
          },
        },
      });
      assert.equal(signal.aborted, false);
      if (change === "START_SECONDARY") {
        owner.send({ type: change, owner: active, input: { work: async () => {} } });
      } else if (change === "ROUTE") {
        assert.equal(owner.advance(change, lease("new-task"), active, owner.epoch), true);
      } else if (change === "RESTORE") {
        owner.send({
          type: change,
          state: { mode: "active", active: lease("restored"), manualOverride: false },
          owner: active,
          epoch: owner.epoch,
        });
      } else {
        owner.send({ type: change });
      }
      assert.equal(signal.aborted, true, change);
    }
  });

  it("rejects background work from a stale owner without cancelling the current child", () => {
    const active = lease();
    const owner = createLeaseOwner({ mode: "active", active, manualOverride: false });
    let signal;
    owner.send({
      type: "START_SECONDARY",
      owner: active,
      input: {
        work: async (abortSignal) => {
          signal = abortSignal;
          await new Promise((resolve) => abortSignal.addEventListener("abort", resolve, { once: true }));
        },
      },
    });
    let staleStarted = false;
    owner.send({
      type: "START_SECONDARY",
      owner: { ...active },
      input: {
        work: async () => {
          staleStarted = true;
        },
      },
    });
    assert.equal(staleStarted, false);
    assert.equal(signal.aborted, false);
    owner.send({ type: "ABORT_SECONDARY" });
    assert.equal(signal.aborted, true);
  });

  it("rejects out-of-phase transitions and mutation through nested snapshots", () => {
    const active = lease();
    const owner = createLeaseOwner({ mode: "active", active, manualOverride: false });
    const executing = { ...active, lifecycle: { ...active.lifecycle, phase: "executing" } };
    assert.equal(owner.advance("EVIDENCE", executing, active, owner.epoch), true);
    assert.equal(owner.advance("SUBMIT_PLAN", executing, executing, owner.epoch), false);
    assert.throws(() => {
      owner.state.active.lifecycle.phase = "executing";
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
