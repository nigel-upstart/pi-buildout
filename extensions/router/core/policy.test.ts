import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOOTSTRAP_ROUTE_POLICIES, PEER_ARCHETYPES, reviewerRefs } from "./policy.ts";
import type { CandidateRef } from "./policy.ts";
import { disqualificationReason } from "./evidence.ts";
import type { AbilityTier } from "./evidence.ts";
import { MODEL_VENDORS } from "./profiles.ts";

function reachableRefs(): readonly CandidateRef[] {
  return [
    ...Object.values(BOOTSTRAP_ROUTE_POLICIES).flatMap((policy) => [...policy.primary, ...policy.fallback]),
    // minimumAbility 1 makes every reviewer tier eligible, so this covers all of them.
    ...MODEL_VENDORS.flatMap((vendor) => reviewerRefs(vendor, 1)),
  ];
}

describe("policy ability table invariants", () => {
  it("never maps one (modelId, effort) pair to conflicting abilities", () => {
    const seen = new Map<string, AbilityTier>();
    for (const ref of reachableRefs()) {
      const key = `${ref.logicalModelId}@${ref.effort}`;
      const known = seen.get(key);
      assert.ok(
        known === undefined || known === ref.ability,
        `${key} maps to conflicting abilities ${String(known)} and ${String(ref.ability)}`,
      );
      seen.set(key, ref.ability);
    }
  });

  it("confines unmeasured peers to the bounded read-only ladders at band 1", () => {
    const allowed = new Set(PEER_ARCHETYPES);
    for (const [archetype, policy] of Object.entries(BOOTSTRAP_ROUTE_POLICIES)) {
      for (const ref of [...policy.primary, ...policy.fallback]) {
        if (ref.unmeasuredPeer !== true) continue;
        assert.ok(allowed.has(policy.archetype), `${ref.logicalModelId} is an unmeasured peer in ${archetype}`);
        assert.equal(ref.ability, 1, `${ref.logicalModelId} must stay in the lowest band`);
        // A peer is an availability and price alternative, never the declared first attempt.
        assert.ok(!policy.primary.includes(ref), `${ref.logicalModelId} must not be the primary of ${archetype}`);
      }
    }
  });

  it("never names a model the evidence disqualifies", () => {
    for (const ref of reachableRefs()) {
      assert.equal(
        disqualificationReason(ref.logicalModelId),
        undefined,
        `${ref.logicalModelId} is disqualified by evidence but still reachable through policy`,
      );
    }
  });
});
