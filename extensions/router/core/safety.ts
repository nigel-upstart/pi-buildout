import { createHash } from "node:crypto";
import { types } from "node:util";
import { Type } from "typebox";
import type { Static, TUnsafe } from "typebox";
import { Check, Errors } from "typebox/value";
import { isCodeBuilder, isStandaloneReviewWork } from "./features.ts";
import type { TaskFeatures } from "./features.ts";
import { isReadOnlyShellCommand, readOnlyShellCommandRejection } from "./shell.ts";

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
const MAX_DISCOVERY_REQUEST_BYTES = 64 * 1024;

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

// Discovery is one concrete tool invocation, not a list of tools or a final execution plan.
export const DiscoveryRequestSchema = Type.Object(
  {
    purpose: Type.Literal("discovery"),
    objective: NonEmptyString,
    target: ShortString,
    expectedEffects: Type.Array(NonEmptyString, { minItems: 1, maxItems: 20 }),
    preconditions: Type.Array(NonEmptyString, { minItems: 1, maxItems: 20 }),
    verification: Type.Array(NonEmptyString, { minItems: 1, maxItems: 20 }),
    abortConditions: Type.Array(NonEmptyString, { minItems: 1, maxItems: 20 }),
    toolName: Type.String({ minLength: 1, maxLength: 120 }),
    input: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
export type DiscoveryRequest = Omit<Static<typeof DiscoveryRequestSchema>, "input"> & { input: JsonObject };
export type DiscoveryRequestValidation =
  { success: true; request: DiscoveryRequest; fingerprint: string; errors: [] } | { success: false; errors: string[] };

/** Reject JS-only values and unsafe object graphs before canonical JSON fingerprinting. */
function isJsonObject(value: unknown): value is JsonObject {
  // `seen` holds the objects on the current traversal path, not every object visited: entries are
  // removed on the way back out. A true cycle is rejected; one object shared by two keys is not.
  const seen = new Set<object>();
  let nodes = 0;
  function visit(item: unknown, depth: number): boolean {
    if (++nodes > 10_000 || depth > 32) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item) && !Object.is(item, -0);
    if (typeof item !== "object" || seen.has(item)) return false;
    // A proxy can satisfy every reflective check below without running its `get` trap, then return
    // different values to TypeBox or the fingerprint, so the inspected value would not be the hashed one.
    if (types.isProxy(item)) return false;
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    seen.add(item);
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== "string")) return false;
    // An array must have exactly the index keys "0"..String(length - 1) plus "length". A numeric-looking
    // name such as "4294967295" is not an index, and the fingerprint would drop it.
    if (
      array &&
      (keys.length !== item.length + 1 ||
        !Array.from({ length: item.length }, (_, index) => Object.hasOwn(item, String(index))).every(Boolean))
    )
      return false;
    for (const key of keys) {
      if (key === "length" && array) continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || !visit(descriptor.value, depth + 1)) {
        return false;
      }
    }
    seen.delete(item);
    return true;
  }
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value) && visit(value, 0);
  } catch {
    return false;
  }
}

export function validateDiscoveryRequest(value: unknown): DiscoveryRequestValidation {
  // Validate the whole object before TypeBox reads its properties or fingerprinting traverses it.
  if (!isJsonObject(value)) {
    return { success: false, errors: ["discovery request must contain only finite, acyclic JSON values"] };
  }
  // The request appears in both the builder context and the independent review prompt. Bound the
  // whole compact JSON encoding (the same byte size as canonical JSON), including keys and escapes.
  // Reject rather than truncate: the reviewed input must remain the exact tool invocation.
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_DISCOVERY_REQUEST_BYTES) {
    return {
      success: false,
      errors: [
        `discovery request exceeds the 64 KiB (${String(MAX_DISCOVERY_REQUEST_BYTES)} bytes) limit for UTF-8 serialized JSON; submit a smaller exact request`,
      ],
    };
  }
  if (!Check(DiscoveryRequestSchema, value)) {
    return {
      success: false,
      errors: [...Errors(DiscoveryRequestSchema, value)]
        .slice(0, 20)
        .map((error) => `${error.instancePath || "/"}: ${error.message}`),
    };
  }
  if (!isJsonObject(value.input)) return { success: false, errors: ["input must be a JSON object"] };
  const request: DiscoveryRequest = { ...value, input: value.input };
  return { success: true, request, fingerprint: safetyFingerprint(request), errors: [] };
}

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

