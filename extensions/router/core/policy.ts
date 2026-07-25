import type { Archetype } from "./archetype.ts";
import { evidenceAbility } from "./evidence.ts";
import type { AbilityTier } from "./evidence.ts";
import { MODEL_VENDORS } from "./profiles.ts";
import type { EffortLevel, ModelVendor } from "./profiles.ts";

export const POLICY_VERSION = "router-policy-v5";

/**
 * Endpoint preference tiers. The model manufacturer's own route is always the primary instance for
 * a model; every other configured route for that same model is an ordered availability backup.
 * Route price only sorts endpoints within a tier — it never selects between different models.
 */
export const ENDPOINT_TIERS = ["manufacturer", "gateway", "resale"] as const;
export type EndpointTier = (typeof ENDPOINT_TIERS)[number];

export type CandidateRef = {
  provider: string;
  modelId: string;
  /**
   * The manufacturer's model ID, shared by every endpoint that serves the same model. Evidence
   * priors, effort policies, and ability bands are keyed by this, never by a resale endpoint ID.
   */
  logicalModelId: string;
  vendor: ModelVendor;
  effort: EffortLevel;
  ability: AbilityTier;
  endpointTier: EndpointTier;
  /** Flat-rate subscription endpoints are excluded from cost tiebreaks and sorted last in their tier. */
  flatRate: boolean;
  /**
   * Authorized only as a retry after a failed attempt, never as a first attempt. Used for the
   * hard-task escalation prior, whose measured hard-task lead comes with same-task flakiness too high
   * to make it any archetype's default.
   */
  escalationOnly?: boolean;
  allowAlias: boolean;
  restricted: boolean;
};

/** Direct-from-manufacturer providers, in the order pi should prefer them. */
const MANUFACTURER_PROVIDERS: Readonly<Record<ModelVendor, readonly string[]>> = {
  openai: ["openai-codex", "openai"],
  anthropic: ["anthropic"],
  google: ["google-vertex", "google"],
};

type BackupEndpoint = {
  provider: string;
  /** Provider-specific model ID; resale routes rarely reuse the manufacturer's ID verbatim. */
  modelId: string;
  tier: EndpointTier;
  flatRate?: boolean;
};

type ModelEndpointPolicy = {
  modelId: string;
  vendor: ModelVendor;
  backups: readonly BackupEndpoint[];
};

/**
 * Same-model backup routes. Bedrock entries use exact cross-region inference-profile IDs; Global
 * profiles precede regional ones because the cost report favors them for residual AWS traffic.
 * GitHub Copilot appears only where Copilot actually exposes the model — it has no Opus 4.8 or
 * Opus 5 route, so the Anthropic direct route is mandatory for those.
 */
