import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { Static, TUnsafe } from "typebox";
import { Check, Errors } from "typebox/value";
import { isCodeBuilder } from "./features.ts";
import type { TaskFeatures } from "./features.ts";
import { isReadOnlyShellCommand } from "./shell.ts";

function stringEnum<const TValues extends readonly string[]>(values: TValues): TUnsafe<TValues[number]> {
  return Type.Unsafe<TValues[number]>({ type: "string", enum: [...values] });
}

const SAFETY_POLICIES = [
  "ordinary",
  "completion_review",
  "advisory_then_completion_review",
  "authorization_then_completion_review",
] as const;
export type SafetyPolicy = (typeof SAFETY_POLICIES)[number];

const REVIEW_KINDS = ["authorization", "advisory", "completion"] as const;
export type SafetyReviewKind = (typeof REVIEW_KINDS)[number];

const REVIEW_VERDICTS = [
  "approve",
  "reject",
  "proceed",
  "caution",
  "do_not_proceed",
  "pass",
  "changes_requested",
] as const;
type SafetyReviewVerdict = (typeof REVIEW_VERDICTS)[number];

const VERDICTS_BY_KIND: Readonly<Record<SafetyReviewKind, readonly SafetyReviewVerdict[]>> = {
  authorization: ["approve", "reject"],
  advisory: ["proceed", "caution", "do_not_proceed"],
  completion: ["pass", "changes_requested"],
};

const NonEmptyString = Type.String({ minLength: 1, maxLength: 2_000 });
const ShortString = Type.String({ minLength: 1, maxLength: 300 });

export const ActionPlanSchema = Type.Object(
  {
    objective: NonEmptyString,
    targets: Type.Array(ShortString, { minItems: 1, maxItems: 100 }),
    assumptions: Type.Array(NonEmptyString, { maxItems: 100 }),
    preconditions: Type.Array(NonEmptyString, { minItems: 1, maxItems: 100 }),
    steps: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$" }),
          action: NonEmptyString,
          target: ShortString,
          expectedEffect: NonEmptyString,
          potentiallyIrreversible: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
    verification: Type.Array(NonEmptyString, { minItems: 1, maxItems: 100 }),
    rollback: Type.Array(NonEmptyString, { minItems: 1, maxItems: 100 }),
    abortConditions: Type.Array(NonEmptyString, { minItems: 1, maxItems: 100 }),
    authorizedToolNames: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
      minItems: 1,
      maxItems: 100,
    }),
  },
  { additionalProperties: false },
);

type ActionPlan = Static<typeof ActionPlanSchema>;

export type ActionPlanValidation =
  { success: true; plan: ActionPlan; fingerprint: string; errors: [] } | { success: false; errors: string[] };

export const SafetyReviewSchema = Type.Object(
  {
    reviewKind: stringEnum(REVIEW_KINDS),
    scopeFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    verdict: stringEnum(REVIEW_VERDICTS),
    summary: NonEmptyString,
    evidence: Type.Array(NonEmptyString, { minItems: 1, maxItems: 100 }),
    findings: Type.Array(NonEmptyString, { maxItems: 100 }),
  },
  { additionalProperties: false },
);

export type SafetyReviewSubmission = Static<typeof SafetyReviewSchema>;

type PlanEvidence = {
  taskFingerprint: string;
  planFingerprint: string;
  submittedAt: string;
  plan: ActionPlan;
};

export type CompletionEvidence = {
  taskFingerprint: string;
  baselineHead?: string;
  completedHead?: string;
  changedFiles: string[];
  diffFingerprint?: string;
  checks: { command: string; passed: boolean; recordedAt: string }[];
  mutations: { toolName: string; inputFingerprint: string; recordedAt: string }[];
  evidenceFingerprint: string;
};

type AuthorizationEvidence = {
  taskFingerprint: string;
  planFingerprint: string;
  reviewTaskId: string;
  reviewerVendor: string;
  sessionId: string;
  approvedAt: string;
};

export type ReviewOutcome = {
  kind: SafetyReviewKind;
  verdict?: SafetyReviewVerdict;
  summary: string;
  reviewTaskId?: string;
  completedAt: string;
};

