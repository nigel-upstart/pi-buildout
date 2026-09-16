import type { TaskFeatures } from "./features.ts";
import { deriveSafetyPolicy } from "./safety.ts";
import type { SafetyPolicy } from "./safety.ts";
import type { RegistryModelSnapshot, RouteChoice } from "./routing.ts";

const RISK_RANK = ["low", "medium", "high", "critical"] as const;
const ACTION_RANK = [
  "information_only",
  "local_read",
  "reversible_mutation",
  "external_side_effect",
  "destructive",
] as const;
const VERIFICATION_RANK = ["none", "self_check", "unit_tests", "integration_tests", "security_and_policy"] as const;
const SAFETY_POLICY_RANK: readonly SafetyPolicy[] = [
  "ordinary",
  "completion_review",
  "advisory_then_completion_review",
  "authorization_then_completion_review",
];

export type CacheValueEstimate = {
  cachedTokens: number;
  expectedReuseRatio: number;
};

export type SecondaryGracePolicy = {
  /** Maximum time to hold the first provider request for a secondary result. */
  maxGraceMs: number;
  /** Total runtime budget for the background secondary classifier before it is aborted. */
  secondaryDeadlineMs: number;
  lowPenaltyUsd: number;
  mediumPenaltyUsd: number;
  lowPenaltyGraceMs: number;
  mediumPenaltyGraceMs: number;
  highPenaltyGraceMs: number;
  materialCorrectionBenefitUsd: number;
  safetyCorrectionBenefitUsd: number;
};

/**
 * Cache-aware secondary reconciliation trades a small wait before the first agent request against
 * the cost of discovering that the secondary classifier would choose a different uncached route.
 * The selected grace is always:
 *
 *   min(cache-risk bucket, maxGraceMs, secondaryDeadlineMs)
 *
 * `maxGraceMs` only caps how long the router pauses before releasing the first provider request.
 * `secondaryDeadlineMs` is the longer background-classifier timeout: after the grace expires, the
 * agent can start on the primary route while the secondary classifier continues until that deadline
 * and can still reconcile at a safe boundary.
 *
 * The penalty is estimated as:
 *
 *   reusable tokens * max(corrected uncached/write rate - incumbent cache-read rate, 0)
 *
 * with rates converted from per-million-token pricing into dollars. For example, 1,000,000 cached
 * tokens with 100% expected reuse leaves 1,000,000 reusable tokens. If the incumbent can read those
 * at $0.10/M but the corrected route would need $4.10/M uncached/write input, the plausible penalty
 * is 1,000,000 / 1,000,000 * ($4.10 - $0.10) = $4.00. With the defaults below, that enters the high
 * bucket: the first request waits up to 400ms, while the secondary classifier may keep running until
 * the 15s deadline and reconcile later.
 *
 * If the plausible penalty is low, we wait less because switching routes is cheap. If it is high, we
 * allow more time for the secondary result so we do not eagerly spend expensive cacheable context on
 * a route that may need correction. To hard-block the first request for the full classifier budget on
 * expensive cache risk, configure `maxGraceMs` and the desired bucket grace to match
 * `secondaryDeadlineMs`; the built-in defaults prefer bounded start latency and rely on later
 * reconciliation plus the correction-benefit thresholds below.
 */
export const DEFAULT_SECONDARY_GRACE_POLICY: SecondaryGracePolicy = Object.freeze({
  maxGraceMs: 15_000,
  secondaryDeadlineMs: 15_000,
  lowPenaltyUsd: 0.001,
  mediumPenaltyUsd: 0.01,
  lowPenaltyGraceMs: 75,
  mediumPenaltyGraceMs: 200,
  highPenaltyGraceMs: 400,
  materialCorrectionBenefitUsd: 0.02,
  safetyCorrectionBenefitUsd: 25,
});

export type SecondaryGraceDecision = {
  graceMs: number;
  expectedReusableTokens: number;
  plausibleCacheMissPenaltyUsd: number;
};

export type ReconciliationDelta = {
  material: boolean;
  safetyRelevant: boolean;
  reasons: string[];
};

export type CorrectionDecision =
  | { action: "accept"; expectedBenefitUsd: number }
  | { action: "reject"; reason: "no_material_delta" | "cache_penalty_exceeds_benefit"; expectedBenefitUsd: number };

function endpoint(
  registry: readonly RegistryModelSnapshot[],
  choice: Pick<RouteChoice, "provider" | "modelId">,
): RegistryModelSnapshot | undefined {
  return registry.find((candidate) => candidate.provider === choice.provider && candidate.modelId === choice.modelId);
}

function nonnegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function expectedReusableTokens(cache: CacheValueEstimate): number {
  return nonnegativeFinite(cache.cachedTokens) * Math.min(1, nonnegativeFinite(cache.expectedReuseRatio));
}

function correctedUncachedInputRate(endpointSnapshot: RegistryModelSnapshot | undefined): number {
  if (!endpointSnapshot) return 0;
  return endpointSnapshot.costPerMillion.input + Math.max(0, endpointSnapshot.costPerMillion.cacheWrite);
}

