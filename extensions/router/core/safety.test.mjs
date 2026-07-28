import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conservativeFeatures } from "./features.ts";
import {
  deriveSafetyPolicy,
  initialLifecycle,
  isLeaseLifecycle,
  lifecycleToolBlockReason,
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
    authorizedToolNames: ["bash"],
  };
}

describe("router safety policy", () => {
  it("distinguishes authorization, advisory, completion review, and ordinary review", () => {
    const base = conservativeFeatures("policy test");
    assert.equal(
      deriveSafetyPolicy({ ...base, risk: "critical", actionMode: "destructive", intent: "operate" }),
      "authorization_then_completion_review",
    );
    assert.equal(
      deriveSafetyPolicy({
        ...base,
        risk: "high",
        actionMode: "reversible_mutation",
        intent: "operate",
        workflowType: "incident_or_operations",
      }),
      "advisory_then_completion_review",
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

    const reordered = {
      ...actionPlan(),
      objective: actionPlan().objective,
    };
    assert.equal(safetyFingerprint(reordered), result.fingerprint);
  });

  it("rejects vague plans that do not identify an irreversible step", () => {
    const invalid = actionPlan();
    invalid.steps[0].potentiallyIrreversible = false;
    assert.match(validateActionPlan(invalid).errors.join("\n"), /potentially irreversible effect/);
  });

  it("rejects steps that act outside the declared targets", () => {
    const invalid = actionPlan();
    invalid.steps[0].target = "staging/keyring";
    assert.match(validateActionPlan(invalid).errors.join("\n"), /undeclared target: staging\/keyring/);
  });
});

describe("deterministic safety tool gate", () => {
  it("blocks mutation in preflight and advisory while allowing bounded inspection", () => {
    const preflight = initialLifecycle("authorization_then_completion_review", "task");
    assert.equal(lifecycleToolBlockReason(preflight, "read", { path: "README.md" }), undefined);
    assert.equal(lifecycleToolBlockReason(preflight, "bash", { command: "git diff --stat" }), undefined);
    assert.match(lifecycleToolBlockReason(preflight, "edit", { path: "README.md" }), /preflight/);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "git status; rm -rf out" }), /preflight/);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "git diff --output=/tmp/leak" }), /preflight/);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "find . -delete" }), /preflight/);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "find . -fprintf out %p" }), /preflight/);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "find . -fprint0 out" }), /preflight/);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "find . -fls out" }), /preflight/);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "find . -fprint out" }), /preflight/);
    assert.equal(lifecycleToolBlockReason(preflight, "bash", { command: "find . -name '*.ts'" }), undefined);
    assert.match(lifecycleToolBlockReason(preflight, "bash", { command: "rg --pre mutate pattern" }), /preflight/);
    assert.equal(lifecycleToolBlockReason(preflight, "submit_action_plan", {}), undefined);

    const validated = validateActionPlan(actionPlan());
    assert.equal(validated.success, true);
    const authorized = {
      phase: "authorized_execution",
      policy: "authorization_then_completion_review",
      taskFingerprint: "task",
      plan: {
        taskFingerprint: "task",
        planFingerprint: validated.fingerprint,
        submittedAt: "2026-07-28T00:00:00.000Z",
        plan: validated.plan,
      },
      authorization: {
        taskFingerprint: "task",
        planFingerprint: validated.fingerprint,
        reviewTaskId: "review",
        reviewerVendor: "anthropic",
        sessionId: "session",
        approvedAt: "2026-07-28T00:01:00.000Z",
      },
    };
    assert.equal(lifecycleToolBlockReason(authorized, "bash", { command: "deploy production" }), undefined);
    assert.match(lifecycleToolBlockReason(authorized, "custom_mutator", {}), /outside.*reviewed action plan/);
    assert.equal(isLeaseLifecycle(authorized), true);
    assert.equal(
      isLeaseLifecycle({
        ...authorized,
        authorization: { ...authorized.authorization, planFingerprint: "tampered" },
      }),
      false,
      "restoration must reject authorization not bound to the persisted plan",
    );

    const advisory = initialLifecycle("advisory_then_completion_review", "task");
    assert.match(lifecycleToolBlockReason(advisory, "custom_mutator", {}), /advisory/);
  });

  it("keeps generated reviews read-only except for the scoped verdict tool", () => {
    const review = {
      phase: "review",
      policy: "ordinary",
      taskFingerprint: "task",
      reviewKind: "authorization",
      scopeFingerprint: "a".repeat(64),
    };
    assert.equal(lifecycleToolBlockReason(review, "submit_safety_review", {}), undefined);
    assert.match(lifecycleToolBlockReason(review, "write", {}), /read-only/);
  });
});

describe("review verdict validation", () => {
  it("binds the kind and verdict to the exact reviewed scope", () => {
    const scope = "a".repeat(64);
    const valid = validateSafetyReview(
      {
        reviewKind: "authorization",
        scopeFingerprint: scope,
        verdict: "approve",
        summary: "The preconditions and abort points bound the risk.",
        evidence: ["Rollback was verified against the named target."],
        findings: [],
      },
      "authorization",
      scope,
    );
    assert.equal(valid.success, true);
    assert.match(
      validateSafetyReview(
        {
          reviewKind: "authorization",
          scopeFingerprint: "b".repeat(64),
          verdict: "pass",
          summary: "Wrong scope and verdict.",
          evidence: ["Mismatch."],
          findings: [],
        },
        "authorization",
        scope,
      ).errors.join("\n"),
      /scope fingerprint|invalid for authorization/,
    );
  });
});