export type LeaseLifecycle =
  | { phase: "ordinary"; policy: "ordinary"; taskFingerprint: string }
  | {
      phase: "building";
      policy: "completion_review";
      taskFingerprint: string;
      evidenceRepairAttempted?: boolean;
    }
  | {
      phase: "advisory_pending";
      policy: "advisory_then_completion_review";
      taskFingerprint: string;
    }
  | {
      phase: "ready_after_advisory";
      policy: "advisory_then_completion_review";
      taskFingerprint: string;
      advisory: ReviewOutcome;
      evidenceRepairAttempted?: boolean;
    }
  | {
      phase: "preflight";
      policy: "authorization_then_completion_review";
      taskFingerprint: string;
      plan?: PlanEvidence;
      lastAuthorizationReview?: ReviewOutcome;
      evidenceRepairAttempted?: boolean;
    }
  | {
      phase: "authorized_execution";
      policy: "authorization_then_completion_review";
      taskFingerprint: string;
      plan: PlanEvidence;
      authorization: AuthorizationEvidence;
      evidenceRepairAttempted?: boolean;
    }
  | {
      phase: "completed";
      policy: Exclude<SafetyPolicy, "ordinary">;
      taskFingerprint: string;
      completionReview: ReviewOutcome;
      plan?: PlanEvidence;
      authorization?: AuthorizationEvidence;
      advisory?: ReviewOutcome;
    }
  | {
      phase: "review";
      policy: "ordinary";
      taskFingerprint: string;
      reviewKind: SafetyReviewKind;
      scopeFingerprint: string;
      submission?: SafetyReviewSubmission;
    };

