import type { TaskLease } from "./lease.ts";
import { MINIMUM_INDEPENDENT_REVIEWERS } from "./routing.ts";
import type { RouteChoice } from "./routing.ts";

// Cross-lease endpoint circuit breaking and background health recovery are tracked in
// nigel-upstart/pi-buildout/issues/53 and #54; this module intentionally handles only bounded in-lease fallback.
export type FailureKind = "availability" | "model_error" | "quality" | "deterministic_verification";

const NON_RETRYABLE_PROVIDER_QUOTA_ERROR_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|usage.?limit|insufficient_quota|out of budget|quota exceeded|billing/i;

export function isProviderQuotaExhaustionError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return NON_RETRYABLE_PROVIDER_QUOTA_ERROR_PATTERN.test(errorMessage);
}

export type FallbackResolution =
  | { action: "use_choice"; choice: RouteChoice; lease: TaskLease; reason: string; reviewFellBackToBuilder: boolean }
  | { action: "restore_previous"; choice?: RouteChoice; lease: TaskLease; reason: string }
  | { action: "skip_review"; lease: TaskLease; reason: string };

export function validateFallbackTopology(lease: TaskLease): string[] {
  const errors: string[] = [];
  if (lease.archetype === "code_review") {
    if (lease.lifecycle.phase === "review") {
      // A tracked review holds one reviewer per eligible non-builder vendor, so the chain length
      // follows the supported vendor set and is not fixed. Only the independence floor is asserted
      // here, matching selectReviewRoute; asserting an exact length would silently discard a
      // restored lease the moment a vendor is added, and isTaskLease treats that as an invalid lease.
      const attempts = [lease.selected, ...lease.fallbacks];
      if (attempts.length < MINIMUM_INDEPENDENT_REVIEWERS) {
        errors.push(
          `tracked-work review must have at least ${String(MINIMUM_INDEPENDENT_REVIEWERS)} independent attempts`,
        );
      }
      const builderVendor = lease.parentLease?.selected.vendor;
      const vendors = new Set(attempts.map((choice) => choice.vendor));
      // Independence, stated directly rather than inferred from a vendor count: no attempt may share
      // the builder's vendor, and the attempts must come from distinct vendors so a second attempt is
      // a genuinely independent opinion rather than the same vendor twice.
      if (builderVendor !== undefined && vendors.has(builderVendor)) {
        errors.push("tracked-work review must not include the builder's vendor");
      }
      if (vendors.size !== attempts.length) {
        errors.push("tracked-work review attempts must each come from a different vendor");
      }
      if (vendors.size < MINIMUM_INDEPENDENT_REVIEWERS) {
        errors.push(
          `tracked-work review must draw on at least ${String(MINIMUM_INDEPENDENT_REVIEWERS)} non-builder vendors`,
        );
      }
    } else {
      if (lease.fallbacks.length === 0) errors.push("standalone review must have at least one feature-routed fallback");
    }
  } else if (lease.fallbacks.length === 0) {
    errors.push("ordinary lease must have at least one fallback");
  }
  return errors;
}

export function resolveFallback(
  lease: TaskLease,
  failure: FailureKind,
  now: string,
  options?: { skipProvider?: string },
): FallbackResolution {
  const skipProvider = options?.skipProvider;
  // attemptIndex indexes into fallbacks, so only the untried suffix may be filtered.
  const remainingFallbacks =
    skipProvider !== undefined
      ? [
          ...lease.fallbacks.slice(0, lease.attemptIndex),
          ...lease.fallbacks.slice(lease.attemptIndex).filter((choice) => choice.provider !== skipProvider),
        ]
      : lease.fallbacks;
  const isSkipped = remainingFallbacks.length < lease.fallbacks.length;

  const nextAttempt = lease.attemptIndex + 1;
  const nextChoice = remainingFallbacks[lease.attemptIndex];
  if (nextChoice) {
    const isBuilderFallback = false;
    const updated: TaskLease = {
      ...lease,
      updatedAt: now,
      attemptIndex: nextAttempt,
      selected: nextChoice,
      fallbacks: remainingFallbacks,
      promptProfileId: nextChoice.profileId,
    };
    return {
      action: "use_choice",
      choice: nextChoice,
      lease: updated,
      reason:
        isSkipped && skipProvider !== undefined
          ? `sequential fallback after ${failure} (fast-skipped exhausted provider ${skipProvider})`
          : `sequential fallback after ${failure}`,
      reviewFellBackToBuilder: isBuilderFallback,
    };
  }

  if (lease.archetype === "code_review" && lease.lifecycle.phase === "review") {
    return {
      action: "skip_review",
      lease: { ...lease, fallbacks: remainingFallbacks },
      reason: "all review attempts failed; preserve the parent task lease",
    };
  }
  return {
    action: "restore_previous",
    ...(lease.previousSelection ? { choice: lease.previousSelection } : {}),
    lease: { ...lease, fallbacks: remainingFallbacks },
    reason:
      lease.archetype === "code_review"
        ? "all standalone review attempts failed; restoring the previous selection"
        : "all authorized ordinary provider choices exhausted; restoring the previous selection",
  };
}
