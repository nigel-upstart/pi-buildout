import type { TaskLease } from "./lease.ts";
import type { RouteChoice } from "./routing.ts";

// Cross-lease endpoint circuit breaking and background health recovery are tracked in
// nigel-upstart/pi-buildout/issues/53 and #54; this module intentionally handles only bounded in-lease fallback.
export type FailureKind = "availability" | "model_error" | "quality" | "deterministic_verification";

const NON_RETRYABLE_PROVIDER_QUOTA_ERROR_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|usage.?limit|insufficient_quota|out of budget|quota exceeded|quota[^.]{0,20}exhaust|billing/i;

export function isProviderQuotaExhaustionError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return NON_RETRYABLE_PROVIDER_QUOTA_ERROR_PATTERN.test(errorMessage);
}

export type FallbackResolution =
  | { action: "use_choice"; choice: RouteChoice; lease: TaskLease; reason: string; reviewFellBackToBuilder: boolean }
  | { action: "restore_previous"; choice?: RouteChoice; lease: TaskLease; reason: string };

export function validateFallbackTopology(lease: TaskLease): string[] {
  const errors: string[] = [];
  if (lease.archetype === "code_review") {
    if (lease.fallbacks.length === 0) errors.push("standalone review must have at least one feature-routed fallback");
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

  return {
    action: "restore_previous",
    ...(lease.previousSelection ? { choice: lease.previousSelection } : {}),
    // Terminal: keep the original topology so the persisted lease still validates on restore.
    lease,
    reason:
      lease.archetype === "code_review"
        ? "all standalone review attempts failed; restoring the previous selection"
        : "all authorized ordinary provider choices exhausted; restoring the previous selection",
  };
}