export function estimateCacheSwitchPenaltyUsd(
  cache: CacheValueEstimate,
  incumbent: Pick<RouteChoice, "provider" | "modelId">,
  corrected: Pick<RouteChoice, "provider" | "modelId">,
  registry: readonly RegistryModelSnapshot[],
): number {
  const tokens = expectedReusableTokens(cache);
  if (tokens <= 0) return 0;
  const incumbentCacheReadRate = endpoint(registry, incumbent)?.costPerMillion.cacheRead ?? 0;
  const correctedRate = correctedUncachedInputRate(endpoint(registry, corrected));
  return (tokens / 1_000_000) * Math.max(0, correctedRate - incumbentCacheReadRate);
}

export function chooseSecondaryGrace(
  cache: CacheValueEstimate,
  incumbent: Pick<RouteChoice, "provider" | "modelId">,
  registry: readonly RegistryModelSnapshot[],
  policy: SecondaryGracePolicy = DEFAULT_SECONDARY_GRACE_POLICY,
): SecondaryGraceDecision {
  const tokens = expectedReusableTokens(cache);
  const incumbentCacheReadRate = endpoint(registry, incumbent)?.costPerMillion.cacheRead ?? 0;
  const plausibleCorrectedRate = registry.reduce(
    (maximum, candidate) => Math.max(maximum, correctedUncachedInputRate(candidate)),
    0,
  );
  const plausibleCacheMissPenaltyUsd =
    tokens <= 0 ? 0 : (tokens / 1_000_000) * Math.max(0, plausibleCorrectedRate - incumbentCacheReadRate);
  const unclamped =
    plausibleCacheMissPenaltyUsd <= 0
      ? 0
      : plausibleCacheMissPenaltyUsd < policy.lowPenaltyUsd
        ? policy.lowPenaltyGraceMs
        : plausibleCacheMissPenaltyUsd < policy.mediumPenaltyUsd
          ? policy.mediumPenaltyGraceMs
          : policy.highPenaltyGraceMs;
  return {
    graceMs: Math.max(0, Math.min(unclamped, policy.maxGraceMs, policy.secondaryDeadlineMs)),
    expectedReusableTokens: tokens,
    plausibleCacheMissPenaltyUsd,
  };
}

function rankIn<T extends string>(value: T, order: readonly T[]): number {
  return order.indexOf(value);
}

function stricter<T extends string>(before: T, after: T, order: readonly T[]): boolean {
  return rankIn(after, order) > rankIn(before, order);
}

function safetyPolicy(features: TaskFeatures): SafetyPolicy {
  return deriveSafetyPolicy(features);
}

export function reconciliationDelta(
  primary: TaskFeatures,
  corrected: TaskFeatures,
  incumbent: RouteChoice,
  correctedChoice: RouteChoice,
): ReconciliationDelta {
  const reasons: string[] = [];
  if (stricter(primary.risk, corrected.risk, RISK_RANK)) reasons.push("risk_stricter");
  if (stricter(primary.actionMode, corrected.actionMode, ACTION_RANK)) reasons.push("action_mode_stricter");
  if (stricter(primary.verificationStrength, corrected.verificationStrength, VERIFICATION_RANK)) {
    reasons.push("verification_stricter");
  }
  if (stricter(safetyPolicy(primary), safetyPolicy(corrected), SAFETY_POLICY_RANK)) {
    reasons.push("safety_policy_stricter");
  }
  if (
    primary.independenceRequirement !== "different_vendor_review" &&
    corrected.independenceRequirement === "different_vendor_review"
  ) {
    reasons.push("independence_required");
  }
  if (!primary.reviewIntent && corrected.reviewIntent) reasons.push("review_required");

  const safetyRelevant = reasons.length > 0;
  if (incumbent.profileId !== correctedChoice.profileId) reasons.push("prompt_profile_changed");
  if (incumbent.logicalModelId !== correctedChoice.logicalModelId) reasons.push("logical_model_changed");
  if (incumbent.effort !== correctedChoice.effort) reasons.push("effort_changed");
  if (incumbent.ability !== correctedChoice.ability) reasons.push("capability_band_changed");
  if (!primary.decompositionRecommended && corrected.decompositionRecommended) reasons.push("decomposition_required");
  if (primary.independenceRequirement !== corrected.independenceRequirement) reasons.push("independence_changed");

  return {
    material: safetyRelevant || reasons.length > 0,
    safetyRelevant,
    reasons: [...new Set(reasons)],
  };
}

export function decideSecondaryCorrection(
  delta: ReconciliationDelta,
  cacheSwitchPenaltyUsd: number,
  policy: SecondaryGracePolicy = DEFAULT_SECONDARY_GRACE_POLICY,
): CorrectionDecision {
  const expectedBenefitUsd = delta.safetyRelevant
    ? policy.safetyCorrectionBenefitUsd
    : delta.material
      ? policy.materialCorrectionBenefitUsd
      : 0;
  if (!delta.material && !delta.safetyRelevant) {
    return { action: "reject", reason: "no_material_delta", expectedBenefitUsd };
  }
  if (expectedBenefitUsd <= cacheSwitchPenaltyUsd) {
    return { action: "reject", reason: "cache_penalty_exceeds_benefit", expectedBenefitUsd };
  }
  return { action: "accept", expectedBenefitUsd };
}
