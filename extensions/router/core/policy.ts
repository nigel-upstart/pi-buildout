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
  /**
   * No source measures this candidate. Admitted only as a lowest-band price peer of an equally
   * unmeasured rung, and only for read-only consequence; see `UNMEASURED_PEERS`.
   */
  unmeasuredPeer?: boolean;
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
  "gpt-5.4-mini": "openai",
  "gpt-oss-120b": "openai",
  "claude-opus-5": "anthropic",
  "claude-opus-4-8": "anthropic",
  "claude-opus-4-6": "anthropic",
  "claude-fable-5": "anthropic",
  "claude-sonnet-5": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "gemini-3.6-flash": "google",
  "gemini-2.5-pro": "google",
  "gemini-2.5-flash": "google",
};

/**
 * Candidates no source in the evidence pack measures at all, admitted only as a lowest-band peer of
 * an already-admitted lowest-band model, and only in the bounded read-only ladders. See
 * specs/routing-layer/model-evidence-2026-08-11.md for the pack's generated tables and source limits.
 *
 * This is deliberately not the same mechanism as an evidence band, and it is not a quality claim.
 * `claude-haiku-4-5` is itself admitted from a consensus figure with no agentic rollout row, so the
 * bounded classification bucket already runs on a model the corpus does not measure agentically. A
 * cheaper small model is a legitimate peer of that rung on price, which the live registry prices at
 * decision time, but nothing here asserts it matches it on quality: the pack contains no row for any
 * mini or nano model, so the comparison against Haiku is genuinely unresolved rather than favorable.
 *
 * The whole case for a peer is per-token price, and that case is conditional. `gpt-5.4-mini` runs at
 * roughly 0.75 of `gpt-5.6-luna`'s per-token price, so the break-even point is 1 / 0.75 ≈ 1.33 turns:
 * a model that needs a third more turns than the one it undercuts has already spent the discount, and
 * nothing measures how many turns it takes. A peer therefore belongs only on one-shot or near-one-shot
 * reasoning, never on anything that iterates.
 *
 * The guardrails are therefore structural, not statistical:
 *  - band 1 only, so consequence gating already bars irreversible work;
 *  - `unmeasuredPeer`, which core/routing.ts refuses outside read-only consequence, so a peer can
 *    never touch even reversible mutation;
 *  - the same flag also refuses it outside a one-shot turn budget, which is where the price argument
 *    holds;
 *  - allowed only in `PEER_ARCHETYPES`, enforced by a policy invariant test;
 *  - ordered after the measured rung it peers with, so it is reached on price or availability only.
 *
 * gpt-5.4-nano is intentionally absent: the same argument would admit it, but two unmeasured rungs in
 * one bucket buys no availability that the first does not already provide.
 */
const UNMEASURED_PEERS: Readonly<Record<string, { peerOf: string; basis: string }>> = {
  "gpt-5.4-mini": {
    peerOf: "claude-haiku-4-5",
    basis:
      "no DeepSWE, CursorBench, or consensus row exists for any mini or nano model in the 2026-07-25 pack; admitted as a price peer of the equally unmeasured claude-haiku-4-5 rung at roughly 0.75 of gpt-5.6-luna's per-token price, restricted to read-only one-shot work because a 1.33x turn count erases that discount",
  },
};

/** Archetypes an unmeasured peer may appear in: bounded, read-only, lowest-band work. */
export const PEER_ARCHETYPES: readonly Archetype[] = ["fast_classification", "exact_extraction"];

/**
 * Every candidate this policy can name must carry an evidence-derived ability band, either from a
 * DeepSWE rollout row for that exact (model, effort) pair or from the consensus-only table in
 * core/evidence.ts. Hand-declared bands are deliberately not supported: the one entry that used to
 * exist (`gpt-5.4@medium`) was never measured at that effort, and a policy-local number that no
 * source backs is indistinguishable from a guess. Unmeasured peers are the single exception, and they
 * are pinned to band 1 rather than given a number of their own.
 */
function abilityFor(modelId: string, effort: EffortLevel): AbilityTier {
  const evidenceTier = evidenceAbility(modelId, effort);
  if (evidenceTier !== undefined) return evidenceTier;
  if (UNMEASURED_PEERS[modelId]) return 1;
  throw new Error(`no evidence band exists for ${modelId}@${effort}`);
}

