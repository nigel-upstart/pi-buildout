import type { Archetype } from "./archetype.ts";
import { evidenceAbility } from "./evidence.ts";
import type { AbilityTier } from "./evidence.ts";
import { MODEL_VENDORS } from "./profiles.ts";
import { canonicalModelId } from "./scope.ts";
import type { EffortLevel, ModelVendor } from "./profiles.ts";

export const POLICY_VERSION = "router-policy-v11";

/**
 * Backward-compatible endpoint classification retained for lease validation and diagnostics. Tiers
 * break equal-effective-cost ties only; weighted effective cost remains the primary order.
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
   * The exact configuration has benchmark ability evidence but no routing-grade rollout prior.
   * The router confines it to read-only consequence. Agreement across unrelated benchmarks does
   * not establish same-task reliability or safety for mutating work.
   */
  singleAttemptEvidence?: boolean;
  allowAlias: boolean;
  restricted: boolean;
};

/**
 * Vendor for each logical model the policy can name. Explicit rather than inferred from the ID, so a
 * new candidate must declare which vendor ladder and prompt-profile family it belongs to.
 */
export const MODEL_VENDOR: Readonly<Record<string, ModelVendor>> = {
  "gpt-6-luna": "openai",
  "gpt-6-astra": "openai",
  "gpt-5.6-terra": "openai",
  "gpt-6.1-terra": "openai",
  "gpt-6-sol": "openai",
  "gpt-6.1-sol": "openai",
  "gpt-6.2-sol": "openai",
  "gpt-6.2-astra": "openai",
  "gpt-oss-120b": "openai",
  "claude-opus-5-5": "anthropic",
  "claude-opus-4-6": "anthropic",
  "claude-fable-5": "anthropic",
  "claude-sonnet-5": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "claude-haiku-5-5": "anthropic",
  "gemini-4-neon": "google",
  "gemini-3.8-flash": "google",
  "gemini-3.6-flash": "google",
  "gemini-2.5-pro": "google",
  "gemini-2.5-flash": "google",
  "minimax-m2.5": "minimax",
  "kimi-k2.5": "moonshot",
  "kimi-k2-thinking": "moonshot",
};

/**
 * Every candidate this policy can name must carry an evidence-derived ability band, either from a
 * DeepSWE rollout row for that exact (model, effort) pair or from the consensus-only table in
 * core/evidence.ts. Hand-declared bands are deliberately not supported: the one entry that used to
 * exist (`gpt-5.4@medium`) was never measured at that effort, and a policy-local number that no
 * source backs is indistinguishable from a guess.
 *
 * There is no longer an exception to this rule. `gpt-5.4-mini` was admitted as an "unmeasured peer"
 * pinned to band 1 on a purely per-token-price argument; that argument was withdrawn when the pinned
 * registry showed the price relationship inverted, and the rung was removed with it.
 */
