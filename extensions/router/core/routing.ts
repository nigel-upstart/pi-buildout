import type { Archetype } from "./archetype.ts";
import { authorizeEffort, findEvidencePrior, resolveEvidenceLanguage, scoreEvidencePrior } from "./evidence.ts";
import type { EvidenceCostWeights, EvidenceLanguageBucket, EvidenceScoreContext } from "./evidence.ts";
import type { TaskFeatures } from "./features.ts";
import {
  BOOTSTRAP_ROUTE_POLICIES,
  ENDPOINT_TIERS,
  HARD_TASK_ESCALATION_REFS,
  POLICY_VERSION,
  reviewerRefs,
} from "./policy.ts";
import type { CandidateRef, EndpointTier } from "./policy.ts";
import { findPromptProfile } from "./profiles.ts";
import type { EffortLevel, ModelVendor } from "./profiles.ts";

export type RegistryModelSnapshot = {
  provider: string;
  modelId: string;
  name: string;
  vendor: ModelVendor;
  contextWindow: number;
  maxOutputTokens: number;
  available: boolean;
  reasoning: boolean;
  supportedEfforts: readonly EffortLevel[];
  inputTypes: readonly ("text" | "image")[];
  toolCapable: boolean;
  costPerMillion: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

export type RouteRequirements = {
  estimatedFinishedTokens: number;
  requiresImages: boolean;
  requiresTools: boolean;
};

type ExclusionCode =
  | "not_in_registry"
  | "unavailable"
  | "context_headroom"
  | "context_headroom_prior"
  | "image_unsupported"
  | "tools_unsupported"
  | "effort_unsupported"
  | "effort_unauthorized"
  | "thrash_guard"
  | "profile_missing"
  | "duplicate_model"
  | "fallback_vendor";

type CandidateExclusion = {
  candidate: string;
  code: ExclusionCode;
  detail: string;
};

type RouteScoreComponents = {
  p75ModelAndToolCost: number;
  developerWaitCost: number;
  humanInterventionCost: number;
  retryCost: number;
};

export type RouteChoice = {
  provider: string;
  modelId: string;
  /** Manufacturer model ID shared by every endpoint serving this model. */
  logicalModelId: string;
  vendor: ModelVendor;
  effort: EffortLevel;
  ability: number;
  profileId: string;
  contextWindow: number;
  endpointTier: EndpointTier;
  /** Blended per-million route price, absent for flat-rate subscription endpoints. */
  endpointBlendedCost?: number;
  /** Authorized as a retry only; never placed in the primary slot. */
  escalationOnly?: boolean;
  score?: number;
  scoreComponents?: RouteScoreComponents;
  evidenceScore?: number;
  evidenceLanguage?: EvidenceLanguageBucket;
  rankReason:
    "bootstrap" | "evidence_prior" | "telemetry" | "controlled_holdout" | "review_ability" | "fixed_builder_fallback";
};

export type RouteSample = {
  provider: string;
  modelId: string;
  archetype: Archetype;
  contextBucket?: string;
  risk?: string;
  interactivity?: string;
  languageBucket?: string;
  comparableSamples: number;
  acceptedRate: number;
  p50ModelAndToolCost?: number;
  p75ModelAndToolCost: number;
  p90ModelAndToolCost?: number;
  p50WallTimeMs?: number;
  p75WallTimeMs: number;
  p90WallTimeMs?: number;
  probabilityHumanIntervention: number;
  probabilityRetry: number;
};

export type CostWeights = {
  developerWaitValuePerMs: number;
  humanInterventionCost: number;
  retryCost: number;
};

type OrdinaryRouteDecision = {
  kind: "ordinary";
  policyVersion: string;
  archetype: Archetype;
  primary: RouteChoice;
  // Every eligible endpoint after the selected primary remains authorized for
  // sequential availability recovery. This includes alternate providers for
  // the same model, which is essential when one provider's credentials fail.
  fallbacks: RouteChoice[];
  exclusions: CandidateExclusion[];
  telemetryMature: boolean;
  controlledHoldout: boolean;
};

type ReviewRouteDecision = {
  kind: "review";
  policyVersion: string;
  archetype: "code_review";
  primary: RouteChoice;
  fallback: RouteChoice;
  builderFallback: RouteChoice;
  exclusions: CandidateExclusion[];
  telemetryMature: boolean;
  ceilingMismatchVendors: ModelVendor[];
};

type UnroutableDecision = {
  kind: "unroutable";
  policyVersion: string;
  archetype: Archetype;
  reason: string;
  exclusions: CandidateExclusion[];
};

export type RouteDecision = OrdinaryRouteDecision | ReviewRouteDecision | UnroutableDecision;

const DEFAULT_COST_WEIGHTS: CostWeights = {
  developerWaitValuePerMs: 0.000_001,
  humanInterventionCost: 25,
  retryCost: 10,
};

/**
 * Evidence-prior weights extend the telemetry weights with two axes the priors can price and
 * observed samples cannot yet: measured regression breakage on repository-mutating work, and
 * measured nondeterminism on unattended work.
 */
const DEFAULT_EVIDENCE_WEIGHTS: EvidenceCostWeights = {
  ...DEFAULT_COST_WEIGHTS,
  regressionBreakCost: 40,
  nondeterminismCost: 15,
};

/** Foreground developer loops price wall time far higher than background work. */
const FOREGROUND_WAIT_MULTIPLIER = 8;

/** Output-weighted blend used only to order endpoints that resolve to the same model and effort. */
function blendedEndpointCost(model: RegistryModelSnapshot): number {
  return 0.25 * model.costPerMillion.input + 0.75 * model.costPerMillion.output;
}

/**
 * Task shape that modifies scoring without changing which models are policy-authorized. Derived
 * from trusted harness state and classifier features by the extension, never from route cost.
 */
export type RoutingContext = {
  /** Present only when the repository resolves to exactly one measured language. */
  language?: EvidenceLanguageBucket | undefined;
  /** High ambiguity or high complexity work; selects the measured hard-task priors. */
  hardTask: boolean;
  /** Autonomous work where a non-deterministic pass is not usable. */
  unattended: boolean;
  /** Foreground developer loop, where wall time dominates. */
  foreground: boolean;
};

const DEFAULT_ROUTING_CONTEXT: RoutingContext = {
  hardTask: false,
  unattended: false,
  foreground: false,
};

/**
 * Derives the scoring context from trusted harness state and classifier features. It changes how
 * authorized candidates are ordered; it never adds or removes a candidate, and it never consults
 * route price.
 */
export function deriveRoutingContext(
  features: Pick<TaskFeatures, "ambiguity" | "interactivity">,
  languageBuckets: readonly string[],
): RoutingContext {
  const language = resolveEvidenceLanguage(languageBuckets);
  return {
    ...DEFAULT_ROUTING_CONTEXT,
    ...(language ? { language } : {}),
    // High ambiguity is the classifier's own signal that the task resembles the corpus's hard tail.
    hardTask: features.ambiguity === "high",
    // Autonomous work cannot rely on a human noticing a non-deterministic pass.
    unattended: features.interactivity === "autonomous",
    foreground: features.interactivity === "developer_loop",
  };
}

function evidenceScoreContext(archetype: Archetype, context: RoutingContext): EvidenceScoreContext {
  return {
    language: context.language,
    mutatesRepository: BOOTSTRAP_ROUTE_POLICIES[archetype].mutatesRepository,
    unattended: context.unattended,
    waitMultiplier: context.foreground ? FOREGROUND_WAIT_MULTIPLIER : 1,
    hardTask: context.hardTask,
  };
}

// Amazon Bedrock cross-region inference profiles prefix the underlying vendor path with a
// region code ("us.", "eu.", "au.", "jp.", "global."). Strip it only when it is immediately
// followed by a known vendor path segment so unrelated IDs are not misparsed.
const BEDROCK_REGION_PREFIX = /^(?:us|eu|au|jp|apac|global)\.(?=anthropic\.|openai\.|amazon\.)/;

export function canonicalVendor(provider: string, modelId: string): ModelVendor | undefined {
  const normalizedId = modelId.toLowerCase();
  const bareId = (normalizedId.split("/").at(-1) ?? normalizedId).replace(BEDROCK_REGION_PREFIX, "");
  if (
    bareId.startsWith("gpt-") ||
    bareId.startsWith("openai.gpt-") ||
    bareId.startsWith("o1") ||
    bareId.startsWith("o3")
  ) {
    return "openai";
  }
  if (bareId.startsWith("claude-") || bareId.startsWith("anthropic.claude-")) return "anthropic";
  if (bareId.startsWith("gemini-")) return "google";
  if (provider === "openai" || provider === "openai-codex") return "openai";
  if (provider === "anthropic") return "anthropic";
  if (provider === "google" || provider === "google-vertex") return "google";
  return undefined;
}

export function robustCostToDone(sample: RouteSample, weights: CostWeights = DEFAULT_COST_WEIGHTS): number {
  return (
    sample.p75ModelAndToolCost +
    weights.developerWaitValuePerMs * sample.p75WallTimeMs +
    weights.humanInterventionCost * sample.probabilityHumanIntervention +
    weights.retryCost * sample.probabilityRetry
  );
}

function modelKey(model: Pick<RegistryModelSnapshot, "provider" | "modelId">): string {
  return `${model.provider}/${model.modelId}`;
}

function findSnapshot(
  ref: CandidateRef,
  registry: readonly RegistryModelSnapshot[],
): RegistryModelSnapshot | undefined {
  return registry.find((model) => model.provider === ref.provider && model.modelId === ref.modelId);
}

function evaluateCandidate(
  ref: CandidateRef,
  registry: readonly RegistryModelSnapshot[],
  archetype: Archetype,
  requirements: RouteRequirements,
  exclusions: CandidateExclusion[],
  context: RoutingContext = DEFAULT_ROUTING_CONTEXT,
): RouteChoice | undefined {
  const key = `${ref.provider}/${ref.modelId}`;
  const model = findSnapshot(ref, registry);
  if (!model) {
    exclusions.push({ candidate: key, code: "not_in_registry", detail: "exact provider/model ID is absent" });
    return undefined;
  }
  if (!model.available) {
    exclusions.push({ candidate: key, code: "unavailable", detail: "endpoint auth/availability is not configured" });
    return undefined;
  }
  const policy = BOOTSTRAP_ROUTE_POLICIES[archetype];
  const authorization = authorizeEffort(ref.logicalModelId, ref.effort, {
    allowSuperSaturation: policy.allowSuperSaturation,
    mutatesRepository: policy.mutatesRepository,
    language: context.language,
  });
  if (!authorization.authorized) {
    exclusions.push({ candidate: key, code: "effort_unauthorized", detail: authorization.reason });
    return undefined;
  }
  const headroom = Math.floor(model.contextWindow * 0.7);
  if (requirements.estimatedFinishedTokens > headroom) {
    exclusions.push({
      candidate: key,
      code: "context_headroom",
      detail: `${String(requirements.estimatedFinishedTokens)} estimated tokens exceed 70% of ${String(model.contextWindow)}`,
    });
    return undefined;
  }
  const prior = findEvidencePrior(ref.logicalModelId, ref.effort);
  if (prior) {
    // The task estimate and the configuration's measured p90 peak context are alternative lower
    // bounds on what this run needs, so the window must accommodate the larger of the two rather
    // than their sum. This is what excludes max-effort OpenAI configurations on 272K windows.
    if (prior.p90PeakContextTokens > headroom) {
      exclusions.push({
        candidate: key,
        code: "context_headroom_prior",
        detail: `measured p90 peak context ${String(prior.p90PeakContextTokens)} exceeds 70% of ${String(model.contextWindow)}`,
      });
      return undefined;
    }
    if (prior.contextOverflowRate > 0.02) {
      exclusions.push({
        candidate: key,
        code: "thrash_guard",
        detail: `measured context-overflow rate ${prior.contextOverflowRate.toFixed(3)} exceeds 0.02`,
      });
      return undefined;
    }
    if (archetype === "long_context_synthesis" && prior.p90PeakContextTokens > Math.floor(model.contextWindow * 0.5)) {
      exclusions.push({
        candidate: key,
        code: "thrash_guard",
        detail: `long-context routes require p90 peak context under half the window; measured ${String(prior.p90PeakContextTokens)}`,
      });
      return undefined;
    }
  }
  if (requirements.requiresImages && !model.inputTypes.includes("image")) {
    exclusions.push({ candidate: key, code: "image_unsupported", detail: "route includes image input" });
    return undefined;
  }
  if (requirements.requiresTools && !model.toolCapable) {
    exclusions.push({ candidate: key, code: "tools_unsupported", detail: "route requires tools" });
    return undefined;
  }
  if (!model.supportedEfforts.includes(ref.effort)) {
    exclusions.push({ candidate: key, code: "effort_unsupported", detail: `${ref.effort} effort is unsupported` });
    return undefined;
  }
  const profile = findPromptProfile(model.vendor, model.modelId, archetype, ref.effort);
  if (!profile) {
    exclusions.push({
      candidate: key,
      code: "profile_missing",
      detail: `no validated ${archetype}/${ref.effort} profile exists`,
    });
    return undefined;
  }
  return {
    provider: model.provider,
    modelId: model.modelId,
    vendor: model.vendor,
    effort: ref.effort,
    ability: ref.ability,
    logicalModelId: ref.logicalModelId,
    profileId: profile.id,
    contextWindow: model.contextWindow,
    endpointTier: ref.endpointTier,
    ...(ref.flatRate ? {} : { endpointBlendedCost: blendedEndpointCost(model) }),
    ...(ref.escalationOnly ? { escalationOnly: true } : {}),
    rankReason: "bootstrap",
  };
}

function deduplicateChoices(choices: readonly RouteChoice[], exclusions: CandidateExclusion[]): RouteChoice[] {
  const seen = new Set<string>();
  return choices.filter((choice) => {
    // Deduplicate only an exact endpoint at an exact effort. Different providers for one model are
    // deliberate availability fallbacks, and the same endpoint at a different effort is a distinct
    // route choice that archetypes such as highest_risk_advisory rely on.
    const key = `${choice.provider}/${choice.modelId}@${choice.effort}`;
    if (seen.has(key)) {
      exclusions.push({
        candidate: key,
        code: "duplicate_model",
        detail: "the exact provider/model endpoint and effort is listed more than once",
      });
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function isControlledHoldout(key: string, oneIn = 20): boolean {
  let hash = 2166136261;
  for (const character of key) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % Math.max(1, oneIn) === 0;
}

/**
 * One logical (model, effort) choice and every eligible endpoint that serves it. Endpoints stay
 * grouped so an availability failure retries the same model before the router changes models.
 */
type CandidateGroup = {
  key: string;
  logicalModelId: string;
  effort: EffortLevel;
  endpoints: RouteChoice[];
};

/**
 * Endpoint order within one model: manufacturer route first, then gateway, then resale. Route price
 * only breaks ties inside a tier, and flat-rate subscription endpoints sort last in their tier
 * because their modeled token price is a capability proxy rather than a cost.
 */
function orderEndpoints(endpoints: readonly RouteChoice[]): RouteChoice[] {
  return [...endpoints].sort((left, right) => {
    const tier = ENDPOINT_TIERS.indexOf(left.endpointTier) - ENDPOINT_TIERS.indexOf(right.endpointTier);
    if (tier !== 0) return tier;
    const leftFlat = left.endpointBlendedCost === undefined;
    const rightFlat = right.endpointBlendedCost === undefined;
    if (leftFlat !== rightFlat) return leftFlat ? 1 : -1;
    return (left.endpointBlendedCost ?? 0) - (right.endpointBlendedCost ?? 0);
  });
}

function groupCandidates(choices: readonly RouteChoice[]): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();
  for (const choice of choices) {
    const key = `${choice.logicalModelId}@${choice.effort}`;
    const group = groups.get(key);
    if (group) group.endpoints.push(choice);
    else groups.set(key, { key, logicalModelId: choice.logicalModelId, effort: choice.effort, endpoints: [choice] });
  }
  return [...groups.values()].map((group) => ({ ...group, endpoints: orderEndpoints(group.endpoints) }));
}

function sampleFor(
  choice: RouteChoice,
  archetype: Archetype,
  samples: readonly RouteSample[],
): RouteSample | undefined {
  return samples.find(
    (sample) =>
      sample.provider === choice.provider && sample.modelId === choice.modelId && sample.archetype === archetype,
  );
}

function orderGroups(
  groups: CandidateGroup[],
  archetype: Archetype,
  qualityFloor: number,
  samples: readonly RouteSample[],
  weights: CostWeights | undefined,
  explorationKey: string | undefined,
  context: RoutingContext,
): { choices: RouteChoice[]; mature: boolean; controlledHoldout: boolean } {
  const primaries = groups.map((group) => group.endpoints[0]);
  const comparable = primaries.map((choice) => (choice ? sampleFor(choice, archetype, samples) : undefined));
  const mature =
    groups.length > 0 &&
    comparable.every((sample) => sample && sample.comparableSamples >= 30 && sample.acceptedRate >= qualityFloor);
  const controlledHoldout = explorationKey ? isControlledHoldout(explorationKey) : false;

  if (mature) {
    const appliedWeights = weights ?? DEFAULT_COST_WEIGHTS;
    const matureRankReason: RouteChoice["rankReason"] = controlledHoldout ? "controlled_holdout" : "telemetry";
    const scored = groups.map((group, index) => {
      const sample = comparable[index];
      if (!sample) throw new Error("mature route is missing its comparable telemetry sample");
      const score = robustCostToDone(sample, appliedWeights);
      const scoreComponents = {
        p75ModelAndToolCost: sample.p75ModelAndToolCost,
        developerWaitCost: appliedWeights.developerWaitValuePerMs * sample.p75WallTimeMs,
        humanInterventionCost: appliedWeights.humanInterventionCost * sample.probabilityHumanIntervention,
        retryCost: appliedWeights.retryCost * sample.probabilityRetry,
      };
      return {
        group,
        score,
        endpoints: group.endpoints.map((choice) => ({
          ...choice,
          score,
          scoreComponents,
          rankReason: matureRankReason,
        })),
      };
    });
    const ordered = controlledHoldout ? scored : scored.sort((left, right) => left.score - right.score);
    return { choices: ordered.flatMap((entry) => entry.endpoints), mature: true, controlledHoldout };
  }

  // Pre-telemetry ordering uses the measured evidence priors rather than policy list order, so a
  // cheap-but-weak configuration cannot win on token price and a strong configuration does not need
  // to be hand-placed first.
  const scoreContext = evidenceScoreContext(archetype, context);
  const scored = groups.map((group) => {
    const prior = findEvidencePrior(group.logicalModelId, group.effort);
    const evidence = prior ? scoreEvidencePrior(prior, DEFAULT_EVIDENCE_WEIGHTS, scoreContext) : undefined;
    return { group, evidence };
  });
  const ranked = scored
    .filter((entry) => entry.evidence !== undefined)
    .sort((left, right) => (left.evidence?.score ?? 0) - (right.evidence?.score ?? 0));
  // Candidates without evidence keep their declared policy order behind every scored candidate.
  const unscored = scored.filter((entry) => entry.evidence === undefined);
  const ordered = [...ranked, ...unscored];
  // A pinned primary is a deliberate capability-first prior for archetypes whose failure cost is
  // paid downstream rather than inside the task. It only reorders; it never adds a candidate.
  const pin = BOOTSTRAP_ROUTE_POLICIES[archetype].pinnedPrimary;
  const pinIndex = pin
    ? ordered.findIndex(
        (entry) => entry.group.logicalModelId === pin.logicalModelId && entry.group.effort === pin.effort,
      )
    : -1;
  if (pinIndex > 0) ordered.unshift(...ordered.splice(pinIndex, 1));
  // An escalation-only candidate may outrank the leaders on the hard-task prior, but its measured
  // flakiness makes it unsuitable for a first attempt, so it is demoted behind the best ordinary
  // candidate while staying authorized as a retry.
  if (ordered[0]?.group.endpoints[0]?.escalationOnly === true) {
    const ordinaryIndex = ordered.findIndex((entry) => entry.group.endpoints[0]?.escalationOnly !== true);
    if (ordinaryIndex > 0) ordered.unshift(...ordered.splice(ordinaryIndex, 1));
  }
  return {
    mature: false,
    controlledHoldout: false,
    choices: ordered.flatMap((entry) =>
      entry.group.endpoints.map((choice) => ({
        ...choice,
        ...(entry.evidence
          ? {
              evidenceScore: entry.evidence.score,
              ...(entry.evidence.languageUsed ? { evidenceLanguage: entry.evidence.languageUsed } : {}),
              rankReason: "evidence_prior" as const,
            }
          : {}),
      })),
    ),
  };
}

export function selectOrdinaryRoute(
  archetype: Exclude<Archetype, "code_review">,
  registry: readonly RegistryModelSnapshot[],
  requirements: RouteRequirements,
  samples: readonly RouteSample[] = [],
  weights?: CostWeights,
  explorationKey?: string,
  context: RoutingContext = DEFAULT_ROUTING_CONTEXT,
): RouteDecision {
  const policy = BOOTSTRAP_ROUTE_POLICIES[archetype];
  const exclusions: CandidateExclusion[] = [];
  // Hard, ambiguous work additionally authorizes the escalation prior as a retry candidate.
  const pool = context.hardTask
    ? [...policy.primary, ...policy.fallback, ...HARD_TASK_ESCALATION_REFS]
    : [...policy.primary, ...policy.fallback];
  const evaluated = pool
    .map((candidate) => evaluateCandidate(candidate, registry, archetype, requirements, exclusions, context))
    .filter((choice): choice is RouteChoice => choice !== undefined);
  const deduplicated = deduplicateChoices(evaluated, exclusions);
  const ranked = orderGroups(
    groupCandidates(deduplicated),
    archetype,
    policy.qualityFloor,
    samples,
    weights,
    explorationKey,
    context,
  );
  const [primary, ...fallbacks] = ranked.choices;

  if (!primary || fallbacks.length === 0) {
    return {
      kind: "unroutable",
      policyVersion: POLICY_VERSION,
      archetype,
      reason: "a primary and at least one eligible fallback endpoint were not available",
      exclusions,
    };
  }
  return {
    kind: "ordinary",
    policyVersion: POLICY_VERSION,
    archetype,
    primary,
    fallbacks,
    exclusions,
    telemetryMature: ranked.mature,
    controlledHoldout: ranked.controlledHoldout,
  };
}

function builderChoice(
  builder: RegistryModelSnapshot,
  builderEffort: EffortLevel,
  builderAbility: number,
  registry: readonly RegistryModelSnapshot[],
  requirements: RouteRequirements,
  exclusions: CandidateExclusion[],
): RouteChoice | undefined {
  const ability = Math.max(1, Math.min(4, Math.round(builderAbility))) as CandidateRef["ability"];
  const eligible = evaluateCandidate(
    {
      provider: builder.provider,
      modelId: builder.modelId,
      // A builder chosen by the user is its own logical model; it carries no resale chain.
      logicalModelId: builder.modelId,
      vendor: builder.vendor,
      effort: builderEffort,
      ability,
      endpointTier: "manufacturer",
      flatRate: false,
      allowAlias: false,
      restricted: false,
    },
    registry,
    "code_review",
    requirements,
    exclusions,
  );
  return eligible ? { ...eligible, rankReason: "fixed_builder_fallback" } : undefined;
}

export function selectReviewRoute(
  registry: readonly RegistryModelSnapshot[],
  requirements: RouteRequirements,
  builder: RegistryModelSnapshot,
  builderEffort: EffortLevel,
  builderAbility: number,
): RouteDecision {
  const exclusions: CandidateExclusion[] = [];
  const vendors = (["openai", "anthropic", "google"] as const).filter((vendor) => vendor !== builder.vendor);
  const ceilingMismatchVendors: ModelVendor[] = [];
  const choices: RouteChoice[] = [];

  for (const vendor of vendors) {
    const refsForVendor = reviewerRefs(vendor, builderAbility);
    const eligible = refsForVendor
      .map((ref) => evaluateCandidate(ref, registry, "code_review", requirements, exclusions))
      .find((choice): choice is RouteChoice => choice !== undefined);
    if (eligible) {
      if (eligible.ability < builderAbility) ceilingMismatchVendors.push(vendor);
      choices.push({ ...eligible, rankReason: "review_ability" });
    }
  }

  choices.sort((left, right) => {
    const leftDistance = Math.abs(left.ability - builderAbility);
    const rightDistance = Math.abs(right.ability - builderAbility);
    return leftDistance - rightDistance;
  });
  const fixedBuilder = builderChoice(builder, builderEffort, builderAbility, registry, requirements, exclusions);
  const primary = choices[0];
  const fallback = choices[1];
  if (choices.length !== 2 || !primary || !fallback || !fixedBuilder) {
    return {
      kind: "unroutable",
      policyVersion: POLICY_VERSION,
      archetype: "code_review",
      reason: "review requires two non-builder vendors and a validated fixed builder fallback",
      exclusions,
    };
  }
  return {
    kind: "review",
    policyVersion: POLICY_VERSION,
    archetype: "code_review",
    primary,
    fallback,
    builderFallback: fixedBuilder,
    exclusions,
    telemetryMature: false,
    ceilingMismatchVendors,
  };
}

export function registrySnapshotId(models: readonly RegistryModelSnapshot[]): string {
  const canonical = models
    .map(
      (model) =>
        `${modelKey(model)}:${String(model.contextWindow)}:${String(model.maxOutputTokens)}:${model.available ? "1" : "0"}:${model.supportedEfforts.join(",")}`,
    )
    .sort()
    .join("|");
  let first = 2166136261;
  let second = 2246822507;
  for (const character of canonical) {
    const code = character.codePointAt(0) ?? 0;
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489909);
  }
  return `registry-v1:${String(models.length)}:${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}