/** Declares one logical (model, effort) candidate. Endpoint expansion happens in core/routing.ts. */
function candidates(logicalModelId: string, effort: EffortLevel): CandidateRef[] {
  const vendor = MODEL_VENDOR[logicalModelId];
  if (!vendor) throw new Error(`no vendor is declared for ${logicalModelId}`);
  const peer = UNMEASURED_PEERS[logicalModelId];
  return [
    {
      logicalModelId,
      vendor,
      effort,
      ability: abilityFor(logicalModelId, effort),
      ...(peer ? { unmeasuredPeer: true } : {}),
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
const HAIKU_LOW = candidates("claude-haiku-4-5", "low");
const MINI_LOW = candidates("gpt-5.4-mini", "low");
const OPUS_LOW = candidates("claude-opus-5", "low");
const OPUS_MEDIUM = candidates("claude-opus-5", "medium");
const OPUS_HIGH = candidates("claude-opus-5", "high");
const OPUS_XHIGH = candidates("claude-opus-5", "xhigh");
const OPUS_MAX = candidates("claude-opus-5", "max");
const FABLE_XHIGH = candidates("claude-fable-5", "xhigh");
const OPUS_46_HIGH = candidates("claude-opus-4-6", "high").map((ref) => ({ ...ref, scopedFrugal: true }));
/**
 * Availability tail of the Opus generation chain, for the archetypes whose intent is "use the best
 * Anthropic Opus available" rather than "use whichever model scores best".
 *
 * Opus 5 remains strongly preferred and nothing here competes with it: every scoped endpoint for Opus
 * 5 is expanded and tried first, manufacturer route ahead of gateways and resale, so an Anthropic
 * outage or an unscoped first-party route already degrades to Opus 5 on a fallback provider before any
 * of this applies. This rung exists for the narrower case where no Opus 5 endpoint exists at all on the
 * machine — a resale catalog that still tops out at 4.8 — where the alternative is dropping the
 * Anthropic rung entirely.
 *
 * It is ordered last and ranks poorly on its own numbers (51.8% pass at $8.27 per pass against Opus 5
 * at high with 72.3% and $8.42), which is the intended behavior: it should never displace a
 * current-generation candidate that is present, only fill a gap that would otherwise be empty. 4.8
 * precedes 4.6 because it is the higher generation and is measured agentically, where 4.6 is retained
 * only as the scoped frugal candidate.
 */
const OPUS_GENERATION_TAIL = candidates("claude-opus-4-8", "high");
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
    //
    // gpt-5.4-mini is the unmeasured price peer of the claude-haiku-4-5 rung and sits directly behind
    // it; both are lowest-band entries, and the live registry decides which is actually cheaper on the
    // machine in hand. The peer is additionally confined to read-only one-shot work, because its only
    // claim is a per-token discount that a third more turns would spend.
    //
    // gpt-oss-120b at high effort precedes gpt-5.6-terra at medium: this archetype is not
    // evidence-ranked, so the declared order is the executed order, and on the only comparable
    // measurement the two share, gpt-oss leads (consensus performance_best 36.5 against terra@medium's
    // 16.3) while also sitting at the corpus cost floor. terra@medium's measured agentic behavior does
    // not rescue the comparison either: 35.1% pass with a 14.7% regression-break rate, the worst of
    // any tier in this ladder. It stays in the ladder only as the availability backup for gpt-oss,
    // which is reachable on a single Amazon Bedrock route and is therefore absent on most machines.
    fallback: [...HAIKU_LOW, ...MINI_LOW, ...GPT_OSS_HIGH, ...TERRA_MEDIUM, ...SOL_MEDIUM, ...OPUS_MEDIUM],
    qualityFloor: 0.96,
    deterministicPassFloor: 0.96,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: false,
  },
  exact_extraction: {
    archetype: "exact_extraction",
    primary: TERRA_MEDIUM,
    fallback: [...HAIKU_LOW, ...MINI_LOW, ...SOL_LOW, ...GPT_OSS_HIGH, ...SOL_MEDIUM, ...OPUS_MEDIUM],
    qualityFloor: 0.98,
    deterministicPassFloor: 0.98,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: false,
  },
  deliberate_tool_workflow: {
    archetype: "deliberate_tool_workflow",
    primary: SOL_MEDIUM,
    // gpt-5.4 at medium is gone from this ladder. It was carried only as a legacy fallback and had no
    // rollout row at that effort at all; the one gpt-5.4 configuration the corpus does measure (xhigh)
    // passes 51.8% with 12.4% regression breakage for $10.91 per pass, worse than every tier above it.
    // Two current-generation entries replace it:
    //
    //  - gpt-5.6-terra at high is the cheap rung this archetype was reaching for: 53.8% pass at $2.11
    //    per pass and 315s median, which is cheaper and faster than sol@medium ($3.05, 355s) for
    //    procedural work whose steps are dictated rather than designed. Its consensus band is 43.0, so
    //    it is band 1 and consequence gating bars it from the irreversible checkpoints in this
    //    archetype on its own; it serves the local_read and reversible members of the same ladder.
    //  - claude-opus-5 at medium is the non-OpenAI tail, and the closest measured neighbour of the Sol
    //    tiers (68.1% pass and consensus 79.0 against sol@high's 69.3% and 79.9, $4.86 per pass against
    //    sol@medium's $3.05, 588s median against 355s). It gives a workflow with external side effects a
    //    vendor alternative, which an all-OpenAI ladder could not.
    fallback: [...SOL_HIGH, ...SOL_LOW, ...TERRA_HIGH, ...OPUS_MEDIUM],
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
    fallback: [...SOL_HIGH, ...FABLE_XHIGH, ...OPUS_GENERATION_TAIL],
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
    fallback: [...SOL_MAX, ...FABLE_XHIGH, ...OPUS_GENERATION_TAIL],
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
    // gpt-5.5 at xhigh used to hold the OpenAI tail here on its long-context numbers: 0% context
    // overflow, p90 peak context 219,152, and the highest partial credit on failure in the ladder
    // (83.1%), which is what a synthesis route degrades into when it does not fully succeed. It is
    // retired anyway, because gpt-5.6-terra at max matches the shape and beats it on every number that
    // matters: 69.6% pass against 67.0%, $7.10 per pass against $10.78, 928s median against 1,588s,
    // consensus 84.7 against 68.8, with the same 0% overflow at a comparable p90 peak of 266,934. Terra
    // is also effort-hungry rather than saturated early, so max is its measured top tier and not a
    // super-saturation reach. claude-opus-4-6 precedes it because a scoped-frugal candidate is admitted
    // only where step count binds, and where it is admitted its 23.6 median API calls are the cheapest
    // way through a large-document pass.
    fallback: [...SOL_HIGH, ...OPUS_46_HIGH, ...TERRA_MAX],
    qualityFloor: 0.72,
    deterministicPassFloor: 0.68,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: true,
  },
  highest_risk_advisory: {
    archetype: "highest_risk_advisory",
    primary: OPUS_MAX,
    fallback: [...SOL_MAX, ...OPUS_HIGH, ...OPUS_GENERATION_TAIL],
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