const MODEL_ENDPOINTS: readonly ModelEndpointPolicy[] = [
  {
    modelId: "claude-opus-5",
    vendor: "anthropic",
    backups: [
      { provider: "amazon-bedrock", modelId: "global.anthropic.claude-opus-5", tier: "resale" },
      { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-5", tier: "resale" },
    ],
  },
  {
    modelId: "claude-fable-5",
    vendor: "anthropic",
    backups: [
      { provider: "amazon-bedrock", modelId: "global.anthropic.claude-fable-5", tier: "resale" },
      { provider: "amazon-bedrock", modelId: "us.anthropic.claude-fable-5", tier: "resale" },
    ],
  },
  {
    modelId: "claude-sonnet-5",
    vendor: "anthropic",
    backups: [
      { provider: "bifrost", modelId: "bedrock/anthropic.claude-sonnet-5", tier: "gateway" },
      { provider: "amazon-bedrock", modelId: "global.anthropic.claude-sonnet-5", tier: "resale" },
      { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-5", tier: "resale" },
    ],
  },
  {
    modelId: "claude-haiku-4-5",
    vendor: "anthropic",
    backups: [
      { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", tier: "resale" },
      { provider: "github-copilot", modelId: "claude-haiku-4.5", tier: "resale", flatRate: true },
    ],
  },
  {
    modelId: "gpt-5.6-sol",
    vendor: "openai",
    backups: [{ provider: "amazon-bedrock", modelId: "openai.gpt-5.6-sol", tier: "resale" }],
  },
  { modelId: "gpt-5.6-terra", vendor: "openai", backups: [] },
  { modelId: "gpt-5.6-luna", vendor: "openai", backups: [] },
  {
    modelId: "gpt-5.5",
    vendor: "openai",
    backups: [{ provider: "github-copilot", modelId: "gpt-5.5", tier: "resale", flatRate: true }],
  },
  { modelId: "gemini-3.6-flash", vendor: "google", backups: [] },
];

function endpointPolicy(modelId: string): ModelEndpointPolicy {
  const policy = MODEL_ENDPOINTS.find((entry) => entry.modelId === modelId);
  if (!policy) throw new Error(`no endpoint policy is declared for ${modelId}`);
  return policy;
}

/**
 * Explicit ability declarations for candidates the evidence pack does not cover. Every entry must
 * name its basis; the evidence-derived band is preferred wherever it exists.
 */
const DECLARED_ABILITY: Readonly<Record<string, AbilityTier>> = {
  // gpt-5.4 retains a tier-2 declaration only as a legacy deliberate-workflow fallback.
  "gpt-5.4@medium": 2,
};

function abilityFor(modelId: string, effort: EffortLevel): AbilityTier {
  const evidenceTier = evidenceAbility(modelId, effort);
  if (evidenceTier !== undefined) return evidenceTier;
  const declared = DECLARED_ABILITY[`${modelId}@${effort}`];
  if (declared !== undefined) return declared;
  throw new Error(`no evidence band or declared ability exists for ${modelId}@${effort}`);
}

/**
 * Expands one (model, effort) choice into its ordered endpoint chain: the manufacturer route first,
 * then gateway routes, then resale routes. Routing keeps this grouping so an availability failure
 * retries the same model before changing models.
 */
function candidates(modelId: string, effort: EffortLevel): CandidateRef[] {
  const policy = endpointPolicy(modelId);
  const ability = abilityFor(modelId, effort);
  const base = {
    modelId,
    logicalModelId: modelId,
    vendor: policy.vendor,
    effort,
    ability,
    allowAlias: false,
    restricted: false,
  } as const;
  const manufacturer: CandidateRef[] = MANUFACTURER_PROVIDERS[policy.vendor].map((provider) => ({
    ...base,
    provider,
    endpointTier: "manufacturer",
    flatRate: false,
  }));
  const backups: CandidateRef[] = [...policy.backups]
    .sort((left, right) => ENDPOINT_TIERS.indexOf(left.tier) - ENDPOINT_TIERS.indexOf(right.tier))
    .map((backup) => ({
      ...base,
      provider: backup.provider,
      modelId: backup.modelId,
      endpointTier: backup.tier,
      flatRate: backup.flatRate === true,
    }));
  return [...manufacturer, ...backups];
}

/** gpt-5.4 has no endpoint policy entry, so its legacy fallback refs are built directly. */
function legacyOpenaiCandidates(modelId: string, effort: EffortLevel): CandidateRef[] {
  return ["openai-codex", "openai"].map((provider) => ({
    provider,
    modelId,
    logicalModelId: modelId,
    vendor: "openai" as const,
    effort,
    ability: abilityFor(modelId, effort),
    endpointTier: "manufacturer" as const,
    flatRate: false,
    allowAlias: false,
    restricted: false,
  }));
}

const LUNA_LOW = candidates("gpt-5.6-luna", "low");
const LUNA_MAX = candidates("gpt-5.6-luna", "max");
const TERRA_MEDIUM = candidates("gpt-5.6-terra", "medium");
const TERRA_MAX = candidates("gpt-5.6-terra", "max");
const SOL_MEDIUM = candidates("gpt-5.6-sol", "medium");
const SOL_HIGH = candidates("gpt-5.6-sol", "high");
const SOL_MAX = candidates("gpt-5.6-sol", "max");
const GPT_55_XHIGH = candidates("gpt-5.5", "xhigh");
const GPT_54_MEDIUM = legacyOpenaiCandidates("gpt-5.4", "medium");
const HAIKU_LOW = candidates("claude-haiku-4-5", "low");
const OPUS_LOW = candidates("claude-opus-5", "low");
const OPUS_MEDIUM = candidates("claude-opus-5", "medium");
const OPUS_HIGH = candidates("claude-opus-5", "high");
const OPUS_XHIGH = candidates("claude-opus-5", "xhigh");
const OPUS_MAX = candidates("claude-opus-5", "max");
const FABLE_XHIGH = candidates("claude-fable-5", "xhigh");
const GEMINI_HIGH = candidates("gemini-3.6-flash", "high");

export type BootstrapRoutePolicy = {
  archetype: Archetype;
  primary: readonly CandidateRef[];
  fallback: readonly CandidateRef[];
  /**
   * Minimum observed accepted rate before telemetry may outrank the evidence priors. Calibrated
   * against achievable behavior rather than aspiration: the best measured deterministic pass rate in
   * the evidence corpus is 72.8%, and a route cannot be accepted more often than it completes
   * correctly, so implementation-class floors sit below that ceiling. Non-agentic archetypes keep
   * their original high floors because the agentic corpus does not measure those task types.
   */
  qualityFloor: number;
  /** Reference deterministic pass rate for this archetype class, recorded for telemetry comparison. */
  deterministicPassFloor: number;
  /** Archetypes authorized to exceed a model's measured effort saturation tier. */
  allowSuperSaturation: boolean;
  /** Whether routes for this archetype are expected to mutate a repository. */
  mutatesRepository: boolean;
  /**
   * Deliberate human prior that outranks the evidence cost objective for this archetype's first
   * attempt. Used only where the cost of a bad result is not paid inside the task: a defective plan
   * or a wrong high-risk verdict propagates into many downstream pull requests, so these archetypes
   * are ordered by capability rather than expected completion cost. Fallbacks stay evidence-ranked,
   * and the pin is ignored when the pinned choice is not eligible.
   */
  pinnedPrimary?: { logicalModelId: string; effort: EffortLevel; reason: string };
};

export const BOOTSTRAP_ROUTE_POLICIES: Record<Archetype, BootstrapRoutePolicy> = {
  fast_classification: {
    archetype: "fast_classification",
    primary: LUNA_LOW,
    fallback: HAIKU_LOW,
    qualityFloor: 0.96,
    deterministicPassFloor: 0.96,
    allowSuperSaturation: false,
    mutatesRepository: false,
  },
  exact_extraction: {
    archetype: "exact_extraction",
    primary: TERRA_MEDIUM,
    fallback: HAIKU_LOW,
    qualityFloor: 0.98,
    deterministicPassFloor: 0.98,
    allowSuperSaturation: false,
    mutatesRepository: false,
  },
  deliberate_tool_workflow: {
    archetype: "deliberate_tool_workflow",
    primary: SOL_MEDIUM,
    fallback: [...SOL_HIGH, ...GPT_54_MEDIUM],
    qualityFloor: 0.8,
    deterministicPassFloor: 0.61,
    allowSuperSaturation: false,
    mutatesRepository: false,
  },
  median_repository_implementation: {
    archetype: "median_repository_implementation",
    primary: OPUS_MEDIUM,
    fallback: [...SOL_HIGH, ...OPUS_HIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.68,
    allowSuperSaturation: false,
    mutatesRepository: true,
  },
  stacked_pr_implementation: {
    archetype: "stacked_pr_implementation",
    primary: OPUS_HIGH,
    fallback: [...SOL_HIGH, ...SOL_MAX],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: false,
    mutatesRepository: true,
  },
  terminal_heavy_implementation: {
    archetype: "terminal_heavy_implementation",
    primary: SOL_HIGH,
    fallback: [...OPUS_HIGH, ...TERRA_MAX],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.69,
    allowSuperSaturation: false,
    mutatesRepository: true,
  },
  algorithmic_iterative_coding: {
    archetype: "algorithmic_iterative_coding",
    primary: SOL_MEDIUM,
    fallback: [...OPUS_MEDIUM, ...GEMINI_HIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.61,
    allowSuperSaturation: false,
    mutatesRepository: true,
  },
  code_review: {
    archetype: "code_review",
    primary: OPUS_HIGH,
    fallback: SOL_HIGH,
    qualityFloor: 0.75,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: false,
    mutatesRepository: false,
  },
  implementation_planning: {
    archetype: "implementation_planning",
    primary: OPUS_HIGH,
    fallback: [...SOL_HIGH, ...FABLE_XHIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: false,
    mutatesRepository: false,
    pinnedPrimary: {
      logicalModelId: "claude-opus-5",
      effort: "high",
      reason:
        "planning is capability-first: Opus 5 holds the top consensus band (92.2) and the lowest regression breakage, and a defective plan propagates across every pull request it authorizes",
    },
  },
  large_program_planning: {
    archetype: "large_program_planning",
    primary: OPUS_XHIGH,
    fallback: [...SOL_MAX, ...FABLE_XHIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: true,
    mutatesRepository: false,
    pinnedPrimary: {
      logicalModelId: "claude-opus-5",
      effort: "xhigh",
      reason:
        "program planning is capability-first and long-horizon; Opus 5 at xhigh leads the corpus (72.5% pass, consensus 97.1) and Fable 5 at xhigh costs 1.5x more per pass for less",
    },
  },
  long_context_synthesis: {
    archetype: "long_context_synthesis",
    primary: OPUS_MEDIUM,
    fallback: [...SOL_HIGH, ...GPT_55_XHIGH],
    qualityFloor: 0.72,
    deterministicPassFloor: 0.68,
    allowSuperSaturation: false,
    mutatesRepository: false,
  },
  highest_risk_advisory: {
    archetype: "highest_risk_advisory",
    primary: OPUS_MAX,
    fallback: [...SOL_MAX, ...OPUS_HIGH],
    qualityFloor: 0.8,
    deterministicPassFloor: 0.73,
    allowSuperSaturation: true,
    mutatesRepository: false,
    pinnedPrimary: {
      logicalModelId: "claude-opus-5",
      effort: "max",
      reason:
        "highest-risk work is quality-first: Opus 5 at max leads determinism (54.9% all-repeat pass) and regression safety (5.7%), and the cost of a wrong verdict is not paid inside the task",
    },
  },
};

/**
 * Reviewer ladders, ordered by evidence-derived ability.
 *
 * Claude Sonnet 5 is absent: at high effort it measures in the lowest ability band (48.2% pass, 138
 * median steps, p90 peak context 286,022), so it can no longer serve as a mid-tier reviewer.
 *
 * The ability-1 OpenAI and Anthropic rungs are also absent. A reviewer must be able to reason about
 * a diff, and the lowest-band configurations either cliff catastrophically (gpt-5.6-luna at low
 * effort passes 1.5% and breaks previously passing tests at 27.7%) or carry no agentic measurement
 * at all (claude-haiku-4-5). Google keeps its single rung because gemini-3.6-flash at high effort is
 * its only eligible configuration; a builder above that band produces a recorded ceiling mismatch
 * rather than a silent downgrade.
 */
const REVIEWER_TIERS: Record<ModelVendor, readonly (readonly CandidateRef[])[]> = {
  openai: [SOL_MEDIUM, SOL_HIGH, SOL_MAX],
  anthropic: [OPUS_LOW, OPUS_MEDIUM, OPUS_HIGH, FABLE_XHIGH],
  google: [GEMINI_HIGH],
};

/**
 * Authorized hard-task escalation choice. Used only after a failed attempt on ambiguous or complex
 * work, where the evidence favors changing the model prior over raising effort on a saturated
 * incumbent. It is never any archetype's primary.
 */
export const HARD_TASK_ESCALATION_REFS: readonly CandidateRef[] = LUNA_MAX.map((ref) => ({
  ...ref,
  escalationOnly: true,
}));

// Derived, never hand-maintained: every candidate reachable through the bootstrap route policies,
// the reviewer tiers, or the escalation path is automatically part of the authoritative ability
// table, so a newly added candidate cannot silently fall through to the regex heuristic in
// pi-state.ts.
const ALL_CANDIDATE_REFS: readonly CandidateRef[] = [
  ...Object.values(BOOTSTRAP_ROUTE_POLICIES).flatMap((policy) => [...policy.primary, ...policy.fallback]),
  ...MODEL_VENDORS.flatMap((vendor) => REVIEWER_TIERS[vendor].flat()),
  ...HARD_TASK_ESCALATION_REFS,
];

/**
 * Ability is a per-(model, effort) judgment derived from cross-source consensus bands, not a uniform
 * effort bump: gpt-5.6-terra stays in a low band at high effort while claude-opus-5 reaches the top
 * band, because effort scales quality differently per model. This table is the single source of
 * truth; heuristics elsewhere must defer to it.
 */
export function policyAbility(modelId: string, effort: EffortLevel): AbilityTier | undefined {
  return ALL_CANDIDATE_REFS.find(
    (ref) => (ref.modelId === modelId || ref.logicalModelId === modelId) && ref.effort === effort,
  )?.ability;
}

export function reviewerRefs(vendor: ModelVendor, minimumAbility: number): readonly CandidateRef[] {
  const tiers = REVIEWER_TIERS[vendor];
  const eligibleTiers = tiers.filter((tier) => (tier[0]?.ability ?? 0) >= minimumAbility);
  return eligibleTiers.length > 0 ? eligibleTiers.flat() : [...(tiers.at(-1) ?? [])];
}
