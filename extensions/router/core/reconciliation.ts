import type { Archetype } from "./archetype.ts";
import type { TaskFeatures } from "./features.ts";
import type { RegistryModelSnapshot, RouteChoice } from "./routing.ts";

export type CacheValueEstimate = {
  cachedTokens: number;
  expectedReuseRatio: number;
};

export type SecondaryReconciliationPolicy = {
  /** Total runtime budget for the background secondary classifier before it is aborted. */
  secondaryDeadlineMs: number;
  /** Benefit assigned to a material routing correction, compared against its cache-switch cost. */
  materialCorrectionBenefitUsd: number;
};

/**
 * The secondary classifier runs in the background without delaying the first provider request.
 * Its deadline bounds background work, not a foreground wait. A later material routing correction
 * is accepted only when its benefit exceeds the estimated cache-switch penalty:
 *
 *   reusable tokens / 1,000,000 * max(corrected cache-write rate - incumbent cache-read rate, 0)
 */
export const DEFAULT_SECONDARY_RECONCILIATION_POLICY: SecondaryReconciliationPolicy = Object.freeze({
  secondaryDeadlineMs: 15_000,
  materialCorrectionBenefitUsd: 0.02,
});

export type ReconciliationDelta = {
  material: boolean;
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

function correctedCacheWriteRate(endpointSnapshot: RegistryModelSnapshot | undefined): number {
  if (!endpointSnapshot) return 0;
  return nonnegativeFinite(endpointSnapshot.costPerMillion.cacheWrite);
}

function sameEndpoint(
  incumbent: Pick<RouteChoice, "provider" | "modelId">,
  corrected: Pick<RouteChoice, "provider" | "modelId">,
): boolean {
  return incumbent.provider === corrected.provider && incumbent.modelId === corrected.modelId;
}

export function estimateCacheSwitchPenaltyUsd(
  cache: CacheValueEstimate,
  incumbent: Pick<RouteChoice, "provider" | "modelId">,
  corrected: Pick<RouteChoice, "provider" | "modelId">,
  registry: readonly RegistryModelSnapshot[],
): number {
  // A correction that keeps the incumbent endpoint (for example an effort-only change) keeps that
  // endpoint's existing cache, so there is no cache-switch penalty to price. Charging a fresh
  // cache write here would make the benefit test reject free corrections.
  if (sameEndpoint(incumbent, corrected)) return 0;
  const tokens = expectedReusableTokens(cache);
  if (tokens <= 0) return 0;
  const incumbentCacheReadRate = endpoint(registry, incumbent)?.costPerMillion.cacheRead ?? 0;
  const correctedRate = correctedCacheWriteRate(endpoint(registry, corrected));
  return (tokens / 1_000_000) * Math.max(0, correctedRate - incumbentCacheReadRate);
}

export function reconciliationDelta(
  primary: TaskFeatures,
  corrected: TaskFeatures,
  incumbent: RouteChoice,
  correctedChoice: RouteChoice,
  archetypes: { incumbent: Archetype; corrected: Archetype },
): ReconciliationDelta {
  const reasons: string[] = [];
  if (incumbent.profileId !== correctedChoice.profileId) reasons.push("prompt_profile_changed");
  if (incumbent.logicalModelId !== correctedChoice.logicalModelId) reasons.push("logical_model_changed");
  if (incumbent.effort !== correctedChoice.effort) reasons.push("effort_changed");
  if (incumbent.ability !== correctedChoice.ability) reasons.push("capability_band_changed");
  // The archetype selects lifecycle tools and review flows on its own, so a corrected archetype is
  // material even when the route keeps the same model, profile, and effort.
  if (archetypes.incumbent !== archetypes.corrected) reasons.push("archetype_changed");
  if (!primary.decompositionRecommended && corrected.decompositionRecommended) reasons.push("decomposition_required");
  if (primary.independenceRequirement !== corrected.independenceRequirement) reasons.push("independence_changed");

  return {
    material: reasons.length > 0,
    reasons: [...new Set(reasons)],
  };
}

export function decideSecondaryCorrection(
  delta: ReconciliationDelta,
  cacheSwitchPenaltyUsd: number,
  policy: SecondaryReconciliationPolicy = DEFAULT_SECONDARY_RECONCILIATION_POLICY,
): CorrectionDecision {
  const expectedBenefitUsd = delta.material ? policy.materialCorrectionBenefitUsd : 0;
  if (!delta.material) {
    return { action: "reject", reason: "no_material_delta", expectedBenefitUsd };
  }
  if (expectedBenefitUsd <= cacheSwitchPenaltyUsd) {
    return { action: "reject", reason: "cache_penalty_exceeds_benefit", expectedBenefitUsd };
  }
  return { action: "accept", expectedBenefitUsd };
}
