import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { Static, TUnsafe } from "typebox";
import { Check, Errors } from "typebox/value";
import { isCodeBuilder, isStandaloneReviewWork } from "./features.ts";
import type { TaskFeatures } from "./features.ts";

function stringEnum<const TValues extends readonly string[]>(values: TValues): TUnsafe<TValues[number]> {
  return Type.Unsafe<TValues[number]>({ type: "string", enum: [...values] });
}

const SAFETY_POLICIES = ["ordinary", "completion_review", "plan_review_then_completion_review"] as const;
export type SafetyPolicy = (typeof SAFETY_POLICIES)[number];

const REVIEW_KINDS = ["plan", "completion"] as const;
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

export const VERDICTS_BY_KIND: Readonly<Record<SafetyReviewKind, readonly SafetyReviewVerdict[]>> = {
  plan: ["approve", "reject", "proceed", "caution", "do_not_proceed"],
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
    toolNames: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
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

type ReviewOutcome = {
  kind: SafetyReviewKind;
  verdict?: SafetyReviewVerdict;
  summary: string;
  reviewTaskId?: string;
  completedAt: string;
};

export type AdvisoryStep = "action_plan" | "plan_review_wait" | "completion_evidence";

export type LeaseLifecycle =
  | { phase: "ordinary"; policy: "ordinary"; taskFingerprint: string }
  | { phase: "building"; policy: "completion_review"; taskFingerprint: string }
  | {
      phase: "planning";
      policy: "plan_review_then_completion_review";
      taskFingerprint: string;
      plan?: PlanEvidence;
      planReview?: ReviewOutcome;
    }
  | {
      phase: "executing";
      policy: "plan_review_then_completion_review";
      taskFingerprint: string;
      plan?: PlanEvidence;
      planReview?: ReviewOutcome;
    }
  | {
      phase: "completed";
      policy: Exclude<SafetyPolicy, "ordinary">;
      taskFingerprint: string;
      completionReview: ReviewOutcome;
      plan?: PlanEvidence;
      planReview?: ReviewOutcome;
    };

export type SafetyEvidenceLog = {
  baselineHead?: string;
  baselineChangedFiles: string[];
  checks: { command: string; passed: boolean; recordedAt: string }[];
  mutations: { toolName: string; inputFingerprint: string; recordedAt: string }[];
};

/**
 * Locale-independent total order on object keys: UTF-16 code units, as `<` compares strings. `localeCompare` is
 * unsuitable here: it follows the host's collation, and it treats distinct but canonically equivalent keys such as
 * "\u00e9" and "e\u0301" as equal, which would make the fingerprint depend on insertion order.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
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
  if (new Set(value.targets).size !== value.targets.length) errors.push("targets must not contain duplicates");
  if (new Set(value.toolNames).size !== value.toolNames.length) {
    errors.push("toolNames must not contain duplicates");
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
  if (isStandaloneReviewWork(features)) return "ordinary";
  const highRisk = features.risk === "high" || features.risk === "critical";
  const irreversible = features.actionMode === "external_side_effect" || features.actionMode === "destructive";
  const broadAutonomousExternalLoop =
    features.actionMode === "external_side_effect" &&
    features.interactivity === "autonomous" &&
    features.horizon === "program_unknown_size";
  if ((highRisk || broadAutonomousExternalLoop) && irreversible) return "plan_review_then_completion_review";
  const mutating = features.actionMode === "reversible_mutation";
  if (highRisk && mutating && isCodeBuilder(features)) return "completion_review";
  if (highRisk && mutating) return "plan_review_then_completion_review";
  return "ordinary";
}

export function initialLifecycle(policy: SafetyPolicy, taskFingerprint: string): LeaseLifecycle {
  switch (policy) {
    case "completion_review":
      return { phase: "building", policy, taskFingerprint };
    case "plan_review_then_completion_review":
      return { phase: "planning", policy, taskFingerprint };
    default:
      return { phase: "ordinary", policy, taskFingerprint };
  }
}

/** Phase text steers the builder; it never grants permission or restricts tools. */
export function safetyContextForLifecycle(lifecycle: LeaseLifecycle): string | undefined {
  switch (lifecycle.phase) {
    case "planning":
      return "Advisory lifecycle: inspect the task and its preconditions, then call submit_action_plan for independent pre-action advice. This is a recommendation, not a tool restriction or permission requirement.";
    case "executing":
      return "Advisory lifecycle: carry out the task, account for review advice, and gather verification evidence for completion review.";
    case "building":
      return "Advisory lifecycle: build and gather verification evidence for the recommended completion review.";
    case "completed":
      return "Advisory lifecycle: completion review delivered; account for its findings.";
    default:
      return undefined;
  }
}

export function lifecycleRequiresCompletionReview(lifecycle: LeaseLifecycle): boolean {
  return lifecycle.phase === "building" || lifecycle.phase === "executing";
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

/** Legacy approvals and discovery grants are discarded, never reinterpreted as advice. */
export function migrateLifecycle(value: unknown): unknown {
  const lifecycle = object(value);
  if (!lifecycle || typeof lifecycle.taskFingerprint !== "string") return value;
  if (
    lifecycle.policy === "authorization_then_completion_review" ||
    lifecycle.policy === "advisory_then_completion_review" ||
    lifecycle.phase === "discovery_ready"
  ) {
    return initialLifecycle("plan_review_then_completion_review", lifecycle.taskFingerprint);
  }
  return value;
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
    case "planning":
    case "executing":
      return (
        lifecycle.policy === "plan_review_then_completion_review" &&
        (lifecycle.plan === undefined || planEvidence(lifecycle.plan, taskFingerprint)) &&
        (lifecycle.planReview === undefined || reviewOutcome(lifecycle.planReview, "plan"))
      );
    case "completed":
      return (
        lifecycle.policy !== "ordinary" &&
        reviewOutcome(lifecycle.completionReview, "completion") &&
        (lifecycle.plan === undefined || planEvidence(lifecycle.plan, taskFingerprint)) &&
        (lifecycle.planReview === undefined || reviewOutcome(lifecycle.planReview, "plan"))
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

/** Conservative evidence observation only; this does not authorize or block tool calls. */
export function isPotentiallyMutatingTool(toolName: string, input: Record<string, unknown>): boolean {
  // Keep the observation API stable without interpreting command text or tool arguments.
  void input;
  if (
    toolName === "submit_action_plan" ||
    toolName === "submit_safety_review" ||
    toolName === "submit_implementation_plan"
  )
    return false;
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") return false;
  // Without interpreting shell syntax, every bash invocation may have side effects.
  return true;
}
