import type { TaskLease } from "./lease.ts";
import type { RouteChoice } from "./routing.ts";

// Cross-lease endpoint circuit breaking and background health recovery are tracked in
// specs/routing-layer/future-work.md; this module intentionally handles only bounded in-lease fallback.
export type FailureKind = "availability" | "model_error" | "quality" | "deterministic_verification";

export type FallbackResolution =
  | { action: "use_choice"; choice: RouteChoice; lease: TaskLease; reason: string; reviewFellBackToBuilder: boolean }
  | { action: "restore_previous"; choice?: RouteChoice; lease: TaskLease; reason: string }
  | { action: "skip_review"; lease: TaskLease; reason: string };

export function validateFallbackTopology(lease: TaskLease): string[] {
  const errors: string[] = [];
  if (lease.archetype === "code_review") {
    if (lease.lifecycle.phase === "review") {
      if (lease.fallbacks.length !== 1) errors.push("tracked-work review must have exactly one independent fallback");
      const builderVendor = lease.parentLease?.selected.vendor;
      const vendors = new Set([lease.selected, ...lease.fallbacks].map((choice) => choice.vendor));
      if (vendors.size !== 2 || (builderVendor !== undefined && vendors.has(builderVendor))) {
        errors.push("tracked-work review attempts must use both non-builder vendors");
      }
    } else {
      if (lease.fallbacks.length === 0) errors.push("standalone review must have at least one feature-routed fallback");
    }
  } else if (lease.fallbacks.length === 0) {
    errors.push("ordinary lease must have at least one fallback");
  }
  return errors;
}

export function resolveFallback(lease: TaskLease, failure: FailureKind, now: string): FallbackResolution {
  const nextAttempt = lease.attemptIndex + 1;
  const nextChoice = lease.fallbacks[lease.attemptIndex];
  if (nextChoice) {
    const isBuilderFallback = false;
    const updated: TaskLease = {
      ...lease,
      updatedAt: now,
      attemptIndex: nextAttempt,
      selected: nextChoice,
      promptProfileId: nextChoice.profileId,
    };
    return {
      action: "use_choice",
      choice: nextChoice,
      lease: updated,
      reason: `sequential fallback after ${failure}`,
      reviewFellBackToBuilder: isBuilderFallback,
    };
  }

  if (lease.archetype === "code_review" && lease.lifecycle.phase === "review") {
    return { action: "skip_review", lease, reason: "all review attempts failed; preserve the parent task lease" };
  }
  return {
    action: "restore_previous",
    ...(lease.previousSelection ? { choice: lease.previousSelection } : {}),
    lease,
    reason:
      lease.archetype === "code_review"
        ? "all standalone review attempts failed; restoring the previous selection"
        : "all authorized ordinary provider choices exhausted; restoring the previous selection",
  };
}