function abilityFor(modelId: string, effort: EffortLevel): AbilityTier {
  const evidenceTier = evidenceAbility(modelId, effort);
  if (evidenceTier !== undefined) return evidenceTier;
  throw new Error(`no evidence band exists for ${modelId}@${effort}`);
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

function readOnlyCandidates(modelId: string, effort: EffortLevel): CandidateRef[] {
  return candidates(modelId, effort).map((ref) => ({ ...ref, singleAttemptEvidence: true }));
}

const LUNA_MEDIUM = candidates("gpt-6-luna", "medium");
const LUNA_HIGH = candidates("gpt-6-luna", "high");
const LUNA_MAX = candidates("gpt-6-luna", "max");
const TERRA_MEDIUM = candidates("gpt-5.6-terra", "medium");
const TERRA_HIGH = candidates("gpt-5.6-terra", "high");
const TERRA_61_MAX = candidates("gpt-6.1-terra", "max");
const TERRA_MAX = [...TERRA_61_MAX, ...candidates("gpt-5.6-terra", "max")];
const GPT_OSS_HIGH = candidates("gpt-oss-120b", "high");
// Declare successors newest first so availability ladders and equal evidence scores prefer them.
// Each generation still resolves to its own scoped endpoints and telemetry.
const CURRENT_SOL_MODELS = ["gpt-6.2-sol", "gpt-6.1-sol"];
const SOL_MODELS = [...CURRENT_SOL_MODELS, "gpt-6-sol"];
const SOL_LOW = SOL_MODELS.flatMap((id) => candidates(id, "low"));
const SOL_MEDIUM = SOL_MODELS.flatMap((id) => candidates(id, "medium"));
const SOL_HIGH = SOL_MODELS.flatMap((id) => candidates(id, "high"));
const SOL_MAX = CURRENT_SOL_MODELS.flatMap((id) => candidates(id, "max"));
const LEGACY_SOL_MAX = candidates("gpt-6-sol", "max");
const ASTRA_HIGH = [...candidates("gpt-6.2-astra", "high"), ...candidates("gpt-6-astra", "high")];
const ASTRA_MAX = readOnlyCandidates("gpt-6.2-astra", "max");
const HAIKU_LOW = [...readOnlyCandidates("claude-haiku-5-5", "low"), ...candidates("claude-haiku-4-5", "low")];
const HAIKU_XHIGH = readOnlyCandidates("claude-haiku-5-5", "xhigh");
const NEON_XHIGH = readOnlyCandidates("gemini-4-neon", "xhigh");
const NEON_REVIEW = [...readOnlyCandidates("gemini-4-neon", "high"), ...NEON_XHIGH];
/**
 * MiniMax M2.5, admitted to the bounded read-only ladders only.
 *
 * It displaces Claude Haiku 4.5 as the cheap rung on measurement rather than on price. On SWE-bench
 * Multilingual, the one source measuring both, it leads Haiku by 3.8 points of mean resolve over eight
 * languages (68.6% against 64.8%), costs 3.9x less per resolved task ($0.155 against $0.612), and uses
 * fewer median API calls (62.6 against 67.6). On SWE-bench Verified it leads gpt-oss-120b by 49.8
 * points at 2.3x lower cost per resolved task.
 *
 * Its evidence is single-attempt, so `singleAttemptEvidence` confines it to read-only consequence.
 * That flag, not its ability band, is what keeps it away from mutating work: the band derived from
 * this source is 2, which would otherwise clear the irreversible floor.
 *
 * It is declared in the fallback chain and never as a declared primary. It is deliberately NOT
 * forcibly demoted at selection time, so if every rung ahead of it is ineligible - Luna unavailable,
 * for instance - it can become the selected primary of a read-only route. That is intended, and the
 * contrast with `escalationOnly` is the reason: that flag is demoted unconditionally because its
 * candidate has a *measured* unfitness for a first attempt, 52.7% same-task flakiness. Here the
 * problem is absence of evidence, not measured unreliability, and the only alternative in that state
 * is the rung this one displaced - which measures worse on every axis the sources share. Forcing a
 * non-single-attempt primary would mean deliberately choosing the worse-measured model. Being first on
 * read-only work is also no more dangerous than being second on it, because the confinement above is
 * what bounds the damage, not the position in the chain.
 *
 * Keep the image-capable Haiku fallback because MiniMax accepts only text.
 *
 * `low` follows the rung it displaces. No source measures this model per effort — the submissions ran
 * at a "high reasoning" setting and measured agentic repository work, not bounded classification — so
 * the effort is chosen to match the rung rather than claimed as measured.
 */
const MINIMAX_LOW = readOnlyCandidates("minimax-m2.5", "low");
/**
 * Reachable Kimi open-weight rungs, confined to read-only work because their quality evidence is
 * single-attempt. Both sit within the approximate Haiku-to-Luna capability range and stay within 3x
 * Luna's direct output-weighted list rate: K2.5 is 2.53x and K2 Thinking is 2.13x. K2.5 resolves 70.8% on
 * SWE-bench Verified, supports image input, and leads the retained Ruby split at 68.2%; K2 Thinking
 * resolves 63.4% and Artificial Analysis records 120.98 output tokens/s versus Haiku's 81.09.
 */
const KIMI_25_LOW = readOnlyCandidates("kimi-k2.5", "low");
const KIMI_THINKING_LOW = readOnlyCandidates("kimi-k2-thinking", "low");
const OPUS_LOW = candidates("claude-opus-5-5", "low");
const OPUS_MEDIUM = candidates("claude-opus-5-5", "medium");
const OPUS_HIGH = candidates("claude-opus-5-5", "high");
const FABLE_XHIGH = candidates("claude-fable-5", "xhigh");
const OPUS_46_HIGH = candidates("claude-opus-4-6", "high").map((ref) => ({ ...ref, scopedFrugal: true }));
/**
 * General Google availability chain. Direct `google` endpoints are filtered from non-review work in
 * core/routing.ts because their operator quota is too low for general traffic; Vertex and other
 * scoped surfaces remain eligible. gemini-3.5-flash stays absent because its measured context
 * overflow disqualifies it.
 */
const GEMINI_GENERAL_HIGH = [
  ...candidates("gemini-3.6-flash", "high"),
  ...candidates("gemini-2.5-pro", "high"),
  ...candidates("gemini-2.5-flash", "high"),
];

// Neon high is close to xhigh on CursorBench 4.1 (63.7 vs 65.4) at $6.54 vs $10.67 per task.
// Require an exact scoped endpoint and supported effort; keep older Google models for availability.
const GEMINI_REVIEW = [...NEON_REVIEW, ...candidates("gemini-3.8-flash", "high"), ...GEMINI_GENERAL_HIGH];

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
   * Prior that outranks the bootstrap cost objective for the first eligible entry in `primary`.
   * Other choices stay evidence-ranked; no endpoint or consequence gate is relaxed.
   */
  preferPrimary?: {
    reason: string;
    /** Keep a measured language-specific route when one exists instead of applying the corpus-wide default. */
    deferToLanguageEvidence?: boolean;
  };
};

