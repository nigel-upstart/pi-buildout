import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveArchetype } from "./archetype.ts";
import { BOOTSTRAP_ROUTE_POLICIES } from "./policy.ts";
import { conservativeFeatures } from "./features.ts";
import {
  canonicalVendor,
  deriveRoutingContext,
  isControlledHoldout,
  registrySnapshotId,
  robustCostToDone,
  selectOrdinaryRoute,
  selectReviewRoute,
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
    model("openai-codex", "gpt-5.5", "openai"),
    model("openai-codex", "gpt-5.4", "openai"),
    model("anthropic", "claude-haiku-4-5", "anthropic"),
    model("anthropic", "claude-sonnet-5", "anthropic"),
    model("anthropic", "claude-opus-5", "anthropic"),
    model("anthropic", "claude-fable-5", "anthropic"),
    model("google-vertex", "gemini-3.6-flash", "google"),
  ];
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

  it("puts the manufacturer endpoint first and same-model backups immediately after it", () => {
    const models = [
      ...registry(),
      model("openai", "gpt-5.6-sol", "openai"),
      model("amazon-bedrock", "openai.gpt-5.6-sol", "openai"),
    ];
    const decision = selectOrdinaryRoute("median_repository_implementation", models, REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    assert.equal(decision.primary.provider, "openai-codex");
    assert.equal(decision.primary.endpointTier, "manufacturer");
    const chain = [decision.primary, ...decision.fallbacks].map((choice) => `${choice.provider}/${choice.modelId}`);
    assert.deepEqual(chain.slice(0, 3), [
      "openai-codex/gpt-5.6-sol",
      "openai/gpt-5.6-sol",
      "amazon-bedrock/openai.gpt-5.6-sol",
    ]);
  });

  it("keeps a cheaper non-manufacturer endpoint behind the manufacturer route", () => {
    const models = [
      ...registry(),
      {
        ...model("amazon-bedrock", "global.anthropic.claude-opus-5", "anthropic"),
        costPerMillion: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0.01 },
      },
    ];
    const decision = selectOrdinaryRoute("implementation_planning", models, REQUIREMENTS);
    assert.equal(decision.kind, "ordinary");
    assert.equal(decision.primary.provider, "anthropic");
    assert.equal(decision.fallbacks[0].provider, "amazon-bedrock");
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
  it("selects both non-builder vendors and fixes the builder as final fallback", () => {
    const models = registry();
    const builder = models.find((candidate) => candidate.modelId === "gpt-5.6-terra");
    const decision = selectReviewRoute(models, REQUIREMENTS, builder, "medium", 2);
    assert.equal(decision.kind, "review");
    assert.deepEqual(new Set([decision.primary.vendor, decision.fallback.vendor]), new Set(["anthropic", "google"]));
    assert.equal(decision.builderFallback.vendor, "openai");
    assert.equal(decision.builderFallback.rankReason, "fixed_builder_fallback");
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
    const anthropic = [decision.primary, decision.fallback].find((choice) => choice.vendor === "anthropic");
    assert.equal(anthropic.modelId, "claude-fable-5");
  });

  it("rejects an unavailable fixed builder fallback", () => {
    const models = registry();
    const builder = { ...models.find((candidate) => candidate.modelId === "gpt-5.6-terra"), available: false };
    const decision = selectReviewRoute(
      models.map((candidate) => (candidate.modelId === builder.modelId ? builder : candidate)),
      REQUIREMENTS,
      builder,
      "medium",
      2,
    );
    assert.equal(decision.kind, "unroutable");
    assert.ok(decision.exclusions.some((exclusion) => exclusion.code === "unavailable"));
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
    assert.match(snapshot, /^registry-v1:10:[0-9a-f]{16}$/);
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

  it("still reviews with the builder as final fallback even when the builder is a low tier", () => {
    // Review is a read-only judgment, so a builder whose effort is barred from state-changing work
    // must still be able to review its own output.
    const models = registry();
    const builder = models.find((candidate) => candidate.modelId === "gpt-5.6-terra");
    const decision = selectReviewRoute(models, REQUIREMENTS, builder, "medium", 2);
    assert.equal(decision.kind, "review");
    assert.equal(decision.builderFallback.modelId, "gpt-5.6-terra");
    assert.equal(decision.builderFallback.effort, "medium");
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
