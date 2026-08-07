import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateProgramPlan } from "./planning.ts";

type PullRequestFixture = {
  id: string;
  title: string;
  goal: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  rollout: string;
  rollback: string;
  risks: string[];
  unknowns: string[];
};

type PlanFixture = {
  objective: string;
  assumptions: string[];
  unknowns: string[];
  pullRequests: PullRequestFixture[];
};

function assertDefined<T>(value: T | undefined, message = "expected value to be defined"): asserts value is T {
  assert.ok(value !== undefined, message);
}

function plan(): PlanFixture {
  return {
    objective: "Migrate the service without interrupting production traffic.",
    assumptions: ["Both storage formats can be read during migration."],
    unknowns: ["Peak dual-write throughput."],
    pullRequests: [
      {
        id: "schema",
        title: "Add the compatible schema",
        goal: "Introduce additive storage fields.",
        dependsOn: [],
        acceptanceCriteria: ["Old readers remain compatible."],
        rollout: "Apply the additive migration first.",
        rollback: "Remove unused additive fields after traffic is drained.",
        risks: ["Migration lock duration."],
        unknowns: [],
      },
      {
        id: "dual-write",
        title: "Dual-write both representations",
        goal: "Populate the new representation safely.",
        dependsOn: ["schema"],
        acceptanceCriteria: ["Both writes are verified in integration tests."],
        rollout: "Canary at one percent, then ramp.",
        rollback: "Disable the dual-write feature flag.",
        risks: ["Inconsistent partial writes."],
        unknowns: ["Required retry budget."],
      },
    ],
  };
}

describe("validateProgramPlan", () => {
  it("accepts a typed DAG and returns dependency-first order", () => {
    const result = validateProgramPlan(plan());
    assert.equal(result.success, true, result.errors.join("\n"));
    assert.deepEqual(result.topologicalOrder, ["schema", "dual-write"]);
  });

  it("rejects unknown dependencies, duplicates, self-dependencies, and cycles", () => {
    const unknownDeps = plan();
    const unknownDepsSecondPr = unknownDeps.pullRequests[1];
    assertDefined(unknownDepsSecondPr);
    unknownDepsSecondPr.dependsOn = ["missing", "missing"];
    assert.match(validateProgramPlan(unknownDeps).errors.join("\n"), /unknown pull request|repeats dependency/);

    const cyclic = plan();
    const cyclicFirstPr = cyclic.pullRequests[0];
    assertDefined(cyclicFirstPr);
    cyclicFirstPr.dependsOn = ["dual-write"];
    assert.match(validateProgramPlan(cyclic).errors.join("\n"), /dependency cycle/);

    const self = plan();
    const selfFirstPr = self.pullRequests[0];
    assertDefined(selfFirstPr);
    selfFirstPr.dependsOn = ["schema"];
    assert.match(validateProgramPlan(self).errors.join("\n"), /depends on itself/);

    const duplicate = plan();
    const duplicateSecondPr = duplicate.pullRequests[1];
    assertDefined(duplicateSecondPr);
    duplicateSecondPr.id = "schema";
    assert.match(validateProgramPlan(duplicate).errors.join("\n"), /duplicate pull request id/);
  });

  it("rejects plans without acceptance, rollout, or rollback contracts", () => {
    const invalid = plan();
    const invalidFirstPr = invalid.pullRequests[0];
    assertDefined(invalidFirstPr);
    invalidFirstPr.acceptanceCriteria = [];
    invalidFirstPr.rollout = "";
    invalidFirstPr.rollback = "";
    const result = validateProgramPlan(invalid);
    assert.equal(result.success, false);
    assert.ok(result.errors.length >= 3);
  });
});
