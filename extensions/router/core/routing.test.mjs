import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveArchetype } from "./archetype.ts";
import { BOOTSTRAP_ROUTE_POLICIES, MODEL_VENDOR } from "./policy.ts";
import { conservativeFeatures } from "./features.ts";
import { deriveSafetyPolicy } from "./safety.ts";
import {
  canonicalVendor,
  deriveRoutingContext,
  isControlledHoldout,
  isStandaloneReviewRequest,
  registrySnapshotId,
  robustCostToDone,
  selectOrdinaryRoute,
  selectReviewRoute,
  selectStandaloneReviewRoute,
} from "./routing.ts";

function model(provider, modelId, vendor, contextWindow = 1_000_000) {
  return {
    provider,
    modelId,
    name: modelId,
    vendor,
    contextWindow,
    maxOutputTokens: 128_000,
    available: true,
    reasoning: true,
    supportedEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    inputTypes: ["text", "image"],
    toolCapable: true,
    costPerMillion: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
  };
}

function registry() {
  return [
    model("openai-codex", "gpt-5.6-luna", "openai"),
    model("openai-codex", "gpt-5.6-terra", "openai"),
    model("openai-codex", "gpt-5.6-sol", "openai"),
    // The previous-generation core models stay in the fixture registry on purpose: they are scoped in
    // on real machines, and the router must refuse them rather than never see them.
    model("openai-codex", "gpt-5.5", "openai"),
    model("openai-codex", "gpt-5.4", "openai"),
    model("openai-codex", "gpt-5.4-mini", "openai"),
    model("anthropic", "claude-haiku-4-5", "anthropic"),
    model("anthropic", "claude-sonnet-5", "anthropic"),
    model("anthropic", "claude-opus-5", "anthropic"),
    model("anthropic", "claude-fable-5", "anthropic"),
    model("google-vertex", "gemini-3.6-flash", "google"),
  ];
}

