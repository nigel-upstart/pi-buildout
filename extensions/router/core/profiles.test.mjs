import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BOOTSTRAP_ROUTE_POLICIES, HARD_TASK_ESCALATION_REFS, MODEL_VENDOR } from "./policy.ts";
import { ARCHETYPES } from "./archetype.ts";
import { EFFORT_LEVELS, findPromptProfile, PROMPT_PROFILES } from "./profiles.ts";
import { canonicalModelId } from "./scope.ts";
import { canonicalVendor } from "./routing.ts";

/**
 * A captured survey of the registry spellings a configured machine exposes, checked in on purpose.
 * Reading the live `@earendil-works/pi-ai` catalog here would make these assertions drift on any
 * dependency bump, and the pinned devDependency does not carry the same set of models as the runtime
 * registry, so a live read is ambiguous as well as unstable.
 */
const REGISTRY_SPELLINGS = JSON.parse(
  readFileSync(new URL("./fixtures/registry-spellings.json", import.meta.url), "utf8"),
);

/** Every (archetype, logical model, effort) triple the bootstrap policy is able to name. */
function policyNamedTriples() {
  const triples = [];
  for (const policy of Object.values(BOOTSTRAP_ROUTE_POLICIES)) {
    for (const ref of [...policy.primary, ...policy.fallback]) {
      triples.push({ archetype: policy.archetype, logicalModelId: ref.logicalModelId, effort: ref.effort });
    }
    if (policy.pinnedPrimary) {
      triples.push({
        archetype: policy.archetype,
        logicalModelId: policy.pinnedPrimary.logicalModelId,
        effort: policy.pinnedPrimary.effort,
      });
    }
    for (const ref of HARD_TASK_ESCALATION_REFS) {
      triples.push({ archetype: policy.archetype, logicalModelId: ref.logicalModelId, effort: ref.effort });
    }
  }
  return triples;
}

/** Fixture endpoints grouped by the logical model their spelling canonicalizes to. */
function spellingsByLogicalModel() {
  const groups = new Map();
  for (const endpoint of REGISTRY_SPELLINGS) {
    const logical = canonicalModelId(endpoint.modelId);
    if (!groups.has(logical)) groups.set(logical, []);
    groups.get(logical).push(endpoint);
  }
  return groups;
}

describe("prompt profile eligibility is declared in canonical logical model IDs", () => {
  it("declares no provider-specific registry spelling in any profile", () => {
    for (const profile of PROMPT_PROFILES) {
      for (const modelId of profile.modelIds) {
        assert.equal(
          modelId,
          canonicalModelId(modelId),
          `${profile.id} declares the non-canonical spelling ${modelId}`,
        );
      }
    }
  });

  it("covers every policy-named logical model in the checked-in registry fixture", () => {
    const covered = spellingsByLogicalModel();
    for (const logicalModelId of Object.keys(MODEL_VENDOR)) {
      assert.ok(
        covered.has(logicalModelId),
        `the registry fixture has no spelling for policy-named model ${logicalModelId}`,
      );
    }
  });

  it("resolves the same profile for every registry spelling of a policy-named triple", () => {
    const groups = spellingsByLogicalModel();
    let asserted = 0;
    for (const { archetype, logicalModelId, effort } of policyNamedTriples()) {
      const vendor = MODEL_VENDOR[logicalModelId];
      assert.ok(vendor, `no vendor is declared for ${logicalModelId}`);
      const canonicalProfile = findPromptProfile(vendor, logicalModelId, archetype, effort);
      assert.ok(canonicalProfile, `no ${archetype}/${effort} profile resolves for policy-named ${logicalModelId}`);
      for (const endpoint of groups.get(logicalModelId) ?? []) {
        assert.equal(
          findPromptProfile(vendor, endpoint.modelId, archetype, effort)?.id,
          canonicalProfile.id,
          `${endpoint.provider}/${endpoint.modelId} resolves a different profile than ${logicalModelId} for ${archetype}/${effort}`,
        );
        asserted += 1;
      }
    }
    assert.ok(asserted > 0, "the fixture produced no spelling assertions at all");
  });

  it("leaves no policy-named fixture endpoint without any resolvable profile", () => {
    // The defect this replaces: eligibility matched an exact registry ID while resolveEndpoints
    // grouped endpoints by canonical ID, so 23 of these 60 endpoints were excluded as
    // profile_missing, 22 of them amazon-bedrock. Canonical matching is strictly additive, so the
    // expected count is now zero.
    const named = [];
    const unroutable = [];
    for (const endpoint of REGISTRY_SPELLINGS) {
      const logical = canonicalModelId(endpoint.modelId);
      const vendor = MODEL_VENDOR[logical];
      if (!vendor) continue;
      named.push(endpoint);
      const resolvable = ARCHETYPES.some((archetype) =>
        EFFORT_LEVELS.some((effort) => findPromptProfile(vendor, endpoint.modelId, archetype, effort)),
      );
      if (!resolvable) unroutable.push(`${endpoint.provider}/${endpoint.modelId}`);
    }
    // 50: cutting gpt-5.4-mini removed its three fixture spellings (openai, openai-codex and
    // github-copilot) from the policy-named set, taking 52 to 49; declaring minimax-m2.5 adds back the
    // one Bedrock spelling that canonicalizes to it. minimax.minimax-m2 and minimax.minimax-m2.1 are in
    // the fixture but are not policy-named, so they are correctly skipped.
    assert.equal(named.length, 50, "the registry fixture no longer describes the surveyed policy endpoint set");
    assert.deepEqual(unroutable, [], "policy-named endpoints resolve no profile and would be excluded");
  });

  it("resolves a profile for the configured Bifrost gateway spelling of Sonnet 5", () => {
    // decisions.md records bifrost/bedrock/anthropic.claude-sonnet-5 as a deliberate Sonnet 5
    // availability alternative, not an exclusion, so it must stay eligible after canonicalization.
    assert.equal(canonicalModelId("bedrock/anthropic.claude-sonnet-5"), "claude-sonnet-5");
    assert.ok(
      findPromptProfile("anthropic", "bedrock/anthropic.claude-sonnet-5", "median_repository_implementation", "medium"),
    );
  });
});