export const BOOTSTRAP_ROUTE_POLICIES: Record<Archetype, BootstrapRoutePolicy> = {
  fast_classification: {
    archetype: "fast_classification",
    // This is the agent answering a bounded task, not the classifier itself. Luna at medium is
    // adequate for read-only work; the measured regression cliff below high excludes it from
    // reversible work. Irreversible work also excludes band-1 Luna high, leaving Sol/Opus medium.
    primary: LUNA_MEDIUM,
    fallback: [
      ...LUNA_HIGH,
      ...MINIMAX_LOW,
      ...KIMI_25_LOW,
      ...KIMI_THINKING_LOW,
      ...GPT_OSS_HIGH,
      ...HAIKU_LOW,
      ...TERRA_MEDIUM,
      ...SOL_MEDIUM,
      ...OPUS_MEDIUM,
    ],
    qualityFloor: 0.96,
    deterministicPassFloor: 0.96,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: false,
  },
  exact_extraction: {
    archetype: "exact_extraction",
    primary: TERRA_MEDIUM,
    // Haiku xhigh is a bounded read-only fallback, not a schema-fidelity claim. Keep inexpensive
    // rungs ahead of it; CursorBench measures multi-step coding, not extraction.
    fallback: [
      ...MINIMAX_LOW,
      ...KIMI_25_LOW,
      ...KIMI_THINKING_LOW,
      ...HAIKU_LOW,
      ...HAIKU_XHIGH,
      ...SOL_LOW,
      ...GPT_OSS_HIGH,
      ...SOL_MEDIUM,
      ...OPUS_MEDIUM,
    ],
    qualityFloor: 0.98,
    deterministicPassFloor: 0.98,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: false,
  },
  deliberate_tool_workflow: {
    archetype: "deliberate_tool_workflow",
    primary: SOL_MEDIUM,
    // Terra supplies cheaper workflow alternatives where their effort, context, and consequence
    // fit. Keep Opus medium as an independent availability fallback.
    fallback: [...SOL_HIGH, ...SOL_LOW, ...TERRA_HIGH, ...TERRA_61_MAX, ...OPUS_MEDIUM],
    qualityFloor: 0.8,
    deterministicPassFloor: 0.61,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: true,
  },
  median_repository_implementation: {
    archetype: "median_repository_implementation",
    primary: SOL_HIGH,
    fallback: [...OPUS_MEDIUM, ...OPUS_HIGH, ...TERRA_HIGH, ...OPUS_46_HIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.68,
    allowSuperSaturation: false,
    mutatesRepository: true,
    evidenceRanked: true,
  },
  stacked_pr_implementation: {
    archetype: "stacked_pr_implementation",
    primary: SOL_MAX,
    fallback: [...SOL_HIGH, ...OPUS_HIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: true,
    mutatesRepository: true,
    evidenceRanked: true,
    preferPrimary: {
      reason: "use current Sol max for stack-wide work while retaining the language-specific evidence order",
      deferToLanguageEvidence: true,
    },
  },
  terminal_heavy_implementation: {
    archetype: "terminal_heavy_implementation",
    primary: SOL_MAX,
    fallback: [...SOL_HIGH, ...TERRA_MAX, ...TERRA_HIGH, ...OPUS_HIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.69,
    allowSuperSaturation: true,
    mutatesRepository: true,
    evidenceRanked: true,
    preferPrimary: {
      reason: "Sol 6.2 and 6.1 at max resolve 61.5% and 60.9% on Terminal-Bench 4.1 with Codex",
    },
  },
  algorithmic_iterative_coding: {
    archetype: "algorithmic_iterative_coding",
    primary: SOL_MEDIUM,
    fallback: [...OPUS_MEDIUM, ...GEMINI_GENERAL_HIGH, ...TERRA_HIGH, ...LUNA_HIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.61,
    allowSuperSaturation: false,
    mutatesRepository: true,
    evidenceRanked: true,
  },
  code_review: {
    archetype: "code_review",
    primary: NEON_REVIEW,
    fallback: [...SOL_HIGH, ...OPUS_HIGH, ...HAIKU_XHIGH],
    qualityFloor: 0.75,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: true,
    preferPrimary: { reason: "prefer Neon high for read-only review; xhigh is a scoped alternative" },
  },
  implementation_planning: {
    archetype: "implementation_planning",
    primary: SOL_HIGH,
    fallback: [...ASTRA_HIGH, ...OPUS_HIGH, ...FABLE_XHIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: true,
  },
  large_program_planning: {
    archetype: "large_program_planning",
    primary: [...ASTRA_MAX, ...NEON_XHIGH, ...SOL_MAX],
    fallback: [...ASTRA_HIGH, ...SOL_HIGH, ...LEGACY_SOL_MAX, ...OPUS_HIGH, ...FABLE_XHIGH],
    qualityFloor: 0.7,
    deterministicPassFloor: 0.72,
    allowSuperSaturation: true,
    mutatesRepository: false,
    evidenceRanked: true,
    preferPrimary: {
      reason: "prefer corroborated frontier capability for large plans within the consequence and context bounds",
    },
  },
  long_context_synthesis: {
    archetype: "long_context_synthesis",
    primary: SOL_HIGH,
    // Keep Terra's context-efficient max workload where the endpoint can fit its measured peak
    // below half the window. Scoped Opus 4.6 remains relevant only where step count binds.
    fallback: [...OPUS_MEDIUM, ...OPUS_46_HIGH, ...TERRA_MAX],
    qualityFloor: 0.72,
    deterministicPassFloor: 0.68,
    allowSuperSaturation: false,
    mutatesRepository: false,
    evidenceRanked: true,
  },
  highest_risk_advisory: {
    archetype: "highest_risk_advisory",
    primary: [...ASTRA_MAX, ...SOL_MAX, ...ASTRA_HIGH],
    fallback: [...SOL_HIGH, ...LEGACY_SOL_MAX, ...OPUS_HIGH, ...OPUS_MEDIUM],
    qualityFloor: 0.8,
    deterministicPassFloor: 0.73,
    allowSuperSaturation: true,
    mutatesRepository: false,
    evidenceRanked: true,
    preferPrimary: {
      reason: "use Astra max only for read-only consequence, then favor qualified Sol max or Astra high",
    },
  },
};

/**
 * Reviewer ladders, ordered by evidence-derived ability.
 *
 * Declared as a partial map rather than a total record over ModelVendor, so a newly supported vendor
 * does not oblige anyone to invent reviewer tiers for it. A vendor absent here simply contributes no
 * reviewer, which `reviewerRefs` reports as an empty list and `selectReviewRoute` handles by looking
 * to the remaining vendors.
 *
 * Claude Sonnet 5 is absent: at high effort it measures in the lowest ability band (48.2% pass, 138
 * median steps, p90 peak context 286,022), so it can no longer serve as a mid-tier reviewer.
 *
 * The ability-1 OpenAI and Anthropic rungs are also absent. A reviewer must be able to reason about
 * a diff, and the lowest-band configurations either cliff catastrophically (gpt-6-luna at low
 * effort passes 1.5% and breaks previously passing tests at 27.7%) or carry no agentic measurement
 * at all (claude-haiku-4-5). Google's rung leads with Gemini 4 Neon, then falls back through older
 * generations as needed. It is an ordered availability chain rather than a set of equal bands.
 */
const REVIEWER_TIERS: Partial<Record<ModelVendor, readonly (readonly CandidateRef[])[]>> = {
  openai: [ASTRA_HIGH, SOL_MEDIUM, SOL_HIGH],
  anthropic: [OPUS_LOW, OPUS_MEDIUM, OPUS_HIGH, FABLE_XHIGH],
  google: [GEMINI_REVIEW],
};

/** Vendors that actually declare a reviewer ladder, in MODEL_VENDORS order. */
export function reviewerVendors(): readonly ModelVendor[] {
  return MODEL_VENDORS.filter((vendor) => (REVIEWER_TIERS[vendor]?.length ?? 0) > 0);
}

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
  ...MODEL_VENDORS.flatMap((vendor) => (REVIEWER_TIERS[vendor] ?? []).flat()),
  ...HARD_TASK_ESCALATION_REFS,
];

/**
 * Ability is a per-(model, effort) judgment derived from cross-source consensus bands, not a uniform
 * effort bump: gpt-5.6-terra stays in a low band at high effort while claude-opus-5-5 reaches the top
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
  // A vendor with no declared ladder contributes no reviewer rather than throwing, so the review
  // path stays defined for every member of an arbitrarily sized vendor set.
  if (!tiers || tiers.length === 0) return [];
  const band = (tier: readonly CandidateRef[]) => tier[0]?.ability ?? 0;
  const preferred = tiers.filter((tier) => band(tier) >= minimumAbility);
  // Stronger catalogue entries can be out of scope or unsupported on a given machine. Try the
  // strongest remaining lower band before losing the vendor and failing the independence floor.
  const below = tiers.filter((tier) => band(tier) < minimumAbility).sort((a, b) => band(b) - band(a));
  return [...preferred, ...below].flat();
}
