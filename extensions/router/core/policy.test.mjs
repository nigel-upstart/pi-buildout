import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOOTSTRAP_ROUTE_POLICIES, policyAbility, reviewerRefs } from "./policy.ts";

const VENDORS = ["openai", "anthropic", "google"];

function reachableRefs() {
  return [
    ...Object.values(BOOTSTRAP_ROUTE_POLICIES).flatMap((policy) => [...policy.primary, ...policy.fallback]),
    // minimumAbility 1 makes every reviewer tier eligible, so this covers all of them.
    ...VENDORS.flatMap((vendor) => reviewerRefs(vendor, 1)),
  ];
}

describe("policy ability table invariants", () => {
  it("resolves every reachable candidate ref through policyAbility", () => {
    const refs = reachableRefs();
    assert.ok(refs.length > 0);
    for (const ref of refs) {
      assert.equal(
        policyAbility(ref.modelId, ref.effort),
        ref.ability,
        `${ref.provider}/${ref.modelId}@${ref.effort} must resolve to its own policy ability`,
      );
    }
  });

  it("never maps one (modelId, effort) pair to conflicting abilities", () => {
    const seen = new Map();
    for (const ref of reachableRefs()) {
      const key = `${ref.modelId}@${ref.effort}`;
      const known = seen.get(key);
      assert.ok(
        known === undefined || known === ref.ability,
        `${key} maps to conflicting abilities ${String(known)} and ${String(ref.ability)}`,
      );
      seen.set(key, ref.ability);
    }
  });
});