describe("canonical eligibility does not over-admit", () => {
  it("resolves neither a vendor nor a profile for an unrelated regional ID", () => {
    assert.equal(canonicalVendor("amazon-bedrock", "us.gov-cloud-widget-1"), undefined);
    // scope.ts strips the region prefix unconditionally; the result is still nobody's model.
    assert.equal(canonicalModelId("us.gov-cloud-widget-1"), "gov-cloud-widget-1");
    assert.equal(MODEL_VENDOR[canonicalModelId("us.gov-cloud-widget-1")], undefined);
    for (const vendor of ["anthropic", "openai", "google"]) {
      assert.equal(
        findPromptProfile(vendor, "us.gov-cloud-widget-1", "median_repository_implementation", "medium"),
        undefined,
      );
    }
  });

  it("does not let a different model inherit a neighbour's profile", () => {
    assert.equal(MODEL_VENDOR["claude-opus-4-8"], undefined);
    for (const spelling of [
      "claude-opus-4-8",
      "claude-opus-4.8",
      "eu.anthropic.claude-opus-4-8",
      "anthropic.claude-opus-4-8",
    ]) {
      assert.equal(
        findPromptProfile("anthropic", spelling, "implementation_planning", "high"),
        undefined,
        `${spelling} retained the removed previous-generation planning profile`,
      );
    }

    // claude-opus-4-7 sits between two admitted models and is named by no profile.
    assert.equal(MODEL_VENDOR["claude-opus-4-7"], undefined);
    for (const spelling of [
      "claude-opus-4-7",
      "claude-opus-4.7",
      "us.anthropic.claude-opus-4-7-v1",
      "anthropic.claude-opus-4-7",
    ]) {
      assert.equal(
        findPromptProfile("anthropic", spelling, "implementation_planning", "high"),
        undefined,
        `${spelling} inherited a neighbouring model's profile`,
      );
    }
    // A model on nobody's ladder stays ineligible however it is spelled.
    assert.equal(findPromptProfile("anthropic", "us.amazon.nova-lite-v1:0", "fast_classification", "low"), undefined);
  });

  it("keeps distinct policy-named models on distinct logical IDs", () => {
    const logical = Object.keys(MODEL_VENDOR).map(canonicalModelId);
    assert.equal(new Set(logical).size, logical.length, "two policy-named models collapse to one logical ID");
    // The spellings that previously needed hand-listing must not merge separate generations.
    const pairs = [
      ["anthropic.claude-opus-5", "anthropic.claude-sonnet-5"],
      ["openai.gpt-5.6-luna", "openai.gpt-5.6-terra"],
      ["claude-haiku-4.5", "claude-sonnet-5"],
    ];
    for (const [left, right] of pairs) {
      assert.notEqual(
        canonicalModelId(left),
        canonicalModelId(right),
        `${left} and ${right} collapsed to the same logical ID`,
      );
    }
    // Distinct logical IDs must also not share an identity through the profile lookup.
    assert.notEqual(
      findPromptProfile("anthropic", "us.anthropic.claude-opus-4-6-v1", "median_repository_implementation", "medium")
        ?.id,
      findPromptProfile("anthropic", "anthropic.claude-opus-5", "median_repository_implementation", "medium")?.id,
    );
  });
});

