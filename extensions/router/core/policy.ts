import type { Archetype } from "./archetype.ts";
import { evidenceAbility } from "./evidence.ts";
import type { AbilityTier } from "./evidence.ts";
import { MODEL_VENDORS } from "./profiles.ts";
import { canonicalModelId } from "./scope.ts";
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
  /**
   * The manufacturer's model ID. Concrete endpoints are resolved from the live scoped registry at
   * decision time, so policy never names a provider: a hand-maintained provider table drifts from the
   * machine it runs on, naming endpoints the operator never scoped in and missing ones they did.
   * Evidence priors, effort policies, ability bands, and prompt profiles are all keyed by this.
   */
  logicalModelId: string;
  vendor: ModelVendor;
  effort: EffortLevel;
  ability: AbilityTier;
  /**
   * Authorized only as a retry after a failed attempt, never as a first attempt. Used for the
   * hard-task escalation prior, whose measured hard-task lead comes with same-task flakiness too high
   * to make it any archetype's default.
   */
  escalationOnly?: boolean;
  /**
   * Scoped frugal candidate: authorized only where step count rather than token cost is the binding
   * constraint, which in the implemented policy means tight context headroom, since fewer steps yields
   * a lower peak context.
   */
  scopedFrugal?: boolean;
  allowAlias: boolean;
  restricted: boolean;
};

/**
 * Vendor for each logical model the policy can name. Explicit rather than inferred from the ID, so a
 * new candidate must declare which vendor ladder and prompt-profile family it belongs to.
 */
const MODEL_VENDOR: Readonly<Record<string, ModelVendor>> = {
  "gpt-5.6-luna": "openai",
  "gpt-5.6-terra": "openai",
  "gpt-5.6-sol": "openai",
  "gpt-5.5": "openai",
  "gpt-5.4": "openai",
  "gpt-oss-120b": "openai",
  "claude-opus-5": "anthropic",
  "claude-opus-4-6": "anthropic",
  "claude-fable-5": "anthropic",
  "claude-sonnet-5": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "gemini-3.6-flash": "google",
  "gemini-2.5-pro": "google",
  "gemini-2.5-flash": "google",
};

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

/** Declares one logical (model, effort) candidate. Endpoint expansion happens in core/routing.ts. */
function candidates(logicalModelId: string, effort: EffortLevel): CandidateRef[] {
  const vendor = MODEL_VENDOR[logicalModelId];
  if (!vendor) throw new Error(`no vendor is declared for ${logicalModelId}`);
  return [
    {
      logicalModelId,
      vendor,
      effort,
      ability: abilityFor(logicalModelId, effort),
      allowAlias: false,
      restricted: false,
    },
  ];
}

const LUNA_LOW = candidates("gpt-5.6-luna", "low");
const LUNA_HIGH = candidates("gpt-5.6-luna", "high");
const LUNA_MAX = candidates("gpt-5.6-luna", "max");
const TERRA_MEDIUM = candidates("gpt-5.6-terra", "medium");
const TERRA_HIGH = candidates("gpt-5.6-terra", "high");
const TERRA_MAX = candidates("gpt-5.6-terra", "max");
const GPT_OSS_HIGH = candidates("gpt-oss-120b", "high");
const SOL_LOW = candidates("gpt-5.6-sol", "low");
const SOL_MEDIUM = candidates("gpt-5.6-sol", "medium");
const SOL_HIGH = candidates("gpt-5.6-sol", "high");
const SOL_MAX = candidates("gpt-5.6-sol", "max");
const GPT_55_XHIGH = candidates("gpt-5.5", "xhigh");
const GPT_54_MEDIUM = candidates("gpt-5.4", "medium");
const HAIKU_LOW = candidates("claude-haiku-4-5", "low");
const OPUS_LOW = candidates("claude-opus-5", "low");
const OPUS_MEDIUM = candidates("claude-opus-5", "medium");
const OPUS_HIGH = candidates("claude-opus-5", "high");
const OPUS_XHIGH = candidates("claude-opus-5", "xhigh");
const OPUS_MAX = candidates("claude-opus-5", "max");
const FABLE_XHIGH = candidates("claude-fable-5", "xhigh");
const OPUS_46_HIGH = candidates("claude-opus-4-6", "high").map((ref) => ({ ...ref, scopedFrugal: true }));
/**
 * Preference order for the Google rung. Independent review requires two non-builder vendors, so the
 * chain exists to guarantee Google can always supply one: whichever entry is scoped in and healthy on
 * a given machine becomes the rung, and the ladder degrades in capability rather than disappearing.
 *
 * gemini-3.6-flash leads because it is the only Gemini configuration the evidence pack does not
 * disqualify. gemini-3.5-flash is deliberately absent: it is disqualified for a measured 3.8%
 * context-overflow rate. The 2.5 entries are lowest-band reviewers, kept because an independent
 * second opinion from a weaker model is worth more than no independent review at all, and review is
 * read-only work where a weak reviewer cannot break anything.
 */
