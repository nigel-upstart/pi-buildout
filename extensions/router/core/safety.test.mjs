import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conservativeFeatures } from "./features.ts";
import {
  deriveSafetyPolicy,
  initialLifecycle,
  migrateLifecycle,
  isLeaseLifecycle,
  isPotentiallyMutatingTool,
  safetyContextForLifecycle,
  safetyFingerprint,
  validateActionPlan,
  validateSafetyReview,
} from "./safety.ts";

function actionPlan() {
  return {
    objective: "Rotate the production signing key without losing access.",
    targets: ["production/keyring"],
    assumptions: ["The old key remains valid during the overlap."],
    preconditions: ["A tested break-glass credential is available."],
    steps: [
      {
        id: "rotate",
        action: "Create and activate the replacement key, then revoke the old key.",
        target: "production/keyring",
        expectedEffect: "New signatures use the replacement key and the old credential stops working.",
        potentiallyIrreversible: true,
      },
    ],
    verification: ["Verify new signatures from two independent clients."],
    rollback: ["Reactivate the old key during the overlap window."],
    abortConditions: ["Stop if break-glass authentication fails."],
    toolNames: ["bash"],
  };
}

describe("router safety policy", () => {
  it("merges pre-action advice while preserving completion-only and ordinary policies", () => {
    const base = conservativeFeatures("policy test");
    assert.equal(
      deriveSafetyPolicy({ ...base, risk: "critical", actionMode: "destructive", intent: "operate" }),
      "plan_review_then_completion_review",
    );
    assert.equal(
      deriveSafetyPolicy({
        ...base,
        risk: "high",
        actionMode: "reversible_mutation",
        intent: "operate",
        workflowType: "incident_or_operations",
      }),
      "plan_review_then_completion_review",
    );
    assert.equal(
      deriveSafetyPolicy({
        ...base,
        risk: "high",
        actionMode: "reversible_mutation",
        intent: "implement",
        workflowType: "coding_implementation",
      }),
      "completion_review",
    );
    assert.equal(
      deriveSafetyPolicy({
        ...base,
        risk: "critical",
        actionMode: "external_side_effect",
        intent: "review",
        workflowType: "code_review",
      }),
      "ordinary",
      "standalone review is orthogonal to tracked-work safety lifecycles",
    );
    assert.equal(
      deriveSafetyPolicy({
        ...base,
        risk: "medium",
        actionMode: "external_side_effect",
        intent: "operate",
        interactivity: "autonomous",
        horizon: "program_unknown_size",
      }),
      "plan_review_then_completion_review",
      "an indefinite unattended external-effect loop is broad-impact even if the classifier understates risk",
    );
    assert.equal(
      deriveSafetyPolicy({ ...base, risk: "high", actionMode: "local_read", intent: "research" }),
      "ordinary",
    );
  });
});

describe("irreversible action plans", () => {
  it("validates concrete irreversible effects and fingerprints plans canonically", () => {
    const result = validateActionPlan(actionPlan());
    assert.equal(result.success, true, result.success ? "" : result.errors.join("\n"));
    assert.equal(result.fingerprint, safetyFingerprint(actionPlan()));
    assert.equal(result.fingerprint.length, 64);

    // Property insertion order must not change the fingerprint, so build the same plan with the
    // objective inserted last rather than first.
    const { objective, ...rest } = actionPlan();
    const reordered = { ...rest, objective };
    assert.notDeepEqual(Object.keys(reordered), Object.keys(actionPlan()), "the fixture must reorder properties");
    assert.equal(safetyFingerprint(reordered), result.fingerprint);
  });

  it("accepts reversible plans for the merged advisory policy", () => {
    const plan = actionPlan();
    plan.steps[0].potentiallyIrreversible = false;
    assert.equal(validateActionPlan(plan).success, true);
  });

  it("rejects steps that act outside the declared targets", () => {
    const invalid = actionPlan();
    invalid.steps[0].target = "staging/keyring";
    assert.match(validateActionPlan(invalid).errors.join("\n"), /undeclared target: staging\/keyring/);
  });
});

describe("canonical fingerprints", () => {
  it("orders object keys by UTF-16 code unit, independent of locale and insertion order", () => {
    // Canonically equivalent but distinct keys: localeCompare treats them as equal, so a stable sort kept
    // insertion order and reordering the object changed the fingerprint.
    const precomposedFirst = { "\u00e9": 1, "e\u0301": 2 };
    const decomposedFirst = { "e\u0301": 2, "\u00e9": 1 };
    assert.equal(safetyFingerprint(precomposedFirst), safetyFingerprint(decomposedFirst));
    // Code-unit order puts "B" (U+0042) before "a" (U+0061); a locale collation would not.
    assert.equal(safetyFingerprint({ a: 1, B: 2 }), createHash("sha256").update('{"B":2,"a":1}').digest("hex"));
  });
});

describe("advisory lifecycle", () => {
  it("migrates legacy discovery and authorization state to empty planning", () => {
    for (const phase of [
      "preflight",
      "discovery_ready",
      "authorized_execution",
      "completed",
      "advisory_pending",
      "ready_after_advisory",
    ]) {
      const migrated = migrateLifecycle({
        phase,
        policy: phase.includes("advisory") ? "advisory_then_completion_review" : "authorization_then_completion_review",
        taskFingerprint: "task",
        grant: { legacy: true },
        authorization: { legacy: true },
      });
      assert.deepEqual(migrated, initialLifecycle("plan_review_then_completion_review", "task"));
      assert.equal(isLeaseLifecycle(migrated), true);
    }
  });
  it("gives recommendations without grants", () => {
    const planning = initialLifecycle("plan_review_then_completion_review", "task");
    assert.match(safetyContextForLifecycle(planning), /submit_action_plan/);
    assert.match(safetyContextForLifecycle(planning), /recommendation, not a tool restriction/);
    const executing = { ...planning, phase: "executing" };
    assert.equal(isLeaseLifecycle(executing), true);
    assert.equal(executing.authorization, undefined);
    assert.equal(isLeaseLifecycle({ phase: "review", policy: "ordinary", taskFingerprint: "task" }), false);
  });
  it("validates plan advice against the current review scope", () => {
    const submission = {
      reviewKind: "plan",
      scopeFingerprint: "a".repeat(64),
      verdict: "approve",
      summary: "Advice",
      evidence: ["Inspected plan"],
      findings: [],
    };
    assert.equal(validateSafetyReview(submission, "plan", submission.scopeFingerprint).success, true);
    assert.equal(validateSafetyReview(submission, "plan", "b".repeat(64)).success, false);
    assert.equal(
      validateSafetyReview({ ...submission, verdict: "pass" }, "plan", submission.scopeFingerprint).success,
      false,
    );
  });
  it("retains mutation heuristics for evidence, not enforcement", () => {
    assert.equal(isPotentiallyMutatingTool("write", {}), true);
    assert.equal(isPotentiallyMutatingTool("read", {}), false);
    assert.equal(isPotentiallyMutatingTool("submit_action_plan", {}), false);
  });
});
