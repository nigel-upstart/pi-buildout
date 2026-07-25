import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveArchetype } from "./archetype.ts";
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

const GO = { hardTask: false, unattended: false, foreground: false, language: "go" };
const TYPESCRIPT = { ...GO, language: "typescript" };
const HARD_GO = { ...GO, hardTask: true };

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

  it("excludes low-effort tiers from repository-mutating archetypes but keeps them for read-only ones", () => {
    const mutating = selectOrdinaryRoute("median_repository_implementation", registry(), REQUIREMENTS);
    assert.equal(mutating.kind, "ordinary");
    assert.ok(
      [mutating.primary, ...mutating.fallbacks].every(
        (choice) => !(choice.modelId === "gpt-5.6-terra" && (choice.effort === "low" || choice.effort === "medium")),
      ),
    );
    const readOnly = selectOrdinaryRoute("exact_extraction", registry(), REQUIREMENTS);
    assert.equal(readOnly.kind, "ordinary");
    assert.equal(readOnly.primary.modelId, "gpt-5.6-terra");
    assert.equal(readOnly.primary.effort, "medium");
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

    const matureSamples = [
      ...samples,
      { ...samples[0], provider: "anthropic", modelId: "claude-opus-5", p75ModelAndToolCost: 1 },
    ];
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
      deriveRoutingContext({ ambiguity: "low", interactivity: "developer_loop" }, ["typescript"]),
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
      deriveRoutingContext({ ambiguity: "high", interactivity: "single_response" }, []),
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
      deriveRoutingContext({ ambiguity: "low", interactivity: "single_response" }, ["ruby"]),
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
      deriveRoutingContext({ ambiguity: "low", interactivity: "single_response" }, ["ruby"]),
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
      deriveRoutingContext({ ambiguity: "low", interactivity: "single_response" }, ["kotlin"]),
    );
    const unmeasured = selectOrdinaryRoute("median_repository_implementation", registry(), REQUIREMENTS);
    assert.equal(kotlin.kind, "ordinary");
    assert.equal(kotlin.primary.modelId, unmeasured.primary.modelId);
    assert.equal(kotlin.primary.effort, unmeasured.primary.effort);
  });
});