const GEMINI_HIGH = [
  ...candidates("gemini-3.6-flash", "high"),
  ...candidates("gemini-2.5-pro", "high"),
  ...candidates("gemini-2.5-flash", "high"),
];

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
  /**
   * Whether this archetype always changes repository state. Used only as a floor under the
   * task-derived consequence tier, so a classifier that under-reads a task cannot downgrade an
   * inherently state-changing archetype to read-only.
   */
  mutatesRepository: boolean;
  /**
   * Whether the measured agentic priors may reorder this archetype's pool. False for archetypes whose
   * task type the corpus does not measure: a multi-step repository pass rate says nothing about
   * single-shot classification or schema extraction, so those keep their declared order and use the
   * pool only for availability.
   */
  evidenceRanked: boolean;
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
    // The cheap band-1 tiers serve ordinary classification. The two band-2+ entries exist so a
    // classification task carrying critical risk or an irreversible action mode is still routable.
    fallback: [...HAIKU_LOW, ...TERRA_MEDIUM, ...GPT_OSS_HIGH, ...SOL_MEDIUM, ...OPUS_MEDIUM],
    qualityFloor: 0.96,
    deterministicPassFloor: 0.96,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: false,
  },
  exact_extraction: {
    archetype: "exact_extraction",
    primary: TERRA_MEDIUM,
    fallback: [...HAIKU_LOW, ...SOL_LOW, ...GPT_OSS_HIGH, ...SOL_MEDIUM, ...OPUS_MEDIUM],
    qualityFloor: 0.98,
    deterministicPassFloor: 0.98,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: false,
  },
  deliberate_tool_workflow: {
    archetype: "deliberate_tool_workflow",
    primary: SOL_MEDIUM,
    fallback: [...SOL_HIGH, ...SOL_LOW, ...GPT_54_MEDIUM],
    qualityFloor: 0.8,
    deterministicPassFloor: 0.61,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: true,
  },
  median_repository_implementation: {
    archetype: "median_repository_implementation",
    primary: OPUS_MEDIUM,
    fallback: [...SOL_HIGH, ...OPUS_HIGH, ...TERRA_HIGH, ...OPUS_46_HIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.68,
    allowSuperSaturation: false,
    mutatesRepository: true,
    evidenceRanked: true,
  },
  stacked_pr_implementation: {
    archetype: "stacked_pr_implementation",
    primary: OPUS_HIGH,
    fallback: [...SOL_HIGH, ...SOL_MAX],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: false,
    mutatesRepository: true,
    evidenceRanked: true,
  },
  terminal_heavy_implementation: {
    archetype: "terminal_heavy_implementation",
    primary: SOL_HIGH,
    fallback: [...OPUS_HIGH, ...TERRA_MAX, ...TERRA_HIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.69,
    allowSuperSaturation: false,
    mutatesRepository: true,
    evidenceRanked: true,
  },
  algorithmic_iterative_coding: {
    archetype: "algorithmic_iterative_coding",
    primary: SOL_MEDIUM,
    fallback: [...OPUS_MEDIUM, ...GEMINI_HIGH, ...TERRA_HIGH, ...LUNA_HIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.61,
    allowSuperSaturation: false,
    mutatesRepository: true,
    evidenceRanked: true,
  },
  code_review: {
    archetype: "code_review",
    primary: OPUS_HIGH,
    fallback: SOL_HIGH,
    qualityFloor: 0.75,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: true,
  },
  implementation_planning: {
    archetype: "implementation_planning",
    primary: OPUS_HIGH,
    fallback: [...SOL_HIGH, ...FABLE_XHIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: true,
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
    evidenceRanked: true,
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
    fallback: [...SOL_HIGH, ...GPT_55_XHIGH, ...OPUS_46_HIGH],
    qualityFloor: 0.72,
    deterministicPassFloor: 0.68,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: true,
  },
  highest_risk_advisory: {
    archetype: "highest_risk_advisory",
    primary: OPUS_MAX,
    fallback: [...SOL_MAX, ...OPUS_HIGH],
    qualityFloor: 0.8,
    deterministicPassFloor: 0.73,
    allowSuperSaturation: true,
    mutatesRepository: false,
    evidenceRanked: true,
    pinnedPrimary: {
      logicalModelId: "claude-opus-5",
      effort: "max",
      reason:
        "highest-risk work is quality-first: Opus 5 at max leads determinism (54.9% all-repeat pass) and regression safety (5.2% corpus-wide), and the cost of a wrong verdict is not paid inside the task",
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
  const canonical = canonicalModelId(modelId);
  return ALL_CANDIDATE_REFS.find(
    (ref) => (ref.logicalModelId === modelId || ref.logicalModelId === canonical) && ref.effort === effort,
  )?.ability;
}

export function reviewerRefs(vendor: ModelVendor, minimumAbility: number): readonly CandidateRef[] {
  const tiers = REVIEWER_TIERS[vendor];
  const eligibleTiers = tiers.filter((tier) => (tier[0]?.ability ?? 0) >= minimumAbility);
  return eligibleTiers.length > 0 ? eligibleTiers.flat() : [...(tiers.at(-1) ?? [])];
}
