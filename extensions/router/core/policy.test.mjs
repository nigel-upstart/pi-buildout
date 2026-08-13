import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOOTSTRAP_ROUTE_POLICIES, PEER_ARCHETYPES, reviewerRefs } from "./policy.ts";
import { authorizeEffort, disqualificationReason } from "./evidence.ts";
import { MODEL_VENDORS } from "./profiles.ts";

function reachableRefs() {
  return [
    ...Object.values(BOOTSTRAP_ROUTE_POLICIES).flatMap((policy) => [...policy.primary, ...policy.fallback]),
    // minimumAbility 1 makes every reviewer tier eligible, so this covers all of them.
    ...MODEL_VENDORS.flatMap((vendor) => reviewerRefs(vendor, 1)),
  ];
}

describe("policy ability table invariants", () => {
  // SPEC.md states: "Every archetype must keep at least one candidate above the lowest ability band so
  // high-consequence work stays routable." Nothing enforced it, so the invariant could only fail at
  // runtime, and it would fail as an unroutable decision rather than as an error.
  //
  // The failure is reachable. Consequence is derived from the task, not the archetype: `critical` risk
  // or a `destructive`/`external_side_effect` action mode raises any archetype to `irreversible`,
  // which bars the lowest ability band outright. fast_classification is also the fallback archetype in
  // core/archetype.ts, so a critical-risk task matching no other archetype lands there. An
  // all-band-1 ladder would therefore drop exactly the highest-consequence work.
  //
  // This asserts the invariant through authorizeEffort rather than by comparing band numbers, so it
  // tracks the real gate instead of a copy of it.
  it("keeps every archetype routable for irreversible consequence", () => {
    for (const [archetype, policy] of Object.entries(BOOTSTRAP_ROUTE_POLICIES)) {
      const firstAttemptRefs = [...policy.primary, ...policy.fallback].filter(
        // An escalation-only candidate cannot serve a first attempt, and an unmeasured peer is
        // confined to read-only consequence, so neither can rescue an otherwise unroutable ladder.
        (ref) => ref.escalationOnly !== true && ref.unmeasuredPeer !== true,
      );
      const authorized = firstAttemptRefs.filter(
        (ref) =>
          authorizeEffort(ref.logicalModelId, ref.effort, {
            allowSuperSaturation: policy.allowSuperSaturation,
            consequence: "irreversible",
          }).authorized,
      );
      assert.ok(
        authorized.length > 0,
        `${archetype} has no candidate authorized for irreversible consequence, so critical-risk work routed here would be unroutable. Candidates: ${firstAttemptRefs
          .map((ref) => `${ref.logicalModelId}@${ref.effort}(band ${String(ref.ability)})`)
          .join(", ")}`,
      );
    }
  });

  it("keeps every archetype routable for reversible consequence", () => {
    for (const [archetype, policy] of Object.entries(BOOTSTRAP_ROUTE_POLICIES)) {
      const authorized = [...policy.primary, ...policy.fallback]
        .filter((ref) => ref.escalationOnly !== true && ref.unmeasuredPeer !== true)
        .filter(
          (ref) =>
            authorizeEffort(ref.logicalModelId, ref.effort, {
              allowSuperSaturation: policy.allowSuperSaturation,
              consequence: "reversible",
            }).authorized,
        );
      assert.ok(authorized.length > 0, `${archetype} has no candidate authorized for reversible consequence`);
    }
  });

  it("never maps one (modelId, effort) pair to conflicting abilities", () => {
    const seen = new Map();
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
        assert.ok(allowed.has(archetype), `${ref.logicalModelId} is an unmeasured peer in ${archetype}`);
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