export type SafetyEvidenceLog = {
  baselineHead?: string;
  baselineChangedFiles: string[];
  checks: { command: string; passed: boolean; recordedAt: string }[];
  mutations: { toolName: string; inputFingerprint: string; recordedAt: string }[];
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function safetyFingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function validateActionPlan(value: unknown): ActionPlanValidation {
  if (!Check(ActionPlanSchema, value)) {
    return {
      success: false,
      errors: [...Errors(ActionPlanSchema, value)]
        .slice(0, 20)
        .map((error) => `${error.instancePath || "/"}: ${error.message}`),
    };
  }
  const ids = new Set<string>();
  const errors: string[] = [];
  const declaredTargets = new Set(value.targets);
  for (const step of value.steps) {
    if (ids.has(step.id)) errors.push(`duplicate action step id: ${step.id}`);
    ids.add(step.id);
    if (!declaredTargets.has(step.target)) {
      errors.push(`step ${step.id} acts on undeclared target: ${step.target}`);
    }
  }
  if (!value.steps.some((step) => step.potentiallyIrreversible)) {
    errors.push("at least one step must identify the potentially irreversible effect being authorized");
  }
  if (new Set(value.targets).size !== value.targets.length) errors.push("targets must not contain duplicates");
  if (new Set(value.authorizedToolNames).size !== value.authorizedToolNames.length) {
    errors.push("authorizedToolNames must not contain duplicates");
  }
  return errors.length > 0
    ? { success: false, errors }
    : { success: true, plan: value, fingerprint: safetyFingerprint(value), errors: [] };
}

export function validateSafetyReview(
  value: unknown,
  expectedKind: SafetyReviewKind,
  expectedScopeFingerprint: string,
): { success: true; submission: SafetyReviewSubmission } | { success: false; errors: string[] } {
  if (!Check(SafetyReviewSchema, value)) {
    return {
      success: false,
      errors: [...Errors(SafetyReviewSchema, value)]
        .slice(0, 20)
        .map((error) => `${error.instancePath || "/"}: ${error.message}`),
    };
  }
  const errors: string[] = [];
  if (value.reviewKind !== expectedKind) errors.push(`expected ${expectedKind} review, received ${value.reviewKind}`);
  if (value.scopeFingerprint !== expectedScopeFingerprint) errors.push("review scope fingerprint does not match");
  if (!VERDICTS_BY_KIND[expectedKind].includes(value.verdict)) {
    errors.push(`verdict ${value.verdict} is invalid for ${expectedKind} review`);
  }
  return errors.length > 0 ? { success: false, errors } : { success: true, submission: value };
}

export function deriveSafetyPolicy(features: TaskFeatures): SafetyPolicy {
  const standaloneReview = features.workflowType === "code_review" || features.intent === "review";
  if (standaloneReview) return "ordinary";
  const highRisk = features.risk === "high" || features.risk === "critical";
  const irreversible = features.actionMode === "external_side_effect" || features.actionMode === "destructive";
  if (highRisk && irreversible) return "authorization_then_completion_review";
  const mutating = features.actionMode === "reversible_mutation";
  if (highRisk && mutating && isCodeBuilder(features)) return "completion_review";
  if (highRisk && mutating) return "advisory_then_completion_review";
  return "ordinary";
}

export function initialLifecycle(policy: SafetyPolicy, taskFingerprint: string): LeaseLifecycle {
  switch (policy) {
    case "completion_review":
      return { phase: "building", policy, taskFingerprint };
    case "advisory_then_completion_review":
      return { phase: "advisory_pending", policy, taskFingerprint };
    case "authorization_then_completion_review":
      return { phase: "preflight", policy, taskFingerprint };
    default:
      return { phase: "ordinary", policy, taskFingerprint };
  }
}

/** The lifecycle instruction added to the system prompt, or undefined where no phase constraint applies. */
export function safetyContextForLifecycle(lifecycle: LeaseLifecycle): string | undefined {
  switch (lifecycle.phase) {
    case "preflight":
      return "Safety lifecycle: remain non-mutating. Inspect targets, then call submit_action_plan with a concrete irreversible-action plan. Execution requires a separate independent approval of the exact task and plan fingerprints.";
    case "advisory_pending":
      return "Safety lifecycle: remain non-mutating while gathering bounded context for a pre-action advisor.";
    case "authorized_execution":
      return `Safety lifecycle: execute only authorized plan ${lifecycle.plan.planFingerprint}; changed targets, steps, or preconditions require a new preflight and review.`;
    case "review":
      return `Safety lifecycle: read-only ${lifecycle.reviewKind} review scoped to ${lifecycle.scopeFingerprint}; submit the verdict with submit_safety_review.`;
    case "ordinary":
    case "building":
    case "ready_after_advisory":
    case "completed":
      return undefined;
  }
}

export function lifecycleRequiresCompletionReview(lifecycle: LeaseLifecycle): boolean {
  return (
    lifecycle.phase === "building" ||
    lifecycle.phase === "ready_after_advisory" ||
    lifecycle.phase === "authorized_execution"
  );
}

export function lifecycleToolBlockReason(
  lifecycle: LeaseLifecycle | undefined,
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!lifecycle) return undefined;
  if (
    lifecycle.phase === "authorized_execution" &&
    isPotentiallyMutatingTool(toolName, input) &&
    !lifecycle.plan.plan.authorizedToolNames.includes(toolName)
  ) {
    return `Tool ${toolName} is outside the independently reviewed action plan`;
  }
  const restricted =
    lifecycle.phase === "review" || lifecycle.phase === "preflight" || lifecycle.phase === "advisory_pending";
  if (!restricted) return undefined;
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") return undefined;
  if (toolName === "bash" && isReadOnlyShellCommand(typeof input.command === "string" ? input.command : "")) {
    return undefined;
  }
  if (lifecycle.phase === "review" && toolName === "submit_safety_review") return undefined;
  if (lifecycle.phase === "preflight" && toolName === "submit_action_plan") return undefined;
  if (lifecycle.phase === "review") return "Independent safety review lease is read-only";
  if (lifecycle.phase === "preflight")
    return "Irreversible-action preflight is non-mutating until its plan is approved";
  return "High-risk advisory must complete before mutating tools are used";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function reviewOutcome(value: unknown, kind?: SafetyReviewKind): value is ReviewOutcome {
  const outcome = object(value);
  return Boolean(
    outcome &&
    REVIEW_KINDS.includes(outcome.kind as SafetyReviewKind) &&
    (kind === undefined || outcome.kind === kind) &&
    typeof outcome.summary === "string" &&
    typeof outcome.completedAt === "string" &&
    (outcome.verdict === undefined ||
      VERDICTS_BY_KIND[outcome.kind as SafetyReviewKind].includes(outcome.verdict as SafetyReviewVerdict)) &&
    (outcome.reviewTaskId === undefined || typeof outcome.reviewTaskId === "string"),
  );
}

function planEvidence(value: unknown, taskFingerprint: string): value is PlanEvidence {
  const evidence = object(value);
  if (
    evidence?.taskFingerprint !== taskFingerprint ||
    typeof evidence.planFingerprint !== "string" ||
    typeof evidence.submittedAt !== "string"
  ) {
    return false;
  }
  const validation = validateActionPlan(evidence.plan);
  return validation.success && validation.fingerprint === evidence.planFingerprint;
}

function authorizationEvidence(
  value: unknown,
  taskFingerprint: string,
  expectedPlanFingerprint: string,
): value is AuthorizationEvidence {
  const authorization = object(value);
  return (
    authorization?.taskFingerprint === taskFingerprint &&
    authorization.planFingerprint === expectedPlanFingerprint &&
    typeof authorization.reviewTaskId === "string" &&
    typeof authorization.reviewerVendor === "string" &&
    typeof authorization.sessionId === "string" &&
    typeof authorization.approvedAt === "string"
  );
}

export function isLeaseLifecycle(value: unknown): value is LeaseLifecycle {
  const lifecycle = object(value);
  if (
    !lifecycle ||
    typeof lifecycle.phase !== "string" ||
    !SAFETY_POLICIES.includes(lifecycle.policy as SafetyPolicy) ||
    typeof lifecycle.taskFingerprint !== "string"
  ) {
    return false;
  }
  const taskFingerprint = lifecycle.taskFingerprint;
  if (lifecycle.evidenceRepairAttempted !== undefined && typeof lifecycle.evidenceRepairAttempted !== "boolean") {
    return false;
  }
  switch (lifecycle.phase) {
    case "ordinary":
      return lifecycle.policy === "ordinary";
    case "building":
      return lifecycle.policy === "completion_review";
    case "advisory_pending":
      return lifecycle.policy === "advisory_then_completion_review";
    case "ready_after_advisory":
      return lifecycle.policy === "advisory_then_completion_review" && reviewOutcome(lifecycle.advisory, "advisory");
    case "preflight":
      return (
        lifecycle.policy === "authorization_then_completion_review" &&
        (lifecycle.plan === undefined || planEvidence(lifecycle.plan, taskFingerprint)) &&
        (lifecycle.lastAuthorizationReview === undefined ||
          reviewOutcome(lifecycle.lastAuthorizationReview, "authorization"))
      );
    case "authorized_execution":
      return (
        lifecycle.policy === "authorization_then_completion_review" &&
        planEvidence(lifecycle.plan, taskFingerprint) &&
        authorizationEvidence(lifecycle.authorization, taskFingerprint, lifecycle.plan.planFingerprint)
      );
    case "completed": {
      if (lifecycle.policy === "ordinary" || !reviewOutcome(lifecycle.completionReview, "completion")) return false;
      if (lifecycle.policy === "authorization_then_completion_review") {
        return (
          planEvidence(lifecycle.plan, taskFingerprint) &&
          authorizationEvidence(lifecycle.authorization, taskFingerprint, lifecycle.plan.planFingerprint)
        );
      }
      return lifecycle.policy !== "advisory_then_completion_review" || reviewOutcome(lifecycle.advisory, "advisory");
    }
    case "review":
      return (
        lifecycle.policy === "ordinary" &&
        REVIEW_KINDS.includes(lifecycle.reviewKind as SafetyReviewKind) &&
        typeof lifecycle.scopeFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(lifecycle.scopeFingerprint) &&
        (lifecycle.submission === undefined ||
          validateSafetyReview(
            lifecycle.submission,
            lifecycle.reviewKind as SafetyReviewKind,
            lifecycle.scopeFingerprint,
          ).success)
      );
    default:
      return false;
  }
}

export function isSafetyEvidenceLog(value: unknown): value is SafetyEvidenceLog {
  const evidence = object(value);
  return Boolean(
    evidence &&
    (evidence.baselineHead === undefined || typeof evidence.baselineHead === "string") &&
    Array.isArray(evidence.baselineChangedFiles) &&
    evidence.baselineChangedFiles.length <= 10_000 &&
    evidence.baselineChangedFiles.every((item) => typeof item === "string" && item.length <= 1_000) &&
    Array.isArray(evidence.checks) &&
    evidence.checks.length <= 20 &&
    evidence.checks.every((item) => {
      const check = object(item);
      return (
        check &&
        typeof check.command === "string" &&
        check.command.length <= 500 &&
        typeof check.passed === "boolean" &&
        typeof check.recordedAt === "string"
      );
    }) &&
    Array.isArray(evidence.mutations) &&
    evidence.mutations.length <= 50 &&
    evidence.mutations.every((item) => {
      const mutation = object(item);
      return (
        mutation &&
        typeof mutation.toolName === "string" &&
        typeof mutation.inputFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(mutation.inputFingerprint) &&
        typeof mutation.recordedAt === "string"
      );
    }),
  );
}

export function isPotentiallyMutatingTool(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "submit_action_plan" || toolName === "submit_safety_review") return false;
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") return false;
  if (toolName === "bash") return !isReadOnlyShellCommand(typeof input.command === "string" ? input.command : "");
  return true;
}