type PendingDiscovery = {
  request: DiscoveryRequest;
  requestFingerprint: string;
  scopeFingerprint: string;
  submittedAt: string;
  cwd: string;
  sessionId: string;
};

type DiscoveryGrant = {
  request: DiscoveryRequest;
  requestFingerprint: string;
  scopeFingerprint: string;
  approvalFingerprint: string;
  taskFingerprint: string;
  cwd: string;
  sessionId: string;
  reviewTaskId: string;
  reviewerVendor: string;
  approvedAt: string;
};

/** The scope presented for review; reviewer identity is recorded on the resulting grant. */
export function discoveryScopeFingerprint(
  request: DiscoveryRequest,
  taskFingerprint: string,
  cwd: string,
  sessionId: string,
): string {
  return safetyFingerprint({ purpose: "discovery", request, taskFingerprint, cwd, sessionId });
}

/** Binds the reviewer's identity and approval record to the exact reviewed call and session. */
export function discoveryApprovalFingerprint(
  scopeFingerprint: string,
  reviewTaskId: string,
  reviewerVendor: string,
  approvedAt: string,
): string {
  return safetyFingerprint({ scopeFingerprint, reviewTaskId, reviewerVendor, approvedAt });
}

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
      discovery?: PendingDiscovery;
      lastAuthorizationReview?: ReviewOutcome;
      evidenceRepairAttempted?: boolean;
    }
  | {
      phase: "discovery_ready";
      policy: "authorization_then_completion_review";
      taskFingerprint: string;
      grant: DiscoveryGrant;
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
  if (isStandaloneReviewWork(features)) return "ordinary";
  const highRisk = features.risk === "high" || features.risk === "critical";
  const irreversible = features.actionMode === "external_side_effect" || features.actionMode === "destructive";
  const broadAutonomousExternalLoop =
    features.actionMode === "external_side_effect" &&
    features.interactivity === "autonomous" &&
    features.horizon === "program_unknown_size";
  if ((highRisk || broadAutonomousExternalLoop) && irreversible) return "authorization_then_completion_review";
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
      return "Safety lifecycle: remain non-mutating. read and read-only bash (git status/diff/log/show/branch, rg, grep, find, ls, head, tail, wc, including && and | chains of them) stay available for inspection. Inspect targets, then call submit_action_plan with a concrete irreversible-action plan. If read-only inspection cannot establish the facts needed for that plan, call submit_discovery_request with one exact bounded tool invocation for independent review first. Discovery approval is single-use and never authorizes final execution; the final plan requires its own independent approval.";
    case "advisory_pending":
      return "Safety lifecycle: remain non-mutating while gathering bounded context for a pre-action advisor.";
    case "discovery_ready":
      return "Safety lifecycle: remain non-mutating except for the one exact, independently approved discovery call. The discovery grant does not authorize final execution.";
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
    lifecycle.phase === "review" ||
    lifecycle.phase === "preflight" ||
    lifecycle.phase === "discovery_ready" ||
    lifecycle.phase === "advisory_pending";
  if (!restricted) return undefined;
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") return undefined;
  const shellRejection =
    toolName === "bash"
      ? readOnlyShellCommandRejection(typeof input.command === "string" ? input.command : "")
      : undefined;
  if (toolName === "bash" && shellRejection === undefined) return undefined;
  if (lifecycle.phase === "review" && toolName === "submit_safety_review") return undefined;
  if (lifecycle.phase === "preflight" && (toolName === "submit_action_plan" || toolName === "submit_discovery_request"))
    return undefined;
  // A bare refusal reads as "bash is unavailable", and the model stops inspecting. Say which part
  // of the command was refused, that read-only bash still works, and how to leave the phase.
  const detail = shellRejection
    ? ` (${shellRejection}). Read-only bash still runs: git status/diff/log/show/branch, rg, grep, find, ls, head, tail, wc, joined with && ; || or |`
    : "";
  if (lifecycle.phase === "review") return `Independent safety review lease is read-only${detail}`;
  if (lifecycle.phase === "discovery_ready")
    return `Only the exact approved discovery call may bypass this gate${detail}`;
  if (lifecycle.phase === "preflight") {
    return `Irreversible-action preflight is non-mutating until its plan is approved${detail}. To perform mutating steps, call submit_action_plan`;
  }
  return `High-risk advisory must complete before mutating tools are used${detail}`;
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

function pendingDiscovery(value: unknown, taskFingerprint: string): value is PendingDiscovery {
  const pending = object(value);
  if (
    !pending ||
    Object.keys(pending).sort().join(",") !== "cwd,request,requestFingerprint,scopeFingerprint,sessionId,submittedAt"
  )
    return false;
  const validated = validateDiscoveryRequest(pending.request);
  return (
    validated.success &&
    pending.requestFingerprint === validated.fingerprint &&
    typeof pending.cwd === "string" &&
    pending.cwd.length > 0 &&
    typeof pending.sessionId === "string" &&
    pending.sessionId.length > 0 &&
    typeof pending.submittedAt === "string" &&
    pending.submittedAt.length > 0 &&
    pending.scopeFingerprint ===
      discoveryScopeFingerprint(validated.request, taskFingerprint, pending.cwd, pending.sessionId)
  );
}

function discoveryGrant(value: unknown, taskFingerprint: string): value is DiscoveryGrant {
  const grant = object(value);
  if (
    !grant ||
    Object.keys(grant).sort().join(",") !==
      "approvalFingerprint,approvedAt,cwd,request,requestFingerprint,reviewTaskId,reviewerVendor,scopeFingerprint,sessionId,taskFingerprint"
  )
    return false;
  const validated = validateDiscoveryRequest(grant.request);
  return (
    validated.success &&
    grant.taskFingerprint === taskFingerprint &&
    typeof grant.cwd === "string" &&
    grant.cwd.length > 0 &&
    typeof grant.sessionId === "string" &&
    grant.sessionId.length > 0 &&
    typeof grant.reviewTaskId === "string" &&
    grant.reviewTaskId.length > 0 &&
    typeof grant.reviewerVendor === "string" &&
    grant.reviewerVendor.length > 0 &&
    typeof grant.approvedAt === "string" &&
    grant.approvedAt.length > 0 &&
    grant.requestFingerprint === validated.fingerprint &&
    grant.scopeFingerprint ===
      discoveryScopeFingerprint(validated.request, taskFingerprint, grant.cwd, grant.sessionId) &&
    grant.approvalFingerprint ===
      discoveryApprovalFingerprint(grant.scopeFingerprint, grant.reviewTaskId, grant.reviewerVendor, grant.approvedAt)
  );
}

/**
 * Pure, fail-closed single-use transition. The caller must persist the returned lifecycle before
 * dispatch: Pi runs every `tool_call` hook in an assistant message before executing any of them,
 * so a grant cleared only when a call ends would let two identical calls in one message both pass.
 */
export function consumeDiscoveryGrant(
  lifecycle: LeaseLifecycle | undefined,
  toolName: string,
  input: unknown,
  context: { taskFingerprint: string; cwd: string; sessionId: string },
): { allowed: true; lifecycle: LeaseLifecycle } | { allowed: false; reason: string } {
  if (lifecycle?.phase !== "discovery_ready" || !isLeaseLifecycle(lifecycle)) {
    return { allowed: false, reason: "No valid discovery grant is ready" };
  }
  const grant = lifecycle.grant;
  if (
    context.taskFingerprint !== lifecycle.taskFingerprint ||
    context.cwd !== grant.cwd ||
    context.sessionId !== grant.sessionId ||
    toolName !== grant.request.toolName ||
    !isJsonObject(input) ||
    safetyFingerprint(input) !== safetyFingerprint(grant.request.input)
  ) {
    return { allowed: false, reason: "Tool call does not match the approved discovery scope" };
  }
  return {
    allowed: true,
    lifecycle: {
      phase: "preflight",
      policy: "authorization_then_completion_review",
      taskFingerprint: lifecycle.taskFingerprint,
    },
  };
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
        (lifecycle.discovery === undefined || pendingDiscovery(lifecycle.discovery, taskFingerprint)) &&
        (lifecycle.lastAuthorizationReview === undefined ||
          reviewOutcome(lifecycle.lastAuthorizationReview, "authorization"))
      );
    case "discovery_ready":
      return (
        lifecycle.policy === "authorization_then_completion_review" &&
        Object.keys(lifecycle).sort().join(",") === "grant,phase,policy,taskFingerprint" &&
        discoveryGrant(lifecycle.grant, taskFingerprint)
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
  if (
    toolName === "submit_action_plan" ||
    toolName === "submit_discovery_request" ||
    toolName === "submit_safety_review"
  )
    return false;
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") return false;
  if (toolName === "bash") return !isReadOnlyShellCommand(typeof input.command === "string" ? input.command : "");
  return true;
}