describe("the scoped MiniMax rung is declared but not yet routable", () => {
  // P5 supplies vendor identity and a bounded prompt profile. It deliberately supplies no policy
  // candidate, so nothing routes here. These assertions pin that boundary in both directions: the
  // plumbing works, and the model is still unreachable.
  it("resolves a vendor for every reachable MiniMax spelling", () => {
    // buildRegistrySnapshot drops any endpoint whose vendor is unknown, and a dropped endpoint is
    // invisible rather than excluded with a reason, so an unresolved vendor is the quietest failure.
    for (const modelId of ["minimax.minimax-m2.5", "minimax.minimax-m2", "minimax.minimax-m2.1"]) {
      assert.equal(canonicalVendor("amazon-bedrock", modelId), "minimax", modelId);
    }
    // Bedrock repeats the brand as both vendor segment and model token; the bare form has only one.
    assert.equal(canonicalVendor("amazon-bedrock", "minimax-m2.5"), "minimax");
    assert.equal(canonicalModelId("minimax.minimax-m2.5"), "minimax-m2.5");
  });

  it("resolves the same bounded profile for the logical ID and the Bedrock spelling", () => {
    for (const archetype of ["fast_classification", "exact_extraction"]) {
      const viaLogical = findPromptProfile("minimax", "minimax-m2.5", archetype, "low");
      assert.equal(viaLogical?.id, "minimax-m2.5-bounded-v1", `${archetype} via logical ID`);
      assert.equal(
        findPromptProfile("minimax", "minimax.minimax-m2.5", archetype, "low")?.id,
        viaLogical?.id,
        `${archetype} via the amazon-bedrock spelling`,
      );
    }
  });

  it("confines the profile to bounded read-only archetypes and the efforts the endpoint exposes", () => {
    const profile = PROMPT_PROFILES.find((entry) => entry.id === "minimax-m2.5-bounded-v1");
    assert.ok(profile);
    assert.deepEqual([...profile.archetypes].sort(), ["exact_extraction", "fast_classification"]);
    // Nothing above `high` exists on the endpoint, so the profile must not offer it.
    for (const effort of ["xhigh", "max"]) {
      assert.ok(!profile.efforts.includes(effort), `profile offers ${effort}, which the endpoint lacks`);
      assert.equal(findPromptProfile("minimax", "minimax-m2.5", "fast_classification", effort), undefined);
    }
    // And it must not resolve for work it has no evidence for.
    for (const archetype of ["median_repository_implementation", "code_review", "implementation_planning"]) {
      assert.equal(findPromptProfile("minimax", "minimax-m2.5", archetype, "low"), undefined, archetype);
    }
  });

  it("gives the refused scoped models no profile at all", () => {
    // GLM-5, DeepSeek V3.2, Kimi and Grok were each refused on a recorded axis, so each must stay
    // structurally ineligible rather than merely unlisted in a ladder.
    for (const modelId of ["glm-5", "deepseek-v3.2", "kimi-k2.5", "kimi-k2-thinking", "grok-4.3"]) {
      for (const vendor of ["minimax", "openai", "anthropic", "google"]) {
        for (const archetype of ARCHETYPES) {
          for (const effort of EFFORT_LEVELS) {
            assert.equal(findPromptProfile(vendor, modelId, archetype, effort), undefined, `${vendor}/${modelId}`);
          }
        }
      }
    }
  });

  it("names no MiniMax candidate in any ladder, so it cannot be routed yet", () => {
    const named = new Set(
      [
        ...Object.values(BOOTSTRAP_ROUTE_POLICIES).flatMap((policy) => [...policy.primary, ...policy.fallback]),
        ...HARD_TASK_ESCALATION_REFS,
      ].map((ref) => ref.logicalModelId),
    );
    assert.ok(!named.has("minimax-m2.5"), "P5 must not make MiniMax routable; that is P6's decision");
    // It is nonetheless declared, which is what lets P6 name it without also opening the vendor union.
    assert.equal(MODEL_VENDOR["minimax-m2.5"], "minimax");
  });
});
