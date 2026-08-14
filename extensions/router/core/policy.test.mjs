import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOOTSTRAP_ROUTE_POLICIES, reviewerRefs } from "./policy.ts";
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
        // An escalation-only candidate cannot serve a first attempt, so it cannot rescue an otherwise
        // unroutable ladder.
        //
        // A candidate confined to read-only consequence cannot serve high-consequence work either, so
        // it must not count toward the floor. singleAttemptEvidence is such a flag; the earlier
        // unmeasuredPeer was another, removed with its only member.
        (ref) => ref.escalationOnly !== true && ref.singleAttemptEvidence !== true,
      );
      const authorized = firstAttemptRefs.filter(
        (ref) =>
          authorizeEffort(ref.logicalModelId, ref.effort, {
            allowSuperSaturation: policy.allowSuperSaturation,
            consequence: "irreversible",
          }).authorized,
      );
      // Two, not one. selectOrdinaryRoute returns unroutable unless it has a primary AND at least one
      // fallback, so a single surviving logical candidate only routes if that model happens to expose
      // two scoped endpoints on the machine in hand. Requiring two logical candidates keeps
      // safety-relevant routability independent of how an operator scoped their registry.
      //
      // This assertion was originally written as `> 0` and missed exactly that: cutting gpt-5.6-sol at
      // medium from fast_classification left claude-opus-5 at medium as the only survivor, and the
      // route became unroutable for critical-risk work while this test still passed.
      assert.ok(
        authorized.length >= 2,
        `${archetype} has ${String(authorized.length)} candidate(s) authorized for irreversible consequence and needs at least 2, so critical-risk work routed here would be unroutable. Candidates: ${firstAttemptRefs
          .map((ref) => `${ref.logicalModelId}@${ref.effort}(band ${String(ref.ability)})`)
          .join(", ")}`,
      );
    }
  });

  it("keeps every archetype routable for reversible consequence", () => {
    for (const [archetype, policy] of Object.entries(BOOTSTRAP_ROUTE_POLICIES)) {
      const authorized = [...policy.primary, ...policy.fallback]
        .filter((ref) => ref.escalationOnly !== true && ref.singleAttemptEvidence !== true)
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