function endpointPrimaryGoldenRegistry() {
  const manufacturerProvider = {
    openai: "openai-codex",
    anthropic: "anthropic",
    google: "google-vertex",
  };
  const direct = Object.entries(MODEL_VENDOR).map(([modelId, vendor]) =>
    model(manufacturerProvider[vendor], modelId, vendor),
  );
  const bedrock = Object.entries(MODEL_VENDOR).map(([modelId, vendor]) => {
    const endpoint = model("amazon-bedrock", `${vendor}.${modelId}`, vendor);
    if (modelId === "gpt-5.6-sol") {
      endpoint.supportedEfforts = ["off", "minimal", "low", "medium", "high", "xhigh"];
    }
    return endpoint;
  });
  const copilot = {
    ...model("github-copilot", "gpt-5.6-sol", "openai"),
    costPerMillion: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return { direct, weighted: [...direct, ...bedrock, copilot] };
}

// Contexts are built through deriveRoutingContext so the fixtures cannot drift from the real derivation.
const FEATURES = {
  ambiguity: "low",
  interactivity: "single_response",
  actionMode: "reversible_mutation",
  risk: "medium",
  verificationStrength: "unit_tests",
};
const GO = deriveRoutingContext(FEATURES, ["go"]);
const TYPESCRIPT = deriveRoutingContext(FEATURES, ["typescript"]);
const HARD_GO = deriveRoutingContext({ ...FEATURES, ambiguity: "high" }, ["go"]);

const REQUIREMENTS = { estimatedFinishedTokens: 50_000, requiresImages: false, requiresTools: true };

describe("deriveArchetype", () => {
  it("routes planning by horizon before implementation", () => {
    const features = {
      ...conservativeFeatures(),
      intent: "plan",
      workflowType: "implementation_planning",
      horizon: "two_to_ten_prs",
      risk: "medium",
      ambiguity: "medium",
      reviewIntent: false,
    };
    assert.equal(deriveArchetype(features).archetype, "implementation_planning");
    assert.equal(
      deriveArchetype({ ...features, horizon: "eleven_to_hundred_prs" }).archetype,
      "large_program_planning",
    );
  });

  it("keeps critical ambiguous advice out of review routing when review is only inferred", () => {
    const features = {
      ...conservativeFeatures(),
      intent: "research",
      workflowType: "research_or_analysis",
      risk: "critical",
      ambiguity: "high",
      reviewIntent: true,
    };
    assert.equal(deriveArchetype(features).archetype, "highest_risk_advisory");
  });

  it("claims a post-completion review duty only where the safety policy creates one", () => {
    const builder = {
      ...conservativeFeatures(),
      intent: "implement",
      workflowType: "coding_implementation",
      risk: "high",
      actionMode: "reversible_mutation",
    };
    assert.equal(deriveArchetype(builder).requiresIndependentReview, true);
    assert.equal(deriveSafetyPolicy(builder), "completion_review");

    // "Review this and fix it" classifies as both review and implementation. The safety policy is
    // ordinary there, so the archetype must not claim a review duty the lifecycle never creates.
    for (const reviewShape of [
      { workflowType: "code_review", intent: "implement" },
      { workflowType: "coding_implementation", intent: "review" },
    ]) {
      const features = { ...builder, ...reviewShape };
      assert.equal(deriveSafetyPolicy(features), "ordinary");
      assert.equal(
        deriveArchetype(features).requiresIndependentReview,
        false,
        `${reviewShape.workflowType}/${reviewShape.intent} must not require an independent review`,
      );
      assert.ok(
        !deriveArchetype(features).reasons.some((reason) => reason.includes("post-completion review")),
        "the explanation must not name a review that will not happen",
      );
    }
  });
});

describe("ordinary route selection", () => {
  it("orders routine repository work by measured completion cost and keeps a cross-vendor fallback", () => {
    const decision = selectOrdinaryRoute("median_repository_implementation", registry(), REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    // Sol at high effort wins routine work on measured completion cost: 69.2% pass at $5.01 per
    // pass and a 517 s median, against Opus 5 at medium with 68.1% at $4.86 and 588 s.
    assert.equal(decision.primary.modelId, "gpt-5.6-sol");
    assert.equal(decision.primary.effort, "high");
    assert.equal(decision.primary.rankReason, "evidence_prior");
    assert.ok(decision.fallbacks.some((choice) => choice.vendor === "anthropic"));
    assert.notEqual(decision.primary.profileId, "");
  });

  it("prefers Opus 5 for routine Go work and Sol for routine TypeScript work", () => {
    const go = selectOrdinaryRoute(
      "median_repository_implementation",
      registry(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      GO,
    );
    assert.equal(go.kind, "ordinary");
    assert.equal(go.primary.modelId, "claude-opus-5");
    assert.equal(go.primary.evidenceLanguage, "go");

    const typescript = selectOrdinaryRoute(
      "median_repository_implementation",
      registry(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      TYPESCRIPT,
    );
    assert.equal(typescript.kind, "ordinary");
    assert.equal(typescript.primary.modelId, "gpt-5.6-sol");
    // TypeScript wins on the uncontested latency and cost basis; its single-source quality gap is not
    // substituted into the score, so no language is recorded on the choice.
    assert.equal(typescript.primary.evidenceLanguage, undefined);
  });

  it("escalates the hard Go tail to Opus 5 at high effort", () => {
    const decision = selectOrdinaryRoute(
      "stacked_pr_implementation",
      registry(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      HARD_GO,
    );
    assert.equal(decision.kind, "ordinary");
    assert.equal(decision.primary.modelId, "claude-opus-5");
    assert.equal(decision.primary.effort, "high");
  });

  it("keeps stacked PR execution on current-generation models and retires Opus 4.8", () => {
    const models = [...registry(), model("anthropic", "claude-opus-4-8", "anthropic")];
    const decision = selectOrdinaryRoute("stacked_pr_implementation", models, REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    assert.ok(
      [decision.primary, ...decision.fallbacks].every((choice) =>
        /^(?:gpt-5\.6-sol|claude-opus-5)$/.test(choice.modelId),
      ),
    );
    assert.ok([decision.primary, ...decision.fallbacks].every((choice) => choice.modelId !== "claude-opus-4-8"));
  });

  it("pins planning archetypes to Opus 5 even though Sol scores lower completion cost", () => {
    for (const [archetype, effort] of [
      ["implementation_planning", "high"],
      ["large_program_planning", "xhigh"],
      ["highest_risk_advisory", "max"],
    ]) {
      const decision = selectOrdinaryRoute(archetype, registry(), REQUIREMENTS);
      assert.equal(decision.kind, "ordinary");
      assert.equal(decision.primary.modelId, "claude-opus-5", `${archetype} must pin Opus 5`);
      assert.equal(decision.primary.effort, effort);
      // The pin reorders only; the cheaper cross-vendor candidate stays available as a fallback.
      assert.ok(decision.fallbacks.some((choice) => choice.vendor === "openai"));
    }
  });

  it("keeps the TypeScript effort ceiling even for a pinned escalation archetype", () => {
    const decision = selectOrdinaryRoute(
      "large_program_planning",
      registry(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      TYPESCRIPT,
    );
    assert.equal(decision.kind, "ordinary");
    assert.notEqual(decision.primary.effort, "xhigh");
    assert.ok(
      decision.exclusions.some(
        (exclusion) => exclusion.code === "effort_unauthorized" && /typescript ceiling high/.test(exclusion.detail),
      ),
    );
  });

  it("uses the current-generation Google candidate and refuses disqualified Gemini models", () => {
    const models = [
      ...registry().filter((candidate) => candidate.vendor !== "google"),
      model("google-vertex", "gemini-3.5-flash", "google"),
      model("google-vertex", "gemini-3.1-pro-preview", "google"),
    ];
    const decision = selectOrdinaryRoute("algorithmic_iterative_coding", models, REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    assert.ok([decision.primary, ...decision.fallbacks].every((choice) => choice.vendor !== "google"));

    const withCurrent = selectOrdinaryRoute("algorithmic_iterative_coding", registry(), REQUIREMENTS);
    assert.ok(withCurrent.fallbacks.some((choice) => choice.modelId === "gemini-3.6-flash"));
  });

  it("deduplicates an endpoint per effort rather than per model", () => {
    // highest_risk_advisory authorizes Opus 5 at max and at high, which is the same endpoint at two
    // efforts; both must survive deduplication so the archetype keeps a fallback.
    const decision = selectOrdinaryRoute("highest_risk_advisory", registry(), REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    const opusEfforts = [decision.primary, ...decision.fallbacks]
      .filter((choice) => choice.modelId === "claude-opus-5")
      .map((choice) => choice.effort);
    assert.deepEqual(opusEfforts, ["max", "high"]);
  });

  it("pins the cost-first endpoint primary for every bootstrap archetype", () => {
    const expectedPrimaries = {
      fast_classification: {
        logicalModelId: "claude-haiku-4-5",
        effort: "low",
        endpoint: "amazon-bedrock/anthropic.claude-haiku-4-5",
      },
      exact_extraction: {
        logicalModelId: "claude-haiku-4-5",
        effort: "low",
        endpoint: "amazon-bedrock/anthropic.claude-haiku-4-5",
      },
      // These Sol routes stay first party because the deliberately large request exceeds the 272K
      // Bedrock list-rate boundary. Copilot is eligible but remains last as a flat-rate proxy.
      deliberate_tool_workflow: {
        logicalModelId: "gpt-5.6-sol",
        effort: "high",
        endpoint: "openai-codex/gpt-5.6-sol",
      },
      median_repository_implementation: {
        logicalModelId: "gpt-5.6-sol",
        effort: "high",
        endpoint: "openai-codex/gpt-5.6-sol",
      },
      stacked_pr_implementation: {
        logicalModelId: "gpt-5.6-sol",
        effort: "high",
        endpoint: "openai-codex/gpt-5.6-sol",
      },
      terminal_heavy_implementation: {
        logicalModelId: "gpt-5.6-sol",
        effort: "high",
        endpoint: "openai-codex/gpt-5.6-sol",
      },
      algorithmic_iterative_coding: {
        logicalModelId: "claude-opus-5",
        effort: "medium",
        endpoint: "amazon-bedrock/anthropic.claude-opus-5",
      },
      code_review: {
        logicalModelId: "gpt-5.6-sol",
        effort: "high",
        endpoint: "openai-codex/gpt-5.6-sol",
      },
      implementation_planning: {
        logicalModelId: "claude-opus-5",
        effort: "high",
        endpoint: "amazon-bedrock/anthropic.claude-opus-5",
      },
      large_program_planning: {
        logicalModelId: "claude-opus-5",
        effort: "xhigh",
        endpoint: "amazon-bedrock/anthropic.claude-opus-5",
      },
      long_context_synthesis: {
        logicalModelId: "gpt-5.6-sol",
        effort: "high",
        endpoint: "openai-codex/gpt-5.6-sol",
      },
      highest_risk_advisory: {
        logicalModelId: "claude-opus-5",
        effort: "max",
        endpoint: "amazon-bedrock/anthropic.claude-opus-5",
      },
    };
    assert.deepEqual(Object.keys(expectedPrimaries).sort(), Object.keys(BOOTSTRAP_ROUTE_POLICIES).sort());

    const { direct, weighted } = endpointPrimaryGoldenRegistry();
    const longContextRequirements = { ...REQUIREMENTS, estimatedFinishedTokens: 300_000 };
    for (const [archetype, expected] of Object.entries(expectedPrimaries)) {
      const baseline = selectOrdinaryRoute(archetype, direct, longContextRequirements);
      const decision = selectOrdinaryRoute(archetype, weighted, longContextRequirements);
      assert.equal(baseline.kind, "ordinary", `${archetype} direct baseline must route`);
      assert.equal(decision.kind, "ordinary", `${archetype} weighted registry must route`);
      assert.deepEqual(
        { logicalModelId: decision.primary.logicalModelId, effort: decision.primary.effort },
        { logicalModelId: baseline.primary.logicalModelId, effort: baseline.primary.effort },
        `${archetype} must preserve logical model and effort selection`,
      );
      assert.deepEqual(
        { logicalModelId: decision.primary.logicalModelId, effort: decision.primary.effort },
        { logicalModelId: expected.logicalModelId, effort: expected.effort },
        `${archetype} logical primary drifted`,
      );
      assert.equal(
        `${decision.primary.provider}/${decision.primary.modelId}`,
        expected.endpoint,
        `${archetype} endpoint primary drifted`,
      );

      if (expected.endpoint === "openai-codex/gpt-5.6-sol") {
        assert.ok(
          decision.exclusions.some(
            (exclusion) =>
              exclusion.candidate === "amazon-bedrock/openai.gpt-5.6-sol" &&
              exclusion.code === "long_context_pricing_unavailable",
          ),
          `${archetype} must reject Bedrock Sol before ordering at long context`,
        );
        const selectedEndpoints = [decision.primary, ...decision.fallbacks].filter(
          (choice) => choice.logicalModelId === "gpt-5.6-sol" && choice.effort === "high",
        );
        assert.equal(selectedEndpoints.at(-1)?.provider, "github-copilot");
      }

      if (archetype === "large_program_planning" || archetype === "highest_risk_advisory") {
        assert.ok(
          decision.exclusions.some(
            (exclusion) =>
              exclusion.candidate === "amazon-bedrock/openai.gpt-5.6-sol" && exclusion.code === "effort_unsupported",
          ),
          `${archetype} must reject Bedrock Sol max before ordering`,
        );
      }
    }
  });

  it("orders endpoints cost-first while keeping every selected-model endpoint contiguous", () => {
    const models = [
      ...registry(),
      model("openai", "gpt-5.6-sol", "openai"),
      model("amazon-bedrock", "openai.gpt-5.6-sol", "openai"),
    ];
    const decision = selectOrdinaryRoute("median_repository_implementation", models, REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    assert.equal(decision.primary.logicalModelId, "gpt-5.6-sol");
    assert.equal(decision.primary.provider, "amazon-bedrock");
    // The tier remains diagnostic metadata and does not prevent the lower effective-cost resale route
    // from becoming primary.
    assert.equal(decision.primary.endpointTier, "resale");
    const choices = [decision.primary, ...decision.fallbacks];
    const selectedGroup = choices.filter(
      (choice) => choice.logicalModelId === "gpt-5.6-sol" && choice.effort === "high",
    );
    assert.deepEqual(
      selectedGroup.map((choice) => `${choice.provider}/${choice.modelId}`),
      ["amazon-bedrock/openai.gpt-5.6-sol", "openai-codex/gpt-5.6-sol", "openai/gpt-5.6-sol"],
    );
    assert.deepEqual(choices.slice(0, selectedGroup.length), selectedGroup);
    assert.ok(
      choices
        .slice(selectedGroup.length)
        .every((choice) => choice.logicalModelId !== "gpt-5.6-sol" || choice.effort !== "high"),
      "a same-model endpoint appeared after a different-model fallback",
    );
  });

  it("promotes a lower weighted-cost Bedrock endpoint over direct Anthropic", () => {
    const models = [
      ...registry(),
      {
        ...model("amazon-bedrock", "global.anthropic.claude-opus-5", "anthropic"),
        costPerMillion: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0.01 },
      },
    ];
    const decision = selectOrdinaryRoute("implementation_planning", models, REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    assert.equal(decision.primary.provider, "amazon-bedrock");
    assert.equal(decision.fallbacks[0].provider, "anthropic");
    assert.ok(decision.primary.endpointEffectiveCost < decision.fallbacks[0].endpointEffectiveCost);
  });

  it("uses provider weights and the comparator total order without hidden provider tiers", () => {
    const equalPrice = { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 2.5 };
    const openaiModels = [
      ...registry().filter((candidate) => candidate.modelId !== "gpt-5.6-sol"),
      { ...model("openai", "gpt-5.6-sol", "openai"), costPerMillion: equalPrice },
      { ...model("openai-codex", "gpt-5.6-sol", "openai"), costPerMillion: equalPrice },
      { ...model("new-token-provider", "gpt-5.6-sol", "openai"), costPerMillion: equalPrice },
    ];
    const openai = selectOrdinaryRoute("median_repository_implementation", openaiModels, REQUIREMENTS);
    assert.equal(openai.kind, "ordinary");
    const solProviders = [openai.primary, ...openai.fallbacks]
      .filter((choice) => choice.logicalModelId === "gpt-5.6-sol" && choice.effort === "high")
      .map((choice) => choice.provider);
    assert.deepEqual(solProviders, ["openai-codex", "openai", "new-token-provider"]);

    const anthropicModels = [
      ...registry().filter((candidate) => candidate.modelId !== "claude-opus-5"),
      { ...model("bifrost", "claude-opus-5", "anthropic"), costPerMillion: equalPrice },
      { ...model("anthropic", "claude-opus-5", "anthropic"), costPerMillion: equalPrice },
    ];
    const anthropic = selectOrdinaryRoute("implementation_planning", anthropicModels, REQUIREMENTS);
    assert.equal(anthropic.kind, "ordinary");
    assert.equal(anthropic.primary.provider, "anthropic");
    assert.equal(anthropic.fallbacks[0].provider, "bifrost");
    assert.equal(anthropic.primary.endpointEffectiveCost, anthropic.fallbacks[0].endpointEffectiveCost);
  });

  it("keeps an exact high-markup AU Bedrock endpoint behind its cheaper direct route", () => {
    const direct = {
      ...model("anthropic", "claude-opus-4-6", "anthropic"),
      costPerMillion: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    };
    const auBedrock = {
      ...model("amazon-bedrock", "au.anthropic.claude-opus-4-6-v1", "anthropic"),
      costPerMillion: { input: 15, output: 83, cacheRead: 1.5, cacheWrite: 18.75 },
    };
    const decision = selectOrdinaryRoute("median_repository_implementation", [...registry(), direct, auBedrock], {
      ...REQUIREMENTS,
      estimatedFinishedTokens: 600_000,
    });
    assert.equal(decision.kind, "ordinary");
    const opus46 = [decision.primary, ...decision.fallbacks].filter(
      (choice) => choice.logicalModelId === "claude-opus-4-6",
    );
    assert.deepEqual(
      opus46.map((choice) => `${choice.provider}/${choice.modelId}`),
      ["anthropic/claude-opus-4-6", "amazon-bedrock/au.anthropic.claude-opus-4-6-v1"],
    );
    assert.equal(opus46[0].endpointEffectiveCost, 20);
    assert.ok(Math.abs(opus46[1].endpointEffectiveCost - 54.78) < 1e-12);
  });

  it("uses identical effective-cost semantics in registry resolution and RouteChoice ordering", () => {
    const cheap = {
      ...model("openai", "gpt-5.6-sol", "openai"),
      costPerMillion: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
      providerWeight: { weight: 0.5, basis: "preference", source: "project" },
    };
    const expensive = {
      ...model("openai-codex", "gpt-5.6-sol", "openai"),
      costPerMillion: { input: 10, output: 10, cacheRead: 1, cacheWrite: 12.5 },
      providerWeight: { weight: 1.5, basis: "preference", source: "user" },
    };
    const models = [...registry().filter((candidate) => candidate.modelId !== "gpt-5.6-sol"), expensive, cheap];

    // Ordinary routing evaluates all endpoints and then orders the resulting RouteChoice group.
    const ordinary = selectOrdinaryRoute("median_repository_implementation", models, REQUIREMENTS);
    assert.equal(ordinary.kind, "ordinary");
    assert.equal(ordinary.primary.provider, "openai");
    assert.equal(ordinary.primary.endpointBlendedCost, 1);
    assert.equal(ordinary.primary.endpointEffectiveCost, 0.5);

    // Tracked review takes the first resolved endpoint before RouteChoice group ordering, exercising
    // the registry-snapshot call path independently.
    const builder = models.find((candidate) => candidate.modelId === "claude-opus-5");
    const review = selectReviewRoute(models, REQUIREMENTS, builder, "high", 3);
    assert.equal(review.kind, "review");
    const openaiReviewer = [review.primary, ...review.fallbacks].find((choice) => choice.vendor === "openai");
    assert.equal(openaiReviewer.provider, "openai");
    assert.equal(openaiReviewer.endpointEffectiveCost, ordinary.primary.endpointEffectiveCost);
  });

  it("filters broad endpoint eligibility and malformed pricing before cost comparison", () => {
    const poisonedPrice = { input: Number.NaN, output: 30, cacheRead: 0.5, cacheWrite: 6.25 };
    const unavailable = {
      ...model("openai", "gpt-5.6-sol", "openai"),
      available: false,
      costPerMillion: poisonedPrice,
    };
    const unhealthy = {
      ...model("bifrost", "gpt-5.6-sol", "openai"),
      health: { provider: "bifrost", modelId: "gpt-5.6-sol", status: "client_error", httpStatus: 401 },
      costPerMillion: poisonedPrice,
    };
    const unsupported = {
      ...model("new-token-provider", "gpt-5.6-sol", "openai"),
      supportedEfforts: ["max"],
      costPerMillion: poisonedPrice,
    };
    const malformed = {
      ...model("amazon-bedrock", "global.openai.gpt-5.6-sol", "openai"),
      costPerMillion: { input: -1, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    };
    const decision = selectOrdinaryRoute(
      "median_repository_implementation",
      [...registry(), unavailable, unhealthy, unsupported, malformed],
      REQUIREMENTS,
    );
    assert.equal(decision.kind, "ordinary");
    const exclusions = new Map(decision.exclusions.map((exclusion) => [exclusion.candidate, exclusion.code]));
    assert.equal(exclusions.get("openai/gpt-5.6-sol"), "unavailable");
    assert.equal(exclusions.get("bifrost/gpt-5.6-sol"), "endpoint_unhealthy");
    assert.equal(exclusions.get("new-token-provider/gpt-5.6-sol"), "effort_unsupported");
    assert.equal(exclusions.get("amazon-bedrock/global.openai.gpt-5.6-sol"), "endpoint_pricing_invalid");
    assert.ok(
      decision.exclusions.some(
        (exclusion) =>
          exclusion.candidate === "amazon-bedrock/global.openai.gpt-5.6-sol" &&
          /finite and nonnegative/.test(exclusion.detail),
      ),
    );
    assert.ok(
      [decision.primary, ...decision.fallbacks].every(
        (choice) => !exclusions.has(`${choice.provider}/${choice.modelId}`),
      ),
    );
  });

  it("keeps flat-rate nominal prices outside endpoint cost ordering", () => {
    const models = [
      ...registry(),
      {
        ...model("amazon-bedrock", "openai.gpt-5.6-sol", "openai"),
        costPerMillion: { input: 100, output: 100, cacheRead: 10, cacheWrite: 125 },
      },
      {
        ...model("github-copilot", "gpt-5.6-sol", "openai"),
        costPerMillion: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ];
    const decision = selectOrdinaryRoute("median_repository_implementation", models, REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    const endpoints = [decision.primary, ...decision.fallbacks].filter(
      (choice) => choice.logicalModelId === "gpt-5.6-sol" && choice.effort === "high",
    );
    const bedrock = endpoints.findIndex((choice) => choice.provider === "amazon-bedrock");
    const copilot = endpoints.findIndex((choice) => choice.provider === "github-copilot");
    assert.ok(bedrock >= 0 && copilot > bedrock);
    assert.equal(endpoints[copilot].endpointBlendedCost, undefined);
    assert.equal(endpoints[copilot].endpointEffectiveCost, undefined);
  });

  it("gates low-effort tiers on task consequence rather than on the archetype label", () => {
    const mutating = selectOrdinaryRoute("median_repository_implementation", registry(), REQUIREMENTS);
    assert.equal(mutating.kind, "ordinary");
    assert.ok(
      [mutating.primary, ...mutating.fallbacks].every(
        (choice) => !(choice.modelId === "gpt-5.6-terra" && (choice.effort === "low" || choice.effort === "medium")),
      ),
    );

    // An extraction task that cannot change anything keeps the cheap precise tier.
    const readOnly = selectOrdinaryRoute(
      "exact_extraction",
      registry(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      deriveRoutingContext({ ...FEATURES, actionMode: "information_only" }, []),
    );
    assert.equal(readOnly.kind, "ordinary");
    assert.equal(readOnly.primary.modelId, "gpt-5.6-terra");
    assert.equal(readOnly.primary.effort, "medium");

    // The same archetype carrying an irreversible action mode drops the low band entirely.
    const irreversible = selectOrdinaryRoute(
      "exact_extraction",
      registry(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      deriveRoutingContext({ ...FEATURES, actionMode: "external_side_effect" }, []),
    );
    assert.equal(irreversible.kind, "ordinary");
    assert.notEqual(irreversible.primary.modelId, "gpt-5.6-terra");
    assert.ok(
      irreversible.exclusions.some(
        (exclusion) => exclusion.code === "effort_unauthorized" && /irreversible floor/.test(exclusion.detail),
      ),
    );
  });

  it("rejects candidates that exceed 70% context headroom", () => {
    const smallRegistry = registry().map((candidate) => ({ ...candidate, contextWindow: 100_000 }));
    const decision = selectOrdinaryRoute("median_repository_implementation", smallRegistry, {
      ...REQUIREMENTS,
      estimatedFinishedTokens: 70_001,
    });
    assert.equal(decision.kind, "unroutable");
    assert.ok(decision.exclusions.some((exclusion) => exclusion.code === "context_headroom"));
  });

  it("excludes Bedrock Sol only above its registered short-context pricing boundary", () => {
    const bedrockSol = {
      ...model("amazon-bedrock", "openai.gpt-5.6-sol", "openai"),
      // The real endpoint does not expose max effort; high remains eligible for this boundary test.
      supportedEfforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
      costPerMillion: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    };
    const models = [...registry(), bedrockSol];
    const atBoundary = selectOrdinaryRoute("median_repository_implementation", models, {
      ...REQUIREMENTS,
      estimatedFinishedTokens: 272_000,
    });
    assert.equal(atBoundary.kind, "ordinary");
    assert.ok(
      [atBoundary.primary, ...atBoundary.fallbacks].some(
        (choice) => choice.provider === "amazon-bedrock" && choice.modelId === "openai.gpt-5.6-sol",
      ),
    );

    // Poison the short-context price for the larger request. Eligibility must remove this endpoint
    // before registry resolution attempts to compute or compare that rate.
    const aboveBoundaryModels = models.map((candidate) =>
      candidate === bedrockSol
        ? { ...candidate, costPerMillion: { ...candidate.costPerMillion, input: Number.NaN } }
        : candidate,
    );
    const aboveBoundary = selectOrdinaryRoute("median_repository_implementation", aboveBoundaryModels, {
      ...REQUIREMENTS,
      estimatedFinishedTokens: 272_001,
    });
    assert.equal(aboveBoundary.kind, "ordinary");
    assert.ok(
      [aboveBoundary.primary, ...aboveBoundary.fallbacks].every(
        (choice) => choice.provider !== "amazon-bedrock" || choice.modelId !== "openai.gpt-5.6-sol",
      ),
    );
    assert.ok(
      aboveBoundary.exclusions.some(
        (exclusion) =>
          exclusion.candidate === "amazon-bedrock/openai.gpt-5.6-sol" &&
          exclusion.code === "long_context_pricing_unavailable" &&
          /no registered price above 272000 estimated tokens/.test(exclusion.detail),
      ),
    );
  });

  it("guards every canonical Bedrock Sol spelling before computing its short-context price", () => {
    for (const modelId of ["global.openai.gpt-5.6-sol", "us.openai.gpt-5.6-sol-v1:0"]) {
      const bedrockSol = {
        ...model("amazon-bedrock", modelId, "openai"),
        supportedEfforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
        costPerMillion: { input: Number.NaN, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      };
      const decision = selectOrdinaryRoute("median_repository_implementation", [...registry(), bedrockSol], {
        ...REQUIREMENTS,
        estimatedFinishedTokens: 272_001,
      });
      assert.equal(decision.kind, "ordinary");
      assert.ok(
        [decision.primary, ...decision.fallbacks].every(
          (choice) => choice.provider !== "amazon-bedrock" || choice.modelId !== modelId,
        ),
      );
      assert.ok(
        decision.exclusions.some(
          (exclusion) =>
            exclusion.candidate === `amazon-bedrock/${modelId}` &&
            exclusion.code === "long_context_pricing_unavailable",
        ),
      );
    }
  });

  it("preserves Bedrock Sol's max-effort exclusion", () => {
    const modelId = "global.openai.gpt-5.6-sol";
    const bedrockSol = {
      ...model("amazon-bedrock", modelId, "openai"),
      supportedEfforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
      // An unsupported larger request must retain the effort reason without touching this price.
      costPerMillion: { input: Number.NaN, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    };
    const decision = selectOrdinaryRoute("highest_risk_advisory", [...registry(), bedrockSol], {
      ...REQUIREMENTS,
      estimatedFinishedTokens: 272_001,
    });
    assert.equal(decision.kind, "ordinary");
    assert.ok(
      decision.exclusions.some(
        (exclusion) => exclusion.candidate === `amazon-bedrock/${modelId}` && exclusion.code === "effort_unsupported",
      ),
    );
    assert.ok(
      [decision.primary, ...decision.fallbacks].every(
        (choice) => choice.provider !== "amazon-bedrock" || choice.modelId !== modelId || choice.effort !== "max",
      ),
    );
  });

  it("rejects candidates whose measured peak context exceeds the window headroom", () => {
    // A 272K window leaves 190K of headroom, below the measured p90 peak context of max-effort
    // OpenAI configurations, so those endpoints are excluded before scoring.
    const models = registry().map((candidate) =>
      candidate.vendor === "openai" ? { ...candidate, contextWindow: 272_000 } : candidate,
    );
    const decision = selectOrdinaryRoute("highest_risk_advisory", models, REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    assert.ok(
      decision.exclusions.some(
        (exclusion) => exclusion.code === "context_headroom_prior" && exclusion.candidate.includes("gpt-5.6-sol"),
      ),
    );
    assert.ok(
      [decision.primary, ...decision.fallbacks].every(
        (choice) => choice.effort !== "max" || choice.contextWindow > 272_000,
      ),
    );
  });

  it("requires long-context routes to keep measured peak context under half the window", () => {
    const decision = selectOrdinaryRoute("long_context_synthesis", registry(), REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    for (const choice of [decision.primary, ...decision.fallbacks]) {
      assert.ok(choice.contextWindow >= 1_000_000);
    }
  });

  it("keeps evidence-prior order until every comparable candidate is mature", () => {
    const samples = [
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        archetype: "median_repository_implementation",
        comparableSamples: 30,
        acceptedRate: 0.99,
        p75ModelAndToolCost: 100,
        p75WallTimeMs: 100,
        probabilityHumanIntervention: 0,
        probabilityRetry: 0,
      },
    ];
    const decision = selectOrdinaryRoute("median_repository_implementation", registry(), REQUIREMENTS, samples);
    assert.equal(decision.kind, "ordinary");
    assert.equal(decision.telemetryMature, false);
    assert.equal(decision.primary.modelId, "gpt-5.6-sol");
    assert.equal(decision.primary.rankReason, "evidence_prior");

    // Maturity requires a comparable sample for every eligible group, so derive them from the
    // evidence-ordered decision rather than hand-listing candidates.
    const matureSamples = [decision.primary, ...decision.fallbacks].map((choice) => ({
      ...samples[0],
      provider: choice.provider,
      modelId: choice.modelId,
      // Make claude-opus-5 the cheapest so telemetry demonstrably reorders away from the prior order.
      p75ModelAndToolCost: choice.logicalModelId === "claude-opus-5" ? 1 : 100,
    }));
    const mature = selectOrdinaryRoute("median_repository_implementation", registry(), REQUIREMENTS, matureSamples);
    assert.equal(mature.kind, "ordinary");
    assert.equal(mature.telemetryMature, true);
    assert.equal(mature.primary.modelId, "claude-opus-5");
    assert.equal(mature.primary.rankReason, "telemetry");
    assert.equal(mature.primary.scoreComponents.p75ModelAndToolCost, 1);
    assert.ok(Math.abs(mature.primary.scoreComponents.developerWaitCost - 0.0001) < 1e-12);
    assert.equal(mature.primary.scoreComponents.humanInterventionCost, 0);
    assert.equal(mature.primary.scoreComponents.retryCost, 0);

    const holdoutKey = Array.from({ length: 100 }, (_, index) => `task-${index}`).find((key) =>
      isControlledHoldout(key),
    );
    assert.ok(holdoutKey);
    const holdout = selectOrdinaryRoute(
      "median_repository_implementation",
      registry(),
      REQUIREMENTS,
      matureSamples,
      undefined,
      holdoutKey,
    );
    assert.equal(holdout.kind, "ordinary");
    assert.equal(holdout.controlledHoldout, true);
    assert.equal(holdout.primary.rankReason, "controlled_holdout");
  });
});

describe("review route selection", () => {
  it("routes standalone review from delta features without inventing a builder", () => {
    const decision = selectStandaloneReviewRoute(registry(), REQUIREMENTS, [], undefined, "standalone", TYPESCRIPT);
    assert.equal(decision.kind, "ordinary");
    assert.equal(decision.archetype, "code_review");
    assert.ok(
      [decision.primary, ...decision.fallbacks].every((choice) => choice.rankReason !== "fixed_builder_fallback"),
    );
  });

  it("selects both non-builder vendors without allowing the builder to review itself", () => {
    const models = registry();
    const builder = models.find((candidate) => candidate.modelId === "gpt-5.6-terra");
    const decision = selectReviewRoute(models, REQUIREMENTS, builder, "medium", 2);
    assert.equal(decision.kind, "review");
    assert.deepEqual(
      new Set([decision.primary, ...decision.fallbacks].map((choice) => choice.vendor)),
      new Set(["anthropic", "google"]),
    );
    assert.ok([decision.primary, ...decision.fallbacks].every((choice) => choice.vendor !== builder.vendor));
  });

  it("tries a stronger reviewer tier when the closest at-or-above model is unavailable", () => {
    const models = registry().map((candidate) =>
      candidate.modelId === "claude-opus-5" || candidate.modelId === "claude-sonnet-5"
        ? { ...candidate, available: false }
        : candidate,
    );
    const builder = models.find((candidate) => candidate.modelId === "gpt-5.6-sol");
    const decision = selectReviewRoute(models, REQUIREMENTS, builder, "high", 3);
    assert.equal(decision.kind, "review");
    const anthropic = [decision.primary, ...decision.fallbacks].find((choice) => choice.vendor === "anthropic");
    assert.equal(anthropic.modelId, "claude-fable-5");
  });

  it("does not require the tracked builder endpoint to remain available for read-only review", () => {
    const models = registry();
    const builder = { ...models.find((candidate) => candidate.modelId === "gpt-5.6-terra"), available: false };
    const decision = selectReviewRoute(
      models.map((candidate) => (candidate.modelId === builder.modelId ? builder : candidate)),
      REQUIREMENTS,
      builder,
      "medium",
      2,
    );
    assert.equal(decision.kind, "review");
    assert.ok([decision.primary, ...decision.fallbacks].every((choice) => choice.vendor !== builder.vendor));
  });

  // The review rule is "every vendor other than the builder's, and at least two must be eligible".
  // It used to be "filter a hardcoded triple, then require exactly two survivors", which returns
  // unroutable for a builder outside that triple. These four tests pin the rule that replaced it.
  it("routes a builder from a vendor outside the historical triple", () => {
    // A vendor the reviewer ladders know nothing about. Under the old exactly-two rule this yielded
    // three candidate vendors and returned unroutable, silently disabling tracked review.
    const models = registry();
    const builder = { ...models.find((candidate) => candidate.modelId === "claude-opus-5"), vendor: "moonshot" };
    const decision = selectReviewRoute(models, REQUIREMENTS, builder, "high", 3);
    assert.equal(decision.kind, "review", "a builder outside the reviewer vendor set must still be reviewable");
    const reviewers = [decision.primary, ...decision.fallbacks];
    assert.ok(reviewers.length >= 2, "independence still requires at least two reviewers");
    assert.ok(
      reviewers.every((choice) => choice.vendor !== builder.vendor),
      "no reviewer may share the builder's vendor",
    );
    // All three ladder vendors are non-builder here, so the chain is longer than the old fixed pair.
    assert.equal(new Set(reviewers.map((choice) => choice.vendor)).size, reviewers.length);
  });

  it("keeps the chain sequential and ordered by closeness to the builder band", () => {
    const models = registry();
    const builder = { ...models.find((candidate) => candidate.modelId === "claude-opus-5"), vendor: "moonshot" };
    const decision = selectReviewRoute(models, REQUIREMENTS, builder, "high", 3);
    assert.equal(decision.kind, "review");
    const distances = [decision.primary, ...decision.fallbacks].map((choice) => Math.abs(choice.ability - 3));
    assert.deepEqual(
      distances,
      [...distances].sort((left, right) => left - right),
      "reviewers must stay ordered by distance from the builder ability band",
    );
  });

  it("fails closed below the independence floor rather than accepting one reviewer", () => {
    // Only Anthropic can supply a reviewer, so the floor of two is unmet.
    const models = registry().map((candidate) =>
      candidate.vendor === "openai" || candidate.vendor === "google" ? { ...candidate, available: false } : candidate,
    );
    const builder = { ...models.find((candidate) => candidate.modelId === "claude-opus-5"), vendor: "moonshot" };
    const decision = selectReviewRoute(models, REQUIREMENTS, builder, "high", 3);
    assert.equal(decision.kind, "unroutable", "one independent reviewer must not satisfy tracked review");
    assert.match(decision.reason, /at least 2 eligible non-builder vendors/);
  });

  it("records a ceiling mismatch per vendor without shortening the chain", () => {
    const models = registry();
    const builder = { ...models.find((candidate) => candidate.modelId === "claude-opus-5"), vendor: "moonshot" };
    const decision = selectReviewRoute(models, REQUIREMENTS, builder, "max", 4);
    assert.equal(decision.kind, "review");
    // A vendor whose best eligible reviewer sits below the builder band is reported, not dropped.
    for (const vendor of decision.ceilingMismatchVendors) {
      assert.ok(
        [decision.primary, ...decision.fallbacks].some((choice) => choice.vendor === vendor),
        `${vendor} was reported as a ceiling mismatch but contributed no reviewer`,
      );
    }
  });
});

describe("routing helpers", () => {
  it("normalizes gateway model IDs to their actual vendor", () => {
    assert.equal(canonicalVendor("github-copilot", "claude-sonnet-5"), "anthropic");
    assert.equal(canonicalVendor("github-copilot", "gemini-3.5-flash"), "google");
    assert.equal(canonicalVendor("openai-codex", "gpt-5.6-terra"), "openai");
    assert.equal(canonicalVendor("bifrost", "openai/gpt-5.6-terra"), "openai");
    assert.equal(canonicalVendor("bifrost", "bedrock/anthropic.claude-sonnet-5"), "anthropic");
    assert.equal(canonicalVendor("bifrost", "vertex/gemini-2.5-flash"), "google");
  });

  it("normalizes Amazon Bedrock direct and cross-region model IDs to their actual vendor", () => {
    assert.equal(canonicalVendor("amazon-bedrock", "openai.gpt-5.6-luna"), "openai");
    assert.equal(canonicalVendor("amazon-bedrock", "openai.gpt-5.6-terra"), "openai");
    assert.equal(canonicalVendor("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0"), "anthropic");
    assert.equal(canonicalVendor("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0"), "anthropic");
    assert.equal(canonicalVendor("amazon-bedrock", "eu.anthropic.claude-sonnet-5"), "anthropic");
    assert.equal(canonicalVendor("amazon-bedrock", "au.anthropic.claude-sonnet-5"), "anthropic");
    assert.equal(canonicalVendor("amazon-bedrock", "jp.anthropic.claude-sonnet-5"), "anthropic");
    assert.equal(canonicalVendor("amazon-bedrock", "global.anthropic.claude-sonnet-5"), "anthropic");
    // A region-like prefix that is not followed by a known vendor path must not be stripped.
    assert.equal(canonicalVendor("amazon-bedrock", "us.gov-cloud-widget-1"), undefined);
  });

  it("calculates robust cost-to-done and stable snapshots", () => {
    assert.equal(
      robustCostToDone(
        {
          provider: "openai",
          modelId: "x",
          archetype: "fast_classification",
          comparableSamples: 30,
          acceptedRate: 1,
          p75ModelAndToolCost: 2,
          p75WallTimeMs: 10,
          probabilityHumanIntervention: 0.1,
          probabilityRetry: 0.2,
        },
        { developerWaitValuePerMs: 0.5, humanInterventionCost: 10, retryCost: 5 },
      ),
      9,
    );
    const snapshot = registrySnapshotId(registry());
    assert.equal(snapshot, registrySnapshotId([...registry()].reverse()));
    assert.match(snapshot, /^registry-v1:11:[0-9a-f]{16}$/);
  });
});

describe("routing context derivation", () => {
  const features = { ambiguity: "low", interactivity: "single_response" };

  it("applies a language affinity only for a single measured language", () => {
    assert.equal(deriveRoutingContext(features, ["go", "shell"]).language, "go");
    assert.equal(deriveRoutingContext(features, ["typescript", "javascript"]).language, "typescript");
    // Kotlin, Ruby, HCL, Helm, protobuf and Kafka work is unmeasured, so no affinity is applied.
    assert.equal(deriveRoutingContext(features, ["kotlin", "ruby"]).language, undefined);
    assert.equal(deriveRoutingContext(features, ["go", "python"]).language, undefined);
  });

  it("maps classifier features onto the scoring axes", () => {
    assert.equal(deriveRoutingContext({ ...features, ambiguity: "high" }, []).hardTask, true);
    assert.equal(deriveRoutingContext({ ...features, interactivity: "autonomous" }, []).unattended, true);
    assert.equal(deriveRoutingContext({ ...features, interactivity: "developer_loop" }, []).foreground, true);
    const conservative = deriveRoutingContext(features, []);
    assert.deepEqual(
      { hardTask: conservative.hardTask, unattended: conservative.unattended, foreground: conservative.foreground },
      { hardTask: false, unattended: false, foreground: false },
    );
  });

  it("keeps a foreground developer loop on the latency-competitive candidate", () => {
    const foreground = selectOrdinaryRoute(
      "median_repository_implementation",
      registry(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      deriveRoutingContext({ ...FEATURES, interactivity: "developer_loop" }, ["typescript"]),
    );
    assert.equal(foreground.kind, "ordinary");
    assert.equal(foreground.primary.modelId, "gpt-5.6-sol");
    assert.equal(foreground.primary.effort, "high");
  });

  it("authorizes the hard-task escalation candidate as a retry but never as the primary", () => {
    const hard = selectOrdinaryRoute(
      "median_repository_implementation",
      registry(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      deriveRoutingContext({ ...FEATURES, ambiguity: "high" }, []),
    );
    assert.equal(hard.kind, "ordinary");
    assert.notEqual(hard.primary.modelId, "gpt-5.6-luna");
    assert.equal(hard.primary.escalationOnly, undefined);
    const escalation = hard.fallbacks.find((choice) => choice.modelId === "gpt-5.6-luna");
    assert.ok(escalation, "hard tasks must authorize the escalation candidate as a retry");
    assert.equal(escalation.effort, "max");
    assert.equal(escalation.escalationOnly, true);

    const routine = selectOrdinaryRoute("median_repository_implementation", registry(), REQUIREMENTS);
    assert.ok(
      [routine.primary, ...routine.fallbacks].every((choice) => choice.modelId !== "gpt-5.6-luna"),
      "routine tasks must not authorize the escalation candidate at all",
    );
  });
});

describe("weakly evidenced language tendencies", () => {
  it("breaks a Ruby near-tie toward Anthropic without overriding a materially better score", () => {
    const ruby = selectOrdinaryRoute(
      "median_repository_implementation",
      registry(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      deriveRoutingContext(FEATURES, ["ruby"]),
    );
    assert.equal(ruby.kind, "ordinary");
    // gpt-5.6-sol@high and claude-opus-5@medium sit within the near-tie band on corpus-wide priors,
    // so Ruby's low-power Anthropic tendency settles it.
    assert.equal(ruby.primary.modelId, "claude-opus-5");
    assert.equal(ruby.primary.effort, "medium");
    // The tendency reorders only; it does not claim a Ruby-specific pass rate.
    assert.equal(ruby.primary.evidenceLanguage, undefined);
  });

  it("does not let a tendency promote a candidate outside the near-tie band", () => {
    const ruby = selectOrdinaryRoute(
      "highest_risk_advisory",
      registry(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      deriveRoutingContext(FEATURES, ["ruby"]),
    );
    assert.equal(ruby.kind, "ordinary");
    // The pin already selects Opus 5 here, so assert the weaker Anthropic tier did not jump the queue.
    assert.equal(ruby.primary.effort, "max");
  });

  it("leaves Kotlin work on the corpus-wide ordering", () => {
    const kotlin = selectOrdinaryRoute(
      "median_repository_implementation",
      registry(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      deriveRoutingContext(FEATURES, ["kotlin"]),
    );
    const unmeasured = selectOrdinaryRoute("median_repository_implementation", registry(), REQUIREMENTS);
    assert.equal(kotlin.kind, "ordinary");
    assert.equal(kotlin.primary.modelId, unmeasured.primary.modelId);
    assert.equal(kotlin.primary.effort, unmeasured.primary.effort);
  });
});

describe("balanced tier and scoped frugal candidate", () => {
  function withExtras() {
    return [
      ...registry(),
      model("amazon-bedrock", "openai.gpt-oss-120b", "openai", 128_000),
      model("anthropic", "claude-opus-4-6", "anthropic"),
      model("github-copilot", "claude-opus-4.6", "anthropic"),
    ];
  }

  it("keeps non-agentic archetypes on their declared order despite agentic priors", () => {
    // The corpus does not measure classification or extraction, so a multi-step repository pass rate
    // must not reorder these pools.
    const readOnlyContext = deriveRoutingContext({ ...FEATURES, actionMode: "information_only" }, []);
    const classification = selectOrdinaryRoute(
      "fast_classification",
      withExtras(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      readOnlyContext,
    );
    assert.equal(classification.kind, "ordinary");
    assert.equal(classification.primary.modelId, "gpt-5.6-luna");
    assert.equal(classification.primary.effort, "low");
    assert.equal(classification.primary.rankReason, "bootstrap");

    const extraction = selectOrdinaryRoute(
      "exact_extraction",
      withExtras(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      readOnlyContext,
    );
    assert.equal(extraction.primary.modelId, "gpt-5.6-terra");
    assert.equal(extraction.primary.effort, "medium");
    assert.equal(extraction.primary.rankReason, "bootstrap");
  });

  it("never routes the generation-superseded core models, even though they are scoped in", () => {
    const readOnly = deriveRoutingContext({ ...FEATURES, actionMode: "information_only" }, []);
    for (const archetype of Object.keys(BOOTSTRAP_ROUTE_POLICIES)) {
      const decision = selectOrdinaryRoute(archetype, withExtras(), REQUIREMENTS, [], undefined, undefined, readOnly);
      assert.equal(decision.kind, "ordinary");
      for (const choice of [decision.primary, ...decision.fallbacks]) {
        assert.ok(
          choice.logicalModelId !== "gpt-5.5" && choice.logicalModelId !== "gpt-5.4",
          `${archetype} routed retired ${choice.logicalModelId}`,
        );
      }
    }
  });

  it("never routes gpt-5.4-mini, which is present in the registry but no longer a candidate", () => {
    // The rung was admitted purely on a per-token-price argument: roughly 0.75 of gpt-5.6-luna, with a
    // 1.33-turn break-even. The pinned registry inverted that relationship, so the argument and the
    // rung were both withdrawn. The endpoint is still in the fixture registry, which is exactly why
    // this guard exists: being reachable must not make it routable.
    const readOnlyOneShot = deriveRoutingContext(
      { ...FEATURES, actionMode: "information_only", horizon: "one_response", expectedAgentTurns: 1 },
      [],
    );
    for (const archetype of Object.keys(BOOTSTRAP_ROUTE_POLICIES)) {
      const decision = selectOrdinaryRoute(
        archetype,
        withExtras(),
        REQUIREMENTS,
        [],
        undefined,
        undefined,
        readOnlyOneShot,
      );
      assert.equal(decision.kind, "ordinary");
      for (const choice of [decision.primary, ...decision.fallbacks]) {
        assert.notEqual(choice.logicalModelId, "gpt-5.4-mini", `${archetype} routed the withdrawn peer rung`);
      }
    }
  });

  it("authorizes gpt-oss-120b for bounded work only, and only on its Bedrock route", () => {
    const extraction = selectOrdinaryRoute(
      "exact_extraction",
      withExtras(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      deriveRoutingContext({ ...FEATURES, actionMode: "information_only" }, []),
    );
    const oss = [extraction.primary, ...extraction.fallbacks].find(
      (choice) => choice.logicalModelId === "gpt-oss-120b",
    );
    assert.ok(oss, "gpt-oss-120b must be an authorized extraction fallback");
    assert.equal(oss.provider, "amazon-bedrock");
    // An open-weight model has no first-party hosted route, so it has no manufacturer tier.
    assert.equal(oss.endpointTier, "resale");

    // It is not authorized for repository-mutating work at all.
    const mutating = selectOrdinaryRoute("median_repository_implementation", withExtras(), REQUIREMENTS);
    assert.ok([mutating.primary, ...mutating.fallbacks].every((choice) => choice.logicalModelId !== "gpt-oss-120b"));
  });

  it("admits the balanced mid tier as fallbacks without letting it take a mutating primary", () => {
    const median = selectOrdinaryRoute("median_repository_implementation", withExtras(), REQUIREMENTS);
    const chain = [median.primary, ...median.fallbacks].map((choice) => `${choice.logicalModelId}@${choice.effort}`);
    assert.ok(chain.includes("gpt-5.6-terra@high"), "terra@high should be an authorized mid fallback");
    assert.equal(median.primary.logicalModelId, "gpt-5.6-sol");

    const algorithmic = selectOrdinaryRoute("algorithmic_iterative_coding", withExtras(), REQUIREMENTS);
    const algoChain = [algorithmic.primary, ...algorithmic.fallbacks].map(
      (choice) => `${choice.logicalModelId}@${choice.effort}`,
    );
    assert.ok(algoChain.includes("gpt-5.6-luna@high"), "luna@high should be authorized above its regression cliff");
    assert.ok(
      algoChain.every((entry) => !entry.startsWith("gpt-5.6-luna@low") && !entry.startsWith("gpt-5.6-luna@medium")),
      "luna below high stays barred from mutating work",
    );
  });

  it("excludes the frugal scoped candidate unless steps are the binding constraint", () => {
    const roomy = selectOrdinaryRoute("median_repository_implementation", withExtras(), REQUIREMENTS);
    assert.ok(
      [roomy.primary, ...roomy.fallbacks].every((choice) => choice.logicalModelId !== "claude-opus-4-6"),
      "a roomy, token-billed route has no reason to use the frugal candidate",
    );
    assert.ok(roomy.exclusions.some((exclusion) => exclusion.code === "scope_unmet"));

    // Constrained headroom: the estimate consumes more than half the window.
    const tight = selectOrdinaryRoute("median_repository_implementation", withExtras(), {
      ...REQUIREMENTS,
      estimatedFinishedTokens: 600_000,
    });
    assert.equal(tight.kind, "ordinary");
    assert.ok(
      [tight.primary, ...tight.fallbacks].some((choice) => choice.logicalModelId === "claude-opus-4-6"),
      "constrained headroom authorizes the frugal candidate",
    );
  });
});

describe("consequence gating invariants", () => {
  const IRREVERSIBLE = { ...FEATURES, actionMode: "external_side_effect" };

  it("keeps every archetype routable for irreversible work", () => {
    // Regression guard: both non-agentic pools were once entirely ability band 1, which made an
    // irreversible task in those archetypes unroutable rather than merely expensive.
    for (const archetype of Object.keys(BOOTSTRAP_ROUTE_POLICIES)) {
      if (archetype === "code_review") continue;
      const decision = selectOrdinaryRoute(
        archetype,
        registry(),
        REQUIREMENTS,
        [],
        undefined,
        undefined,
        deriveRoutingContext(IRREVERSIBLE, []),
      );
      assert.equal(decision.kind, "ordinary", `${archetype} became unroutable for irreversible work`);
    }
  });

  it("bars the lowest ability band from irreversible work in every archetype", () => {
    for (const archetype of Object.keys(BOOTSTRAP_ROUTE_POLICIES)) {
      if (archetype === "code_review") continue;
      const decision = selectOrdinaryRoute(
        archetype,
        registry(),
        REQUIREMENTS,
        [],
        undefined,
        undefined,
        deriveRoutingContext(IRREVERSIBLE, []),
      );
      for (const choice of [decision.primary, ...decision.fallbacks]) {
        assert.ok(choice.ability >= 2, `${archetype} allowed ability ${String(choice.ability)} on irreversible work`);
      }
    }
  });

  it("escalates critical risk to the irreversible tier even for a read-only action mode", () => {
    const context = deriveRoutingContext({ ...FEATURES, actionMode: "local_read", risk: "critical" }, []);
    assert.equal(context.consequence, "irreversible");
    const benign = deriveRoutingContext({ ...FEATURES, actionMode: "local_read", risk: "medium" }, []);
    assert.equal(benign.consequence, "read_only");
  });

  it("discounts the regression term when the task runs the tests that would catch it", () => {
    const none = deriveRoutingContext({ ...FEATURES, verificationStrength: "none" }, []);
    const unit = deriveRoutingContext({ ...FEATURES, verificationStrength: "unit_tests" }, []);
    const integration = deriveRoutingContext({ ...FEATURES, verificationStrength: "integration_tests" }, []);
    // Pin the actual values rather than only their ordering, so a silent reweighting fails the test.
    assert.equal(none.verificationDiscount, 1);
    assert.equal(
      deriveRoutingContext({ ...FEATURES, verificationStrength: "self_check" }, []).verificationDiscount,
      0.85,
    );
    assert.equal(unit.verificationDiscount, 0.5);
    assert.equal(integration.verificationDiscount, 0.25);
    assert.equal(
      deriveRoutingContext({ ...FEATURES, verificationStrength: "security_and_policy" }, []).verificationDiscount,
      0.25,
    );
  });

  it("keeps tracked review independent even when the builder is a low tier", () => {
    const models = registry();
    const builder = models.find((candidate) => candidate.modelId === "gpt-5.6-terra");
    const decision = selectReviewRoute(models, REQUIREMENTS, builder, "medium", 2);
    assert.equal(decision.kind, "review");
    assert.ok([decision.primary, ...decision.fallbacks].every((choice) => choice.vendor !== builder.vendor));
  });
});

describe("escalation-only candidates can never be a first attempt", () => {
  const HARD = {
    ambiguity: "high",
    interactivity: "single_response",
    actionMode: "reversible_mutation",
    risk: "medium",
    verificationStrength: "none",
  };

  it("never takes the primary slot in any archetype, even when it is the only eligible model", () => {
    // Degenerate registry: the escalation candidate is the only model, at its only authorized effort.
    // Previously the demotion lived inside one ranking branch and used `findIndex(...) > 0`, so it
    // failed open here and handed every archetype its least reliable configuration as a first attempt.
    const only = [model("openai-codex", "gpt-5.6-luna", "openai"), model("openai", "gpt-5.6-luna", "openai")].map(
      (candidate) => ({ ...candidate, supportedEfforts: ["max"] }),
    );
    const context = deriveRoutingContext(HARD, []);
    for (const archetype of Object.keys(BOOTSTRAP_ROUTE_POLICIES)) {
      if (archetype === "code_review") continue;
      const decision = selectOrdinaryRoute(archetype, only, REQUIREMENTS, [], undefined, undefined, context);
      if (decision.kind === "ordinary") {
        assert.notEqual(
          decision.primary.escalationOnly,
          true,
          `${archetype} promoted an escalation-only candidate to primary`,
        );
      } else {
        // Failing closed is the correct outcome: the previous selection is preserved.
        assert.equal(decision.kind, "unroutable");
        assert.ok(decision.exclusions.some((exclusion) => exclusion.code === "escalation_without_primary"));
      }
    }
  });

  it("applies the rule to archetypes that are not evidence ranked", () => {
    // fast_classification and exact_extraction return early from ranking, so the invariant has to be
    // enforced outside that branch.
    for (const archetype of ["fast_classification", "exact_extraction"]) {
      const decision = selectOrdinaryRoute(
        archetype,
        registry(),
        REQUIREMENTS,
        [],
        undefined,
        undefined,
        deriveRoutingContext({ ...HARD, actionMode: "information_only" }, []),
      );
      assert.equal(decision.kind, "ordinary");
      assert.notEqual(decision.primary.escalationOnly, true);
      // luna at low effort is the legitimate declared classification primary; only luna at max is the
      // escalation candidate, so the check is on the flag and the effort, not on the model name.
      assert.notEqual(decision.primary.effort, "max");
      assert.ok(
        [decision.primary, ...decision.fallbacks].every(
          (choice) => choice.escalationOnly !== true || choice !== decision.primary,
        ),
      );
    }
  });

  it("keeps it available as a retry when an ordinary candidate exists", () => {
    const decision = selectOrdinaryRoute(
      "median_repository_implementation",
      registry(),
      REQUIREMENTS,
      [],
      undefined,
      undefined,
      deriveRoutingContext(HARD, []),
    );
    assert.equal(decision.kind, "ordinary");
    const escalation = decision.fallbacks.find((choice) => choice.escalationOnly === true);
    assert.ok(escalation, "the escalation candidate must remain an authorized retry");
    assert.equal(escalation.modelId, "gpt-5.6-luna");
    assert.equal(escalation.effort, "max");
    // It is last in the chain, after every ordinary candidate.
    assert.equal(decision.fallbacks.at(-1).escalationOnly, true);
  });
});

describe("scope and health drive the candidate pool", () => {
  function endpoint(provider, modelId, vendor, extra = {}) {
    return { ...model(provider, modelId, vendor), ...extra };
  }

  it("resolves a logical model to whichever endpoints are actually present", () => {
    // Only Bedrock region profiles are scoped in for Opus 5 here; the Anthropic route is absent.
    const bedrockOnly = [
      endpoint("amazon-bedrock", "us.anthropic.claude-opus-5", "anthropic"),
      endpoint("amazon-bedrock", "global.anthropic.claude-opus-5", "anthropic"),
      endpoint("openai-codex", "gpt-5.6-sol", "openai"),
    ];
    const decision = selectOrdinaryRoute("implementation_planning", bedrockOnly, REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    assert.equal(decision.primary.logicalModelId, "claude-opus-5");
    assert.equal(decision.primary.provider, "amazon-bedrock");
    // The bare-ish global profile is preferred over the regional one.
    assert.equal(decision.primary.modelId, "global.anthropic.claude-opus-5");
    assert.equal(decision.fallbacks[0].modelId, "us.anthropic.claude-opus-5");
  });

  it("lets weighted cost outrank endpoint-tier metadata when direct and Bedrock both exist", () => {
    const both = [
      endpoint("amazon-bedrock", "global.anthropic.claude-opus-5", "anthropic"),
      endpoint("anthropic", "claude-opus-5", "anthropic"),
      endpoint("openai-codex", "gpt-5.6-sol", "openai"),
    ];
    const decision = selectOrdinaryRoute("implementation_planning", both, REQUIREMENTS);
    assert.equal(decision.primary.provider, "amazon-bedrock");
    assert.equal(decision.primary.endpointTier, "resale");
    assert.equal(decision.fallbacks[0].provider, "anthropic");
  });

  it("reports a model that is not in scope rather than pretending it was unavailable", () => {
    const withoutOpus = [endpoint("openai-codex", "gpt-5.6-sol", "openai")];
    const decision = selectOrdinaryRoute("median_repository_implementation", withoutOpus, REQUIREMENTS);
    assert.ok(
      decision.exclusions.some(
        (exclusion) => exclusion.code === "not_in_scope" && exclusion.candidate.startsWith("claude-opus-5@"),
      ),
    );
  });

  it("excludes an endpoint a probe found broken, and keeps a transient failure usable", () => {
    const registryWithHealth = [
      endpoint("anthropic", "claude-opus-5", "anthropic", {
        health: { provider: "anthropic", modelId: "claude-opus-5", status: "client_error", httpStatus: 400 },
      }),
      endpoint("amazon-bedrock", "global.anthropic.claude-opus-5", "anthropic", {
        health: { provider: "amazon-bedrock", modelId: "global.anthropic.claude-opus-5", status: "server_error" },
      }),
      endpoint("openai-codex", "gpt-5.6-sol", "openai"),
    ];
    const decision = selectOrdinaryRoute("implementation_planning", registryWithHealth, REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    // The 400 endpoint is dropped; the 5xx endpoint remains because a provider outage is transient.
    assert.equal(decision.primary.provider, "amazon-bedrock");
    assert.ok(
      decision.exclusions.some(
        (exclusion) => exclusion.code === "endpoint_unhealthy" && exclusion.candidate === "anthropic/claude-opus-5",
      ),
    );
  });

  it("supplies a Google reviewer from whichever Gemini generation is scoped in", () => {
    // On a machine without gemini-3.6-flash, the chain degrades rather than leaving Google absent, so
    // independent review keeps two non-builder vendors.
    const olderGemini = [
      endpoint("openai-codex", "gpt-5.6-sol", "openai"),
      endpoint("anthropic", "claude-opus-5", "anthropic"),
      endpoint("google-vertex", "gemini-2.5-pro", "google"),
    ];
    const builder = olderGemini.find((candidate) => candidate.modelId === "gpt-5.6-sol");
    const decision = selectReviewRoute(olderGemini, REQUIREMENTS, builder, "high", 3);
    assert.equal(decision.kind, "review");
    const vendors = new Set([decision.primary, ...decision.fallbacks].map((choice) => choice.vendor));
    assert.deepEqual(vendors, new Set(["anthropic", "google"]));
  });

  it("refuses to route a disqualified Gemini generation even when it is the only one scoped", () => {
    const disqualifiedOnly = [
      endpoint("openai-codex", "gpt-5.6-sol", "openai"),
      endpoint("anthropic", "claude-opus-5", "anthropic"),
      endpoint("github-copilot", "gemini-3.5-flash", "google"),
    ];
    const builder = disqualifiedOnly.find((candidate) => candidate.modelId === "gpt-5.6-sol");
    const decision = selectReviewRoute(disqualifiedOnly, REQUIREMENTS, builder, "high", 3);
    // Two independent vendors are required, and a measured-overflow model is not an acceptable one.
    assert.equal(decision.kind, "unroutable");
  });
});

describe("previous-generation Opus exclusion", () => {
  it("does not recover Opus 4.8 through a gateway when current-generation fallbacks exist", () => {
    const models = [...registry(), model("github-copilot", "claude-opus-4-8", "anthropic")];
    for (const archetype of ["implementation_planning", "large_program_planning", "highest_risk_advisory"]) {
      const decision = selectOrdinaryRoute(archetype, models, REQUIREMENTS);
      assert.equal(decision.kind, "ordinary", decision.reason);
      assert.ok(
        [decision.primary, ...decision.fallbacks].every((choice) => choice.logicalModelId !== "claude-opus-4-8"),
        `${archetype} recovered a removed previous-generation profile`,
      );
    }
  });
});

describe("isStandaloneReviewRequest", () => {
  it("detects explicit review verbs and pull-request references only", () => {
    for (const prompt of [
      "Review this change for risk",
      "Please audit the migration script",
      "Inspect the failing job",
      "Can you look over my patch",
      "Take a pass at PR #305",
      "Take a pass at PR # 305",
      "Check https://github.com/acme/widgets/pull/42 before we merge",
      "opinions on pull request 7",
    ]) {
      assert.equal(isStandaloneReviewRequest(prompt), true, prompt);
    }
    for (const prompt of [
      "Implement the retry policy",
      "Rotate the production credential",
      "Explain how the router picks a model",
      "Fix the flaky test in shard 3",
    ]) {
      assert.equal(isStandaloneReviewRequest(prompt), false, prompt);
    }
  });
});
